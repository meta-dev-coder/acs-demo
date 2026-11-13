/**
 * Phase 9C — version history, element-level comparison, and the design/construction separation.
 *
 * The comparison engine is tested against FIXTURES BUILT FROM THE REAL MODEL's own behaviour, not
 * against invented shapes. Every rule here was written because the actual IFC exporter did
 * something between V1 and V2 of `Building-Structural` that a naive diff gets wrong:
 *
 *   - it re-tessellated five meshes without moving them (68 → 64 triangles on the foundation)
 *   - it reclassified three elements (IfcBuildingElementProxy → IfcChimney / IfcDiscreteAccessory)
 *   - it gave twenty elements an IFC `PredefinedType` they did not have before
 *
 * None of those is a design change in the sense a reader means, and a comparison that reports
 * "20 modified" without saying which dimension moved is worse than useless. So the tests below
 * pin: area as the tessellation-invariant shape test, the vertex centroid as NOT a position test,
 * reclassification tracked apart from modification, and `geometryChanged` separate from
 * `propertiesChanged`.
 *
 * The other half is the separation the whole phase rests on: A PUBLISHED VERSION IS NOT A
 * BUILDING. Nothing may turn a model publication into construction progress, and with no approved
 * mapping the screen must refuse to produce a completion figure rather than estimate one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANGE, DIMENSION, TOLERANCE, compareVersions, propertyDifferences, sameGeometry,
} from '../server/construction/speckleCompare.mjs';
import { countRows, openConstructionDb } from '../server/construction/db.mjs';
import { seedSourceSystems } from '../server/construction/seed.mjs';
import {
  MAPPING_STATUS, comparison, decideMapping, markPublished, proposeMapping, publishVersion,
  saveComparison, timeline, versions as storedVersions,
} from '../server/construction/speckleStore.mjs';
import { buildStyle, CHANGE_COLOUR } from '../src/construction/bimViewer.js';
import { CHANGE_LABEL } from '../src/construction/bimTimeline.js';
import { SUBTABS } from '../src/construction/constructionProgressTabs.js';

const quiet = { warn() {}, error() {}, log() {} };
const PROJECT = '13347d8410';
const MODEL = 'd1fdafff76';

/* ── fixtures, shaped like the real model ──────────────────────────────────────────────────── */

const print = ({ area, min, max, verts = 100, tris = 30, centroid = [0, 0, 0] }) => ({
  area, centroid, bounds: { min, max }, vertexCount: verts, triangleCount: tris,
});

/** A girder, as V1 had it. */
const girderV1 = {
  ifcGuid: '0fqX614OH1YO1Njdxms2$Q', name: 'girder', ifcType: 'IfcBeam', level: null,
  properties: { 'Attributes.Name': 'girder', 'Element Type Attributes.PredefinedType': 'NOTDEFINED' },
  geometryFingerprint: print({ area: 1.234, min: [7.75, 4.9, 2.27], max: [7.96, 7.6, 2.49],
    verts: 36, tris: 12, centroid: [7.85, 6.25, 2.38] }),
};

/** The chimney the exporter reclassified without touching its shape. */
const chimneyV1 = {
  ifcGuid: '3Fbgsvr8nAYfGs9y5keub0', name: 'house - chimney',
  ifcType: 'IfcBuildingElementProxy', level: null,
  properties: { 'Attributes.Name': 'house - chimney' },
  geometryFingerprint: print({ area: 17.8279, min: [7.7, 7.6, -0.25], max: [8.4, 8.3, 4.7],
    verts: 300, tris: 100, centroid: [8.0, 7.9, 2.2] }),
};

function createDb() {
  const db = openConstructionDb({ path: ':memory:' });
  if (countRows(db, ['src_p6_activity']).src_p6_activity === 0) seedSourceSystems(db);
  return db;
}

/* ── the rule the engine exists for ────────────────────────────────────────────────────────── */

