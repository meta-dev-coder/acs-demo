/**
 * The maintenance assessment (seagirt_implementation.md §10, §13–§15, §22): one contract for one asset or many,
 * built from the investigation's evidence (askOrchestrator.js) — the operational status engine's record and the
 * existing document intelligence for each asset (server/ifcSpatial/docIntel.mjs). Nothing here reads a PDF or
 * invents a finding: every finding, action and restriction is one the analysis extracted, with its citation.
 *
 * Kept apart (§14): no linked documents · documents that could not be retrieved · documents that could not be
 * read · documents without inspection reports · inspections without findings · findings · actions with
 * verified completion · actions without verified closure. The cause of the current operational status is
 * NOT_ESTABLISHED unless a document states it: historical findings are not presented as the cause (§10 step 6).
 */

export const EVIDENCE = Object.freeze({
  AVAILABLE: 'AVAILABLE', NO_RELEVANT_FINDINGS: 'NO_RELEVANT_FINDINGS', NO_INSPECTION_RECORDS: 'NO_INSPECTION_RECORDS',
  NO_DOCUMENTS: 'NO_DOCUMENTS', RETRIEVAL_FAILED: 'RETRIEVAL_FAILED', UNREADABLE: 'UNREADABLE', NOT_CHECKED: 'NOT_CHECKED',
});
export const CAUSE = Object.freeze({ VERIFIED: 'VERIFIED', NOT_ESTABLISHED: 'NOT_ESTABLISHED', NOT_APPLICABLE: 'NOT_APPLICABLE' });
const SEVERITY_RANK = { DEFECT: 0, ATTENTION: 1 };
const PROBLEM_STATUS = new Set(['DEGRADED', 'NO_POWER', 'OFFLINE']);

/** A source reference: document, version, page, the inspection date, the asset (never guessed). */
function refOf(citation, { assetId, inspectionDate = null, sources = [] } = {}) {
  if (!citation?.documentId) return null;
  const src = sources.find(s => s.documentId === citation.documentId);
  return { documentId: citation.documentId, fileName: citation.fileName ?? src?.fileName ?? null, version: citation.version ?? src?.version ?? null,
    page: Number.isFinite(citation.page) ? citation.page : null, section: citation.section ?? null, evidenceText: citation.evidenceText ?? null,
    assetId, inspectionDate, webViewUrl: src?.webViewUrl ?? null, title: src?.title ?? null };
}
const refKey = r => `${r.documentId}|${r.page ?? ''}`;
/** Source references grouped by document and page (several findings on one page share one reference). */
export function groupRefs(refs) {
  const m = new Map();
  for (const r of refs.filter(Boolean)) if (!m.has(refKey(r))) m.set(refKey(r), r);
  return [...m.values()].sort((a, b) => (b.inspectionDate ?? '').localeCompare(a.inspectionDate ?? '') || (a.page ?? 0) - (b.page ?? 0));
}

