/**
 * Asset document intelligence: what an asset's own documents say, read from their contents
 * (docExtract.mjs), never from file names or general equipment knowledge.
 *
 *  - Each document is classified by what it contains (an "Inspection date" row, a specification table…).
 *  - Specifications: the documented label/value rows, mapped to fields that suit the asset's category
 *    (a transformer's voltages are not asked of a crane). A field nobody documents is "Not documented";
 *    two documents giving different values are both kept and flagged as a conflict.
 *  - Inspections: the inspection date (only from the report's own date row, never the upload or file date),
 *    condition, findings (rows with a result), measurements, actions and restrictions.
 *  - Trends compare reports of the same asset: a finding is RECURRING only when two dated reports record it,
 *    an action is completed only when a later document says so, and a missing finding is not a good result.
 *  - Every material statement carries a citation: {documentId, version, page, section, evidenceText}, the
 *    extracted line it rests on.
 */
import { layoutDocument, sentences } from './docExtract.mjs';

export const ANALYSIS_PIPELINE = 'doc-intel-1';
export const ANALYSIS = Object.freeze({
  INSPECTION_HISTORY: 'INSPECTION_HISTORY', TECHNICAL_SPECIFICATIONS: 'TECHNICAL_SPECIFICATIONS', MAINTENANCE_HISTORY: 'MAINTENANCE_HISTORY',
  DOCUMENT_SUMMARY: 'DOCUMENT_SUMMARY', CONDITION_TRENDS: 'CONDITION_TRENDS', REPLACEMENT_READINESS: 'REPLACEMENT_READINESS', DOCUMENT_COMPARISON: 'DOCUMENT_COMPARISON',
});
export const DOC_TYPE = Object.freeze({ TECHNICAL_SPECIFICATION: 'TECHNICAL_SPECIFICATION', INSPECTION: 'INSPECTION', MAINTENANCE: 'MAINTENANCE', TEST_REPORT: 'TEST_REPORT', OTHER: 'OTHER' });
export const TREND = Object.freeze({
  NEW_FINDING: 'NEW_FINDING', RECURRING_FINDING: 'RECURRING_FINDING', RESOLVED_WITH_EVIDENCE: 'RESOLVED_WITH_EVIDENCE',
  WORSENING_WITH_EVIDENCE: 'WORSENING_WITH_EVIDENCE', IMPROVING_WITH_EVIDENCE: 'IMPROVING_WITH_EVIDENCE', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});
export const CLOSURE = Object.freeze({
  COMPLETED_WITH_EVIDENCE: 'COMPLETED_WITH_EVIDENCE', NOT_COMPLETED_WITH_EVIDENCE: 'NOT_COMPLETED_WITH_EVIDENCE', NOT_VERIFIED: 'NOT_VERIFIED',
});
export const NOT_DOCUMENTED = 'Not documented';

// ---- citations ----

/** A citation to an extracted line of a document. */
export function cite(doc, item, section) {
  return {
    documentId: doc.documentId, fileName: doc.fileName, title: doc.title, version: doc.version?.versionNumber ?? null,
    page: item?.page ?? null, section: section ?? null, evidenceText: String(item?.text ?? '').slice(0, 400),
  };
}

// ---- normalising a document ----

const kvs = layout => layout.sections.flatMap(s => s.kv.map(k => ({ ...k, section: s.heading })));
const findKv = (layout, re) => kvs(layout).find(k => re.test(k.label.replace(/[.:]+$/, '').trim()));
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
/** A date written in a document → "YYYY-MM-DD", or null (never guessed from anything else). */
export function documentDate(text) {
  const s = String(text ?? '');
  const iso = ISO_DAY.exec(s);
  if (iso && !Number.isNaN(Date.parse(`${iso[0]}T00:00:00Z`))) return iso[0];
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS})\\.? (\\d{4})\\b`, 'i').exec(s);
  const mdy = new RegExp(`\\b(${MONTHS})\\.? (\\d{1,2}),? (\\d{4})\\b`, 'i').exec(s);
  const parts = dmy ? [dmy[3], dmy[2], dmy[1]] : mdy ? [mdy[3], mdy[1], mdy[2]] : null;
  if (!parts) return null;
  const d = new Date(`${parts[1]} ${parts[2]}, ${parts[0]} 00:00:00 UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const SPEC_HINT = /\b(voltage|rating|rated|capacity|power|current|manufacturer|model|serial|frequency|impedance|cooling|insulation|wattage|conductor|weight|dimensions?|size)\b/i;
/** What kind of document this is, from its contents. */
export function classifyDocument(layout) {
  const labels = kvs(layout).map(k => k.label.toLowerCase());
  const headings = [layout.title, ...layout.sections.map(s => s.heading)].filter(Boolean).join(' \n ').toLowerCase();
  if (labels.some(l => /^(inspection|examination|survey) date/.test(l)) || /\b(inspection|examination) report\b|\bcondition inspection\b|\bthorough examination\b/.test(headings)) return DOC_TYPE.INSPECTION;
  if (labels.some(l => /^test date/.test(l)) || /\btest (report|certificate)\b|\bcommissioning tests?\b/.test(headings)) return DOC_TYPE.TEST_REPORT;
  if (/\b(maintenance (report|record|log)|work order|service (report|record)|repair report)\b/.test(headings)) return DOC_TYPE.MAINTENANCE;
  if (/\b(asset sheet|data ?sheet|specification|nameplate|technical data)\b/.test(headings) || labels.filter(l => SPEC_HINT.test(l)).length >= 3) return DOC_TYPE.TECHNICAL_SPECIFICATION;
  return DOC_TYPE.OTHER;
}

/**
 * One document, normalised: its identity and dates kept apart, its type, its layout and how it was read.
 * @param {object} record the ACC index record (documentId, fileName, accVersionId, versionNumber, lastModifiedTime…)
 * @param {object} extraction from extractPdfText
 */
export function normalizeDocument(record, extraction, { assetId } = {}) {
  const layout = extraction.status === 'FAILED' ? { title: null, banners: [], sections: [] } : layoutDocument(extraction);
  const base = {
    documentId: record.documentId, assetId: assetId ?? record.mapping?.assetId ?? null, fileName: record.fileName,
    title: layout.title ?? extraction.metadata?.title ?? record.fileName, source: 'ACC',
    version: { versionNumber: record.versionNumber ?? null, accVersionId: record.accVersionId ?? null },
    uploadedAt: record.createTime ?? null, accModifiedAt: record.lastModifiedTime ?? null,
    pdfCreatedAt: extraction.metadata?.createdAt ?? null, webViewUrl: record.webViewUrl ?? null,
    pageCount: extraction.pageCount ?? 0, pages: (extraction.pages ?? []).map(p => ({ page: p.page, status: p.status })),
    extractionStatus: extraction.status, errors: extraction.errors ?? [],
  };
  if (extraction.status === 'FAILED') return { ...base, documentType: null, inspectionDate: null, revisionDate: null, layout, caveats: [] };
  const docType = classifyDocument(layout);
  const date = findKv(layout, /^(inspection|examination|survey) date$|^date of (inspection|examination)$/i);
  const revision = findKv(layout, /^(revision|rev\.?)( date)?$|^issue date$|^report date$/i);
  const doc = { ...base, documentType: docType, layout,
    inspectionDate: docType === DOC_TYPE.INSPECTION || docType === DOC_TYPE.TEST_REPORT ? documentDate(date?.value) : null,
    revisionDate: documentDate(revision?.value) };
  // What the document says about itself ("illustrative", "not as-built"): shown with its findings.
  const caveatRe = /\b(illustrative|not as-built|not a real|demo(nstration)? (data|document)|mock)\b/i;
  const caveats = [];
  for (const b of layout.banners) if (caveatRe.test(b.text)) caveats.push({ text: b.text, citation: cite(doc, b, 'Page banner') });
  for (const k of kvs(layout)) if (/data ?status/i.test(k.label) && caveatRe.test(k.value)) caveats.push({ text: `${k.label}: ${k.value}`, citation: cite(doc, k, k.section) });
  doc.caveats = caveats.slice(0, 3);
  // The asset the document states it is about, to refuse another asset's documents.
  // The element's own id: its Network ID first (a crane's steel shares the crane's Tag), then its tag.
  const stated = findKv(layout, /^network ?id$/i) ?? findKv(layout, /^(asset id|asset id \(tag\)|tag|equipment id)$/i);
  const globalId = findKv(layout, /^ifc globalid$/i);
  doc.statedAssetId = stated?.value?.split(/\s/)[0] ?? null;
  doc.statedGlobalId = globalId?.value ?? null;
  return doc;
}

// ---- asset categories and specification fields ----

/** The asset's category, from its IFC class and type (what fields make sense for it). */
export function categoryOf(asset = {}) {
  const t = `${asset.ifcClass ?? ''} ${asset.assetType ?? ''} ${asset.name ?? ''}`.toLowerCase();
  if (/transformer/.test(t)) return 'transformer';
  if (/crane|transportelement/.test(t)) return 'crane';
  if (/protectivedevice|breaker/.test(t)) return 'breaker';
  if (/switchingdevice|switch\b|isolator/.test(t)) return 'switch';
  if (/distributionboard|switchgear|rmu|ring main|panel/.test(t)) return 'switchgear';
  if (/cable|fibre|fiber/.test(t)) return 'cable';
  if (/light|lamp|mast/.test(t)) return 'light';
  if (/generator/.test(t)) return 'generator';
  return 'generic';
}