test('RE-TESSELLATION IS NOT A DESIGN CHANGE', () => {
  // The real case: the back wall went from 96 triangles to 95 between V1 and V2, with every
  // bound identical and its surface area identical to 1e-5 m².
  const before = { ...girderV1 };
  const after = { ...girderV1,
    geometryFingerprint: print({ ...girderV1.geometryFingerprint.bounds,
      area: girderV1.geometryFingerprint.area,
      min: girderV1.geometryFingerprint.bounds.min, max: girderV1.geometryFingerprint.bounds.max,
      verts: 33, tris: 11, centroid: [7.9, 6.3, 2.4] }) };

  const geometry = sameGeometry(before, after);
  assert.equal(geometry.same, true, 'same shape, same place');
  assert.equal(geometry.retessellated, true, 'but the mesh was rebuilt, and that is reported');
  assert.match(geometry.reason, /mesh was rebuilt/);

  const result = compareVersions([before], [after]);
  assert.equal(result.counts.modified, 0,
    'a rebuilt mesh with the same shape must NOT be reported as modified');
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.counts.retessellated, 1);
  assert.deepEqual(result.elements[0].dimensions, [DIMENSION.TESSELLATION]);
});

test('THE VERTEX CENTROID IS NOT A POSITION TEST', () => {
  /*
   * The real failure this pins: the back wall's vertex centroid moved 22 mm between V1 and V2
   * while its bounds and area were identical, because re-tessellating redistributes vertices.
   * Comparing the centroid reported a stationary wall as having moved.
   */
  const before = { ...girderV1 };
  const after = { ...girderV1,
    geometryFingerprint: { ...girderV1.geometryFingerprint,
      centroid: [7.8282, 6.2807, 2.3932], vertexCount: 33, triangleCount: 11 } };
  assert.ok(Math.abs(after.geometryFingerprint.centroid[0]
    - before.geometryFingerprint.centroid[0]) > TOLERANCE.distance,
  'the centroids differ by more than the tolerance');
  assert.equal(sameGeometry(before, after).same, true,
    'and the element is still correctly reported as unmoved');
});

test('a real move IS detected', () => {
  const moved = { ...girderV1,
    geometryFingerprint: print({ area: 1.234, min: [8.75, 4.9, 2.27], max: [8.96, 7.6, 2.49],
      verts: 36, tris: 12 }) };
  const geometry = sameGeometry(girderV1, moved);
  assert.equal(geometry.same, false);
  assert.match(geometry.reason, /moved or changed size/);
  const result = compareVersions([girderV1], [moved]);
  assert.equal(result.counts.modified, 1);
  assert.equal(result.counts.geometryChanged, 1);
  assert.ok(result.elements[0].dimensions.includes(DIMENSION.GEOMETRY));
});

test('a real resize IS detected, through surface area', () => {
  const bigger = { ...girderV1,
    geometryFingerprint: print({ area: 2.5, min: [7.75, 4.9, 2.27], max: [7.96, 7.6, 2.49],
      verts: 36, tris: 12 }) };
  assert.equal(sameGeometry(girderV1, bigger).same, false);
  assert.match(sameGeometry(girderV1, bigger).reason, /surface area changed/);
});

test('RECLASSIFICATION IS TRACKED SEPARATELY FROM MODIFICATION', () => {
  // The real case: IfcBuildingElementProxy → IfcChimney, geometry untouched.
  const after = { ...chimneyV1, ifcType: 'IfcChimney' };
  const result = compareVersions([chimneyV1], [after]);
  assert.equal(result.counts.reclassified, 1);
  assert.equal(result.counts.modified, 0, 'a class change alone is not a modification');
  const [entry] = result.elements;
  assert.equal(entry.kind, CHANGE.RECLASSIFIED);
  assert.equal(entry.previousIfcType, 'IfcBuildingElementProxy');
  assert.equal(entry.ifcType, 'IfcChimney');
  assert.ok(entry.dimensions.includes(DIMENSION.CLASSIFICATION));
});

test('an element can be modified AND reclassified, and both are reported', () => {
  const after = { ...chimneyV1, ifcType: 'IfcChimney',
    geometryFingerprint: print({ area: 20, min: [7.7, 7.6, -0.25], max: [9.4, 8.3, 4.7] }) };
  const [entry] = compareVersions([chimneyV1], [after]).elements;
  assert.equal(entry.kind, CHANGE.MODIFIED);
  assert.equal(entry.reclassified, true,
    'forcing the totals to add up by dropping one of these would hide a real finding');
});

