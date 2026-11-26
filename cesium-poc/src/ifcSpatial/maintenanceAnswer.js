/**
 * The maintenance assessment in Ask the Twin (seagirt_implementation.md §11–§13): one asset in detail (identity,
 * status, the documented condition trend, "What needs to be fixed or investigated", engineering review, sources,
 * actions) or a compact collection (counts that do not overlap, one row per asset, drill-down and Back to results).
 * Built from the contract in maintenance.js; every finding shows the source it came from. Text is escaped.
 */
import { ASK_ICONS } from './askPanel.js';
import { EVIDENCE, maintenanceSay, rowSummary } from './maintenance.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso ?? ''; };
const month = iso => { const m = /^(\d{4})-(\d{2})/.exec(iso ?? ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso ?? ''; };
const STATUS_TEXT = { DEGRADED: 'Degraded', NO_POWER: 'No power', OFFLINE: 'Offline', POWERED: 'Powered', UNKNOWN: 'Status unknown' };
const STATUS_TONE = { DEGRADED: 'warn', NO_POWER: 'bad', OFFLINE: 'neutral', POWERED: 'ok', UNKNOWN: 'neutral' };
const two = n => String(n).padStart(2, '0');

/** A citation chip: opens the existing document preview at the page (and the ACC link where there is one). */
export function citeChip(ref, label = null) {
  if (!ref?.documentId) return '';
  return `<button type="button" class="tw-mcite" data-doc-cite="${esc(ref.documentId)}"${ref.page ? ` data-doc-page="${esc(ref.page)}"` : ''} title="${esc(`${ref.fileName ?? ''}${ref.version ? ` · V${ref.version}` : ''}${ref.page ? ` · page ${ref.page}` : ''}`)}">${esc(label ?? `${ref.inspectionDate ? `${day(ref.inspectionDate)} · ` : ''}p.${ref.page ?? '–'}`)}</button>`;
}

/** The documented condition ratings over time: actual dated points only; hidden with fewer than two. */
export function trendSvg(points) {
  if (!points || points.length < 2) return '';
  const W = 320, H = 92, pad = 26;
  const t = points.map(p => Date.parse(p.date));
  const [t0, t1] = [Math.min(...t), Math.max(...t)];
  const scale = Math.max(...points.map(p => p.scale ?? 5));
  const x = v => pad + (t1 === t0 ? 0.5 : (v - t0) / (t1 - t0)) * (W - 2 * pad);
  const y = s => 16 + (1 - (s - 1) / Math.max(scale - 1, 1)) * (H - 40);
  const tone = p => (p.score / (p.scale ?? 5) >= 0.8 ? 'ok' : p.score / (p.scale ?? 5) >= 0.6 ? 'warn' : 'bad');
  const pts = points.map((p, i) => [x(t[i]), y(p.score)]);
  return `<figure class="tw-mtrend" aria-label="Inspection condition trend"><figcaption>Inspection condition trend</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(points.map(p => `${month(p.date)}: ${p.label ?? ''} ${p.score}/${p.scale}`).join('; '))}">
      ${[1, Math.ceil(scale / 2), scale].map(s => `<line x1="${pad}" x2="${W - pad}" y1="${y(s)}" y2="${y(s)}" class="tw-mtrend-grid"/>`).join('')}
      <polyline points="${pts.map(p => p.join(',')).join(' ')}" class="tw-mtrend-line"/>
      ${points.map((p, i) => `<circle cx="${pts[i][0]}" cy="${pts[i][1]}" r="4.5" class="is-${tone(p)}"/><text x="${pts[i][0]}" y="${pts[i][1] - 8}" class="tw-mtrend-v is-${tone(p)}" text-anchor="middle">${p.score}/${p.scale}</text>
        <text x="${pts[i][0]}" y="${H - 4}" class="tw-mtrend-d" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${esc(month(p.date))}</text>`).join('')}
    </svg><small>Documented inspection ratings, not live operational status.</small></figure>`;
}

/** The single-asset assessment card. */
/** The section for what was asked (§15–§16), above the findings. */
function focusHtml(a, intent) {
  const CLOSURE = { NOT_VERIFIED: 'Closure not verified', NOT_COMPLETED_WITH_EVIDENCE: 'Documented as not completed', COMPLETED_WITH_EVIDENCE: 'Documented as completed' };
  if (intent === 'RECURRING_DEFECTS' && (a.recurring.length || a.newFindings.length)) {
    return `<h5 class="tw-mh">Recurrence across inspections</h5><ul class="tw-mplain is-rich">
      ${a.recurring.map(f => `<li><b>${esc(f.title)}</b> <span class="tw-mtag is-warn">Recurring</span><small>First reported ${esc(day(f.firstReported))} · latest ${esc(day(f.latestReported))}</small>${citeChip(f.ref)}</li>`).join('')}
      ${a.newFindings.map(f => `<li><b>${esc(f.title)}</b> <span class="tw-mtag">New in the latest report</span>${citeChip(f.ref)}</li>`).join('')}</ul>`;
  }
  if (intent === 'OUTSTANDING_ACTIONS') {
    const rows = [...a.documentedCorrectiveActions, ...a.completedActions];
    if (!rows.length) return '';
    return `<h5 class="tw-mh">Documented actions</h5><ul class="tw-mplain is-rich">${rows.map(x => `<li><b>${esc(x.text)}</b> <span class="tw-mtag${x.closure === 'COMPLETED_WITH_EVIDENCE' ? ' is-ok' : x.closure === 'NOT_COMPLETED_WITH_EVIDENCE' ? ' is-bad' : ' is-warn'}">${esc(CLOSURE[x.closure] ?? x.closure)}</span>
      <small>${esc([x.raisedOn ? `Raised ${day(x.raisedOn)}` : null, x.priority ? `${x.priority} priority` : null, x.due ? `due ${day(x.due)}` : null].filter(Boolean).join(' · '))}${x.closureBasis ? ` — ${esc(x.closureBasis)}` : ''}</small>${citeChip(x.ref)}</li>`).join('')}</ul>`;
  }
  if (intent === 'HISTORICAL_STATUS') {
    return `<dl class="tw-mkv"><div><dt>Operational status</dt><dd>${esc(STATUS_TEXT[a.operationalStatus] ?? a.operationalStatus)}${a.statusDate ? ` · record dated ${esc(day(a.statusDate))}` : ''}${a.statusFlag ? ` · flag “${esc(a.statusFlag)}”` : ''}</dd></div>
      <div><dt>Start of this status</dt><dd>Not established by the available records</dd></div>
      ${a.latestInspection ? `<div><dt>Latest inspection</dt><dd>${esc(day(a.latestInspection.date))}${a.latestInspection.condition?.label ? ` · ${esc(a.latestInspection.condition.label)}` : ''} ${citeChip(a.latestInspection.ref, `p.${a.latestInspection.ref?.page ?? 1}`)}</dd></div>` : ''}</dl>`;
  }
  if (intent === 'CONDITION_TREND' && a.worsening.length) {
    return `<h5 class="tw-mh is-sm">Measurements documented as worsening</h5><ul class="tw-mplain">${a.worsening.map(w => `<li>${esc(w.name)}${w.basis ? ` <small>${esc(w.basis)}</small>` : ''}${citeChip(w.ref)}</li>`).join('')}</ul>`;
  }
  return '';
}

export function assetAssessmentHtml(a, { statusPill = () => null, intent = null } = {}) {
  const pill = statusPill(a.assetId);
  const statusText = `${STATUS_TEXT[a.operationalStatus] ?? a.operationalStatus}${a.operationalStatus === 'DEGRADED' && a.powerState === 'POWERED' ? ' · still powered' : ''}`;
  const head = `<header class="tw-mhead"><div><b class="tw-mid">${esc(a.assetId)}</b>
      <span class="tw-msub">${esc([a.assetType, a.name && a.name !== a.assetId ? a.name : null].filter(Boolean).join(' · '))}<span class="tw-mst is-${STATUS_TONE[a.operationalStatus] ?? pill?.tone ?? 'neutral'}">${esc(statusText)}</span></span></div></header>`;
  if (a.evidenceAvailability !== EVIDENCE.AVAILABLE) {
    const msg = {
      NO_DOCUMENTS: 'No inspection or maintenance documents are linked to this asset in ACC. The available records do not establish what needs to be fixed.',
      NO_INSPECTION_RECORDS: 'The linked documents include no inspection report, so no defects or corrective actions are documented.',
      NO_RELEVANT_FINDINGS: 'The inspection records contain no findings or actions requiring attention.',
      RETRIEVAL_FAILED: 'The linked documents could not be retrieved from ACC. The assessment is incomplete.',
      UNREADABLE: 'The linked documents could not be read. The assessment is incomplete.',
      NOT_CHECKED: 'The documents were not checked.',
    }[a.evidenceAvailability];
    return `<section class="tw-card tw-maint is-empty">${head}<p class="tw-mnote">${esc(msg)}</p>
      ${a.operationalStatus !== 'POWERED' ? '<p class="tw-mnote is-muted">A site inspection is needed to establish the cause of the reported status.</p>' : ''}
      ${a.sourceRefs.length ? `<p class="tw-msrc">${a.sourceRefs.map(r => citeChip(r, r.fileName ?? 'Document')).join('')}</p>` : ''}
      <div class="tw-macts"><button type="button" class="tw-btn is-primary" data-maint-focus="${esc(a.assetId)}">Show on map</button></div></section>`;
  }
  const actionFor = f => a.documentedCorrectiveActions.find(x => shares(x.text, `${f.title} ${f.text ?? ''}`));
  const items = [
    ...a.findings.map(f => ({ title: f.title, text: f.text, sev: f.severity, extra: [f.recurring ? `Recurring${f.firstReported ? ` since ${day(f.firstReported)}` : ''}` : null, actionFor(f) ? `Documented action: ${actionFor(f).text}${actionFor(f).due ? ` (due ${day(actionFor(f).due)})` : ''}` : null].filter(Boolean), ref: f.ref })),
    ...a.documentedCorrectiveActions.filter(x => !a.findings.some(f => actionFor(f) === x)).map(x => ({ title: x.text, text: `Documented action${x.raisedOn ? ` from ${day(x.raisedOn)}` : ''}${x.priority ? ` · ${x.priority} priority` : ''}; completion not verified in later records.`, sev: null, extra: [], ref: x.ref })),
  ];
  // Each finding: its source, and the extracted text it rests on (opened on request).
  const evidence = r => (r?.evidenceText ? `<details class="tw-mev"><summary>Evidence</summary><blockquote>${esc(r.evidenceText)}</blockquote><small>${esc([r.fileName, r.version ? `V${r.version}` : null, r.page ? `page ${r.page}` : null, r.section].filter(Boolean).join(' · '))}</small></details>` : '');
  const row = (it, i) => `<li class="tw-mfind${it.sev === 'DEFECT' ? ' is-bad' : it.sev === 'ATTENTION' ? ' is-warn' : ''}"><span class="tw-mn">${two(i + 1)}</span>
      <div><b>${esc(it.title)}</b>${it.text ? `<p>${esc(it.text)}</p>` : ''}${it.extra.map(x => `<p class="tw-mx">${esc(x)}</p>`).join('')}<span class="tw-mrefs">${citeChip(it.ref)}${evidence(it.ref)}</span></div></li>`;
  const shown = items.slice(0, 5), rest = items.slice(5);
  const latest = a.latestInspection;
  // Asked about something else (history, recurrence, actions, restrictions): that first, the findings on request.
  const focus = focusHtml(a, intent);
  const secondary = Boolean(focus) || ['OPERATING_RESTRICTIONS', 'HISTORICAL_STATUS'].includes(intent);
  const findings = `<ol class="tw-mlist">${shown.map(row).join('')}</ol>
    ${rest.length ? `<details class="tw-mmore"><summary>View all findings (${items.length})</summary><ol class="tw-mlist" start="6">${rest.map((it, i) => row(it, i + 5)).join('')}</ol></details>` : ''}`;
  const restrictionsFirst = intent === 'OPERATING_RESTRICTIONS';
  const restrictions = a.operatingRestrictions.length ? `<h5 class="tw-mh${restrictionsFirst ? '' : ' is-sm'}">Documented operating restrictions</h5><ul class="tw-mplain">${a.operatingRestrictions.map(r => `<li>${esc(r.text)} <small>${esc(r.applicability)}</small>${citeChip(r.ref)}</li>`).join('')}</ul>` : '';
  return `<section class="tw-card tw-maint">${head}
    ${trendSvg(a.conditionTrend)}
    ${restrictionsFirst ? restrictions : ''}${focus}
    ${items.length ? (secondary ? `<details class="tw-mmore tw-mfold"><summary>What needs to be fixed or investigated (${items.length})</summary>${findings}</details>` : `<h5 class="tw-mh">What needs to be fixed or investigated</h5>${findings}`) : ''}
    ${restrictionsFirst ? '' : restrictions}
    ${a.maintenanceRecords.length ? `<p class="tw-msrc">Maintenance records: ${a.maintenanceRecords.map(r => citeChip({ ...r, page: null }, r.title ?? r.fileName)).join('')}</p>` : ''}
    ${a.additionalInvestigations.length ? `<details class="tw-mmore"><summary>Further checks suggested by the findings (${a.additionalInvestigations.length})</summary><ul class="tw-mplain">${a.additionalInvestigations.map(x => `<li>${esc(x.text)} <small>Derived from the findings, not a documented instruction.</small></li>`).join('')}</ul></details>` : ''}
    ${a.completedActions.length ? `<details class="tw-mmore"><summary>Actions with documented completion (${a.completedActions.length})</summary><ul class="tw-mplain">${a.completedActions.map(x => `<li>${esc(x.text)} <small>${esc(x.closureBasis ?? '')}</small>${citeChip(x.closureRef ?? x.ref)}</li>`).join('')}</ul></details>` : ''}
    <p class="tw-mreview"><b>Engineering review required</b>${a.conditionTrend.length >= 2 && a.conditionTrend.at(-1).score < a.conditionTrend[0].score ? ' — the documented condition has deteriorated' : ''}. Confirm the corrective actions before any work; this is not a repair, isolation or operating instruction.</p>
    ${latest ? `<p class="tw-msrc">Latest inspection · ${esc(day(latest.date))}${latest.condition?.label ? ` · ${esc(latest.condition.label)}${Number.isFinite(latest.condition.score) ? ` ${latest.condition.score}/${latest.condition.scale ?? 5}` : ''}` : ''} ${citeChip(latest.ref, `ACC p.${latest.ref?.page ?? 1}`)}</p>` : ''}
    ${a.limitations.length ? `<p class="tw-mnote is-muted">${esc(a.limitations.join(' '))}</p>` : ''}
    <div class="tw-macts"><button type="button" class="tw-btn is-primary" data-maint-focus="${esc(a.assetId)}">Show on map</button>${latest?.ref ? `<button type="button" class="tw-btn" data-doc-cite="${esc(latest.ref.documentId)}"${latest.ref.page ? ` data-doc-page="${esc(latest.ref.page)}"` : ''}>View inspection</button>` : ''}</div></section>`;
}
const REPORT_BTN = '<button type="button" class="tw-btn tw-mreport" data-maint-report="1">Generate maintenance report</button>';
const reportButton = (enabled, { inRow = false } = {}) => (!enabled ? '' : inRow ? REPORT_BTN : `<div class="tw-macts">${REPORT_BTN}</div>`);
const shares = (a, b) => { const t = s => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !['inspection', 'transformer'].includes(w))); const A = t(a), B = t(b); return [...A].some(w => B.has(w)); };

