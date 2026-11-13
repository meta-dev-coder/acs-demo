/**
 * The Construction Integration Demo's own SQLite database.
 *
 * SEPARATE BY CONSTRUCTION. Its own file, its own tables, its own module. I-595 has no database at
 * all — its data is committed JSON and DataConnect — so nothing here can reach it, and deleting
 * this file removes this project's state and nothing else.
 *
 * `node:sqlite` rather than better-sqlite3: it ships with Node, so the demo needs no native build.
 * It is still flagged experimental, which is why every call lives behind this module — swapping
 * the driver is a change to `open()` and nothing above it.
 *
 * TWO LAYERS, and the separation is the point:
 *
 *   src_*  the MOCK SOURCE SYSTEMS. What a real P6, ACC or SAP would return over its API. The
 *          adapters read these and nothing else, so replacing an adapter with a real client
 *          changes no table above it.
 *   the rest  the NORMALIZED INTEGRATION DATA — what SYNCHRO 4D holds after an inbound sync, each
 *          row carrying the system and identifier it came from.
 *
 * Nothing in here records a synchronisation that did not happen: `sync_run`, `sync_error` and
 * `audit_event` are written only by a real run, so an un-synced install reports "never run"
 * rather than a seeded success.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Beside the repository's other local state, never inside `public/`. Override for tests. */
export const DEFAULT_DB_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)), '../../.data/construction-integration.sqlite');

export const SCHEMA_VERSION = 11;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

