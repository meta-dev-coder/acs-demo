import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { allowed, buildRawMessage, classifySendError, createGmailApi, parseRecipients, SEND_SCOPE } from '../server/gmail/api.mjs';

// ---- fakes with the real clients' shape (google-auth-library OAuth2Client, @googleapis/gmail) ----
function fakeGoogle({ scope = `${SEND_SCOPE} openid email`, email = 'sender@example.com' } = {}) {
  const calls = { sent: [], revoked: [], refreshed: 0, exchanged: [] };
  const behaviour = { send: 'ok', refresh: 'ok' };
  const oauth = () => {
    const listeners = {};
    const client = {
      credentials: {},
      async generateCodeVerifierAsync() { return { codeVerifier: 'v'.repeat(43), codeChallenge: 'challenge-xyz' }; },
      generateAuthUrl: o => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state: o.state, code_challenge: o.code_challenge, code_challenge_method: o.code_challenge_method, scope: o.scope.join(' '), access_type: o.access_type, prompt: o.prompt })}`,
      async getToken({ code, codeVerifier }) {
        calls.exchanged.push({ code, codeVerifier });
        if (code === 'bad') throw Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
        return { tokens: { access_token: `at-${code}`, refresh_token: `rt-${code}`, expiry_date: Date.now() + 3600e3, scope, id_token: 'idt' } };
      },
      async verifyIdToken() { return { getPayload: () => ({ email }) }; },
      setCredentials(c) { client.credentials = { ...c }; },
      on(event, fn) { listeners[event] = fn; },
      async getAccessToken() {
        if (behaviour.refresh === 'revoked') throw Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } });
        if ((client.credentials.expiry_date ?? 0) < Date.now()) { calls.refreshed += 1; listeners.tokens?.({ access_token: 'at-refreshed', expiry_date: Date.now() + 3600e3 }); }
        return { token: client.credentials.access_token };
      },
      async revokeToken(t) { calls.revoked.push(t); },
    };
    return client;
  };
  const gmail = () => ({ users: { messages: { async send({ userId, requestBody }) {
    calls.sent.push({ userId, raw: requestBody.raw });
    if (behaviour.send === 'ok') return { data: { id: `msg-${calls.sent.length}`, threadId: 'thr-1' } };
    if (behaviour.send === 'timeout') throw Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ETIMEDOUT' });
    if (behaviour.send === '429') throw Object.assign(new Error('Too many'), { response: { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } } });
    if (behaviour.send === '403') throw Object.assign(new Error('x'), { response: { status: 403, data: { error: { message: 'Mail service not enabled by your domain administrator policy' } } } });
    if (behaviour.send === '500') throw Object.assign(new Error('x'), { response: { status: 500, data: { error: { message: 'Backend Error' } } } });
    if (behaviour.send === 'slow') { await new Promise(r => setTimeout(r, 80)); return { data: { id: 'msg-slow', threadId: 't' } }; }
    throw new Error('unexpected');
  } } } });
  return { google: { oauth, gmail }, calls, behaviour };
}

const PDF = Buffer.from('%PDF-1.4\nreport bytes\n%%EOF');
const XLSX = Buffer.from('PK\u0003\u0004xlsx bytes');
/** A fake report store with the two functions server/gmail uses. */
function fakeReports({ illustrative = false, missing = [], files = null } = {}) {
  const draft = { draftId: 'd1', to: ['team@example.com'], cc: ['lead@example.com'], bcc: ['audit@example.com'], subject: 'Seagirt — Transformers requiring inspection', body: 'Hi Team,\n\nPlease review.', sendState: 'DRAFT' };
  const records = [];
  return {
    draft, records,
    async sendContext(req, fileName, reportId) {
      if (req.headers.sid !== 'aps-1') throw Object.assign(new Error('This report does not exist or belongs to another session.'), { code: 'REPORT_NOT_FOUND', status: 404 });
      return { owner: 'owner-1', projectId: 'b.p', reportId, revision: 1, fileName, draft: { ...draft }, illustrative, missing,
        files: files ?? [{ artifactId: 'pdfaaaaaaaaa', filename: 'Transformer_Inspection_Report_2026-11-26.pdf', mime: 'application/pdf', bytes: PDF },
          { artifactId: 'xlsxbbbbbbbb', filename: 'Transformer_Inspection_Register_2026-11-26.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: XLSX }] };
    },
    async recordSend(req, fileName, id, r) { records.push(r); draft.sendState = r.state; if (r.sent) draft.sent = r.sent; },
  };
}
const ENV = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'http://localhost:5188/api/gmail/auth/callback' };
function harness({ env = ENV, reports = fakeReports(), google = fakeGoogle() } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'gmail-'));
  const api = createGmailApi({ env, google: google.google, reports, dataDir, logger: { info() {}, warn() {}, error() {} } });
  async function call(method, path, { body = null, cookie = null, sid = 'aps-1' } = {}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url: path, headers: { ...(cookie ? { cookie } : {}), sid } });
    let status, headers; const parts = [];
    await api.handle(req, { writeHead(s, h) { status = s; headers = h ?? {}; }, write(c) { parts.push(Buffer.from(c)); }, end(b) { if (b) parts.push(Buffer.from(b)); } });
    const text = Buffer.concat(parts).toString();
    return { status, headers, text, json: /json/.test(headers['content-type'] ?? '') ? JSON.parse(text) : null };
  }
  /** Connect: login (cookie, state) then Google's redirect back. */
  async function connect(code = 'good') {
    const login = await call('GET', '/api/gmail/auth/login');
    const cookie = login.headers['set-cookie'].split(';')[0];
    const state = new URL(login.headers.location).searchParams.get('state');
    const cb = await call('GET', `/api/gmail/auth/callback?state=${state}&code=${code}`, { cookie });
    return { cookie, login, cb, state };
  }
  return { api, call, connect, google, reports, dataDir };
}
const key = n => `idem-key-${String(n).padStart(8, '0')}`;
/** The MIME parts of a raw message: headers and decoded bodies. */
function parseMime(raw) {
  const text = Buffer.from(raw, 'base64url').toString('latin1');
  const boundary = /boundary="?([^"\r\n;]+)"?/i.exec(text)[1];
  const parts = text.split(`--${boundary}`).slice(1, -1).map(p => {
    const [head, ...rest] = p.replace(/^\r\n/, '').split('\r\n\r\n');
    const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    return { head, bytes: /base64/i.test(head) ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : Buffer.from(body, 'latin1') };
  });
  return { text, head: text.split('\r\n\r\n')[0], parts };
}

test('not configured: status says what is missing; nothing can start', async () => {
  const h = harness({ env: {} });
  const s = (await h.call('GET', '/api/gmail/status')).json;
  assert.deepEqual([s.configured, s.connected, s.canSend], [false, false, false]);
  assert.deepEqual(s.missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']);
  assert.equal((await h.call('GET', '/api/gmail/auth/login')).json.error.code, 'GMAIL_NOT_CONFIGURED');
});

test('OAuth: state + PKCE, the minimum scope; the callback checks state and cookie; tokens never leave the server', async () => {
  const h = harness();
  const { login, cb, cookie } = await h.connect();
  assert.equal(login.status, 302);
  assert.match(login.headers['set-cookie'], /^gmail_sid=[A-Za-z0-9_-]{40,}; Path=\/api; HttpOnly; SameSite=Lax/);
  const u = new URL(login.headers.location);
  assert.equal(u.origin, 'https://accounts.google.com');
  assert.deepEqual(u.searchParams.get('scope').split(' '), ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'], 'send only: no read, modify or delete');
  assert.deepEqual([u.searchParams.get('code_challenge_method'), u.searchParams.get('code_challenge'), u.searchParams.get('access_type')], ['S256', 'challenge-xyz', 'offline']);
  assert.equal(h.google.calls.exchanged[0].codeVerifier, 'v'.repeat(43), 'the PKCE verifier is sent with the code');
  assert.equal(cb.status, 200);
  assert.match(cb.text, /postMessage\(\{"type":"gmail-auth","ok":true,"email":"sender@example.com"\},location\.origin\)/);
  const s = (await h.call('GET', '/api/gmail/status', { cookie })).json;
  assert.deepEqual([s.connected, s.email, s.canSend, s.reconnectRequired], [true, 'sender@example.com', true, false]);
  assert.doesNotMatch(JSON.stringify(s) + cb.text, /at-good|rt-good|secret|idt/, 'no token or secret in what the browser sees');
  // A replayed or foreign state is refused; so is a state started by another browser.
  assert.match((await h.call('GET', `/api/gmail/auth/callback?state=${u.searchParams.get('state')}&code=good`, { cookie })).text, /could not be verified/);
  const other = await h.call('GET', '/api/gmail/auth/login');
  const st = new URL(other.headers.location).searchParams.get('state');
  const stolen = await h.call('GET', `/api/gmail/auth/callback?state=${st}&code=good`, { cookie });
  assert.equal(stolen.status, 400);
  assert.match(stolen.text, /INVALID_STATE/);
  // Each browser has its own connection.
  assert.equal((await h.call('GET', '/api/gmail/status', { cookie: other.headers['set-cookie'].split(';')[0] })).json.connected, false);
});

test('OAuth: denied, or the send permission unticked, is not a connection', async () => {
  const h = harness();
  const login = await h.call('GET', '/api/gmail/auth/login');
  const cookie = login.headers['set-cookie'].split(';')[0];
  const denied = await h.call('GET', `/api/gmail/auth/callback?state=${new URL(login.headers.location).searchParams.get('state')}&error=access_denied`, { cookie });
  assert.match(denied.text, /AUTHORIZATION_DENIED/);
  const g = fakeGoogle({ scope: 'openid email' });
  const h2 = harness({ google: g });
  const { cb, cookie: c2 } = await h2.connect();
  assert.match(cb.text, /SCOPE_NOT_GRANTED/);
  assert.deepEqual(g.calls.revoked, ['at-good'], 'the partial grant is revoked');
  assert.equal((await h2.call('GET', '/api/gmail/status', { cookie: c2 })).json.connected, false);
});

test('recipients: addresses only; demo-data reports to the allowlist, or with explicit acknowledgement', () => {
  assert.deepEqual(parseRecipients('a@x.com; b@y.org,  a@X.com  bad@ @no'), { valid: ['a@x.com', 'b@y.org'], invalid: ['bad@', '@no'] });
  assert.deepEqual(parseRecipients(['Electrical Maintenance Team']).invalid, ['Electrical Maintenance Team'], 'a group name is not an address');
  assert.equal(allowed('qa@test.example', ['@test.example']), true);
  assert.equal(allowed('client@real.example', ['@test.example', 'me@x.com']), false);
});

test('send: the saved draft with the real PDF and XLSX bytes, base64url through the Gmail API; recorded; no resend', async () => {
  const h = harness();
  const { cookie } = await h.connect();
  const r = (await h.call('POST', '/api/gmail/send', { cookie, body: { fileName: 'net.ifc', reportId: 'RPT-1', idempotencyKey: key(1) } })).json;
  assert.equal(r.status, 'SENT');
  assert.deepEqual([r.messageId, r.sender, r.to, r.cc, r.attachmentCount], ['msg-1', 'sender@example.com', ['team@example.com'], ['lead@example.com'], 2]);
  assert.equal(h.google.calls.sent.length, 1);
  assert.equal(h.google.calls.sent[0].userId, 'me');
  assert.match(h.google.calls.sent[0].raw, /^[A-Za-z0-9_-]+$/, 'base64url');
  const m = parseMime(h.google.calls.sent[0].raw);
  assert.match(m.head, /^From: sender@example\.com$/m);
  assert.match(m.head, /^To: team@example\.com$/m);
  assert.match(m.head, /^Cc: lead@example\.com$/m);
  assert.match(m.head, /^Bcc: audit@example\.com$/m);
  assert.match(m.head, /^Subject: /m);
  const pdf = m.parts.find(p => /filename=.*\.pdf/.test(p.head));
  const xlsx = m.parts.find(p => /filename=.*\.xlsx/.test(p.head));
  assert.match(pdf.head, /Content-Type:\s+application\/pdf/);
  assert.match(xlsx.head, /Content-Type:\s+application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.ok(pdf.bytes.equals(PDF), 'the PDF bytes, not a link');
  assert.ok(xlsx.bytes.equals(XLSX));
  assert.deepEqual(h.reports.records.map(x => x.state), ['SENDING', 'SENT']);
  assert.equal(h.reports.records[1].sent.messageId, 'msg-1');
  // The same click again: the recorded result, no second message. A new attempt on a sent draft: refused.
  const again = (await h.call('POST', '/api/gmail/send', { cookie, body: { fileName: 'net.ifc', reportId: 'RPT-1', idempotencyKey: key(1) } })).json;
  assert.deepEqual([again.status, again.reused, again.messageId], ['SENT', true, 'msg-1']);
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, body: { fileName: 'net.ifc', reportId: 'RPT-1', idempotencyKey: key(2) } })).json.error.code, 'ALREADY_SENT');
  assert.equal(h.google.calls.sent.length, 1);
  // History and the audit file: the attempt, no tokens, no attachment contents.
  const hist = (await h.call('GET', '/api/gmail/history?file=net.ifc&reportId=RPT-1', { cookie })).json.attempts;
  assert.deepEqual(hist.map(x => [x.status, x.messageId, x.attachments.length]), [['SENT', 'msg-1', 2]]);
  const audit = readFileSync(join(h.dataDir, 'send-audit.json'), 'utf8');
  assert.match(audit, /"appUser": "owner-1"/);
  assert.match(audit, /"reportId": "RPT-1"/);
  assert.doesNotMatch(audit, /at-good|rt-good|report bytes|xlsx bytes/);
});

test('send: refused before anything is sent — not connected, another user, bad recipients, missing or oversized files, demo rules', async () => {
  const h = harness();
  assert.equal((await h.call('POST', '/api/gmail/send', { body: { reportId: 'RPT-1', idempotencyKey: key(1) } })).json.error.code, 'GMAIL_NOT_CONNECTED');
  const { cookie } = await h.connect();
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1' } })).json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, sid: 'aps-2', body: { reportId: 'RPT-1', idempotencyKey: key(1) } })).json.error.code, 'REPORT_NOT_FOUND', 'another user\'s report and files');
  h.reports.draft.to = ['Electrical Maintenance Team'];
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1', idempotencyKey: key(2) } })).json.error.code, 'INVALID_RECIPIENT', 'a group name is not an address');
  h.reports.draft.to = [];
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1', idempotencyKey: key(3) } })).json.error.code, 'NO_RECIPIENT');
  const missing = harness({ reports: fakeReports({ missing: ['Transformer_Inspection_Register_2026-11-26.xlsx'] }) });
  const c2 = (await missing.connect()).cookie;
  assert.equal((await missing.call('POST', '/api/gmail/send', { cookie: c2, body: { reportId: 'RPT-1', idempotencyKey: key(4) } })).json.error.code, 'ATTACHMENT_MISSING');
  const big = harness({ env: { ...ENV, GMAIL_MAX_ATTACHMENT_MB: '0.00001' } });
  const c3 = (await big.connect()).cookie;
  assert.equal((await big.call('POST', '/api/gmail/send', { cookie: c3, body: { reportId: 'RPT-1', idempotencyKey: key(5) } })).json.error.code, 'ATTACHMENT_TOO_LARGE');
  // Illustrative reports: only the allowlist; without one, only with the sender's explicit acknowledgement.
  const demo = harness({ env: { ...ENV, GMAIL_TEST_RECIPIENTS: '@example.com' }, reports: fakeReports({ illustrative: true }) });
  const c4 = (await demo.connect()).cookie;
  demo.reports.draft.to = ['client@real-client.example'];
  assert.equal((await demo.call('POST', '/api/gmail/send', { cookie: c4, body: { reportId: 'RPT-1', idempotencyKey: key(6) } })).json.error.code, 'RECIPIENT_NOT_ALLOWED');
  demo.reports.draft.to = ['team@example.com'];
  assert.equal((await demo.call('POST', '/api/gmail/send', { cookie: c4, body: { reportId: 'RPT-1', idempotencyKey: key(7) } })).json.status, 'SENT');
  const ack = harness({ reports: fakeReports({ illustrative: true }) });
  const c5 = (await ack.connect()).cookie;
  assert.equal((await ack.call('POST', '/api/gmail/send', { cookie: c5, body: { reportId: 'RPT-1', idempotencyKey: key(8) } })).json.error.code, 'ILLUSTRATIVE_NOT_ACKNOWLEDGED');
  assert.equal((await ack.call('POST', '/api/gmail/send', { cookie: c5, body: { reportId: 'RPT-1', idempotencyKey: key(9), acknowledgeIllustrative: true } })).json.status, 'SENT');
  for (const x of [h, missing, big]) assert.equal(x.google.calls.sent.length, 0, 'nothing reached Gmail');
});

test('send: an ambiguous timeout is "status unknown" and is not retried; a clear failure keeps the draft for a retry', async () => {
  const h = harness();
  const { cookie } = await h.connect();
  h.google.behaviour.send = 'timeout';
  const r = (await h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1', idempotencyKey: key(1) } })).json;
  assert.deepEqual([r.status, r.failure.message], ['SEND_STATUS_UNKNOWN', 'Send status could not be confirmed. Check Gmail before retrying.']);
  h.google.behaviour.send = 'ok';
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1', idempotencyKey: key(1) } })).json.error.code, 'SEND_STATUS_UNKNOWN');
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1', idempotencyKey: key(2) } })).json.error.code, 'SEND_STATUS_UNKNOWN', 'a new click does not resend either');
  assert.equal(h.google.calls.sent.length, 1);
  // Rate limited: a clear failure; the draft can be sent again.
  const f = harness();
  const c2 = (await f.connect()).cookie;
  f.google.behaviour.send = '429';
  const failed = (await f.call('POST', '/api/gmail/send', { cookie: c2, body: { reportId: 'RPT-1', idempotencyKey: key(3) } })).json;
  assert.deepEqual([failed.status, failed.failure.code], ['FAILED', 'RATE_LIMITED']);
  assert.equal(f.reports.draft.sendState, 'FAILED');
  f.google.behaviour.send = 'ok';
  assert.equal((await f.call('POST', '/api/gmail/send', { cookie: c2, body: { reportId: 'RPT-1', idempotencyKey: key(4) } })).json.status, 'SENT');
  assert.equal(classifySendError({ response: { status: 403, data: { error: { message: 'Mail service not enabled by your domain administrator policy' } } } }).message, 'Your Google Workspace administrator does not allow sending with this app.');
  assert.equal(classifySendError({ response: { status: 500 } }).state, 'SEND_STATUS_UNKNOWN');
  assert.equal(classifySendError({ code: 'ECONNRESET' }).state, 'SEND_STATUS_UNKNOWN');
});

test('send: two clicks at once send one message', async () => {
  const h = harness();
  const { cookie } = await h.connect();
  h.google.behaviour.send = 'slow';
  const [a, b] = await Promise.all([1, 2].map(() => h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1', idempotencyKey: key(1) } })));
  assert.equal(h.google.calls.sent.length, 1);
  assert.deepEqual([a.json.status ?? a.json.error.code, b.json.status ?? b.json.error.code].sort(), ['SEND_IN_PROGRESS', 'SENT']);
});

test('tokens: an expired access token is refreshed and kept; a revoked one asks to reconnect; disconnect revokes', async () => {
  const h = harness();
  const { cookie } = await h.connect();
  // The stored access token has expired: the send refreshes it first (and keeps the new one).
  const g = h.google;
  const orig = g.google.oauth;
  g.google.oauth = () => { const c = orig(); const set = c.setCredentials; c.setCredentials = cr => set({ ...cr, expiry_date: 1 }); return c; };
  assert.equal((await h.call('POST', '/api/gmail/send', { cookie, body: { reportId: 'RPT-1', idempotencyKey: key(1) } })).json.status, 'SENT');
  assert.equal(g.calls.refreshed, 1);
  g.google.oauth = orig;
  // Revoked at Google: a clean failure (nothing sent), and the status asks to reconnect.
  const r = harness();
  const c2 = (await r.connect()).cookie;
  r.google.behaviour.refresh = 'revoked';
  const res = (await r.call('POST', '/api/gmail/send', { cookie: c2, body: { reportId: 'RPT-1', idempotencyKey: key(2) } })).json;
  assert.deepEqual([res.status, res.failure.code], ['FAILED', 'RECONNECT_REQUIRED']);
  assert.equal(r.google.calls.sent.length, 0);
  const st = (await r.call('GET', '/api/gmail/status', { cookie: c2 })).json;
  assert.deepEqual([st.connected, st.reconnectRequired, st.canSend], [false, true, false]);
  assert.equal((await r.call('POST', '/api/gmail/send', { cookie: c2, body: { reportId: 'RPT-1', idempotencyKey: key(3) } })).json.error.code, 'RECONNECT_REQUIRED');
  // Disconnect: revoked at Google, forgotten here.
  const d = (await r.call('POST', '/api/gmail/disconnect', { cookie: c2 })).json;
  assert.equal(d.connected, false);
  assert.deepEqual(r.google.calls.revoked, ['rt-good']);
});

test('MIME: the composer builds a standards message without SMTP', async () => {
  const { raw, bytes } = await buildRawMessage({ from: 'a@x.com', to: ['b@y.org'], subject: 'Seagirt — Ümlaut', text: 'Hello', attachments: [{ filename: 'r.pdf', mime: 'application/pdf', bytes: PDF }] });
  const m = parseMime(raw);
  assert.ok(bytes > PDF.length);
  assert.match(m.head, /^MIME-Version: 1\.0$/m);
  assert.match(m.head, /^Subject: =\?UTF-8\?/m, 'non-ASCII subject encoded');
  assert.ok(m.parts.some(p => p.bytes.equals(PDF)));
});