/** The whole answer: one asset, or the collection (with one opened from it). */
export function maintenanceHtml(m, { open = null, statusPill = () => null, illustrative = false, reports = false } = {}) {
  const intent = m.primaryIntent;
  // A report only when there is something to report: documented findings, or a reported problem to investigate.
  reports = reports && m.assets.some(a => a.evidenceAvailability === EVIDENCE.AVAILABLE || ['DEGRADED', 'NO_POWER', 'OFFLINE'].includes(a.operationalStatus));
  const foot = illustrative ? '<p class="tw-mfoot">Illustrative records · findings require engineering verification</p>' : '<p class="tw-mfoot">Findings require engineering verification</p>';
  if (!m.assets.length) return '';
  if (m.assets.length === 1) return assetAssessmentHtml(m.assets[0], { statusPill, intent }) + reportButton(reports) + foot;
  const opened = open ? m.assets.find(a => a.assetId === open) : null;
  if (opened) return `<button type="button" class="tw-mback" data-maint-back="1">${ASK_ICONS.chevron}<span>Back to results (${m.assets.length})</span></button>${assetAssessmentHtml(opened, { statusPill, intent })}${foot}`;
  const s = m.summary;
  const filt = (m.filters?.operationalStatus ?? []).map(x => STATUS_TEXT[x]).join(' / ');
  const metrics = `<div class="tw-mmetrics"><div><span>${esc(filt ? `${filt} assets` : 'Assets')}</span><b class="is-${STATUS_TONE[m.filters?.operationalStatus?.[0]] ?? 'neutral'}">${s.matchingAssets}</b></div>
      <div><span>With documented findings</span><b>${s.assetsWithDocumentedFindings}</b></div><div><span>Without documented findings</span><b class="is-muted">${s.assetsWithoutDocumentedFindings}</b></div></div>`;
  const rowHtml = a => { const r = rowSummary(a); return `<button type="button" class="tw-mrow" data-maint-open="${esc(a.assetId)}"><span class="tw-mrow-id"><b>${esc(a.assetId)}</b><small>${esc(a.assetType ?? '')}</small></span>
      <span class="tw-mrow-t is-${r.tone}">${esc(r.text)}</span><span class="tw-chev" aria-hidden="true">${ASK_ICONS.chevron}</span></button>`; };
  const first = m.assets.slice(0, 8), rest = m.assets.slice(8);
  return `<section class="tw-maint-list"><h5 class="tw-mh">Maintenance assessment</h5>${metrics}
    ${s.assetsWithUnknownDegradationCause ? `<p class="tw-mnote is-muted">The current cause of the reported status is not established by the records for ${s.assetsWithUnknownDegradationCause === s.matchingAssets ? 'any of them' : `${s.assetsWithUnknownDegradationCause} of them`}.</p>` : ''}
    <div class="tw-mrows">${first.map(rowHtml).join('')}</div>
    ${rest.length ? `<details class="tw-mmore"><summary>${rest.length} more</summary><div class="tw-mrows">${rest.map(rowHtml).join('')}</div></details>` : ''}
    ${m.limitations.length ? `<p class="tw-mnote is-muted">${esc(m.limitations.join(' '))}</p>` : ''}
    <div class="tw-macts"><button type="button" class="tw-btn is-primary" data-maint-all="1">Show all on map</button>${reportButton(reports, { inRow: true })}</div></section>${foot}`;
}