/* ── mock source systems ──────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS src_p6_wbs (
  code TEXT PRIMARY KEY, parent_code TEXT, name TEXT NOT NULL, level INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS src_p6_activity (
  activity_id TEXT PRIMARY KEY,
  wbs_code TEXT NOT NULL REFERENCES src_p6_wbs(code),
  name TEXT NOT NULL,
  calendar TEXT NOT NULL,
  planned_start TEXT NOT NULL, planned_finish TEXT NOT NULL,
  baseline_start TEXT NOT NULL, baseline_finish TEXT NOT NULL,
  actual_start TEXT, actual_finish TEXT,
  pct_complete REAL NOT NULL,
  remaining_duration REAL NOT NULL,
  data_date TEXT NOT NULL,
  /* Bumped whenever the mock P6 record changes. INT-02's conflict check reads it in Phase 5. */
  rev INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS src_acc_model_version (
  version_id TEXT PRIMARY KEY, model_name TEXT NOT NULL, version INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  /* ISO 19650 information state. Only PUBLISHED may sync; work-in-progress stays out. */
  state TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS src_acc_element (
  element_id TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES src_acc_model_version(version_id),
  category TEXT NOT NULL, level TEXT NOT NULL, zone TEXT NOT NULL,
  discipline TEXT NOT NULL, work_package TEXT NOT NULL,
  quantity REAL, unit TEXT,
  /* The activity that builds it, as the model's own property. Null is a real gap, not an error. */
  activity_ref TEXT,
  /* The cost code the model carries, which is how an element reaches a BOQ item. Null where the
     modeller did not set one, which leaves the choice to a reviewer rather than to a guess. */
  boq_ref TEXT,
  PRIMARY KEY (element_id, version_id));

CREATE TABLE IF NOT EXISTS src_sap_wbs (
  code TEXT PRIMARY KEY, parent_code TEXT, name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS src_sap_cost (
  sap_wbs_code TEXT PRIMARY KEY REFERENCES src_sap_wbs(code),
  budget REAL NOT NULL, planned_cost REAL NOT NULL, actual_cost REAL NOT NULL,
  currency TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS src_sap_boq (
  code TEXT PRIMARY KEY, description TEXT NOT NULL,
  sap_wbs_code TEXT NOT NULL REFERENCES src_sap_wbs(code),
  quantity REAL NOT NULL, unit TEXT NOT NULL, unit_rate REAL NOT NULL);

/* ── normalized integration data (what SYNCHRO 4D holds) ──────────────────────────────────── */

CREATE TABLE IF NOT EXISTS wbs (
  source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  parent_source_id TEXT, name TEXT NOT NULL, level INTEGER,
  source_rev INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL, sync_run_id INTEGER NOT NULL,
  PRIMARY KEY (source_system, source_id));

CREATE TABLE IF NOT EXISTS activity (
  source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  wbs_code TEXT NOT NULL, name TEXT NOT NULL, calendar TEXT,
  planned_start TEXT, planned_finish TEXT, baseline_start TEXT, baseline_finish TEXT,
  actual_start TEXT, actual_finish TEXT,
  pct_complete REAL, remaining_duration REAL, data_date TEXT,
  source_rev INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL, sync_run_id INTEGER NOT NULL,
  PRIMARY KEY (source_system, source_id));

CREATE TABLE IF NOT EXISTS model_version (
  source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  model_name TEXT NOT NULL, version INTEGER NOT NULL, published_at TEXT NOT NULL, state TEXT NOT NULL,
  source_rev INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL, sync_run_id INTEGER NOT NULL,
  PRIMARY KEY (source_system, source_id));

CREATE TABLE IF NOT EXISTS element (
  source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  model_version_id TEXT NOT NULL, category TEXT, level TEXT, zone TEXT,
  discipline TEXT, work_package TEXT, quantity REAL, unit TEXT, activity_ref TEXT, boq_ref TEXT,
  source_rev INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL, sync_run_id INTEGER NOT NULL,
  PRIMARY KEY (source_system, source_id));

CREATE TABLE IF NOT EXISTS boq_item (
  source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  description TEXT NOT NULL, sap_wbs_code TEXT NOT NULL,
  quantity REAL NOT NULL, unit TEXT NOT NULL, unit_rate REAL NOT NULL,
  source_rev INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL, sync_run_id INTEGER NOT NULL,
  PRIMARY KEY (source_system, source_id));

CREATE TABLE IF NOT EXISTS cost (
  source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  budget REAL NOT NULL, planned_cost REAL NOT NULL, actual_cost REAL NOT NULL, currency TEXT NOT NULL,
  source_rev INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL, sync_run_id INTEGER NOT NULL,
  PRIMARY KEY (source_system, source_id));

/* ── runs, errors and the audit trail: written only by something that actually happened ───── */

CREATE TABLE IF NOT EXISTS sync_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interface_id TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL,
  records_read INTEGER NOT NULL DEFAULT 0,
  records_created INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  records_unchanged INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sync_error (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id INTEGER NOT NULL REFERENCES sync_run(id) ON DELETE CASCADE,
  interface_id TEXT NOT NULL, severity TEXT NOT NULL,
  record_ref TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL);

/*
 * The audit trail's own events.
 *
 * The four columns after "detail" were added in Phase 6. They were previously buried in the
 * free-form "detail" JSON under whatever key each call site happened to use, which meant the
 * trail could not be filtered by record or correlation id, and "what changed" could not be shown
 * in a column. "detail" is still there for whatever else an event wants to carry.
 *
 * This is the only store Phase 6 extended. The unified trail MERGES this with exception_event,
 * outbound_transition, mapping_proposal and sync_run at read time — each stays its own source of
 * truth, and nothing is copied into a second audit table to drift from the first.
 */
CREATE TABLE IF NOT EXISTS audit_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL,
  interface_id TEXT, sync_run_id INTEGER, detail TEXT,
  /* The record the event is about — an activity, an element, a WBS, a proposal. */
  subject_id TEXT,
  previous_state TEXT,
  new_state TEXT,
  result TEXT,
  correlation_id TEXT);


/* ── Phase 3: the integration-owned mapping layer ─────────────────────────────────────────── */

/*
 * One row per BIM element — the chain's anchor.
 *
 * INTEGRATION-OWNED, and that is the whole point: correcting a mapping writes here and never to a
 * src_* table. "*_basis" says where each link came from, so a link the source published and a link
 * a reviewer approved are never confused.
 *
 * The chain is DERIVED where the source already carries it (element.activity_ref,
 * activity.wbs_code, boq_item.sap_wbs_code) and only decided here where it does not: the
 * P6-to-SAP WBS correspondence, and the choice among the several BOQ items a WBS can carry.
 */
CREATE TABLE IF NOT EXISTS mapping (
  element_id TEXT PRIMARY KEY,
  model_version_id TEXT,
  activity_id TEXT,
  activity_basis TEXT,
  p6_wbs_code TEXT,
  sap_wbs_code TEXT,
  boq_code TEXT,
  boq_basis TEXT,
  /* How many BOQ items the WBS offers. 1 is a mapping; more is a choice nobody has made. */
  boq_candidates INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  source_rev TEXT,
  built_at TEXT NOT NULL,
  build_id INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS mapping_build (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  elements INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL);

/*
 * Every validation result, keyed so a repeat run updates rather than appends.
 *
 * "first_seen" survives; "last_seen" moves. That is what makes "has this been wrong since the
 * first sync, or did it appear yesterday?" answerable.
 */
CREATE TABLE IF NOT EXISTS validation_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_key TEXT NOT NULL UNIQUE,
  rule_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  expected TEXT, actual TEXT,
  explanation TEXT NOT NULL,
  source_rev TEXT,
  status TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  cleared_at TEXT);

CREATE TABLE IF NOT EXISTS validation_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  subjects_checked INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  cleared INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL);

/*
 * Exceptions, with a STABLE IDENTITY: one per (rule, subject), for the life of the project.
 *
 * A sync that runs fifty times must not leave fifty copies of the same finding. A resolved
 * exception stays, and a finding that comes back reopens the row it had before with a new event
 * in its history rather than starting a fresh one with no past.
 */
CREATE TABLE IF NOT EXISTS exception (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exception_key TEXT NOT NULL UNIQUE,
  rule_id TEXT NOT NULL,
  interface_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  status TEXT NOT NULL,
  first_detected TEXT NOT NULL,
  last_detected TEXT NOT NULL,
  resolved_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS exception_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exception_id INTEGER NOT NULL REFERENCES exception(id) ON DELETE CASCADE,
  at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL,
  from_status TEXT, to_status TEXT, detail TEXT);

/*
 * A proposed mapping change, and its decision.
 *
 * "source_rev_at_proposal" is read again immediately before applying: if the source has moved
 * since the proposal was raised, the change is HELD rather than posted over a value nobody
 * reviewed. That is the same control INT-02 will use in Phase 5.
 */
CREATE TABLE IF NOT EXISTS mapping_proposal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  element_id TEXT NOT NULL,
  field TEXT NOT NULL,
  current_value TEXT,
  proposed_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  requester TEXT NOT NULL, requester_role TEXT NOT NULL,
  approver TEXT, approver_role TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL, decided_at TEXT, applied_at TEXT, revalidated_at TEXT,
  source_rev_at_proposal TEXT,
  validation_outcome TEXT,
  exception_id INTEGER REFERENCES exception(id) ON DELETE SET NULL);