test('geometry and property changes are counted SEPARATELY', () => {
  // The real V1 → V2: twenty elements gained `PredefinedType`, none changed shape.
  const after = { ...girderV1,
    properties: { ...girderV1.properties,
      'Element Type Attributes.PredefinedType': 'SOLIDWALL' } };
  const result = compareVersions([girderV1], [after]);
  assert.equal(result.counts.modified, 1);
  assert.equal(result.counts.geometryChanged, 0,
    '"20 modified" and "0 changed shape, 20 gained properties" are very different statements');
  assert.equal(result.counts.propertiesChanged, 1);
});

test('the exporter\'s own bookkeeping is ignored', () => {
  const after = { ...girderV1,
    properties: { ...girderV1.properties,
      'Attributes.id': 999, 'Attributes.OwnerHistory': 'rewritten',
      'Attributes.CreationDate': '2026-11-11', speckle_type: 'Objects.Data.DataObject' } };
  assert.deepEqual(propertyDifferences(girderV1, after), [],
    'comparing these would mark every element changed on every publication');
  assert.equal(compareVersions([girderV1], [after]).counts.unchanged, 1);
});

test('the `properties.` prefix is not counted twice', () => {
  // The flattened element carries the same value under both spellings; an unnormalised diff made
  // 17 real changes look like 34.
  const before = { ...girderV1, properties: { 'Attributes.Name': 'a', 'properties.Attributes.Name': 'a' } };
  const after = { ...girderV1, properties: { 'Attributes.Name': 'b', 'properties.Attributes.Name': 'b' } };
  assert.equal(propertyDifferences(before, after).length, 1);
});

test('the IFC class is not ALSO reported as a property change', () => {
  const before = { ...chimneyV1, properties: { ifcType: 'IfcBuildingElementProxy' } };
  const after = { ...chimneyV1, ifcType: 'IfcChimney', properties: { ifcType: 'IfcChimney' } };
  const [entry] = compareVersions([before], [after]).elements;
  assert.equal(entry.kind, CHANGE.RECLASSIFIED);
  assert.ok(!entry.dimensions.includes(DIMENSION.PROPERTIES), 'reported once, not twice');
});

test('A MISSING FINGERPRINT IS "UNKNOWN", NEVER "CHANGED"', () => {
  /*
   * The real failure: a version cached by an older converter had no shape fingerprint, and the
   * first comparison after the upgrade reported 16 elements as having gained geometry. None had.
   */
  const old = { ...girderV1, geometryFingerprint: null };
  const geometry = sameGeometry(old, girderV1);
  assert.equal(geometry.same, true);
  assert.equal(geometry.unknown, true);
  assert.match(geometry.reason, /before shape fingerprints were recorded/);
  const result = compareVersions([old], [girderV1]);
  assert.equal(result.counts.modified, 0, 'uncertainty must not be reported as a change');
  assert.ok(result.elements[0].dimensions.includes(DIMENSION.GEOMETRY_UNKNOWN));
});

test('identity is the IFC GlobalId, never the name', () => {
  // The real model has six elements called "girder" and two called "beam shoe".
  const a = [{ ...girderV1, ifcGuid: 'AAA' }, { ...girderV1, ifcGuid: 'BBB' }];
  const b = [{ ...girderV1, ifcGuid: 'AAA' }, { ...girderV1, ifcGuid: 'CCC' }];
  const result = compareVersions(a, b);
  assert.equal(result.counts.added, 1);
  assert.equal(result.counts.removed, 1);
  assert.equal(result.counts.unchanged, 1);
});

test('added and removed are classified from the GUID set', () => {
  const result = compareVersions([girderV1], [girderV1, chimneyV1]);
  assert.equal(result.counts.added, 1);
  assert.equal(result.elements.find(e => e.ifcGuid === chimneyV1.ifcGuid).kind, CHANGE.ADDED);
  const back = compareVersions([girderV1, chimneyV1], [girderV1]);
  assert.equal(back.counts.removed, 1);
  assert.equal(back.elements.find(e => e.ifcGuid === chimneyV1.ifcGuid).kind, CHANGE.REMOVED);
});

