/**
 * The integration-owned mapping layer: ACC element → P6 activity → P6 WBS → SAP WBS → BOQ item.
 *
 * WHAT IS DERIVED AND WHAT IS DECIDED, which is the distinction the whole phase turns on.
 *
 *   DERIVED — the source systems already publish these, so nothing here invents them:
 *     element.activity_ref   the model's own property naming the activity that builds it (495/500)
 *     activity.wbs_code      P6's own breakdown (150/150)
 *     boq_item.sap_wbs_code  SAP's own cost allocation (50/50)
 *
 *   DECIDED HERE — no source publishes these:
 *     P6 WBS ↔ SAP WBS   matched on the code both systems use. SAP carries 1.6 and P6 does not,
 *                        which is a real mismatch for its owner rather than something to paper over.
 *     element → BOQ item A WBS carries up to five BOQ items, so this is one-to-many and usually
 *                        NOT a mapping at all. It is resolved only where the WBS offers exactly
 *                        one item, or where a reviewer has approved a choice.
 *
 * Cardinality is never assumed: up to nine elements share an activity, two activities have no
 * element, and a WBS can carry five BOQ items. Nothing below treats any of those as one-to-one.
 *
 * Correcting a mapping writes HERE. No src_* table is ever modified by this file.
 */

export const BASIS = Object.freeze({
  /** The source system published the link. */
  SOURCE: 'SOURCE',
  /** Only one candidate existed, so there was nothing to choose. */
  UNAMBIGUOUS: 'UNAMBIGUOUS',
  /** A reviewer chose it and an authorised owner approved it. */
  APPROVED: 'APPROVED',
  /** Several candidates and nobody has chosen. Not a mapping. */
  UNRESOLVED: 'UNRESOLVED',
  /** Nothing to link to at all. */
  NONE: 'NONE',
});

export const MAPPING_STATUS = Object.freeze({
  COMPLETE: 'COMPLETE',
  /** The chain resolves but its last link is a choice nobody has made. */
  NEEDS_SELECTION: 'NEEDS_SELECTION',
  /** A link earlier in the chain is missing, so the rest cannot be resolved. */
  INCOMPLETE: 'INCOMPLETE',
});

const nowIso = () => new Date().toISOString();

/** The approved proposals that override the source, newest decision wins. */
export function approvedOverrides(db) {
  const rows = db.prepare(
    `SELECT element_id, field, proposed_value FROM mapping_proposal
      WHERE status = 'APPLIED' ORDER BY applied_at ASC, id ASC`).all();
  const byElement = new Map();
  for (const row of rows) {
    const entry = byElement.get(row.element_id) ?? {};
    entry[row.field] = row.proposed_value;
    byElement.set(row.element_id, entry);
  }
  return byElement;
}

/**
 * Build the whole mapping layer from the synced records plus the approved overrides.
 *
 * Idempotent: it rewrites every row from the same inputs, so running it twice leaves the table
 * identical. A build is recorded, because it is a thing that happened.
 */