CREATE TABLE IF NOT EXISTS reconciliation_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS reconciliation_check (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES reconciliation_run(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL, label TEXT NOT NULL,
  checked INTEGER NOT NULL, matched INTEGER NOT NULL,
  unmatched INTEGER NOT NULL, warnings INTEGER NOT NULL,
  /* Excluded by policy is its own column. A WIP model is not a failed import. */
  excluded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, detail TEXT);

CREATE INDEX IF NOT EXISTS idx_validation_rule ON validation_result(rule_id, status);
CREATE INDEX IF NOT EXISTS idx_validation_subject ON validation_result(subject_id);
CREATE INDEX IF NOT EXISTS idx_exception_status ON exception(status, severity);
CREATE INDEX IF NOT EXISTS idx_exception_subject ON exception(subject_id);
CREATE INDEX IF NOT EXISTS idx_proposal_element ON mapping_proposal(element_id, status);
CREATE INDEX IF NOT EXISTS idx_mapping_status ON mapping(status);


/* ── Phase 4: geometry, verified progress and draft P6 updates ────────────────────────────── */

/*
 * Where each element sits, in local metres.
 *
 * The ACC export carries no coordinates, so this is SYNTHETIC — generated deterministically from
 * the element's own level, zone, category and index, and STORED, so the viewer never invents a
 * position at render time and two sessions draw the same building.
 */
CREATE TABLE IF NOT EXISTS element_geometry (
  element_id TEXT PRIMARY KEY,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  sx REAL NOT NULL, sy REAL NOT NULL, sz REAL NOT NULL,
  level_index INTEGER NOT NULL, zone_index INTEGER NOT NULL);

/*
 * What has actually been built, as observed.
 *
 * Only a VERIFIED observation counts towards actual progress. A DRAFT is somebody's note and a
 * REJECTED one is a note that was wrong; treating either as built is how a project reports
 * progress it has not made.
 */
CREATE TABLE IF NOT EXISTS progress_observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id TEXT NOT NULL,
  element_id TEXT,
  observed_on TEXT NOT NULL,
  verified_quantity REAL,
  completion TEXT NOT NULL,
  source TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (activity_id, element_id, observed_on));

/*
 * How each activity's progress is measured, declared per activity.
 *
 * Equal-weight element counting is only correct where every element is comparable, so it is
 * configured rather than assumed; everywhere else the measure is the quantity the BOQ states.
 */
CREATE TABLE IF NOT EXISTS measurement_rule (
  activity_id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  note TEXT NOT NULL);

/*
 * A prepared P6 progress update. A DRAFT, and nothing else.
 *
 * Phase 5 adds the planner's approval and the write-back. Until then there is no code path that
 * sends one of these anywhere, and the row says so.
 */