test('elements with no GlobalId are counted, not silently dropped or name-matched', () => {
  const result = compareVersions([{ ...girderV1, ifcGuid: null }], [girderV1]);
  assert.equal(result.counts.beforeUnidentified, 1);
  assert.equal(result.counts.added, 1, 'the identified one is new; nothing is matched by name');
});

test('containers with no geometry are never reported as changed', () => {
  const site = { ifcGuid: 'SITE', name: 'house - site', ifcType: 'IfcSite',
    properties: {}, geometryFingerprint: null };
  assert.equal(compareVersions([site], [site]).counts.unchanged, 1);
});

test('every comparison carries the design-is-not-construction caveat', () => {
  const result = compareVersions([girderV1], [girderV1]);
  assert.match(result.caveat, /drawn, not that it was built/);
});

/* ── persistence ───────────────────────────────────────────────────────────────────────────── */

const manifestFor = (count, triangles) => ({ counts: { objects: count, vertices: count * 10,
  triangles }, units: 'm', glbBytes: 1000, boundsModel: { min: [0, 0, 0], max: [1, 1, 1] },
source: { projectName: 'My First Project', modelName: 'Building-Structural' } });

function publish(db, versionId, elements, { ordinal, label, createdAt, activate = true }) {
  return publishVersion(db, { projectId: PROJECT, modelId: MODEL, versionId,
    manifest: manifestFor(elements.length, elements.length * 3),
    artifactDir: `/tmp/${versionId}`, elements, activate,
    // noteVersion carries the ordinal; publishVersion calls it.
  }) && (() => {
    db.prepare('UPDATE speckle_version SET ordinal = ?, label = ?, source_created_at = ? '
      + 'WHERE project_id = ? AND model_id = ? AND version_id = ?')
      .run(ordinal, label, createdAt, PROJECT, MODEL, versionId);
    return storedVersions(db, { projectId: PROJECT, modelId: MODEL })
      .find(entry => entry.versionId === versionId);
  })();
}

test('a stored comparison is idempotent and keeps unchanged elements', () => {
  const db = createDb();
  publish(db, 'v1', [girderV1, chimneyV1], { ordinal: 1, label: 'V1',
    createdAt: '2026-11-11T04:00:00Z', activate: false });
  publish(db, 'v2', [girderV1, { ...chimneyV1, ifcType: 'IfcChimney' }],
    { ordinal: 2, label: 'V2', createdAt: '2026-11-11T06:00:00Z' });

  const first = saveComparison(db, { projectId: PROJECT, modelId: MODEL,
    fromVersionId: 'v1', toVersionId: 'v2' });
  assert.ok(first);
  saveComparison(db, { projectId: PROJECT, modelId: MODEL, fromVersionId: 'v1', toVersionId: 'v2' });

  const stored = comparison(db, { projectId: PROJECT, modelId: MODEL,
    fromVersionId: 'v1', toVersionId: 'v2' });
  assert.equal(stored.total, 2, 'running it twice writes the same rows, not double');
  assert.equal(stored.counts.reclassified, 1);
  assert.equal(stored.counts.unchanged, 1);
  // Unchanged rows are kept: "what was already there" is a question the Changes tab must answer.
  assert.ok(stored.elements.some(entry => entry.kind === CHANGE.UNCHANGED));
});

test('the stored counts rebuild the geometry/properties split', () => {
  const db = createDb();
  const after = { ...girderV1,
    properties: { ...girderV1.properties, 'Element Type Attributes.PredefinedType': 'SOLIDWALL' } };
  publish(db, 'v1', [girderV1], { ordinal: 1, label: 'V1', createdAt: '2026-11-11T04:00:00Z',
    activate: false });
  publish(db, 'v2', [after], { ordinal: 2, label: 'V2', createdAt: '2026-11-11T06:00:00Z' });
  saveComparison(db, { projectId: PROJECT, modelId: MODEL, fromVersionId: 'v1', toVersionId: 'v2' });
  const stored = comparison(db, { projectId: PROJECT, modelId: MODEL,
    fromVersionId: 'v1', toVersionId: 'v2' });
  assert.equal(stored.counts.modified, 1);
  assert.equal(stored.counts.geometryChanged, 0,
    'the cached counts must carry the split, or the timeline reads "20 changed, we do not know how"');
  assert.equal(stored.counts.propertiesChanged, 1);
});