const ALL = null;
/** Specification fields: label patterns (as documents write them) and which categories they belong to. */
export const SPEC_FIELDS = [
  { key: 'manufacturer', label: 'Manufacturer', re: /^(manufacturer|make|maker|vendor)$/i, cats: ALL },
  { key: 'model', label: 'Model', re: /^(model( number| no\.?)?|type designation|product model)$/i, cats: ALL },
  { key: 'serial', label: 'Serial number', re: /^serial( number| no\.?)?$/i, cats: ALL },
  { key: 'ratedPower', label: 'Rated power', re: /^(rated (power|capacity|apparent power)|maximum ?apparent ?power|(kva|mva) rating|nameplate (kva|mva))$/i, unit: 'apparentPower', cats: ['transformer', 'generator', 'switchgear'] },
  { key: 'capacityKw', label: 'Real power capacity', re: /^capacity ?kw$|^(real power|active power) capacity$|^rated output$/i, unit: 'realPower', cats: ALL },
  { key: 'primaryVoltage', label: 'Primary voltage', re: /^(primary|hv) ?voltage$/i, unit: 'voltage', cats: ['transformer'] },
  { key: 'secondaryVoltage', label: 'Secondary voltage', re: /^(secondary|lv) ?voltage$/i, unit: 'voltage', cats: ['transformer'] },
  { key: 'rating', label: 'Rating (as written)', re: /^(rating|nameplate rating)$/i, cats: ALL },
  { key: 'voltageLevel', label: 'Voltage', re: /^(voltage ?level|rated voltage|nominal voltage|voltage class|system voltage|supply voltage|voltage)$/i, unit: 'voltage', cats: ALL },
  { key: 'ratedCurrent', label: 'Rated current', re: /^(rated|nominal) current$/i, unit: 'current', cats: ['breaker', 'switch', 'switchgear', 'cable', 'generic'] },
  { key: 'interrupting', label: 'Interrupting capacity', re: /^((interrupting|breaking|short[- ]circuit breaking) (capacity|current|rating))$/i, cats: ['breaker', 'switchgear'] },
  { key: 'trip', label: 'Trip characteristics', re: /^trip( unit| characteristics?| curve| settings?)?$/i, cats: ['breaker'] },
  { key: 'frequency', label: 'Frequency', re: /^(rated )?frequency$/i, cats: ALL },
  { key: 'phases', label: 'Phases', re: /^(phases?|phase configuration|number of phases)$/i, cats: ALL },
  { key: 'vectorGroup', label: 'Vector group', re: /^vector group$/i, cats: ['transformer'] },
  { key: 'cooling', label: 'Cooling', re: /^cooling( method| class| type)?$/i, cats: ['transformer', 'generator'] },
  { key: 'insulation', label: 'Insulation', re: /^insulation( type| class| rating| medium)?$/i, cats: ALL },
  { key: 'impedance', label: 'Impedance', re: /^((percent |%)?impedance( voltage)?( \(%\))?|uk ?%?)$/i, cats: ['transformer'] },
  { key: 'conductor', label: 'Conductor', re: /^conductor( material)?$/i, cats: ['cable'] },
  { key: 'crossSection', label: 'Cross-section', re: /^(cross[- ]?section(al area)?|conductor size)$/i, cats: ['cable'] },
  { key: 'wattage', label: 'Wattage', re: /^(wattage|lamp power|rated wattage)$/i, cats: ['light'] },
  { key: 'fixture', label: 'Fixture type', re: /^(fixture|luminaire)( type)?$/i, cats: ['light'] },
  { key: 'ratedLoad', label: 'Rated load', re: /^(safe working load|swl|rated load|lifting capacity)$/i, cats: ['crane'] },
  { key: 'dimensions', label: 'Dimensions', re: /^(overall size|dimensions)\b/i, cats: ALL },
  { key: 'weight', label: 'Weight', re: /^(total |shipping |operating )?(weight|mass)\b/i, cats: ALL },
  { key: 'installDate', label: 'Installation date', re: /^(install(ation|ed)( date)?|date installed|year of installation)$/i, cats: ALL },
  { key: 'commissionDate', label: 'Commissioning date', re: /^commission(ing|ed)( date)?$/i, cats: ALL },
  { key: 'standards', label: 'Standards', re: /^(standards?|complies with|design standard)$/i, cats: ALL },
];
/** The fields a replacement needs per category; each is shown, as "Not documented" if no document has it. */
export const KEY_FIELDS = {
  transformer: ['manufacturer', 'model', 'serial', 'ratedPower', 'primaryVoltage', 'secondaryVoltage', 'frequency', 'vectorGroup', 'impedance', 'cooling', 'dimensions', 'weight', 'installDate'],
  crane: ['manufacturer', 'model', 'ratedLoad', 'voltageLevel', 'capacityKw', 'installDate'],
  breaker: ['manufacturer', 'model', 'voltageLevel', 'ratedCurrent', 'interrupting', 'trip'],
  switch: ['manufacturer', 'model', 'voltageLevel', 'ratedCurrent'],
  switchgear: ['manufacturer', 'model', 'voltageLevel', 'ratedCurrent', 'interrupting'],
  cable: ['conductor', 'crossSection', 'insulation', 'voltageLevel'],
  light: ['manufacturer', 'fixture', 'wattage', 'voltageLevel', 'installDate'],
  generator: ['manufacturer', 'model', 'serial', 'ratedPower', 'voltageLevel', 'frequency', 'cooling', 'installDate'],
  generic: ['manufacturer', 'model', 'serial', 'voltageLevel', 'installDate'],
};
const fieldsFor = cat => SPEC_FIELDS.filter(f => !f.cats || f.cats.includes(cat));
const NON_SPEC_GROUP = /status/i;
export const CONDITION_LABEL = /condition|assessment|recommended action|^description$|^remarks?$/i;
const NON_SPEC_LABEL = /^(data ?status|status(flag|colour|color|date)?|sourceref|network ?id|asset id|ifc |name$|local x|latitude|maryland|positional accuracy|located in|part of|connection ports|systems|supply path)/i;

const UNIT = { v: ['voltage', 1], kv: ['voltage', 1e3], mv: ['voltage', 1e6], va: ['apparentPower', 1], kva: ['apparentPower', 1e3], mva: ['apparentPower', 1e6],
  w: ['realPower', 1], kw: ['realPower', 1e3], mw: ['realPower', 1e6], a: ['current', 1], ka: ['current', 1e3], hz: ['frequency', 1] };
/** "34,500 V" → {kind: 'voltage', si: 34500}; a bare number takes the unit its label states ("CapacitykW"). */
export function quantity(value, label = '') {
  const m = /^\s*([<>~≈]?)\s*(-?[\d,]*\.?\d+)\s*(mva|kva|va|kv|mv|v|mw|kw|w|ka|a|hz)?\b/i.exec(String(value ?? ''));
  if (!m) return null;
  const unit = (m[3] ?? /(mva|kva|kv|kw|mw|hz)\)?$/i.exec(label.replace(/\s+/g, ''))?.[1] ?? '').toLowerCase();
  if (!UNIT[unit]) return null;
  const [kind, factor] = UNIT[unit];
  return { kind, si: Number(m[2].replace(/,/g, '')) * factor };
}
/**
 * A quantity for reading: 12,000,000 VA → "12 MVA", 34,500 V → "34.5 kV", 11,000 kW → "11 MW". Apparent power
 * (VA) and real power (W) keep their own units; the extracted value stays the source of record.
 */
export function formatQuantity(q) {
  if (!q || !Number.isFinite(q.si)) return null;
  const steps = { voltage: [[1e6, 'MV'], [1e3, 'kV'], [1, 'V']], apparentPower: [[1e6, 'MVA'], [1e3, 'kVA'], [1, 'VA']], realPower: [[1e6, 'MW'], [1e3, 'kW'], [1, 'W']],
    current: [[1e3, 'kA'], [1, 'A']], frequency: [[1, 'Hz']] }[q.kind];
  if (!steps) return null;
  const [factor, unit] = steps.find(([f]) => Math.abs(q.si) >= f) ?? steps.at(-1);
  const n = q.si / factor;
  return `${Number(n.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 3 })} ${unit}`;
}
const sameValue = (a, b) => (a.q && b.q && a.q.kind === b.q.kind ? Math.abs(a.q.si - b.q.si) <= Math.max(Math.abs(a.q.si), Math.abs(b.q.si)) * 0.005
  : a.value.trim().toLowerCase().replace(/\s+/g, ' ') === b.value.trim().toLowerCase().replace(/\s+/g, ' '));

/**
 * Documented specifications: key fields (or "Not documented"), more fields, and conflicts.
 * Specification documents are the source; inspection reports that restate a rating are kept as a second
 * source, so a disagreement between them is seen.
 */