/** One asset's assessment (§22 "assets[]"). */
export function assessAsset(e, { describe = () => ({}) } = {}) {
  const d = describe(e.id) ?? {};
  const a = e.analysis;
  const status = e.status?.status ?? 'UNKNOWN';
  const base = {
    assetId: e.id, assetType: d.type ?? e.category ?? null, name: d.name ?? null, category: e.category ?? null,
    operationalStatus: status, statusFlag: e.status?.flag ?? null, statusDate: e.status?.date ?? null, statusSource: e.status?.source ?? null,
    // "Still powered" only when the status engine says so: degraded equipment that has supply.
    powerState: status === 'DEGRADED' || status === 'POWERED' ? 'POWERED' : status === 'NO_POWER' ? 'NO_POWER' : status === 'OFFLINE' ? 'OFFLINE' : 'UNKNOWN',
    latestInspection: null, conditionTrend: [], findings: [], documentedCorrectiveActions: [], completedActions: [], additionalInvestigations: [],
    operatingRestrictions: [], closureEvidence: [], recurring: [], newFindings: [], worsening: [], maintenanceRecords: [], inspectionCount: 0,
    degradationCause: { status: PROBLEM_STATUS.has(status) ? CAUSE.NOT_ESTABLISHED : CAUSE.NOT_APPLICABLE, sourceRefs: [] },
    evidenceAvailability: EVIDENCE.NOT_CHECKED, documents: { linked: e.documents?.linked ?? null, analysed: 0, unreadable: 0 }, sourceRefs: [], limitations: [],
  };
  if (e.error) {
    base.evidenceAvailability = EVIDENCE.RETRIEVAL_FAILED;
    base.limitations.push(`The linked documents could not be retrieved from ACC (${e.error}).`);
    return base;
  }
  if (e.documents?.linked === 0 || (a && a.documents.linked === 0)) {
    base.evidenceAvailability = EVIDENCE.NO_DOCUMENTS;
    base.limitations.push('No ACC documents are linked to this asset.');
    return base;
  }
  if (!a) { base.limitations.push('The linked documents were not read.'); return base; }
  const sources = a.sources ?? [];
  base.documents = { linked: a.documents.linked, analysed: a.documents.analysed, unreadable: a.documents.unreadable };
  if (!a.documents.analysed) {
    base.evidenceAvailability = EVIDENCE.UNREADABLE;
    base.limitations.push(`${a.documents.unreadable || a.documents.linked} linked document${(a.documents.unreadable || a.documents.linked) === 1 ? '' : 's'} could not be read.`);
    return base;
  }
  if (a.documents.unreadable) base.limitations.push(`${a.documents.unreadable} linked document${a.documents.unreadable === 1 ? '' : 's'} could not be read; the assessment uses the rest.`);
  const timeline = a.inspections?.timeline ?? [];
  const latest = timeline.find(t => t.inspectionDate) ?? null;
  base.inspectionCount = timeline.length;
  // Maintenance, repair and work-order records: listed as evidence; their contents are not read for completed work.
  base.maintenanceRecords = sources.filter(x => x.documentType === 'MAINTENANCE').map(x => ({ documentId: x.documentId, fileName: x.fileName, title: x.title, version: x.version, webViewUrl: x.webViewUrl }));
  if (base.maintenanceRecords.length) base.limitations.push(`${base.maintenanceRecords.length} maintenance record${base.maintenanceRecords.length === 1 ? ' is' : 's are'} linked; ${base.maintenanceRecords.length === 1 ? 'its' : 'their'} contents are not analysed, so completed work is not verified from ${base.maintenanceRecords.length === 1 ? 'it' : 'them'}.`);
  if (!timeline.length) {
    base.evidenceAvailability = EVIDENCE.NO_INSPECTION_RECORDS;
    base.limitations.push('The linked documents include no inspection report.');
    base.sourceRefs = groupRefs(sources.filter(s => s.status === 'SUCCESS' || s.status === 'PARTIAL').map(s => ({ documentId: s.documentId, fileName: s.fileName, version: s.version, page: null, assetId: e.id, inspectionDate: null, webViewUrl: s.webViewUrl, title: s.title })));
    return base;
  }
  const at = latest?.inspectionDate ?? null;
  if (latest) {
    base.latestInspection = { date: at, type: latest.type ?? null, reportNumber: latest.reportNumber ?? null,
      condition: latest.condition ? { label: latest.condition.label ?? null, score: latest.condition.score ?? null, scale: latest.condition.scale ?? null, text: latest.condition.text ?? null } : null,
      ref: refOf(latest.dateCitation ?? latest.condition?.citation ?? { documentId: latest.documentId, fileName: latest.fileName, version: latest.version, page: 1 }, { assetId: e.id, inspectionDate: at, sources }) };
  }
  // Condition trend: actual dated ratings only (no interpolation, no invented points).
  base.conditionTrend = [...timeline].filter(t => t.inspectionDate && Number.isFinite(t.condition?.score)).reverse()
    .map(t => ({ date: t.inspectionDate, label: t.condition.label ?? null, score: t.condition.score, scale: t.condition.scale ?? 5, ref: refOf(t.condition.citation, { assetId: e.id, inspectionDate: t.inspectionDate, sources }) }));
  const cmp = a.inspections.comparison ?? {};
  const trendOf = item => (cmp.findings ?? []).find(c => String(c.item).toLowerCase() === String(item).toLowerCase()) ?? null;
  // Findings of the latest inspection, the most serious first; each with its trend across reports.
  base.findings = (latest?.findings ?? []).map(f => {
    const tr = trendOf(f.item);
    // First reported: the earliest report that records it as a finding (an earlier "OK" for the same item is not).
    const first = (tr?.history ?? []).filter(h => h.date && h.severity && h.severity !== 'OK').map(h => h.date).sort()[0] ?? at;
    return { title: f.item, text: f.notes ?? f.result ?? null, result: f.result ?? null, severity: f.severity ?? null, trend: tr?.trend ?? null,
      firstReported: first, latestReported: at, recurring: tr?.trend === 'RECURRING_FINDING' || tr?.trend === 'WORSENING_WITH_EVIDENCE',
      provenance: 'ACC_INSPECTION', ref: refOf(f.citation, { assetId: e.id, inspectionDate: at, sources }) };
  }).sort((x, y) => (SEVERITY_RANK[x.severity] ?? 2) - (SEVERITY_RANK[y.severity] ?? 2) || Number(y.recurring) - Number(x.recurring));
  base.recurring = base.findings.filter(f => f.recurring);
  base.newFindings = base.findings.filter(f => f.trend === 'NEW_FINDING');
  base.worsening = (a.worsening ?? []).map(m => ({ name: m.name, basis: m.basis ?? null, provenance: 'ACC_INSPECTION', ref: refOf(m.citation ?? m.history?.at(-1)?.citation, { assetId: e.id, sources }) }));
  // Actions: documented ones, with their closure as the later reports state it (never assumed open or done).
  for (const x of cmp.actions ?? []) {
    const action = { text: x.action, priority: x.priority ?? null, due: x.due ?? null, raisedOn: x.raisedOn ?? null, inLatest: Boolean(x.inLatest),
      closure: x.closure?.status ?? 'NOT_VERIFIED', closureBasis: x.closure?.basis ?? null, provenance: 'ACC_INSPECTION',
      ref: refOf(x.citation, { assetId: e.id, inspectionDate: x.raisedOn ?? null, sources }), closureRef: x.closure?.citation ? refOf(x.closure.citation, { assetId: e.id, sources }) : null };
    if (action.closure === 'COMPLETED_WITH_EVIDENCE') { base.completedActions.push(action); base.closureEvidence.push({ text: action.text, basis: action.closureBasis, ref: action.closureRef ?? action.ref }); }
    else base.documentedCorrectiveActions.push(action);
  }
  base.documentedCorrectiveActions.sort((x, y) => Number(y.inLatest) - Number(x.inLatest) || (y.raisedOn ?? '').localeCompare(x.raisedOn ?? ''));
  // Findings the documents raise without a documented action: an investigation is needed (said as such, not as an instruction).
  const actioned = text => base.documentedCorrectiveActions.some(x => tokensOverlap(x.text, text));
  base.additionalInvestigations = base.findings.filter(f => f.severity === 'DEFECT' && !actioned(`${f.title} ${f.text ?? ''}`))
    .map(f => ({ text: `Investigate “${f.title}” (no corrective action is documented for it)`, provenance: 'DERIVED', basedOn: f.title, ref: f.ref }));
  base.operatingRestrictions = (latest?.restrictions ?? []).map(r => ({ text: r.text, applicability: `Documented at the ${at ?? 'latest'} inspection; whether it still applies is not verified.`, provenance: 'ACC_INSPECTION', ref: refOf(r.citation, { assetId: e.id, inspectionDate: at, sources }) }));
  base.evidenceAvailability = base.findings.length || base.documentedCorrectiveActions.length || base.operatingRestrictions.length ? EVIDENCE.AVAILABLE : EVIDENCE.NO_RELEVANT_FINDINGS;
  if (base.degradationCause.status === CAUSE.NOT_ESTABLISHED && base.findings.length) base.limitations.push('The inspection findings are documented, but the records do not establish whether they cause the current operational status.');
  base.sourceRefs = groupRefs([base.latestInspection?.ref, ...base.findings.map(f => f.ref), ...base.documentedCorrectiveActions.map(x => x.ref), ...base.operatingRestrictions.map(r => r.ref), ...base.conditionTrend.map(t => t.ref)]);
  return base;
}
const tokensOverlap = (a, b) => {
  const t = s => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
  const A = t(a), B = t(b);
  return [...A].filter(w => B.has(w)).length >= 1;
};

