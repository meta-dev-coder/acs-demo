/**
 * A generated report in the Ask the Twin conversation (server/ifcSpatial/reports/): progress while it runs,
 * then a compact answer — the matching assets (their rows on demand, the map), the generated files (preview,
 * download, retry), the email draft (preview, expand, edit, copy, .eml, regenerate) and the criteria and
 * sources behind it. Never the report's content itself: that is in the files.
 *
 * Every button is wired to something real (networkTwin.js handles data-report-*); nothing sends email.
 */
import { ASK_ICONS } from './askPanel.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const size = b => (!Number.isFinite(b) ? '' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const RUNNING = new Set(['PENDING', 'ANALYZING', 'GENERATING']);
const SOURCE = { DOCUMENTED: 'Documented', POLICY: 'Policy', USER_ASSUMPTION: 'Your assumption', DERIVED: 'Derived review criterion', OPERATIONAL: 'Operational status', USER_REQUEST: 'Request' };
const TONE = { INSPECTION_REQUIRED: 'bad', REVIEW_RECOMMENDED: 'warn', INSUFFICIENT_EVIDENCE: 'neutral', NO_REQUIREMENT_IDENTIFIED: 'ok',
  // Maintenance reports: the asset's evidence (maintenance.js).
  AVAILABLE: 'warn', NO_RELEVANT_FINDINGS: 'ok', NO_INSPECTION_RECORDS: 'neutral', NO_DOCUMENTS: 'neutral', RETRIEVAL_FAILED: 'bad', UNREADABLE: 'bad', NOT_CHECKED: 'neutral' };
const icon = (name, svg) => `<span class="tw-art-ic is-${name}" aria-hidden="true">${svg}</span>`;
const PDF_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4M9 13h6M9 17h4"/></svg>';
const XLSX_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 10h16M4 15h16M10 4v16"/></svg>';
const MAIL_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>';
const DOWNLOAD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

/** The first sentences of the answer: what was found and what was prepared (only what exists). */
export function reportSay(r) {
  const req = r.request;
  const phrase = req.typeLabels.map(l => l.plural).join(' and ') || 'assets';
  const one = req.typeLabels.length === 1 ? req.typeLabels[0].singular : 'asset';
  const s = r.summary;
  if (RUNNING.has(r.status)) return { say: req.outputs.pdf || req.outputs.xlsx || req.outputs.email ? `Preparing the ${req.kind === 'INSPECTION' ? 'inspection ' : req.kind === 'MAINTENANCE' ? 'maintenance ' : ''}report for ${phrase}…` : `Evaluating ${phrase}…`, say2: null };
  if (r.status === 'FAILED' && !s) return { say: 'The report could not be generated.', say2: r.error ?? null };
  if (r.status === 'CANCELLED') return { say: 'Report generation was cancelled.', say2: null };
  let say;
  if (req.kind === 'MAINTENANCE') {
    say = `The maintenance report covers ${plural(s.included, 'asset', 'assets')}: ${s.withFindings} with documented findings${s.openActions ? `, ${plural(s.openActions, 'action', 'actions')} without verified closure` : ''}.`;
  } else if (req.kind === 'INSPECTION') {
    say = s.inspectionRequired ? `I found ${plural(s.inspectionRequired, one, phrase.split(' and ')[0])} requiring inspection.`
      : `No ${phrase} meet the available inspection-required criteria.`;
  } else say = s.included ? `I found ${plural(s.included, one, phrase)}${req.filters.status === 'DEGRADED' ? ' with a degraded status' : req.filters.status === 'NO_POWER' ? ' with no power' : req.filters.recurring ? ' with recurring inspection findings' : ''}.` : `No ${phrase} match.`;
  const done = r.artifacts.filter(a => a.status === 'COMPLETED');
  const made = [done.some(a => a.type === 'PDF') && (req.kind === 'INSPECTION' ? 'an inspection report' : req.kind === 'MAINTENANCE' ? 'a maintenance report' : 'a report'), done.some(a => a.type === 'XLSX') && (req.kind === 'MAINTENANCE' ? 'a corrective action register' : 'an Excel register'), r.emailDraft && 'a draft email'].filter(Boolean);
  const failed = r.artifacts.filter(a => a.status === 'FAILED').map(a => (a.type === 'PDF' ? 'the PDF report' : 'the Excel register'));
  const say2 = [made.length ? `I've prepared ${made.length > 1 ? `${made.slice(0, -1).join(', ')} and ${made.at(-1)}` : made[0]} for your review.` : null,
    failed.length ? `${failed.join(' and ')} could not be generated; you can retry it.` : null,
    !made.length && !failed.length && (req.outputs.pdf || req.outputs.xlsx) && !s.included ? 'No files were generated: there is nothing to report.' : null,
    req.kind === 'INSPECTION' && s.reviewRecommended ? `${plural(s.reviewRecommended, 'more is', 'more are')} recommended for review.` : null].filter(Boolean).join(' ');
  return { say, say2: say2 || null };
}