export function extractSpecifications(docs, category) {
  const fields = fieldsFor(category);
  const values = new Map();
  const add = (key, entry) => { if (!values.has(key)) values.set(key, []); values.get(key).push(entry); };
  const more = [];
  for (const doc of docs) {
    if (!doc.layout || doc.extractionStatus === 'FAILED') continue;
    const isSpec = doc.documentType === DOC_TYPE.TECHNICAL_SPECIFICATION;
    for (const s of doc.layout.sections) for (const k of s.kv) {
      if (k.badge || !k.value) continue;
      const label = k.label.replace(/[.:]+$/, '').trim();
      const field = fields.find(f => f.re.test(label));
      const citation = cite(doc, k, [s.heading, k.group].filter(Boolean).join(' · ') || null);
      if (field && (isSpec || /rating|voltage|power|capacity/i.test(field.key))) {
        add(field.key, { value: k.value, q: field.unit ? quantity(k.value, label) : null, label, citation, primary: isSpec });
        // A rating written as "34.5/13.8 kV, 12 MVA" also states the voltages and the power.
        if (field.key === 'rating' && category === 'transformer') {
          const volts = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*kV/i.exec(k.value);
          const power = /(\d+(?:\.\d+)?)\s*(MVA|kVA)\b/i.exec(k.value);
          const derived = `read from "${label}: ${k.value}"`;
          if (volts) {
            add('primaryVoltage', { value: `${volts[1]} kV`, q: quantity(`${volts[1]} kV`), label, citation, primary: isSpec, derived });
            add('secondaryVoltage', { value: `${volts[2]} kV`, q: quantity(`${volts[2]} kV`), label, citation, primary: isSpec, derived });
          }
          if (power) add('ratedPower', { value: `${power[1]} ${power[2]}`, q: quantity(`${power[1]} ${power[2]}`), label, citation, primary: isSpec, derived });
        }
      } else if (isSpec && !NON_SPEC_GROUP.test(k.group ?? '') && !NON_SPEC_LABEL.test(label) && !CONDITION_LABEL.test(label) && !/location|geometry/i.test(s.heading ?? '')) {
        more.push({ label, value: k.value, citation });
      }
    }
  }
  const out = {};
  for (const f of fields) {
    const list = values.get(f.key);
    if (!list?.length) continue;
    // One entry per distinct value; each keeps all the places that state it.
    const distinct = [];
    // A specification sheet before a report restating it; a value stated as such before one read out of a rating.
    for (const v of list.sort((a, b) => Number(b.primary) - Number(a.primary) || Number(Boolean(a.derived)) - Number(Boolean(b.derived)))) {
      const same = distinct.find(d => sameValue(d, v));
      if (same) same.sources.push({ ...v.citation, derived: v.derived ?? null }); else distinct.push({ value: v.value, q: v.q, sources: [{ ...v.citation, derived: v.derived ?? null }] });
    }
    // `display` is for reading only (12 MVA); `value` is what the document wrote.
    const shown = distinct.map(d => ({ value: d.value, display: formatQuantity(d.q) ?? d.value, sources: d.sources }));
    out[f.key] = { key: f.key, label: f.label, value: distinct[0].value, display: shown[0].display, unitKind: distinct[0].q?.kind ?? null, values: shown,
      conflict: distinct.length > 1, source: distinct[0].sources[0] };
  }
  const keyFields = (KEY_FIELDS[category] ?? KEY_FIELDS.generic).map(k => out[k] ?? { key: k, label: SPEC_FIELDS.find(f => f.key === k).label, value: NOT_DOCUMENTED, values: [], conflict: false, source: null, missing: true });
  const extra = Object.values(out).filter(f => !keyFields.some(k => k.key === f.key));
  return {
    category, keyFields, otherFields: [...extra, ...more.filter(m => !Object.values(out).some(o => o.values.some(v => v.sources.some(s => s.evidenceText === m.citation.evidenceText))))
      .map(m => ({ key: null, label: m.label, value: m.value, values: [{ value: m.value, sources: [m.citation] }], conflict: false, source: m.citation }))],
    conflicts: Object.values(out).filter(f => f.conflict),
    missing: keyFields.filter(f => f.missing).map(f => f.label),
  };
}

// ---- inspections ----

const SEVERITY = { OK: 0, ATTENTION: 1, DEFECT: 2 };
export function resultSeverity(result) {
  const r = String(result ?? '').trim().toLowerCase();
  if (/^(ok|pass(ed)?|satisfactory|good|acceptable|no defects?|within limits?|serviceable|compliant)$/.test(r)) return 'OK';
  if (/^(attention|monitor|observe|minor|advisory|watch|fair|marginal)$/.test(r)) return 'ATTENTION';
  if (/^(defect|fail(ed)?|poor|unsatisfactory|action required|major|critical|unsafe|not ok|reject(ed)?)$/.test(r)) return 'DEFECT';
  return null;
}
const RESULT_COL = /^(result|status|condition|outcome|finding|assessment)$/i;
const ITEM_COLS = /^(area|item|component|element|check|description|system|part)$/i;
const NOTE_COL = /^(notes?|remarks?|comments?|observations?|details?|findings?)$/i;
const ACTION_COL = /^(action|recommended action|recommendation|corrective action|task|work)s?$/i;
const MEASURE_NAME = /^(test|gas|parameter|measurement|reading|quantity)$/i;
const VALUE_COL = /^(result|value|reading|measured|measurement)$/i;

/** "Poor (2 of 5; …)", "FAIR (3/5)" → {label: 'Poor', score: 2, scale: 5}. */
export function conditionOf(text) {
  const t = String(text ?? '');
  const label = /^\s*([A-Za-z][A-Za-z -]*?)\s*(\(|$|,|;)/.exec(t)?.[1]?.trim();
  const score = /\((\d+(?:\.\d+)?)\s*(?:\/|of)\s*(\d+)/i.exec(t);
  if (!label && !score) return null;
  return { label: label ? label[0].toUpperCase() + label.slice(1).toLowerCase() : null, score: score ? Number(score[1]) : null, scale: score ? Number(score[2]) : null };
}
const numberOf = text => {
  const m = /^\s*([<>])?\s*(-?\d[\d,]*\.?\d*)\s*$/.exec(String(text ?? ''));
  return m ? { value: Number(m[2].replace(/,/g, '')), censored: m[1] ?? null, text: String(text).trim() } : null;
};

/** "(kV, 2 mm gap)" → "kV"; "(H2)" is a chemical formula, not a unit. */
function unitOf(name) {
  const inner = /\(([^)]*)\)\s*$/.exec(name)?.[1]?.split(',')[0]?.trim();
  if (!inner || /^[A-Z][A-Z0-9]*$/.test(inner) || /^[A-Z][a-z]?\d/.test(inner)) return null;
  return inner;
}

/** One inspection report's contents. */
export function extractInspection(doc) {
  const { layout } = doc;
  const kv = re => findKv(layout, re);
  const k = (re, section) => { const f = kv(re); return f ? { value: f.value, citation: cite(doc, f, f.section ?? section) } : null; };
  const conditionKv = kv(/^(overall condition|condition rating|condition|asset condition)$/i);
  const inspection = {
    documentId: doc.documentId, fileName: doc.fileName, title: doc.title, version: doc.version?.versionNumber ?? null,
    inspectionDate: doc.inspectionDate, dateCitation: (() => { const d = kv(/^(inspection|examination|survey) date$|^date of (inspection|examination)$/i); return d ? cite(doc, d, d.section) : null; })(),
    reportNumber: k(/^report (number|no\.?|id|reference)$/i)?.value ?? null,
    type: k(/^(inspection|examination) type$|^type of (inspection|examination)$/i),
    inspector: k(/^(inspector|inspected by|examiner)$/i), reviewer: k(/^(reviewed by|reviewer|approved by)$/i),
    conditions: k(/^(conditions|weather|ambient( conditions)?)$/i), operatingState: k(/^(operating state|load at inspection|operating condition)$/i),
    condition: conditionKv ? { ...conditionOf(conditionKv.value), text: conditionKv.value, citation: cite(doc, conditionKv, conditionKv.section) } : null,
    nextDue: k(/^next (inspection|examination) due$/i), reportStatus: k(/^report status$/i),
    interval: k(/^(inspection|examination) (interval|frequency|cycle)$|^frequency of (inspection|examination)$/i),
    summary: [], restrictions: [], findings: [], measurements: [], observations: [], actions: [],
  };
  for (const s of layout.sections) {
    const heading = s.heading ?? '';
    for (const kvRow of s.kv) if (/restriction|limitation/i.test(kvRow.label)) inspection.restrictions.push({ text: kvRow.value, citation: cite(doc, kvRow, heading) });
    if (/^(summary|conclusions?|overview|executive summary)$/i.test(heading)) {
      for (const p of s.paragraphs) inspection.summary.push({ text: p.text, citation: cite(doc, { page: p.page, text: p.text }, heading) });
    } else if (!s.tables.length) {
      for (const p of s.paragraphs) {
        if (/^(all names|this document|illustrative)/i.test(p.text)) continue;
        let prev = null;
        for (const sentence of sentences(p.text)) {
          const severity = /\b(serious|severe|critical|major)\b/i.test(sentence) ? 'DEFECT' : /\b(minor|slight)\b/i.test(sentence) ? 'ATTENTION' : null;
          // A bare grading ("Serious.") qualifies the sentence before it; it is not a finding of its own.
          if (prev && sentence.trim().split(/\s+/).length < 3) {
            prev.text = `${prev.text} ${sentence}`;
            prev.severity = severity ?? prev.severity;
            prev.citation = cite(doc, { page: p.page, text: prev.text }, heading);
            continue;
          }
          prev = { topic: heading || null, text: sentence, severity, citation: cite(doc, { page: p.page, text: sentence }, heading) };
          inspection.observations.push(prev);
        }
      }
    } else {
      for (const p of s.paragraphs) if (/^interpretation\b/i.test(p.text)) inspection.observations.push({ topic: heading, text: p.text, severity: null, interpretation: true, citation: cite(doc, { page: p.page, text: p.text }, heading) });
    }
    for (const t of s.tables) {
      const names = t.columns.map(c => c.name.trim());
      const resultCol = names.find(n => RESULT_COL.test(n));
      const actionCol = names.find(n => ACTION_COL.test(n));
      const itemCols = names.filter(n => ITEM_COLS.test(n));
      const noteCol = names.find(n => NOTE_COL.test(n));
      if (actionCol) {
        const priority = names.find(n => /^(priority|urgency|severity)$/i.test(n));
        const due = names.find(n => /^(due|due date|target date|by)$/i.test(n));
        const status = names.find(n => /^(status|state|closed|completed)$/i.test(n));
        for (const r of t.rows) if (r.cells[actionCol]) inspection.actions.push({ action: r.cells[actionCol], priority: priority ? r.cells[priority] ?? null : null, due: due ? documentDate(r.cells[due]) ?? r.cells[due] ?? null : null,
          status: status ? r.cells[status] ?? null : null, citation: cite(doc, r, heading) });
        continue;
      }
      const resultsAreWords = resultCol && t.rows.some(r => resultSeverity(r.cells[resultCol]));
      if (resultCol && resultsAreWords) {
        for (const r of t.rows) {
          const item = (itemCols.length ? itemCols : [names[0]]).map(c => r.cells[c]).filter(Boolean).join(' — ');
          if (!item) continue;
          inspection.findings.push({ item, result: r.cells[resultCol] ?? null, severity: resultSeverity(r.cells[resultCol]), notes: noteCol ? r.cells[noteCol] ?? null : null,
            topic: heading, citation: cite(doc, r, heading) });
        }
        continue;
      }
      // Measurements: a name column and numeric values (this report's result, a previous one, or dated columns).
      const nameCol = names.find(n => MEASURE_NAME.test(n)) ?? names[0];
      const valueCol = names.find(n => VALUE_COL.test(n));
      const prevCol = names.find(n => /^previous/i.test(n));
      const dated = names.filter(n => documentDate(n) && n !== nameCol);
      const unitOfSection = /\(([^)]+)\)\s*$/.exec(heading)?.[1] ?? null;
      for (const r of t.rows) {
        const name = r.cells[nameCol];
        if (!name) continue;
        const points = [];
        if (valueCol && numberOf(r.cells[valueCol])) points.push({ date: doc.inspectionDate, ...numberOf(r.cells[valueCol]) });
        if (prevCol && numberOf(r.cells[prevCol])) points.push({ date: documentDate(prevCol) ?? null, previous: true, ...numberOf(r.cells[prevCol]) });
        for (const d of dated) if (numberOf(r.cells[d])) points.push({ date: documentDate(d), ...numberOf(r.cells[d]) });
        if (!points.length) continue;
        inspection.measurements.push({ name, unit: unitOf(name) ?? unitOfSection, topic: heading, points, citation: cite(doc, r, heading) });
      }
    }
  }
  return inspection;
}

