/**
 * What changed between two published BIM versions.
 *
 * PURE and deterministic — two element lists in, a classification out — so every rule below is
 * testable against a fixture and the persistence layer only has to store the answer.
 *
 * The rule this engine exists for, stated first because it is the one a naive diff gets wrong:
 *
 *   AN EXPORTER RE-TESSELLATING A SHAPE IS NOT A DESIGN CHANGE.
 *
 * Between V1 and V2 of the real model the IFC exporter rebuilt five meshes — the foundation went
 * from 68 triangles to 64, the back wall from 96 to 95 — and not one of them moved: every bound
 * is identical to six decimal places and every surface area to 1e-5 m². A comparison keyed on
 * vertex or triangle counts reports five elements as "modified" and buries the three that
 * genuinely changed. So geometry equality is **bounds + surface area + centroid**, each compared
 * with a tolerance, and the counts are reported but never compared.
 *
 * The second rule: IDENTITY IS THE IFC GlobalId, never the name. The real model contains six
 * elements all called "girder" and two called "beam shoe"; names identify nothing.
 *
 * The third: A VERSION PUBLICATION IS NOT CONSTRUCTION. Everything here describes the evolution
 * of a published design. Nothing in this file infers that anything was built.
 */

/** How an element differs between two versions. An element may carry several. */
export const CHANGE = Object.freeze({
  ADDED: 'ADDED',
  REMOVED: 'REMOVED',
  MODIFIED: 'MODIFIED',
  UNCHANGED: 'UNCHANGED',
  /** The IFC class changed. Tracked separately from geometry, because it means something else. */
  RECLASSIFIED: 'RECLASSIFIED',
});

/**
 * Which dimension of an element moved. One element can report more than one.
 *
 * `GEOMETRY` and `TESSELLATION` are deliberately different findings: the first means the shape or
 * its position changed, the second means only the triangulation did. Only the first makes an
 * element MODIFIED.
 */
export const DIMENSION = Object.freeze({
  GEOMETRY: 'GEOMETRY',
  CLASSIFICATION: 'CLASSIFICATION',
  PROPERTIES: 'PROPERTIES',
  NAME: 'NAME',
  LEVEL: 'LEVEL',
  MATERIAL: 'MATERIAL',
  /** Reported, never a reason to call an element modified. */
  TESSELLATION: 'TESSELLATION',
  /** One side predates shape fingerprints, so geometry could not be compared at all. */
  GEOMETRY_UNKNOWN: 'GEOMETRY_UNKNOWN',
});

/**
 * Tolerances, in the model's own units (metres) and square metres.
 *
 * A millimetre on a building, and a square millimetre of surface. Loose enough to absorb the
 * float32 round-trip through the GLB and the exporter's own rounding; tight enough that any
 * change a person would call a change exceeds it.
 */
export const TOLERANCE = Object.freeze({
  distance: 1e-3,
  area: 1e-3,
});

/**
 * Properties that say nothing about the design.
 *
 * An IFC exporter rewrites these on every run — internal row ids, the exporter's own name, the
 * file timestamp — and comparing them would mark every element in the model as changed on every
 * publication. Matched case-insensitively against the leaf of the property path.
 */
export const IGNORED_PROPERTIES = Object.freeze([
  'id', 'guid', 'globalid', 'ownerhistory', 'tag',
  'applicationidentifier', 'applicationfullname', 'applicationdeveloper',
  'creationdate', 'lastmodifieddate', 'timestamp', 'speckle_type', 'units',
  // The IFC class has its own dimension. Comparing it here as well reported every
  // reclassification twice — once as RECLASSIFIED and once as a property change.
  'ifctype',
]);

const leaf = key => String(key).split('.').pop().toLowerCase();
const ignored = key => IGNORED_PROPERTIES.includes(leaf(key));