test('the comparison can be filtered by kind, class and search', () => {
  const db = createDb();
  publish(db, 'v1', [girderV1], { ordinal: 1, label: 'V1', createdAt: '2026-11-11T04:00:00Z',
    activate: false });
  publish(db, 'v2', [girderV1, chimneyV1], { ordinal: 2, label: 'V2',
    createdAt: '2026-11-11T06:00:00Z' });
  saveComparison(db, { projectId: PROJECT, modelId: MODEL, fromVersionId: 'v1', toVersionId: 'v2' });
  const base = { projectId: PROJECT, modelId: MODEL, fromVersionId: 'v1', toVersionId: 'v2' };
  assert.equal(comparison(db, { ...base, kind: 'ADDED' }).elements.length, 1);
  assert.equal(comparison(db, { ...base, ifcType: 'IfcBeam' }).elements.length, 1);
  assert.equal(comparison(db, { ...base, search: 'chimney' }).elements.length, 1);
  assert.equal(comparison(db, { ...base, search: chimneyV1.ifcGuid }).elements.length, 1,
    'searchable by IFC GlobalId as well as by name');
  // The counts always describe the WHOLE comparison, never the filtered page.
  assert.equal(comparison(db, { ...base, kind: 'ADDED' }).counts.unchanged, 1);
});

test('the timeline is chronological and carries each version\'s change counts', () => {
  const db = createDb();
  publish(db, 'vb', [girderV1, chimneyV1], { ordinal: 2, label: 'V2',
    createdAt: '2026-11-11T06:00:00Z' });
  publish(db, 'va', [girderV1], { ordinal: 1, label: 'V1', createdAt: '2026-11-11T04:00:00Z',
    activate: false });
  saveComparison(db, { projectId: PROJECT, modelId: MODEL, fromVersionId: 'va', toVersionId: 'vb' });

  const entries = timeline(db, { projectId: PROJECT, modelId: MODEL });
  assert.deepEqual(entries.map(entry => entry.versionId), ['va', 'vb'], 'oldest first');
  assert.equal(entries[0].changesFromPrevious, null, 'the baseline has no previous');
  assert.equal(entries[1].changesFromPrevious.added, 1);
  assert.equal(entries[1].previousVersionId, 'va');
  assert.match(entries[1].glbUrl, /model\.glb\?version=vb/);
});

test('A VERSION DELETED UPSTREAM LEAVES THE TIMELINE BUT KEEPS ITS ARTIFACTS', () => {
  // This happened mid-implementation: a published version was replaced, and a cached ghost would
  // otherwise have sat in the timeline with a stale ordinal.
  const db = createDb();
  publish(db, 'va', [girderV1], { ordinal: 1, label: 'V1', createdAt: '2026-11-11T04:00:00Z',
    activate: false });
  publish(db, 'vgone', [girderV1, chimneyV1], { ordinal: 2, label: 'V2',
    createdAt: '2026-11-11T06:00:00Z' });

  markPublished(db, { projectId: PROJECT, modelId: MODEL, versionIds: ['va'] });
  assert.deepEqual(timeline(db, { projectId: PROJECT, modelId: MODEL })
    .map(entry => entry.versionId), ['va']);
  const kept = timeline(db, { projectId: PROJECT, modelId: MODEL, includeUnpublished: true });
  assert.equal(kept.length, 2, 'the row and its artifacts are preserved');
  assert.equal(kept.find(entry => entry.versionId === 'vgone').published, false);
});

/* ── the design/construction separation ────────────────────────────────────────────────────── */

