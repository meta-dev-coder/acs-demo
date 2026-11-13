/**
 * Where the converted Speckle model is remembered, and nothing else is touched.
 *
 * Every statement in this file names a `speckle_*` table, plus one `audit_event` row through the
 * existing `recordAudit` because the audit trail is where a reader looks to find out what the
 * system did. There is no INSERT or UPDATE here against `element`, `activity`, `src_p6_activity`,
 * `cost`, `sync_run` or any other table the five pilot interfaces own — the isolation the phase
 * asks for, checkable by reading the SQL rather than by trusting a comment.
 *
 * The one rule worth stating twice: EXACTLY ONE VERSION IS ACTIVE, and the switch to a new one is
 * a single transaction. A reader sees the version before the switch or the version after it,
 * never a model whose GLB is new and whose elements are old.
 */
import { RUN_STATUS, SPECKLE } from './speckle.mjs';
import { CHANGE, compareVersions } from './speckleCompare.mjs';
import { recordAudit } from './sync.mjs';
import { transact } from './openProjectStore.mjs';

const nowIso = () => new Date().toISOString();
const json = value => (value == null ? null : JSON.stringify(value));
const parse = value => { try { return value == null ? null : JSON.parse(value); } catch { return null; } };

/** The version currently being served, or null before the first successful conversion. */
export function activeVersion(db, { projectId, modelId }) {
  const row = db.prepare(`SELECT * FROM speckle_version
     WHERE project_id = ? AND model_id = ? AND active = 1 AND status = 'CONVERTED'
     ORDER BY id DESC LIMIT 1`).get(String(projectId), String(modelId));
  return row ? shapeVersion(row) : null;
}

/** One version row by its Speckle id, whatever its status. */
export function versionRow(db, { projectId, modelId, versionId }) {
  const row = db.prepare(`SELECT * FROM speckle_version
     WHERE project_id = ? AND model_id = ? AND version_id = ?`)
    .get(String(projectId), String(modelId), String(versionId));
  return row ?? null;
}