/**
 * The property path without the converter's `properties.` prefix.
 *
 * The flattened element carries the same value under both `Attributes.PredefinedType` and
 * `properties.Attributes.PredefinedType`, so an unnormalised diff counted every real change
 * twice and made 17 changed properties look like 34.
 */
const canonical = key => String(key).replace(/^properties\./, '');

const close = (a, b, tolerance) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) === String(b);
  return Math.abs(x - y) <= tolerance;
};

const closeTriple = (a, b, tolerance) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return a == null && b == null;
  if (a.length !== b.length) return false;
  return a.every((value, index) => close(value, b[index], tolerance));
};

/**
 * Are these two elements the same shape, in the same place?
 *
 * @returns {{same: boolean, reason: string|null, retessellated: boolean}}
 */
export function sameGeometry(before, after) {
  const a = before?.geometryFingerprint ?? null;
  const b = after?.geometryFingerprint ?? null;

  // "Neither has geometry" is not a change: containers (IfcSite, IfcBuilding, IfcBuildingStorey)
  // legitimately carry none, and calling them modified every version would be noise.
  if (!a && !b) return { same: true, reason: null, retessellated: false };

  /*
   * ONE SIDE HAS NO FINGERPRINT: we cannot tell, and "cannot tell" is not "changed".
   *
   * This happens when a version was converted by an older build of the converter, before shape
   * fingerprints existed. The first run after the upgrade compared a fingerprinted version
   * against a cached one and reported 16 elements as having gained geometry — none had; the
   * older artifact simply did not record it. Reporting uncertainty as a change is the worse of
   * the two errors, so it is reported as unknown and the element is not called modified.
   */
  if (!a || !b) {
    return { same: true, unknown: true, retessellated: false,
      reason: 'geometry could not be compared: one of the two versions was converted before '
        + 'shape fingerprints were recorded. Re-convert that version to compare it.' };
  }

  const retessellated = a.vertexCount !== b.vertexCount || a.triangleCount !== b.triangleCount;

  if (!close(a.area, b.area, TOLERANCE.area)) {
    return { same: false, retessellated,
      reason: `surface area changed from ${a.area} to ${b.area} m²` };
  }
  /*
   * THE CENTROID IS REPORTED BUT NOT COMPARED.
   *
   * It is the average of the VERTICES, so re-tessellating a shape moves it even though the shape
   * has not moved: the back wall's vertex centroid shifted 22 mm between V1 and V2 while its
   * bounds and surface area stayed identical to four decimal places. Comparing it reported a
   * stationary wall as having moved. The bounding box is the position test, and it is invariant
   * to triangulation.
   */
  if (!closeTriple(a.bounds?.min, b.bounds?.min, TOLERANCE.distance)
    || !closeTriple(a.bounds?.max, b.bounds?.max, TOLERANCE.distance)) {
    return { same: false, retessellated,
      reason: 'the element moved or changed size (its bounding box changed)' };
  }
  // Area, centroid and extent all agree. If the counts differ the exporter rebuilt the mesh, and
  // that is reported as a tessellation note rather than as a design change.
  return { same: true, retessellated,
    reason: retessellated
      ? `the mesh was rebuilt (${a.triangleCount} → ${b.triangleCount} triangles) with the same `
        + 'shape, position and surface area'
      : null };
}

/** Which meaningful properties differ, ignoring the exporter's own bookkeeping. */
export function propertyDifferences(before, after) {
  const a = before?.properties ?? {};
  const b = after?.properties ?? {};
  const index = source => {
    const out = new Map();
    for (const [key, value] of Object.entries(source)) {
      if (ignored(key)) continue;
      // The prefixed spelling wins where both exist; they always hold the same value.
      const name = canonical(key);
      if (!out.has(name) || key.startsWith('properties.')) out.set(name, value);
    }
    return out;
  };
  const left_ = index(a);
  const right_ = index(b);
  const keys = new Set([...left_.keys(), ...right_.keys()]);
  const changed = [];
  for (const key of [...keys].sort()) {
    const left = left_.get(key);
    const right = right_.get(key);
    if (left === right) continue;
    // Numbers compare numerically so `837` and `837.0` are the same value, which is how the
    // exporter writes the same number on two different runs.
    if (typeof left === 'number' || typeof right === 'number') {
      if (close(left, right, 1e-9)) continue;
    }
    if (String(left ?? '') === String(right ?? '')) continue;
    changed.push({ key, before: left ?? null, after: right ?? null });
  }
  return changed;
}