/** The direct answer for the view: the collection, or the opened asset. */
export function maintenanceSayFor(m, open = null) {
  if (open && m.assets.length > 1) {
    const a = m.assets.find(x => x.assetId === open);
    if (a) return maintenanceSay({ ...m, assets: [a], summary: { ...m.summary, matchingAssets: 1 }, targetKind: 'NAMED' });
  }
  return maintenanceSay(m);
}

/** At most three follow-ups, from the investigation (§11). */
export function maintenanceSuggestions(m, { open = null, reports = false } = {}) {
  const a = open ? m.assets.find(x => x.assetId === open) : m.assets.length === 1 ? m.assets[0] : null;
  const out = [];
  if (a) {
    out.push({ label: `If ${a.assetId} is taken out of service`, question: `What happens if ${a.assetId} goes offline?`, icon: 'bolt' });
    if (a.evidenceAvailability === EVIDENCE.AVAILABLE) out.push(a.recurring.length || a.conditionTrend.length >= 2 ? { label: 'Has this occurred before?', question: `Has this issue occurred before on ${a.assetId}?`, icon: 'doc' } : { label: 'Outstanding actions', question: `Which repairs are still outstanding on ${a.assetId}?`, icon: 'doc' });
    out.push({ label: 'Can it remain in service?', question: `Can we continue operating ${a.assetId}?`, icon: 'info' });
    if (reports && a.evidenceAvailability === EVIDENCE.AVAILABLE) out.splice(2, 1, { label: 'Draft an email to the maintenance team', question: 'Draft an email to the maintenance team', icon: 'doc' });
  } else {
    out.push({ label: 'Which repairs are outstanding?', question: 'Which repairs are still outstanding for these assets?', icon: 'doc' });
  }
  return out.slice(0, 3);
}
