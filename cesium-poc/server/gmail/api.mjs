/**
 * /api/gmail/*: sending a report's email draft through the user's own Gmail account (Gmail API, OAuth 2.0).
 *
 *   GET  /api/gmail/status              connected?, the account address, can it send, does it need reconnecting
 *   GET  /api/gmail/auth/login          start Google sign-in (state + PKCE), in a popup
 *   GET  /api/gmail/auth/callback       Google's redirect: state checked, code exchanged, tokens kept here
 *   POST /api/gmail/send                send a report's saved draft, after the user confirmed it ({file, reportId, idempotencyKey, acknowledgeIllustrative})
 *   POST /api/gmail/disconnect          revoke the token at Google and forget the connection
 *   GET  /api/gmail/history?file=&reportId=   this user's send attempts for a report
 *
 * Independent of the Autodesk sign-in (server/aps/): its own client, its own HttpOnly cookie (gmail_sid) and its
 * own token store. Scope: gmail.send (send only — no reading, changing or deleting mail) plus openid/email to
 * know which account is connected. Tokens never leave this process: not to the page, not to a model, not to logs.
 *
 * Only an explicit request from the page (after the confirmation dialog) sends; nothing here is a tool a
 * model can call. The message is the report's saved draft; attachments are resolved on the server from the
 * report's own files by artifact id (reports/service.mjs), never from a path the page sends.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cookieValues, createEncryptedFileStore, createMemoryStore } from '../aps/sessions.mjs';

export const GMAIL_BASE = '/api/gmail';
export const GMAIL_SCOPES = Object.freeze(['https://www.googleapis.com/auth/gmail.send', 'openid', 'email']);
export const SEND_SCOPE = GMAIL_SCOPES[0];
export const GMAIL_COOKIE = 'gmail_sid';
export const SEND_STATE = Object.freeze({ DRAFT: 'DRAFT', READY_TO_SEND: 'READY_TO_SEND', SENDING: 'SENDING', SENT: 'SENT', FAILED: 'FAILED', SEND_STATUS_UNKNOWN: 'SEND_STATUS_UNKNOWN' });
const STATE_TTL_MS = 10 * 60 * 1000;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export class GmailError extends Error {
  constructor(code, status, message, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}

export function loadGmailConfig(env = process.env) {
  const id = String(env.GOOGLE_CLIENT_ID ?? '').trim(), secret = String(env.GOOGLE_CLIENT_SECRET ?? '').trim(), redirect = String(env.GOOGLE_REDIRECT_URI ?? '').trim();
  const missing = [!id && 'GOOGLE_CLIENT_ID', !secret && 'GOOGLE_CLIENT_SECRET', !redirect && 'GOOGLE_REDIRECT_URI'].filter(Boolean);
  const allow = String(env.GMAIL_TEST_RECIPIENTS ?? '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  return { configured: !missing.length, missing, clientId: id, clientSecret: secret, redirectUri: redirect, testRecipients: allow,
    maxAttachmentBytes: (Number(env.GMAIL_MAX_ATTACHMENT_MB) > 0 ? Number(env.GMAIL_MAX_ATTACHMENT_MB) : 24) * 1024 * 1024, auditRetentionDays: Math.max(1, Number(env.GMAIL_AUDIT_RETENTION_DAYS ?? 90)),
    tokenKey: String(env.GMAIL_TOKEN_ENCRYPTION_KEY ?? '').trim(), tokenPath: String(env.GMAIL_TOKEN_STORE_PATH ?? '').trim() };
}

/** "a@x.com; b@y.org" or a list → unique, trimmed addresses, and the ones that are not addresses. */
export function parseRecipients(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/)).map(x => String(x).trim()).filter(Boolean);
  const seen = new Set();
  const valid = [], invalid = [];
  for (const x of list) {
    if (!EMAIL.test(x) || x.length > 254) { invalid.push(x); continue; }
    const key = x.toLowerCase();
    if (!seen.has(key)) { seen.add(key); valid.push(x); }
  }
  return { valid, invalid };
}
/** The demo allowlist: exact addresses, or "@domain" for a whole domain. */
export const allowed = (address, list) => list.some(a => (a.startsWith('@') ? address.toLowerCase().endsWith(a) : address.toLowerCase() === a));

