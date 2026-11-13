/**
 * The source-system adapters.
 *
 * ONE CONTRACT, so a mock and a real client are interchangeable. An adapter knows how to talk to
 * its system and nothing else: it does not write to the integration tables, does not decide what
 * is new, and does not know a sync run exists. Replacing `createMockP6Adapter` with a client that
 * calls a real P6 REST endpoint is a change to this file alone.
 *
 * INBOUND adapters implement `fetch`. OUTBOUND adapters (INT-02, INT-05) declare themselves and
 * refuse to post from here: write-back runs through the approval-controlled path in
 * `destinations.mjs`, which will not write without an approved proposal and six passing checks.
 * An adapter that quietly posted would be a way round that gate.
 */

export const SYSTEMS = Object.freeze({
  P6: 'P6', ACC: 'ACC', SAP: 'SAP', SYNCHRO: 'SYNCHRO',
});

export const DIRECTION = Object.freeze({ INBOUND: 'INBOUND', OUTBOUND: 'OUTBOUND' });

/** The five pilot interfaces, exactly as the proposal numbers them. */
export const INTERFACES = Object.freeze([
  Object.freeze({ id: 'INT-01', direction: DIRECTION.INBOUND, from: SYSTEMS.P6, to: SYSTEMS.SYNCHRO,
    label: 'P6 → SYNCHRO 4D',
    moves: 'Project, WBS, activities, calendars, baselines, data date, progress',
    control: 'Automated sync at a configurable frequency; baseline kept separate from updates' }),
  Object.freeze({ id: 'INT-02', direction: DIRECTION.OUTBOUND, from: SYSTEMS.SYNCHRO, to: SYSTEMS.P6,
    label: 'SYNCHRO 4D → P6',
    moves: 'Actual start and finish, % complete, remaining duration, agreed quantities',
    control: 'Planner approves; held and flagged if the P6 value changed since last read',
    approver: 'Project Planner (P6)' }),
  Object.freeze({ id: 'INT-03', direction: DIRECTION.INBOUND, from: SYSTEMS.ACC, to: SYSTEMS.SYNCHRO,
    label: 'ACC / Revit → SYNCHRO 4D',
    moves: 'Published model versions, element IDs, agreed properties',
    control: 'BIM Coordinator confirms each new version; no writes to ACC or Revit' }),
  Object.freeze({ id: 'INT-04', direction: DIRECTION.INBOUND, from: SYSTEMS.SAP, to: SYSTEMS.SYNCHRO,
    label: 'SAP → SYNCHRO 4D',
    moves: 'WBS elements, budget, planned and actual cost, approved BOQ quantities and unit rates',
    control: 'SAP stays the only cost ledger' }),
  Object.freeze({ id: 'INT-05', direction: DIRECTION.OUTBOUND, from: SYSTEMS.SYNCHRO, to: SYSTEMS.SAP,
    label: 'SYNCHRO 4D → SAP',
    moves: 'Approved physical progress and earned value by WBS',
    control: 'Finance controller approves; proven in the SAP quality client during the pilot',
    approver: 'Finance Controller' }),
]);

export const interfaceById = id => INTERFACES.find(entry => entry.id === id) ?? null;

/** How write-back works, as a value, so a screen prints the reason rather than guessing it. */
export const WRITE_BACK_STATUS = Object.freeze({
  implemented: true,
  simulated: true,
  reason: 'Write-back is approval-controlled and simulated. A proposal is approved by its own '
    + 'data owner — the planner for INT-02, the Finance controller for INT-05 — and six checks '
    + 'run immediately before posting. The destinations are mock P6 and mock SAP; no live system '
    + 'is contacted.',
  /** The adapters themselves still refuse: posting has one path, and this is not it. */
  adapterRefuses: 'Posting runs through the approval gate, never through an adapter.',
});

const METHODS = Object.freeze(['describe', 'fetch']);

/** An adapter implements the whole contract or it is not one. */
export function assertAdapter(adapter, name = 'adapter') {
  if (!adapter?.system) throw new TypeError(`${name} must declare the system it talks to`);
  if (!adapter?.interfaceId) throw new TypeError(`${name} must declare its interface`);
  if (adapter.direction === DIRECTION.OUTBOUND) {
    if (typeof adapter.post !== 'function') throw new TypeError(`${name} must declare post()`);
    return adapter;
  }
  const missing = METHODS.filter(method => typeof adapter[method] !== 'function');
  if (missing.length) throw new TypeError(`${name} is missing: ${missing.join(', ')}`);
  return adapter;
}

