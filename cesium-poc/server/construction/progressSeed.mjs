/**
 * Geometry and verified progress for Tower A — synthetic, deterministic, and stored.
 *
 * TWO THINGS THE ACC EXPORT DOES NOT CARRY, generated here rather than at render time:
 *
 *   GEOMETRY     the model has no coordinates. Positions are derived from the element's own
 *                level, zone, category and index, so the building that appears is the one the
 *                database describes and the same one on every machine.
 *   OBSERVATIONS what has actually been built. P6's own `pct_complete` is a claim; this is the
 *                evidence, and only a VERIFIED observation counts towards actual progress.
 *
 * The worked example is exact: A-1020 "Cast Level 2 columns" has 20 columns, 12 of them verified,
 * so actual progress is 60% against the 80% P6 claims.
 */

/** A building 36 m square and five storeys, which is enough to read at a glance. */
export const GRID = Object.freeze({
  bayX: 6, bayY: 6, baysX: 6, baysY: 6, storeyHeight: 4,
  columnSize: 0.6, slabThickness: 0.3, wallThickness: 0.2, ductSize: 0.5,
});

export const LEVELS = Object.freeze(['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5']);
export const ZONES = Object.freeze(['Zone A', 'Zone B', 'Zone C']);

/** The 12 of A-1020's 20 columns that have been verified built. Fixed, so 60% is always 60%. */
export const A1020_VERIFIED = 12;

const index = id => Number(String(id).split('-')[1] ?? 0);

/**
 * One element's box, in local metres with z up.
 *
 * Each category occupies its own part of the frame — columns on the grid intersections, slabs
 * spanning a zone, walls on a line, curtain panels on the facade, ducts under the slab — so the
 * result reads as a building rather than a cloud of boxes.
 */
export function geometryFor(element) {
  const levelIndex = Math.max(0, LEVELS.indexOf(element.level));
  const zoneIndex = Math.max(0, ZONES.indexOf(element.zone));
  const n = index(element.source_id ?? element.element_id);
  const base = levelIndex * GRID.storeyHeight;
  // Within its own level, an element is placed by its ordinal among that level's elements.
  const slot = Math.floor(n / LEVELS.length);
  const col = slot % GRID.baysX;
  const row = Math.floor(slot / GRID.baysX) % GRID.baysY;
  const x = (col - (GRID.baysX - 1) / 2) * GRID.bayX;
  const y = (row - (GRID.baysY - 1) / 2) * GRID.bayY;

  switch (element.category) {
    case 'Structural Columns':
      return { x, y, z: base + GRID.storeyHeight / 2,
        sx: GRID.columnSize, sy: GRID.columnSize, sz: GRID.storeyHeight,
        levelIndex, zoneIndex };
    case 'Floors': {
      // One slab panel per zone strip, so three slabs tile a storey.
      const width = (GRID.baysX * GRID.bayX) / ZONES.length;
      return { x: (zoneIndex - (ZONES.length - 1) / 2) * width, y: 0,
        z: base + GRID.storeyHeight, sx: width - 0.4, sy: GRID.baysY * GRID.bayY,
        sz: GRID.slabThickness, levelIndex, zoneIndex };
    }
    case 'Walls':
      return { x, y: y + GRID.bayY / 2, z: base + GRID.storeyHeight / 2,
        sx: GRID.bayX - 0.5, sy: GRID.wallThickness, sz: GRID.storeyHeight - GRID.slabThickness,
        levelIndex, zoneIndex };
    case 'Curtain Panels': {
      // On the perimeter: alternate faces so the facade is not one wall of glass.
      const half = (GRID.baysY * GRID.bayY) / 2;
      const onY = slot % 2 === 0;
      return { x: onY ? x : (slot % 4 === 1 ? half : -half),
        y: onY ? (slot % 4 === 0 ? half : -half) : y,
        z: base + GRID.storeyHeight / 2,
        sx: onY ? GRID.bayX - 0.4 : 0.15, sy: onY ? 0.15 : GRID.bayY - 0.4,
        sz: GRID.storeyHeight - 0.6, levelIndex, zoneIndex };
    }
    case 'Ducts':
      return { x, y, z: base + GRID.storeyHeight - 0.8,
        sx: GRID.bayX - 1, sy: GRID.ductSize, sz: GRID.ductSize, levelIndex, zoneIndex };
    default:
      return { x, y, z: base + 1, sx: 1, sy: 1, sz: 1, levelIndex, zoneIndex };
  }
}

