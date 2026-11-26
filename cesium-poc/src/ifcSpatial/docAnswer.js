/**
 * Ask the Twin answers from an asset's documents (server/ifcSpatial/docIntel.mjs), laid out for the
 * conversation panel: a header, a short summary, then the sections the question needs (inspection
 * history, trends, specifications, outstanding issues, before replacement), and the sources.
 *
 * Every finding carries a citation chip built from the analysis's structured citation (document, version,
 * page, the extracted line) — never text the answer made up. A chip opens the existing document preview at
 * that page (data-doc-cite / data-doc-page); the Documents tab stays the place to browse the files.
 */
import { docReviewHtml } from './docReview.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const DOC_TITLES = {
  ASSET_REPLACEMENT_READINESS: 'Replacement Readiness Review', ASSET_INSPECTION_HISTORY: 'Inspection History', ASSET_TECHNICAL_SPECIFICATIONS: 'Technical Specifications',
  ASSET_MAINTENANCE_HISTORY: 'Actions and Maintenance', ASSET_CONDITION_TREND: 'Condition Over Time', ASSET_DOCUMENT_COMPARISON: 'Inspection Comparison', ASSET_DOCUMENT_SUMMARY: 'Document Summary',
};
const TREND_LABEL = {
  NEW_FINDING: ['New', 'warn'], RECURRING_FINDING: ['Recurring', 'bad'], RESOLVED_WITH_EVIDENCE: ['Recorded OK later', 'ok'], WORSENING_WITH_EVIDENCE: ['Worsening', 'bad'],
  IMPROVING_WITH_EVIDENCE: ['Improving', 'ok'], INSUFFICIENT_EVIDENCE: ['Not enough evidence', 'neutral'],
};
const SEVERITY_TONE = { DEFECT: 'bad', ATTENTION: 'warn', OK: 'ok' };
const BASIS = { DOCUMENTED: ['Documented', 'info'], DERIVED: ['Derived', 'neutral'], CHECK_REQUIRED: ['To verify', 'warn'], NETWORK: ['Electrical model', 'info'] };
const pill = (text, tone = 'neutral') => `<span class="tw-dpill is-${tone}">${esc(text)}</span>`;
const conditionTone = c => (c?.score === null || c?.score === undefined ? 'neutral' : c.score / (c.scale || 5) <= 0.4 ? 'bad' : c.score / (c.scale || 5) <= 0.6 ? 'warn' : 'ok');
const conditionText = c => (c ? `${c.label ?? ''}${c.score !== null && c.score !== undefined ? ` ${c.score}/${c.scale}` : ''}`.trim() : '');

/** A renderer bound to one analysis: citation chips are labelled by document ("Inspection 2026-10-28 · p.2"). */
function citer(a, { fallback = 'Document' } = {}) {
  const used = new Map();
  const label = id => {
    const s = (a?.sources ?? []).find(x => x.documentId === id);
    if (!s) return fallback;
    if (s.inspectionDate) return `Inspection ${s.inspectionDate}`;
    if (s.documentType === 'TECHNICAL_SPECIFICATION') return 'Asset sheet';
    return s.title ?? s.fileName ?? 'Document';
  };
  const chip = c => {
    if (!c?.documentId) return '';
    if (!used.has(c.documentId)) used.set(c.documentId, new Set());
    if (c.page) used.get(c.documentId).add(c.page);
    return `<button type="button" class="tw-cite" data-doc-cite="${esc(c.documentId)}"${c.page ? ` data-doc-page="${esc(c.page)}"` : ''} title="${esc(`${c.fileName ?? ''}${c.version ? ` · V${c.version}` : ''}${c.page ? ` · page ${c.page}` : ''}${c.section ? ` · ${c.section}` : ''}\n“${c.evidenceText ?? ''}”`)}">${esc(label(c.documentId))}${c.page ? ` · p.${esc(c.page)}` : ''}</button>`;
  };
  const chips = list => [...new Map((list ?? []).filter(c => c?.documentId).map(c => [`${c.documentId}:${c.page}`, c])).values()].map(chip).join('');
  return { chip, chips, used, label };
}

