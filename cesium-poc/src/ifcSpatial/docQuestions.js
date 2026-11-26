/**
 * Ask the Twin: questions answered from an asset's documents (its inspection reports, asset sheets and
 * datasheets in ACC), routed ahead of "locate the asset it names":
 *
 *   ASSET_REPLACEMENT_READINESS    before we replace TX-M1, summarize… / what should we verify before replacing… / replacement checklist
 *   ASSET_INSPECTION_HISTORY       summarize TX-M1 inspection history / what defects were reported for USS-1?
 *   ASSET_TECHNICAL_SPECIFICATIONS show technical specifications for TX-M2 / what is the rated capacity?
 *   ASSET_MAINTENANCE_HISTORY      which inspection recommended corrective action? / maintenance history
 *   ASSET_CONDITION_TREND          has TX-M1's condition deteriorated? / was the same defect reported earlier? / has that issue been resolved?
 *   ASSET_DOCUMENT_COMPARISON      compare the latest two inspection reports for TX-M1 / compare TX-M1 and TX-M2 specifications
 *   ASSET_DOCUMENT_SUMMARY         summarize TX-M1's documents
 *   FLEET_INSPECTION_ISSUES        which assets have recurring inspection issues?
 *   SHOW_SOURCE                    show the document where this was mentioned
 *   REPLACEMENT_IMPACT             which downstream assets would be affected during replacement? (the electrical model)
 *
 * The asset is the one named, or the conversation's when the question says "it", "its", "that issue" or names none.
 * Everything else returns null and keeps its route.
 */
import { namedIds } from './askCompare.js';

export const DOC_INTENT = Object.freeze({
  REPLACEMENT_READINESS: 'ASSET_REPLACEMENT_READINESS', INSPECTION_HISTORY: 'ASSET_INSPECTION_HISTORY', TECHNICAL_SPECIFICATIONS: 'ASSET_TECHNICAL_SPECIFICATIONS',
  MAINTENANCE_HISTORY: 'ASSET_MAINTENANCE_HISTORY', CONDITION_TREND: 'ASSET_CONDITION_TREND', DOCUMENT_COMPARISON: 'ASSET_DOCUMENT_COMPARISON',
  DOCUMENT_SUMMARY: 'ASSET_DOCUMENT_SUMMARY', FLEET: 'FLEET_INSPECTION_ISSUES', SHOW_SOURCE: 'SHOW_SOURCE', REPLACEMENT_IMPACT: 'REPLACEMENT_IMPACT',
  EVIDENCE: 'ASSET_FINDING_EVIDENCE',
});
/** The server's analysis type for each intent. */
export const ANALYSIS_OF = {
  ASSET_REPLACEMENT_READINESS: 'REPLACEMENT_READINESS', ASSET_INSPECTION_HISTORY: 'INSPECTION_HISTORY', ASSET_TECHNICAL_SPECIFICATIONS: 'TECHNICAL_SPECIFICATIONS',
  ASSET_MAINTENANCE_HISTORY: 'MAINTENANCE_HISTORY', ASSET_CONDITION_TREND: 'CONDITION_TRENDS', ASSET_DOCUMENT_COMPARISON: 'DOCUMENT_COMPARISON', ASSET_DOCUMENT_SUMMARY: 'DOCUMENT_SUMMARY',
};

