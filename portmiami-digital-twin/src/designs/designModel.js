/**
 * A design alternative: what CHANGES against the baseline, never a copy of it.
 *
 * THE BASELINE IS IMMUTABLE. The county road centrelines and building footprints are facts about
 * the port; a design is a set of proposed changes that reference them by their own stable ids.
 * Nothing here writes to those datasets, and a REMOVED element marks a baseline segment as
 * proposed for removal without taking it out of the file. That is also why an alternative holds
 * only its own elements: duplicating 2,362 road segments per design would cost megabytes and
 * invite the two copies to drift.
 *
 * EVERY DESIGN IN PHASE 1 IS SYNTHETIC. The three below are conceptual sketches made to exercise
 * the viewer. They are not Kimley-Horn proposals, not approved, and not engineering designs, and
 * `SYNTHETIC_LABEL` is attached to each so no screen can show one without saying so.
 *
 * GEOMETRY IS SEPARATE FROM PROVENANCE AND QUANTITIES. An element carries its geometry and its
 * properties; what it measures is derived (see `designQuantities`), and where it came from is
 * recorded on the package. A future import adapter fills the same shape from a real file.
 */

export const CHANGE_TYPE = Object.freeze({
  NEW: 'NEW',
  MODIFIED: 'MODIFIED',
  REMOVED: 'REMOVED',
  UNCHANGED: 'UNCHANGED',
});

export const ELEMENT_TYPE = Object.freeze({
  ROAD: 'ROAD',
  BUILDING: 'BUILDING',
  PARKING_GARAGE: 'PARKING_GARAGE',
  SURFACE_PARKING: 'SURFACE_PARKING',
  TERMINAL: 'TERMINAL',
  ACCESS_INFRASTRUCTURE: 'ACCESS_INFRASTRUCTURE',
});

export const VERIFICATION = Object.freeze({
  CONCEPTUAL: 'CONCEPTUAL',
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
});

export const DESIGN_SOURCE = Object.freeze({
  SYNTHETIC_DEMO: 'SYNTHETIC_DEMO',
  IMPORTED: 'IMPORTED',
  USER_DRAWN: 'USER_DRAWN',
});

/** Shown wherever a synthetic design is named. Never optional, never dismissible. */
export const SYNTHETIC_LABEL = 'Synthetic Conceptual Design — Not an Approved Engineering Proposal';

/** The baseline is a design package with no elements, so every screen can treat it the same way. */
export const BASELINE_ID = 'baseline';

const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * The study area a design must sit inside.
 *
 * A coordinate outside it is almost always an unreferenced CAD coordinate that has been read as
 * degrees — the failure the import validator exists to catch.
 */
export const STUDY_AREA = Object.freeze({
  west: -80.25, east: -80.10, south: 25.70, north: 25.85,
});

export const inStudyArea = ([lon, lat] = []) =>
  finite(lon) && finite(lat)
  && lon >= STUDY_AREA.west && lon <= STUDY_AREA.east
  && lat >= STUDY_AREA.south && lat <= STUDY_AREA.north;

/** A design package with its defaults. `elements` is always an array, never undefined. */
export function createDesign({
  id, name, description = '', source = DESIGN_SOURCE.SYNTHETIC_DEMO,
  verificationStatus = VERIFICATION.CONCEPTUAL, revision = '01', organisation = null,
  sourceFile = null, importedAt = null, crs = 'EPSG:4326', units = 'metre', elements = [],
  domain = null,
} = {}) {
  return {
    id, name, description,
    source, verificationStatus, revision,
    // Which kind of infrastructure this design is about. Declared, never inferred from the name;
    // see `designDomain.js`. Null means undeclared, which classification fills in from contents.
    domain,
    organisation, sourceFile, importedAt, crs, units,
    elements: [...elements],
  };
}

/**
 * An EMPTY road alternative.
 *
 * Empty on purpose, and it stays empty: a blank road design is a blank sheet, not a prompt to
 * fill in with sketches. The studio used to open on three parking records, which is how garage
 * massing and a 1,500-space plate ended up in a road workflow.
 */
export const roadDesign = (id, name) => createDesign({
  id,
  name,
  description: 'Proposed road changes. Empty until you draw one.',
  source: DESIGN_SOURCE.USER_DRAWN,
  verificationStatus: VERIFICATION.CONCEPTUAL,
  domain: 'ROAD_INFRASTRUCTURE',
  elements: [],
});

/** The three road alternatives the studio offers beside the baseline. */
export const roadDesigns = () => [
  roadDesign('road-design-a', 'Design A'),
  roadDesign('road-design-b', 'Design B'),
  roadDesign('road-design-c', 'Design C'),
];