// ---- trends between reports ----

const itemKey = item => String(item).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// The usual reading of common condition tests: which way is worse. Used to call a change worsening or improving
// (labelled as derived), never to judge a single value.
const HIGHER_IS_WORSE = /moisture|water content|acidity|power factor|dissipation|tan ?δ|hydrogen|methane|ethane|ethylene|acetylene|carbon (mon|di)oxide|combustible gas|tdcg|turns ratio deviation|temperature rise|broken wires|wear|vibration|partial discharge/i;
const HIGHER_IS_BETTER = /dielectric breakdown|breakdown voltage|interfacial tension|insulation resistance|polari[sz]ation index/i;

/**
 * Compare a single asset's dated inspections: findings by item, measurements by name, the condition score,
 * and whether each action was later documented as done.
 */
export function compareInspections(inspections) {
  const dated = inspections.filter(i => i.inspectionDate).sort((a, b) => a.inspectionDate.localeCompare(b.inspectionDate));
  const undated = inspections.filter(i => !i.inspectionDate);
  const out = { reports: dated.length, undated: undated.map(i => ({ documentId: i.documentId, fileName: i.fileName })), findings: [], measurements: [], condition: null, actions: [], caveats: [] };
  if (!dated.length) return out;
  const latest = dated.at(-1);
  // Findings by item.
  const items = new Map();
  for (const ins of dated) for (const f of ins.findings) {
    const key = itemKey(f.item);
    if (!items.has(key)) items.set(key, { item: f.item, history: [] });
    items.get(key).history.push({ date: ins.inspectionDate, result: f.result, severity: f.severity, notes: f.notes, citation: f.citation });
  }
  for (const { item, history } of items.values()) {
    if (!history.some(h => h.severity && h.severity !== 'OK')) continue;
    const last = history.at(-1);
    const inLatest = last.date === latest.inspectionDate;
    const earlier = history.filter(h => h !== last);
    const earlierBad = earlier.filter(h => h.severity && h.severity !== 'OK');
    let trend;
    let basis;
    if (!inLatest) { trend = TREND.INSUFFICIENT_EVIDENCE; basis = `Recorded on ${earlierBad.at(-1)?.date ?? last.date}, not recorded in the latest report (${latest.inspectionDate}).`; }
    else if (last.severity === 'OK') { trend = TREND.RESOLVED_WITH_EVIDENCE; basis = `Recorded ${earlierBad.at(-1).result} on ${earlierBad.at(-1).date}; recorded OK on ${last.date}.`; }
    else if (dated.length === 1) { trend = TREND.INSUFFICIENT_EVIDENCE; basis = 'Only one dated inspection report: no earlier record to compare with.'; }
    else if (earlierBad.length) {
      const prevBad = earlierBad.at(-1);
      trend = SEVERITY[last.severity] > SEVERITY[prevBad.severity] ? TREND.WORSENING_WITH_EVIDENCE : SEVERITY[last.severity] < SEVERITY[prevBad.severity] ? TREND.IMPROVING_WITH_EVIDENCE : TREND.RECURRING_FINDING;
      basis = `${prevBad.result} on ${prevBad.date}, ${last.result} on ${last.date}.`;
    } else if (earlier.length) { trend = TREND.NEW_FINDING; basis = `Recorded OK on ${earlier.at(-1).date}; ${last.result} on ${last.date}.`; }
    else { trend = TREND.NEW_FINDING; basis = `First recorded on ${last.date}; earlier reports do not list this item.`; }
    out.findings.push({ item, trend, recurring: earlierBad.length > 0 && inLatest && last.severity !== 'OK', basis, latest: last, history });
  }
  // Measurements by name: every dated value any report gives, the report's own result first.
  const series = new Map();
  for (const ins of dated) for (const m of ins.measurements) {
    const key = itemKey(m.name);
    if (!series.has(key)) series.set(key, { name: m.name, unit: m.unit, topic: m.topic ?? null, points: new Map() });
    const s = series.get(key);
    for (const p of m.points) {
      if (!p.date) continue;
      const own = p.date === ins.inspectionDate;
      const prev = s.points.get(p.date);
      if (!prev || (own && !prev.own)) s.points.set(p.date, { date: p.date, value: p.value, censored: p.censored, text: p.text, own, citation: m.citation });
    }
  }
  for (const s of series.values()) {
    const points = [...s.points.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (points.length < 2) continue;
    const [first, last] = [points.at(-2), points.at(-1)];
    const up = last.value > first.value && !(first.censored === '>' ) && !(last.censored === '<');
    const down = last.value < first.value && !(first.censored === '<') && !(last.censored === '>');
    const direction = HIGHER_IS_WORSE.test(s.name) ? 'higherWorse' : HIGHER_IS_BETTER.test(s.name) ? 'higherBetter' : null;
    let trend = TREND.INSUFFICIENT_EVIDENCE;
    if (direction && (up || down)) trend = (up === (direction === 'higherWorse')) ? TREND.WORSENING_WITH_EVIDENCE : TREND.IMPROVING_WITH_EVIDENCE;
    out.measurements.push({ name: s.name, unit: s.unit, topic: s.topic, trend, direction, points, change: { from: first.text, to: last.text, fromDate: first.date, toDate: last.date },
      basis: direction ? `${first.text} → ${last.text}${s.unit ? ` ${s.unit}` : ''} (${first.date} → ${last.date}); ${direction === 'higherWorse' ? 'a higher value is usually worse' : 'a lower value is usually worse'} for this test (derived).`
        : `${first.text} → ${last.text} (${first.date} → ${last.date}); which direction is a concern is not stated.` });
  }
  // Differing test conditions: said with the comparison.
  const cond = dated.filter(i => i.conditions || i.operatingState);
  if (cond.length >= 2) {
    const texts = cond.map(i => `${i.inspectionDate}: ${[i.conditions?.value, i.operatingState?.value].filter(Boolean).join('; ')}`);
    if (new Set(cond.map(i => i.conditions?.value ?? '')).size > 1 || new Set(cond.map(i => i.operatingState?.value ?? '')).size > 1) {
      out.caveats.push({ text: `Reports were made under different conditions, so measurements are not strictly comparable (${texts.join(' · ')}).`, citations: cond.map(i => i.conditions?.citation ?? i.operatingState?.citation).filter(Boolean) });
    }
  }
  // Condition score.
  const scored = dated.filter(i => i.condition?.score !== null && i.condition?.score !== undefined);
  if (scored.length >= 2) {
    const [a, b] = [scored.at(-2), scored.at(-1)];
    out.condition = { trend: b.condition.score < a.condition.score ? TREND.WORSENING_WITH_EVIDENCE : b.condition.score > a.condition.score ? TREND.IMPROVING_WITH_EVIDENCE : TREND.RECURRING_FINDING,
      from: { date: a.inspectionDate, ...pick(a.condition) }, to: { date: b.inspectionDate, ...pick(b.condition) }, history: scored.map(i => ({ date: i.inspectionDate, ...pick(i.condition) })) };
  }
  // Actions: closure only with a later document saying so.
  for (let n = 0; n < dated.length; n += 1) {
    const ins = dated[n];
    const later = dated.slice(n + 1);
    for (const a of ins.actions) out.actions.push({ ...a, raisedOn: ins.inspectionDate, raisedIn: ins.documentId, inLatest: ins === latest, closure: closureOf(a, ins, later) });
  }
  return out;
}
const pick = c => ({ label: c.label, score: c.score, scale: c.scale, citation: c.citation });

const STOP = new Set('the and for with from into onto that this then than are was were has have had its not any all per at on in of to a an be by or as is it next new check plan prepare consider'.split(' '));
const tokens = text => String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(t => t && !STOP.has(t) && (t.length > 2 || /\d/.test(t)));
/** Text lines of a report that could speak to an action: findings, notes, summary and observations. */
function statementsOf(ins) {
  return [
    ...ins.summary.flatMap(s => sentences(s.text).map(text => ({ text, citation: { ...s.citation, evidenceText: text } }))),
    ...ins.findings.map(f => ({ text: `${f.item}: ${f.notes ?? ''}`, citation: f.citation })),
    ...ins.observations.map(o => ({ text: o.text, citation: o.citation })),
    ...ins.actions.map(a => ({ text: a.action, citation: a.citation, isAction: true })),
  ];
}
/** Clauses of a sentence, so "X is leaking and fan 4 is still out" does not say "still" about X. */
const clauses = text => String(text).split(/[;,]\s+|\s+and\s+(?=(the|a|an|fan|no)\b)|\.\s+/i).filter(c => c && !/^(the|a|an|fan|no)$/i.test(c));
const REPAIR = /\b(repair|replace|fix|rectify|renew|torque|tighten|reseal|re-?gasket|overhaul|refurbish)\w*/i;
const NOT_DONE = /\b(not (been )?(completed|carried out|done|implemented|repaired|replaced|fixed|actioned)|still|remains?|outstanding|again|recurr\w*|repeat(ed)?)\b/i;
const DONE = /\b(replaced|repaired|completed|fixed|rectified|renewed|resolved|carried out|done)\b/i;
function closureOf(action, ins, later) {
  if (action.status) {
    if (/^(closed|completed?|done)$/i.test(action.status.trim())) return { status: CLOSURE.COMPLETED_WITH_EVIDENCE, basis: `Marked "${action.status}" in the report that raised it.`, citation: action.citation };
  }
  const words = tokens(action.action);
  const year = ins.inspectionDate?.slice(0, 4);
  for (const rep of later) {
    for (const st of statementsOf(rep)) {
      if (st.isAction) continue;
      // A general statement about the earlier report's actions ("The 2025 repair actions were not completed").
      const refersToReport = (year && new RegExp(`\\b${year}\\b`).test(st.text) || (ins.reportNumber && st.text.includes(ins.reportNumber))) && /\b(actions?|repairs?|recommendations?|work)\b/i.test(st.text);
      // "Repair actions were not completed" speaks for repairs only; "actions were not completed" for all of them.
      const repairsOnly = /\brepairs?\b|\brepair actions?\b/i.test(st.text);
      if (refersToReport && /\bnot (been )?(completed|carried out|done|implemented)|outstanding|remain(s|ed)? open\b/i.test(st.text) && (!repairsOnly || REPAIR.test(action.action))) {
        return { status: CLOSURE.NOT_COMPLETED_WITH_EVIDENCE, basis: `The ${rep.inspectionDate} report states: "${st.text}"`, citation: st.citation };
      }
      for (const clause of clauses(st.text)) {
        const overlap = tokens(clause).filter(t => words.includes(t));
        if (overlap.filter(t => !/^\d+$/.test(t)).length < 1 || overlap.length < 2) continue;
        if (NOT_DONE.test(clause)) return { status: CLOSURE.NOT_COMPLETED_WITH_EVIDENCE, basis: `The ${rep.inspectionDate} report records: "${st.text}"`, citation: st.citation };
        if (DONE.test(clause) && !/\bnot\b/i.test(clause)) return { status: CLOSURE.COMPLETED_WITH_EVIDENCE, basis: `The ${rep.inspectionDate} report records: "${st.text}"`, citation: st.citation };
      }
    }
  }
  return { status: CLOSURE.NOT_VERIFIED, basis: later.length ? 'No later document records whether it was done.' : 'Raised in the latest report; no later document yet.', citation: null };
}

// ---- the analysis ----

/**
 * What the documents linked to an asset say. `docs` are normalised documents (normalizeDocument), all linked
 * to this asset; `failures` are linked documents that could not be read at all (access, download, not a PDF).
 */
export function analyzeAssetDocuments({ asset, docs, failures = [], analysisType = ANALYSIS.REPLACEMENT_READINESS, modelVersion = null }) {
  const category = categoryOf(asset);
  // A document that states it is about another asset is not used for this one.
  const mismatched = docs.filter(d => d.statedAssetId && asset.id && d.statedAssetId.toUpperCase() !== asset.id.toUpperCase() && d.statedAssetId.toUpperCase() !== `${asset.id}-STRUCT`.toUpperCase()
    && !(asset.id.endsWith('-STRUCT') && d.statedAssetId.toUpperCase() === asset.id.replace(/-STRUCT$/i, '').toUpperCase()));
  const usable = docs.filter(d => d.extractionStatus !== 'FAILED' && !mismatched.includes(d));
  const unreadable = docs.filter(d => d.extractionStatus === 'FAILED');
  const globalIdNotes = usable.filter(d => d.statedGlobalId && asset.globalId && d.statedGlobalId !== asset.globalId)
    .map(d => ({ documentId: d.documentId, fileName: d.fileName, text: `States IFC GlobalId ${d.statedGlobalId}; the model (${modelVersion ?? 'current version'}) has ${asset.globalId} for ${asset.id}.` }));

  const byType = t => usable.filter(d => d.documentType === t);
  const inspectionDocs = [...byType(DOC_TYPE.INSPECTION), ...byType(DOC_TYPE.TEST_REPORT)];
  const inspections = inspectionDocs.map(extractInspection);
  const comparison = compareInspections(inspections);
  // A crane's intake and its steel are linked to the same asset but are different elements: their values are
  // not compared with each other; the companion's are listed under its own id.
  const sameElement = d => !d.statedAssetId || d.statedAssetId.toUpperCase() === String(asset.id).toUpperCase();
  const specDocs = byType(DOC_TYPE.TECHNICAL_SPECIFICATION);
  const specs = extractSpecifications([...specDocs.filter(sameElement), ...inspectionDocs.filter(sameElement)], category);
  const companions = [...new Set(specDocs.filter(d => !sameElement(d)).map(d => d.statedAssetId))];
  for (const id of companions) {
    const other = extractSpecifications(specDocs.filter(d => d.statedAssetId === id), categoryOf({ ifcClass: id.endsWith('-STRUCT') ? 'IfcTransportElement' : asset.ifcClass }));
    for (const f of [...other.keyFields.filter(k => !k.missing), ...other.otherFields]) specs.otherFields.push({ ...f, key: null, label: `${f.label} (${id})`, companion: id });
  }

  // Condition statements in specification/asset sheets ("AssessmentCondition: Poor"): kept, but not as inspections.
  const conditionNotes = specDocs.flatMap(d => d.layout.sections.flatMap(sec => sec.kv.filter(k => !k.badge && CONDITION_LABEL.test(k.label) && k.value && !/not assessed/i.test(k.value))
    .map(k => ({ label: k.label.replace(/[.:]+$/, ''), value: k.value, citation: cite(d, k, [sec.heading, k.group].filter(Boolean).join(' · ') || null) }))));
  const timeline = [...inspections].sort((a, b) => (b.inspectionDate ?? '').localeCompare(a.inspectionDate ?? '')).map(ins => {
    const bad = ins.findings.filter(f => f.severity === 'DEFECT');
    const attention = ins.findings.filter(f => f.severity === 'ATTENTION');
    const summary = ins.summary[0] ? sentences(ins.summary[0].text) : [];
    return {
      documentId: ins.documentId, fileName: ins.fileName, version: ins.version, inspectionDate: ins.inspectionDate, dateCitation: ins.dateCitation,
      type: ins.type?.value ?? null, reportNumber: ins.reportNumber, inspector: ins.inspector?.value ?? null,
      condition: ins.condition, mainFinding: summary.length ? { text: summary.slice(0, 2).join(' '), citation: { ...ins.summary[0].citation, evidenceText: summary.slice(0, 2).join(' ') } }
        : bad[0] ? { text: `${bad[0].item}: ${bad[0].notes ?? bad[0].result}`, citation: bad[0].citation } : null,
      counts: { defects: bad.length, attention: attention.length, ok: ins.findings.filter(f => f.severity === 'OK').length, actions: ins.actions.length },
      findings: ins.findings.filter(f => f.severity && f.severity !== 'OK'), restrictions: ins.restrictions, actions: ins.actions, observations: ins.observations.filter(o => o.severity || o.interpretation),
      nextDue: ins.nextDue, interval: ins.interval, conditions: ins.conditions, operatingState: ins.operatingState, operatingLoad: operatingLoadOf(ins.operatingState),
      measurements: ins.measurements.map(m => ({ name: m.name, unit: m.unit, topic: m.topic, value: m.points.find(p => !p.previous && (!p.date || p.date === ins.inspectionDate))?.text ?? null, citation: m.citation })).filter(m => m.value !== null),
    };
  });
  const latest = timeline.find(t => t.inspectionDate) ?? null;

  // Outstanding: the latest report's findings, open actions, restrictions and worsening measurements.
  const outstanding = [];
  if (latest) {
    for (const f of latest.findings) {
      const trend = comparison.findings.find(c => itemKey(c.item) === itemKey(f.item));
      outstanding.push({ kind: 'FINDING', text: `${f.item}: ${f.notes ?? f.result}`, severity: f.severity, result: f.result, trend: trend?.trend ?? TREND.INSUFFICIENT_EVIDENCE,
        trendBasis: trend?.basis ?? null, status: 'Closure not verified', citation: f.citation, earlier: (trend?.history ?? []).filter(h => h.date !== f.citation && h.date !== latest.inspectionDate).map(h => h.citation) });
    }
    for (const r of latest.restrictions) outstanding.push({ kind: 'RESTRICTION', text: r.text, status: 'In force at the latest inspection', citation: r.citation });
  }
  for (const a of comparison.actions) {
    if (a.closure.status === CLOSURE.COMPLETED_WITH_EVIDENCE) continue;
    outstanding.push({ kind: 'ACTION', text: a.action, priority: a.priority, due: a.due, raisedOn: a.raisedOn, status: a.closure.status === CLOSURE.NOT_COMPLETED_WITH_EVIDENCE ? 'Not completed (documented)' : 'Closure not verified',
      closure: a.closure, citation: a.citation });
  }
  const worsening = comparison.measurements.filter(m => m.trend === TREND.WORSENING_WITH_EVIDENCE);

  const sources = docs.map(d => ({
    documentId: d.documentId, fileName: d.fileName, title: d.title, version: d.version?.versionNumber ?? null, documentType: d.documentType, webViewUrl: d.webViewUrl,
    status: mismatched.includes(d) ? 'NOT_USED_OTHER_ASSET' : d.extractionStatus, pageCount: d.pageCount, unreadablePages: d.pages.filter(p => p.status !== 'TEXT').map(p => p.page),
    inspectionDate: d.inspectionDate, accModifiedAt: d.accModifiedAt, errors: d.errors, statedAssetId: d.statedAssetId,
  }));
  for (const f of failures) sources.push({ documentId: f.documentId, fileName: f.fileName, title: f.fileName, version: f.versionNumber ?? null, documentType: null, webViewUrl: f.webViewUrl ?? null,
    status: f.code ?? 'FAILED', errors: [f.message], pageCount: 0, unreadablePages: [] });

  const result = {
    pipeline: ANALYSIS_PIPELINE, analysisType, modelVersion,
    asset: { id: asset.id, name: asset.name ?? null, ifcClass: asset.ifcClass ?? null, globalId: asset.globalId ?? null, category },
    documents: { linked: docs.length + failures.length, analysed: usable.length, unreadable: unreadable.length + failures.length, notUsed: mismatched.length,
      byType: Object.fromEntries(Object.values(DOC_TYPE).map(t => [t, byType(t).length]).filter(([, n]) => n)) },
    sources, caveats: dedupeCaveats(usable.flatMap(d => d.caveats)), identityNotes: globalIdNotes,
    inspections: { count: inspections.length, dated: comparison.reports, undated: comparison.undated, timeline, comparison },
    specifications: { ...specs, fromDocuments: specDocs.map(d => d.documentId), companions }, conditionNotes,
    outstanding, worsening,
  };
  result.checks = replacementChecks(result);
  result.summary = summaryOf(result);
  result.boundary = boundaryOf(result);
  result.review = reviewOf(result);
  return result;
}

/**
 * "Load at inspection 5.4 MW (about 45% of nameplate)": the real power as written, the percentage the report
 * states, and why it is not a verified loading — MW is real power and a transformer nameplate is apparent
 * power (MVA), so MW ÷ MVA is the loading only at unity power factor. No percentage is computed here.
 */
export function operatingLoadOf(state) {
  const text = state?.value ?? '';
  const m = /(-?\d[\d,]*\.?\d*)\s*(MW|kW|MVA|kVA|A)\b/i.exec(text);
  if (!m) return null;
  const q = quantity(`${m[1]} ${m[2]}`);
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  const real = q?.kind === 'realPower';
  return { text, value: formatQuantity(q) ?? `${m[1]} ${m[2]}`, kind: q?.kind ?? null, statedPercent: pct ? Number(pct[1]) : null,
    note: pct && real ? 'The report divides real power (MW) by the apparent-power nameplate (MVA). That equals the loading only at unity power factor; no power factor or MVA reading is documented, so the percentage is not a verified loading.' : null,
    citation: state.citation };
}

// ---- the review: structured counts, grouped findings, the condition trend and the conclusion ----

const stem = t => t.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, '');
// Words every action and finding share (an outage, a load, an inspection) say nothing about which component it is.
const GENERIC = new Set(['load', 'outage', 'inspection', 'test', 'oil', 'operation', 'during', 'needs', 'repair', 'replace', 're', 'sample']);
const words = text => tokens(text).map(stem).filter(w => !GENERIC.has(w));
/** Recommended actions that speak to a component (shared words with its name or its documented notes). */
function relatedActions(component, actions) {
  const own = new Set(words(`${component.item} ${component.history.map(h => h.notes ?? '').join(' ')}`));
  return actions.filter(a => {
    const hit = words(a.action).filter(w => own.has(w));
    const named = hit.filter(w => !/^\d+$/.test(w)).length;
    return named >= 2 || (named >= 1 && hit.length >= 2);
  });
}
const PURPOSE_LABEL = { ELECTRICAL: 'Electrical compatibility', PHYSICAL: 'Physical requirements', MAINTENANCE: 'Maintenance readiness', OPERATIONAL: 'Operational planning' };
export { PURPOSE_LABEL };

