/**
 * The document-intelligence workspace inside an Ask the Twin answer: one asset's documents
 * (server/ifcSpatial/docIntel.mjs → analysis.review) as three tabs — Overview, Inspections, Specifications —
 * over the same analysis, for any kind of asset and any document question. Overview first, details on demand,
 * evidence always one click away.
 *
 *  - The Overview follows the question (reviewMode): its summary, its three metrics and its next steps —
 *    "Before replacement", "Maintenance considerations", "Condition assessment" — come from the analysis's
 *    summaries and nextSteps for that kind of question; the electrical model is added for replacement only.
 *  - Every tab is rendered once from the analysis; switching tabs only shows another panel (no request,
 *    no re-render: networkTwin.js toggles `hidden`), so ACC, the extraction and the map are untouched.
 *  - Citations are numbered per document ([1] asset sheet, [2] latest inspection…). A number opens a small
 *    card (citePopoverHtml) with the document, version, page and the extracted line, Preview (the existing
 *    document preview at that page) and Open in ACC. Each claim cites only its own lines.
 *  - Nothing here is about one asset: fields, groups and counts all come from the analysis.
 */
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const REVIEW_TABS = Object.freeze([['overview', 'Overview'], ['inspections', 'Inspections'], ['specifications', 'Specifications']]);
/** The heading of the Overview's next steps, by what the question is about. */
export const NEXT_STEPS_LABEL = Object.freeze({ replacement: 'Before replacement', maintenance: 'Maintenance considerations', condition: 'Condition assessment',
  specifications: 'Specification follow-up', general: 'Recommended next steps' });