CREATE TABLE IF NOT EXISTS p6_update_draft (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id TEXT NOT NULL,
  current_pct REAL,
  proposed_pct REAL NOT NULL,
  actual_start TEXT, actual_finish TEXT,
  remaining_duration REAL,
  evidence TEXT NOT NULL,
  source_rev TEXT,
  validation_status TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_observation_activity ON progress_observation(activity_id, status);
CREATE INDEX IF NOT EXISTS idx_geometry_level ON element_geometry(level_index, zone_index);
CREATE INDEX IF NOT EXISTS idx_draft_activity ON p6_update_draft(activity_id, status);


/* ── Phase 5: demo authorization, outbound proposals and simulated write-back ─────────────── */

/*
 * A DEMO session. Read the note on every row before trusting it for anything.
 *
 * This application has no authentication: before this table, a caller simply put
 * {"actorRole": "planner"} in the request body and the server believed it. That is not
 * authorization, so the role now comes from a server-issued token instead and the body cannot
 * assert one.
 *
 * It is still only a demonstration control: anyone who can reach the API can mint a session for
 * any role, because there is no identity provider to check them against. What it does buy is a
 * single place where the role is decided, bound to a session, and recorded in the audit trail —
 * so wiring a real IdP later is a change to issueSession() and nothing above it.
 */
CREATE TABLE IF NOT EXISTS demo_session (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  note TEXT NOT NULL);

/*
 * An outbound proposal: a change SYNCHRO 4D would like to make to P6 (INT-02) or SAP (INT-05).
 *
 * One table for both interfaces, because the lifecycle is identical and splitting it would mean
 * two state machines to keep in step. "interface_id" says which, and the permitted fields differ.
 *
 * The three fingerprints are the conflict controls. Each is taken when the proposal is raised and
 * compared again immediately before posting: if the source, the evidence or the mapping has moved
 * underneath it, the proposal is HELD and nothing is written.
 */
CREATE TABLE IF NOT EXISTS outbound_proposal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interface_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  draft_id INTEGER REFERENCES p6_update_draft(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  evidence TEXT NOT NULL,
  source_rev TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  mapping_fingerprint TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  coverage TEXT,
  /* Stable per subject and payload, so a repeated submission is the same proposal. */
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  submitted_at TEXT, decided_at TEXT, posted_at TEXT,
  approver TEXT, approver_role TEXT, decision_note TEXT,
  hold_reason TEXT, failure_reason TEXT);

CREATE TABLE IF NOT EXISTS outbound_transition (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES outbound_proposal(id) ON DELETE CASCADE,
  at TEXT NOT NULL, actor TEXT NOT NULL, actor_role TEXT,
  from_status TEXT, to_status TEXT NOT NULL,
  reason TEXT, detail TEXT);

/*
 * One row per posting ATTEMPT, with the destination's own answer.
 *
 * An attempt is recorded before the destination is called and closed with whatever it returned,
 * so a failure cannot vanish and nothing is reported as posted that was not acknowledged.
 */
CREATE TABLE IF NOT EXISTS outbound_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES outbound_proposal(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  at TEXT NOT NULL, actor TEXT NOT NULL,
  destination TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT,
  outcome TEXT NOT NULL,
  finished_at TEXT);

/*
 * The ONLY SAP field this application may write.
 *
 * Its own table, deliberately: budgets, actual cost postings, unit rates, BOQ master data and the
 * WBS structure live in src_sap_* and are read-only here. A write-back that could reach them
 * would be one schema slip away from changing a cost ledger.
 */
CREATE TABLE IF NOT EXISTS src_sap_earned_value (
  sap_wbs_code TEXT PRIMARY KEY,
  earned_value REAL NOT NULL,
  currency TEXT NOT NULL,
  coverage TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  proposal_id INTEGER);

CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_proposal(interface_id, status);
CREATE INDEX IF NOT EXISTS idx_outbound_subject ON outbound_proposal(subject_id);
CREATE INDEX IF NOT EXISTS idx_attempt_proposal ON outbound_attempt(proposal_id, attempt);

/* ── Phase 8A: the live OpenProject schedule source ──────────────────────────────────────── */

/*
 * ITS OWN NAMESPACE, and that is the whole point.
 *
 * Every table here is prefixed "live_schedule_" and NONE of them is in "ALL_TABLES", so
 * "countRows()" does not report them among the demo's figures and "clearConstructionDb()" — what
 * "Reset demo data" calls — does not empty them. Two reasons, both deliberate:
 *
 *   - these rows are observations of a real external system, not synthetic demo state. Resetting
 *     the demo must not destroy the record of what OpenProject said yesterday.
 *   - nothing in the normalized SYNCHRO layer may ever be written from here, and a reviewer can
 *     check that by name: no "live_schedule_" table has a foreign key into the integration tables,
 *     and no integration table references one.
 *
 * "live_schedule_fetch" is a READ LOG, not a sync run. It is kept out of "sync_run" on purpose:
 * a row in "sync_run" means records were written into SYNCHRO 4D, and fetching a schedule writes
 * nothing. Conflating them would make the overview claim a synchronisation that did not happen.
 */

CREATE TABLE IF NOT EXISTS live_schedule_fetch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_system TEXT NOT NULL,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  /* The adapter's own state word: CONNECTED, PARTIAL, AUTH_FAILED, ... */
  state TEXT NOT NULL,
  failure TEXT, http_status INTEGER, reason TEXT,
  elapsed_ms INTEGER,
  /* What the collection HOLDS, and what we actually received. Separate columns, always. */
  collection_total INTEGER,
  records_received INTEGER NOT NULL DEFAULT 0,
  records_new INTEGER NOT NULL DEFAULT 0,
  records_changed INTEGER NOT NULL DEFAULT 0,
  records_unchanged INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  /*
   * Phase 8B: the synchronisation run this read belongs to.
   *
   * COLUMNS ON THE EXISTING TABLE rather than a second "live_schedule_run" table, because a run
   * and a read are the same event here: one cycle makes one HTTP walk and writes one row. A
   * parallel table would have been a 1:1 join and a second place for the counts to disagree.
   *
   *   run_id      a per-run uuid, so a client can correlate an SSE notification with this row
   *               without guessing from timestamps.
   *   trigger     STARTUP | SCHEDULED | MANUAL. Which of the three opened it, kept because
   *               "the schedule changed itself overnight" and "somebody pressed Sync Now" are
   *               different stories and the audit trail should be able to tell them apart.
   *   run_status  SUCCESS | PARTIAL | FAILED | SKIPPED. Derived from "state", with one value
   *               "state" cannot carry: SKIPPED is a cycle that never asked, so it has no
   *               connection state at all.
   *   started_at / finished_at   the wall-clock bracket. "elapsed_ms" is the adapter's own
   *               measure of time spent in HTTP; these two bracket the whole cycle including the
   *               diff and the writes, and the difference between them is worth seeing.
   */
  run_id TEXT,
  trigger TEXT,
  run_status TEXT,
  started_at TEXT,
  finished_at TEXT);