/**
 * The whole assessment (§22): scope, counts that never overlap misleadingly, the assets, and the limitations.
 * @param {object} inv the orchestrator's result
 */
export function buildMaintenanceAssessment(inv, { describe = () => ({}), scopeLabel = null } = {}) {
  // Assets with documented findings first (defects before attention items), then the rest by status.
  const rank = a => (a.evidenceAvailability === EVIDENCE.AVAILABLE ? (a.findings.some(f => f.severity === 'DEFECT') ? 0 : 1) : [EVIDENCE.RETRIEVAL_FAILED, EVIDENCE.UNREADABLE].includes(a.evidenceAvailability) ? 2 : 3);
  const order = { NO_POWER: 0, DEGRADED: 1, OFFLINE: 2 };
  const assets = inv.assets.map(e => assessAsset(e, { describe })).sort((x, y) => rank(x) - rank(y) || (order[x.operationalStatus] ?? 3) - (order[y.operationalStatus] ?? 3) || x.assetId.localeCompare(y.assetId, undefined, { numeric: true }));
  const withFindings = assets.filter(a => a.evidenceAvailability === EVIDENCE.AVAILABLE);
  const problems = assets.filter(a => PROBLEM_STATUS.has(a.operationalStatus));
  const limitations = [];
  if (inv.failures.length) limitations.push(`${inv.failures.length} asset${inv.failures.length === 1 ? '’s' : 's’'} linked documents could not be retrieved; the assessment is incomplete.`);
  if (inv.limited) limitations.push(`The first ${inv.limited} of ${inv.targets.ids.length} matching assets were investigated.`);
  if (inv.targets.notAssets?.length) limitations.push(`${inv.targets.notAssets.length} item${inv.targets.notAssets.length === 1 ? '' : 's'} in the scope ${inv.targets.notAssets.length === 1 ? 'is' : 'are'} not electrical network assets and ${inv.targets.notAssets.length === 1 ? 'was' : 'were'} not assessed.`);
  return {
    responseType: 'MAINTENANCE_ASSESSMENT', primaryIntent: inv.plan.primaryIntent, question: inv.plan.question,
    scope: { ...inv.plan.scope, label: scopeLabel }, filters: inv.plan.assetFilters, targetKind: inv.targets.how,
    summary: {
      matchingAssets: assets.length, assetsWithDocumentedFindings: withFindings.length, assetsWithoutDocumentedFindings: assets.length - withFindings.length,
      assetsWithVerifiedDegradationCause: problems.filter(a => a.degradationCause.status === CAUSE.VERIFIED).length,
      assetsWithUnknownDegradationCause: problems.filter(a => a.degradationCause.status === CAUSE.NOT_ESTABLISHED).length,
      partialEvidence: inv.partial || assets.some(a => [EVIDENCE.RETRIEVAL_FAILED, EVIDENCE.UNREADABLE].includes(a.evidenceAvailability)),
    },
    assets, limitations, illustrative: inv.assets.some(e => /illustrative/i.test(JSON.stringify(e.analysis?.caveats ?? []))),
    mapActions: assets.length ? [{ type: assets.length === 1 ? 'FOCUS_ASSET' : 'HIGHLIGHT_ASSETS', assetIds: assets.map(a => a.assetId) }] : [],
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const STATUS_WORD = { DEGRADED: 'degraded', NO_POWER: 'without power', OFFLINE: 'offline' };
const STATUS_NAME = { ...STATUS_WORD, POWERED: 'powered' };
/**
 * The direct answer (§11 / §12 / §14): what was found and how far the evidence goes, in one or two sentences.
 */
export function maintenanceSay(m) {
  const s = m.summary;
  const filt = (m.filters?.operationalStatus ?? []).map(x => STATUS_WORD[x]).filter(Boolean).join(' or ');
  const where = m.scope?.type === 'SELECTED_AREA' ? ' in the selected area' : m.scope?.type === 'TERMINAL' && m.scope.explicit ? ' across the terminal' : '';
  if (!s.matchingAssets) return { say: `I found no ${filt ? `${filt} ` : ''}assets${where} to investigate.`, say2: '' };
  if (s.matchingAssets === 1) {
    const a = m.assets[0];
    const focused = focusedSay(a, m.primaryIntent);
    if (focused) return focused;
    const who = `${a.assetId}${a.assetType ? ` (${a.assetType.toLowerCase()})` : ''}`;
    const st = STATUS_WORD[a.operationalStatus];
    const noun = (a.assetType ?? 'asset').toLowerCase();
    const head = m.targetKind === 'FILTER' ? `I found one ${filt ? `${filt} ` : 'matching '}${noun}, ${a.assetId}${where ? `,${where}` : ''}.` : `${who}${STATUS_NAME[a.operationalStatus] ? ` is reported ${STATUS_NAME[a.operationalStatus]}` : ''}.`;
    const ev = {
      AVAILABLE: a.findings.length ? `Its latest inspection${a.latestInspection?.date ? ` (${a.latestInspection.date})` : ''} documents ${plural(a.findings.length, 'issue', 'issues')}${a.documentedCorrectiveActions.length ? ` and ${plural(a.documentedCorrectiveActions.length, 'action', 'actions')} without verified closure` : ''}.` : `Its records document ${plural(a.documentedCorrectiveActions.length, 'action', 'actions')} without verified closure.`,
      NO_RELEVANT_FINDINGS: 'Its inspection records contain no findings requiring attention.',
      NO_INSPECTION_RECORDS: 'Its linked documents include no inspection report, so no maintenance findings are documented.',
      NO_DOCUMENTS: st ? `It is reported ${st}, but the available records do not establish the cause: no supporting inspection or maintenance documents are linked.` : 'No inspection or maintenance documents are linked to it, so no maintenance findings are documented.',
      RETRIEVAL_FAILED: 'Its linked inspection documents could not be retrieved, so the assessment is incomplete.',
      UNREADABLE: 'Its linked documents could not be read, so the assessment is incomplete.',
      NOT_CHECKED: 'Its documents were not checked.',
    }[a.evidenceAvailability];
    const cause = a.degradationCause.status === CAUSE.NOT_ESTABLISHED && a.evidenceAvailability === EVIDENCE.AVAILABLE ? 'The records do not establish whether these findings cause the current status.' : '';
    return { say: `${head} ${ev}`.trim(), say2: cause };
  }
  if (m.primaryIntent === 'OUTSTANDING_ACTIONS') {
    const open = m.assets.reduce((n, a) => n + a.documentedCorrectiveActions.length, 0);
    return { say: `${plural(open, 'documented action has', 'documented actions have')} no verified closure across ${plural(m.assets.filter(a => a.documentedCorrectiveActions.length).length, 'asset', 'assets')}${where}.`, say2: 'Without closure evidence the work is not known to be done or not done.' };
  }
  if (m.primaryIntent === 'OPERATING_RESTRICTIONS') {
    const n = m.assets.filter(a => a.operatingRestrictions.length).length;
    return { say: `${plural(n, 'asset has', 'assets have')} documented operating restrictions${where}, of ${s.matchingAssets} investigated.`, say2: 'Applicability now is not verified; continued operation needs engineering approval.' };
  }
  if (m.primaryIntent === 'RECURRING_DEFECTS') {
    const n = m.assets.filter(a => a.recurring.length).length;
    return { say: `${plural(n, 'asset has', 'assets have')} findings that were also reported in earlier inspections${where}, of ${s.matchingAssets} investigated.`, say2: '' };
  }
  const what = !filt ? plural(s.matchingAssets, 'asset', 'assets') : filt.includes(' ') ? `${plural(s.matchingAssets, 'asset', 'assets')} that ${s.matchingAssets === 1 ? 'is' : 'are'} ${filt}` : plural(s.matchingAssets, `${filt} asset`, `${filt} assets`);
  return { say: `I found ${what}${where}. Inspection evidence is available for ${s.assetsWithDocumentedFindings} of them.`,
    say2: s.partialEvidence ? 'Some linked documents could not be retrieved or read: the assessment is incomplete.' : '' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = iso => { const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return x ? `${Number(x[3])} ${MONTHS[Number(x[2]) - 1]} ${x[1]}` : iso ?? ''; };
const monthOf = iso => { const x = /^(\d{4})-(\d{2})/.exec(iso ?? ''); return x ? `${MONTHS[Number(x[2]) - 1]} ${x[1]}` : iso ?? ''; };
const rating = t => `${t.label ? `${t.label} ` : ''}${t.score}/${t.scale ?? 5}`;
const list = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The direct answer for one asset, focused on what was asked (§15–§16): history of the status, the condition
 * trend, recurrence, outstanding actions, operating restrictions, the cause. Null for the general assessment.
 */
export function focusedSay(a, intent) {
  const st = STATUS_WORD[a.operationalStatus];
  const noDocs = [EVIDENCE.NO_DOCUMENTS, EVIDENCE.RETRIEVAL_FAILED, EVIDENCE.UNREADABLE, EVIDENCE.NOT_CHECKED].includes(a.evidenceAvailability);
  const latest = a.latestInspection;
  switch (intent) {
    case 'HISTORICAL_STATUS':
      return { say: `${a.assetId} is reported ${st ?? (a.operationalStatus ?? 'with an unknown status').toLowerCase()}${a.statusDate ? ` (status record dated ${dayOf(a.statusDate)})` : ''}. The available operational records do not establish when ${st ? `the ${st} status` : 'this status'} began.`,
        say2: latest?.condition ? `The latest inspection recorded ${latest.condition.label ?? 'its'} condition on ${dayOf(latest.date)}; an inspection date is not the start of an operational status.` : 'No status history is recorded in the model, only the current status.' };
    case 'CONDITION_TREND': {
      const t = a.conditionTrend;
      if (t.length < 2) return { say: noDocs ? `${a.assetId}'s condition trend cannot be established: no inspection records are available.` : `${a.assetId}'s condition trend cannot be established: ${t.length ? 'only one dated condition rating is documented' : 'no dated condition rating is documented'}.`, say2: '' };
      const [first, last] = [t[0], t.at(-1)];
      const dir = last.score < first.score ? 'worsened' : last.score > first.score ? 'improved' : 'not changed';
      return { say: `${dir === 'worsened' ? 'Yes' : 'No'}: ${a.assetId}'s documented condition has ${dir}, from ${rating(first)} (${monthOf(first.date)}) to ${rating(last)} (${monthOf(last.date)}).`,
        say2: [a.worsening.length ? `${a.worsening.length} measurement${a.worsening.length === 1 ? ' is' : 's are'} documented as worsening.` : '', 'These are inspection ratings, not the live operational status.'].filter(Boolean).join(' ') };
    }
    case 'RECURRING_DEFECTS':
      if (a.inspectionCount < 2) return { say: noDocs ? `Recurrence cannot be established for ${a.assetId}: no inspection records are available.` : `Recurrence cannot be established for ${a.assetId}: only one inspection report is linked.`, say2: '' };
      return a.recurring.length
        ? { say: `Yes: ${a.recurring.length} of ${a.assetId}'s latest findings ${a.recurring.length === 1 ? 'was' : 'were'} also reported in earlier inspections: ${list(a.recurring.map(f => `${f.title}${f.firstReported ? ` (first reported ${dayOf(f.firstReported)})` : ''}`))}.`, say2: a.newFindings.length ? `${a.newFindings.length} ${a.newFindings.length === 1 ? 'is' : 'are'} new in the latest report.` : '' }
        : { say: `No: none of ${a.assetId}'s latest findings appears in its earlier inspection reports.`, say2: '' };
    case 'OUTSTANDING_ACTIONS': {
      const open = a.documentedCorrectiveActions, done = a.completedActions;
      if (noDocs) return { say: `No documented actions are available for ${a.assetId}: ${a.evidenceAvailability === EVIDENCE.NO_DOCUMENTS ? 'no documents are linked' : 'its documents could not be read'}.`, say2: '' };
      return { say: open.length ? `${open.length} documented ${open.length === 1 ? 'action has' : 'actions have'} no verified closure for ${a.assetId}${done.length ? `; ${done.length} ${done.length === 1 ? 'is' : 'are'} documented as completed` : ''}.` : `No documented action for ${a.assetId} is without verified closure${done.length ? ` (${done.length} documented as completed)` : ''}.`,
        say2: open.length ? 'Without closure evidence the work is not known to be done or not done: only later inspection reports were checked.' : '' };
    }
    case 'OPERATING_RESTRICTIONS':
      return { say: a.operatingRestrictions.length ? `${latest ? `The latest inspection (${dayOf(latest.date)})` : 'The inspection records'} ${a.operatingRestrictions.length === 1 ? 'documents one operating restriction' : `document ${a.operatingRestrictions.length} operating restrictions`} for ${a.assetId}: ${list(a.operatingRestrictions.map(r => r.text.replace(/\.$/, '')))}.` : `No operating restriction is documented for ${a.assetId}${noDocs ? ' (no readable inspection records)' : ' in its inspection records'}.`,
        say2: `Whether ${a.operatingRestrictions.length ? 'it still applies' : 'it can stay in service'} is not verified here${a.powerState === 'POWERED' ? ', and being energized does not show it is safe to operate' : ''}: continued operation needs engineering approval.` };
    case 'ASSET_DIAGNOSIS':
      if (a.degradationCause.status === CAUSE.VERIFIED) return null;
      return { say: noDocs ? `The available records do not establish why ${a.assetId} is ${st ?? 'in this state'}: no supporting inspection or maintenance findings were found.` : `The records do not establish why ${a.assetId} is ${st ?? 'in this state'}. ${a.findings.length ? `Its latest inspection${latest ? ` (${dayOf(latest.date)})` : ''} documents ${list(a.findings.slice(0, 3).map(f => f.title.toLowerCase()))}${a.findings.length > 3 ? ` and ${a.findings.length - 3} more` : ''}.` : 'Its inspection records document no defects.'}`,
        say2: a.findings.length ? 'These are documented findings, not a confirmed cause of the current status.' : '' };
    default: return null;
  }
}

/** A one-line summary of an asset's main documented issues (the multi-asset rows). */
export function rowSummary(a) {
  if (a.evidenceAvailability === EVIDENCE.AVAILABLE) {
    const items = [...a.findings.map(f => f.title), ...a.documentedCorrectiveActions.map(x => x.text)].slice(0, 3);
    return { text: items.join(', '), tone: a.findings.some(f => f.severity === 'DEFECT') ? 'bad' : 'warn', evidence: 'Findings available' };
  }
  const cause = { DEGRADED: 'Cause of degradation not documented', NO_POWER: 'Cause of power loss not documented', OFFLINE: 'Reason for being offline not documented' }[a.operationalStatus];
  return { text: { NO_RELEVANT_FINDINGS: 'No findings in its inspection records', NO_INSPECTION_RECORDS: 'No inspection report linked', NO_DOCUMENTS: cause ?? 'No linked documents',
    RETRIEVAL_FAILED: 'Documents could not be retrieved', UNREADABLE: 'Documents could not be read', NOT_CHECKED: 'Documents not checked' }[a.evidenceAvailability], tone: 'neutral', evidence: 'Investigation required' };
}