function progressHtml(r) {
  const state = s => (s.state === 'done' ? '<span class="tw-pg-ok" aria-label="done">✓</span>' : s.state === 'running' ? '<span class="tw-spin" aria-label="in progress"></span>'
    : s.state === 'failed' ? '<span class="tw-pg-bad" aria-label="failed">!</span>' : s.state === 'skipped' ? '<span class="tw-pg-skip" aria-label="skipped">–</span>' : '<span class="tw-pg-wait" aria-hidden="true"></span>');
  return `<ol class="tw-pg" aria-live="polite">${r.steps.map(s => `<li class="is-${esc(s.state)}">${state(s)}<span>${esc(s.label)}${s.total ? ` <small>${s.done} of ${s.total}</small>` : ''}${s.detail && s.state !== 'running' ? `<small>${esc(s.detail)}</small>` : ''}</span></li>`).join('')}</ol>
    ${RUNNING.has(r.status) ? `<button type="button" class="tw-rlink" data-report-act="cancel" data-report-id="${esc(r.reportId)}">Cancel</button>` : ''}`;
}

function matchingHtml(r, u) {
  const req = r.request;
  const s = r.summary;
  const inspection = req.kind === 'INSPECTION';
  const n = inspection ? s.inspectionRequired : s.included;
  const word = req.typeLabels.length === 1 ? (n === 1 ? req.typeLabels[0].singular : req.typeLabels[0].plural) : n === 1 ? 'asset' : 'assets';
  const rows = r.assets.map(a => `<button type="button" class="tw-crow" data-asset="${esc(a.id)}" title="${esc(a.reason ?? a.label)}">
      <b>${esc(a.id)}</b><span class="tw-cstat is-${TONE[a.classification] ?? 'neutral'}"><i aria-hidden="true"></i>${esc(inspection ? a.label : a.status ?? a.label)}</span><span class="tw-chev" aria-hidden="true">${ASK_ICONS.chevron}</span></button>`);
  return `<section class="tw-card tw-rmatch"><div class="tw-rmatch-h"><div><b>${n} ${esc(word)}</b><small>${inspection ? 'Matching inspection-required criteria' : 'Matching the request'}${inspection && s.reviewRecommended ? ` · ${s.reviewRecommended} for review` : ''}</small></div>
      <span class="tw-rmatch-ic" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 12l2 2 4-4"/></svg></span></div>
    <div class="tw-rmatch-acts">${r.assets.length ? `<button type="button" class="tw-rlink is-plain" data-report-act="assets" data-report-id="${esc(r.reportId)}" aria-expanded="${Boolean(u.assetsOpen)}">${u.assetsOpen ? 'Hide matching assets' : 'View matching assets'}</button>` : '<span></span>'}
      ${r.assets.length ? `<button type="button" class="tw-rlink is-plain" data-report-act="map" data-report-id="${esc(r.reportId)}">${ASK_ICONS.target}<span>Show on map</span></button>` : ''}</div>
    ${u.assetsOpen ? `<div class="tw-coll-rows">${rows.join('')}</div>` : ''}</section>`;
}

function artifactHtml(r, a) {
  const pdf = a.type === 'PDF';
  const desc = r.request.kind === 'MAINTENANCE' ? (pdf ? 'PDF · Findings, corrective actions, closure and locations' : `XLSX · Findings and corrective actions for ${plural(r.summary.included, 'asset', 'assets')}`)
    : pdf ? `PDF · ${r.request.kind === 'INSPECTION' ? 'Asset details, location plot and inspection history' : 'Asset details and location plot'}` : `XLSX · ${plural(r.summary.included, 'asset', 'assets')} and recommended follow-ups`;
  if (a.status === 'FAILED') {
    return `<div class="tw-card tw-art is-failed">${icon(pdf ? 'pdf' : 'xlsx', pdf ? PDF_ICON : XLSX_ICON)}<div class="tw-art-m"><b>${pdf ? 'PDF report' : 'Excel register'}</b><small class="tw-rwarn">Generation failed: ${esc(a.error)}</small></div>
      <div class="tw-art-acts"><button type="button" class="tw-rlink" data-report-act="retry" data-report-type="${esc(a.type)}" data-report-id="${esc(r.reportId)}">Retry</button></div></div>`;
  }
  return `<div class="tw-card tw-art">${icon(pdf ? 'pdf' : 'xlsx', pdf ? PDF_ICON : XLSX_ICON)}<div class="tw-art-m"><b>${esc(a.title)}</b><small>${esc(desc)}${a.size ? ` · ${size(a.size)}` : ''}</small></div>
    <a class="tw-art-dl" href="${esc(a.url)}&download=1" download="${esc(a.filename)}" aria-label="Download ${esc(a.filename)}" title="${esc(a.filename)}">${DOWNLOAD}</a>
    <div class="tw-art-acts"><button type="button" class="tw-rlink is-plain" data-report-act="preview" data-report-artifact="${esc(a.artifactId)}" data-report-id="${esc(r.reportId)}">Preview</button>
      <a class="tw-rlink is-plain" href="${esc(a.url)}&download=1" download="${esc(a.filename)}">Download ${pdf ? 'PDF' : 'Excel'}</a></div></div>`;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** "a@x.com; b@y.org" → the addresses and what is not one (the same rule the server applies). */
export function splitAddresses(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/)).map(x => String(x).trim()).filter(Boolean);
  return { valid: list.filter(x => EMAIL_RE.test(x)), invalid: list.filter(x => !EMAIL_RE.test(x)) };
}
const allowedTo = (a, list) => list.some(x => (x.startsWith('@') ? a.toLowerCase().endsWith(x) : a.toLowerCase() === x));