/**
 * Why a send failed, without anything sensitive. `unknown`: the request may have reached Gmail (a timeout or
 * a server error after sending), so it must not be retried blindly.
 */
export function classifySendError(error) {
  const status = error?.response?.status ?? error?.status ?? null;
  const reason = error?.response?.data?.error?.status ?? error?.response?.data?.error?.errors?.[0]?.reason ?? error?.code ?? null;
  const text = String(error?.response?.data?.error?.message ?? error?.message ?? '').slice(0, 300);
  if (/invalid_grant|token has been expired or revoked/i.test(`${error?.response?.data?.error ?? ''} ${text}`)) return { state: 'FAILED', code: 'RECONNECT_REQUIRED', message: 'The Gmail authorization has expired or was revoked. Reconnect Gmail and try again.', reconnect: true };
  if (status === 401) return { state: 'FAILED', code: 'RECONNECT_REQUIRED', message: 'Gmail refused the authorization. Reconnect Gmail and try again.', reconnect: true };
  if (status === 429 || /RESOURCE_EXHAUSTED|rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/i.test(String(reason))) return { state: 'FAILED', code: 'RATE_LIMITED', message: 'Gmail sending limit or quota reached. Wait and try again later.' };
  if (status === 403) return { state: 'FAILED', code: 'FORBIDDEN', message: /domain|admin|policy|workspace/i.test(text) ? 'Your Google Workspace administrator does not allow sending with this app.' : `Gmail refused to send: ${text || 'permission denied'}.` };
  if (status === 400) return { state: 'FAILED', code: 'REJECTED', message: `Gmail rejected the message: ${text || 'invalid message'}.` };
  if (status && status >= 400 && status < 500) return { state: 'FAILED', code: 'REJECTED', message: `Gmail refused the message (${status}).` };
  // A server error or a timeout: Gmail may have accepted it.
  return { state: 'SEND_STATUS_UNKNOWN', code: 'SEND_STATUS_UNKNOWN', message: 'Send status could not be confirmed. Check Gmail before retrying.' };
}

/** The MIME message (Nodemailer's composer only — no SMTP), base64url for the Gmail API. */
export async function buildRawMessage({ from, to, cc = [], bcc = [], subject, text, html = null, attachments = [] }) {
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
  const mail = new MailComposer({ from, to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, subject, text, ...(html ? { html } : {}),
    attachments: attachments.map(a => ({ filename: a.filename, content: a.bytes, contentType: a.mime })) });
  const node = mail.compile();
  // Gmail delivers to Bcc recipients from the Bcc header (and removes it before delivery): it must be kept here.
  node.keepBcc = true;
  const buf = await new Promise((resolve, reject) => node.build((error, message) => (error ? reject(error) : resolve(message))));
  return { raw: buf.toString('base64url'), bytes: buf.length };
}

/** The real Google clients; tests pass fakes with the same shape. */
export async function googleClients(config) {
  const { OAuth2Client } = await import('google-auth-library');
  const { gmail } = await import('@googleapis/gmail');
  return {
    oauth: () => new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri }),
    gmail: auth => gmail({ version: 'v1', auth }),
  };
}