export const isBaseline = design => design?.id === BASELINE_ID;

/** The empty package every other design is a change against. */
export const baselineDesign = () => createDesign({
  id: BASELINE_ID,
  name: 'Existing Baseline',
  description: 'The port as the county GIS records it today. No proposed changes.',
  source: DESIGN_SOURCE.IMPORTED,
  verificationStatus: VERIFICATION.APPROVED,
  organisation: 'Miami-Dade County GIS',
  elements: [],
});

// ---- validation --------------------------------------------------------------------------------

const coordinatesOf = geometry => {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates ?? [];
  if (geometry.type === 'Polygon') return (geometry.coordinates?.[0]) ?? [];
  if (geometry.type === 'Point') return [geometry.coordinates ?? []];
  return [];
};

/**
 * Every reason a design package cannot be trusted, as sentences.
 *
 * Reasons rather than a boolean, and all of them, because an import that fails on its third
 * problem after two silent ones is an import nobody can fix.
 */
export function validateDesign(design) {
  const errors = [], warnings = [];
  if (!design) return { ok: false, errors: ['No design package was supplied.'], warnings };
  if (!design.id) errors.push('The design has no id.');
  if (!design.name) errors.push('The design has no name.');
  if (design.crs && design.crs !== 'EPSG:4326') {
    errors.push(`Coordinates are declared as ${design.crs}. This viewer reads EPSG:4326 only; `
      + 'projected or unreferenced CAD coordinates must be transformed before import.');
  }

  const seen = new Set();
  for (const element of design.elements ?? []) {
    if (!element.id) { errors.push('An element has no id.'); continue; }
    if (seen.has(element.id)) errors.push(`Duplicate element id "${element.id}".`);
    seen.add(element.id);
    if (!ELEMENT_TYPE[element.type]) errors.push(`Element "${element.id}" has an unknown type.`);
    if (!CHANGE_TYPE[element.changeType]) {
      errors.push(`Element "${element.id}" has an unknown change type.`);
    }
    // A REMOVED or MODIFIED element must say WHAT it changes, or it changes nothing.
    if ((element.changeType === CHANGE_TYPE.REMOVED || element.changeType === CHANGE_TYPE.MODIFIED)
      && !element.baselineRef) {
      errors.push(`Element "${element.id}" is ${element.changeType} but names no baseline feature.`);
    }
    const points = coordinatesOf(element.geometry);
    if (element.changeType !== CHANGE_TYPE.REMOVED && element.geometry && points.length === 0) {
      errors.push(`Element "${element.id}" has a geometry with no usable coordinates.`);
    }
    for (const point of points) {
      if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) {
        errors.push(`Element "${element.id}" has a non-numeric coordinate.`);
        break;
      }
      // Longitude first. At this latitude a swapped pair cannot be told apart by magnitude —
      // both 25.77 and -80.17 are inside ±90 — so the test is the one that actually decides it:
      // the pair is outside the study area, and swapping it puts it inside.
      if (!inStudyArea(point) && inStudyArea([point[1], point[0]])) {
        errors.push(`Element "${element.id}" looks like latitude, longitude — this reader expects `
          + 'longitude first.');
        break;
      }
      if (!inStudyArea(point)) {
        errors.push(`Element "${element.id}" has a coordinate outside the PortMiami study area.`);
        break;
      }
    }
    if (element.type === ELEMENT_TYPE.ROAD && element.changeType !== CHANGE_TYPE.REMOVED
      && !finite(element.properties?.widthM)) {
      warnings.push(`Road "${element.id}" states no width, so no surface can be drawn for it.`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---- reading a package ---------------------------------------------------------------------------

export const elementsOfType = (design, type) =>
  (design?.elements ?? []).filter(element => element.type === type);

export const elementsOfChange = (design, changeType) =>
  (design?.elements ?? []).filter(element => element.changeType === changeType);

/** The baseline features a design touches, by the ids it references. */
export function baselineRefs(design) {
  const roads = new Set(), buildings = new Set(), assets = new Set();
  for (const element of design?.elements ?? []) {
    const ref = element.baselineRef;
    if (!ref) continue;
    if (ref.kind === 'ROAD' && finite(ref.objectId)) roads.add(ref.objectId);
    if (ref.kind === 'BUILDING' && finite(ref.objectId)) buildings.add(ref.objectId);
    if (ref.kind === 'ASSET' && ref.assetId) assets.add(ref.assetId);
  }
  return { roads, buildings, assets };
}