const TREND = {
  WORSENING_WITH_EVIDENCE: ['Worsening', 'bad'], RECURRING_FINDING: ['Recurring', 'warn'], NEW_FINDING: ['New', 'warn'],
  RESOLVED_WITH_EVIDENCE: ['Recorded OK later', 'ok'], IMPROVING_WITH_EVIDENCE: ['Improving', 'ok'], INSUFFICIENT_EVIDENCE: ['Not in latest report', 'neutral'],
};
const SEV = { DEFECT: ['Defect', 'bad'], ATTENTION: ['Attention', 'warn'], OK: ['OK', 'ok'] };
const BASIS = { DOCUMENTED: 'Documented', DERIVED: 'Derived from records', CHECK_REQUIRED: 'Suggested check', NETWORK: 'Electrical model' };
const CLOSURE = { COMPLETED_WITH_EVIDENCE: ['Completion documented', 'ok'], NOT_COMPLETED_WITH_EVIDENCE: ['Documented as not completed', 'bad'], NOT_VERIFIED: ['Closure not verified', 'warn'] };
const KIND = { transformer: 'Transformer', crane: 'Crane', breaker: 'Circuit breaker', switch: 'Switch', switchgear: 'Switchgear', cable: 'Cable', light: 'Lighting', generator: 'Generator', generic: 'Asset' };
const ANALYSIS_LABEL = {
  ASSET_REPLACEMENT_READINESS: 'Replacement review', ASSET_INSPECTION_HISTORY: 'Inspection history', ASSET_TECHNICAL_SPECIFICATIONS: 'Technical specifications',
  ASSET_MAINTENANCE_HISTORY: 'Actions and maintenance', ASSET_CONDITION_TREND: 'Condition over time', ASSET_DOCUMENT_SUMMARY: 'Document summary',
};
const dot = tone => `<i class="tw-rdot is-${tone}" aria-hidden="true"></i>`;
const tag = (text, tone = 'neutral') => `<span class="tw-rtag is-${tone}">${esc(text)}</span>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const condTone = c => (!Number.isFinite(c?.score) ? 'neutral' : c.score / (c.scale || 5) <= 0.4 ? 'bad' : c.score / (c.scale || 5) <= 0.6 ? 'warn' : 'ok');
const condText = c => (c ? `${c.label ?? ''}${Number.isFinite(c.score) ? ` ${c.score}/${c.scale ?? 5}` : ''}`.trim() : '');
const READ = new Set(['SUCCESS', 'PARTIAL']);

// ---- sources: one number per document, stable for the analysis ----

/**
 * The analysis's source registry: specification sheets first, then inspections latest first, then the rest.
 * `refs(citations)` renders "[1, 3]" for the citations a claim rests on (one button per document and page).
 */
export function sourceRegistry(a) {
  const order = s => (s.documentType === 'TECHNICAL_SPECIFICATION' ? 0 : s.inspectionDate ? 1 : 2);
  const list = [...(a.sources ?? [])].sort((x, y) => order(x) - order(y) || String(y.inspectionDate ?? '').localeCompare(String(x.inspectionDate ?? '')));
  const n = new Map(list.map((s, i) => [s.documentId, i + 1]));
  const byId = new Map(list.map(s => [s.documentId, s]));
  const used = new Map();
  const label = s => (!s ? 'Document' : s.inspectionDate ? `Inspection ${s.inspectionDate}` : s.documentType === 'TECHNICAL_SPECIFICATION' ? 'Asset sheet' : s.title ?? s.fileName ?? 'Document');
  const one = c => {
    const s = byId.get(c.documentId);
    if (!n.has(c.documentId)) return '';
    if (!used.has(c.documentId)) used.set(c.documentId, new Set());
    if (c.page) used.get(c.documentId).add(c.page);
    // The document's title, version and ACC link are on its row in the sources list (data-src-doc).
    return `<button type="button" class="tw-ref" data-ref-doc="${esc(c.documentId)}"${c.page ? ` data-ref-page="${esc(c.page)}"` : ''}${c.section ? ` data-ref-sec="${esc(c.section)}"` : ''} data-ref-ev="${esc(c.evidenceText ?? '')}" title="${esc(`${label(s)}${c.page ? ` · p.${c.page}` : ''}`)}">${n.get(c.documentId)}</button>`;
  };
  const refs = list => {
    const seen = new Map();
    for (const c of list ?? []) if (c?.documentId && n.has(c.documentId)) seen.set(`${c.documentId}:${c.page ?? ''}`, c);
    const cs = [...seen.values()].sort((x, y) => n.get(x.documentId) - n.get(y.documentId) || (x.page ?? 0) - (y.page ?? 0));
    return cs.length ? `<span class="tw-refs">[${cs.map(one).join('<span class="tw-refsep">, </span>')}]</span>` : '';
  };
  return { list, n, used, label, refs };
}

/** The card a citation number opens (built from the number's data attributes). */
export function citePopoverHtml(ref, src = {}) {
  const d = { ...ref, refN: src.srcN ?? '', refTitle: src.srcTitle ?? 'Document', refVer: src.srcVer ?? null, refUrl: src.srcUrl ?? null };
  return `<div class="tw-cpop" role="dialog" aria-label="Source ${esc(d.refN)}">
    <div class="tw-cpop-h"><b>[${esc(d.refN)}] ${esc(d.refTitle)}</b><button type="button" class="tw-cpop-x" data-act="refClose" aria-label="Close">×</button></div>
    <small>${[d.refVer ? `ACC version V${d.refVer}` : null, d.refPage ? `page ${d.refPage}` : null, d.refSec || null].filter(Boolean).map(esc).join(' · ')}</small>
    ${d.refEv ? `<blockquote>“${esc(d.refEv)}”</blockquote>` : ''}
    <div class="tw-cpop-acts"><button type="button" class="tw-rbtn" data-doc-cite="${esc(d.refDoc)}"${d.refPage ? ` data-doc-page="${esc(d.refPage)}"` : ''}>Preview${d.refPage ? ` p.${esc(d.refPage)}` : ''}</button>
      ${d.refUrl ? `<a class="tw-rbtn" href="${esc(d.refUrl)}" target="_blank" rel="noopener noreferrer">Open in ACC</a>` : ''}</div></div>`;
}

function sourcesHtml(a, reg) {
  const read = a.sources.filter(s => READ.has(s.status));
  const reason = s => ({ FAILED: s.errors?.[0] ?? 'Its contents could not be extracted.', ACCESS_DENIED: 'Your ACC account cannot read it.', DOCUMENT_MISSING: 'Not found in ACC at the last sync.',
    NOT_USED_OTHER_ASSET: `It states it is about ${s.statedAssetId}, so it was not used for ${a.asset.id}.` })[s.status] ?? s.errors?.[0] ?? 'Could not be read.';
  const rows = reg.list.map(s => {
    const pages = [...(reg.used.get(s.documentId) ?? [])].sort((x, y) => x - y);
    return `<li data-src-doc="${esc(s.documentId)}" data-src-n="${reg.n.get(s.documentId)}" data-src-title="${esc(reg.label(s))} · ${esc(s.fileName ?? '')}"${s.version ? ` data-src-ver="${esc(s.version)}"` : ''}${s.webViewUrl ? ` data-src-url="${esc(s.webViewUrl)}"` : ''}><span class="tw-srcn">${reg.n.get(s.documentId)}</span><span class="tw-srcm"><b>${esc(reg.label(s))}</b><small>${esc([s.fileName, s.version ? `V${s.version}` : null,
      pages.length ? `cited p.${pages.join(', ')}` : null, s.status === 'PARTIAL' ? `pages ${s.unreadablePages.join(', ')} unreadable` : null].filter(Boolean).join(' · '))}</small>
      ${READ.has(s.status) ? '' : `<small class="tw-rwarn">${esc(reason(s))}</small>`}</span>
      <span class="tw-srca">${s.status === 'DOCUMENT_MISSING' ? '' : `<button type="button" class="tw-rlink" data-doc-cite="${esc(s.documentId)}"${pages[0] ? ` data-doc-page="${pages[0]}"` : ''}>Preview</button>`}${s.webViewUrl ? `<a class="tw-rlink" href="${esc(s.webViewUrl)}" target="_blank" rel="noopener noreferrer">ACC</a>` : ''}</span></li>`;
  });
  const ids = a.identityNotes?.length ? `<p class="tw-rmuted">${esc(plural(a.identityNotes.length, 'document states', 'documents state'))} a different IFC GlobalId than the model: ${a.identityNotes.map(x => esc(x.fileName)).join(', ')}.</p>` : '';
  return `<details class="tw-rev-src"><summary><span class="tw-rev-src-l"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/></svg>
      ${esc(plural(read.length, 'ACC document'))} analyzed${a.sources.length > read.length ? ` · ${a.sources.length - read.length} not read` : ''}</span><span class="tw-rev-src-r">Sources</span></summary>
    <ol class="tw-srclist">${rows.join('')}</ol>${ids}
    <p class="tw-rmuted">Read from the documents' contents in ACC${a.modelVersion ? ` · linked to ${esc(a.modelVersion)}` : ''}.</p></details>`;
}

// ---- header, provenance ----

function headerHtml(a, { intent, status }) {
  const kind = KIND[a.asset.category] ?? 'Asset';
  return `<div class="tw-rev-h"><div><b class="tw-rev-id">${esc(a.asset.id)}</b><small>${esc(kind)} · ${esc(ANALYSIS_LABEL[intent] ?? 'Document review')}</small></div>
    ${status ? `<span class="tw-rev-status is-${esc(status.tone ?? 'neutral')}" title="Reported operational status in the model">${esc(status.label)}</span>` : ''}</div>`;
}