const REPLACE = /\b(replac(e|es|ed|ing|ement)|swap(ping)? out|renew(al|ing)?|change ?out)\b/i;
const PREP = /\b(before|summari[sz]e|history|spec\w*|verify|check(list)?|readiness|prepare|plan(ning)?|know|consider)\b/i;
const IMPACT = /\b(affected|impact\w*|lose (power|supply)|outage|downstream|isolat\w*|switching)\b/i;
const INSPECTION = /\binspect(ion|ions|ed|or)?s?\b|\bexamination\b|\bsurvey\b/i;
const HISTORY = /\b(history|reports?|records?|results?|findings?|summari[sz]e|summary|latest|last|previous|earlier)\b/i;
const DEFECTS = /\b(defects?|findings?|faults?|issues?|problems?|observations?)\b.*\b(reported|found|recorded|documented|raised|noted|identified)\b|\b(reported|recorded|documented) (defects?|issues?|findings?)\b/i;
const SPECS = /\b(technical )?spec(ification)?s?\b|\bdatasheet\b|\bdata sheet\b|\bnameplate\b|\brated (capacity|power|voltage|current|load)\b|\b(primary|secondary) voltage\b|\b(impedance|vector group|manufacturer|serial number|cooling (method|class)|kva|mva)\b|\bwhat (is|are) (its|the) (rating|capacity|voltage|weight|dimensions?|size)\b|\bhow (heavy|big)\b/i;
const MAINTENANCE = /\bmaintenance\b|\bwork orders?\b|\bcorrective actions?\b|\brecommend(ed|s)? (actions?|repairs?|corrective)|\bwhich (inspection|report) recommend/i;
const TREND = /\bdeteriorat\w*|\bworsen\w*|\bimprov\w*|\btrends?\b|\bover time\b|\bcondition (changed|history)\b|\bsame (defect|issue|finding|problem)\b|\brecurr\w*|\b(reported|seen|found|recorded) (before|earlier|previously)\b|\bearlier inspections?\b|\b(been )?resolved\b|\b(fixed|repaired|closed) yet\b|\bstill (open|outstanding)\b/i;
const COMPARE = /\bcompar\w*|\bversus\b|\bvs\.?\b|\bdifferen\w* between\b/i;
const DOC_WORDS = /\b(document(ation)?s?|reports?|records?|pdfs?|files?|sheets?)\b/i;
const SHOW_SOURCE = /\b(show|open|see)\b.*\b(document|source|report|page|pdf)\b.*\b(where|that|which|mention\w*|says?|said)\b|\bwhere (was|is) (this|that|it) (mentioned|stated|reported|documented)\b|\bopen the (source|report|document)\b/i;
const FLEET = /\b(which|what|any|list) (assets?|equipment|transformers?|cranes?)\b.*\b(recurring|repeated|repeat|worsening|deteriorat\w*|inspection (issues?|findings?|problems?)|open (defects?|actions?)|defects?)\b/i;
const EVIDENCE = /\b(evidence|sources?|proof|citations?)\b.*\b(for|of|behind|about|on)\b\s+(?:the\s+|that\s+|this\s+|its\s+)?(.+?)\s*(issue|finding|problem|defect|concern)?s?\s*[?.!]*$/i;
const UNCLOSED = /\b(not|un)[ -]?(verified )?(closed|completed|done|resolved)\b|\bwithout (verified |documented )?closure\b|\bopen (corrective )?actions?\b|\bactions?\b.*\b(open|outstanding|closed|closure)\b/i;
const MISSING = /\b(missing|undocumented|not documented|gaps?)\b/i;
const LATEST = /\b(latest|last|most recent|newest)\b/i;
const PRONOUN = /\b(it|its|it's|this|that|these|those|them|the asset|the same)\b/i;
/** The field a specification question asks about, if one. */
const FIELDS = [
  ['ratedPower', /\brated (capacity|power)\b|\bcapacity\b|\b(kva|mva)\b|\bhow (big|large)\b/i], ['primaryVoltage', /\bprimary voltage\b|\bhv voltage\b/i],
  ['secondaryVoltage', /\bsecondary voltage\b|\blv voltage\b/i], ['impedance', /\bimpedance\b/i], ['vectorGroup', /\bvector group\b/i],
  ['manufacturer', /\bmanufacturer\b|\bwho (made|makes)\b/i], ['serial', /\bserial number\b/i], ['weight', /\bweight\b|\bhow heavy\b/i],
  ['dimensions', /\bdimensions?\b|\bsize\b/i], ['cooling', /\bcooling\b/i], ['frequency', /\bfrequency\b/i], ['ratedLoad', /\b(safe working|rated) load\b|\bswl\b/i],
  ['ratedCurrent', /\brated current\b/i], ['voltageLevel', /\bvoltage\b/i],
];

/**
 * @param {string} question
 * @param {{assetIds: Set<string>, contextAssetId?: string|null, lastAnalysis?: object|null}} opts
 */
export function classifyDocumentQuestion(question, { assetIds, contextAssetId = null, lastAnalysis = null }) {
  const q = String(question ?? '');
  const named = namedIds(q, assetIds);
  const usesContext = !named.length && (PRONOUN.test(q) || Boolean(lastAnalysis) || Boolean(contextAssetId));
  const asset = named[0] ?? (usesContext ? contextAssetId : null);
  const assets = named.length ? named : asset ? [asset] : [];
  const out = (intent, extra = {}) => ({ intent, assetIds: assets, assetId: assets[0] ?? null, analysisType: ANALYSIS_OF[intent] ?? null, ...extra });

  if (SHOW_SOURCE.test(q) && lastAnalysis) return out(DOC_INTENT.SHOW_SOURCE);
  // "Show the evidence for the cooling system issue": the component in the analysis already read.
  const ev = EVIDENCE.exec(q);
  if (ev && lastAnalysis?.review && (!named.length || named[0] === lastAnalysis.asset.id)) {
    const hit = findingFor(ev[3], lastAnalysis.review.components);
    if (hit) return { intent: DOC_INTENT.EVIDENCE, assetIds: [lastAnalysis.asset.id], assetId: lastAnalysis.asset.id, analysisType: null, openItem: hit.item,
      evidenceSay: `${hit.item}: ${hit.observations.length} observation${hit.observations.length === 1 ? '' : 's'} across the inspection reports, each with its source.` };
  }
  // "Compare this transformer with TX-M1": the conversation's asset and the one named.
  if (COMPARE.test(q) && named.length === 1 && contextAssetId && contextAssetId !== named[0] && PRONOUN.test(q) && (lastAnalysis || INSPECTION.test(q) || SPECS.test(q))) {
    return { intent: DOC_INTENT.DOCUMENT_COMPARISON, assetIds: [contextAssetId, named[0]], assetId: contextAssetId, analysisType: ANALYSIS_OF[DOC_INTENT.DOCUMENT_COMPARISON], compare: 'ASSETS',
      aspect: SPECS.test(q) && !INSPECTION.test(q) ? 'SPECS' : 'INSPECTIONS' };
  }
  if (UNCLOSED.test(q) && assets.length && (lastAnalysis || named.length)) return out(DOC_INTENT.CONDITION_TREND, { focus: 'CLOSURE' });
  if (!named.length && FLEET.test(q)) return { intent: DOC_INTENT.FLEET, assetIds: [], assetId: null, analysisType: null };
  // Replacement: the network impact of the work (electrical model), or the documents for it.
  if (REPLACE.test(q) && !/\b(oil|gasket|fan|ropes?|brushes?|seal)\b.*\breplac/i.test(q)) {
    if (IMPACT.test(q) && !/\b(summari[sz]e|history|spec\w*|documents?|inspection)\b/i.test(q)) return assets.length ? out(DOC_INTENT.REPLACEMENT_IMPACT) : null;
    if (PREP.test(q) || DOC_WORDS.test(q) || INSPECTION.test(q)) return assets.length ? out(DOC_INTENT.REPLACEMENT_READINESS, { withTopology: true }) : needAsset(DOC_INTENT.REPLACEMENT_READINESS);
  }
  if (COMPARE.test(q) && (INSPECTION.test(q) || SPECS.test(q) || DOC_WORDS.test(q))) {
    if (!assets.length) return needAsset(DOC_INTENT.DOCUMENT_COMPARISON);
    return out(DOC_INTENT.DOCUMENT_COMPARISON, { compare: assets.length >= 2 ? 'ASSETS' : 'REPORTS', aspect: SPECS.test(q) && !INSPECTION.test(q) ? 'SPECS' : 'INSPECTIONS' });
  }
  if (TREND.test(q) && (assets.length || lastAnalysis)) return assets.length ? out(DOC_INTENT.CONDITION_TREND, { focus: /\bresolved|fixed|closed|still (open|outstanding)/i.test(q) ? 'CLOSURE' : 'TREND' }) : null;
  if (MAINTENANCE.test(q)) return assets.length ? out(DOC_INTENT.MAINTENANCE_HISTORY) : needAsset(DOC_INTENT.MAINTENANCE_HISTORY);
  if ((INSPECTION.test(q) && (HISTORY.test(q) || named.length)) || DEFECTS.test(q)) {
    if (!assets.length) return needAsset(DOC_INTENT.INSPECTION_HISTORY);
    return out(DOC_INTENT.INSPECTION_HISTORY, { focus: DEFECTS.test(q) ? 'DEFECTS' : LATEST.test(q) ? 'LATEST' : 'HISTORY' });
  }
  if (SPECS.test(q) && (named.length || usesContext)) {
    if (!assets.length) return needAsset(DOC_INTENT.TECHNICAL_SPECIFICATIONS);
    const field = /\bspec(ification)?s?\b|\bdatasheet\b|\bnameplate\b/i.test(q) ? null : FIELDS.find(([, re]) => re.test(q))?.[0] ?? null;
    return out(DOC_INTENT.TECHNICAL_SPECIFICATIONS, { field, focus: !field && MISSING.test(q) ? 'MISSING' : null });
  }
  if (/\bsummari[sz]e\b|\bwhat do (the|its|their)\b/i.test(q) && DOC_WORDS.test(q) && assets.length) return out(DOC_INTENT.DOCUMENT_SUMMARY);
  return null;
}
/** The component a phrase names ("cooling system" → "Radiators and cooling fans"), by shared words. */
export function findingFor(phrase, components = []) {
  const stem = w => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, '');
  const ws = p => String(p).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 2 && !/^(the|and|for|system|issue|with)$/.test(w)).map(stem);
  const want = ws(phrase);
  const score = c => { const own = new Set(ws(`${c.item} ${c.latestNote ?? ''}`)); return want.filter(w => own.has(w)).length; };
  const best = [...components].map(c => [c, score(c)]).sort((x, y) => y[1] - x[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}
const needAsset = intent => ({ intent, assetIds: [], assetId: null, analysisType: ANALYSIS_OF[intent] ?? null, needsAsset: true });