/*
 * The last thing we saw, per work package. One row per activity, overwritten in place.
 *
 * "first_seen_at" survives the overwrite, which is how a baseline stays distinguishable from a
 * later revision no matter how many times the schedule is refreshed.
 */
CREATE TABLE IF NOT EXISTS live_schedule_snapshot (
  source_system TEXT NOT NULL,
  project_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  activity_name TEXT, activity_type TEXT, status TEXT,
  planned_start TEXT, planned_finish TEXT,
  progress_pct REAL,
  estimated_raw TEXT, estimated_hours REAL,
  remaining_raw TEXT, remaining_hours REAL,
  parent_external_id TEXT,
  source_revision INTEGER,
  source_updated_at TEXT,
  /* The normalized record as it arrived, for a detail view that must quote the source. */
  payload TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_fetch_id INTEGER,
  PRIMARY KEY (source_system, project_id, external_id));

/*
 * One row per DETECTED change. Append-only.
 *
 * A single revision can produce several rows — a progress change and a schedule change are two
 * findings about the same revision, and collapsing them would lose one. "(external_id, revision,
 * kind, field)" is unique, which is what makes a repeated refresh idempotent: re-detecting the
 * same change writes nothing instead of growing the log.
 */
CREATE TABLE IF NOT EXISTS live_schedule_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_system TEXT NOT NULL,
  project_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  field TEXT,
  previous_value TEXT, current_value TEXT,
  previous_revision INTEGER, current_revision INTEGER,
  previous_updated_at TEXT, current_updated_at TEXT,
  detected_at TEXT NOT NULL,
  fetch_id INTEGER,
  UNIQUE (source_system, project_id, external_id, current_revision, kind, field));

/*
 * The candidate link between a live OpenProject activity and a synthetic P6 one.
 *
 * A PROPOSAL, never an applied mapping. Approving it unlocks a read-only comparison and nothing
 * else: there is no column here that any synthetic record is written from.
 */
CREATE TABLE IF NOT EXISTS live_schedule_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_system TEXT NOT NULL,
  project_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  /* The synthetic P6 activity id this is a candidate for. */
  target_system TEXT NOT NULL,
  target_activity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  basis TEXT NOT NULL,
  evidence TEXT,
  proposed_at TEXT NOT NULL, proposed_by TEXT NOT NULL,
  decided_at TEXT, decided_by TEXT, decision_note TEXT,
  UNIQUE (source_system, project_id, external_id, target_system, target_activity_id));

/*
 * ── Phase 9B: the real Speckle BIM model ──────────────────────────────────────────────────────
 *
 * Prefixed "speckle_" and, like the "live_schedule_" tables, deliberately NOT in "ALL_TABLES":
 * these rows describe a real external model and a reset of the synthetic demo must not destroy
 * the record of it. No table here has a foreign key into the integration tables, and none of the
 * integration tables references one - so "this cannot touch the synthetic BIM data" is checkable
 * by reading the SQL rather than by trusting a comment.
 *
 * A row in "speckle_version" is one immutable Speckle version. Conversion is cached against it,
 * which is what stops an unchanged model being downloaded and re-converted every minute.
 */

CREATE TABLE IF NOT EXISTS speckle_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  project_name TEXT, model_name TEXT,
  source_created_at TEXT, source_application TEXT, referenced_object TEXT,
  first_seen_at TEXT NOT NULL,
  converted_at TEXT,
  /* PENDING | CONVERTING | CONVERTED | FAILED */
  status TEXT NOT NULL,
  artifact_dir TEXT,
  glb_bytes INTEGER,
  element_count INTEGER, geometry_count INTEGER,
  vertex_count INTEGER, triangle_count INTEGER,
  units TEXT,
  bounds TEXT,          /* JSON, model frame (Z-up metres) */
  manifest TEXT,        /* JSON, the converter's own manifest */
  error TEXT, error_class TEXT,
  /* Exactly one row may be active. The switch is a transaction - see publishVersion(). */
  active INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, model_id, version_id));