/** One element, classified. */
function classify(guid, before, after) {
  if (!before) {
    return { ifcGuid: guid, kind: CHANGE.ADDED, dimensions: [],
      name: after.name, ifcType: after.ifcType, level: after.level ?? null,
      hasGeometry: Boolean(after.geometryFingerprint),
      detail: `First published in this version as ${after.ifcType}.` };
  }
  if (!after) {
    return { ifcGuid: guid, kind: CHANGE.REMOVED, dimensions: [],
      name: before.name, ifcType: before.ifcType, level: before.level ?? null,
      hasGeometry: Boolean(before.geometryFingerprint),
      detail: 'Present in the earlier version and absent from this one.' };
  }

  const dimensions = [];
  const notes = [];

  const geometry = sameGeometry(before, after);
  if (geometry.unknown) {
    // Recorded so a reader knows the comparison is incomplete, but NOT a substantive dimension:
    // it must not make the element modified.
    dimensions.push(DIMENSION.GEOMETRY_UNKNOWN);
    notes.push(geometry.reason);
  } else if (!geometry.same) {
    dimensions.push(DIMENSION.GEOMETRY);
    notes.push(geometry.reason);
  } else if (geometry.retessellated) {
    dimensions.push(DIMENSION.TESSELLATION);
    notes.push(geometry.reason);
  }

  const reclassified = String(before.ifcType ?? '') !== String(after.ifcType ?? '');
  if (reclassified) {
    dimensions.push(DIMENSION.CLASSIFICATION);
    notes.push(`reclassified from ${before.ifcType} to ${after.ifcType}`);
  }
  if (String(before.name ?? '') !== String(after.name ?? '')) {
    dimensions.push(DIMENSION.NAME);
    notes.push(`renamed from "${before.name}" to "${after.name}"`);
  }
  if (String(before.level ?? '') !== String(after.level ?? '')) {
    dimensions.push(DIMENSION.LEVEL);
    notes.push(`storey changed from ${before.level ?? 'none'} to ${after.level ?? 'none'}`);
  }
  if (String(before.material ?? '') !== String(after.material ?? '')) {
    dimensions.push(DIMENSION.MATERIAL);
    notes.push(`material changed from ${before.material ?? 'none'} to ${after.material ?? 'none'}`);
  }
  const properties = propertyDifferences(before, after);
  if (properties.length) {
    dimensions.push(DIMENSION.PROPERTIES);
    notes.push(`${properties.length} propert${properties.length === 1 ? 'y' : 'ies'} changed`);
  }

  /*
   * WHAT MAKES AN ELEMENT "MODIFIED".
   *
   * Real geometry, properties, name, storey or material. NOT a tessellation difference on its
   * own, and NOT a reclassification on its own — the brief asks for reclassification to be
   * tracked separately, and an element whose only change is its IFC class is a reclassification,
   * not a modification. An element can be both.
   */
  const substantive = dimensions.filter(entry => entry !== DIMENSION.TESSELLATION
    && entry !== DIMENSION.CLASSIFICATION && entry !== DIMENSION.GEOMETRY_UNKNOWN);
  const kind = substantive.length ? CHANGE.MODIFIED
    : reclassified ? CHANGE.RECLASSIFIED
      : CHANGE.UNCHANGED;

  return {
    ifcGuid: guid,
    kind,
    /** Both are reported: an element can be modified AND reclassified. */
    reclassified,
    dimensions,
    name: after.name,
    ifcType: after.ifcType,
    previousIfcType: reclassified ? before.ifcType : null,
    level: after.level ?? null,
    hasGeometry: Boolean(after.geometryFingerprint),
    retessellated: geometry.retessellated,
    propertyChanges: properties.slice(0, 20),
    detail: notes.length ? notes.join('; ')
      : 'Identical geometry, classification and properties.',
  };
}