test('A MAPPING IS A PROPOSAL, AND NOTHING AUTOMATIC CREATES ONE', () => {
  const db = createDb();
  const result = proposeMapping(db, { projectId: PROJECT, modelId: MODEL,
    ifcGuid: girderV1.ifcGuid, activitySystem: 'OPENPROJECT', activityId: '38',
    activityName: 'Cast Level 2 Columns', basis: 'MANUAL', actor: 'Planner' });
  assert.equal(result.mapping.status, MAPPING_STATUS.PROPOSED);
  assert.equal(result.mapping.decidedAt, null);

  // Proposing the same pair twice does not duplicate it.
  const again = proposeMapping(db, { projectId: PROJECT, modelId: MODEL,
    ifcGuid: girderV1.ifcGuid, activitySystem: 'OPENPROJECT', activityId: '38',
    basis: 'MANUAL', actor: 'Planner' });
  assert.equal(again.created, false);

  const decided = decideMapping(db, { mappingId: result.mapping.id,
    decision: MAPPING_STATUS.APPROVED, actor: 'Planner' });
  assert.equal(decided.mapping.status, MAPPING_STATUS.APPROVED);
  // And it cannot be decided twice.
  assert.equal(decideMapping(db, { mappingId: result.mapping.id,
    decision: MAPPING_STATUS.REJECTED, actor: 'Planner' }).ok, false);
});

test('publishing versions touches no synthetic P6, SYNCHRO, SAP or ACC row', () => {
  const db = createDb();
  const watched = ['src_p6_activity', 'src_acc_element', 'src_sap_cost', 'element', 'activity',
    'cost', 'sync_run', 'outbound_proposal', 'progress_observation'];
  const before = countRows(db, watched);
  const beforeP6 = db.prepare('SELECT * FROM src_p6_activity ORDER BY activity_id').all();
  publish(db, 'v1', [girderV1], { ordinal: 1, label: 'V1', createdAt: '2026-11-11T04:00:00Z',
    activate: false });
  publish(db, 'v2', [girderV1, chimneyV1], { ordinal: 2, label: 'V2',
    createdAt: '2026-11-11T06:00:00Z' });
  saveComparison(db, { projectId: PROJECT, modelId: MODEL, fromVersionId: 'v1', toVersionId: 'v2' });
  proposeMapping(db, { projectId: PROJECT, modelId: MODEL, ifcGuid: girderV1.ifcGuid,
    activitySystem: 'P6', activityId: 'A-1020', basis: 'MANUAL', actor: 'Planner' });

  assert.deepEqual(countRows(db, watched), before);
  assert.deepEqual(db.prepare('SELECT * FROM src_p6_activity ORDER BY activity_id').all(),
    beforeP6, 'byte for byte');
  void quiet;
});

/* ── the viewer and the UI vocabulary ──────────────────────────────────────────────────────── */

test('the Cesium style colours each change kind, with a neutral fallback', () => {
  const style = buildStyle({ changes: { a: 'ADDED', m: 'MODIFIED', u: 'UNCHANGED' } });
  const conditions = style.color.conditions;
  assert.ok(conditions.some(([expr, colour]) =>
    expr.includes("'a'") && colour.includes(CHANGE_COLOUR.ADDED)));
  assert.ok(conditions.some(([expr, colour]) =>
    expr.includes("'m'") && colour.includes(CHANGE_COLOUR.MODIFIED)));
  assert.deepEqual(conditions.at(-1), ['true', `color('${CHANGE_COLOUR.UNCHANGED}')`],
    'everything else is neutral grey');
});

test('hiding a change category becomes a show clause, ANDed with the class filter', () => {
  const style = buildStyle({ visibleTypes: ['IfcBeam'],
    changes: { u: 'UNCHANGED', a: 'ADDED' }, hiddenKinds: new Set(['UNCHANGED']) });
  assert.match(style.show, /IfcBeam/);
  assert.match(style.show, /\$\{ifcGuid\} !== 'u'/);
  assert.ok(!style.show.includes("!== 'a'"), 'only the hidden kind is excluded');
});

test('a quote in a GUID or class cannot break out of the style expression', () => {
  const style = buildStyle({ visibleTypes: ["Ifc' || true || '"],
    changes: { "x' || true || '": 'ADDED' } });
  assert.ok(!style.show.includes("' || true || '"));
  assert.ok(!JSON.stringify(style.color ?? {}).includes("' || true || '"));
});