export function reviewOf(a) {
  const cmp = a.inspections.comparison;
  const dated = a.inspections.timeline.filter(t => t.inspectionDate);
  const latest = dated[0] ?? null;
  // One historical issue per component, with every observation of it.
  const components = cmp.findings.map(f => {
    const inLatest = Boolean(latest) && f.latest.date === latest.inspectionDate;
    const open = inLatest && f.latest.severity && f.latest.severity !== 'OK';
    const c = { item: f.item, trend: f.trend, recurring: f.recurring, basis: f.basis, severity: open ? f.latest.severity : null, open,
      status: open ? 'OPEN' : f.trend === TREND.RESOLVED_WITH_EVIDENCE ? 'RECORDED_OK_LATER' : 'NOT_IN_LATEST', latestNote: f.latest.notes ?? f.latest.result,
      observations: f.history.map(h => ({ date: h.date, result: h.result, severity: h.severity, notes: h.notes, citation: h.citation })) };
    c.actions = relatedActions(f, cmp.actions).map(x => ({ action: x.action, raisedOn: x.raisedOn, closure: x.closure.status, citation: x.citation }));
    return c;
  });
  const sev = { DEFECT: 3, ATTENTION: 1 };
  const trendScore = { WORSENING_WITH_EVIDENCE: 2, RECURRING_FINDING: 1 };
  components.sort((x, y) => ((sev[y.severity] ?? 0) + (trendScore[y.trend] ?? 0)) - ((sev[x.severity] ?? 0) + (trendScore[x.trend] ?? 0)));

  // Test results by the report section they are in (dissolved gas, oil quality…), compared between the last two reports that give them.
  const groups = new Map();
  for (const m of cmp.measurements) {
    const key = m.topic ?? 'Measurements';
    if (!groups.has(key)) groups.set(key, { topic: key, items: [] });
    groups.get(key).items.push(m);
  }
  const measurementGroups = [...groups.values()].map(g => {
    const worse = g.items.filter(m => m.trend === TREND.WORSENING_WITH_EVIDENCE).length;
    const better = g.items.filter(m => m.trend === TREND.IMPROVING_WITH_EVIDENCE).length;
    const dates = [...new Set(g.items.flatMap(m => [m.change.fromDate, m.change.toDate]))].sort();
    const interpretation = latest?.observations.find(o => o.interpretation && o.topic === g.topic) ?? null;
    return { topic: g.topic, title: g.topic.replace(/\s*\([^)]*\)\s*$/, ''), compared: g.items.length, worsening: worse, improving: better, unclear: g.items.length - worse - better,
      fromDate: dates[0] ?? null, toDate: dates.at(-1) ?? null, interpretation, items: g.items };
  });

  // Key concerns: the latest report's open defects and worsening items, and test groups that mostly deteriorated.
  const concerns = [];
  for (const c of components.filter(x => x.open)) {
    const word = { WORSENING_WITH_EVIDENCE: 'Worsening', RECURRING_FINDING: 'Recurring', NEW_FINDING: 'New' }[c.trend];
    const earlier = c.observations.filter(o => o.severity && o.severity !== 'OK' && o.date !== latest.inspectionDate).at(-1);
    concerns.push({ kind: 'FINDING', title: c.item, severity: c.severity, trend: c.trend, score: (sev[c.severity] ?? 0) + (trendScore[c.trend] ?? 0),
      text: `${word ? `${word}: ` : ''}${c.latestNote ?? ''}`.trim(), citations: [c.observations.at(-1).citation, ...(earlier && c.trend !== TREND.NEW_FINDING ? [earlier.citation] : [])] });
  }
  for (const g of measurementGroups) {
    if (g.worsening < 2 || g.worsening * 2 < g.compared) continue;
    const interp = g.interpretation?.text.replace(/^interpretation:\s*/i, '').split(/(?<=\.)\s/)[0] ?? null;
    concerns.push({ kind: 'MEASUREMENTS', title: g.title, severity: 'ATTENTION', score: 3 + (g.interpretation ? 1 : 0) + (g.worsening === g.compared ? 1 : 0),
      text: `${g.worsening} of ${g.compared} results deteriorated (${g.fromDate} → ${g.toDate})${interp ? `. Report: “${interp.replace(/\.$/, '')}”` : ''}.`,
      citations: [...(g.interpretation ? [g.interpretation.citation] : []), ...g.items.slice(0, 1).flatMap(m => m.points.slice(-2).map(p => p.citation))] });
  }
  concerns.sort((x, y) => y.score - x.score);

  const actions = cmp.actions;
  const counts = {
    latestDefects: latest?.counts.defects ?? 0, latestAttention: latest?.counts.attention ?? 0,
    uniqueFindings: components.length, openFindings: components.filter(c => c.open).length, recurringFindings: components.filter(c => c.recurring).length,
    worseningFindings: components.filter(c => c.trend === TREND.WORSENING_WITH_EVIDENCE).length,
    actions: actions.length, actionsClosedVerified: actions.filter(x => x.closure.status === CLOSURE.COMPLETED_WITH_EVIDENCE).length,
    actionsNotCompletedDocumented: actions.filter(x => x.closure.status === CLOSURE.NOT_COMPLETED_WITH_EVIDENCE).length,
    actionsWithoutVerifiedClosure: actions.filter(x => x.closure.status !== CLOSURE.COMPLETED_WITH_EVIDENCE).length,
    restrictions: latest?.restrictions.length ?? 0, missingSpecs: a.specifications.missing.length, keySpecs: a.specifications.keyFields.length, conflicts: a.specifications.conflicts.length,
    measurementsCompared: cmp.measurements.length, measurementsWorsening: cmp.measurements.filter(m => m.trend === TREND.WORSENING_WITH_EVIDENCE).length,
  };
  // What "outstanding" used to add up, so the two numbers can be told apart.
  counts.outstandingItems = a.outstanding.length;
  counts.outstandingExplained = `${a.outstanding.filter(o => o.kind === 'FINDING').length} latest-report findings + ${a.outstanding.filter(o => o.kind === 'RESTRICTION').length} operating restriction${a.outstanding.filter(o => o.kind === 'RESTRICTION').length === 1 ? '' : 's'} + ${a.outstanding.filter(o => o.kind === 'ACTION').length} actions without verified closure`;

  const conditionTrend = [...dated].reverse().filter(t => Number.isFinite(t.condition?.score))
    .map(t => ({ date: t.inspectionDate, label: t.condition.label, score: t.condition.score, scale: t.condition.scale ?? 5, citation: t.condition.citation }));

  const ctx = { counts, conditionTrend, components, measurementGroups, latest };
  const summaries = Object.fromEntries(REVIEW_MODES.map(m => [m, summaryFor(a, m, ctx)]));
  const nextSteps = Object.fromEntries(REVIEW_MODES.map(m => [m, nextStepsFor(a, m, ctx)]));
  return { counts, components, concerns: concerns.slice(0, 3), allConcerns: concerns, measurementGroups, conditionTrend, summaries, nextSteps,
    conclusion: summaries.replacement,
    checkGroups: Object.keys(PURPOSE_LABEL).map(p => ({ purpose: p, label: PURPOSE_LABEL[p], items: a.checks.filter(k => k.purpose === p) })).filter(g => g.items.length) };
}

