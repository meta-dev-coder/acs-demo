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
const TONE = { INSPECTION_REQUIRED: 'bad', REVIEW_RECOMMENDED: 'warn', INSUFFICIENT_EVIDENCE: 'neutral', NO_REQUIREMENT_IDENTIFIED: 'ok' };
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
  if (RUNNING.has(r.status)) return { say: req.outputs.pdf || req.outputs.xlsx || req.outputs.email ? `Preparing the ${req.kind === 'INSPECTION' ? 'inspection ' : ''}report for ${phrase}…` : `Evaluating ${phrase}…`, say2: null };
  if (r.status === 'FAILED' && !s) return { say: 'The report could not be generated.', say2: r.error ?? null };
  if (r.status === 'CANCELLED') return { say: 'Report generation was cancelled.', say2: null };
  let say;
  if (req.kind === 'INSPECTION') {
    say = s.inspectionRequired ? `I found ${plural(s.inspectionRequired, one, phrase.split(' and ')[0])} requiring inspection.`
      : `No ${phrase} meet the available inspection-required criteria.`;
  } else say = s.included ? `I found ${plural(s.included, one, phrase)}${req.filters.status === 'DEGRADED' ? ' with a degraded status' : req.filters.status === 'NO_POWER' ? ' with no power' : req.filters.recurring ? ' with recurring inspection findings' : ''}.` : `No ${phrase} match.`;
  const done = r.artifacts.filter(a => a.status === 'COMPLETED');
  const made = [done.some(a => a.type === 'PDF') && (req.kind === 'INSPECTION' ? 'an inspection report' : 'a report'), done.some(a => a.type === 'XLSX') && 'an Excel register', r.emailDraft && 'a draft email'].filter(Boolean);
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
  const desc = pdf ? `PDF · ${r.request.kind === 'INSPECTION' ? 'Asset details, location plot and inspection history' : 'Asset details and location plot'}` : `XLSX · ${plural(r.summary.included, 'asset', 'assets')} and recommended follow-ups`;
  if (a.status === 'FAILED') {
    return `<div class="tw-card tw-art is-failed">${icon(pdf ? 'pdf' : 'xlsx', pdf ? PDF_ICON : XLSX_ICON)}<div class="tw-art-m"><b>${pdf ? 'PDF report' : 'Excel register'}</b><small class="tw-rwarn">Generation failed: ${esc(a.error)}</small></div>
      <div class="tw-art-acts"><button type="button" class="tw-rlink" data-report-act="retry" data-report-type="${esc(a.type)}" data-report-id="${esc(r.reportId)}">Retry</button></div></div>`;
  }
  return `<div class="tw-card tw-art">${icon(pdf ? 'pdf' : 'xlsx', pdf ? PDF_ICON : XLSX_ICON)}<div class="tw-art-m"><b>${esc(a.title)}</b><small>${esc(desc)}${a.size ? ` · ${size(a.size)}` : ''}</small></div>
    <a class="tw-art-dl" href="${esc(a.url)}&download=1" download="${esc(a.filename)}" aria-label="Download ${esc(a.filename)}" title="${esc(a.filename)}">${DOWNLOAD}</a>
    <div class="tw-art-acts"><button type="button" class="tw-rlink is-plain" data-report-act="preview" data-report-artifact="${esc(a.artifactId)}" data-report-id="${esc(r.reportId)}">Preview</button>
      <a class="tw-rlink is-plain" href="${esc(a.url)}&download=1" download="${esc(a.filename)}">Download ${pdf ? 'PDF' : 'Excel'}</a></div></div>`;
}