/** Store the geometry for every synced element. Idempotent: it rewrites the same rows. */
export function seedGeometry(db) {
  const elements = db.prepare(
    "SELECT source_id, category, level, zone FROM element WHERE source_system = 'ACC' ORDER BY source_id").all();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO element_geometry (element_id, x, y, z, sx, sy, sz, level_index, zone_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const element of elements) {
      const box = geometryFor(element);
      insert.run(element.source_id, box.x, box.y, box.z, box.sx, box.sy, box.sz,
        box.levelIndex, box.zoneIndex);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return elements.length;
}

/* ── measurement rules ─────────────────────────────────────────────────────────────────────── */

export const RULE = Object.freeze({
  /** Every element counts the same. Only correct where they are comparable, so it is declared. */
  EQUAL_WEIGHT_ELEMENTS: 'EQUAL_WEIGHT_ELEMENTS',
  /** Verified quantity against the BOQ's approved quantity. */
  QUANTITY: 'QUANTITY',
  /** Nothing to measure against. Progress is not calculated rather than guessed. */
  NOT_MEASURABLE: 'NOT_MEASURABLE',
});

/**
 * Declare a rule per activity.
 *
 * Columns, walls and curtain panels are repeating comparable units, so equal-weight counting is
 * defensible and is configured for them. Slabs and ducts vary in size, so they are measured by
 * quantity where a BOQ item gives one. Anything with no elements is not measurable here.
 */
export function seedMeasurementRules(db) {
  const rows = db.prepare(
    `SELECT a.source_id AS activity_id,
            (SELECT COUNT(*) FROM mapping m WHERE m.activity_id = a.source_id) AS elements,
            (SELECT COUNT(DISTINCT e.category) FROM mapping m
               JOIN element e ON e.source_id = m.element_id WHERE m.activity_id = a.source_id) AS categories,
            (SELECT e.category FROM mapping m JOIN element e ON e.source_id = m.element_id
              WHERE m.activity_id = a.source_id LIMIT 1) AS category,
            (SELECT COUNT(*) FROM mapping m WHERE m.activity_id = a.source_id
               AND m.boq_code IS NOT NULL) AS withBoq
       FROM activity a WHERE a.source_system = 'P6' ORDER BY a.source_id`).all();
  const EQUAL = new Set(['Structural Columns', 'Walls', 'Curtain Panels']);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO measurement_rule (activity_id, rule, note) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (!row.elements) {
        insert.run(row.activity_id, RULE.NOT_MEASURABLE,
          'No BIM element is linked to this activity, so there is nothing to measure against.');
        continue;
      }
      if (row.categories === 1 && EQUAL.has(row.category)) {
        insert.run(row.activity_id, RULE.EQUAL_WEIGHT_ELEMENTS,
          `${row.category} on one level are repeating comparable units, so each counts equally. `
          + 'Configured for this activity rather than assumed.');
        continue;
      }
      insert.run(row.activity_id, row.withBoq ? RULE.QUANTITY : RULE.NOT_MEASURABLE,
        row.withBoq
          ? 'Measured by verified quantity against the BOQ item\'s approved quantity.'
          : 'Elements vary in size and no BOQ item is mapped, so no quantity rule can be applied.');
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return rows.length;
}

/* ── observations ──────────────────────────────────────────────────────────────────────────── */

const addDays = (iso, days) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * The verified record of what has been built.
 *
 * Deterministic: an activity's elements are taken in id order and the first N are observed, where
 * N follows from the activity's own state. A-1020 is pinned at 12 of 20, which is the worked
 * example's 60%.
 *
 * A few observations are left DRAFT on purpose — they must not count, and a test holds that.
 */
export function seedObservations(db, { now = () => new Date().toISOString() } = {}) {
  const createdAt = now();
  const activities = db.prepare(
    `SELECT a.source_id, a.name, a.planned_start, a.planned_finish, a.pct_complete,
            r.rule
       FROM activity a LEFT JOIN measurement_rule r ON r.activity_id = a.source_id
      WHERE a.source_system = 'P6' ORDER BY a.source_id`).all();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO progress_observation (activity_id, element_id, observed_on,
        verified_quantity, completion, source, reviewer, evidence_ref, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let written = 0;
  db.exec('BEGIN');
  try {
    for (const activity of activities) {
      const elements = db.prepare(
        `SELECT m.element_id, e.quantity, e.unit FROM mapping m
           JOIN element e ON e.source_id = m.element_id
          WHERE m.activity_id = ? ORDER BY m.element_id`).all(activity.source_id);
      if (!elements.length) continue;

      // How many are built. Pinned for the worked example; elsewhere it trails P6's own claim,
      // which is the point of the comparison — the claim is not the evidence.
      const verified = activity.source_id === 'A-1020'
        ? A1020_VERIFIED
        : Math.round(elements.length * Math.max(0, (activity.pct_complete - 10)) / 100);

      elements.forEach((element, position) => {
        if (position >= verified) return;
        insert.run(activity.source_id, element.element_id,
          addDays(activity.planned_start, position % 7),
          element.quantity, 'COMPLETE', 'Site inspection (synthetic)',
          'Demo Site Engineer P. Raman (synthetic)',
          `DEMO-SNAG-${activity.source_id}-${String(position + 1).padStart(2, '0')}`,
          'VERIFIED', createdAt);
        written += 1;
      });

      // One unverified note per partly-built activity. It must never reach a progress figure.
      if (verified > 0 && verified < elements.length) {
        const pending = elements[verified];
        insert.run(activity.source_id, pending.element_id,
          addDays(activity.planned_start, 8), pending.quantity, 'COMPLETE',
          'Site inspection (synthetic)', 'Demo Site Engineer P. Raman (synthetic)',
          `DEMO-SNAG-${activity.source_id}-DRAFT`, 'DRAFT', createdAt);
        written += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return written;
}

/** Everything Phase 4 adds, in order. Run after the mapping layer is built. */
export function seedProgress(db) {
  return {
    geometry: seedGeometry(db),
    rules: seedMeasurementRules(db),
    observations: seedObservations(db),
  };
}