/**
 * The question a review answers decides its summary and its next steps: what to verify before replacing, what
 * maintenance is open, how the condition is changing, what the specifications lack — or all of it in brief.
 */
export const REVIEW_MODES = Object.freeze(['general', 'replacement', 'maintenance', 'condition', 'specifications']);
const s_ = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const joinAnd = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '');

function conditionSentence(a, { conditionTrend }) {
  const c = p => `${p.label ?? 'Rated'} (${p.score}/${p.scale})`;
  if (!a.inspections.count) return `No inspection report is linked, so ${a.asset.id}'s condition history is not documented here.`;
  if (conditionTrend.length >= 2) {
    const [f, l] = [conditionTrend[0], conditionTrend.at(-1)];
    const dir = l.score < f.score ? 'declining' : l.score > f.score ? 'improving' : 'unchanged';
    return `Inspection records show condition ${dir}, from ${c(f)} in ${f.date.slice(0, 4)} to ${c(l)} in ${l.date.slice(0, 4)}.`;
  }
  if (conditionTrend.length === 1) return `The only rated inspection (${conditionTrend[0].date}) records ${c(conditionTrend[0])}.`;
  return `${s_(a.inspections.count, 'inspection report')} linked; none states a condition rating.`;
}
function latestSentence({ counts, components, measurementGroups }) {
  const worse = components.filter(x => x.open && x.trend === TREND.WORSENING_WITH_EVIDENCE);
  const tests = measurementGroups.filter(g => g.worsening >= 2 && g.worsening * 2 >= g.compared);
  const bits = [counts.latestDefects ? s_(counts.latestDefects, 'defect') : null, worse.length ? s_(worse.length, 'worsening finding') : null,
    tests.length ? `${counts.measurementsWorsening} of ${counts.measurementsCompared} test results deteriorating` : null].filter(Boolean);
  return bits.length ? `The latest report records ${joinAnd(bits)}.` : null;
}