/**
 * Can this draft be sent now, and if not, why (the first reason is shown under the button). The server checks
 * all of it again; this only keeps the button honest.
 */
export function sendReadiness(r, gmail) {
  const d = r.emailDraft;
  const why = [];
  if (!d) return { ready: false, why: ['No draft.'] };
  if (['SENT', 'SENDING', 'SEND_STATUS_UNKNOWN'].includes(d.sendState)) return { ready: false, why: [] };
  if (!gmail) why.push('Checking the Gmail connection…');
  else if (!gmail.configured) why.push('Gmail sending is not set up on the server.');
  else if (gmail.reconnectRequired) why.push('Reconnect Gmail to send.');
  else if (!gmail.canSend) why.push('Connect Gmail to send.');
  const to = splitAddresses(d.to), cc = splitAddresses(d.cc), bcc = splitAddresses(d.bcc);
  const bad = [...to.invalid, ...cc.invalid, ...bcc.invalid];
  if (bad.length) why.push(`Not an email address: ${bad.slice(0, 2).join(', ')}${bad.length > 2 ? '…' : ''}`);
  else if (!to.valid.length) why.push(`Enter ${d.recipientGroup ? `the ${d.recipientGroup}'s` : 'a recipient'} email address.`);
  if (!String(d.subject ?? '').trim()) why.push('Add a subject.');
  if (!String(d.body ?? '').trim()) why.push('Add a message.');
  const files = r.artifacts.filter(a => d.attachmentIds.includes(a.artifactId));
  if (files.some(a => a.status !== 'COMPLETED')) why.push('A selected attachment is not available.');
  if (r.illustrative && gmail?.testRecipients?.length) {
    const outside = [...to.valid, ...cc.valid, ...bcc.valid].filter(a => !allowedTo(a, gmail.testRecipients));
    if (outside.length) why.push(`Demo data can be sent only to approved test recipients (${gmail.testRecipients.join(', ')}).`);
  }
  return { ready: !why.length, why };
}

const GMAIL_MARK = '<svg width="22" height="22" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285f4" d="M6 38h7V22l-9-6.5V36a2 2 0 0 0 2 2Z"/><path fill="#34a853" d="M35 38h7a2 2 0 0 0 2-2V15.5L35 22Z"/><path fill="#fbbc04" d="M35 12v10l9-6.5V13c0-3.3-3.8-5.2-6.4-3.2Z"/><path fill="#ea4335" d="M13 22V12l11 8 11-8v10l-11 8Z"/><path fill="#c5221f" d="M4 13v2.5l9 6.5V12l-2.6-2.2C7.8 7.8 4 9.7 4 13Z"/></svg>';
const STATE_BADGE = { DRAFT: ['Needs review', 'warn'], READY_TO_SEND: ['Ready to send', 'ok'], SENDING: ['Sending…', 'info'], SENT: ['Sent', 'ok'], FAILED: ['Not sent', 'bad'], SEND_STATUS_UNKNOWN: ['Status unknown', 'bad'] };
const when = iso => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function gmailRowHtml(r, g, u) {
  const id = esc(r.reportId);
  if (!g) return `<div class="tw-gm"><span class="tw-gm-ic">${GMAIL_MARK}</span><div><b>Gmail account</b><small>Checking…</small></div></div>`;
  if (!g.configured) return `<div class="tw-gm"><span class="tw-gm-ic">${GMAIL_MARK}</span><div><b>Gmail account</b><small>Sending is not set up on the server (${esc(g.missing.join(', '))}).</small></div><span class="tw-gm-st">Unavailable</span></div>`;
  const connected = g.connected && g.email;
  return `<div class="tw-gm"><span class="tw-gm-ic">${GMAIL_MARK}</span><div><b>${connected ? esc(g.email) : 'Gmail account'}</b><small>${connected ? 'Connected · send only' : g.reconnectRequired ? 'Authorization expired or revoked' : 'Connect your Google account'}</small></div>
    <span class="tw-gm-st${connected ? ' is-on' : ''}">${connected ? 'Connected' : g.reconnectRequired ? 'Reconnect' : 'Not connected'}</span>
    <div class="tw-gm-acts">${connected ? `<button type="button" class="tw-rlink is-plain" data-report-act="gmailDisconnect" data-report-id="${id}">Disconnect</button>`
      : `<button type="button" class="tw-btn is-primary" data-report-act="gmailConnect" data-report-id="${id}">${g.reconnectRequired ? 'Reconnect Gmail' : 'Connect Gmail'}</button>`}</div>
    ${u.gmailNote ? `<p class="tw-gm-note">${esc(u.gmailNote)}</p>` : ''}</div>`;
}

function confirmHtml(r, g, u) {
  const d = r.emailDraft;
  const files = r.artifacts.filter(a => d.attachmentIds.includes(a.artifactId) && a.status === 'COMPLETED');
  const to = splitAddresses(d.to).valid, cc = splitAddresses(d.cc).valid, bcc = splitAddresses(d.bcc).valid;
  const ack = r.illustrative && !(g?.testRecipients?.length);
  return `<div class="tw-mconf" role="dialog" aria-modal="true" aria-label="Confirm sending">
    <h5>Send this email?</h5>
    <dl><dt>From</dt><dd>${esc(g?.email ?? '')}</dd><dt>To</dt><dd>${esc(to.join(', '))}</dd>${cc.length ? `<dt>Cc</dt><dd>${esc(cc.join(', '))}</dd>` : ''}${bcc.length ? `<dt>Bcc</dt><dd>${esc(bcc.join(', '))}</dd>` : ''}
      <dt>Subject</dt><dd>${esc(d.subject)}</dd><dt>Attachments</dt><dd>${files.length} · ${files.map(a => esc(a.filename)).join('<br>') || 'none'}</dd></dl>
    ${r.illustrative ? `<p class="tw-mconf-warn">This report is based on illustrative demo data, not actual inspection records${g?.testRecipients?.length ? '. It can be sent only to the approved test recipients.' : '.'}</p>` : ''}
    ${ack ? `<label class="tw-mconf-ack"><input type="checkbox" data-mail-ack> I confirm the recipients know this is illustrative demo data.</label>` : ''}
    ${u.sendError ? `<p class="tw-rwarn">${esc(u.sendError)}</p>` : ''}
    <div class="tw-mail-acts"><button type="button" class="tw-btn" data-report-act="sendCancel" data-report-id="${esc(r.reportId)}"${u.sending ? ' disabled' : ''}>Cancel</button>
      <button type="button" class="tw-btn is-primary" data-report-act="sendConfirm" data-report-id="${esc(r.reportId)}"${u.sending || ack ? ' disabled' : ''} data-needs-ack="${ack}">${u.sending ? '<span class="tw-spin" aria-hidden="true"></span> Sending…' : 'Send now'}</button></div></div>`;
}

function sentHtml(r, s) {
  return `<div class="tw-msent"><p class="tw-msent-h">✓ Email sent successfully</p>
    <dl><dt>From</dt><dd>${esc(s.sender)}</dd><dt>To</dt><dd>${esc([...s.to].join(', '))}</dd>${s.cc?.length ? `<dt>Cc</dt><dd>${esc(s.cc.join(', '))}</dd>` : ''}${s.bcc?.length ? `<dt>Bcc</dt><dd>${esc(s.bcc.join(', '))}</dd>` : ''}
      <dt>Subject</dt><dd>${esc(s.subject)}</dd><dt>Sent</dt><dd>${esc(when(s.sentAt))}</dd><dt>Attachments</dt><dd>${s.attachmentCount}</dd></dl>
    <p class="tw-mail-note">Submitted to Gmail. Delivery to the recipients and whether they read it are not confirmed here.</p>
    <div class="tw-mail-acts"><button type="button" class="tw-btn" data-report-act="emailNew" data-report-id="${esc(r.reportId)}">New draft from this email</button></div></div>`;
}

function historyHtml(r, u) {
  const list = u.history;
  return `<div class="tw-mhist"><button type="button" class="tw-rlink is-plain" data-report-act="sendHistory" data-report-id="${esc(r.reportId)}" aria-expanded="${Boolean(u.historyOpen)}">Send history${list ? ` (${list.length})` : ''}</button>
    ${u.historyOpen ? (list ? (list.length ? `<ul class="tw-rlist">${list.map(x => `<li><i class="tw-rdot is-${x.status === 'SENT' ? 'ok' : x.status === 'SENDING' ? 'info' : 'bad'}" aria-hidden="true"></i><span>${esc(when(x.sentAt ?? x.createdAt))} · ${esc(x.status === 'SENT' ? 'Sent' : x.status === 'SEND_STATUS_UNKNOWN' ? 'Status unknown' : x.status === 'SENDING' ? 'Sending' : 'Not sent')} to ${esc(x.to.join(', '))}${x.failure ? `<br><small>${esc(x.failure.message)}</small>` : ''}</span></li>`).join('')}</ul>` : '<p class="tw-rmuted">No send attempts yet.</p>') : '<p class="tw-rmuted">Loading…</p>') : ''}</div>`;
}

const ICON = {
  user: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c.9-3.8 3.9-5.6 7.5-5.6s6.6 1.8 7.5 5.6"/></svg>',
  tag: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9Z"/><circle cx="8" cy="8" r="1.5"/></svg>',
  clip: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m21 11-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8"/></svg>',
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  down: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  dots: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  fileDown: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Z"/><path d="M14 3v4h4M12 11v6M9.5 14.5 12 17l2.5-2.5"/></svg>',
  refresh: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/></svg>',
  history: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  send: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M21 3 3 10.5l7 2.5 2.5 7Z"/><path d="m10 13 11-10"/></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>',
  bold: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7Zm0 7h7a3.5 3.5 0 0 1 0 7H7Z"/></svg>',
  italic: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 5h5M5 19h5M15 5 9 19"/></svg>',
  underline: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/></svg>',
  ul: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>',
  ol: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5c0-1 2.8-1 2.8.5 0 1-2.8 2-2.8 3h3"/></svg>',
  link: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};
const escHtmlBody = t => esc(t).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

/** Addresses as chips (an address that is not one is shown as such), and the input for more. */
export function chipsHtml(field, list, { id, placeholder = '' } = {}) {
  const chips = (list ?? []).map(a => { const ok = EMAIL_RE.test(a); return `<span class="tw-chip2${ok ? '' : ' is-bad'}" title="${esc(ok ? a : `Not an email address: ${a}`)}">${esc(a)}<button type="button" data-chip-remove="${field}" data-chip-value="${esc(a)}" data-report-id="${esc(id)}" aria-label="Remove ${esc(a)}">${ICON.x}</button></span>`; }).join('');
  return `${chips}<input class="tw-chip-in" data-chip-input="${field}" data-report-id="${esc(id)}" placeholder="${list?.length ? '' : esc(placeholder)}" aria-label="${field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'} email addresses" autocomplete="off" inputmode="email">`;
}

function gmailBarHtml(r, g, u) {
  const id = esc(r.reportId);
  if (!g) return `<div class="tw-cmp-gm"><span class="tw-gm-ic">${GMAIL_MARK}</span><span class="tw-cmp-gm-t"><b>Gmail</b><small>Checking the connection…</small></span></div>`;
  if (!g.configured) return `<div class="tw-cmp-gm"><span class="tw-gm-ic">${GMAIL_MARK}</span><span class="tw-cmp-gm-t"><b>Gmail sending is not set up</b><small>The server needs ${esc(g.missing.join(', '))}.</small></span></div>`;
  if (g.connected && g.email) {
    return `<div class="tw-cmp-gm is-on"><span class="tw-gm-ic">${GMAIL_MARK}</span><span class="tw-cmp-gm-t"><b title="${esc(g.email)}">${esc(g.email)}</b><small><i class="tw-dot-on" aria-hidden="true"></i>Connected · send only</small></span>
      <button type="button" class="tw-cmp-link" data-report-act="gmailDisconnect" data-report-id="${id}">Disconnect</button></div>`;
  }
  return `<div class="tw-cmp-gm"><span class="tw-gm-ic">${GMAIL_MARK}</span><span class="tw-cmp-gm-t"><b>${g.reconnectRequired ? 'Gmail authorization expired' : 'Gmail not connected'}</b><small>${u.gmailNote ? esc(u.gmailNote) : 'Authorization is required to send from your account.'}</small></span>
    <button type="button" class="tw-cmp-btn is-gm" data-report-act="gmailConnect" data-report-id="${id}">${g.reconnectRequired ? 'Reconnect Gmail' : 'Connect Gmail'}</button></div>`;
}

function editorHtml(d, id, locked) {
  const tb = (fmt, icon, label, extra = '') => `<button type="button" class="tw-ed-b${extra}" data-fmt="${fmt}" data-report-id="${id}" aria-label="${label}" title="${label}"${locked ? ' disabled' : ''}>${icon}</button>`;
  return `<div class="tw-ed">
    <div class="tw-ed-tb" role="toolbar" aria-label="Formatting">
      <select class="tw-ed-sel is-wide" data-fmt-block data-report-id="${id}" aria-label="Paragraph style"${locked ? ' disabled' : ''}><option value="p">Paragraph</option><option value="h3">Heading</option><option value="blockquote">Quote</option></select>
      <span class="tw-ed-sep is-wide"></span>${tb('bold', ICON.bold, 'Bold')}${tb('italic', ICON.italic, 'Italic')}${tb('underline', ICON.underline, 'Underline')}
      <span class="tw-ed-sep"></span>${tb('insertUnorderedList', ICON.ul, 'Bulleted list')}${tb('insertOrderedList', ICON.ol, 'Numbered list', ' is-wide')}
      <span class="tw-ed-sep"></span>${tb('link', ICON.link, 'Insert link')}</div>
    <div class="tw-ed-body" contenteditable="${locked ? 'false' : 'true'}" role="textbox" aria-multiline="true" aria-label="Message" data-mail-editor data-report-id="${id}" spellcheck="true">${d.bodyHtml ?? `<p>${escHtmlBody(d.body ?? '')}</p>`}</div></div>`;
}

function attachmentsHtml(r, d, id, locked) {
  const files = r.artifacts.filter(a => a.status === 'COMPLETED');
  const on = files.filter(a => d.attachmentIds.includes(a.artifactId));
  const off = files.filter(a => !d.attachmentIds.includes(a.artifactId));
  const total = on.reduce((n, a) => n + (a.size ?? 0), 0);
  const card = a => `<div class="tw-att"><span class="tw-att-ic is-${a.type === 'PDF' ? 'pdf' : a.type === 'XLSX' ? 'xlsx' : 'doc'}">${a.type === 'PDF' ? 'PDF' : a.type === 'XLSX' ? 'XLS' : 'FILE'}</span>
      <span class="tw-att-m"><b title="${esc(a.filename)}">${esc(a.filename)}</b><small>${esc(size(a.size))}</small></span>
      <button type="button" class="tw-att-b" data-report-act="preview" data-report-artifact="${esc(a.artifactId)}" data-report-id="${id}" aria-label="Preview ${esc(a.filename)}" title="Preview">${ICON.eye}</button>
      <a class="tw-att-b" href="${esc(a.url)}&download=1" download="${esc(a.filename)}" aria-label="Download ${esc(a.filename)}" title="Download">${ICON.down}</a>
      ${locked ? '' : `<button type="button" class="tw-att-b" data-mail-att-remove="${esc(a.artifactId)}" data-report-id="${id}" aria-label="Remove ${esc(a.filename)} from the email" title="Remove from the email">${ICON.x}</button>`}</div>`;
  return `<section class="tw-atts" aria-label="Attachments"><header>${ICON.clip}<b>Attachments (${on.length})</b>${total ? `<small>Total ${esc(size(total))}</small>` : ''}</header>
    ${on.length ? `<div class="tw-atts-grid">${on.map(card).join('')}</div>` : '<p class="tw-rmuted">No files attached.</p>'}
    ${off.length && !locked ? `<p class="tw-atts-off">${off.map(a => `<button type="button" class="tw-cmp-link" data-mail-att-add="${esc(a.artifactId)}" data-report-id="${id}">+ Attach ${esc(a.filename)}</button>`).join(' ')}</p>` : ''}</section>`;
}

function emailHtml(r, u, g) {
  const d = r.emailDraft;
  if (!d) return '';
  const id = esc(r.reportId);
  const state = d.sendState ?? 'DRAFT';
  const ready = sendReadiness(r, g);
  const badge = STATE_BADGE[state === 'DRAFT' && ready.ready ? 'READY_TO_SEND' : state] ?? STATE_BADGE.DRAFT;
  const locked = ['SENDING', 'SEND_STATUS_UNKNOWN', 'SENT'].includes(state);
  const secondary = [
    `<a class="tw-cmp-sec" href="${esc(r.emlUrl)}" download>${ICON.fileDown}<span>Download .eml</span></a>`,
    locked ? '' : `<button type="button" class="tw-cmp-sec" data-report-act="emailRegenAsk" data-report-id="${id}">${ICON.refresh}<span>Regenerate text</span></button>`,
    `<button type="button" class="tw-cmp-sec" data-report-act="sendHistory" data-report-id="${id}" aria-expanded="${Boolean(u.historyOpen)}">${ICON.history}<span>Send history</span></button>`].filter(Boolean);
  const head = `<header class="tw-cmp-h"><span class="tw-cmp-ic">${MAIL_ICON.replace('width="16" height="16"', 'width="18" height="18"')}</span>
      <span class="tw-cmp-ht"><b>Email Draft</b><small>Review, edit and send the report to your team.</small></span>
      <span class="tw-cmp-st is-${badge[1]}"><i aria-hidden="true"></i>${badge[0]}</span>
      <span class="tw-cmp-menu"><button type="button" class="tw-cmp-dots" data-report-act="mailMenu" data-report-id="${id}" aria-haspopup="menu" aria-expanded="${Boolean(u.menuOpen)}" aria-label="More email actions" title="More actions">${ICON.dots}</button>
        ${u.menuOpen ? `<span class="tw-cmp-pop" role="menu">${secondary.join('')}</span>` : ''}</span></header>`;
  const history = u.historyOpen ? historyHtml(r, u).replace('<div class="tw-mhist">', '<div class="tw-mhist is-open">') : '';
  if (state === 'SENT' && d.sent) return `<section class="tw-card tw-mail tw-cmp" data-mail-card="${id}">${head}${sentHtml(r, d.sent)}${history}</section>`;
  const why = ready.why[0] ?? '';
  const footStatus = state === 'SEND_STATUS_UNKNOWN' ? '<span class="is-bad">Send status could not be confirmed. Check Gmail before retrying.</span>'
    : state === 'FAILED' && d.lastAttempt?.failure ? `<span class="is-bad">Not sent: ${esc(d.lastAttempt.failure.message)}</span>`
      : state === 'SENDING' ? 'Sending…' : u.copied ? 'Copied to the clipboard.' : u.saveError ? `<span class="is-bad">${esc(u.saveError)}</span>` : ready.ready ? 'Ready to send · not sent yet' : `Not sent · ${esc(why)}`;
  const showCc = u.ccOpen || d.cc?.length || d.bcc?.length;
  const row = (field, label, icon, list, placeholder, extra = '') => `<div class="tw-cmp-row"><span class="tw-cmp-lab">${icon}<span>${label}</span></span>
      <div class="tw-chips" data-chips="${field}" data-report-id="${id}">${chipsHtml(field, list, { id: r.reportId, placeholder })}</div>${extra}</div>`;
  return `<section class="tw-card tw-mail tw-cmp${u.confirming ? ' is-confirming' : ''}" data-mail-card="${id}">${head}
    ${gmailBarHtml(r, g, u)}
    <div class="tw-cmp-fields">
      ${row('to', 'To', ICON.user, d.to ?? [], d.recipientGroup ? `${d.recipientGroup} — enter email address` : 'Recipient email address', showCc ? '' : `<button type="button" class="tw-cmp-link tw-cmp-cc" data-report-act="mailCc" data-report-id="${id}">Cc / Bcc</button>`)}
      ${showCc ? `${row('cc', 'Cc', ICON.user, d.cc ?? [], 'Optional')}${row('bcc', 'Bcc', ICON.user, d.bcc ?? [], 'Optional')}` : ''}
      <div class="tw-cmp-row"><span class="tw-cmp-lab">${ICON.tag}<span>Subject</span></span><input class="tw-cmp-in" data-mail="subject" data-report-id="${id}" value="${esc(d.subject)}" aria-label="Subject"${locked ? ' readonly' : ''}></div>
    </div>
    ${editorHtml(d, id, locked)}
    ${attachmentsHtml(r, d, id, locked)}
    ${r.illustrative ? `<p class="tw-cmp-demo">${ICON.warn}<span>Demo data — send only to approved test recipients.</span></p>` : ''}
    ${state === 'SEND_STATUS_UNKNOWN' ? `<div class="tw-mail-acts"><button type="button" class="tw-cmp-btn" data-report-act="emailNew" data-report-id="${id}">Not sent? Create a new draft</button></div>` : ''}
    <div class="tw-cmp-secbar">${secondary.join('')}</div>
    ${u.regenConfirm ? `<div class="tw-cmp-confirm"><span>Replace your edited text with a newly generated message? The report and register are not regenerated.</span>
      <button type="button" class="tw-cmp-btn" data-report-act="emailRegenCancel" data-report-id="${id}">Keep my text</button><button type="button" class="tw-cmp-btn is-primary" data-report-act="emailRegen" data-report-id="${id}">Replace</button></div>` : ''}
    ${history}
    <footer class="tw-cmp-f"><p class="tw-cmp-fs" data-mail-why>${footStatus}</p>
      <button type="button" class="tw-cmp-btn" data-report-act="emailCopy" data-report-id="${id}">${ICON.copy}<span>Copy draft</span></button>
      <button type="button" class="tw-cmp-btn is-primary" data-report-act="sendStart" data-report-id="${id}" data-send-btn${ready.ready ? '' : ' disabled'}>${ICON.send}<span>${state === 'SENDING' ? 'Sending…' : 'Send Email'}</span></button></footer>
    ${u.confirming ? confirmHtml(r, g, u) : ''}</section>`;
}

function criteriaHtml(r, u) {
  const c = r.coverage;
  const missing = r.evaluated.filter(e => e.classification === 'INSUFFICIENT_EVIDENCE');
  return `<section class="tw-rcrit"><button type="button" class="tw-rlink is-plain" data-report-act="criteria" data-report-id="${esc(r.reportId)}" aria-expanded="${Boolean(u.criteriaOpen)}">${ASK_ICONS.info}<span>Sources &amp; ${r.request.kind === 'INSPECTION' ? 'inspection ' : ''}criteria</span></button>
    ${u.criteriaOpen ? `<div class="tw-rcrit-b">
      <h6>Rules applied</h6><ul class="tw-rlist">${r.criteria.map(x => `<li><i class="tw-rdot is-${x.assets ? 'info' : 'neutral'}" aria-hidden="true"></i><span>${esc(x.text)} <small>${esc(SOURCE[x.source] ?? x.source)} · ${x.assets} asset${x.assets === 1 ? '' : 's'}</small></span></li>`).join('')}</ul>
      <h6>Coverage</h6><p>${c.evaluated} ${esc(r.request.typeLabels.map(l => l.plural).join(' and ') || 'assets')} evaluated · documents linked for ${c.withDocuments} · inspection records for ${c.withInspectionRecords} · ${r.documentsRead} ACC documents read${c.failed.length ? ` · ${c.failed.length} could not be assessed` : ''}.</p>
      ${missing.length ? `<h6>Missing records</h6><p>${missing.map(e => esc(e.id)).join(', ')}: inspection history could not be established.</p>` : ''}
      <h6>Limitations</h6><ul class="tw-rlist">${r.limitations.map(l => `<li><i class="tw-rdot is-warn" aria-hidden="true"></i><span>${esc(l)}</span></li>`).join('')}</ul>
      <p class="tw-rmuted">IFC model ${esc(r.model.fileName ?? '')}${r.model.versionNumber ? ` v${esc(r.model.versionNumber)}` : ''} · report ${esc(r.reportId)}${r.revision > 1 ? ` rev ${r.revision}` : ''} · the full source list is in the PDF.</p></div>` : ''}</section>`;
}

/** The answer's body (below the sentences). */
export function reportHtml(r, u = {}, { gmail = null } = {}) {
  if (RUNNING.has(r.status) || (!r.summary && r.status !== 'FAILED')) return `<div class="tw-report">${progressHtml(r)}</div>`;
  if (!r.summary) return `<div class="tw-report">${progressHtml(r)}</div>`;
  const files = r.artifacts;
  return `<div class="tw-report" data-report="${esc(r.reportId)}">
    ${r.illustrative ? '<p class="tw-rdemo">Illustrative demo data — not actual inspection records.</p>' : ''}
    ${matchingHtml(r, u)}
    ${files.length ? `<h5 class="tw-rh-up">Generated documents</h5><div class="tw-arts">${files.map(a => artifactHtml(r, a)).join('')}</div>` : ''}
    ${emailHtml(r, u, gmail)}
    ${criteriaHtml(r, u)}
    ${r.status === 'PARTIALLY_COMPLETED' ? '<p class="tw-rwarn">Some files could not be generated; the others are ready.</p>' : ''}</div>`;
}

/** The register's first rows as a table, for the Excel preview (the file itself is the download). */
export function registerPreviewHtml(snapshot) {
  const cols = [['Asset ID', a => a.id], ['Status', a => a.operationalStatus?.label], ['Latest inspection', a => a.latestInspection?.date], ['Condition', a => a.condition ? `${a.condition.label ?? ''}${Number.isFinite(a.condition.score) ? ` (${a.condition.score}/${a.condition.scale})` : ''}` : null],
    ['Classification', a => a.inspection.label], ['Priority', a => a.inspection.priority.level], ['Reason', a => a.inspection.reasons.find(x => x.classification === a.inspection.classification)?.text], ['Recommended follow-up', a => a.inspection.followUps[0]?.text],
    ['Next due', a => a.inspection.nextInspection.date], ['Assigned To', () => ''], ['Planned Inspection Date', () => '']];
  return `<div class="isp-xlsx-prev"><p class="isp-muted">Sheet "Inspection Register" · ${snapshot.assets.length} row${snapshot.assets.length === 1 ? '' : 's'} · two more sheets (Inspection History, Sources and Criteria) in the file. Shaded columns are for the maintenance team to fill in.</p>
    <div class="isp-xlsx-scroll"><table><thead><tr>${cols.map(([h]) => `<th${/Assigned|Planned/.test(h) ? ' class="is-edit"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${snapshot.assets.map(a => `<tr>${cols.map(([h, f]) => `<td${/Assigned|Planned/.test(h) ? ' class="is-edit"' : ''}>${esc(f(a) ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
}
