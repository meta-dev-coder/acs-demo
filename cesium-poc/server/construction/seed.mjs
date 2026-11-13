/**
 * Tower A — Commercial Building Construction. The synthetic source systems.
 *
 * DETERMINISTIC by construction: one fixed seed through a small PRNG, so every install of this
 * demonstration holds byte-identical data and a rehearsal and a presentation never disagree.
 *
 * It seeds the MOCK SOURCE SYSTEMS ONLY — what a real P6, ACC and SAP would hold. The normalized
 * side stays empty until a synchronisation actually runs, and `sync_run`, `sync_error` and
 * `audit_event` are never seeded at all. An install that has not synced must report "never run",
 * not a manufactured success.
 *
 * The deliberate inconsistencies at the bottom are the Phase 3 and Phase 5 scenarios' raw
 * material. They are listed in `SEEDED_SCENARIOS` so the demonstration can say which flaws are
 * intentional and nobody mistakes one for a bug.
 */

/** Everything in here is invented. Nothing is a real project, cost, quantity or person. */
export const PROJECT = Object.freeze({
  id: 'TOWER-A',
  name: 'Tower A — Commercial Building Construction',
  synthetic: true,
  dataDate: '2026-09-30',
});

/** Change this and the whole dataset changes; leave it and it never does. */
const SEED = 0x7A1E_0001;

/** mulberry32 — small, fast, and identical on every platform and Node version. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];
const round = (value, places = 2) => Number(value.toFixed(places));
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000)
  .toISOString().slice(0, 10);

/* ── the breakdown structure, shared by P6 and SAP ─────────────────────────────────────────── */

const PACKAGES = Object.freeze([
  { code: '1.1', name: 'Substructure', children: ['Piling', 'Pile caps', 'Ground slab'] },
  // Columns is deliberately the third child, so its code is 1.2.3 — the WBS the proposal's own
  // worked example names for "Cast Level 2 columns".
  { code: '1.2', name: 'Superstructure', children: ['Cores and stairs', 'Slabs', 'Columns'] },
  { code: '1.3', name: 'Envelope', children: ['Curtain wall', 'Roofing', 'External doors'] },
  { code: '1.4', name: 'MEP', children: ['HVAC', 'Electrical', 'Plumbing'] },
  { code: '1.5', name: 'Fit-out', children: ['Partitions', 'Finishes', 'Lifts'] },
]);

/** The 21 WBS nodes: the project, five packages, fifteen leaves. */
export function wbsNodes() {
  const nodes = [{ code: '1', parent_code: null, name: PROJECT.name, level: 1 }];
  for (const group of PACKAGES) {
    nodes.push({ code: group.code, parent_code: '1', name: group.name, level: 2 });
    group.children.forEach((child, index) => {
      nodes.push({ code: `${group.code}.${index + 1}`, parent_code: group.code, name: child, level: 3 });
    });
  }
  return nodes;
}

export const leafWbs = () => wbsNodes().filter(node => node.level === 3);

/* ── P6 activities ─────────────────────────────────────────────────────────────────────────── */

const LEVELS = Object.freeze(['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5']);
const ZONES = Object.freeze(['Zone A', 'Zone B', 'Zone C']);
const VERBS = Object.freeze(['Install', 'Cast', 'Erect', 'Fix', 'Commission', 'Survey']);

/**
 * 150 activities over the fifteen leaves, ten each.
 *
 * Progress is staged rather than random: earlier packages are finished, the middle is running and
 * the last is not started, so a schedule view reads like a building going up rather than noise.
 */