/*
 * One row per BIM element of a converted version, keyed by its IFC GlobalId.
 *
 * The GUID is stored EXACTLY as Speckle reported it. Nothing generates a replacement: an invented
 * id would join to nothing outside this demo while looking authoritative.
 */
CREATE TABLE IF NOT EXISTS speckle_element (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_row_id INTEGER NOT NULL,
  ifc_guid TEXT,
  name TEXT, ifc_type TEXT, level TEXT,
  /* Its row in the GLB property table, which is what a Cesium pick resolves to. */
  feature_index INTEGER,
  vertex_count INTEGER, triangle_count INTEGER,
  has_geometry INTEGER NOT NULL DEFAULT 0,
  bounds TEXT, properties TEXT,
  UNIQUE (version_row_id, ifc_guid));

/* The synchronisation log. UNCHANGED is the common case and is recorded as its own outcome. */
CREATE TABLE IF NOT EXISTS speckle_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  trigger TEXT,
  /* CONVERTED | UNCHANGED | FAILED | SKIPPED */
  status TEXT NOT NULL,
  project_id TEXT, model_id TEXT, version_id TEXT,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  converted INTEGER NOT NULL DEFAULT 0,
  reason TEXT, error_class TEXT, actor TEXT);

/*
 * Phase 9C: the version-to-version comparison, and the manual element-to-activity mapping.
 *
 * "speckle_version_change" is one row per element per comparison. It is derived data - it can
 * always be recomputed from two versions' elements - but it is persisted because the timeline
 * asks for it constantly and recomputing a 63-element diff on every frame of a playback would be
 * absurd. The UNIQUE constraint is what makes a repeated sync idempotent.
 */
CREATE TABLE IF NOT EXISTS speckle_version_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  /* The OLDER version, and the NEWER one. Never inferred from row order. */
  from_version_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  ifc_guid TEXT NOT NULL,
  /* ADDED | REMOVED | MODIFIED | UNCHANGED | RECLASSIFIED */
  kind TEXT NOT NULL,
  /* Reported alongside "kind": an element can be MODIFIED and reclassified at once. */
  reclassified INTEGER NOT NULL DEFAULT 0,
  retessellated INTEGER NOT NULL DEFAULT 0,
  dimensions TEXT,
  name TEXT, ifc_type TEXT, previous_ifc_type TEXT,
  detail TEXT,
  computed_at TEXT NOT NULL,
  UNIQUE (project_id, model_id, from_version_id, to_version_id, ifc_guid));

/*
 * The MANUAL link between a BIM element and a construction activity.
 *
 * A PROPOSAL until somebody approves it, exactly like the OpenProject schedule link. Publishing a
 * model version is not a construction event, and nothing in this schema lets one become one: the
 * only way a BIM element is associated with an activity is a row here that a person decided on.
 */
CREATE TABLE IF NOT EXISTS speckle_element_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ifc_guid TEXT NOT NULL,
  /* OPENPROJECT | P6 - which schedule the activity belongs to. */
  activity_system TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  activity_name TEXT,
  /* PROPOSED | APPROVED | REJECTED */
  status TEXT NOT NULL,
  basis TEXT NOT NULL,
  evidence TEXT,
  proposed_at TEXT NOT NULL, proposed_by TEXT NOT NULL,
  decided_at TEXT, decided_by TEXT, decision_note TEXT,
  UNIQUE (project_id, model_id, ifc_guid, activity_system, activity_id));

/*
 * A LEDGER OF CREATION REQUESTS. NOT a table of work packages.
 *
 * The distinction is the whole design. OpenProject owns work packages; a created one reaches this
 * database the same way every other one does, through the live_schedule_snapshot upsert, so
 * there is exactly one place a task is read from and this table can never become a second answer
 * to "what are the activities?". What it records is something OpenProject does not keep: the
 * history of OUR attempt to create one.
 *
 * It exists because OpenProject has no idempotency key. A POST that times out may have created
 * the record, and the only safe move is to look for it - never to send it again. So the row is
 * written BEFORE the request leaves, carries a marker that is also written into the work package's
 * description, and survives a refresh, a crash and a restart. idempotency_key is UNIQUE, so a
 * double-click is a constraint violation rather than a second task; work_package_id is UNIQUE
 * where set, so no two requests can ever claim the same created record.
 */