/** Two or three sentences for the question asked; never a replacement decision. */
function summaryFor(a, mode, ctx) {
  const { counts, components, measurementGroups } = ctx;
  if (!a.documents.analysed) return { title: 'Documents could not be read', text: `None of ${a.asset.id}'s linked documents could be read.`, tone: 'neutral' };
  const worse = components.filter(x => x.open && x.trend === TREND.WORSENING_WITH_EVIDENCE);
  const tests = measurementGroups.filter(g => g.worsening >= 2 && g.worsening * 2 >= g.compared);
  const review = counts.latestDefects || worse.length || tests.length;
  const conditionTitle = review ? 'Engineering review required' : counts.latestAttention ? 'Items to monitor' : a.inspections.count ? 'No open defects documented' : 'Condition not documented';
  const tone = review ? 'bad' : counts.latestAttention ? 'warn' : 'neutral';
  const spec = a.specifications;
  const specSentence = !spec.fromDocuments.length ? 'No technical datasheet or asset sheet is linked.'
    : spec.missing.length ? `${spec.missing.length} of ${spec.keyFields.length} key specifications are not documented${spec.conflicts.length ? `, and ${s_(spec.conflicts.length, 'value')} differ between documents` : ''}.`
      : spec.conflicts.length ? `${s_(spec.conflicts.length, 'specification')} differ between documents.` : `All ${spec.keyFields.length} key specifications are documented.`;
  if (mode === 'specifications') {
    const gaps = spec.missing.length || spec.conflicts.length || !spec.fromDocuments.length;
    const documented = spec.keyFields.filter(f => !f.missing).length;
    return { title: gaps ? 'Specification gaps' : 'Specifications documented', tone: gaps ? 'warn' : 'neutral',
      text: [`${documented} of ${spec.keyFields.length} key specifications for ${a.asset.category === 'generic' ? 'an asset of this type' : `a ${a.asset.category}`} are documented in the linked files${spec.missing.length ? `; ${spec.missing.length} are missing` : ''}.`,
        spec.conflicts.length ? `${s_(spec.conflicts.length, 'specification')} differ between documents; both values are kept.` : null,
        !spec.fromDocuments.length ? 'No technical datasheet or asset sheet is linked.' : null].filter(Boolean).join(' ') };
  }
  if (mode === 'maintenance') {
    if (!a.inspections.count) return { title: 'No maintenance history documented', tone: 'neutral', text: `No inspection or maintenance record is linked to ${a.asset.id}, so open work cannot be established from the documents.` };
    const open = counts.actionsWithoutVerifiedClosure;
    const parts = [`${open} of ${counts.actions} corrective actions raised in inspections have no documented closure${counts.actionsNotCompletedDocumented ? `; ${counts.actionsNotCompletedDocumented} are documented as not completed` : ''}.`];
    if (counts.restrictions) parts.push(`The latest report sets ${s_(counts.restrictions, 'operating restriction')}.`);
    const rec = components.filter(c => c.recurring);
    if (rec.length) parts.push(`${s_(rec.length, 'finding recurs', 'findings recur')} across reports.`);
    return { title: open ? `${s_(open, 'action')} without verified closure` : 'No open actions documented', tone: counts.actionsNotCompletedDocumented ? 'bad' : open ? 'warn' : 'neutral', text: parts.slice(0, 3).join(' ') };
  }
  const parts = [conditionSentence(a, ctx), latestSentence(ctx)].filter(Boolean);
  if (mode === 'condition') {
    const meas = tests.length ? null : counts.measurementsCompared ? `${counts.measurementsWorsening} of ${counts.measurementsCompared} test results deteriorated between the last two reports.` : null;
    return { title: conditionTitle, tone, text: [...parts, meas].filter(Boolean).slice(0, 3).join(' ') };
  }
  if (mode === 'replacement') parts.push(spec.missing.length ? `${spec.missing.length} of ${spec.keyFields.length} key replacement specifications are not documented.` : specSentence);
  else parts.push(specSentence);
  return { title: conditionTitle, tone, text: parts.slice(0, 3).join(' ') };
}

/**
 * Recommended next steps, from what the documents record and what they leave out. Each step says its basis
 * (documented, derived from the records, or a suggested check) and cites its lines; `link` points to the tab
 * that holds the detail. Replacement steps are the replacement checks; the electrical model is added by the page.
 */