export function activities() {
  const random = rng(SEED);
  const leaves = leafWbs();
  const rows = [];
  let n = 1000;
  /*
   * Two activities per work package per level: the work, then its inspection.
   *
   * 15 leaves x 5 levels x 2 = 150, the count the brief asks for, and every one of them is about
   * a real place in the building. The previous shape — ten arbitrary activities per package —
   * meant no activity owned a level, so the twenty Level 2 columns could not all belong to
   * "Cast Level 2 columns".
   */
  leaves.forEach((leaf, leafIndex) => {
    LEVELS.forEach((level, levelIndex) => {
      const start = addDays('2026-01-05', leafIndex * 24 + levelIndex * 4);
      const duration = 4 + Math.floor(random() * 10);
      const finish = addDays(start, duration);
      const done = finish <= PROJECT.dataDate;
      const running = start <= PROJECT.dataDate && finish > PROJECT.dataDate;
      const pct = done ? 100 : running ? Math.round(random() * 70 + 15) : 0;
      for (const [kind, verb] of [['build', BUILD_VERB[leaf.code] ?? 'Install'], ['inspect', 'Inspect']]) {
        n += 10;
        const offset = kind === 'inspect' ? duration : 0;
        rows.push({
          activity_id: `A-${n}`,
          wbs_code: leaf.code,
          kind,
          name: `${verb} ${level} ${leaf.name.toLowerCase()}`,
          calendar: 'Standard 5-day',
          planned_start: addDays(start, offset), planned_finish: addDays(finish, offset),
          baseline_start: addDays(start, offset), baseline_finish: addDays(finish, offset),
          actual_start: pct > 0 ? addDays(start, offset) : null,
          actual_finish: pct === 100 ? addDays(finish, offset) : null,
          pct_complete: pct,
          remaining_duration: round(duration * (1 - pct / 100), 1),
          data_date: PROJECT.dataDate,
          rev: 1,
        });
      }
    });
  });

  /*
   * The worked example must be A-1020, and the generator numbers sequentially, so the id that
   * lands on "Cast Level 2 columns" is swapped with whatever currently holds A-1020. A swap keeps
   * every id unique and the set unchanged; renumbering would move every other activity.
   */
  const columnsLevel2 = rows.find(row => row.wbs_code === '1.2.3' && row.kind === 'build'
    && row.name.includes('Level 2'));
  const holder = rows.find(row => row.activity_id === 'A-1020');
  if (columnsLevel2 && holder && columnsLevel2 !== holder) {
    const wanted = holder.activity_id;
    holder.activity_id = columnsLevel2.activity_id;
    columnsLevel2.activity_id = wanted;
  }
  Object.assign(columnsLevel2, {
    name: 'Cast Level 2 columns',
    planned_start: '2026-04-06', planned_finish: '2026-04-24',
    baseline_start: '2026-04-06', baseline_finish: '2026-04-20',
    actual_start: '2026-04-08', actual_finish: null,
    // Scenario 4: 80% claimed in P6 against the 60% the verified observations support.
    pct_complete: 80, remaining_duration: 3.6,
  });
  return rows.sort((a, b) => a.activity_id.localeCompare(b.activity_id));
}

/** How each package's work is described. The inspection activity always says "Inspect". */
const BUILD_VERB = Object.freeze({
  '1.1.1': 'Drive', '1.1.2': 'Cast', '1.1.3': 'Pour',
  '1.2.1': 'Erect', '1.2.2': 'Pour', '1.2.3': 'Cast',
  '1.3.1': 'Install', '1.3.2': 'Lay', '1.3.3': 'Fit',
  '1.4.1': 'Install', '1.4.2': 'Install', '1.4.3': 'Install',
  '1.5.1': 'Erect', '1.5.2': 'Apply', '1.5.3': 'Install',
});

/* ── ACC / Revit ───────────────────────────────────────────────────────────────────────────── */

export function modelVersions() {
  return [
    { version_id: 'TOWERA-ARC-v3', model_name: 'Tower A Architectural', version: 3,
      published_at: '2026-08-14T09:00:00Z', state: 'PUBLISHED' },
    { version_id: 'TOWERA-STR-v5', model_name: 'Tower A Structural', version: 5,
      published_at: '2026-09-02T11:30:00Z', state: 'PUBLISHED' },
    { version_id: 'TOWERA-MEP-v2', model_name: 'Tower A MEP', version: 2,
      published_at: '2026-09-18T15:45:00Z', state: 'PUBLISHED' },
    // Work in progress. ISO 19650 says it does not leave the authoring team, so INT-03 must not
    // sync it — and a test holds that it does not.
    { version_id: 'TOWERA-STR-v6', model_name: 'Tower A Structural', version: 6,
      published_at: '2026-09-29T08:10:00Z', state: 'WORK_IN_PROGRESS' },
    // A newer PUBLISHED architectural version that drops six walls — scenario 5's raw material.
    // Without a newer published version, "which mappings does a new version invalidate?" has no
    // answer to find.
    { version_id: 'TOWERA-ARC-v4', model_name: 'Tower A Architectural', version: 4,
      published_at: '2026-09-24T10:15:00Z', state: 'PUBLISHED' },
  ];
}