CREATE TABLE IF NOT EXISTS work_package_creation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  /* The client's key for this attempt. One key = at most one work package, forever. */
  idempotency_key TEXT NOT NULL UNIQUE,
  /* Written into the description and used to find the record if the outcome is unknown. */
  marker TEXT NOT NULL UNIQUE,
  /* DRAFT | PENDING | CREATING | CREATED | RECONCILING | RECONCILED | FAILED | OUTCOME_UNKNOWN */
  status TEXT NOT NULL,
  source_system TEXT NOT NULL,
  project_id TEXT NOT NULL,
  /* Null until OpenProject confirms one. UNIQUE so a retry can never duplicate a task. */
  work_package_id TEXT UNIQUE,
  source_url TEXT,
  lock_version INTEGER,
  /* What was asked for, and what OpenProject said it would store, for reconciliation. */
  requested TEXT NOT NULL,
  expected TEXT,
  confirmed TEXT,
  /* PENDING | MATCHED | DIFFERS | UNCHECKED */
  reconciliation TEXT,
  reconciliation_detail TEXT,
  endpoint TEXT,
  http_status INTEGER,
  failure TEXT,
  field_errors TEXT,
  error TEXT,
  /* The BIM context this task was created from, when it came from selected geometry. */
  bim_context TEXT,
  /* NOT_REQUESTED | PENDING | PROPOSED | FAILED - the mapping half of the operation. */
  mapping_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  mapping_detail TEXT,
  actor TEXT NOT NULL,
  actor_role TEXT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0);