export function createGmailApi({ env = process.env, logger = console, now = () => Date.now(), google = null, reports, dataDir = fileURLToPath(new URL('../../.data/gmail/', import.meta.url)), secure = false } = {}) {
  const config = loadGmailConfig(env);
  if (!config.configured) logger.info?.(`gmail: not configured (${config.missing.join(', ')} not set). /api/gmail/status says so; the rest of the app is unaffected.`);
  const store = config.tokenKey ? createEncryptedFileStore({ path: config.tokenPath || join(dataDir, 'connections.enc'), key: config.tokenKey, logger }) : createMemoryStore();
  const pending = new Map();   // state → {sid, verifier, at}
  const inflight = new Set();  // idempotency keys being sent now
  let clients = google;
  const g = async () => (clients ??= await googleClients(config));
  const auditPath = join(dataDir, 'send-audit.json');
  const readAudit = () => { try { return JSON.parse(readFileSync(auditPath, 'utf8')); } catch { return []; } };
  const writeAudit = list => {
    mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
    const cutoff = now() - config.auditRetentionDays * 86_400_000;
    const tmp = `${auditPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list.filter(x => Date.parse(x.updatedAt ?? x.createdAt) >= cutoff), null, 1), { mode: 0o600 });
    renameSync(tmp, auditPath);
  };
  const hash = v => createHash('sha256').update(String(v)).digest('hex').slice(0, 32);

  // ---- the browser's Gmail session ----
  const sidOf = req => cookieValues(req.headers?.cookie, GMAIL_COOKIE).find(Boolean) ?? null;
  const cookie = id => `${GMAIL_COOKIE}=${id}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`;
  const connectionOf = req => { const sid = sidOf(req); return sid ? { sid, record: store.get(sid) } : { sid: null, record: null }; };

  function status(req) {
    const { record } = connectionOf(req);
    return {
      configured: config.configured, missing: config.configured ? [] : config.missing, connected: Boolean(record?.tokens?.refresh_token || record?.tokens?.access_token) && !record?.reconnectRequired,
      email: record?.email ?? null, reconnectRequired: Boolean(record?.reconnectRequired), canSend: Boolean(config.configured && record?.email && !record.reconnectRequired && record.scopes?.includes(SEND_SCOPE)),
      scope: SEND_SCOPE, connectedAt: record?.connectedAt ?? null, testRecipients: config.testRecipients,
    };
  }

  async function login(req, res) {
    if (!config.configured) throw new GmailError('GMAIL_NOT_CONFIGURED', 503, `Gmail sending is not configured on the server (${config.missing.join(', ')}).`);
    let sid = sidOf(req);
    const headers = {};
    if (!sid) { sid = randomBytes(32).toString('base64url'); headers['set-cookie'] = cookie(sid); }
    const client = (await g()).oauth();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(24).toString('base64url');
    for (const [k, v] of pending) if (now() - v.at > STATE_TTL_MS) pending.delete(k);
    pending.set(state, { sid, verifier: codeVerifier, at: now() });
    const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GMAIL_SCOPES, state, code_challenge_method: 'S256', code_challenge: codeChallenge, include_granted_scopes: false });
    res.writeHead(302, { location: url, 'cache-control': 'no-store', ...headers });
    res.end();
  }

  /** The popup's last page: tells the conversation the result and closes. Nothing sensitive in it. */
  function finish(res, result, status = 200) {
    const payload = JSON.stringify({ type: 'gmail-auth', ...result }).replace(/</g, '\\u003c');
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Gmail</title><body style="font:14px system-ui;background:#0b192d;color:#f5f8ff;padding:24px">
<p>${result.ok ? `Gmail connected${result.email ? ` as ${String(result.email).replace(/[<>&"]/g, '')}` : ''}. You can close this window.` : `Gmail was not connected: ${String(result.message ?? '').replace(/[<>&"]/g, '')}`}</p>
<script>try{window.opener&&window.opener.postMessage(${payload},location.origin)}catch(e){};setTimeout(function(){window.close()},${result.ok ? 300 : 4000});</script></body>`);
  }

  async function callback(req, res, url) {
    const state = url.searchParams.get('state');
    const p = state ? pending.get(state) : null;
    if (state) pending.delete(state);
    const sid = sidOf(req);
    if (!p || p.sid !== sid || now() - p.at > STATE_TTL_MS) return finish(res, { ok: false, code: 'INVALID_STATE', message: 'The sign-in could not be verified (expired or not started here). Try Connect Gmail again.' }, 400);
    if (url.searchParams.get('error')) return finish(res, { ok: false, code: 'AUTHORIZATION_DENIED', message: url.searchParams.get('error') === 'access_denied' ? 'Access was not granted.' : 'Google did not authorize the request.' }, 400);
    const code = url.searchParams.get('code');
    if (!code) return finish(res, { ok: false, code: 'NO_CODE', message: 'Google returned no authorization code.' }, 400);
    try {
      const client = (await g()).oauth();
      const { tokens } = await client.getToken({ code, codeVerifier: p.verifier });
      const scopes = String(tokens.scope ?? '').split(/\s+/).filter(Boolean);
      if (!scopes.includes(SEND_SCOPE)) {
        if (tokens.access_token) await client.revokeToken(tokens.access_token).catch(() => {});
        return finish(res, { ok: false, code: 'SCOPE_NOT_GRANTED', message: 'Permission to send email was not granted. Connect again and allow "Send email on your behalf".' }, 400);
      }
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
      const email = ticket.getPayload()?.email ?? null;
      store.set(sid, { email, scopes, connectedAt: new Date(now()).toISOString(), reconnectRequired: false,
        tokens: { access_token: tokens.access_token ?? null, refresh_token: tokens.refresh_token ?? store.get(sid)?.tokens?.refresh_token ?? null, expiry_date: tokens.expiry_date ?? null } });
      return finish(res, { ok: true, email });
    } catch (error) {
      logger.warn?.(`gmail: token exchange failed (${error?.response?.data?.error ?? error?.code ?? 'error'})`);
      return finish(res, { ok: false, code: 'TOKEN_EXCHANGE_FAILED', message: 'Google did not complete the sign-in. Try again.' }, 400);
    }
  }

  async function disconnect(req) {
    const { sid, record } = connectionOf(req);
    if (!sid || !record) return status(req);
    const token = record.tokens?.refresh_token ?? record.tokens?.access_token;
    if (token) { try { await (await g()).oauth().revokeToken(token); } catch (error) { logger.warn?.(`gmail: revoke failed (${error?.response?.status ?? error?.code ?? 'error'}); forgetting the connection anyway`); } }
    store.delete(sid);
    return status(req);
  }

  /** An authorized client for this connection; refreshed tokens are kept. */
  async function authorized(sid, record) {
    const client = (await g()).oauth();
    client.setCredentials(record.tokens);
    client.on?.('tokens', t => {
      const cur = store.get(sid);
      if (cur) store.set(sid, { ...cur, tokens: { ...cur.tokens, ...(t.access_token ? { access_token: t.access_token } : {}), ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}), ...(t.expiry_date ? { expiry_date: t.expiry_date } : {}) } });
    });
    return client;
  }

  /**
   * Send the report's saved draft. Checks, in order: Gmail connected, the report and its files (this user's,
   * reports.sendContext), the recipients and the demo-data rules, the attachment size, and that the draft and
   * this idempotency key have not already been sent or left in an unknown state.
   */
  async function send(req, body) {
    const { sid, record } = connectionOf(req);
    if (!config.configured) throw new GmailError('GMAIL_NOT_CONFIGURED', 503, 'Gmail sending is not configured on the server.');
    if (!record || !record.email) throw new GmailError('GMAIL_NOT_CONNECTED', 409, 'Connect Gmail before sending.');
    if (record.reconnectRequired) throw new GmailError('RECONNECT_REQUIRED', 409, 'The Gmail authorization has expired or was revoked. Reconnect Gmail.');
    const key = String(body?.idempotencyKey ?? '');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw new GmailError('IDEMPOTENCY_KEY_REQUIRED', 400, 'A send needs an idempotency key.');
    const ctx = await reports.sendContext(req, String(body?.fileName ?? ''), String(body?.reportId ?? ''));
    const d = ctx.draft;
    const audit = readAudit();
    const prior = audit.find(x => x.idempotencyKey === key && x.appUser === ctx.owner);
    if (prior?.status === 'SENT') return { ...prior, reused: true };
    if (prior?.status === 'SENDING' || inflight.has(key)) throw new GmailError('SEND_IN_PROGRESS', 409, 'This email is already being sent.');
    if (prior?.status === 'SEND_STATUS_UNKNOWN') throw new GmailError('SEND_STATUS_UNKNOWN', 409, 'Send status could not be confirmed. Check Gmail before retrying.');
    if (d.sendState === 'SENT') throw new GmailError('ALREADY_SENT', 409, 'This draft was already sent. Create a new draft from it to send again.');
    if (d.sendState === 'SEND_STATUS_UNKNOWN') throw new GmailError('SEND_STATUS_UNKNOWN', 409, 'Send status could not be confirmed. Check Gmail before retrying; to send anyway, create a new draft from it.');
    if (d.sendState === 'SENDING') throw new GmailError('SEND_IN_PROGRESS', 409, 'This email is already being sent.');
    // Recipients: valid addresses only, none invented; the demo rules for illustrative reports.
    const to = parseRecipients(d.to), cc = parseRecipients(d.cc), bcc = parseRecipients(d.bcc);
    const bad = [...to.invalid, ...cc.invalid, ...bcc.invalid];
    if (bad.length) throw new GmailError('INVALID_RECIPIENT', 400, `Not valid email addresses: ${bad.join(', ')}.`);
    if (!to.valid.length) throw new GmailError('NO_RECIPIENT', 400, 'Add at least one recipient address.');
    const everyone = [...to.valid, ...cc.valid, ...bcc.valid];
    if (everyone.length > 50) throw new GmailError('TOO_MANY_RECIPIENTS', 400, 'At most 50 recipients.');
    if (!String(d.subject ?? '').trim() || !String(d.body ?? '').trim()) throw new GmailError('INVALID_DRAFT', 400, 'The subject and message cannot be empty.');
    if (ctx.illustrative) {
      if (config.testRecipients.length) {
        const outside = everyone.filter(a => !allowed(a, config.testRecipients));
        if (outside.length) throw new GmailError('RECIPIENT_NOT_ALLOWED', 403, `This report is based on illustrative demo data; it can be sent only to the approved test recipients. Not allowed: ${outside.join(', ')}.`);
      } else if (body?.acknowledgeIllustrative !== true) throw new GmailError('ILLUSTRATIVE_NOT_ACKNOWLEDGED', 400, 'Confirm that you are sending illustrative demo data, not actual inspection records.');
    }
    if (ctx.missing.length) throw new GmailError('ATTACHMENT_MISSING', 409, `Attachment not available: ${ctx.missing.join(', ')}. Regenerate it or remove it from the draft.`);
    const size = ctx.files.reduce((n, f) => n + f.bytes.length, 0);
    if (size > config.maxAttachmentBytes) throw new GmailError('ATTACHMENT_TOO_LARGE', 413, `The attachments are ${(size / 1048576).toFixed(1)} MB; Gmail accepts up to ${Math.round(config.maxAttachmentBytes / 1048576)} MB.`);

    const entry = { id: randomBytes(9).toString('hex'), idempotencyKey: key, appUser: ctx.owner, gmailConnection: hash(sid), projectId: ctx.projectId, reportId: ctx.reportId, revision: ctx.revision,
      draftId: d.draftId, sender: record.email, to: to.valid, cc: cc.valid, bcc: bcc.valid, subject: d.subject, attachmentIds: ctx.files.map(f => f.artifactId), attachments: ctx.files.map(f => f.filename),
      attachmentBytes: size, illustrative: ctx.illustrative, status: 'SENDING', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), messageId: null, threadId: null, failure: null };
    inflight.add(key);
    writeAudit([...audit, entry]);
    await reports.recordSend(req, ctx.fileName, ctx.reportId, { state: 'SENDING', attemptId: entry.id });
    const finishEntry = async patch => {
      Object.assign(entry, patch, { updatedAt: new Date(now()).toISOString() });
      writeAudit([...readAudit().filter(x => x.id !== entry.id), entry]);
      inflight.delete(key);
      await reports.recordSend(req, ctx.fileName, ctx.reportId, { state: entry.status, attemptId: entry.id, sent: entry.status === 'SENT' ? publicEntry(entry) : null, failure: entry.failure });
      return publicEntry(entry);
    };
    let message;
    // The formatted body (sanitized when saved, and again here) with its plain-text alternative.
    const { sanitizeEmailHtml } = await import('../ifcSpatial/reports/emailHtml.mjs');
    try { message = await buildRawMessage({ from: record.email, to: to.valid, cc: cc.valid, bcc: bcc.valid, subject: d.subject, text: d.body, html: d.bodyHtml ? sanitizeEmailHtml(d.bodyHtml) : null, attachments: ctx.files }); }
    catch (error) { return finishEntry({ status: 'FAILED', failure: { code: 'MIME_FAILED', message: 'The message could not be built.' } }); }
    let client;
    try {
      client = await authorized(sid, record);
      // Refresh before sending, so an authorization problem is a clean failure, not an unknown send.
      await client.getAccessToken();
    } catch (error) {
      const c = classifySendError(error);
      if (c.reconnect) store.set(sid, { ...store.get(sid), reconnectRequired: true });
      return finishEntry({ status: 'FAILED', failure: { code: c.code === 'SEND_STATUS_UNKNOWN' ? 'TOKEN_REFRESH_FAILED' : c.code, message: c.code === 'SEND_STATUS_UNKNOWN' ? 'Gmail could not be reached to authorize the send; nothing was sent.' : c.message } });
    }
    try {
      const res = await (await g()).gmail(client).users.messages.send({ userId: 'me', requestBody: { raw: message.raw } }, { timeout: 60_000 });
      if (!res?.data?.id) return finishEntry({ status: 'SEND_STATUS_UNKNOWN', failure: { code: 'NO_MESSAGE_ID', message: 'Send status could not be confirmed. Check Gmail before retrying.' } });
      logger.info?.(`gmail: report ${ctx.reportId} sent (${entry.to.length + entry.cc.length + entry.bcc.length} recipients, ${entry.attachments.length} attachments)`);
      return finishEntry({ status: 'SENT', messageId: res.data.id, threadId: res.data.threadId ?? null, sentAt: new Date(now()).toISOString() });
    } catch (error) {
      const c = classifySendError(error);
      if (c.reconnect) store.set(sid, { ...store.get(sid), reconnectRequired: true });
      return finishEntry({ status: c.state, failure: { code: c.code, message: c.message } });
    }
  }
  const publicEntry = e => ({ id: e.id, status: e.status, sender: e.sender, to: e.to, cc: e.cc, bcc: e.bcc, subject: e.subject, attachments: e.attachments, attachmentCount: e.attachments.length,
    reportId: e.reportId, revision: e.revision, messageId: e.messageId, threadId: e.threadId, sentAt: e.sentAt ?? null, createdAt: e.createdAt, failure: e.failure, illustrative: e.illustrative });

  async function history(req, url) {
    const ctx = await reports.sendContext(req, url.searchParams.get('file') ?? '', url.searchParams.get('reportId') ?? '', { history: true });
    return { attempts: readAudit().filter(x => x.appUser === ctx.owner && x.reportId === ctx.reportId).map(publicEntry).reverse() };
  }

  // ---- HTTP ----
  const send_ = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(payload)); };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > 16_000) { reject(new GmailError('BODY_TOO_LARGE', 413, 'The request body is too large.')); req.destroy?.(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new GmailError('INVALID_JSON', 400, 'The body is not JSON.')); } });
    req.on('error', reject);
  });
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== GMAIL_BASE && !url.pathname.startsWith(`${GMAIL_BASE}/`)) return false;
    const path = url.pathname.slice(GMAIL_BASE.length);
    try {
      if (path === '/status' && req.method === 'GET') return send_(res, 200, status(req)), true;
      if (path === '/auth/login' && req.method === 'GET') return await login(req, res), true;
      if (path === '/auth/callback' && req.method === 'GET') return await callback(req, res, url), true;
      if (path === '/disconnect' && req.method === 'POST') return send_(res, 200, await disconnect(req)), true;
      // An attempt answers 200 with its outcome (SENT, FAILED or SEND_STATUS_UNKNOWN); a refusal before sending is an error.
      if (path === '/send' && req.method === 'POST') return send_(res, 200, await send(req, await readBody(req))), true;
      if (path === '/history' && req.method === 'GET') return send_(res, 200, await history(req, url)), true;
      send_(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown Gmail route.' } });
    } catch (error) {
      const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : 500;
      if (status === 500) logger.error?.(`gmail: unexpected failure: ${error?.message ?? error}`);
      send_(res, status, { error: { code: error?.code ?? 'INTERNAL', message: status === 500 ? 'Unexpected server error.' : error.message } });
    }
    return true;
  }
  return { handle, middleware: (req, res, next) => { handle(req, res).then(handled => { if (!handled) next(); }, next); }, config: { configured: config.configured, testRecipients: config.testRecipients } };
}