/**
 * The five element categories, each with the WBS leaf that actually builds it.
 *
 * `wbs` is the point. Without it the generator spread every category evenly across all fifteen
 * leaves, so "Cast Level 2 columns" was linked to a duct and a curtain panel — and a 4D sequence
 * built from that shows a duct being cast as part of a column pour.
 */
const CATEGORIES = Object.freeze([
  { prefix: 'COL', category: 'Structural Columns', discipline: 'Structural', unit: 'm3',
    model: 'TOWERA-STR-v5', wbs: '1.2.3' },
  { prefix: 'SLB', category: 'Floors', discipline: 'Structural', unit: 'm2',
    model: 'TOWERA-STR-v5', wbs: '1.2.2' },
  { prefix: 'WAL', category: 'Walls', discipline: 'Architectural', unit: 'm2',
    model: 'TOWERA-ARC-v3', wbs: '1.5.1' },
  { prefix: 'CWL', category: 'Curtain Panels', discipline: 'Architectural', unit: 'm2',
    model: 'TOWERA-ARC-v3', wbs: '1.3.1' },
  { prefix: 'DCT', category: 'Ducts', discipline: 'MEP', unit: 'm',
    model: 'TOWERA-MEP-v2', wbs: '1.4.1' },
]);

/**
 * 500 elements, 100 of each category, each naming the activity that builds it.
 *
 * COL-001 is pinned to the proposal's own worked example rather than generated, because that is
 * the record the demonstration is narrated around.
 */
/** Walls dropped by the newer architectural version. Their mappings go stale, by design. */
export const REMOVED_IN_ARC_V4 = Object.freeze(
  ['WAL-004', 'WAL-017', 'WAL-032', 'WAL-055', 'WAL-078', 'WAL-091']);

export function elements() {
  const random = rng(SEED ^ 0x5EED);
  const leafByCode = new Map(leafWbs().map(leaf => [leaf.code, leaf]));
  const activityRows = activities();
  const byLeaf = new Map(leafWbs().map(leaf => [leaf.code, []]));
  for (const activity of activityRows) byLeaf.get(activity.wbs_code).push(activity);

  /**
   * The activity on this leaf that builds this level.
   *
   * Preferred by the level named in the activity's own description, so "Cast Level 2 columns"
   * takes the Level 2 columns and nothing else. Where no activity names the level, the leaf's
   * activities are shared out by level index, which is still coherent and still deterministic.
   */
  const activityFor = (leafCode, level) => {
    const candidates = (byLeaf.get(leafCode) ?? [])
      .filter(entry => entry.kind === 'build' && entry.name.includes(level));
    return candidates[0]?.activity_id ?? null;
  };

  const rows = [];
  for (const spec of CATEGORIES) {
    const leaf = leafByCode.get(spec.wbs);
    for (let index = 1; index <= 100; index += 1) {
      const level = LEVELS[index % LEVELS.length];
      rows.push({
        element_id: `${spec.prefix}-${String(index).padStart(3, '0')}`,
        version_id: spec.model,
        boq_ref: null,
        category: spec.category,
        level,
        zone: ZONES[index % ZONES.length],
        discipline: spec.discipline,
        work_package: leaf.name,
        quantity: round(1 + random() * 40),
        unit: spec.unit,
        activity_ref: activityFor(spec.wbs, level),
      });
    }
  }
  // The proposal's worked example: COL-001 at Tower A Level 2 → A-1020 → WBS 1.2.3 → BOQ CON-045.
  const example = rows.find(row => row.element_id === 'COL-001');
  Object.assign(example, {
    version_id: 'TOWERA-STR-v5', category: 'Structural Columns', level: 'Level 2', zone: 'Zone A',
    discipline: 'Structural', work_package: 'Columns', quantity: 12.4, unit: 'm3',
    activity_ref: 'A-1020', boq_ref: 'CON-045',
  });

  // The architectural model's newer published version. It carries the same walls and panels
  // except the six it dropped, so the older version remains the only record of those.
  const arcV4 = rows
    .filter(row => row.version_id === 'TOWERA-ARC-v3' && !REMOVED_IN_ARC_V4.includes(row.element_id))
    .map(row => ({ ...row, version_id: 'TOWERA-ARC-v4' }));
  rows.push(...arcV4);
  return rows;
}