test('every change kind has a label AND a colour — never colour alone', () => {
  for (const kind of Object.values(CHANGE)) {
    assert.ok(CHANGE_LABEL[kind], `${kind} has a label`);
    assert.ok(CHANGE_LABEL[kind].colour, `${kind} has a colour`);
    assert.ok(['ok', 'warn', 'bad', 'info'].includes(CHANGE_LABEL[kind].tone));
  }
  assert.equal(CHANGE_LABEL.UNCHANGED.tone, 'info', 'unchanged is not a problem');
});

test('Construction Progress keeps its existing screen as one of four subtabs', () => {
  assert.deepEqual(SUBTABS.map(tab => tab.id),
    ['overview', 'timeline', 'changes', 'schedule']);
  // The existing synthetic P6 screen is the `schedule` tab and is mounted unchanged — rebuilding
  // it to add a timeline would have risked a working feature to deliver a new one.
  assert.equal(SUBTABS.at(-1).label, 'Schedule & Progress');
});

/* ── Phase 9D: the Timeline / Changes split ────────────────────────────────────────────────── */

test('the two BIM subtabs are separate screens over one shared workspace', async () => {
  const { createBimWorkspace } = await import('../src/construction/bimWorkspace.js');
  const built = [];
  const fakeViewer = () => ({
    container: { remove() {} }, viewer: { resize() {}, scene: { requestRender() {} } },
    load: async () => { built.push('load'); }, fit() {}, cameraPose: () => null,
    restorePose: () => true, fitElement: () => true, setChanges() {}, setHiddenKinds() {},
    select() {}, destroy() {},
  });
  const timelinePayload = { versions: [
    { versionId: 'v1', label: 'V1', ordinal: 1, status: 'CONVERTED', elementCount: 20,
      glbUrl: '/a.glb', changesFromPrevious: null },
    { versionId: 'v2', label: 'V2', ordinal: 2, status: 'CONVERTED', elementCount: 23,
      glbUrl: '/b.glb', changesFromPrevious: { added: 3, removed: 0, modified: 0 } },
  ], activeVersionId: 'v2', placement: {} };
  const fetchJson = async path => {
    if (path.includes('/timeline')) return timelinePayload;
    if (path.includes('/compare')) {
      return { counts: { added: 1, removed: 0, modified: 0, unchanged: 1 },
        elements: [{ ifcGuid: 'NEW', kind: 'ADDED', name: 'a wall', ifcType: 'IfcWall',
          dimensions: [] },
        { ifcGuid: 'OLD', kind: 'UNCHANGED', name: 'a girder', ifcType: 'IfcBeam',
          dimensions: [] }] };
    }
    return { element: { ifcGuid: 'NEW', name: 'a wall', ifcType: 'IfcWall' } };
  };

  const workspace = createBimWorkspace({ fetchJson, viewerFactory: fakeViewer });
  await workspace.load();
  assert.equal(workspace.state.timeline.length, 2);
  // The baseline follows the selection: V2 selected means V1 → V2.
  assert.equal(workspace.state.selectedVersionId, 'v2');
  assert.equal(workspace.state.baselineVersionId, 'v1');
  assert.equal(workspace.state.comparison.counts.added, 1);

  // The change map is built from the WHOLE comparison, so a filtered list cannot recolour the model.
  assert.deepEqual(workspace.changeMap(), { NEW: 'ADDED', OLD: 'UNCHANGED' });
});

test('the appearance toggle removes the style rather than replacing the materials', async () => {
  const { createBimWorkspace, APPEARANCE } = await import('../src/construction/bimWorkspace.js');
  const applied = [];
  const fakeViewer = () => ({
    container: { remove() {} }, viewer: { resize() {}, scene: { requestRender() {} } },
    load: async () => {}, fit() {}, cameraPose: () => null, restorePose: () => true,
    fitElement: () => true,
    setChanges(map) { applied.push(map); }, setHiddenKinds() {}, select() {}, destroy() {},
  });
  const workspace = createBimWorkspace({
    fetchJson: async path => (path.includes('/timeline')
      ? { versions: [{ versionId: 'v1', label: 'V1', ordinal: 1, status: 'CONVERTED',
        elementCount: 1, glbUrl: '/a.glb' }], activeVersionId: 'v1', placement: {} }
      : { counts: {}, elements: [] }),
    viewerFactory: fakeViewer,
  });
  workspace.attach({ append() {} });
  await workspace.load();
  workspace.setAppearance(APPEARANCE.ORIGINAL);
  assert.equal(applied.at(-1), null, 'the style is cleared, so the original materials show');
  workspace.setAppearance(APPEARANCE.CHANGES);
  assert.notEqual(applied.at(-1), undefined);
});