/** The documents' own statement that they are demo data, kept in view on every tab. */
function provenanceHtml(a, reg) {
  if (!a.caveats?.length) return '';
  const demo = a.caveats.every(x => /illustrative|demo|mock|not as-built|not a real/i.test(x.text));
  return `<details class="tw-rev-prov${demo ? ' is-demo' : ''}"><summary><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6h.01"/></svg>
      ${demo ? 'Illustrative demo records · Not real inspections' : 'Document notes'}</summary>
    <ul>${a.caveats.map(x => `<li>${esc(x.text)} ${reg.refs([x.citation])}</li>`).join('')}</ul>
    ${demo ? '<p class="tw-rmuted">The linked documents describe themselves as illustrative; the findings below are not real Seagirt inspection results.</p>' : ''}</details>`;
}

// ---- overview ----

/** Condition ratings as documented, oldest to newest; nothing is drawn for an inspection without a score. */
export function conditionTrendSvg(points) {
  if (!points?.length) return '';
  const W = 300, H = 104, padX = 26, top = 24, bottom = 74;
  const scale = Math.max(...points.map(p => p.scale ?? 5));
  const x = i => (points.length === 1 ? W / 2 : padX + (i * (W - 2 * padX)) / (points.length - 1));
  const y = s => bottom - ((s - 1) / Math.max(scale - 1, 1)) * (bottom - top);
  const colour = { ok: '#5fe3a1', warn: '#ffc861', bad: '#ff8a8a', neutral: '#b9c8db' };
  const grid = [1, Math.ceil(scale / 2), scale].map(s => `<line x1="${padX - 8}" x2="${W - padX + 8}" y1="${y(s)}" y2="${y(s)}" class="tw-ct-grid"/>`).join('');
  const line = points.length > 1 ? `<polyline points="${points.map((p, i) => `${x(i)},${y(p.score)}`).join(' ')}" class="tw-ct-line"/>` : '';
  const marks = points.map((p, i) => {
    const c = colour[condTone(p)];
    return `<circle cx="${x(i)}" cy="${y(p.score)}" r="5.5" fill="${c}"/><text x="${x(i)}" y="${y(p.score) - 10}" text-anchor="middle" class="tw-ct-v" fill="${c}">${p.score}/${p.scale ?? 5}</text>
      <text x="${x(i)}" y="${H - 12}" text-anchor="middle" class="tw-ct-d">${esc(points.filter(q => q.date.slice(0, 4) === p.date.slice(0, 4)).length > 1 ? p.date : p.date.slice(0, 4))}</text>
      <text x="${x(i)}" y="${H - 1}" text-anchor="middle" class="tw-ct-l" fill="${c}">${esc(p.label ?? '')}</text>`;
  }).join('');
  const desc = points.map(p => `${p.date}: ${condText(p)}`).join(', ');
  return `<figure class="tw-ct"><figcaption>Documented condition</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Documented condition rating: ${desc}`)}">${grid}${line}${marks}</svg></figure>`;
}

/** Up to three numbers for the question asked; each opens the tab with its detail. */
function metricsFor(a, mode) {
  const c = a.review.counts;
  const m = (v, l, tone, tab, title, open = null) => ({ v, l, tone, tab, title, open });
  const defects = m(c.latestDefects, c.latestDefects === 1 ? 'Latest defect' : 'Latest defects', c.latestDefects ? 'bad' : 'ok', 'inspections', 'Defects recorded in the latest inspection report');
  const openActs = m(c.actionsWithoutVerifiedClosure, 'Actions not verified closed', c.actionsWithoutVerifiedClosure ? 'warn' : 'ok', 'inspections', 'Corrective actions raised in inspections with no later document recording completion', 'actions');
  const missing = m(c.missingSpecs, 'Missing key specs', c.missingSpecs ? 'neutral' : 'ok', 'specifications', 'Key specifications no linked document states', 'missing');
  if (mode === 'specifications') {
    return [m(c.keySpecs - c.missingSpecs, 'Key specs documented', 'neutral', 'specifications', ''), missing, m(c.conflicts, c.conflicts === 1 ? 'Conflicting value' : 'Conflicting values', c.conflicts ? 'bad' : 'ok', 'specifications', 'Values that differ between documents')];
  }
  if (!a.inspections.count) return [m(a.documents.analysed, 'Documents read', 'neutral', null, ''), missing];
  if (mode === 'maintenance') {
    return [openActs, m(c.actionsNotCompletedDocumented, 'Documented as not completed', c.actionsNotCompletedDocumented ? 'bad' : 'ok', 'inspections', 'A later report states the action was not done', 'actions'),
      m(c.restrictions, c.restrictions === 1 ? 'Operating restriction' : 'Operating restrictions', c.restrictions ? 'warn' : 'ok', 'inspections', 'Restrictions set in the latest inspection report')];
  }
  if (mode === 'condition') {
    return [defects, m(c.worseningFindings, c.worseningFindings === 1 ? 'Worsening finding' : 'Worsening findings', c.worseningFindings ? 'bad' : 'ok', 'inspections', 'Findings more severe than in the previous report', 'components'),
      m(c.measurementsCompared ? `${c.measurementsWorsening}/${c.measurementsCompared}` : '—', 'Test results deteriorated', c.measurementsWorsening ? 'warn' : 'ok', 'inspections', 'Results compared between the last two reports giving each', 'measurements')];
  }
  return [defects, openActs, missing];
}

/** A next-step's link: the tab (and the part of it) that holds the detail. */
const STEP_LINK = { missing: ['specifications', 'missing', 'View list'], actions: ['inspections', 'actions', 'View actions'], component: ['inspections', 'component', 'View history'], measurements: ['inspections', 'measurements', 'View results'] };
function stepHtml(x, reg) {
  const link = STEP_LINK[x.link];
  return `<li>${dot(x.basis === 'DOCUMENTED' ? 'info' : 'warn')}<span>${esc(x.text)} ${reg.refs(x.sources)}${link ? ` <button type="button" class="tw-rlink" data-doc-tab="${link[0]}" data-doc-open="${link[1]}"${x.item ? ` data-doc-item="${esc(x.item)}"` : ''}>${link[2]}</button>` : ''} <small>${esc(BASIS[x.basis] ?? '')}</small></span></li>`;
}