/**
 * Give most elements the cost code their model carries, and leave some without.
 *
 * Assigned from the BOQ items under the element's own WBS, deterministically. Roughly one in
 * twelve is left null: the modeller did not set one, so the choice falls to a reviewer rather
 * than to a guess — which is what keeps NEEDS_SELECTION a real state rather than a theoretical one.
 */
function assignCostCodes({ elementRows, activityRows, boqRows }) {
  const random = rng(SEED ^ 0xC0DE);
  const wbsOfActivity = new Map(activityRows.map(row => [row.activity_id, row.wbs_code]));
  const boqByWbs = new Map();
  for (const item of boqRows) {
    const list = boqByWbs.get(item.sap_wbs_code) ?? [];
    list.push(item);
    boqByWbs.set(item.sap_wbs_code, list);
  }
  const unitOf = new Map(boqRows.map(item => [item.code, item.unit]));

  // Decided ONCE PER ELEMENT, not per row. The same element appears in two model versions, and
  // deciding per row gave it a cost code in one version and none in the other — an inconsistency
  // nothing in the story justified.
  const byElement = new Map();
  for (const row of elementRows) {
    if (!byElement.has(row.element_id)) byElement.set(row.element_id, []);
    byElement.get(row.element_id).push(row);
  }

  const codeFor = new Map();
  let index = 0;
  for (const [elementId, rows] of byElement) {
    index += 1;
    const first = rows[0];
    if (first.boq_ref) { codeFor.set(elementId, first.boq_ref); continue; }
    const wbs0 = first.activity_ref ? wbsOfActivity.get(first.activity_ref) : null;
    // One in twelve has no code, so a reviewer has something to choose — except on the package
    // that is measured end to end, which is what gives a complete-coverage valuation a subject.
    if (index % 12 === 0 && wbs0 !== FULLY_PRICED_WBS) continue;
    const wbs = first.activity_ref ? wbsOfActivity.get(first.activity_ref) : null;
    const candidates = wbs ? boqByWbs.get(wbs) ?? [] : [];
    // Only a cost code measured in the element's own unit. Where the WBS offers none, the model
    // carries no code and the choice falls to a reviewer — which is what a modeller would do.
    const sameUnit = candidates.filter(item => item.unit === first.unit);
    if (!sameUnit.length) continue;
    codeFor.set(elementId, sameUnit[Math.floor(random() * sameUnit.length) % sameUnit.length].code);
  }

  // Scenario 6: a few elements measured in a unit their BOQ item does not use. A real finding for
  // Finance, and the only way the unit rule has anything to catch. The worked example is never
  // touched — COL-001 → CON-045 is the chain the demonstration is narrated around.
  let mismatched = 0;
  for (const [elementId, rows] of byElement) {
    if (mismatched >= 6 || elementId === 'COL-001') continue;
    const code = codeFor.get(elementId);
    if (!code || unitOf.get(code) !== rows[0].unit) continue;
    const wbs = rows[0].activity_ref ? wbsOfActivity.get(rows[0].activity_ref) : null;
    const other = (boqByWbs.get(wbs) ?? []).find(item => item.unit !== rows[0].unit);
    if (!other) continue;
    codeFor.set(elementId, other.code);
    mismatched += 1;
  }

  for (const [elementId, rows] of byElement) {
    for (const row of rows) row.boq_ref = codeFor.get(elementId) ?? null;
  }
  return elementRows;
}

/* ── SAP ───────────────────────────────────────────────────────────────────────────────────── */