test('the Changes filters are mutually inclusive and never double-counted into one total', async () => {
  const { filterElements, matchesFilter, FILTERS } = await import('../src/construction/bimChanges.js');
  // An element that is geometry-modified AND reclassified belongs in both buckets.
  const both = { ifcGuid: 'X', kind: 'MODIFIED', reclassified: true,
    dimensions: ['GEOMETRY', 'CLASSIFICATION'], ifcType: 'IfcWall', name: 'w' };
  assert.equal(matchesFilter(both, 'GEOMETRY'), true);
  assert.equal(matchesFilter(both, 'RECLASSIFIED'), true);
  assert.equal(matchesFilter(both, 'PROPERTIES'), false);
  // Which is exactly why the buckets are shown as separate counts and never summed.
  assert.equal(FILTERS.length, 6);

  const rows = [both, { ifcGuid: 'Y', kind: 'UNCHANGED', dimensions: [], ifcType: 'IfcBeam',
    name: 'girder' }];
  assert.equal(filterElements(rows, { kinds: new Set(['GEOMETRY']) }).length, 1);
  assert.equal(filterElements(rows, { kinds: new Set(), ifcType: 'IfcBeam' }).length, 1);
  assert.equal(filterElements(rows, { kinds: new Set(), search: 'gird' }).length, 1);
  assert.equal(filterElements(rows, { kinds: new Set(), search: 'X' }).length, 1,
    'searchable by IFC GlobalId too');
});

test('a property-only change is never reported as a geometry change', async () => {
  const { matchesFilter } = await import('../src/construction/bimChanges.js');
  const propsOnly = { ifcGuid: 'P', kind: 'MODIFIED', dimensions: ['PROPERTIES'] };
  assert.equal(matchesFilter(propsOnly, 'PROPERTIES'), true);
  assert.equal(matchesFilter(propsOnly, 'GEOMETRY'), false,
    'the real V1 → V2 case: 20 elements gained a PredefinedType and none moved');
});

test('newly introduced IFC classifications are derived, not hardcoded', async () => {
  const { introducedClasses } = await import('../src/construction/bimTimeline.js');
  const comparison = { elements: [
    { kind: 'ADDED', ifcType: 'IfcWindow' },
    { kind: 'ADDED', ifcType: 'IfcWindow' },
    { kind: 'ADDED', ifcType: 'IfcBeam' },
    { kind: 'UNCHANGED', ifcType: 'IfcBeam' },
  ] };
  const result = introducedClasses(comparison);
  const window_ = result.find(entry => entry.ifcType === 'IfcWindow');
  const beam = result.find(entry => entry.ifcType === 'IfcBeam');
  assert.equal(window_.count, 2);
  assert.equal(window_.isNew, true, 'no IfcWindow existed before this version');
  assert.equal(beam.isNew, false, 'beams were already there');
  assert.equal(result[0].ifcType, 'IfcWindow', 'newly introduced classes sort first');
});

test('unchanged geometry stays visible in 3D by default', async () => {
  const { DEFAULT_VISIBLE_KINDS, createBimWorkspace } = await import('../src/construction/bimWorkspace.js');
  assert.ok(DEFAULT_VISIBLE_KINDS.includes('UNCHANGED'),
    'hiding it strips the context that makes an added wall legible as a wall');
  const workspace = createBimWorkspace({ fetchJson: async () => ({ versions: [] }) });
  assert.equal(workspace.state.hiddenKinds.size, 0);
  workspace.toggleKind('UNCHANGED');
  assert.equal(workspace.state.hiddenKinds.has('UNCHANGED'), true, 'and only when asked');
});