/** The electrical model's part of "before replacement": who loses supply, candidates, the existing simulation. */
function impactStepHtml(impact) {
  if (!impact) return '';
  const n = impact.lost.length;
  const over = impact.candidates.filter(o => o.capacity === 'OVERLOAD').length;
  const line = n
    ? `Taking ${impact.assetId} out of service: ${plural(n, 'consumer')} ${n === 1 ? 'loses' : 'lose'} supply in the electrical model; ${impact.candidates.length ? `${plural(impact.candidates.length, 'candidate transfer option')}${over ? ` (${over} ${over === 1 ? 'overloads' : 'overload'} in the model)` : ''} for engineering review` : 'the model has no candidate transfer option'}.`
    : `Taking ${impact.assetId} out of service leaves every consumer supplied in the electrical model.`;
  return `<li>${dot(n ? 'warn' : 'info')}<span>${esc(line)} <small>${BASIS.NETWORK}</small>
    ${n || impact.candidates.length || impact.upstream ? `<details class="tw-rsub"><summary>Affected consumers and transfer candidates</summary>${operationalImpactHtml(impact)}</details>` : ''}</span></li>`;
}

/**
 * Recommended next steps: one collapsed row named for the question ("Before replacement", "Maintenance
 * considerations", "Condition assessment"…); opening it shows the steps, grouped where they have groups.
 */
function nextStepsHtml(a, reg, { mode, impact }) {
  const steps = a.review.nextSteps?.[mode] ?? [];
  const label = mode === 'general' ? 'General review' : NEXT_STEPS_LABEL[mode];
  let body;
  let count;
  if (mode === 'replacement') {
    const groups = [...new Set(steps.map(x => x.group))];
    const items = groups.flatMap(g => [`<li class="tw-rgroup">${esc(g)}</li>`, ...steps.filter(x => x.group === g).map(x => (x.missingSpecs ? stepHtml({ ...x, text: `Confirm the ${plural(a.specifications.missing.length, 'missing key specification')} from the nameplate or manufacturer.` }, reg) : stepHtml(x, reg)))]);
    if (impact) items.push('<li class="tw-rgroup">Operational impact</li>', impactStepHtml(impact));
    body = `<ul class="tw-rlist">${items.join('')}</ul>
      ${impact ? `<button type="button" class="tw-rgo" data-act="docSimulate" data-asset-id="${esc(impact.assetId)}">Open outage simulation <span aria-hidden="true">→</span></button>` : ''}
      <p class="tw-rbound">${esc(a.boundary)} These checks are not an authorization to replace the equipment.</p>`;
    count = [plural(steps.length, 'check'), impact?.lost.length ? `${plural(impact.lost.length, 'consumer')} affected in the model` : null].filter(Boolean).join(' · ');
  } else {
    if (!steps.length) return '';
    body = `<ul class="tw-rlist">${steps.map(x => stepHtml(x, reg)).join('')}</ul>`;
    count = plural(steps.length, 'step');
  }
  return `<section class="tw-rnext"><h5 class="tw-rh">Recommended next steps</h5>
    <details class="tw-rstep" data-next-steps="${esc(mode)}"><summary><span>${esc(label)}</span><small>${esc(count)}</small></summary><div class="tw-rstep-b">${body}</div></details></section>`;
}

function overviewHtml(a, reg, { impact, mode }) {
  const r = a.review;
  const sum = r.summaries?.[mode] ?? r.conclusion;
  const metrics = metricsFor(a, mode).slice(0, 3);
  const concern = k => `<li class="tw-concern">${dot(k.severity === 'DEFECT' ? 'bad' : 'warn')}<div><b>${esc(k.title)}</b><p>${esc(k.text)} ${reg.refs(k.citations)}</p></div></li>`;
  // Specification questions: the findings are the gaps, shown under next steps; no inspection concerns.
  const concerns = mode === 'specifications' ? [] : r.concerns;
  return `<div class="tw-concl is-${esc(sum.tone)}"><h4>${esc(sum.title)}</h4><p>${esc(sum.text)}</p></div>
    ${mode === 'specifications' ? '' : conditionTrendSvg(r.conditionTrend)}
    <div class="tw-rmetrics">${metrics.map(x => `<${x.tab ? `button type="button" data-doc-tab="${x.tab}"${x.open ? ` data-doc-open="${x.open}"` : ''}` : 'div'} class="tw-rmetric is-${x.tone}"${x.title ? ` title="${esc(x.title)}"` : ''}><b>${esc(x.v)}</b><span>${esc(x.l)}</span></${x.tab ? 'button' : 'div'}>`).join('')}</div>
    ${concerns.length ? `<h5 class="tw-rh">Key findings</h5><ul class="tw-concerns">${concerns.map(concern).join('')}</ul>` : ''}
    ${nextStepsHtml(a, reg, { mode, impact })}`;
}

// ---- inspections ----