CREATE INDEX IF NOT EXISTS idx_wp_creation_status ON work_package_creation(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_wp_creation_wp ON work_package_creation(work_package_id);

CREATE INDEX IF NOT EXISTS idx_speckle_change_pair
  ON speckle_version_change(from_version_id, to_version_id, kind);
CREATE INDEX IF NOT EXISTS idx_speckle_change_guid ON speckle_version_change(ifc_guid);
CREATE INDEX IF NOT EXISTS idx_speckle_map_guid ON speckle_element_activity(ifc_guid);
CREATE INDEX IF NOT EXISTS idx_speckle_map_activity
  ON speckle_element_activity(activity_system, activity_id);

CREATE INDEX IF NOT EXISTS idx_speckle_version_active ON speckle_version(active, id DESC);
CREATE INDEX IF NOT EXISTS idx_speckle_element_version ON speckle_element(version_row_id);
CREATE INDEX IF NOT EXISTS idx_speckle_element_guid ON speckle_element(ifc_guid);
CREATE INDEX IF NOT EXISTS idx_speckle_sync_at ON speckle_sync(id DESC);

CREATE INDEX IF NOT EXISTS idx_live_change_activity
  ON live_schedule_change(external_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_live_fetch_at ON live_schedule_fetch(id DESC);
CREATE INDEX IF NOT EXISTS idx_live_link_status ON live_schedule_link(status);

CREATE INDEX IF NOT EXISTS idx_sync_run_interface ON sync_run(interface_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_event(id DESC);
CREATE INDEX IF NOT EXISTS idx_element_activity ON element(activity_ref);
`;

/** Every table this project owns, in dependency order for a reset. */
export const SOURCE_TABLES = Object.freeze([
  'src_sap_earned_value', 'src_sap_boq', 'src_sap_cost', 'src_sap_wbs',
  'src_acc_element', 'src_acc_model_version',
  'src_p6_activity', 'src_p6_wbs',
]);

export const INTEGRATION_TABLES = Object.freeze([
  'audit_event', 'sync_error', 'sync_run',
  'outbound_attempt', 'outbound_transition', 'outbound_proposal', 'demo_session',
  'p6_update_draft', 'progress_observation', 'measurement_rule', 'element_geometry',
  'reconciliation_check', 'reconciliation_run',
  'mapping_proposal', 'exception_event', 'exception',
  'validation_result', 'validation_run', 'mapping', 'mapping_build',
  'cost', 'boq_item', 'element', 'model_version', 'activity', 'wbs',
]);

/**
 * The live OpenProject tables (Phase 8A). DELIBERATELY NOT in `ALL_TABLES`.
 *
 * `countRows()` and `clearConstructionDb()` default to `ALL_TABLES`, so the demo's own figures and
 * its "Reset demo data" button are unchanged by this phase — and a record of what a real external
 * system reported is not something a demo reset should silently destroy. `clearLiveScheduleState`
 * exists for tests and for an explicit operator request.
 */
export const LIVE_SCHEDULE_TABLES = Object.freeze([
  'live_schedule_change', 'live_schedule_link', 'live_schedule_snapshot', 'live_schedule_fetch',
  /* Phase 10B. A record of what we asked a real system to create; a demo reset must not erase it. */
  'work_package_creation',
]);

/**
 * The Speckle BIM tables (Phase 9B). Also deliberately NOT in `ALL_TABLES`.
 *
 * Same reasoning as the live-schedule tables above: "Reset demo data" restores the synthetic
 * baseline and must not delete the record of a real external model, nor the converted artifacts
 * those rows point at.
 */
export const SPECKLE_TABLES = Object.freeze([
  'speckle_version_change', 'speckle_element_activity',
  'speckle_element', 'speckle_sync', 'speckle_version',
]);

/** The Speckle rows, gone. Separate from the demo reset, by name. */
export function clearSpeckleState(db) {
  for (const table of SPECKLE_TABLES) db.exec(`DELETE FROM ${table}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('speckle_element', 'speckle_sync',
    'speckle_version', 'speckle_version_change', 'speckle_element_activity')`);
}

export const ALL_TABLES = Object.freeze([...INTEGRATION_TABLES, ...SOURCE_TABLES]);

/**
 * Open the database, creating and migrating it if need be.
 *
 * @param {{path?: string}} [options] `:memory:` for tests.
 */
export function openConstructionDb({ path = DEFAULT_DB_PATH } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schemaVersion', String(SCHEMA_VERSION));
  return db;
}

/**
 * Columns added to a table that already exists in somebody's file.
 *
 * `CREATE TABLE IF NOT EXISTS` is the whole of `SCHEMA`, which means it builds a correct database
 * from nothing and does NOTHING to one that is already there. Every developer and the demo host
 * have a `.data/construction-integration.sqlite` from an earlier schema version, so a column added
 * above only reaches them through an `ALTER TABLE` here.
 *
 * Additive only, and by design: a column is added when `PRAGMA table_info` says it is missing, and
 * nothing is ever dropped, renamed or retyped. A migration that can only add cannot lose anybody's
 * recorded observations, which matters more here than schema tidiness — these rows are the record
 * of what a real external system reported.
 */
function migrate(db) {
  addColumns(db, 'live_schedule_fetch', {
    run_id: 'TEXT',
    trigger: 'TEXT',
    run_status: 'TEXT',
    started_at: 'TEXT',
    finished_at: 'TEXT',
  });
  /*
   * AFTER the columns, not in `SCHEMA` with the other indexes.
   *
   * `SCHEMA` runs first, on a file that may predate `run_id`, and a `CREATE INDEX` naming a column
   * that is not there yet fails the whole `exec` — which took the database, and with it the entire
   * Construction demo, down on every existing checkout. Found by running the migration against a
   * copy of the real `.data` file rather than against a fresh one.
   */
  db.exec('CREATE INDEX IF NOT EXISTS idx_live_fetch_run ON live_schedule_fetch(run_id)');

  // Phase 9C. `ordinal`/`label` are DERIVED from chronological order — Speckle has no such
  // concept — and are stored so the timeline's V1..Vn labels are stable rather than recomputed
  // differently by each caller.
  addColumns(db, 'speckle_version', {
    ordinal: 'INTEGER',
    label: 'TEXT',
    message: 'TEXT',
    /*
     * Still published upstream?
     *
     * A version can be deleted or replaced in Speckle — one was, mid-implementation, which is how
     * this column came to exist. Its artifacts and rows are KEPT, because the brief asks for
     * history to be preserved and because a cached conversion is still a true record of what was
     * published. But it must not sit in the timeline as though it were current, so it is flagged
     * rather than deleted.
     */
    published: 'INTEGER NOT NULL DEFAULT 1',
  });
  // Phase 9D: the Changes panel shows WHICH properties changed, before and after. The comparison
  // computed them all along and then threw them away on the way to the database, so the detail
  // panel had nothing to show but a count.
  addColumns(db, 'speckle_version_change', { property_changes: 'TEXT' });
  addColumns(db, 'speckle_element', {
    /* The tessellation-invariant shape signature. See speckleCompare.mjs. */
    area: 'REAL',
    centroid: 'TEXT',
    fingerprint: 'TEXT',
  });
}

/** @param {Record<string, string>} columns name → type, added only when absent. */
export function addColumns(db, table, columns) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const added = [];
  for (const [name, type] of Object.entries(columns)) {
    if (present.has(name)) continue;
    // The name and type are module constants from the call above, never request data.
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added.push(name);
  }
  return added;
}

/** Everything this project owns, gone. Scoped to these tables by name — it drops nothing else. */
export function clearConstructionDb(db, { tables = ALL_TABLES } = {}) {
  for (const table of tables) db.exec(`DELETE FROM ${table}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('sync_run', 'sync_error', 'audit_event',
    'mapping_build', 'validation_run', 'validation_result', 'exception', 'exception_event',
    'mapping_proposal', 'reconciliation_run', 'reconciliation_check',
    'progress_observation', 'p6_update_draft',
    'outbound_proposal', 'outbound_transition', 'outbound_attempt')`);
}

/** The live-schedule observations, gone. Separate from the demo reset, by name. */
export function clearLiveScheduleState(db) {
  for (const table of LIVE_SCHEDULE_TABLES) db.exec(`DELETE FROM ${table}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('live_schedule_fetch',
    'live_schedule_change', 'live_schedule_link')`);
}

/** Row counts, by table. What the overview reports instead of a written-down number. */
export function countRows(db, tables = ALL_TABLES) {
  return Object.fromEntries(tables.map(table =>
    [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}