/**
 * A batch, as every inbound adapter returns it.
 *
 * `entity` names the normalized table the records belong in; `key` is the column that carries the
 * source identifier. The sync engine needs nothing else to upsert them, which is what keeps it
 * free of per-system knowledge.
 */
const batch = ({ entity, key, records, now }) => Object.freeze({
  entity, key, records: Object.freeze(records), fetchedAt: now,
});

const nowIso = () => new Date().toISOString();

/* ── P6 (INT-01) ───────────────────────────────────────────────────────────────────────────── */

export function createMockP6Adapter(db, { now = nowIso } = {}) {
  return assertAdapter({
    system: SYSTEMS.P6,
    interfaceId: 'INT-01',
    direction: DIRECTION.INBOUND,
    origin: 'MOCK',
    describe: () => ({ system: SYSTEMS.P6, origin: 'MOCK', entities: ['wbs', 'activity'],
      note: 'Reads the src_p6_* tables. Swap for a Primavera P6 REST client.' }),
    fetch() {
      const at = now();
      return [
        batch({ entity: 'wbs', key: 'code', now: at,
          records: db.prepare('SELECT code, parent_code, name, level FROM src_p6_wbs ORDER BY code').all()
            .map(row => ({ source_id: row.code, parent_source_id: row.parent_code,
              name: row.name, level: row.level, source_rev: 1 })) }),
        batch({ entity: 'activity', key: 'activity_id', now: at,
          records: db.prepare('SELECT * FROM src_p6_activity ORDER BY activity_id').all()
            .map(row => ({
              source_id: row.activity_id, wbs_code: row.wbs_code, name: row.name,
              calendar: row.calendar,
              planned_start: row.planned_start, planned_finish: row.planned_finish,
              // The baseline travels in its own columns and is never overwritten by an update,
              // which is INT-01's stated control.
              baseline_start: row.baseline_start, baseline_finish: row.baseline_finish,
              actual_start: row.actual_start, actual_finish: row.actual_finish,
              pct_complete: row.pct_complete, remaining_duration: row.remaining_duration,
              data_date: row.data_date, source_rev: row.rev,
            })) }),
      ];
    },
  }, 'P6 adapter');
}

/* ── ACC / Revit (INT-03) ──────────────────────────────────────────────────────────────────── */

export function createMockAccAdapter(db, { now = nowIso } = {}) {
  return assertAdapter({
    system: SYSTEMS.ACC,
    interfaceId: 'INT-03',
    direction: DIRECTION.INBOUND,
    origin: 'MOCK',
    /** Stated on the adapter because it is the adapter's rule, not the engine's. */
    readOnlyTarget: 'ACC and Revit are never written to.',
    describe: () => ({ system: SYSTEMS.ACC, origin: 'MOCK', entities: ['model_version', 'element'],
      note: 'Reads the src_acc_* tables. Swap for an Autodesk Construction Cloud client.' }),
    fetch() {
      const at = now();
      // Published only. ISO 19650 keeps work-in-progress inside the authoring team, and a 4D
      // sequence built on an unpublished model is a sequence nobody has agreed to.
      const versions = db.prepare(
        "SELECT * FROM src_acc_model_version WHERE state = 'PUBLISHED' ORDER BY version_id").all();
      /*
       * One row per element: the newest PUBLISHED version of its model that still contains it.
       *
       * An element the newest version dropped is still carried, from the last published version
       * that had it. Dropping it here instead would delete its mapping silently; carrying it lets
       * the validation say "this is no longer in the current model" and let a person decide.
       */
      const elements = versions.length
        ? db.prepare(
          `SELECT e.* FROM src_acc_element e
             JOIN src_acc_model_version v ON v.version_id = e.version_id
            WHERE v.state = 'PUBLISHED'
              AND v.version = (SELECT MAX(v2.version) FROM src_acc_element e2
                                 JOIN src_acc_model_version v2 ON v2.version_id = e2.version_id
                                WHERE e2.element_id = e.element_id AND v2.state = 'PUBLISHED'
                                  AND v2.model_name = v.model_name)
            ORDER BY e.element_id`).all()
        : [];
      return [
        batch({ entity: 'model_version', key: 'version_id', now: at,
          records: versions.map(row => ({ source_id: row.version_id, model_name: row.model_name,
            version: row.version, published_at: row.published_at, state: row.state,
            source_rev: row.version })) }),
        batch({ entity: 'element', key: 'element_id', now: at,
          records: elements.map(row => ({ source_id: row.element_id, model_version_id: row.version_id,
            category: row.category, level: row.level, zone: row.zone, discipline: row.discipline,
            work_package: row.work_package, quantity: row.quantity, unit: row.unit,
            activity_ref: row.activity_ref, boq_ref: row.boq_ref, source_rev: 1 })) }),
      ];
    },
  }, 'ACC adapter');
}