function inspectionTimelineHtml(a, reg, { openLatest }) {
  const t = a.inspections.timeline;
  const notes = (a.conditionNotes ?? []).filter(n => /condition|assessment/i.test(n.label)).slice(0, 2);
  const noteHtml = notes.length ? `<p class="tw-rnote">Asset sheet (not an inspection): ${notes.map(n => `${esc(n.label)} <b>${esc(n.value)}</b>`).join(' · ')} ${reg.refs(notes.map(n => n.citation))}</p>` : '';
  if (!t.length) return `<p class="tw-rempty">No inspection reports are among ${esc(a.asset.id)}'s linked documents.</p>${noteHtml}`;
  const card = (x, i) => {
    const load = x.operatingLoad;
    const facts = [x.reportNumber ? ['Report', x.reportNumber] : null, x.type ? ['Type', x.type] : null, x.inspector ? ['Inspector', x.inspector] : null,
      x.conditions?.value ? ['Conditions', x.conditions.value, x.conditions.citation] : null, x.operatingState?.value ? ['Operating state', x.operatingState.value, x.operatingState.citation] : null,
      x.nextDue?.value ? ['Next due', x.nextDue.value, x.nextDue.citation] : null].filter(Boolean);
    const findings = x.findings.map(f => `<li>${dot(SEV[f.severity]?.[1] ?? 'neutral')}<span><b>${esc(f.item)}</b>${f.notes ? ` — ${esc(f.notes)}` : ''} ${reg.refs([f.citation])}</span></li>`);
    const obs = x.observations.map(o => `<li>${dot(o.severity === 'DEFECT' ? 'bad' : o.severity === 'ATTENTION' ? 'warn' : 'info')}<span>${o.topic ? `<b>${esc(o.topic)}</b> — ` : ''}${esc(o.text)} ${reg.refs([o.citation])}</span></li>`);
    return `<li><details class="tw-insp"${openLatest && i === 0 ? ' open' : ''}><summary>
        <span class="tw-insp-h"><b>${esc(x.inspectionDate ?? 'Date not documented')}</b>${x.condition ? tag(condText(x.condition), condTone(x.condition)) : ''}<small>${esc([x.counts.defects ? plural(x.counts.defects, 'defect') : null, x.counts.attention ? `${x.counts.attention} attention` : null].filter(Boolean).join(' · ') || 'no findings recorded')}</small></span>
        <span class="tw-insp-s">${x.mainFinding ? esc(x.mainFinding.text) : '<i>No summary in the report.</i>'} ${reg.refs([x.mainFinding?.citation ?? x.dateCitation])}</span></summary>
      <div class="tw-insp-b">
        ${findings.length ? `<h6>Findings</h6><ul class="tw-rlist">${findings.join('')}</ul>` : ''}
        ${obs.length ? `<h6>Observations</h6><ul class="tw-rlist">${obs.join('')}</ul>` : ''}
        ${x.measurements?.length ? `<details class="tw-rsub"><summary>${esc(plural(x.measurements.length, 'measurement'))}</summary><table class="tw-rtable"><tbody>${x.measurements.map(m => `<tr><th>${esc(m.name)}</th><td>${esc(m.value)}${m.unit && !m.name.includes(m.unit) ? ` ${esc(m.unit)}` : ''} ${reg.refs([m.citation])}</td></tr>`).join('')}</tbody></table></details>` : ''}
        ${x.restrictions.length ? `<h6>Operating restrictions</h6><ul class="tw-rlist">${x.restrictions.map(r => `<li>${dot('info')}<span>${esc(r.text)} ${reg.refs([r.citation])}</span></li>`).join('')}</ul>` : ''}
        ${x.actions.length ? `<h6>Recommended actions</h6><ul class="tw-rlist">${x.actions.map(r => `<li>${dot('neutral')}<span>${esc(r.action)}${r.priority ? ` <small>${esc(r.priority)}${r.due ? ` · due ${esc(r.due)}` : ''}</small>` : ''} ${reg.refs([r.citation])}</span></li>`).join('')}</ul>` : ''}
        ${facts.length ? `<dl class="tw-rkv">${facts.map(([k, v, cit]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)} ${cit ? reg.refs([cit]) : ''}</dd></div>`).join('')}</dl>` : ''}
        ${load?.note ? `<p class="tw-rnote is-warn">${esc(load.note)}</p>` : ''}
        <p class="tw-rmuted">Source: ${reg.refs([x.dateCitation ?? x.mainFinding?.citation])} ${esc(x.fileName)}</p></div></details></li>`;
  };
  return `<ol class="tw-insps">${t.map(card).join('')}</ol>${noteHtml}`;
}

/** One row per component: its trend across reports; open it for every observation and related actions. */
function componentTrendHtml(a, reg, { openItem = null } = {}) {
  const r = a.review;
  if (a.inspections.comparison.reports < 2) return a.inspections.count ? `<p class="tw-rempty">Only ${a.inspections.comparison.reports === 1 ? 'one dated inspection report' : 'undated reports'}: no change over time can be established.</p>` : '';
  if (!r.components.length) return '<p class="tw-rempty">No component has a finding other than OK in any report.</p>';
  const rows = r.components.map(c => {
    const [label, tone] = TREND[c.trend] ?? ['—', 'neutral'];
    const open = openItem && c.item.toLowerCase().includes(openItem.toLowerCase());
    return `<details class="tw-comp"${open ? ' open' : ''}><summary><span>${esc(c.item)}</span>${tag(label, tone)}</summary>
      <ul class="tw-rlist">${c.observations.map(o => `<li>${dot(SEV[o.severity]?.[1] ?? 'neutral')}<span><b>${esc(o.date)}</b> ${esc(o.result ?? '')}${o.notes ? ` — ${esc(o.notes)}` : ''} ${reg.refs([o.citation])}</span></li>`).join('')}</ul>
      <p class="tw-rmuted">${esc(c.basis)}</p>
      ${c.actions.length ? `<p class="tw-rmuted">Related actions: ${c.actions.map(x => `${esc(x.action)} (${esc(x.raisedOn)}, ${esc(CLOSURE[x.closure][0].toLowerCase())}) ${reg.refs([x.citation])}`).join('; ')}</p>` : ''}</details>`;
  });
  return `<div class="tw-comps" role="table" aria-label="Changes over time"><div class="tw-comps-h" role="row"><span>Component</span><span>Trend</span></div>${rows.join('')}</div>`;
}

function measurementComparisonHtml(a, reg, { open = false } = {}) {
  const r = a.review;
  const cmp = a.inspections.comparison;
  if (!cmp.measurements.length) return '';
  const dates = [...new Set(r.measurementGroups.flatMap(g => [g.fromDate, g.toDate]))].filter(Boolean).sort();
  const loads = a.inspections.timeline.filter(t => t.operatingLoad).map(t => ({ date: t.inspectionDate, ...t.operatingLoad }));
  const diff = cmp.caveats.length > 0;
  const row = m => {
    const [label, tone] = m.trend === 'INSUFFICIENT_EVIDENCE' ? ['Direction not stated', 'neutral'] : TREND[m.trend];
    return `<tr><th>${esc(m.name)}</th><td>${esc(m.change.from)} → ${esc(m.change.to)}${m.unit && !m.name.includes(m.unit) ? ` ${esc(m.unit)}` : ''}</td><td>${tag(label === 'Worsening' ? 'Deteriorated' : label, tone)}</td><td>${reg.refs(m.points.slice(-2).map(p => p.citation))}</td></tr>`;
  };
  return `<details class="tw-rsec"${open ? ' open' : ''}><summary><span>Test results</span><small>${esc(`${cmp.measurements.length} compared between the ${dates.length > 2 ? 'last two reports giving each' : `${dates[0]} and ${dates.at(-1)} reports`} · ${r.counts.measurementsWorsening} deteriorated`)}</small></summary>
    ${diff ? `<p class="tw-rnote is-warn">Measurements were recorded under different operating conditions and require engineering validation before direct comparison. ${reg.refs(cmp.caveats.flatMap(c => c.citations))}</p>` : ''}
    ${r.measurementGroups.map(g => `<h6>${esc(g.topic)} <small>${g.worsening} of ${g.compared} deteriorated</small></h6><table class="tw-rtable is-cmp"><tbody>${g.items.map(row).join('')}</tbody></table>
      ${g.interpretation ? `<p class="tw-rmuted">Report interpretation: ${esc(g.interpretation.text.replace(/^interpretation:\s*/i, ''))} ${reg.refs([g.interpretation.citation])}</p>` : ''}`).join('')}
    ${loads.length ? `<h6>Operating load at each inspection</h6><table class="tw-rtable"><tbody>${loads.map(l => `<tr><th>${esc(l.date)}</th><td>${esc(l.value)}${l.statedPercent !== null ? ` <small>(report states about ${esc(l.statedPercent)}% of nameplate)</small>` : ''} ${reg.refs([l.citation])}</td></tr>`).join('')}</tbody></table>
      ${loads.some(l => l.note) ? `<p class="tw-rnote">${esc(loads.find(l => l.note).note)}</p>` : ''}` : ''}
    <p class="tw-rmuted">Each test compares the two most recent dated values. "Deteriorated" uses the usual reading of that test (for example, higher moisture or lower breakdown voltage is worse); it is derived, not stated by the reports. Original values and units are as written in the reports.</p>
    ${cmp.undated.length ? `<p class="tw-rmuted">${esc(plural(cmp.undated.length, 'report has', 'reports have'))} no inspection date and ${cmp.undated.length === 1 ? 'is' : 'are'} left out.</p>` : ''}</details>`;
}

function inspectionsHtml(a, reg, o) {
  return `${inspectionTimelineHtml(a, reg, o)}
    ${a.inspections.comparison.reports >= 2 ? `<h5 class="tw-rh">Changes over time</h5>${componentTrendHtml(a, reg, o)}` : componentTrendHtml(a, reg, o)}
    ${findingsAndActionsHtml(a, reg, o)}
    ${measurementComparisonHtml(a, reg, { open: o.openMeasurements })}`;
}

// ---- specifications ----

const HIGHLIGHT_KEYS = ['ratedPower', 'voltageRatio', 'voltageLevel', 'ratedCurrent', 'interrupting', 'ratedLoad', 'wattage', 'capacityKw'];
function specificationsHtml(a, reg, { field = null, openMissing = false } = {}) {
  const s = a.specifications;
  const all = [...s.keyFields, ...s.otherFields.filter(f => f.key)];
  const get = k => all.find(f => f.key === k && !f.missing);
  const shown = f => f.display ?? f.value;
  // Primary ratings for this kind of asset: a transformer's two voltages read as one ratio.
  const highlights = [];
  for (const k of HIGHLIGHT_KEYS) {
    if (highlights.length >= 3) break;
    if (k === 'voltageRatio') {
      const p = get('primaryVoltage'), q = get('secondaryVoltage');
      if (p && q && !p.conflict && !q.conflict) highlights.push({ keys: ['primaryVoltage', 'secondaryVoltage'], label: 'Voltage ratio', value: `${shown(p).replace(/\s*kV$/, '')} / ${shown(q)}`, sources: [p.source, q.source] });
      continue;
    }
    if (k === 'voltageLevel' && get('primaryVoltage')) continue;
    if (k === 'capacityKw' && get('ratedPower')) continue;
    const f = get(k);
    if (f && !f.conflict) highlights.push({ keys: [k], label: f.label, value: shown(f), sources: [f.source] });
  }
  const row = f => `<tr class="${f.key && f.key === field ? 'is-focus' : ''}"><th>${esc(f.label)}</th><td>${f.conflict
    ? `${f.values.map(v => `<span class="tw-rconf">${esc(v.display ?? v.value)} ${reg.refs(v.sources)}</span>`).join('')}${tag('Conflict', 'bad')}`
    : `<span${f.display && f.display !== f.value ? ` title="As written: ${esc(f.value)}"` : ''}>${esc(shown(f))}</span> ${reg.refs(f.values.flatMap(v => v.sources).slice(0, 2))}`}</td></tr>`;
  // The table lists what the highlights do not (the field asked about always stays in it).
  const inHighlights = new Set(highlights.flatMap(h => h.keys));
  const documented = s.keyFields.filter(f => !f.missing && (!inHighlights.has(f.key) || f.key === field));
  const ordered = field ? [...documented.filter(f => f.key === field), ...documented.filter(f => f.key !== field)] : documented;
  const missing = s.keyFields.filter(f => f.missing);
  const noSheet = !s.fromDocuments.length ? `<p class="tw-rnote is-warn">The linked ACC documents do not include a readable technical datasheet or asset sheet for ${esc(a.asset.id)}.</p>` : '';
  return `${noSheet}
    ${highlights.length ? `<div class="tw-rspec-hl">${highlights.map(h => `<div><small>${esc(h.label)}</small><b>${esc(h.value)}</b>${reg.refs(h.sources)}</div>`).join('')}</div>` : ''}
    ${ordered.length ? `<table class="tw-rtable is-spec"><tbody>${ordered.map(row).join('')}</tbody></table>` : ''}
    ${s.otherFields.length ? `<details class="tw-rsub"><summary>Show all specifications (${s.otherFields.length} more)</summary><table class="tw-rtable is-spec"><tbody>${s.otherFields.map(row).join('')}</tbody></table></details>` : ''}
    ${missingSpecificationsHtml(a, { open: openMissing || (field && missing.some(f => f.key === field)) })}
    ${s.conflicts.length ? `<p class="tw-rnote is-warn">${esc(plural(s.conflicts.length, 'specification differs', 'specifications differ'))} between documents; both values are kept with their sources.</p>` : ''}
    <p class="tw-rmuted">Values shown in engineering units; hover a value for the text as written. Apparent power (VA) and real power (W) are kept apart.</p>`;
}
function missingSpecificationsHtml(a, { open = false } = {}) {
  const missing = a.specifications.keyFields.filter(f => f.missing);
  if (!missing.length) return '';
  return `<details class="tw-rmiss" id="tw-miss-${esc(a.asset.id)}"${open ? ' open' : ''}><summary>${dot('warn')}<span>${esc(plural(missing.length, 'key specification'))} missing</span></summary>
    <ul>${missing.map(f => `<li>${esc(f.label)}</li>`).join('')}</ul><p class="tw-rmuted">No linked document states these. Take them from the nameplate or the manufacturer.</p></details>`;
}

/** What the reports raised and whether it was closed: separate counts, and every action with its closure. */
function findingsAndActionsHtml(a, reg, { openActions = false } = {}) {
  const c = a.review.counts;
  if (!a.inspections.count) return '';
  const tiles = [[c.latestDefects, 'Latest defects'], [c.latestAttention, 'Latest attention items'], [c.uniqueFindings, 'Unique historical findings'],
    [c.actions, 'Corrective actions'], [c.actionsClosedVerified, 'Verified closed'], [c.actionsWithoutVerifiedClosure, 'Without verified closure']];
  const actions = a.inspections.comparison.actions;
  const act = x => `<li>${dot(CLOSURE[x.closure.status][1])}<span>${esc(x.action)} <small>raised ${esc(x.raisedOn)}${x.priority ? ` · ${esc(x.priority)}` : ''}${x.due ? ` · due ${esc(x.due)}` : ''} · ${esc(CLOSURE[x.closure.status][0])}</small> ${reg.refs([x.citation, ...(x.closure.citation && x.closure.citation !== x.citation ? [x.closure.citation] : [])])}</span></li>`;
  return `<h5 class="tw-rh">Findings and corrective actions</h5>
    <div class="tw-rcounts">${tiles.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
    <details class="tw-rsub"><summary>How these are counted</summary><p class="tw-rmuted">Latest defects and attention items come from the latest inspection report only. A unique historical finding is one component with a non-OK result in any report, however often it was recorded (${esc(c.recurringFindings)} recur in the latest report). Corrective actions are every action any report raised; one is verified closed only when a later document records it done.</p></details>
    ${actions.length ? `<details class="tw-rsub tw-racts"${openActions ? ' open' : ''}><summary>Corrective actions (${actions.length}) · ${c.actionsWithoutVerifiedClosure} without verified closure</summary><ul class="tw-rlist">${[...actions].reverse().map(act).join('')}</ul></details>` : ''}`;
}

/**
 * The electrical model's view of taking the asset out of service: consumers that lose supply, normally-open
 * devices that could pick them up (candidates, not a restoration plan) and the protective devices around it.
 */
export function operationalImpactHtml(impact) {
  if (!impact) return '';
  const asset = x => `<button type="button" class="tw-rasset" data-asset="${esc(x)}">${esc(x)}</button>`;
  const cap = o => (o.capacity === 'OVERLOAD' ? tag(`Modeled overload: ${o.overloads.join(', ')}`, 'bad') : o.capacity === 'UNKNOWN' ? tag('Capacity not modeled', 'neutral') : tag('Within modeled capacity', 'ok'));
  return `<div class="tw-rimpact">
    <div class="tw-rcounts is-two"><div><b>${impact.lost.length}</b><span>Consumers affected</span></div><div><b>${impact.candidates.length}</b><span>Candidate transfer option${impact.candidates.length === 1 ? '' : 's'}</span></div></div>
    ${impact.lost.length ? `<details class="tw-rsub"><summary>Affected consumers (${impact.lost.length})</summary><p>${impact.lost.map(asset).join('')}</p></details>` : `<p class="tw-rmuted">Every consumer keeps a supply route in the model${impact.rerouted ? ` (${impact.rerouted} over another route)` : ''}.</p>`}
    ${impact.candidates.length ? `<h6>Candidate transfer options</h6><ul class="tw-rlist">${impact.candidates.map(o => `<li>${dot(o.capacity === 'OVERLOAD' ? 'bad' : 'info')}<span>${asset(o.switchId)} normally open · reaches ${o.restored} of ${impact.lost.length} affected consumers in the model ${cap(o)}</span></li>`).join('')}</ul>
      <p class="tw-rmuted">Topological reachability and modeled capacity only. Operational availability is not verified: it depends on the device's condition, protection settings and switching approvals.</p>` : impact.lost.length ? '<p class="tw-rmuted">The model has no normally-open device that reaches the affected consumers.</p>' : ''}
    ${impact.upstream || impact.downstream.length ? `<h6>Protective devices for engineering review</h6><p>${impact.upstream ? `Upstream ${asset(impact.upstream)} ` : ''}${impact.downstream.length ? `Downstream ${impact.downstream.map(asset).join('')}` : ''}</p>` : ''}
    <p class="tw-rnote">Identified from the model for review only. Isolation and switching need an approved procedure, equipment verification on site and authorized personnel.${impact.pathVerified ? '' : ' Some connections on the supply path have no stated direction in the IFC.'}</p></div>`;
}

// ---- the workspace ----

/** What the question is about: it decides the Overview's summary, metrics and next steps. */
export function reviewMode({ intent, focus = null }) {
  if (intent === 'ASSET_REPLACEMENT_READINESS') return 'replacement';
  if (intent === 'ASSET_MAINTENANCE_HISTORY' || (intent === 'ASSET_CONDITION_TREND' && focus === 'CLOSURE')) return 'maintenance';
  if (intent === 'ASSET_CONDITION_TREND' || intent === 'ASSET_INSPECTION_HISTORY') return 'condition';
  if (intent === 'ASSET_TECHNICAL_SPECIFICATIONS') return 'specifications';
  return 'general';
}

/** Which tab a question opens, and what in it is opened for the question. */
export function reviewFocus({ intent, focus = null, field = null }) {
  const mode = reviewMode({ intent, focus });
  if (intent === 'ASSET_TECHNICAL_SPECIFICATIONS') return { mode, tab: 'specifications', field, openMissing: focus === 'MISSING' };
  if (intent === 'ASSET_INSPECTION_HISTORY') return { mode, tab: 'inspections', openLatest: focus === 'DEFECTS' || focus === 'LATEST' };
  if (intent === 'EVIDENCE') return { mode, tab: 'inspections' };
  return { mode, tab: 'overview', openActions: mode === 'maintenance' };
}

/**
 * @param {object} a the analysis (with `review`)
 * @param {{intent: string, focus?: string, field?: string, openItem?: string, impact?: object, status?: {label, tone}}} o
 */
export function docReviewHtml(a, { intent, focus = null, field = null, openItem = null, impact = null, status = null } = {}) {
  const reg = sourceRegistry(a);
  const f = { ...reviewFocus({ intent, focus, field }), field, openItem, impact };
  const tabs = REVIEW_TABS.filter(([k]) => k !== 'inspections' || a.inspections.count || a.documents.analysed);
  // Panels first (they number the citations), then the sources list that shows which pages were cited.
  const panels = { overview: overviewHtml(a, reg, f), inspections: inspectionsHtml(a, reg, f), specifications: specificationsHtml(a, reg, f) };
  const uid = `${a.asset.id}-${Math.random().toString(36).slice(2, 7)}`.replace(/[^\w-]/g, '');
  return `<div class="tw-rev" data-doc-review="${esc(a.asset.id)}">${sourcesHtml(a, reg)}
    <div class="tw-rev-card">${headerHtml(a, { intent, status })}${provenanceHtml(a, reg)}
      <div class="tw-rev-tabs" role="tablist" aria-label="${esc(a.asset.id)} document review">${tabs.map(([k, l]) => `<button type="button" role="tab" id="tw-tab-${uid}-${k}" aria-controls="tw-pan-${uid}-${k}" class="tw-rev-tab" data-doc-tab="${k}" aria-selected="${k === f.tab}">${esc(l)}</button>`).join('')}</div>
      ${tabs.map(([k]) => `<div class="tw-rev-panel" role="tabpanel" id="tw-pan-${uid}-${k}" aria-labelledby="tw-tab-${uid}-${k}" data-doc-panel="${k}"${k === f.tab ? '' : ' hidden'}>${panels[k]}</div>`).join('')}
    </div></div>`;
}

/** Tab switching inside one workspace: a different panel shown, nothing re-rendered or re-requested. */
export function switchReviewTab(root, tab, { open = null, item = null } = {}) {
  if (!root) return false;
  const panel = root.querySelector(`[data-doc-panel="${tab}"]`);
  if (!panel) return false;
  for (const b of root.querySelectorAll('.tw-rev-tab')) { const on = b.dataset.docTab === tab; b.setAttribute("aria-selected", String(on)); }
  for (const p of root.querySelectorAll('[data-doc-panel]')) p.hidden = p !== panel;
  root.querySelector('.tw-cpop')?.remove();
  // The part of the tab a link points to, opened and brought into view.
  const target = open === 'missing' ? panel.querySelector('.tw-rmiss') : open === 'actions' ? panel.querySelector('.tw-racts')
    : open === 'measurements' ? panel.querySelector('.tw-rsec') : open === 'components' ? panel.querySelector('.tw-comps')
      : open === 'component' && item ? [...panel.querySelectorAll('.tw-comp')].find(d => d.querySelector('summary span')?.textContent === item) : null;
  if (target) { if (target.tagName === 'DETAILS') target.open = true; target.scrollIntoView({ block: 'nearest' }); }
  else root.querySelector('.tw-rev-tabs')?.scrollIntoView({ block: 'nearest' });
  return true;
}
