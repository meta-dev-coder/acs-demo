/**
 * The email draft, written from the report snapshot (the same counts as the PDF and the register), and its
 * .eml export. A draft only: nothing here sends mail. The recipient is the group the user named; an address
 * is used only when one is supplied (no directory is configured, and none is guessed).
 */
import { randomBytes } from 'node:crypto';
import { emailHtmlToText, textToEmailHtml } from './emailHtml.mjs';

export const DRAFT_STATUS = 'DRAFT_NEEDS_REVIEW';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** The type words for a count: "1 transformer", "3 transformers", "2 transformers and circuit breakers". */
function typed(snap, n) {
  const labels = snap.request.typeLabels ?? [];
  if (labels.length === 1) return plural(n, labels[0].singular, labels[0].plural);
  return `${n} ${snap.request.phrase}`;
}
const greeting = group => (group ? `Hi ${/team$/i.test(group) ? 'Team' : group.replace(/^the /i, '')},` : 'Hi,');

/**
 * @param {object} snap the report snapshot
 * @param {{recipientGroup?: string, style?: 'standard'|'short', attachments?: {artifactId, filename}[]}} o
 */
export function draftEmail(snap, { recipientGroup = snap.request.recipientGroup, style = 'standard', attachments = [], addresses = [], to = [], cc = [], bcc = [], directory = null } = {}) {
  const s = snap.summary;
  const site = snap.project.name ? snap.project.name.replace(/\s+(Electrical )?Digital Twin.*$/i, '').trim() : null;
  const project = site ? `${site} — ` : '';
  const inspection = snap.kind === 'INSPECTION';
  const subject = inspection ? `${project}${cap(snap.request.phrase)} requiring inspection` : `${project}${snap.names.reportTitle}`;
  const ids = list => (list.length > 8 ? `${list.slice(0, 8).join(', ')} and ${list.length - 8} more` : list.join(', '));
  const kinds = [...new Set(attachments.map(a => (/\.pdf$/i.test(a.filename) ? 'report' : /\.xlsx$/i.test(a.filename) ? 'register' : 'file')))];
  const what = kinds.length ? `the attached ${kinds.join(' and ')}` : 'the report in the Seagirt twin';
  const title = snap.names.reportTitle.replace(/ (Report|Register)$/, '').toLowerCase();
  const where = site ? ` across ${site}` : '';
  // Short and actionable (about 100–150 words): what was found, what is missing, what to do. The report has the rest.
  const lines = [greeting(recipientGroup), ''];
  if (inspection) {
    lines.push(s.inspectionRequired
      ? `Based on the available asset records and ACC inspection documents, ${typed(snap, s.inspectionRequired)} ${s.inspectionRequired === 1 ? 'requires' : 'require'} inspection${where}: ${ids(snap.selectedIds)}.`
      : `Based on the available asset records and ACC inspection documents, no ${snap.request.phrase}${where} meet the inspection-required criteria.`);
    if (s.reviewRecommended) lines.push('', `${cap(typed(snap, s.reviewRecommended))} ${s.reviewRecommended === 1 ? 'is' : 'are'} recommended for engineering review: ${ids(snap.reviewIds)}.`);
  } else lines.push(`Please find ${kinds.length ? 'attached ' : ''}the ${title} ${kinds.length === 2 ? 'report and register' : kinds[0] === 'register' ? 'register' : 'report'} covering ${typed(snap, s.included)}${where}.`);
  const missing = snap.inventoryCoverage.insufficientEvidence;
  if (missing) lines.push('', `Inspection history could not be established for ${plural(missing, 'asset', 'assets')} from the available records${inspection ? '; this does not by itself mean they require inspection' : ''}.`);
  if (style !== 'short') {
    lines.push('', `Please review ${what} and coordinate the necessary follow-up${inspection && s.inspectionRequired ? ', including the proposed inspection schedule' : ''}${missing ? `${inspection && s.inspectionRequired ? ' and' : ', including'} verification of the missing inspection records` : ''}.`);
  }
  if (snap.illustrative) lines.push('', 'Note: this report is based on illustrative demonstration data and does not represent actual inspection records.');
  lines.push('', 'Regards,');
  const body = lines.join('\n');
  // A named group becomes addresses only from the configured directory; otherwise the user types them.
  const resolved = !to.length && recipientGroup && typeof directory === 'function' ? directory(recipientGroup) ?? [] : [];
  return {
    recipientGroup: recipientGroup || null, recipientAddresses: addresses.filter(a => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a)),
    subject, body, bodyHtml: textToEmailHtml(body), style, attachmentIds: attachments.map(a => a.artifactId), attachments: attachments.map(a => ({ artifactId: a.artifactId, filename: a.filename })),
    to: to.length ? [...to] : [...resolved], cc: [...cc], bcc: [...bcc], recipientResolved: resolved.length > 0,
    status: DRAFT_STATUS, sendState: 'DRAFT', sent: null, draftId: randomBytes(9).toString('base64url'), reportId: snap.reportId, revision: snap.revision, updatedAt: new Date().toISOString(),
  };
}

const header = v => String(v ?? '').replace(/[\r\n]+/g, ' ');
const encodeWord = v => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);
const b64 = buf => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');

/**
 * The draft as an .eml file with the generated files attached (MIME). Marked X-Unsent so a mail client opens it
 * as a draft to review and send; the "To" is the named group (RFC 5322 group syntax) unless addresses were given.
 */
export function toEml(draft, files, { now = Date.now() } = {}) {
  const boundary = `----=_twin_${randomBytes(12).toString('hex')}`;
  const addrs = draft.to?.length ? draft.to : draft.recipientAddresses ?? [];
  const to = addrs.length ? addrs.join(', ') : `${encodeWord(header(draft.recipientGroup ?? 'Recipients to be confirmed')).replace(/[,:;]/g, ' ')}:;`;
  const parts = [
    `To: ${to}`, ...(draft.cc?.length ? [`Cc: ${draft.cc.join(', ')}`] : []), `Subject: ${encodeWord(header(draft.subject))}`, `Date: ${new Date(now).toUTCString()}`, 'MIME-Version: 1.0', 'X-Unsent: 1',
    `X-Twin-Report: ${draft.reportId} rev ${draft.revision}`, `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    ...(draft.bodyHtml ? (() => {
      // The formatted body and its plain-text alternative.
      const alt = `----=_twin_alt_${randomBytes(10).toString('hex')}`;
      return [`--${boundary}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
        `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from((draft.body || emailHtmlToText(draft.bodyHtml)).replace(/\n/g, '\r\n'), 'utf8')),
        `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(`<!doctype html><html><body>${draft.bodyHtml}</body></html>`, 'utf8')), `--${alt}--`];
    })() : [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(draft.body.replace(/\n/g, '\r\n'), 'utf8'))]),
  ];
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Type: ${f.mime}; name="${f.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${f.filename}"`, '', b64(f.bytes));
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n'), 'utf8');
}