const section = (title, body, { count = null, open = true } = {}) => (body ? `<section class="tw-dsec${open ? '' : ' is-folded'}"><h4>${esc(title)}${count !== null ? ` <small>${esc(count)}</small>` : ''}</h4>${body}</section>` : '');
/** The first `n` items, the rest behind "Show N more". */
function folded(items, n, more = 'more') {
  if (items.length <= n) return items.join('');
  return `${items.slice(0, n).join('')}<details class="tw-dmore"><summary>Show ${items.length - n} ${esc(more)}</summary>${items.slice(n).join('')}</details>`;
}

function timelineHtml(a, c, { all = false } = {}) {
  const t = a.inspections.timeline;
  const notes = (a.conditionNotes ?? []).filter(n => /condition|assessment/i.test(n.label));
  const noteHtml = notes.length ? `<p class="tw-dnote">Asset sheet (not an inspection report): ${notes.slice(0, 2).map(n => `${esc(n.label)} <b>${esc(n.value)}</b>`).join(' · ')} ${c.chips(notes.slice(0, 2).map(n => n.citation))}</p>` : '';
  if (!t.length) return `<p class="tw-dempty">No inspection reports are among ${esc(a.asset.id)}'s linked documents.</p>${noteHtml}`;
  const rows = t.map(x => `<li class="tw-tl">
      <div class="tw-tl-head"><b>${esc(x.inspectionDate ?? 'Date not documented')}</b>${x.condition ? pill(conditionText(x.condition), conditionTone(x.condition)) : ''}${x.type ? `<small>${esc(x.type)}</small>` : ''}</div>
      ${x.mainFinding ? `<p>${esc(x.mainFinding.text)}</p>` : '<p class="tw-dmuted">No summary in the report.</p>'}
      <div class="tw-tl-foot"><small>${[x.counts.defects ? `${x.counts.defects} defect${x.counts.defects === 1 ? '' : 's'}` : null, x.counts.attention ? `${x.counts.attention} attention` : null, x.counts.actions ? `${x.counts.actions} action${x.counts.actions === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'No findings recorded'}</small>${c.chips([x.dateCitation ?? x.mainFinding?.citation, x.mainFinding?.citation])}</div></li>`);
  return `<ol class="tw-timeline">${all ? rows.join('') : folded(rows, 3, 'earlier reports')}</ol>${noteHtml}`;
}

function findingsHtml(list, c, n = 5) {
  if (!list.length) return '';
  return `<ul class="tw-dlist">${folded(list.map(f => `<li>${pill(f.result ?? f.severity ?? '', SEVERITY_TONE[f.severity] ?? 'neutral')}<span><b>${esc(f.item)}</b>${f.notes ? ` — ${esc(f.notes)}` : ''}</span>${c.chip(f.citation)}</li>`), n, 'findings')}</ul>`;
}

function trendsHtml(a, c, { n = 5 } = {}) {
  const cmp = a.inspections.comparison;
  if (cmp.reports < 2) return a.inspections.count ? `<p class="tw-dempty">Only ${cmp.reports === 1 ? 'one dated inspection report' : 'undated reports'}: no trend can be established from the documents.</p>` : '';
  const order = ['WORSENING_WITH_EVIDENCE', 'RECURRING_FINDING', 'NEW_FINDING', 'IMPROVING_WITH_EVIDENCE', 'RESOLVED_WITH_EVIDENCE', 'INSUFFICIENT_EVIDENCE'];
  const findings = [...cmp.findings].sort((x, y) => order.indexOf(x.trend) - order.indexOf(y.trend)).map(f => {
    const [label, tone] = TREND_LABEL[f.trend];
    return `<li>${pill(label, tone)}<span><b>${esc(f.item)}</b> — ${esc(f.basis)}</span>${c.chips(f.history.map(h => h.citation))}</li>`;
  });
  const worse = cmp.measurements.filter(m => m.trend === 'WORSENING_WITH_EVIDENCE');
  const other = cmp.measurements.filter(m => m.trend !== 'WORSENING_WITH_EVIDENCE');
  const mRow = m => `<li>${pill(TREND_LABEL[m.trend][0], TREND_LABEL[m.trend][1])}<span><b>${esc(m.name)}</b> ${esc(m.change.from)} → ${esc(m.change.to)}${m.unit && !m.name.includes(m.unit) ? ` ${esc(m.unit)}` : ''} <small>(${esc(m.change.fromDate)} → ${esc(m.change.toDate)})</small></span>${c.chips(m.points.slice(-2).map(p => p.citation))}</li>`;
  const cond = cmp.condition ? `<p class="tw-dnote">Overall condition: ${esc(cmp.condition.history.map(h => `${h.date} ${conditionText(h)}`).join(' → '))} ${c.chips(cmp.condition.history.map(h => h.citation))}</p>` : '';
  return `${cond}${findings.length ? `<ul class="tw-dlist">${folded(findings, n, 'findings')}</ul>` : ''}
    ${cmp.measurements.length ? `<details class="tw-dmore"><summary>Measurements: ${worse.length} of ${cmp.measurements.length} moved the usual way of concern</summary><ul class="tw-dlist">${[...worse, ...other].map(mRow).join('')}</ul>
      <p class="tw-dmuted">"Worsening" uses the usual reading of each test (derived, not stated by the report).</p></details>` : ''}
    ${cmp.caveats.map(x => `<p class="tw-dnote is-warn">${esc(x.text)} ${c.chips(x.citations)}</p>`).join('')}
    ${cmp.undated.length ? `<p class="tw-dmuted">${cmp.undated.length} report${cmp.undated.length === 1 ? ' has' : 's have'} no documented inspection date and ${cmp.undated.length === 1 ? 'is' : 'are'} left out of the comparison.</p>` : ''}`;
}

function specsHtml(a, c, { field = null } = {}) {
  const s = a.specifications;
  const row = f => `<tr class="${f.missing ? 'is-missing' : ''}${f.conflict ? ' is-conflict' : ''}"><th>${esc(f.label)}</th><td>${f.missing ? '<span class="tw-dmuted">Not documented</span>'
    : f.conflict ? f.values.map(v => `<span class="tw-dconf">${esc(v.value)} ${c.chips(v.sources)}</span>`).join('') + pill('Conflict', 'bad')
      : `${esc(f.value)}${f.source?.derived ? ' <small class="tw-dmuted">(from the rating)</small>' : ''} ${c.chips(f.values.flatMap(v => v.sources).slice(0, 2))}`}</td></tr>`;
  const focus = field ? [...s.keyFields, ...s.otherFields].find(f => f.key === field) : null;
  const keyRows = (focus ? [focus, ...s.keyFields.filter(f => f !== focus)] : s.keyFields);
  const documented = keyRows.filter(f => !f.missing);
  const missing = keyRows.filter(f => f.missing);
  const noSheet = !s.fromDocuments.length ? `<p class="tw-dnote is-warn">The linked ACC documents do not include a readable technical datasheet or asset sheet for ${esc(a.asset.id)}.</p>` : '';
  return `${noSheet}<table class="tw-dspec"><tbody>${documented.map(row).join('')}</tbody></table>
    ${missing.length ? `<p class="tw-dmuted">Not documented: ${esc(missing.map(f => f.label).join(', '))}.</p>` : ''}
    ${s.otherFields.length ? `<details class="tw-dmore"><summary>Show ${s.otherFields.length} more documented fields</summary><table class="tw-dspec"><tbody>${s.otherFields.map(row).join('')}</tbody></table></details>` : ''}`;
}

const STATUS_TONE = { 'Closure not verified': 'warn', 'Not completed (documented)': 'bad', 'In force at the latest inspection': 'info' };
function outstandingHtml(a, c, n = 5) {
  if (!a.outstanding.length) return a.inspections.count ? '<p class="tw-dempty">The linked documents record no open findings or actions.</p>' : '';
  const order = { FINDING: 0, RESTRICTION: 1, ACTION: 2 };
  const items = [...a.outstanding].sort((x, y) => order[x.kind] - order[y.kind] || (y.severity === 'DEFECT') - (x.severity === 'DEFECT')).map(o => {
    const trend = o.kind === 'FINDING' && o.trend && o.trend !== 'INSUFFICIENT_EVIDENCE' ? pill(TREND_LABEL[o.trend][0], TREND_LABEL[o.trend][1]) : '';
    const head = o.kind === 'FINDING' ? pill(o.result ?? o.severity, SEVERITY_TONE[o.severity] ?? 'neutral') : o.kind === 'RESTRICTION' ? pill('Restriction', 'info') : pill(o.priority ? `Action · ${o.priority}` : 'Action', 'neutral');
    const meta = o.kind === 'ACTION' ? `<small>Raised ${esc(o.raisedOn ?? '')}${o.due ? ` · due ${esc(o.due)}` : ''}</small>` : '';
    const closure = o.closure?.citation ? `<small class="tw-dmuted">${esc(o.closure.basis)}</small>${c.chip(o.closure.citation)}` : '';
    return `<li>${head}<span>${esc(o.text)} ${meta}<span class="tw-dstat">${pill(o.status, STATUS_TONE[o.status] ?? 'neutral')}${trend}</span>${closure}</span>${c.chip(o.citation)}</li>`;
  });
  return `<ul class="tw-dlist">${folded(items, n, 'items')}</ul>`;
}

function checksHtml(a, c, topology) {
  const items = a.checks.flatMap(k => {
    if (k.network) return topology?.length ? topology.map(t => ({ basis: 'NETWORK', text: t.text, assets: t.assets })) : [];
    return [k];
  }).map(k => `<li>${pill(BASIS[k.basis][0], BASIS[k.basis][1])}<span>${esc(k.text)}${k.assets?.length ? ` ${k.assets.slice(0, 8).map(id => `<button type="button" class="tw-dasset" data-asset="${esc(id)}">${esc(id)}</button>`).join('')}${k.assets.length > 8 ? ` <small>+${k.assets.length - 8} more</small>` : ''}` : ''}</span>${c.chips(k.sources)}</li>`);
  return `<ul class="tw-dlist is-checks">${items.join('')}</ul>`;
}

function sourcesHtml(a, c) {
  const read = a.sources.filter(s => s.status === 'SUCCESS' || s.status === 'PARTIAL');
  const notRead = a.sources.filter(s => !(s.status === 'SUCCESS' || s.status === 'PARTIAL'));
  const reason = s => ({ FAILED: s.errors?.[0] ?? 'Its contents could not be extracted.', ACCESS_DENIED: 'Your ACC account cannot read it.', DOCUMENT_MISSING: 'Not found in ACC at the last sync.',
    NOT_USED_OTHER_ASSET: `It states it is about ${s.statedAssetId}, so it was not used for ${a.asset.id}.` })[s.status] ?? s.errors?.[0] ?? 'Could not be read.';
  const row = s => {
    const pages = [...(c.used.get(s.documentId) ?? [])].sort((x, y) => x - y);
    return `<li><span class="tw-doc-ic" aria-hidden="true">PDF</span><span><b>${esc(s.fileName)}</b><small>${esc([c.label(s.documentId), s.version ? `V${s.version}` : null,
      s.pageCount ? `${s.pageCount} page${s.pageCount === 1 ? '' : 's'}` : null, pages.length ? `cited: p.${pages.join(', ')}` : null, s.status === 'PARTIAL' ? `pages ${s.unreadablePages.join(', ')} unreadable` : null].filter(Boolean).join(' · '))}</small>
      ${notRead.includes(s) ? `<small class="tw-dwarn">${esc(reason(s))}</small>` : ''}</span>
      <span class="tw-src-act">${s.status === 'DOCUMENT_MISSING' ? '' : `<button type="button" class="tw-cite" data-doc-cite="${esc(s.documentId)}"${pages[0] ? ` data-doc-page="${pages[0]}"` : ''}>Preview</button>`}${s.webViewUrl ? `<a class="tw-cite" href="${esc(s.webViewUrl)}" target="_blank" rel="noopener noreferrer">ACC</a>` : ''}</span></li>`;
  };
  return `<details class="tw-dsrc"><summary>Sources · ${read.length} analysed${notRead.length ? ` · ${notRead.length} not read` : ''}</summary><ul class="tw-dsrc-list">${[...read, ...notRead].map(row).join('')}</ul>
    <p class="tw-dmuted">Read from the documents' contents in ACC${a.modelVersion ? ` · linked to ${esc(a.modelVersion)}` : ''}. Hover a reference to see the extracted text.</p></details>`;
}

/**
 * One asset's documents, as the question needs them.
 * @param {object} a the analysis
 * @param {{intent: string, focus?: string, field?: string, topology?: {text, assets}[]}} o
 */
export function docAnalysisHtml(a, { intent, focus = null, field = null, topology = null, impact = null, status = null, openItem = null } = {}) {
  // One asset: the tabbed review (docReview.js). Two reports side by side keep the comparison table.
  if (a.review && intent !== 'ASSET_DOCUMENT_COMPARISON') return docReviewHtml(a, { intent, focus, field, impact, status, openItem });
  const c = citer(a);
  const caveat = a.caveats.length ? `<p class="tw-dnote is-warn">${a.caveats.length && a.caveats.every(x => /illustrative|demo|mock|not as-built|not a real/i.test(x.text)) ? 'The documents describe themselves as illustrative demo data' : 'Document notes'}: ${esc(a.caveats[0].text)} ${c.chips(a.caveats.map(x => x.citation))}</p>` : '';
  const ids = a.identityNotes.length ? `<details class="tw-dmore tw-dids"><summary>${a.identityNotes.length} document${a.identityNotes.length === 1 ? ' states' : 's state'} a different IFC GlobalId than the model</summary><ul class="tw-dlist">${a.identityNotes.map(n => `<li><span><b>${esc(n.fileName)}</b> — ${esc(n.text)}</span></li>`).join('')}</ul></details>` : '';
  const latest = a.inspections.timeline.find(t => t.inspectionDate);
  let body = '';
  if (intent === 'ASSET_REPLACEMENT_READINESS') {
    body = section('Inspection History', timelineHtml(a, c), { count: a.inspections.count ? `${a.inspections.count} report${a.inspections.count === 1 ? '' : 's'}` : null })
      + (a.inspections.comparison.reports >= 2 ? section('Changes Between Inspections', trendsHtml(a, c, { n: 4 })) : '')
      + section('Technical Specifications', specsHtml(a, c))
      + section('Outstanding Issues', outstandingHtml(a, c, 4), { count: a.outstanding.length ? String(a.outstanding.length) : null })
      + section('Before Replacement', checksHtml(a, c, topology));
  } else if (intent === 'ASSET_INSPECTION_HISTORY') {
    body = focus === 'DEFECTS'
      ? section(`Findings in the latest report${latest ? ` (${latest.inspectionDate})` : ''}`, latest ? findingsHtml(latest.findings, c, 8) || '<p class="tw-dempty">The latest report records no defects or items needing attention.</p>' : timelineHtml(a, c))
        + (a.inspections.comparison.reports >= 2 ? section('Compared with earlier reports', trendsHtml(a, c)) : '')
      : section('Inspection History', timelineHtml(a, c, { all: true })) + (a.inspections.comparison.reports >= 2 ? section('Changes Between Inspections', trendsHtml(a, c)) : '');
  } else if (intent === 'ASSET_TECHNICAL_SPECIFICATIONS') {
    body = section('Technical Specifications', specsHtml(a, c, { field }));
  } else if (intent === 'ASSET_CONDITION_TREND') {
    body = focus === 'CLOSURE' ? section('Outstanding Issues', outstandingHtml(a, c, 8)) : section('Condition Over Time', trendsHtml(a, c, { n: 8 }) || timelineHtml(a, c));
  } else if (intent === 'ASSET_MAINTENANCE_HISTORY') {
    const acts = a.inspections.comparison.actions;
    body = section('Recommended actions by report', acts.length ? `<ul class="tw-dlist">${folded([...acts].reverse().map(x => `<li>${pill(x.priority ?? 'Action', x.priority === 'High' ? 'bad' : 'neutral')}<span><b>${esc(x.action)}</b> <small>raised ${esc(x.raisedOn)}${x.due ? ` · due ${esc(x.due)}` : ''}</small><span class="tw-dstat">${pill(x.closure.status === 'COMPLETED_WITH_EVIDENCE' ? 'Completion documented' : x.closure.status === 'NOT_COMPLETED_WITH_EVIDENCE' ? 'Not completed (documented)' : 'Closure not verified', x.closure.status === 'COMPLETED_WITH_EVIDENCE' ? 'ok' : x.closure.status === 'NOT_COMPLETED_WITH_EVIDENCE' ? 'bad' : 'warn')}</span>${x.closure.citation ? `<small class="tw-dmuted">${esc(x.closure.basis)}</small>${c.chip(x.closure.citation)}` : ''}</span>${c.chip(x.citation)}</li>`), 6, 'actions')}</ul>`
      : `<p class="tw-dempty">No inspection or maintenance record linked to ${esc(a.asset.id)} lists actions.</p>`)
      + (a.documents.byType.MAINTENANCE ? '' : `<p class="tw-dmuted">No maintenance records are linked; closure is taken only from later inspection reports.</p>`);
  } else if (intent === 'ASSET_DOCUMENT_COMPARISON') {
    body = section('Latest two inspection reports', reportComparisonHtml(a, c));
  } else {
    body = section('Inspection History', timelineHtml(a, c)) + section('Technical Specifications', specsHtml(a, c)) + section('Outstanding Issues', outstandingHtml(a, c, 4));
  }
  const sources = sourcesHtml(a, c);
  return `<div class="tw-doc">
    <div class="tw-doc-head"><b>${esc(a.asset.id)}</b><span>${esc(DOC_TITLES[intent] ?? 'Documents')}</span></div>
    <p class="tw-doc-sum">${esc(a.summary)}</p>${caveat}${ids}
    ${body}
    ${intent === 'ASSET_REPLACEMENT_READINESS' || intent === 'ASSET_CONDITION_TREND' ? `<p class="tw-dbound">${esc(a.boundary)}</p>` : ''}
    ${sources}</div>`;
}

function reportComparisonHtml(a, c) {
  const t = a.inspections.timeline.filter(x => x.inspectionDate);
  if (t.length < 2) return `<p class="tw-dempty">${t.length ? 'Only one dated inspection report is linked' : 'No dated inspection reports are linked'}: there is nothing to compare.</p>${timelineHtml(a, c)}`;
  const [now, before] = t;
  const head = x => `<th>${esc(x.inspectionDate)}<br>${x.condition ? pill(conditionText(x.condition), conditionTone(x.condition)) : ''} ${c.chip(x.dateCitation)}</th>`;
  const count = (x, k) => x.counts[k];
  const table = `<table class="tw-dcmp"><thead><tr><th></th>${head(before)}${head(now)}</tr></thead><tbody>
    <tr><th>Defects</th><td>${count(before, 'defects')}</td><td>${count(now, 'defects')}</td></tr>
    <tr><th>Needs attention</th><td>${count(before, 'attention')}</td><td>${count(now, 'attention')}</td></tr>
    <tr><th>Actions raised</th><td>${count(before, 'actions')}</td><td>${count(now, 'actions')}</td></tr></tbody></table>`;
  return `${table}${trendsHtml(a, c, { n: 6 })}`;
}

/** Two or more assets side by side: their latest inspections, or their specifications. */
export function docCompareAssetsHtml(list, { aspect = 'INSPECTIONS' } = {}) {
  const cs = list.map(citer);
  const head = `<tr><th></th>${list.map(a => `<th>${esc(a.asset.id)}</th>`).join('')}</tr>`;
  let rows;
  if (aspect === 'SPECS') {
    const keys = [...new Map(list.flatMap(a => a.specifications.keyFields.map(f => [f.key, f.label]))).entries()];
    rows = keys.map(([key, label]) => `<tr><th>${esc(label)}</th>${list.map((a, i) => { const f = a.specifications.keyFields.find(x => x.key === key); return `<td>${!f || f.missing ? '<span class="tw-dmuted">Not documented</span>' : `${esc(f.value)} ${cs[i].chips(f.values.flatMap(v => v.sources).slice(0, 1))}${f.conflict ? pill('Conflict', 'bad') : ''}`}</td>`; }).join('')}</tr>`);
  } else {
    const latest = a => a.inspections.timeline.find(t => t.inspectionDate);
    const cell = (a, i, fn) => { const l = latest(a); return `<td>${l ? fn(l, cs[i]) : '<span class="tw-dmuted">No inspection report</span>'}</td>`; };
    rows = [
      `<tr><th>Latest inspection</th>${list.map((a, i) => cell(a, i, (l, c) => `${esc(l.inspectionDate)} ${c.chip(l.dateCitation)}`)).join('')}</tr>`,
      `<tr><th>Condition</th>${list.map((a, i) => cell(a, i, l => (l.condition ? pill(conditionText(l.condition), conditionTone(l.condition)) : '<span class="tw-dmuted">Not stated</span>'))).join('')}</tr>`,
      `<tr><th>Defects · attention</th>${list.map((a, i) => cell(a, i, l => `${l.counts.defects} · ${l.counts.attention}`)).join('')}</tr>`,
      `<tr><th>Main finding</th>${list.map((a, i) => cell(a, i, (l, c) => (l.mainFinding ? `${esc(l.mainFinding.text)} ${c.chip(l.mainFinding.citation)}` : '—'))).join('')}</tr>`,
      `<tr><th>Reports linked</th>${list.map(a => `<td>${a.inspections.count}</td>`).join('')}</tr>`,
    ];
  }
  return `<div class="tw-doc"><div class="tw-doc-head"><b>${esc(list.map(a => a.asset.id).join(' vs '))}</b><span>${aspect === 'SPECS' ? 'Specification Comparison' : 'Latest Inspections'}</span></div>
    <div class="tw-dscroll"><table class="tw-dcmp"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>
    ${list.map((a, i) => sourcesHtml(a, cs[i]).replace('<summary>Sources', `<summary>${esc(a.asset.id)} sources`)).join('')}</div>`;
}

/** Assets with recurring or worsening inspection findings. */
export function fleetHtml(f) {
  if (!f.assets.length) return `<div class="tw-doc"><p class="tw-dempty">None of the ${f.checkedAssets} assets with two or more linked documents has an inspection report.</p></div>`;
  const rows = f.assets.map(x => `<li>
    <button type="button" class="tw-dasset" data-asset="${esc(x.assetId)}">${esc(x.assetId)}</button>
    <span><small>${x.inspections} report${x.inspections === 1 ? '' : 's'}${x.latest?.condition ? ` · latest ${esc(conditionText(x.latest.condition))} (${esc(x.latest.date)})` : ''}</small>
    ${x.recurring.length ? x.recurring.map(r => `<span class="tw-dline">${pill(TREND_LABEL[r.trend][0], TREND_LABEL[r.trend][1])} ${esc(r.item)} <small>${esc(r.basis)}</small> ${citer(null, { fallback: 'Report' }).chips(r.citations)}</span>`).join('')
      : x.inspections < 2 ? '<span class="tw-dmuted">One report: recurrence cannot be established.</span>' : '<span class="tw-dmuted">No finding recorded in more than one report.</span>'}
    ${x.worsening ? `<small>${x.worsening} worsening item${x.worsening === 1 ? '' : 's'} (findings and measurements)</small>` : ''}</span></li>`);
  return `<div class="tw-doc"><div class="tw-doc-head"><b>Recurring inspection issues</b><span>${f.assets.filter(x => x.recurring.length).length} of ${f.withInspections} inspected assets</span></div>
    <ul class="tw-dlist is-fleet">${rows.join('')}</ul>
    <p class="tw-dmuted">Checked ${f.checkedAssets} assets with two or more linked documents, read from their contents${f.model?.versionNumber ? ` (model v${esc(f.model.versionNumber)})` : ''}.</p></div>`;
}

/** The first sentence the chat shows for an analysis. */
export function docSay(a, { intent, field = null, focus = null } = {}) {
  const id = a.asset.id;
  const t = a.inspections.timeline.filter(x => x.inspectionDate);
  if (!a.documents.linked) return `No ACC documents are linked to ${id}.`;
  if (!a.documents.analysed) return `${id} has ${a.documents.linked} linked document${a.documents.linked === 1 ? '' : 's'}, but none could be read.`;
  if (intent === 'ASSET_TECHNICAL_SPECIFICATIONS' && field) {
    const f = [...a.specifications.keyFields, ...a.specifications.otherFields].find(x => x.key === field);
    if (!f || f.missing) return `${id}'s linked documents do not state its ${(f?.label ?? field).toLowerCase()}.`;
    if (f.conflict) return `Two documents give different values for ${id}'s ${f.label.toLowerCase()}: ${f.values.map(v => v.value).join(' and ')}.`;
    return `${id}'s ${f.label.toLowerCase()}: ${f.value}.`;
  }
  if (intent === 'ASSET_TECHNICAL_SPECIFICATIONS') return a.specifications.fromDocuments.length ? `Here is what ${id}'s documents state about its specifications.` : `The linked documents do not include a readable technical datasheet for ${id}.`;
  if (intent === 'ASSET_REPLACEMENT_READINESS') return `I read ${id}'s ${a.documents.analysed} linked ACC document${a.documents.analysed === 1 ? '' : 's'} for the replacement review.`;
  if (!a.inspections.count) return `No inspection reports were found among ${id}'s linked documents.`;
  if (intent === 'ASSET_CONDITION_TREND' && focus === 'CLOSURE') {
    const notDone = a.outstanding.filter(o => o.status === 'Not completed (documented)').length;
    const open = a.outstanding.filter(o => o.kind === 'ACTION').length;
    return notDone ? `Not according to the documents: ${notDone} action${notDone === 1 ? ' is' : 's are'} documented as not completed, and ${open - notDone} more have no documented closure.` : open ? `The documents do not establish it: ${open} action${open === 1 ? ' has' : 's have'} no documented closure.` : 'The linked documents record no open actions.';
  }
  if (intent === 'ASSET_CONDITION_TREND') {
    const c = a.inspections.comparison;
    if (c.reports < 2) return `Only one dated inspection report is linked to ${id}, so a change over time cannot be established.`;
    const rec = c.findings.filter(f => f.recurring).length;
    return c.condition?.trend === 'WORSENING_WITH_EVIDENCE' ? `Yes: across ${c.reports} reports ${id}'s condition went from ${c.condition.from.label} to ${c.condition.to.label}${rec ? `, with ${rec} finding${rec === 1 ? '' : 's'} recorded more than once` : ''}.`
      : c.condition?.trend === 'IMPROVING_WITH_EVIDENCE' ? `${id}'s recorded condition improved from ${c.condition.from.label} to ${c.condition.to.label}.` : `${c.reports} reports compared; ${rec} finding${rec === 1 ? ' was' : 's were'} recorded more than once.`;
  }
  if (intent === 'ASSET_INSPECTION_HISTORY' && focus === 'DEFECTS') {
    const l = t[0];
    return l ? `The latest inspection of ${id} (${l.inspectionDate}) records ${l.counts.defects} defect${l.counts.defects === 1 ? '' : 's'} and ${l.counts.attention} item${l.counts.attention === 1 ? '' : 's'} needing attention.` : `${id}'s inspection reports have no documented date.`;
  }
  return t.length ? `${id} has ${t.length} dated inspection report${t.length === 1 ? '' : 's'}${t.length > 1 ? `, from ${t.at(-1).inspectionDate} to ${t[0].inspectionDate}` : ` (${t[0].inspectionDate})`}.` : `${id} has inspection reports, but none states its inspection date.`;
}

/** The citation of an answer that "show me where this was mentioned" opens. */
export function primaryCitation(a, intent) {
  const latest = a.inspections.timeline.find(t => t.inspectionDate);
  if (intent === 'ASSET_TECHNICAL_SPECIFICATIONS') return a.specifications.keyFields.find(f => !f.missing)?.source ?? null;
  return a.outstanding[0]?.citation ?? latest?.mainFinding?.citation ?? latest?.dateCitation ?? a.specifications.keyFields.find(f => !f.missing)?.source ?? null;
}