export function sapWbs() {
  // Same codes as P6, which is what lets schedule and cost compare like for like.
  return wbsNodes().map(node => ({ code: node.code, parent_code: node.parent_code, name: node.name }));
}

export function sapCosts() {
  const random = rng(SEED ^ 0xC057);
  return leafWbs().map(leaf => {
    const budget = Math.round((400_000 + random() * 2_600_000) / 1000) * 1000;
    const planned = Math.round(budget * (0.85 + random() * 0.14));
    return {
      sap_wbs_code: leaf.code, budget, planned_cost: planned,
      actual_cost: Math.round(planned * (0.2 + random() * 0.7)),
      currency: 'INR',
    };
  });
}

/**
 * 50 BOQ items across the fifteen leaves. CON-045 is the worked example's.
 *
 * A leaf's items are measured in the unit its elements are modelled in — columns in m3, slabs and
 * walls in m2, ducts in m — because that is what a bill of quantities does. Drawing the unit at
 * random left three of the five modelled packages with no item an element could ever be priced
 * against, so sixty per cent of the building could not be valued at all.
 *
 * One item per leaf is deliberately measured in a different unit, so the unit-mismatch rule and
 * the coverage gap still have real material.
 */
const LEAF_UNIT = Object.freeze({
  '1.2.3': 'm3', '1.2.2': 'm2', '1.3.1': 'm2', '1.4.1': 'm', '1.5.1': 'm2',
});

export function boqItems() {
  const random = rng(SEED ^ 0xB0B0);
  const leaves = leafWbs();
  const seenLeaf = new Map();
  const rows = [];
  for (let index = 1; index <= 50; index += 1) {
    const leaf = leaves[index % leaves.length];
    const nth = (seenLeaf.get(leaf.code) ?? 0) + 1;
    seenLeaf.set(leaf.code, nth);
    const native = LEAF_UNIT[leaf.code] ?? pick(random, ['m3', 'm2', 'm', 'nr', 't']);
    // The third item on a modelled leaf is off-unit on purpose; the rest match.
    const unit = nth === 3 && LEAF_UNIT[leaf.code] ? 'nr' : native;
    rows.push({
      code: `CON-${String(index).padStart(3, '0')}`,
      description: `${leaf.name} — measured works item ${index}`,
      sap_wbs_code: leaf.code,
      quantity: round(50 + random() * 900, 1),
      unit,
      unit_rate: round(300 + random() * 9000),
    });
  }
  const example = rows.find(row => row.code === 'CON-045');
  Object.assign(example, {
    description: 'Cast in-situ concrete columns, Grade M40',
    sap_wbs_code: '1.2.3', quantity: 420, unit: 'm3', unit_rate: 8450,
  });
  return rows;
}

/**
 * The package that is fully measured.
 *
 * Every other leaf leaves roughly one element in twelve without a cost code, which is the
 * realistic case and the one the coverage gap demonstrates. Curtain wall is measured end to end,
 * so a complete-coverage earned value has a subject.
 */
export const FULLY_PRICED_WBS = '1.3.1';

/**
 * The flaws that are on purpose.
 *
 * Seeded so Phases 3 and 5 have something real to detect, and declared here so a reviewer can
 * tell an intentional inconsistency from a defect.
 */
export const SEEDED_SCENARIOS = Object.freeze([
  Object.freeze({ id: 'unpublished-model-version', scenario: 8,
    detail: 'TOWERA-STR-v6 is WORK_IN_PROGRESS. INT-03 must not sync it.' }),
  Object.freeze({ id: 'element-without-activity', scenario: 2,
    detail: 'Five structural elements carry no activity reference, so no BIM-to-P6 mapping exists.' }),
  Object.freeze({ id: 'wbs-mismatch', scenario: 3,
    detail: 'One SAP WBS code has no P6 counterpart, so schedule and cost cannot be compared for it.' }),
  Object.freeze({ id: 'element-removed-in-new-version', scenario: 5,
    detail: 'TOWERA-ARC-v4 is published and drops six walls that v3 carried. Their mappings go stale.' }),
  Object.freeze({ id: 'partial-boq-coverage', scenario: 9,
    detail: 'Roughly one element in twelve carries no cost code, so most packages can only be '
      + 'valued partially. Curtain wall (1.3.1) is measured end to end.' }),
  Object.freeze({ id: 'unit-mismatch', scenario: 6,
    detail: 'Six elements are modelled in a unit their BOQ item does not measure in.' }),
  Object.freeze({ id: 'boq-not-set', scenario: 7,
    detail: 'Roughly one element in twelve carries no cost code, so its BOQ item is a reviewer\'s choice.' }),
  Object.freeze({ id: 'progress-overstated', scenario: 4,
    detail: 'A-1020 "Cast Level 2 columns" reports 80% planned progress; the model can verify 60%.' }),
]);