function emailHtml(r, u) {
  const d = r.emailDraft;
  if (!d) return '';
  const id = esc(r.reportId);
  const files = r.artifacts.filter(a => a.status === 'COMPLETED');
  const attached = files.filter(a => d.attachmentIds.includes(a.artifactId));
  const head = `<header class="tw-mail-h"><span>${MAIL_ICON}<b>Draft email</b></span><span class="tw-mail-st">Needs review</span>
      <button type="button" class="tw-mail-tg" data-report-act="email" data-report-id="${id}" aria-expanded="${Boolean(u.emailOpen)}" aria-label="${u.emailOpen ? 'Collapse' : 'Expand'} the email">${u.emailOpen ? '⌃' : '⌄'}</button></header>`;
  if (u.editing) {
    return `<section class="tw-card tw-mail is-edit">${head}
      <label>To<input class="tw-mail-in" data-mail="recipientGroup" value="${esc(d.recipientGroup ?? '')}" placeholder="Recipient group or names"></label>
      <label>Subject<input class="tw-mail-in" data-mail="subject" value="${esc(d.subject)}"></label>
      <label>Message<textarea class="tw-mail-in" data-mail="body" rows="10">${esc(d.body)}</textarea></label>
      <fieldset class="tw-mail-att"><legend>Attachments</legend>${files.map(a => `<label><input type="checkbox" data-mail-att="${esc(a.artifactId)}"${d.attachmentIds.includes(a.artifactId) ? ' checked' : ''}> ${esc(a.filename)}</label>`).join('') || '<small>No files were generated.</small>'}</fieldset>
      <div class="tw-mail-acts"><button type="button" class="tw-btn is-primary" data-report-act="emailSave" data-report-id="${id}">Save draft</button><button type="button" class="tw-btn" data-report-act="emailCancel" data-report-id="${id}">Cancel</button></div></section>`;
  }
  const lines = d.body.split('\n');
  const preview = u.emailOpen ? d.body : lines.filter(Boolean).slice(0, 3).join('\n');
  return `<section class="tw-card tw-mail">${head}
    <dl class="tw-mail-f"><dt>To</dt><dd>${esc(d.recipientGroup ?? 'Recipient to be confirmed')}${d.recipientAddresses?.length ? ` <small>${esc(d.recipientAddresses.join(', '))}</small>` : ''}</dd><dt>Subject</dt><dd><b>${esc(d.subject)}</b></dd></dl>
    <div class="tw-mail-b${u.emailOpen ? ' is-open' : ''}">${esc(preview)}${!u.emailOpen && lines.filter(Boolean).length > 3 ? '<span class="tw-mail-more">…</span>' : ''}</div>
    ${!u.emailOpen ? `<button type="button" class="tw-rlink is-plain" data-report-act="email" data-report-id="${id}">Show full email</button>` : ''}
    <div class="tw-mail-att"><span>📎 ${plural(attached.length, 'attachment', 'attachments')}${d.attachmentIds.length && r.revision > 1 ? ` · report revision ${r.revision}` : ''}</span>${attached.map(a => `<small>${esc(a.filename)}</small>`).join('')}</div>
    <div class="tw-mail-acts"><button type="button" class="tw-btn" data-report-act="emailEdit" data-report-id="${id}">Edit draft</button><button type="button" class="tw-btn" data-report-act="emailCopy" data-report-id="${id}">Copy email</button>
      <a class="tw-btn" href="${esc(r.emlUrl)}" download>Download draft (.eml)</a><button type="button" class="tw-btn" data-report-act="emailRegen" data-report-id="${id}">Regenerate</button></div>
    <p class="tw-mail-note">${u.copied ? 'Copied to the clipboard. ' : ''}${d.edited ? 'Edited. ' : ''}Email has not been sent.</p></section>`;
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
export function reportHtml(r, u = {}) {
  if (RUNNING.has(r.status) || (!r.summary && r.status !== 'FAILED')) return `<div class="tw-report">${progressHtml(r)}</div>`;
  if (!r.summary) return `<div class="tw-report">${progressHtml(r)}</div>`;
  const files = r.artifacts;
  return `<div class="tw-report" data-report="${esc(r.reportId)}">
    ${r.illustrative ? '<p class="tw-rdemo">Illustrative demo data — not actual inspection records.</p>' : ''}
    ${matchingHtml(r, u)}
    ${files.length ? `<h5 class="tw-rh-up">Generated documents</h5>${files.map(a => artifactHtml(r, a)).join('')}` : ''}
    ${emailHtml(r, u)}
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