/** Every version we have seen, newest first. */
export function versions(db, { projectId, modelId, limit = 20 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return db.prepare(`SELECT * FROM speckle_version
     WHERE project_id = ? AND model_id = ? ORDER BY id DESC LIMIT ?`)
    .all(String(projectId), String(modelId), capped).map(shapeVersion);
}

export const shapeVersion = row => (!row ? null : {
  id: row.id,
  projectId: row.project_id,
  projectName: row.project_name,
  modelId: row.model_id,
  modelName: row.model_name,
  versionId: row.version_id,
  ordinal: row.ordinal,
  /** "V1", "V2"… derived from chronological order; Speckle has no such concept. */
  label: row.label ?? (row.ordinal ? `V${row.ordinal}` : null),
  message: row.message,
  sourceCreatedAt: row.source_created_at,
  sourceApplication: row.source_application,
  referencedObject: row.referenced_object,
  firstSeenAt: row.first_seen_at,
  convertedAt: row.converted_at,
  status: row.status,
  active: Boolean(row.active),
  published: row.published == null ? true : Boolean(row.published),
  glbBytes: row.glb_bytes,
  elementCount: row.element_count,
  geometryCount: row.geometry_count,
  vertexCount: row.vertex_count,
  triangleCount: row.triangle_count,
  units: row.units,
  bounds: parse(row.bounds),
  error: row.error,
  errorClass: row.error_class,
});

/** Note that a version exists, before anything has been converted. Idempotent. */
export function noteVersion(db, { projectId, modelId, versionId, projectName = null,
  modelName = null, createdAt = null, sourceApplication = null, referencedObject = null,
  ordinal = null, label = null, message = null }) {
  const at = nowIso();
  db.prepare(`INSERT INTO speckle_version (project_id, model_id, version_id, project_name,
      model_name, source_created_at, source_application, referenced_object, first_seen_at, status,
      ordinal, label, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
     ON CONFLICT (project_id, model_id, version_id) DO UPDATE SET
       project_name = COALESCE(excluded.project_name, project_name),
       model_name = COALESCE(excluded.model_name, model_name),
       source_created_at = COALESCE(excluded.source_created_at, source_created_at),
       source_application = COALESCE(excluded.source_application, source_application),
       referenced_object = COALESCE(excluded.referenced_object, referenced_object),
       /* The ordinal and label are recomputed from chronological order on every discovery, so an
          older version published late takes its rightful place instead of keeping a stale one. */
       ordinal = COALESCE(excluded.ordinal, ordinal),
       label = COALESCE(excluded.label, label),
       message = COALESCE(excluded.message, message)`)
    .run(String(projectId), String(modelId), String(versionId), projectName, modelName,
      createdAt, sourceApplication, referencedObject, at, ordinal, label, message);
  return versionRow(db, { projectId, modelId, versionId });
}

/**
 * Publish a converted version: store its elements and make it the active one, atomically.
 *
 * ONE TRANSACTION covering the version row, every element row and the active switch. They are one
 * fact about one conversion: a GLB marked active whose elements are still the previous version's
 * would make a pick resolve to the wrong record, which is precisely the failure this phase exists
 * to avoid.
 */
export function publishVersion(db, { projectId, modelId, versionId, manifest, artifactDir,
  elements = [], actor = 'Speckle sync', activate = true }) {
  const at = nowIso();
  const counts = manifest?.counts ?? {};
  const withGeometry = elements.filter(entry => entry.featureIndex != null).length;

  return transact(db, () => {
    noteVersion(db, { projectId, modelId, versionId,
      projectName: manifest?.source?.projectName, modelName: manifest?.source?.modelName,
      createdAt: manifest?.source?.versionCreatedAt,
      sourceApplication: manifest?.source?.sourceApplication,
      referencedObject: manifest?.source?.referencedObject });

    db.prepare(`UPDATE speckle_version SET status = 'CONVERTED', converted_at = ?,
        artifact_dir = ?, glb_bytes = ?, element_count = ?, geometry_count = ?, vertex_count = ?,
        triangle_count = ?, units = ?, bounds = ?, manifest = ?, error = NULL, error_class = NULL
       WHERE project_id = ? AND model_id = ? AND version_id = ?`)
      .run(at, artifactDir, manifest?.glbBytes ?? null, counts.objects ?? elements.length,
        withGeometry, counts.vertices ?? null, counts.triangles ?? null,
        manifest?.units ?? null, json(manifest?.boundsModel), json(manifest),
        String(projectId), String(modelId), String(versionId));

    const row = versionRow(db, { projectId, modelId, versionId });

    // Re-converting the same version replaces its elements rather than doubling them.
    db.prepare('DELETE FROM speckle_element WHERE version_row_id = ?').run(row.id);
    const insert = db.prepare(`INSERT OR REPLACE INTO speckle_element (version_row_id, ifc_guid,
        name, ifc_type, level, feature_index, vertex_count, triangle_count, has_geometry, bounds,
        properties, area, centroid, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const element of elements) {
      const print = element.geometryFingerprint ?? null;
      insert.run(row.id, element.ifcGuid ?? null, element.name ?? null, element.ifcType ?? null,
        element.level ?? null, element.featureIndex ?? null, element.vertexCount ?? 0,
        element.triangleCount ?? 0, element.featureIndex != null ? 1 : 0,
        json(element.bounds), json(element.properties),
        print?.area ?? null, json(print?.centroid), json(print));
    }

    /*
     * THE ATOMIC SWITCH, and only when asked.
     *
     * Phase 9C converts the whole published history, oldest first. Activating each one as it
     * lands would drag the viewer backwards through the build and leave V1 showing at the end,
     * so only the newest published version activates; the rest are converted, cached and
     * selectable from the timeline without ever becoming "the" model.
     */
    if (activate) {
      db.prepare(`UPDATE speckle_version SET active = 0
         WHERE project_id = ? AND model_id = ?`).run(String(projectId), String(modelId));
      db.prepare('UPDATE speckle_version SET active = 1 WHERE id = ?').run(row.id);
    }

    recordAudit(db, { actor, event: 'SPECKLE_MODEL_PUBLISHED',
      subject: `SPECKLE:${projectId}/${modelId}@${versionId}`,
      result: `${elements.length} element(s), ${counts.triangles ?? 0} triangle(s)`,
      detail: { source: SPECKLE.system, versionId, glbBytes: manifest?.glbBytes ?? null,
        note: 'A READ of an external model, converted and cached. No synthetic BIM element, P6 '
          + 'activity, SYNCHRO record, SAP value or ACC model was created, updated or deleted.' } });

    return shapeVersion(versionRow(db, { projectId, modelId, versionId }));
  });
}

/**
 * Record that a conversion failed.
 *
 * THE PREVIOUS ACTIVE VERSION IS LEFT ALONE — not cleared, not deactivated. The last model that
 * worked is still the last model that worked, and a screen that went blank because a new version
 * failed to convert would be strictly less useful than one that keeps showing the old one and
 * says why.
 */
export function recordFailedConversion(db, { projectId, modelId, versionId, error, errorClass,
  actor = 'Speckle sync' }) {
  noteVersion(db, { projectId, modelId, versionId });
  db.prepare(`UPDATE speckle_version SET status = 'FAILED', error = ?, error_class = ?
     WHERE project_id = ? AND model_id = ? AND version_id = ? AND active = 0`)
    .run(String(error ?? '').slice(0, 1000), errorClass ?? null,
      String(projectId), String(modelId), String(versionId));
  recordAudit(db, { actor, event: 'SPECKLE_CONVERSION_FAILED',
    subject: `SPECKLE:${projectId}/${modelId}@${versionId}`,
    result: errorClass ?? 'FAILED',
    detail: { source: SPECKLE.system, versionId, reason: String(error ?? '').slice(0, 500),
      note: 'The previously converted model is still active and still served.' } });
  return versionRow(db, { projectId, modelId, versionId });
}

/* ── elements ──────────────────────────────────────────────────────────────────────────────── */

const shapeElement = row => ({
  ifcGuid: row.ifc_guid,
  area: row.area,
  geometryFingerprint: parse(row.fingerprint),
  name: row.name,
  ifcType: row.ifc_type,
  level: row.level,
  featureIndex: row.feature_index,
  vertexCount: row.vertex_count,
  triangleCount: row.triangle_count,
  hasGeometry: Boolean(row.has_geometry),
  bounds: parse(row.bounds),
});

/** Every element of a version. Properties are omitted — see `elementDetail`. */
export function elements(db, versionRowId, { ifcType = null } = {}) {
  const rows = ifcType
    ? db.prepare(`SELECT * FROM speckle_element WHERE version_row_id = ? AND ifc_type = ?
         ORDER BY feature_index IS NULL, feature_index, id`).all(versionRowId, String(ifcType))
    : db.prepare(`SELECT * FROM speckle_element WHERE version_row_id = ?
         ORDER BY feature_index IS NULL, feature_index, id`).all(versionRowId);
  return rows.map(shapeElement);
}

/** One element, with its full property set. The detail panel's source. */
export function elementDetail(db, versionRowId, ifcGuid) {
  const row = db.prepare('SELECT * FROM speckle_element WHERE version_row_id = ? AND ifc_guid = ?')
    .get(versionRowId, String(ifcGuid));
  return row ? { ...shapeElement(row), properties: parse(row.properties) ?? {} } : null;
}

/** The IFC classes present, with counts. What the filter control is built from. */
export function ifcTypes(db, versionRowId) {
  return db.prepare(`SELECT ifc_type AS type, COUNT(*) AS total,
      SUM(has_geometry) AS withGeometry FROM speckle_element
     WHERE version_row_id = ? GROUP BY ifc_type ORDER BY total DESC, ifc_type`)
    .all(versionRowId)
    .map(row => ({ ifcType: row.type ?? 'Unclassified', count: row.total,
      withGeometry: Number(row.withGeometry ?? 0) }));
}

/* ── the sync log ──────────────────────────────────────────────────────────────────────────── */

export function recordSync(db, { runId, trigger, status, projectId, modelId, versionId,
  startedAt, finishedAt, converted = false, reason = null, errorClass = null,
  actor = 'Speckle sync' }) {
  const finished = finishedAt ?? nowIso();
  const duration = startedAt ? Math.max(0, Date.parse(finished) - Date.parse(startedAt)) : null;
  const info = db.prepare(`INSERT INTO speckle_sync (run_id, trigger, status, project_id, model_id,
      version_id, started_at, finished_at, duration_ms, converted, reason, error_class, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId ?? null, trigger ?? null, status, String(projectId), String(modelId),
      versionId == null ? null : String(versionId), startedAt ?? null, finished, duration,
      converted ? 1 : 0, reason, errorClass, actor);
  return Number(info.lastInsertRowid);
}

export function syncLog(db, { projectId, modelId, limit = 25 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 25, 1), 200);
  return db.prepare(`SELECT * FROM speckle_sync WHERE project_id = ? AND model_id = ?
     ORDER BY id DESC LIMIT ?`).all(String(projectId), String(modelId), capped)
    .map(row => ({
      id: row.id, runId: row.run_id, trigger: row.trigger, status: row.status,
      versionId: row.version_id, startedAt: row.started_at, finishedAt: row.finished_at,
      durationMs: row.duration_ms, converted: Boolean(row.converted), reason: row.reason,
      errorClass: row.error_class, actor: row.actor,
    }));
}

/** The last run of any outcome, including UNCHANGED. */
export function lastSync(db, { projectId, modelId }) {
  return syncLog(db, { projectId, modelId, limit: 1 })[0] ?? null;
}

export { RUN_STATUS };

/* ── Phase 9C: version comparison and the manual element↔activity mapping ──────────────────── */

/** Every element of a version, with its full properties — what the comparison engine consumes. */
export function elementsForCompare(db, versionRowId) {
  return db.prepare('SELECT * FROM speckle_element WHERE version_row_id = ?').all(versionRowId)
    .map(row => ({
      ifcGuid: row.ifc_guid, name: row.name, ifcType: row.ifc_type, level: row.level,
      material: null,
      geometryFingerprint: parse(row.fingerprint),
      properties: parse(row.properties) ?? {},
    }));
}

/**
 * Compare two stored versions and persist the result. Idempotent.
 *
 * Derived data — it can always be recomputed — but a 63-element diff recomputed on every frame of
 * a timeline playback would be absurd, so it is stored. The UNIQUE constraint plus the delete
 * below means running this twice writes the same rows rather than doubling them.
 */
export function saveComparison(db, { projectId, modelId, fromVersionId, toVersionId }) {
  const from = versionRow(db, { projectId, modelId, versionId: fromVersionId });
  const to = versionRow(db, { projectId, modelId, versionId: toVersionId });
  if (!from || !to) return null;
  if (from.status !== 'CONVERTED' || to.status !== 'CONVERTED') return null;

  const result = compareVersions(elementsForCompare(db, from.id), elementsForCompare(db, to.id));
  const at = nowIso();

  return transact(db, () => {
    db.prepare(`DELETE FROM speckle_version_change
       WHERE project_id = ? AND model_id = ? AND from_version_id = ? AND to_version_id = ?`)
      .run(String(projectId), String(modelId), String(fromVersionId), String(toVersionId));
    const insert = db.prepare(`INSERT OR REPLACE INTO speckle_version_change (project_id, model_id,
        from_version_id, to_version_id, ifc_guid, kind, reclassified, retessellated, dimensions,
        name, ifc_type, previous_ifc_type, detail, computed_at, property_changes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const entry of result.elements) {
      // UNCHANGED elements are stored too. "What was already there in V4" is a question the
      // Changes tab must answer, and recomputing it to answer it would defeat the cache.
      insert.run(String(projectId), String(modelId), String(fromVersionId), String(toVersionId),
        entry.ifcGuid, entry.kind, entry.reclassified ? 1 : 0, entry.retessellated ? 1 : 0,
        json(entry.dimensions), entry.name ?? null, entry.ifcType ?? null,
        entry.previousIfcType ?? null, entry.detail ?? null, at,
        // Only the paths that ACTUALLY differ, with both values. "Do not display unchanged
        // properties as changes" is enforced upstream by `propertyDifferences`, which never puts
        // an equal pair in this list.
        json(entry.propertyChanges ?? []));
    }
    return { ...result, fromVersionId, toVersionId, computedAt: at };
  });
}

const shapeChange = row => ({
  ifcGuid: row.ifc_guid,
  propertyChanges: parse(row.property_changes) ?? [],
  kind: row.kind,
  reclassified: Boolean(row.reclassified),
  retessellated: Boolean(row.retessellated),
  dimensions: parse(row.dimensions) ?? [],
  name: row.name,
  ifcType: row.ifc_type,
  previousIfcType: row.previous_ifc_type,
  detail: row.detail,
});

/** A stored comparison, optionally filtered. Returns null when it has not been computed. */
export function comparison(db, { projectId, modelId, fromVersionId, toVersionId,
  kind = null, ifcType = null, search = null, limit = 500 } = {}) {
  const base = `SELECT * FROM speckle_version_change
     WHERE project_id = ? AND model_id = ? AND from_version_id = ? AND to_version_id = ?`;
  const args = [String(projectId), String(modelId), String(fromVersionId), String(toVersionId)];
  const all = db.prepare(`${base} ORDER BY kind, ifc_type, name, ifc_guid`).all(...args);
  if (!all.length) return null;

  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0, reclassified: 0,
    retessellated: 0, geometryChanged: 0, propertiesChanged: 0 };
  for (const row of all) {
    const key = String(row.kind).toLowerCase();
    if (key in counts) counts[key] += 1;
    // Counted separately: an element can be MODIFIED and reclassified, and forcing the totals to
    // add up by dropping one of them would hide a real finding.
    if (row.reclassified && row.kind === 'MODIFIED') counts.reclassified += 1;
    if (row.retessellated) counts.retessellated += 1;
    /*
     * REBUILT FROM THE STORED DIMENSIONS, not recomputed from the models.
     *
     * "20 modified" and "0 changed shape, 20 gained properties" are very different statements and
     * only the second is true of V1 → V2. These were missing from the cached counts, so the
     * timeline reported `geom 0, props 0` beside `~20` — which read as "20 elements changed and
     * we do not know how", the opposite of the point.
     */
    const dimensions = parse(row.dimensions) ?? [];
    if (dimensions.includes('GEOMETRY')) counts.geometryChanged += 1;
    if (dimensions.includes('PROPERTIES')) counts.propertiesChanged += 1;
  }

  const needle = search ? String(search).trim().toLowerCase() : null;
  const filtered = all.filter(row => {
    if (kind && row.kind !== kind) return false;
    if (ifcType && row.ifc_type !== ifcType) return false;
    if (needle && !(String(row.name ?? '').toLowerCase().includes(needle)
      || String(row.ifc_guid ?? '').toLowerCase().includes(needle))) return false;
    return true;
  });

  const types = {};
  for (const row of all) {
    const key = row.ifc_type ?? 'Unclassified';
    types[key] = (types[key] ?? 0) + 1;
  }

  const firstSeen = firstSeenByGuid(db, { projectId, modelId });

  return {
    fromVersionId, toVersionId, counts,
    ifcTypes: Object.entries(types).sort((a, b) => b[1] - a[1])
      .map(([ifcType_, count]) => ({ ifcType: ifcType_, count })),
    total: all.length,
    returned: Math.min(filtered.length, limit),
    // "First seen in V3" is a fact about the model's whole history, not about this pair, and the
    // Changes panel is asked for it on every element.
    elements: filtered.slice(0, limit).map(row => ({ ...shapeChange(row),
      firstSeenOrdinal: firstSeen.get(row.ifc_guid) ?? null })),
    computedAt: all[0].computed_at,
  };
}

/** Which version each IFC GlobalId first appeared in. The timeline's "first seen" column. */
export function firstSeenByGuid(db, { projectId, modelId }) {
  const rows = db.prepare(`SELECT e.ifc_guid AS guid, MIN(v.ordinal) AS ordinal
     FROM speckle_element e JOIN speckle_version v ON v.id = e.version_row_id
     WHERE v.project_id = ? AND v.model_id = ? AND v.status = 'CONVERTED' AND e.ifc_guid IS NOT NULL
     GROUP BY e.ifc_guid`).all(String(projectId), String(modelId));
  return new Map(rows.map(row => [row.guid, row.ordinal]));
}

/**
 * The construction timeline: every converted version, oldest first, with its own counts and the
 * change counts against the version before it.
 */
export function timeline(db, { projectId, modelId, includeUnpublished = false }) {
  const all = db.prepare(`SELECT * FROM speckle_version
     WHERE project_id = ? AND model_id = ? ORDER BY ordinal IS NULL, ordinal, source_created_at,
       id`).all(String(projectId), String(modelId)).map(shapeVersion);
  // A version deleted upstream keeps its row and its artifacts but leaves the timeline, so the
  // V1..Vn sequence stays contiguous and matches what Speckle currently publishes.
  const rows = includeUnpublished ? all : all.filter(entry => entry.published);

  const converted = rows.filter(entry => entry.status === 'CONVERTED');
  return rows.map(entry => {
    const index = converted.findIndex(other => other.versionId === entry.versionId);
    const previous = index > 0 ? converted[index - 1] : null;
    const diff = previous
      ? comparison(db, { projectId, modelId, fromVersionId: previous.versionId,
        toVersionId: entry.versionId, limit: 0 })
      : null;
    return {
      ...entry,
      previousVersionId: previous?.versionId ?? null,
      changesFromPrevious: diff?.counts ?? null,
      glbUrl: entry.status === 'CONVERTED'
        ? `/api/construction/speckle/model.glb?version=${encodeURIComponent(entry.versionId)}`
        : null,
    };
  });
}

/* ── the manual mapping ────────────────────────────────────────────────────────────────────── */

export const MAPPING_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED', APPROVED: 'APPROVED', REJECTED: 'REJECTED',
});

/**
 * The permission a session needs to decide an element↔activity link.
 *
 * `approve:BIM_MAPPING`, NOT `approve:SCHEDULE_LINK`. Deciding whether an IFC element is the
 * thing an activity builds is a BIM judgement and belongs to the BIM Coordinator; deciding
 * whether a live OpenProject activity is the same work as a synthetic P6 one is a schedule
 * judgement and stays with the Planner and the Integration Lead. Phase 9C used one string for
 * both, which locked the BIM Coordinator out of their own job.
 */
export const MAPPING_PERMISSION = 'approve:BIM_MAPPING';

const shapeMapping = row => (!row ? null : {
  id: row.id,
  ifcGuid: row.ifc_guid,
  activitySystem: row.activity_system,
  activityId: row.activity_id,
  activityName: row.activity_name,
  status: row.status,
  basis: row.basis,
  evidence: parse(row.evidence),
  proposedAt: row.proposed_at,
  proposedBy: row.proposed_by,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
  decisionNote: row.decision_note,
});

/**
 * Propose a link between a BIM element and a construction activity. NEVER applies one.
 *
 * A proposal only, and always a person's. Nothing automatic proposes these: the brief is explicit
 * that a model version publication is not a work-package completion event, and the surest way to
 * keep that true is for the system never to guess the link in the first place.
 */
export function proposeMapping(db, { projectId, modelId, ifcGuid, activitySystem, activityId,
  activityName = null, basis, evidence = null, actor = 'Demo operator' }) {
  const at = nowIso();
  const existing = db.prepare(`SELECT * FROM speckle_element_activity
     WHERE project_id = ? AND model_id = ? AND ifc_guid = ? AND activity_system = ?
       AND activity_id = ?`)
    .get(String(projectId), String(modelId), String(ifcGuid), String(activitySystem),
      String(activityId));
  if (existing) return { ok: true, created: false, mapping: shapeMapping(existing) };

  const info = db.prepare(`INSERT INTO speckle_element_activity (project_id, model_id, ifc_guid,
      activity_system, activity_id, activity_name, status, basis, evidence, proposed_at,
      proposed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(projectId), String(modelId), String(ifcGuid), String(activitySystem),
      String(activityId), activityName, MAPPING_STATUS.PROPOSED, basis, json(evidence), at, actor);

  recordAudit(db, { actor, event: 'SPECKLE_ELEMENT_MAPPING_PROPOSED',
    subject: `SPECKLE:${ifcGuid}`, next: MAPPING_STATUS.PROPOSED,
    result: `Candidate ${activitySystem} ${activityId}`,
    detail: { basis, evidence,
      note: 'A proposal only. No construction progress is derived from it until a reviewer '
        + 'approves it, and approval still derives progress from the ACTIVITY, never from the '
        + 'existence of the BIM element.' } });
  return { ok: true, created: true,
    mapping: shapeMapping(db.prepare('SELECT * FROM speckle_element_activity WHERE id = ?')
      .get(Number(info.lastInsertRowid))) };
}

/** Approve or reject a proposed mapping. */
export function decideMapping(db, { mappingId, decision, actor, note = null }) {
  if (decision !== MAPPING_STATUS.APPROVED && decision !== MAPPING_STATUS.REJECTED) {
    return { ok: false,
      error: `A decision must be ${MAPPING_STATUS.APPROVED} or ${MAPPING_STATUS.REJECTED}.` };
  }
  const row = db.prepare('SELECT * FROM speckle_element_activity WHERE id = ?')
    .get(Number(mappingId));
  if (!row) return { ok: false, error: `No candidate mapping with id ${mappingId}.` };
  if (row.status !== MAPPING_STATUS.PROPOSED) {
    return { ok: false,
      error: `That mapping is ${row.status}, not ${MAPPING_STATUS.PROPOSED}, so it cannot be `
        + 'decided again.' };
  }
  const at = nowIso();
  db.prepare(`UPDATE speckle_element_activity SET status = ?, decided_at = ?, decided_by = ?,
      decision_note = ? WHERE id = ?`).run(decision, at, actor, note, Number(mappingId));
  recordAudit(db, { actor, event: 'SPECKLE_ELEMENT_MAPPING_DECIDED',
    subject: `SPECKLE:${row.ifc_guid}`, previous: MAPPING_STATUS.PROPOSED, next: decision,
    result: `${decision} for ${row.activity_system} ${row.activity_id}`,
    detail: { note,
      warning: 'Approval links an element to an activity for reporting. Construction completion '
        + 'still comes from the activity\'s verified status; nothing is inferred from the model.' } });
  return { ok: true,
    mapping: shapeMapping(db.prepare('SELECT * FROM speckle_element_activity WHERE id = ?')
      .get(Number(mappingId))) };
}

/** Every mapping for this model, optionally by element or by activity. */
export function mappings(db, { projectId, modelId, ifcGuid = null, activityId = null,
  status = null } = {}) {
  const rows = db.prepare(`SELECT * FROM speckle_element_activity
     WHERE project_id = ? AND model_id = ? ORDER BY id`)
    .all(String(projectId), String(modelId)).map(shapeMapping);
  return rows.filter(row => (!ifcGuid || row.ifcGuid === ifcGuid)
    && (!activityId || row.activityId === String(activityId))
    && (!status || row.status === status));
}

export { CHANGE };

/**
 * Mark exactly the discovered versions as published, and everything else as not.
 *
 * Called after each discovery. A version deleted or replaced upstream keeps its row and its
 * converted artifacts — history is preserved — but drops out of the timeline, so the V1..Vn
 * sequence always matches what Speckle currently publishes rather than accumulating ghosts.
 */
export function markPublished(db, { projectId, modelId, versionIds }) {
  const ids = new Set(versionIds.map(String));
  if (!ids.size) return 0;
  const rows = db.prepare('SELECT version_id FROM speckle_version WHERE project_id = ? AND model_id = ?')
    .all(String(projectId), String(modelId));
  const update = db.prepare('UPDATE speckle_version SET published = ? WHERE project_id = ? AND model_id = ? AND version_id = ?');
  let changed = 0;
  for (const row of rows) {
    const next = ids.has(String(row.version_id)) ? 1 : 0;
    update.run(next, String(projectId), String(modelId), row.version_id);
    if (!next) changed += 1;
  }
  return changed;
}

/**
 * The bounds of the BUILDING, excluding spatial outliers.
 *
 * Why this is not just the model's bounding sphere: the real model contains an element named
 * `geo-reference` about 40 m from the house. Framing the full bounds leaves the building a speck
 * in the middle of the viewport, which is what the screen recording showed.
 *
 * THE RULE IS SPATIAL, NOT BY SIZE OR NAME. The first attempt weighted by triangle count and
 * failed outright: that marker carries 824 triangles — 44% of the whole model — so it is neither
 * small nor droppable by coverage, and weighting by it dragged the centroid out to meet it.
 * Matching on the name would work for this model and no other.
 *
 * So: the MEDIAN element centre (robust — half the elements would have to be outliers to move
 * it), then the 75th-percentile distance from it as the scale of the building, and anything
 * beyond twice that is a separate object rather than part of it.
 *
 * On the real model the distances separate cleanly: 45 elements between 0.7 m and 4.2 m, then
 * `origin` at 7.1 m and `geo-reference` at 39.7 m. The threshold lands at 5.8 m, inside that gap,
 * and the frame shrinks from 38 x 24 m to the house. A wider multiple kept the `origin` marker
 * cube, which pulled the camera target a couple of metres off the building — visible on screen as
 * a model sitting left of centre.
 *
 * Returns null when there is nothing to measure; the caller falls back to the full bounds.
 */
export function focusBounds(db, versionRowId, { spread = 2, floor = 2 } = {}) {
  const rows = db.prepare(`SELECT bounds FROM speckle_element
     WHERE version_row_id = ? AND has_geometry = 1 AND bounds IS NOT NULL`).all(versionRowId);
  const items = rows.map(row => parse(row.bounds))
    .filter(bounds => Array.isArray(bounds?.min) && Array.isArray(bounds?.max));
  if (!items.length) return null;

  const centreOf = bounds => [0, 1, 2].map(i => (bounds.min[i] + bounds.max[i]) / 2);
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const half = sorted.length >> 1;
    return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
  };

  const centres = items.map(centreOf);
  const centre = [0, 1, 2].map(axis => median(centres.map(point => point[axis])));
  const distances = centres.map(point => Math.hypot(...point.map((v, i) => v - centre[i])));
  const sorted = [...distances].sort((a, b) => a - b);
  const p75 = sorted[Math.min(sorted.length - 1, Math.floor(0.75 * (sorted.length - 1)))];
  const threshold = Math.max(p75 * spread, p75 + floor);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let kept = 0;
  items.forEach((bounds, index) => {
    if (distances[index] > threshold) return;
    kept += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], bounds.min[axis]);
      max[axis] = Math.max(max[axis], bounds.max[axis]);
    }
  });
  // Everything is an outlier only if the model is pathological; fall back rather than return a
  // degenerate box.
  if (!kept || !Number.isFinite(min[0])) return null;

  return { min, max, elementsKept: kept, elementsTotal: items.length,
    excluded: items.length - kept,
    note: `the bounds of ${kept} of ${items.length} geometry elements; `
      + `${items.length - kept} sit more than ${Math.round(threshold)} m from the median element `
      + 'centre and are treated as separate objects (survey markers and the like) rather than '
      + 'part of the building' };
}