/**
 * Compare two versions, element by element.
 *
 * @param {Array} beforeElements the OLDER version's elements
 * @param {Array} afterElements the NEWER version's elements
 */
export function compareVersions(beforeElements = [], afterElements = []) {
  const before = new Map();
  const after = new Map();
  // Elements with no GlobalId cannot be tracked across versions at all. They are counted and
  // reported rather than silently dropped or matched on a name.
  let beforeUnidentified = 0;
  let afterUnidentified = 0;
  for (const element of beforeElements) {
    if (element?.ifcGuid) before.set(element.ifcGuid, element); else beforeUnidentified += 1;
  }
  for (const element of afterElements) {
    if (element?.ifcGuid) after.set(element.ifcGuid, element); else afterUnidentified += 1;
  }

  const guids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const elements = guids.map(guid => classify(guid, before.get(guid) ?? null,
    after.get(guid) ?? null));

  /*
   * `geometryChanged` and `propertiesChanged` are counted separately from `modified` on purpose.
   * "20 elements modified" and "0 elements changed shape, 17 gained an IFC PredefinedType" are
   * very different statements about a design, and only the second is true of V1 → V2.
   */
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0, reclassified: 0,
    retessellated: 0, geometryChanged: 0, propertiesChanged: 0 };
  const byType = {};
  for (const entry of elements) {
    if (entry.kind === CHANGE.ADDED) counts.added += 1;
    else if (entry.kind === CHANGE.REMOVED) counts.removed += 1;
    else if (entry.kind === CHANGE.MODIFIED) counts.modified += 1;
    else if (entry.kind === CHANGE.RECLASSIFIED) counts.reclassified += 1;
    else counts.unchanged += 1;
    // Counted separately, because an element can be both modified and reclassified and the two
    // totals must not be made to add up by dropping one of them.
    if (entry.reclassified && entry.kind === CHANGE.MODIFIED) counts.reclassified += 1;
    if (entry.retessellated) counts.retessellated += 1;
    if (entry.dimensions?.includes(DIMENSION.GEOMETRY)) counts.geometryChanged += 1;
    if (entry.dimensions?.includes(DIMENSION.PROPERTIES)) counts.propertiesChanged += 1;
    const key = entry.ifcType ?? 'Unclassified';
    byType[key] ??= { added: 0, removed: 0, modified: 0, unchanged: 0, reclassified: 0 };
    const bucket = byType[key];
    if (entry.kind === CHANGE.ADDED) bucket.added += 1;
    else if (entry.kind === CHANGE.REMOVED) bucket.removed += 1;
    else if (entry.kind === CHANGE.MODIFIED) bucket.modified += 1;
    else if (entry.kind === CHANGE.RECLASSIFIED) bucket.reclassified += 1;
    else bucket.unchanged += 1;
  }

  return {
    elements,
    counts: {
      ...counts,
      beforeTotal: beforeElements.length,
      afterTotal: afterElements.length,
      tracked: guids.length,
      beforeUnidentified,
      afterUnidentified,
    },
    byType,
    /** Said on every comparison, because it is the misreading the whole phase invites. */
    caveat: 'This is a comparison of two published DESIGNS. An element appearing in a newer '
      + 'version means it was drawn, not that it was built. Verified construction progress comes '
      + 'from schedule activities and approved element mappings, and is reported separately.',
  };
}

/** The change set for a single element, for the detail panel. */
export const changeFor = (comparison, ifcGuid) =>
  comparison?.elements?.find(entry => entry.ifcGuid === ifcGuid) ?? null;