export function buildMappings(db, { actor = 'Integration service', now = nowIso } = {}) {
  const startedAt = now();
  const buildId = db.prepare(
    'INSERT INTO mapping_build (started_at, actor) VALUES (?, ?)').run(startedAt, actor).lastInsertRowid;

  const activities = new Map(db.prepare(
    "SELECT source_id, wbs_code, source_rev FROM activity WHERE source_system = 'P6'").all()
    .map(row => [row.source_id, row]));
  const p6Wbs = new Set(db.prepare("SELECT source_id FROM wbs WHERE source_system = 'P6'").all()
    .map(row => row.source_id));
  const sapWbs = new Set(db.prepare("SELECT source_id FROM wbs WHERE source_system = 'SAP'").all()
    .map(row => row.source_id));
  const boqByWbs = new Map();
  for (const row of db.prepare('SELECT source_id, sap_wbs_code FROM boq_item ORDER BY source_id').all()) {
    const list = boqByWbs.get(row.sap_wbs_code) ?? [];
    list.push(row.source_id);
    boqByWbs.set(row.sap_wbs_code, list);
  }
  const overrides = approvedOverrides(db);
  const elements = db.prepare(
    `SELECT source_id, model_version_id, activity_ref, boq_ref, source_rev
       FROM element WHERE source_system = 'ACC' ORDER BY source_id`).all();

  const insert = db.prepare(
    `INSERT OR REPLACE INTO mapping (element_id, model_version_id, activity_id, activity_basis,
        p6_wbs_code, sap_wbs_code, boq_code, boq_basis, boq_candidates, status, source_rev,
        built_at, build_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let complete = 0;
  let incomplete = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM mapping');
    for (const element of elements) {
      const override = overrides.get(element.source_id) ?? {};
      const activityId = override.activity_id ?? element.activity_ref ?? null;
      const activityBasis = !activityId ? BASIS.NONE
        : override.activity_id ? BASIS.APPROVED : BASIS.SOURCE;

      const activity = activityId ? activities.get(activityId) ?? null : null;
      // An activity id that resolves to nothing is NOT a WBS: leaving p6WbsCode null here is what
      // lets rule 2 say "the activity does not exist" instead of rule 3 saying "no WBS".
      const p6WbsCode = activity?.wbs_code && p6Wbs.has(activity.wbs_code) ? activity.wbs_code : null;
      // The correspondence is by the code both systems use. No SAP counterpart means no SAP WBS,
      // which is a finding for the owner of that structure.
      const sapWbsCode = p6WbsCode && sapWbs.has(p6WbsCode) ? p6WbsCode : null;

      const candidates = sapWbsCode ? boqByWbs.get(sapWbsCode) ?? [] : [];
      let boqCode = null;
      let boqBasis = BASIS.NONE;
      if (override.boq_code && candidates.includes(override.boq_code)) {
        boqCode = override.boq_code; boqBasis = BASIS.APPROVED;
      } else if (element.boq_ref && candidates.includes(element.boq_ref)) {
        // The model carries its own cost code. That is a link the source publishes, not a guess.
        boqCode = element.boq_ref; boqBasis = BASIS.SOURCE;
      } else if (candidates.length === 1) {
        boqCode = candidates[0]; boqBasis = BASIS.UNAMBIGUOUS;
      } else if (candidates.length > 1) {
        boqBasis = BASIS.UNRESOLVED;
      }

      const status = !activityId || !activity || !p6WbsCode || !sapWbsCode ? MAPPING_STATUS.INCOMPLETE
        : boqCode ? MAPPING_STATUS.COMPLETE : MAPPING_STATUS.NEEDS_SELECTION;
      if (status === MAPPING_STATUS.COMPLETE) complete += 1; else incomplete += 1;

      insert.run(element.source_id, element.model_version_id, activityId, activityBasis,
        p6WbsCode, sapWbsCode, boqCode, boqBasis, candidates.length, status,
        `e${element.source_rev ?? 1}/a${activity?.source_rev ?? 0}`, startedAt, buildId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.prepare('UPDATE mapping_build SET finished_at = ? WHERE id = ?').run(now(), buildId);
    throw error;
  }

  db.prepare(`UPDATE mapping_build SET finished_at = ?, elements = ?, complete = ?, incomplete = ?
     WHERE id = ?`).run(now(), elements.length, complete, incomplete, buildId);
  return Object.freeze({ buildId: Number(buildId), elements: elements.length, complete, incomplete });
}

/** The full chain for one element, with the records each link points at. */
export function mappingDetail(db, elementId) {
  const mapping = db.prepare('SELECT * FROM mapping WHERE element_id = ?').get(String(elementId));
  if (!mapping) return null;
  const element = db.prepare(
    "SELECT * FROM element WHERE source_system = 'ACC' AND source_id = ?").get(mapping.element_id);
  const activity = mapping.activity_id
    ? db.prepare("SELECT * FROM activity WHERE source_system = 'P6' AND source_id = ?").get(mapping.activity_id)
    : null;
  const version = mapping.model_version_id
    ? db.prepare("SELECT * FROM model_version WHERE source_system = 'ACC' AND source_id = ?")
      .get(mapping.model_version_id)
    : null;
  const boq = mapping.boq_code
    ? db.prepare('SELECT * FROM boq_item WHERE source_id = ?').get(mapping.boq_code) : null;
  const candidates = mapping.sap_wbs_code
    ? db.prepare('SELECT * FROM boq_item WHERE sap_wbs_code = ? ORDER BY source_id').all(mapping.sap_wbs_code)
    : [];
  return {
    mapping,
    chain: [
      { step: 'BIM element', system: 'ACC', id: mapping.element_id, basis: BASIS.SOURCE,
        record: element ?? null },
      { step: 'P6 activity', system: 'P6', id: mapping.activity_id, basis: mapping.activity_basis,
        record: activity ?? null },
      { step: 'P6 WBS', system: 'P6', id: mapping.p6_wbs_code, basis: mapping.p6_wbs_code ? BASIS.SOURCE : BASIS.NONE,
        record: mapping.p6_wbs_code
          ? db.prepare("SELECT * FROM wbs WHERE source_system = 'P6' AND source_id = ?").get(mapping.p6_wbs_code) : null },
      { step: 'SAP WBS', system: 'SAP', id: mapping.sap_wbs_code,
        basis: mapping.sap_wbs_code ? BASIS.UNAMBIGUOUS : BASIS.NONE,
        record: mapping.sap_wbs_code
          ? db.prepare("SELECT * FROM wbs WHERE source_system = 'SAP' AND source_id = ?").get(mapping.sap_wbs_code) : null },
      { step: 'BOQ item', system: 'SAP', id: mapping.boq_code, basis: mapping.boq_basis,
        record: boq ?? null },
    ],
    modelVersion: version ?? null,
    boqCandidates: candidates,
    validation: db.prepare(
      "SELECT * FROM validation_result WHERE subject_id = ? AND status = 'OPEN' ORDER BY severity, rule_id")
      .all(mapping.element_id),
    exceptions: db.prepare(
      'SELECT * FROM exception WHERE subject_id = ? ORDER BY id DESC').all(mapping.element_id),
    proposals: db.prepare(
      'SELECT * FROM mapping_proposal WHERE element_id = ? ORDER BY id DESC').all(mapping.element_id),
  };
}

/** The facets the workbench filters by — read from the data, never a written-down list. */
export function mappingFacets(db) {
  const distinct = column => db.prepare(
    `SELECT DISTINCT ${column} AS value FROM element WHERE source_system = 'ACC'
       AND ${column} IS NOT NULL ORDER BY ${column}`).all().map(row => row.value);
  return {
    level: distinct('level'),
    zone: distinct('zone'),
    discipline: distinct('discipline'),
    wbs: db.prepare('SELECT DISTINCT p6_wbs_code AS value FROM mapping WHERE p6_wbs_code IS NOT NULL ORDER BY p6_wbs_code')
      .all().map(row => row.value),
    status: Object.values(MAPPING_STATUS),
    rule: db.prepare("SELECT DISTINCT rule_id AS value FROM validation_result WHERE status = 'OPEN' ORDER BY rule_id")
      .all().map(row => row.value),
  };
}

/** The mapping table, filtered. Joins in the element's own properties and its open findings. */
export function listMappings(db, filters = {}) {
  const where = ["e.source_system = 'ACC'"];
  const params = [];
  const add = (sql, value) => { if (value) { where.push(sql); params.push(value); } };
  add('e.level = ?', filters.level);
  add('e.zone = ?', filters.zone);
  add('e.discipline = ?', filters.discipline);
  add('m.p6_wbs_code = ?', filters.wbs);
  add('m.status = ?', filters.status);
  if (filters.rule) {
    where.push(`EXISTS (SELECT 1 FROM validation_result v WHERE v.subject_id = m.element_id
      AND v.status = 'OPEN' AND v.rule_id = ?)`);
    params.push(filters.rule);
  }
  if (filters.query) {
    where.push(`(m.element_id LIKE ? OR m.activity_id LIKE ? OR m.p6_wbs_code LIKE ?
      OR m.boq_code LIKE ? OR e.work_package LIKE ?)`);
    const like = `%${filters.query}%`;
    params.push(like, like, like, like, like);
  }
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
  const offset = Math.max(0, Number(filters.offset) || 0);

  const base = `FROM mapping m JOIN element e ON e.source_id = m.element_id
    WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params).n;
  const rows = db.prepare(
    `SELECT m.*, e.level, e.zone, e.discipline, e.work_package, e.quantity, e.unit,
       (SELECT COUNT(*) FROM validation_result v WHERE v.subject_id = m.element_id
          AND v.status = 'OPEN' AND v.severity = 'ERROR') AS errors,
       (SELECT COUNT(*) FROM validation_result v WHERE v.subject_id = m.element_id
          AND v.status = 'OPEN' AND v.severity = 'WARNING') AS warnings
     ${base} ORDER BY m.element_id LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows, limit, offset };
}

/** Completeness, counted. Every figure is a COUNT(*) over the table above. */
export function mappingSummary(db) {
  const count = sql => db.prepare(`SELECT COUNT(*) AS n FROM mapping ${sql}`).get().n;
  return {
    elements: count(''),
    complete: count("WHERE status = 'COMPLETE'"),
    needsSelection: count("WHERE status = 'NEEDS_SELECTION'"),
    incomplete: count("WHERE status = 'INCOMPLETE'"),
    withActivity: count('WHERE activity_id IS NOT NULL'),
    withoutActivity: count('WHERE activity_id IS NULL'),
    withP6Wbs: count('WHERE p6_wbs_code IS NOT NULL'),
    withSapWbs: count('WHERE sap_wbs_code IS NOT NULL'),
    withBoq: count('WHERE boq_code IS NOT NULL'),
    boqApproved: count(`WHERE boq_basis = '${BASIS.APPROVED}'`),
    activityApproved: count(`WHERE activity_basis = '${BASIS.APPROVED}'`),
    lastBuiltAt: db.prepare('SELECT MAX(finished_at) AS at FROM mapping_build').get().at ?? null,
  };
}
