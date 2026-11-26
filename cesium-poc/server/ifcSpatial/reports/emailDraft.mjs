/**
 * The email draft, written from the report snapshot (the same counts as the PDF and the register), and its
 * .eml export. A draft only: nothing here sends mail. The recipient is the group the user named; an address
 * is used only when one is supplied (no directory is configured, and none is guessed).
 */
import { randomBytes } from 'node:crypto';

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
export function draftEmail(snap, { recipientGroup = snap.request.recipientGroup, style = 'standard', attachments = [], addresses = [] } = {}) {
  const s = snap.summary;
  const project = snap.project.name ? `${snap.project.name.replace(/\s+(Electrical )?Digital Twin.*$/i, '')} — ` : '';
  const inspection = snap.kind === 'INSPECTION';
  const subject = inspection ? `${project}${cap(snap.request.phrase)} requiring inspection` : `${project}${snap.names.reportTitle}`;
  const ids = list => list.join(', ');
  const att = attachments.length
    ? `the attached ${attachments.map(a => (/\.pdf$/i.test(a.filename) ? 'report' : /\.xlsx$/i.test(a.filename) ? 'register' : 'file')).filter((x, i, l) => l.indexOf(x) === i).join(' and ')}`
    : 'the report in the Seagirt twin';
  const lines = [greeting(recipientGroup), ''];
  if (inspection) {
    if (s.inspectionRequired) lines.push(`Based on the latest available asset records and ACC inspection documentation, ${typed(snap, s.inspectionRequired)} ${s.inspectionRequired === 1 ? 'has' : 'have'} been identified as requiring inspection: ${ids(snap.selectedIds)}.`);
    else lines.push(`Based on the latest available asset records and ACC inspection documentation, no ${snap.request.phrase} meet the inspection-required criteria.`);
    if (s.reviewRecommended) lines.push(`${cap(typed(snap, s.reviewRecommended))} ${s.reviewRecommended === 1 ? 'is' : 'are'} also recommended for engineering review: ${ids(snap.reviewIds)}.`);
  } else lines.push(`Please find ${snap.names.reportTitle.toLowerCase()} covering ${typed(snap, s.included)}${s.included && s.included <= 12 ? `: ${ids(snap.selectedIds)}` : ''}.`);
  if (style !== 'short') {
    if (inspection && s.mainReasons.length) {
      lines.push('', 'Main reasons:');
      for (const r of s.mainReasons.slice(0, 4)) lines.push(`- ${r.text} (${plural(r.assets, 'asset', 'assets')})`);
    }
    lines.push('', `Please review ${att}, which summarise${attachments.length === 1 ? 's' : ''} the relevant assets, documented findings and recommended follow-up actions${inspection ? ', and confirm the proposed inspection schedule' : ''}.`);
    if (snap.inventoryCoverage.insufficientEvidence) lines.push('', `Inspection history could not be established for ${plural(snap.inventoryCoverage.insufficientEvidence, 'asset', 'assets')} from the available records; see the limitations in the report.`);
  } else lines.push('', `Details are in ${att}.${inspection ? ' Please confirm the inspection schedule.' : ''}`);
  if (snap.illustrative) lines.push('', 'Note: these results are based on illustrative demonstration records, not actual inspection records.');
  lines.push('', 'Regards,', '[Your name]');
  return {
    recipientGroup: recipientGroup || null, recipientAddresses: addresses.filter(a => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a)),
    subject, body: lines.join('\n'), style, attachmentIds: attachments.map(a => a.artifactId), attachments: attachments.map(a => ({ artifactId: a.artifactId, filename: a.filename })),
    status: DRAFT_STATUS, reportId: snap.reportId, revision: snap.revision, updatedAt: new Date().toISOString(),
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
  const to = draft.recipientAddresses?.length ? draft.recipientAddresses.join(', ') : `${encodeWord(header(draft.recipientGroup ?? 'Recipients to be confirmed')).replace(/[,:;]/g, ' ')}:;`;
  const parts = [
    `To: ${to}`, `Subject: ${encodeWord(header(draft.subject))}`, `Date: ${new Date(now).toUTCString()}`, 'MIME-Version: 1.0', 'X-Unsent: 1',
    `X-Twin-Report: ${draft.reportId} rev ${draft.revision}`, `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(draft.body.replace(/\n/g, '\r\n'), 'utf8')),
  ];
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Type: ${f.mime}; name="${f.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${f.filename}"`, '', b64(f.bytes));
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n'), 'utf8');
}
