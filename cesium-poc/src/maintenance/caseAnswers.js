/**
 * Turning a question about an ACS case into capability calls, and the results into an answer.
 *
 * The same division the TMC and Safety Intelligence screens already use: a deterministic parser
 * decides which read-only capabilities a question needs, the existing orchestrator runs them, and
 * this composes the reply from what actually came back. No figure in the answer is calculated here
 * and none is produced by a model — every number, status and finding is quoted from the capability
 * that returned it.
 *
 * The rules are ADDITIVE, as `twin/orchestrator.js` is: each clause that is recognised adds a step,
 * so "why did inspection fail and what evidence is missing?" asks both rather than the first match
 * winning and the rest being dropped.
 *
 * Pure: no DOM, no fetching, no Cesium.
 */
import { PROVENANCE } from '../twin/capabilities.js';
import { STAGE_LABELS, STAGE_ORDER } from '../qcqa/stageValidation.js';
import { stageKeyOf } from './caseCapabilities.js';
import { usd } from './claimsIntelligence.js';

/** A case id as the demonstration writes them. Only this shape is read out of a question. */
const CASE_ID = /\bACS-DEMO-\d{3}\b/i;

/** The identifier a question names, if it names one the application can recognise. */
export function caseIdIn(question) {
  const match = CASE_ID.exec(String(question ?? ''));
  return match ? match[0].toUpperCase() : null;
}

/** Which of the four stages a question is about, where it names one. */
export function stageIn(question) {
  const text = String(question ?? '').toLowerCase();
  if (/\bqa\b|\bqc\b|q\/?a|q\/?c|quality|acceptance|conform/.test(text)) return 'QCQA';
  if (/inspect/.test(text)) return 'INSPECTION';
  if (/repair|work ?order|rework/.test(text)) return 'REPAIR';
  if (/claim|recover|reimburse/.test(text)) return 'CLAIM';
  return null;
}

/**
 * Which capabilities a question needs, in the order the answer reads best.
 *
 * Stems end in `\w*` for the same reason the orchestrator's do: "failed", "blocking" and
 * "documentation" are the words people type, and a trailing word boundary rejects all three.
 */