function nextStepsFor(a, mode, ctx) {
  const { counts, components, measurementGroups, latest } = ctx;
  const steps = [];
  const add = (text, basis, sources = [], extra = {}) => steps.push({ text, basis, sources: sources.filter(Boolean), ...extra });
  const spec = a.specifications;
  const cmp = a.inspections.comparison;
  const specSteps = () => {
    if (!spec.fromDocuments.length) add('Obtain a technical datasheet or nameplate record: none is among the linked documents.', 'CHECK_REQUIRED');
    if (spec.missing.length) add(`Obtain the ${s_(spec.missing.length, 'missing key specification')} from the nameplate or manufacturer.`, 'CHECK_REQUIRED', [], { link: 'missing' });
    for (const c of spec.conflicts) add(`Resolve the conflicting ${c.label.toLowerCase()}: ${c.values.map(v => v.display ?? v.value).join(' vs ')}.`, 'CHECK_REQUIRED', c.values.flatMap(v => v.sources));
    if (spec.fromDocuments.length && !spec.missing.length && !spec.conflicts.length) add('Confirm the documented ratings against the installed nameplate.', 'CHECK_REQUIRED', spec.keyFields.slice(0, 2).map(f => f.source));
  };
  const maintenanceSteps = () => {
    const order = { NOT_COMPLETED_WITH_EVIDENCE: 0, NOT_VERIFIED: 1 };
    const prio = p => (/high|urgent|critical/i.test(p ?? '') ? 0 : /medium/i.test(p ?? '') ? 1 : 2);
    const open = cmp.actions.filter(x => x.closure.status !== CLOSURE.COMPLETED_WITH_EVIDENCE)
      .sort((x, y) => order[x.closure.status] - order[y.closure.status] || prio(x.priority) - prio(y.priority) || String(y.raisedOn).localeCompare(String(x.raisedOn)));
    for (const x of open.slice(0, 3)) {
      add(`${x.action} (raised ${x.raisedOn}${x.due ? `, due ${x.due}` : ''}): ${x.closure.status === CLOSURE.NOT_COMPLETED_WITH_EVIDENCE ? 'documented as not completed' : 'no record of completion'}.`,
        x.closure.status === CLOSURE.NOT_COMPLETED_WITH_EVIDENCE ? 'DOCUMENTED' : 'DERIVED', [x.citation, x.closure.citation]);
    }
    if (open.length > 3) add(`Review the other ${s_(open.length - 3, 'action')} without verified closure.`, 'DERIVED', [], { link: 'actions' });
    for (const r of latest?.restrictions ?? []) add(`Keep to the documented operating restriction: ${r.text}`, 'DOCUMENTED', [r.citation]);
    for (const c of components.filter(x => x.open && x.recurring && !x.actions.length)) add(`No action in the reports addresses the recurring ${c.item.toLowerCase()} finding.`, 'DERIVED', c.observations.map(o => o.citation), { link: 'component', item: c.item });
    if (latest?.nextDue?.value) add(`Next inspection due ${latest.nextDue.value}, as the latest report states.`, 'DOCUMENTED', [latest.nextDue.citation]);
    if (a.inspections.count && !a.documents.byType.MAINTENANCE) add('No maintenance records are linked: closure is taken only from later inspection reports. Link work orders to confirm completed work.', 'CHECK_REQUIRED');
  };
  const conditionSteps = () => {
    for (const c of components.filter(x => x.open && x.trend === TREND.WORSENING_WITH_EVIDENCE)) add(`Assess the worsening ${c.item.toLowerCase()}: ${c.basis}`, 'DERIVED', c.observations.filter(o => o.severity !== 'OK').map(o => o.citation), { link: 'component', item: c.item });
    for (const g of measurementGroups.filter(x => x.worsening >= 2 && x.worsening * 2 >= x.compared)) {
      add(`${g.title}: ${g.worsening} of ${g.compared} results deteriorated (${g.fromDate} → ${g.toDate}); have them assessed.`, 'DERIVED', [g.interpretation?.citation, ...g.items.slice(0, 1).map(m => m.points.at(-1).citation)], { link: 'measurements' });
    }
    if (cmp.caveats.length && cmp.measurements.length) add('Validate the measurement comparison: the reports were made under different operating conditions.', 'CHECK_REQUIRED', cmp.caveats.flatMap(c => c.citations));
    for (const c of components.filter(x => x.open && x.trend === TREND.RECURRING_FINDING)) add(`Track the recurring ${c.item.toLowerCase()} finding: ${c.basis}`, 'DERIVED', c.observations.filter(o => o.severity !== 'OK').map(o => o.citation), { link: 'component', item: c.item });
    if (a.inspections.count && cmp.reports < 2) add('Only one dated inspection report: a further inspection is needed to establish a trend.', 'CHECK_REQUIRED');
    if (!a.inspections.count) add('No inspection report is linked: an inspection is needed to establish the condition.', 'CHECK_REQUIRED');
    if (latest?.nextDue?.value) add(`Next inspection due ${latest.nextDue.value}, as the latest report states.`, 'DOCUMENTED', [latest.nextDue.citation]);
  };
  if (mode === 'replacement') {
    // The replacement checks (electrical, physical, maintenance, operational), in that order.
    for (const p of Object.keys(PURPOSE_LABEL)) for (const k of a.checks.filter(x => x.purpose === p)) {
      if (k.network) continue;
      steps.push({ text: k.text, basis: k.basis, sources: k.sources ?? [], group: PURPOSE_LABEL[p], ...(k.missingSpecs ? { link: 'missing', missingSpecs: true } : {}) });
    }
    return steps;
  }
  if (mode === 'maintenance') maintenanceSteps();
  else if (mode === 'condition') conditionSteps();
  else if (mode === 'specifications') specSteps();
  else {
    // A general question: the most pressing step of each kind.
    const pick = fn => { const before = steps.length; fn(); steps.splice(before + 1); };
    pick(conditionSteps); pick(maintenanceSteps); pick(specSteps);
  }
  // The same step twice (a next-due date from two routes) once.
  return steps.filter((x, i) => steps.findIndex(y => y.text === x.text) === i);
}
function dedupeCaveats(list) {
  const seen = new Set();
  return list.filter(c => { const k = c.text.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);
}

const lc = s => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
/** What to verify before replacing the asset, from what is documented and what is not. */
export function replacementChecks(a) {
  const checks = [];
  const spec = key => a.specifications.keyFields.find(f => f.key === key) ?? a.specifications.otherFields.find(f => f.key === key);
  const documented = keys => keys.map(spec).filter(f => f && !f.missing);
  const ratings = documented(['ratedPower', 'primaryVoltage', 'secondaryVoltage', 'voltageLevel', 'ratedCurrent', 'ratedLoad', 'wattage', 'capacityKw'])
    .filter(f => !(f.key === 'voltageLevel' && spec('primaryVoltage') && !spec('primaryVoltage').missing));
  if (ratings.length) checks.push({ basis: 'DOCUMENTED', purpose: 'ELECTRICAL', text: `Match the replacement to the documented ratings (${ratings.map(f => `${lc(f.label)} ${f.display ?? f.value}`).join(', ')}) and confirm them on the installed nameplate.`, sources: ratings.map(f => f.source).filter(Boolean) });
  for (const c of a.specifications.conflicts) checks.push({ basis: 'CHECK_REQUIRED', purpose: 'ELECTRICAL', text: `Resolve the conflicting ${lc(c.label)}: ${c.values.map(v => v.value).join(' vs ')}.`, sources: c.values.flatMap(v => v.sources) });
  if (a.specifications.missing.length) checks.push({ basis: 'CHECK_REQUIRED', purpose: 'ELECTRICAL', missingSpecs: true, text: `Not documented in the linked files: ${a.specifications.missing.map(lc).join(', ')}. Take them from the nameplate or the manufacturer before specifying a replacement.`, sources: [] });
  const dims = spec('dimensions');
  if (dims && !dims.missing) checks.push({ basis: 'DOCUMENTED', purpose: 'PHYSICAL', text: `Check access, foundation and clearances for the documented size (${dims.value}).`, sources: [dims.source] });
  const weight = spec('weight');
  if (!weight || weight.missing) checks.push({ basis: 'CHECK_REQUIRED', purpose: 'PHYSICAL', text: 'Weight is not documented: needed for lifting and transport planning.', sources: [] });
  const latest = a.inspections.timeline.find(t => t.inspectionDate);
  for (const r of latest?.restrictions ?? []) checks.push({ basis: 'DOCUMENTED', purpose: 'MAINTENANCE', text: `Keep to the documented operating restriction until the work is done: ${r.text}`, sources: [r.citation] });
  const openActions = a.outstanding.filter(o => o.kind === 'ACTION');
  if (openActions.length) checks.push({ basis: 'DERIVED', purpose: 'MAINTENANCE', text: `Decide what happens to ${openActions.length} inspection action${openActions.length === 1 ? '' : 's'} without documented closure (carry over or close with the replacement).`, sources: openActions.slice(0, 4).map(o => o.citation) });
  const latestActions = openActions.filter(o => latest && o.raisedOn === latest.inspectionDate);
  const switching = latestActions.find(o => /switching|isolat/i.test(o.text)) ?? latestActions.find(o => /outage/i.test(o.text));
  if (switching) checks.push({ basis: 'DOCUMENTED', purpose: 'OPERATIONAL', text: `The latest report already asks to: ${switching.text}.`, sources: [switching.citation] });
  if (!a.inspections.count) checks.push({ basis: 'CHECK_REQUIRED', purpose: 'MAINTENANCE', text: 'No inspection report is linked: the asset\'s condition history is not documented here.', sources: [] });
  // Network checks are filled in from the electrical model by the caller (never from a PDF).
  checks.push({ basis: 'NETWORK', purpose: 'OPERATIONAL', text: 'Isolation, switching and the loads affected during the work: from the electrical model.', sources: [], network: true });
  return checks;
}

function summaryOf(a) {
  // Two to four sentences: what was read, what the inspections establish, what is open, what is missing.
  const parts = [];
  const n = a.documents;
  const types = Object.entries(n.byType).map(([t, c]) => `${c} ${TYPE_WORD[t]}${c === 1 ? '' : 's'}`).join(', ');
  parts.push(`Read ${n.analysed} of ${n.linked} linked document${n.linked === 1 ? '' : 's'}${types ? ` (${types})` : ''}${n.unreadable ? `; ${n.unreadable} could not be read` : ''}${n.notUsed ? `; ${n.notUsed} named another asset and ${n.notUsed === 1 ? 'was' : 'were'} not used` : ''}.`);
  const t = a.inspections.timeline.filter(x => x.inspectionDate);
  if (!a.inspections.count) parts.push(`No inspection reports are among ${a.asset.id}'s linked documents, so its inspection history is not documented here.`);
  else {
    const latest = t[0];
    const cond = a.inspections.comparison.condition;
    const c = x => `${x.label}${x.score !== null && x.score !== undefined ? ` (${x.score}/${x.scale})` : ''}`;
    if (cond) parts.push(`Condition went from ${c(cond.from)} on ${cond.from.date} to ${c(cond.to)} on ${cond.to.date}.`);
    else if (latest) parts.push(`One dated inspection (${latest.inspectionDate})${latest.condition?.label ? `: ${c(latest.condition)}` : ''}.`);
    if (latest) {
      const rec = a.inspections.comparison.findings.filter(f => f.recurring).length;
      const open = a.outstanding.filter(o => o.kind === 'ACTION').length;
      const issues = [`${latest.counts.defects} defect${latest.counts.defects === 1 ? '' : 's'}`, latest.counts.attention ? `${latest.counts.attention} item${latest.counts.attention === 1 ? '' : 's'} needing attention` : null].filter(Boolean).join(' and ');
      parts.push(`The latest report records ${issues}${rec ? ` (${rec} also recorded earlier)` : ''}${open ? `; ${open} action${open === 1 ? ' has' : 's have'} no documented closure` : ''}.`);
    }
  }
  const s = a.specifications;
  if (!s.fromDocuments.length) parts.push('No technical datasheet or asset sheet is among the linked documents.');
  else if (s.missing.length) parts.push(`${s.missing.length} of ${s.keyFields.length} key specifications are not documented${s.conflicts.length ? `, and ${s.conflicts.length} differ between documents` : ''}.`);
  else if (s.conflicts.length) parts.push(`${s.conflicts.length} specification${s.conflicts.length === 1 ? '' : 's'} differ between documents.`);
  return parts.join(' ');
}
const TYPE_WORD = { TECHNICAL_SPECIFICATION: 'specification sheet', INSPECTION: 'inspection report', MAINTENANCE: 'maintenance record', TEST_REPORT: 'test report', OTHER: 'other document' };

function boundaryOf(a) {
  const defects = a.outstanding.filter(o => o.kind === 'FINDING' && o.severity === 'DEFECT').length;
  if (defects || a.worsening.length) return `The documented findings warrant engineering review. They do not by themselves establish that ${a.asset.id} must be replaced; that needs an engineering assessment.`;
  return `Nothing in the linked documents establishes whether ${a.asset.id} needs replacing; that needs an engineering assessment.`;
}