/* ── SAP (INT-04) ──────────────────────────────────────────────────────────────────────────── */

export function createMockSapAdapter(db, { now = nowIso } = {}) {
  return assertAdapter({
    system: SYSTEMS.SAP,
    interfaceId: 'INT-04',
    direction: DIRECTION.INBOUND,
    origin: 'MOCK',
    describe: () => ({ system: SYSTEMS.SAP, origin: 'MOCK', entities: ['wbs', 'cost', 'boq_item'],
      note: 'Reads the src_sap_* tables. SAP stays the only cost ledger.' }),
    fetch() {
      const at = now();
      return [
        batch({ entity: 'wbs', key: 'code', now: at,
          records: db.prepare('SELECT code, parent_code, name FROM src_sap_wbs ORDER BY code').all()
            .map(row => ({ source_id: row.code, parent_source_id: row.parent_code,
              name: row.name, level: row.code.split('.').length, source_rev: 1 })) }),
        batch({ entity: 'cost', key: 'sap_wbs_code', now: at,
          records: db.prepare('SELECT * FROM src_sap_cost ORDER BY sap_wbs_code').all()
            .map(row => ({ source_id: row.sap_wbs_code, budget: row.budget,
              planned_cost: row.planned_cost, actual_cost: row.actual_cost,
              currency: row.currency, source_rev: 1 })) }),
        batch({ entity: 'boq_item', key: 'code', now: at,
          records: db.prepare('SELECT * FROM src_sap_boq ORDER BY code').all()
            .map(row => ({ source_id: row.code, description: row.description,
              sap_wbs_code: row.sap_wbs_code, quantity: row.quantity, unit: row.unit,
              unit_rate: row.unit_rate, source_rev: 1 })) }),
      ];
    },
  }, 'SAP adapter');
}

/* ── the two outbound interfaces ───────────────────────────────────────────────────────────── */

/**
 * An outbound adapter that refuses.
 *
 * Present so the Integration Overview can show all five interfaces honestly: these two exist, they
 * are approval-controlled, and they do not post yet. `post` throws rather than returning a success
 * nobody earned.
 */
function outbound(interfaceId, system) {
  const definition = interfaceById(interfaceId);
  return assertAdapter({
    system,
    interfaceId,
    direction: DIRECTION.OUTBOUND,
    origin: 'MOCK',
    approver: definition.approver,
    writeBack: WRITE_BACK_STATUS,
    describe: () => ({ system, origin: 'MOCK', entities: [],
      note: `${definition.label}. ${WRITE_BACK_STATUS.reason}` }),
    post() {
      throw new Error(`${interfaceId}: ${WRITE_BACK_STATUS.adapterRefuses} Raise a proposal and `
        + `have ${definition.approver} approve it.`);
    },
  }, `${interfaceId} adapter`);
}

export const createMockP6WriteAdapter = () => outbound('INT-02', SYSTEMS.P6);
export const createMockSapWriteAdapter = () => outbound('INT-05', SYSTEMS.SAP);

/** Every adapter, by interface id. */
export function createMockAdapters(db, options = {}) {
  return new Map([
    ['INT-01', createMockP6Adapter(db, options)],
    ['INT-02', createMockP6WriteAdapter()],
    ['INT-03', createMockAccAdapter(db, options)],
    ['INT-04', createMockSapAdapter(db, options)],
    ['INT-05', createMockSapWriteAdapter()],
  ]);
}