export const CASE_CLAUSE_RULES = Object.freeze([
  { capability: 'get_case_summary',
    match: /\b(summar\w*|overview|what happened|tell me about|complete case|whole case|where (is|are) (we|this)|remain\w*|outstanding|next (required )?action|what(’|')?s left|what is left|ready\b)/i },
  { capability: 'get_case_validation',
    // `work order` and `associated` are here because the work-order reference IS a repair-stage
    // field: "which work order is associated?" is answered by the stage record, and without them
    // that question — one the repair suggestions offer — planned nothing at all.
    match: /\b(why|fail\w*|block\w*|check\w*|validat\w*|criteri\w*|acceptance|tolerance|reinspect\w*|re-?inspect\w*|correctiv\w*|non-?conform\w*|stage\w*|pass\w*|complet\w*|violat\w*|work ?order\w*|associat\w*)/i },
  { capability: 'get_case_evidence',
    match: /\b(evidence|document\w*|attach\w*|photo\w*|certificat\w*|missing|short of|paperwork|sign-?off)/i },
  { capability: 'search_missing_evidence',
    match: /\b(find|search\w*|locate|recover\w*|look for|retriev\w*|office ?track|mims|sunguide|another system|other systems)/i },
  { capability: 'get_case_claim',
    match: /\b(claim\w*|cost\w*|amount\w*|money|recover\w*|approv\w*|settl\w*|estimat\w*|submission|submit\w*|financial|exposure)/i },
  { capability: 'get_case_activity',
    match: /\b(audit|history|activity|trail|who (did|changed|reviewed|approved)|when did|log\b)/i },
  { capability: 'get_incident_weather',
    match: /\b(weather|rain\w*|visibilit\w*|wind\w*|temperatur\w*|condition\w* at|humid\w*|precipitat\w*)/i },
  { capability: 'get_incident_traffic',
    match: /\b(traffic|speed\w*|congest\w*|volume\w*|aadt|lane closure\w*|how busy)/i },
  { capability: 'get_nearby_incidents',
    match: /\b(nearby|near (this|that|here|the)|other incidents|around (this|it|there)|same (spot|location)|within \d+ ?m)/i },
  { capability: 'get_related_assets',
    match: /\b(related asset\w*|which asset\w*|what asset\w*|asset.{0,12}(link\w*|associat\w*)|proximit\w*|candidate asset\w*)/i },
]);

/**
 * The queue rules: a question about the SET of cases, not about one of them.
 *
 * "Which cases are closed?" used to plan nothing — it names no case and matches no per-case rule —
 * so it fell through to the remote free-form service, which answered about the live FL511 feed.
 * An operator looking at seven ACS cases was told the corridor had no events.
 */
export const QUEUE_CLAUSE_RULES = Object.freeze([
  { capability: 'search_cases',
    // PLURAL only. "What remains to complete this case?" and "Which asset is related to this
    // case?" are questions about one case, and a rule that matched the singular swallowed both.
    match: /\b(which|what|how many|list|show|any|all)\b[^?]{0,30}\bcases\b|\bcases (are|is|need|needs|have|has|remain)\b|\bcase queue\b|\bthe queue\b/i },
]);

/**
 * The Operations Overview rules: the corridor's own operational figures.
 *
 * These are production records, not the synthetic cases — which is exactly why they need their own
 * capability rather than being answered from the case queue.
 */
export const OPERATIONS_CLAUSE_RULES = Object.freeze([
  { capability: 'get_operations_overview',
    match: /\b(incidents?|asset\w*|repeated damage|repairs?|work ?orders?|inspections?|linked|backlog|overview|kpis?|figures?)\b/i },
]);

/** The claims-tab rules. Answered about the claim set rather than about one case. */
export const CLAIMS_CLAUSE_RULES = Object.freeze([
  { capability: 'search_claims',
    match: /\b(which claims?|what claims?|claims? (are|is|need|needs|still|that)|pending|needs? attention|missing (supporting )?document\w*|blocked claims?|unpaid|outstanding claims?)/i },
  { capability: 'get_claims_summary',
    match: /\b(total\w*|sum\b|how much|recovered|exposure|highest|most|repeated|by (asset|segment|status|incident)|breakdown|across)/i },
]);

/**
 * The plan for one question, on the subtab the operator is on.
 *
 * On Claims Intelligence the claim-set rules come first: "which claims are still pending?" is a
 * question about the list, not about whichever case happens to be selected.
 */
export function planCaseQuestion(question, context) {
  const text = String(question ?? '');
  if (!text.trim() || !context) return [];
  const steps = [];
  const add = capability => { if (!steps.includes(capability)) steps.push(capability); };

  const onClaims = context.tab === 'claims';
  if (onClaims) {
    for (const rule of CLAIMS_CLAUSE_RULES) if (rule.match.test(text)) add(rule.capability);
  } else {
    for (const rule of QUEUE_CLAUSE_RULES) if (rule.match.test(text)) add(rule.capability);
    // Operations Overview asks about the corridor's own records. Only when nothing more specific
    // has matched, so a case question on that subtab still reaches its case.
    if (context.tab === 'operations' && !steps.length && !caseIdIn(text) && !context.selectedCaseId) {
      for (const rule of OPERATIONS_CLAUSE_RULES) if (rule.match.test(text)) add(rule.capability);
    }
  }
  const named = caseIdIn(text);
  /**
   * A question that names no case and has no case selected cannot be answered about one. The
   * claim-set rules still apply, which is what makes the Claims subtab answerable with nothing
   * selected.
   *
   * On Claims Intelligence, a question the claim-set rules already recognised is a question about
   * the SET: "which claims are still pending?" wants the list. Letting the per-case rules fire too
   * made the answer open with the selected claim's own case, which reads as an answer about a case
   * nobody asked about.
   */
  const setAnswered = steps.length > 0;
  const hasCase = Boolean(named || (!setAnswered && context.selectedCaseId));
  if (hasCase) {
    for (const rule of CASE_CLAUSE_RULES) if (rule.match.test(text)) add(rule.capability);
  }
  if (!onClaims && !steps.length) {
    for (const rule of CLAIMS_CLAUSE_RULES) if (rule.match.test(text)) add(rule.capability);
  }
  return steps.slice(0, 6);
}

/**
 * The inputs each planned capability is called with.
 *
 * The case id comes from the question only when the question names one; otherwise the capability
 * falls back to the selection itself. Either way the id is looked up, never trusted.
 */
export function caseCapabilityInput(question, context, plan = []) {
  const caseId = caseIdIn(question) ?? context?.selectedCaseId ?? null;
  const stage = stageIn(question);
  const input = {};
  for (const capability of plan) {
    input[capability] = { ...(caseId ? { caseId } : {}) };
    if (stage && (capability === 'get_case_validation' || capability === 'get_case_evidence')) {
      input[capability].stage = stage;
    }
    if (capability === 'search_cases') {
      const text = String(question).toLowerCase();
      input[capability].bucket = /\bclosed\b|\bcomplete[d]?\b|\bfinished\b/.test(text) ? 'closed'
        : /\bneed\w* action|\bblocked\b|\battention\b|\bfail\w*/.test(text) ? 'action'
          : /\bin progress\b|\bunderway\b|\bopen\b|\boutstanding\b/.test(text) ? 'progress' : 'all';
      if (stage) input[capability].stage = stage;
    }
    if (capability === 'search_claims' && /missing (supporting )?document/i.test(question)) {
      input[capability].missingDocuments = true;
    }
    if (capability === 'search_claims' && /\bpending\b/i.test(question)) input[capability].status = 'PENDING';
    if (capability === 'get_claims_summary') {
      input[capability].dimension = /asset/i.test(question) ? 'assetType'
        : /status/i.test(question) ? 'status'
          : /incident/i.test(question) ? 'incidentType' : 'segment';
    }
  }
  return input;
}

/* ── composing the answer ────────────────────────────────────────────────────────────────────── */

const line = (out, text) => { if (text) out.push(text); };
const blank = out => { if (out.length && out[out.length - 1] !== '') out.push(''); };
const money = value => (value == null ? 'not recorded' : usd(value));

function summaryLines(out, data) {
  blank(out);
  line(out, `${data.caseId} — ${data.incident.type} affecting ${data.asset.assetType} `
    + `(${data.asset.assetName}). Status: ${data.status}.`);
  if (data.blockingStageLabel) line(out, `Held at: ${data.blockingStageLabel}.`);
  line(out, `Stages: ${data.stages.map(stage => `${stage.label} ${stage.status}`
    + (stage.blockedBy ? ` (held by ${stage.blockedBy})` : '')).join(' · ')}`);
  line(out, `Next action: ${data.outstanding.action}`);
  if (data.outstanding.role || data.outstanding.team) {
    line(out, `Owner: ${[data.outstanding.role, data.outstanding.team].filter(Boolean).join(' · ')}.`);
  }
  if (data.location?.sourceIncidentId) {
    line(out, `On the map it sits at register incident ${data.location.sourceIncidentId}`
      + `${data.location.segment ? ` · ${data.location.segment}` : ''}.`);
  }
}

function validationLines(out, data) {
  for (const stage of data.stages) {
    blank(out);
    if (stage.gatedBy) {
      // The one distinction this screen exists to keep: blocked is not failed.
      line(out, `${stage.label}: BLOCKED — held by the ${stage.gatedBy} stage. It has no findings `
        + 'of its own; nothing about it has been checked and found wanting.');
      continue;
    }
    line(out, `${stage.label}: ${stage.status} — ${stage.summary.passed} passed, `
      + `${stage.summary.failed} failed, ${stage.summary.missing} missing.`);
    for (const field of stage.failed) {
      line(out, `• FAILED ${field.label}${field.message ? ` — ${field.message}` : ''}`);
    }
    for (const field of stage.missing) {
      line(out, `• MISSING ${field.label}${field.message ? ` — ${field.message}` : ''}`);
    }
    for (const field of stage.pending) line(out, `• PENDING ${field.label} — required, not yet due.`);
  }
  const open = data.nonConformances.filter(entry => entry.status === 'OPEN');
  if (open.length) {
    blank(out);
    line(out, `${open.length} open non-conformance${open.length === 1 ? '' : 's'}:`);
    for (const entry of open) line(out, `• ${entry.description ?? entry.id} → ${entry.correctiveAction ?? 'no corrective action recorded'}`);
  }
  if (!data.checklist.agrees) {
    blank(out);
    line(out, `Checklist: the case declares ${data.checklist.declared}; the selection engine would `
      + `choose ${data.checklist.engineWouldSelect.join(', ') || 'none'}. The disagreement is shown, not resolved.`);
  }
  blank(out);
  line(out, `Corrective action: ${data.correctiveAction}`);
}

function evidenceLines(out, data) {
  blank(out);
  line(out, `Evidence held: ${data.counts.held}. Missing: ${data.counts.missing}.`);
  for (const gap of data.missing) {
    line(out, `• ${gap.stage} · ${gap.label}${gap.message ? ` — ${gap.message}` : ''}`);
  }
  for (const entry of data.humanOnly) {
    line(out, `• ${entry.fieldId} cannot be filled by any recovered record: ${entry.reason}`);
  }
}

function searchLines(out, data) {
  blank(out);
  line(out, 'Searched: ' + data.searches.map(search =>
    `${search.label} ${search.status === 'UNAVAILABLE' ? 'SOURCE_UNAVAILABLE' : `${search.status} (${search.records})`}`
    + `${search.origin === 'SYNTHETIC' ? ' [synthetic stand-in]' : ''}`).join(' · '));
  for (const gap of data.gaps) {
    blank(out);
    if (gap.humanOnly) {
      line(out, `${gap.label}: no record can satisfy this — ${gap.humanOnly.reason}`);
      continue;
    }
    if (!gap.best) {
      line(out, `${gap.label}: nothing found. ${gap.reason ?? ''}`.trim());
      continue;
    }
    line(out, `${gap.label}: candidate ${gap.best.recordId} from ${gap.best.system} — `
      + `${gap.best.tier}, ${gap.best.confidence}% confidence.`);
    if (gap.best.explanation) line(out, `  ${gap.best.explanation}`);
    for (const warning of gap.best.warnings) line(out, `  ⚠ ${warning}`);
    line(out, gap.requiresReview
      ? `  Needs human review${gap.reviewReason ? `: ${gap.reviewReason}` : ''}. Nothing has been attached.`
      : '  Nothing has been attached — this is a proposal, not a recovery.');
  }
}

function claimLines(out, data) {
  blank(out);
  line(out, `Claim ${data.claimReference ?? '(no reference)'} — ${data.statusLabel}.`);
  line(out, `Estimated ${money(data.financial.estimatedUSD)} · claimed ${money(data.financial.claimedUSD)} `
    + `· approved ${money(data.financial.approvedUSD)} · recovered ${money(data.financial.recoveredUSD)} `
    + `· outstanding ${money(data.financial.outstandingUSD)}.`);
  if (data.financial.basis) line(out, `Cost basis: ${data.financial.basis}.`);
  for (const finding of data.findings) {
    line(out, `• ${finding.status} ${finding.label}${finding.message ? ` — ${finding.message}` : ''}`);
  }
  if (data.outstanding.blockingStage && !data.outstanding.isClaimStage) {
    line(out, `Nothing is outstanding on the claim itself: the ${data.outstanding.blockingStage} `
      + 'stage is holding this case.');
  }
}

function activityLines(out, data) {
  blank(out);
  line(out, `Audit trail: ${data.total} entr${data.total === 1 ? 'y' : 'ies'}`
    + `${data.firstActivity ? `, ${data.firstActivity} → ${data.lastActivity}` : ''}.`);
  for (const entry of data.entries.slice(-8)) {
    line(out, `• ${entry.at} — ${entry.event ?? entry.action ?? 'event'}`
      + `${entry.actor ? ` (${entry.actor})` : ''}${entry.detail ? `: ${entry.detail}` : ''}`);
  }
}

function weatherLines(out, data) {
  blank(out);
  line(out, `Weather at ${data.requestedFor}, matched to the observation at ${data.matchedObservationAt}`
    + `${data.localHour ? ` (${data.localHour} corridor time)` : ''}:`);
  for (const entry of data.observations) {
    line(out, `• ${entry.label}: ${entry.value == null ? 'no value returned' : entry.value}`
      + `${entry.unit ? ` ${entry.unit}` : ''} — ${entry.quality}`);
  }
  line(out, `Provenance: ${data.provenance}`);
  for (const text of data.implications) line(out, `• ${text}`);
}

function trafficLines(out, data) {
  blank(out);
  line(out, 'Traffic — what is actually recorded:');
  for (const entry of data.recorded) {
    line(out, `• ${entry.label}: ${entry.value ?? 'not recorded'} (${entry.source}, ${entry.quality})`);
  }
  if (data.annualAverage) {
    line(out, `• ${data.annualAverage.label}: ${data.annualAverage.value ?? 'not published'}`
      + `${data.annualAverage.unit ? ` ${data.annualAverage.unit}` : ''} — a published annual average, not an observation at this hour.`);
  }
  line(out, 'No timestamped historical speed, volume or congestion observation exists for this '
    + `corridor in any connected system (checked: ${data.sourcesChecked.join(', ')}).`);
  const synthetic = Object.entries(data.synthetic).filter(([, entry]) => entry?.value != null);
  if (synthetic.length) {
    line(out, 'Shown for the demonstration only, and SYNTHETIC: '
      + synthetic.map(([key, entry]) => `${key} ${entry.value}${entry.unit ? ` ${entry.unit}` : ''}`).join(' · ')
      + '. These are not measurements and current FL511 conditions have not been substituted for them.');
  }
}

function nearbyLines(out, data) {
  blank(out);
  line(out, `${data.total} register incident(s) within ${data.radiusM} m and ${data.windowDays} day(s) `
    + `of ${data.anchorIncidentId} (searched ${data.searchedRecords} records).`);
  for (const entry of data.incidents) {
    line(out, `• ${entry.incidentId} — ${entry.distanceM} m${entry.at ? `, ${entry.at}` : ''}`
      + `${entry.type ? `, ${entry.type}` : ''}, ${entry.severity}. Matched on ${entry.matchedOn}.`);
  }
  if (data.total) {
    line(out, 'Being nearby does not establish that any of these involved the same asset or is '
      + 'related to this case.');
  }
}

function relatedLines(out, data) {
  blank(out);
  line(out, `The case names ${data.namedAsset.assetId} (${data.namedAsset.assetType}) as damaged — `
    + `${data.namedAsset.relationshipLabel}. ${data.namedAsset.reason}`);
  if (data.sourceIncidentAsset) {
    line(out, `The real incident ${data.sourceIncidentId} links to registry asset `
      + `${data.sourceIncidentAsset.assetId} — ${data.sourceIncidentAsset.relationshipLabel}`
      + `${Number.isFinite(data.sourceIncidentAsset.distanceM) ? `, ${data.sourceIncidentAsset.distanceM} m away` : ''}. `
      + data.sourceIncidentAsset.reason);
  } else {
    line(out, `The real incident ${data.sourceIncidentId ?? '(none resolved)'} is `
      + `${data.sourceIncidentRelationship}: no registry asset is named by it and none lies within `
      + `${data.candidateRadiusM} m.`);
  }
}

function operationsLines(out, data) {
  blank(out);
  line(out, `Operations Overview, over ${data.incidents} incident record(s) and `
    + `${data.assets} registry asset(s):`);
  for (const entry of data.kpis) {
    line(out, entry.available
      ? `• ${entry.label}: ${entry.value} (${entry.basis.toLowerCase()}) — ${entry.note}`
      : `• ${entry.label}: not available — ${entry.note}`);
  }
  blank(out);
  line(out, `Incident-to-asset links: ${data.associations.CONFIRMED} confirmed, `
    + `${data.associations.CANDIDATE} proximity candidate(s) awaiting review, `
    + `${data.associations.INFERRED} inferred, ${data.associations.UNLINKED} with nothing to match on.`);
  for (const row of data.repeatedDamage.slice(0, 5)) {
    line(out, `• ${row.assetId} — ${row.count} confirmed incidents`
      + `${row.segment ? ` · ${row.segment}` : ''}`
      + `${row.firstIncidentDate ? `, ${row.firstIncidentDate} to ${row.lastIncidentDate}` : ''}.`);
  }
}

function queueLines(out, data) {
  blank(out);
  line(out, `${data.total} of ${data.of} ACS case(s) match. The queue holds `
    + `${data.counts.action} needing action, ${data.counts.progress} in progress and `
    + `${data.counts.closed} closed.`);
  // The distribution first: "which stage holds up the most cases" is answered by this line, and
  // putting it after seven rows buried it below the fold.
  if (data.byBlockingStage.length) {
    line(out, 'Held at: ' + data.byBlockingStage
      .map(entry => `${entry.label} ${entry.count}`).join(' · ') + '.');
  }
  for (const row of data.cases) {
    line(out, `• ${row.caseId} — ${row.status}, ${row.assetType ?? 'asset not stated'}`
      + `${row.segment ? ` · ${row.segment}` : ''}`
      + `${row.blockingStageLabel ? `, held at ${row.blockingStageLabel}` : ''}`
      + `${row.lastActivity ? `, last activity ${String(row.lastActivity).slice(0, 10)}` : ''}.`);
  }
}

function claimsSearchLines(out, data) {
  blank(out);
  line(out, `${data.total} of ${data.of} demonstration claim(s) match.`);
  for (const claim of data.claims) {
    line(out, `• ${claim.claimReference ?? claim.caseId} (${claim.caseId}) — ${claim.statusLabel}, `
      + `${claim.assetType ?? 'asset not stated'}${claim.segment ? ` · ${claim.segment}` : ''}, `
      + `claimed ${money(claim.claimedUSD)}, recovered ${money(claim.recoveredUSD)}.`);
  }
}

function claimsSummaryLines(out, data) {
  blank(out);
  line(out, `${data.counts.total} demonstration claims: ${data.counts.pending} pending, `
    + `${data.counts.needsDocumentation} short of documentation, ${data.counts.approved} approved, `
    + `${data.counts.settled} settled, ${data.counts.blocked} blocked by an earlier stage.`);
  line(out, `Estimated ${data.money.formatted.estimated} · claimed ${data.money.formatted.claimed} `
    + `· recovered ${data.money.formatted.recovered} · outstanding ${data.money.formatted.outstanding}.`);
  blank(out);
  line(out, `By ${data.groupedBy.label.toLowerCase()}:`);
  for (const group of data.groups.slice(0, 8)) {
    line(out, `• ${group.value} — ${group.count} claim(s), `
      + `claimed ${money(group.claimedUSD)}, recovered ${money(group.recoveredUSD)}.`);
  }
  line(out, data.repeatedClaims.length
    ? `${data.repeatedClaims.length} asset(s) are named by more than one claim.`
    : 'No asset is named by more than one claim in this set, so there is no repeated-claim pattern.');
}

const SECTIONS = Object.freeze({
  // The sets first: when a question is about the set, the set is the answer.
  get_operations_overview: operationsLines,
  search_cases: queueLines,
  get_case_summary: summaryLines,
  get_case_validation: validationLines,
  get_case_evidence: evidenceLines,
  search_missing_evidence: searchLines,
  get_case_claim: claimLines,
  get_case_activity: activityLines,
  get_incident_weather: weatherLines,
  get_incident_traffic: trafficLines,
  get_nearby_incidents: nearbyLines,
  get_related_assets: relatedLines,
  search_claims: claimsSearchLines,
  get_claims_summary: claimsSummaryLines,
});

/** The capabilities whose answers are about ONE case, and so carry its disclaimer. */
const CASE_SCOPED = new Set(['get_case_summary', 'get_case_validation', 'get_case_evidence',
  'search_missing_evidence', 'get_case_claim', 'get_case_activity', 'get_incident_weather',
  'get_incident_traffic', 'get_nearby_incidents', 'get_related_assets']);

/**
 * The answer, from whatever actually ran.
 *
 * A step that was unavailable is reported rather than omitted — an investigation that quietly ran
 * three of five steps is indistinguishable from one that ran all five.
 */
export function composeCaseAnswer(run, context) {
  const out = [];
  const record = context?.case ?? null;
  const answered = Object.entries(SECTIONS)
    .filter(([capability]) => run.results?.[capability]?.status === 'ok' && run.results[capability].data);
  // The per-case disclaimer belongs on a per-case answer. On a queue or corridor answer it named a
  // case the question was not about, which is its own kind of confusion.
  if (record?.isSynthetic && answered.some(([capability]) => CASE_SCOPED.has(capability))) {
    out.push(`${record.caseId} is synthetic demonstration data: the damage, inspection, repair, `
      + 'QC/QA and claim below did not happen. Only its location is a real corridor incident.');
  }
  for (const [capability, section] of answered) section(out, run.results[capability].data);

  const refused = (run.steps ?? []).filter(step => ['unavailable', 'timeout', 'error', 'unknown'].includes(step.status));
  if (refused.length) {
    blank(out);
    out.push('Could not be answered:');
    for (const step of refused) {
      out.push(`• ${step.capability}: ${step.reason ?? run.results?.[step.capability]?.reason ?? step.status}`);
    }
  }
  if (run.limitations?.length) {
    blank(out);
    out.push('Limitations');
    for (const text of [...new Set(run.limitations)].slice(0, 8)) out.push(`• ${text}`);
  }
  if (run.provenance === PROVENANCE.MIXED) {
    blank(out);
    out.push('This answer mixes recorded data with explicitly synthetic records; each section '
      + 'above says which.');
  }
  return out.join('\n').trim();
}

export { STAGE_LABELS, STAGE_ORDER, stageKeyOf };