/** Apply the deliberate inconsistencies on top of the clean dataset. */
function applyScenarios({ elementRows, sapWbsRows, activityRows }) {
  // 2 — elements with nothing to map to.
  //
  // EVERY row for the element, not the first. An architectural element exists once per published
  // model version, and the adapter syncs the newest — so nulling only the v3 copy left the v4 one
  // mapped and the scenario silently applied to three elements instead of five.
  const withoutActivity = new Set(['SLB-007', 'SLB-023', 'WAL-011', 'DCT-004', 'CWL-061']);
  for (const row of elementRows) {
    if (withoutActivity.has(row.element_id)) row.activity_ref = null;
  }
  // 3 — a SAP cost centre P6 does not carry.
  sapWbsRows.push({ code: '1.6', parent_code: '1', name: 'Site establishment (SAP only)' });
  // Scenario 4 — A-1020 reports 80% planned against the 60% the model can verify. Its identity
  // and dates are pinned in activities(); only the claim about progress belongs here.
  return { elementRows, sapWbsRows, activityRows };
}

/** The whole synthetic source dataset, assembled once. */
export function buildSeed() {
  const activityRows = activities();
  const elementRows = elements();
  const sapWbsRows = sapWbs();
  applyScenarios({ elementRows, sapWbsRows, activityRows });
  const boqRows = boqItems();
  assignCostCodes({ elementRows, activityRows, boqRows });
  const costRows = sapCosts();
  // The SAP-only WBS carries a budget too, or the mismatch would show as missing cost instead.
  costRows.push({ sap_wbs_code: '1.6', budget: 750_000, planned_cost: 700_000,
    actual_cost: 412_000, currency: 'INR' });
  return {
    project: PROJECT,
    p6Wbs: wbsNodes(),
    p6Activities: activityRows,
    accModelVersions: modelVersions(),
    accElements: elementRows,
    sapWbs: sapWbsRows,
    sapCosts: costRows,
    sapBoq: boqRows,
  };
}

/** Write the source systems. Idempotent: it replaces the mock sources, never the synced side. */
export function seedSourceSystems(db, data = buildSeed()) {
  const insert = (table, columns, rows) => {
    const statement = db.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    for (const row of rows) statement.run(...columns.map(column => row[column] ?? null));
  };
  db.exec('BEGIN');
  try {
    insert('src_p6_wbs', ['code', 'parent_code', 'name', 'level'], data.p6Wbs);
    insert('src_p6_activity', ['activity_id', 'wbs_code', 'name', 'calendar', 'planned_start',
      'planned_finish', 'baseline_start', 'baseline_finish', 'actual_start', 'actual_finish',
      'pct_complete', 'remaining_duration', 'data_date', 'rev'], data.p6Activities);
    insert('src_acc_model_version', ['version_id', 'model_name', 'version', 'published_at', 'state'],
      data.accModelVersions);
    insert('src_acc_element', ['element_id', 'version_id', 'category', 'level', 'zone', 'discipline',
      'work_package', 'quantity', 'unit', 'activity_ref', 'boq_ref'], data.accElements);
    insert('src_sap_wbs', ['code', 'parent_code', 'name'], data.sapWbs);
    insert('src_sap_cost', ['sap_wbs_code', 'budget', 'planned_cost', 'actual_cost', 'currency'],
      data.sapCosts);
    insert('src_sap_boq', ['code', 'description', 'sap_wbs_code', 'quantity', 'unit', 'unit_rate'],
      data.sapBoq);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return data;
}
