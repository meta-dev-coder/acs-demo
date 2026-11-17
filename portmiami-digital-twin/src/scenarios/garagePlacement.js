/**
 * A PROPOSED garage, as parameters rather than as a polygon.
 *
 * WHY THIS EXISTS. Scenario B used to derive its volume from the capacity assumptions:
 * `padFootprint` took spaces x gross-area-per-space / floors, took the square root, and stepped
 * that many metres off the picked longitude and latitude. Three things were wrong with it. The
 * shape was always an axis-aligned square, so it never lined up with a quay, a road or anything
 * else on the ground. The size was a function of the capacity target, so resizing the building
 * was not a thing a user could do — only changing the target was. And the corners were made by
 * adding degrees to degrees with a fixed metres-per-degree constant, which is not a rectangle on
 * the ellipsoid and is not the frame Cesium draws in.
 *
 * So a placement is stored as what it is: a centre, a heading, a length, a width, floors and a
 * floor height. Every consumer — the walls, the roof, the floor lines, the drag handles, the
 * saved record, the area, the conflict check — derives its geometry from this one record through
 * the one function below, so none of them can disagree about where the building is.
 *
 * COORDINATE FRAME. Corners are laid out in metres in a local East-North-Up frame at the centre,
 * then converted to geodetic coordinates through the WGS-84 ellipsoid: ENU -> ECEF -> geodetic,
 * the same chain `Cesium.Transforms.eastNorthUpToFixedFrame` uses. It is implemented here in
 * plain JavaScript so the geometry is unit-testable without a viewer; `verify-placement.mjs`
 * asserts in the browser that it agrees with Cesium's own transform to well under a millimetre.
 *
 * HEADING is clockwise degrees from geographic north, which is how a bearing is normally read.
 * It is the direction the building's LENGTH axis points. The width axis is 90 degrees clockwise
 * of it. At heading 0 a building is length-wise north-south and width-wise east-west.
 *
 * NOTHING HERE IS VERIFIED. A placement is a proposal someone dragged into position. It is not a
 * site, a permission, a survey or a design, and every label the planner puts on one says so.
 */

/** WGS-84, the datum Cesium's default ellipsoid uses. */
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

const DEG = Math.PI / 180;

export const GEOMETRY_SOURCE = 'USER_DEFINED_CANDIDATE';

/**
 * What the placement proposes.
 *
 * A SURFACE_LOT is the same rectangle, positioned the same way, but it is an AREA rather than a
 * volume: no floors, no height, and its capacity comes from the ground it covers rather than from
 * a floor area multiplied by storeys. Carrying the distinction on the record keeps the editor,
 * the capacity arithmetic and the drawing from each having to re-derive it from the scenario type.
 */
export const PLACEMENT_KIND = Object.freeze({
  BUILDING: 'BUILDING',
  SURFACE_LOT: 'SURFACE_LOT',
});

export const isSurfaceLot = placement => placement?.kind === PLACEMENT_KIND.SURFACE_LOT;

export const BASE_HEIGHT_SOURCE = Object.freeze({
  SAMPLED_GROUND: 'SAMPLED_GROUND',
  USER_ASSUMED: 'USER_ASSUMED',
  UNKNOWN: 'UNKNOWN',
});

export const BASE_HEIGHT_SOURCE_LABEL = Object.freeze({
  SAMPLED_GROUND: 'Sampled from the rendered 3D tiles around the site — a visualisation estimate, '
    + 'not a survey',
  USER_ASSUMED: 'Entered by you',
  UNKNOWN: 'Not established — the envelope sits at an assumed elevation',
});

/**
 * What a placement is allowed to be.
 *
 * These are editor limits, not engineering ones. They exist so a drag cannot produce a building
 * of zero or a thousand metres, and so a typed value that is out of range is REPORTED rather than
 * silently clamped — a number that quietly changes under the user is worse than one that is
 * refused with a reason.
 */
export const PLACEMENT_LIMITS = Object.freeze({
  lengthM: Object.freeze({ min: 10, max: 400 }),
  widthM: Object.freeze({ min: 10, max: 400 }),
  areaM2: Object.freeze({ min: 100, max: 160_000 }),
  floors: Object.freeze({ min: 1, max: 20 }),
  floorHeightM: Object.freeze({ min: 2.2, max: 6 }),
  /** The study area. A placement outside it is a mis-click, not a site. */
  longitude: Object.freeze({ min: -80.25, max: -80.1 }),
  latitude: Object.freeze({ min: 25.7, max: 25.85 }),
});

/** The angles the rotation control snaps to when snapping is on. */
export const SNAP_ANGLES_DEG = Object.freeze([0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165,
  180, 195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345]);

export const SNAP_TOLERANCE_DEG = 4;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Heading wrapped into [0, 360). */
export const normaliseHeading = degrees => {
  if (!finite(degrees)) return 0;
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
};

/** The nearest snap angle, or the heading unchanged when none is within tolerance. */
export function snapHeading(degrees, { enabled = true, toleranceDeg = SNAP_TOLERANCE_DEG } = {}) {
  const heading = normaliseHeading(degrees);
  if (!enabled) return heading;
  for (const angle of SNAP_ANGLES_DEG) {
    // The shortest way round the circle, so 358 snaps to 0 rather than missing it by 358.
    const delta = Math.abs(((heading - angle + 540) % 360) - 180);
    if (delta <= toleranceDeg) return angle;
  }
  return heading;
}

// ---- the ENU <-> geodetic pair every consumer shares -----------------------------------------

/** Geodetic (degrees, metres) -> earth-centred, earth-fixed metres. */
export function geodeticToEcef(lonDeg, latDeg, heightM = 0) {
  const lon = lonDeg * DEG, lat = latDeg * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + heightM) * cosLat * Math.cos(lon),
    (n + heightM) * cosLat * Math.sin(lon),
    (n * (1 - WGS84_E2) + heightM) * sinLat,
  ];
}

/**
 * ECEF -> geodetic, by Bowring's closed-form method.
 *
 * Closed form rather than iteration: at these heights it is accurate to well under a millimetre,
 * and it cannot fail to converge while a handle is being dragged.
 */
export function ecefToGeodetic([x, y, z]) {
  const p = Math.hypot(x, y);
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);
  const lat = Math.atan2(
    z + WGS84_EP2 * WGS84_B * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta);
  const lon = Math.atan2(y, x);
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const height = p / Math.cos(lat) - n;
  return [lon / DEG, lat / DEG, height];
}

/**
 * A point `east` / `north` metres from an origin, as [lon, lat].
 *
 * The up component is deliberately absent: the editor moves a building across the ground, and
 * its elevation comes from the base-height sampling, not from the horizontal transform.
 *
 * Like Cesium's, this is a TANGENT-PLANE frame: the offset is a straight line in ECEF, so a point
 * 1 km out sits about 80 micrometres below the ellipsoid and re-projecting it to the surface
 * shifts it by about the same. That is the frame Cesium draws in, which is the point — agreeing
 * with the renderer matters more here than agreeing with a geodesic.
 */
export function enuToLonLat([lonDeg, latDeg], eastM, northM) {
  const lon = lonDeg * DEG, lat = latDeg * DEG;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const [x0, y0, z0] = geodeticToEcef(lonDeg, latDeg, 0);
  // The ENU basis vectors at the origin, in ECEF.
  const x = x0 + (-sinLon * eastM) + (-sinLat * cosLon * northM);
  const y = y0 + (cosLon * eastM) + (-sinLat * sinLon * northM);
  const z = z0 + (cosLat * northM);
  const [outLon, outLat] = ecefToGeodetic([x, y, z]);
  return [outLon, outLat];
}

/** The inverse: how far east and north a point lies from an origin, in metres. */
export function lonLatToEnu([lonDeg, latDeg], [pointLon, pointLat]) {
  const lon = lonDeg * DEG, lat = latDeg * DEG;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const [x0, y0, z0] = geodeticToEcef(lonDeg, latDeg, 0);
  const [x, y, z] = geodeticToEcef(pointLon, pointLat, 0);
  const dx = x - x0, dy = y - y0, dz = z - z0;
  return [
    -sinLon * dx + cosLon * dy,
    -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
  ];
}

/**
 * The building frame -> the local ENU frame.
 *
 * `along` runs down the length axis, towards the heading. `across` runs down the width axis,
 * 90 degrees clockwise of it. Heading is clockwise from north, so a clockwise rotation of the
 * (north, east) pair is what converts between them.
 */
export function buildingToEnu(headingDeg, alongM, acrossM) {
  const heading = normaliseHeading(headingDeg) * DEG;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  return [alongM * sin + acrossM * cos, alongM * cos - acrossM * sin];
}

/** The inverse: an east/north offset read back as along/across the building. */
export function enuToBuilding(headingDeg, eastM, northM) {
  const heading = normaliseHeading(headingDeg) * DEG;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  return [eastM * sin + northM * cos, eastM * cos - northM * sin];
}

// ---- the placement record --------------------------------------------------------------------

/**
 * A placement from a picked point.
 *
 * The starting size is a SHAPE, not a capacity: a 60 x 40 m rectangle, which is an ordinary
 * parking-structure plate. It is deliberately NOT sized to hit the capacity target, because
 * making the building fit the target is the question the user is here to answer, and answering
 * it for them by construction is how a conceptual tool starts reporting its own assumptions back
 * as findings. The capacity the geometry supports is reported separately and may well fall short.
 */
export function createPlacement({
  point, kind = PLACEMENT_KIND.BUILDING, lengthM = 60, widthM = 40, headingDeg = 0, floors = 6,
  floorHeightM = 3.2, baseHeightM = null, baseHeightSource = BASE_HEIGHT_SOURCE.UNKNOWN,
  now = () => new Date().toISOString(),
} = {}) {
  const [lon, lat] = point ?? [];
  const surface = kind === PLACEMENT_KIND.SURFACE_LOT;
  return {
    kind,
    centerLongitude: lon ?? null,
    centerLatitude: lat ?? null,
    headingDegrees: normaliseHeading(headingDeg),
    // A surface lot starts larger, because an area holding the same cars as a garage needs the
    // garage's floor area all on the ground.
    lengthM: surface ? Math.max(lengthM, 160) : lengthM,
    widthM: surface ? Math.max(widthM, 90) : widthM,
    // No structure means no floors and no height, by construction rather than by the UI hiding
    // a control that still holds a number.
    floors: surface ? 0 : floors,
    floorHeightM: surface ? 0 : floorHeightM,
    baseHeightM,
    baseHeightSource,
    geometrySource: GEOMETRY_SOURCE,
    updatedAt: now(),
  };
}

/** A placement with some fields replaced, re-stamped. Never mutates the original. */
export const withPlacement = (placement, patch, now = () => new Date().toISOString()) => ({
  ...placement, ...patch, updatedAt: now(),
});

/** The four corners, closed, as [lon, lat] — the one geometry every consumer reads. */
export function placementRing(placement) {
  if (!placement || !finite(placement.centerLongitude) || !finite(placement.centerLatitude)) return null;
  const halfLength = Math.max(placement.lengthM, 0) / 2;
  const halfWidth = Math.max(placement.widthM, 0) / 2;
  const centre = [placement.centerLongitude, placement.centerLatitude];
  const corners = [
    [+halfLength, -halfWidth], [+halfLength, +halfWidth],
    [-halfLength, +halfWidth], [-halfLength, -halfWidth],
  ].map(([along, across]) => {
    const [east, north] = buildingToEnu(placement.headingDegrees, along, across);
    return enuToLonLat(centre, east, north);
  });
  return [...corners, corners[0]];
}

/** The ring as the one-ring-set shape the Cesium layers already take. */
export const placementRings = placement => {
  const ring = placementRing(placement);
  return ring ? [ring] : null;
};

/**
 * The points the editor puts a handle on, in the building's own frame.
 *
 * `kind` says what dragging it does. The rotation handle stands off the length axis so it is
 * never under the building, and its distance scales with the building so it is reachable on a
 * 20 m pad and not a kilometre away from a 300 m one.
 */
export function placementHandles(placement) {
  if (!placement) return [];
  const halfLength = placement.lengthM / 2, halfWidth = placement.widthM / 2;
  const standoff = Math.max(12, Math.min(60, placement.lengthM * 0.35));
  const spec = [
    { id: 'move', kind: 'MOVE', along: 0, across: 0 },
    { id: 'length-plus', kind: 'LENGTH', along: +halfLength, across: 0, sign: +1 },
    { id: 'length-minus', kind: 'LENGTH', along: -halfLength, across: 0, sign: -1 },
    { id: 'width-plus', kind: 'WIDTH', along: 0, across: +halfWidth, sign: +1 },
    { id: 'width-minus', kind: 'WIDTH', along: 0, across: -halfWidth, sign: -1 },
    { id: 'corner-ne', kind: 'CORNER', along: +halfLength, across: +halfWidth },
    { id: 'corner-se', kind: 'CORNER', along: -halfLength, across: +halfWidth },
    { id: 'corner-sw', kind: 'CORNER', along: -halfLength, across: -halfWidth },
    { id: 'corner-nw', kind: 'CORNER', along: +halfLength, across: -halfWidth },
    { id: 'rotate', kind: 'ROTATE', along: halfLength + standoff, across: 0 },
  ];
  const centre = [placement.centerLongitude, placement.centerLatitude];
  return spec.map(handle => {
    const [east, north] = buildingToEnu(placement.headingDegrees, handle.along, handle.across);
    return { ...handle, point: enuToLonLat(centre, east, north) };
  });
}

// ---- the three edits -------------------------------------------------------------------------

/** Move the building to a new centre. Dimensions and heading are untouched by construction. */
export const movePlacement = (placement, [lon, lat], now) =>
  withPlacement(placement, { centerLongitude: lon, centerLatitude: lat }, now);

/** The steps the nudge buttons offer, in metres. */
export const NUDGE_STEPS_M = Object.freeze([1, 5, 10, 25]);

/**
 * Shift the building by a fixed number of metres, in ITS OWN frame.
 *
 * Forward is down the length axis, towards the heading; right is 90 degrees clockwise of it. In
 * the building's frame rather than in compass directions because that is what "move it forward a
 * bit" means once the thing has been rotated: a rotated garage nudged "north" slides diagonally
 * across its own footprint, which is not what anyone pressing an arrow is asking for.
 *
 * Exact metres, so a nudge is repeatable and reversible — pressing forward then back returns the
 * building to where it started, which dragging cannot promise.
 */
export function nudgePlacement(placement, forwardM, rightM, now) {
  if (!placement || !finite(placement.centerLongitude) || !finite(placement.centerLatitude)) {
    return placement;
  }
  const [east, north] = buildingToEnu(placement.headingDegrees, forwardM, rightM);
  const [lon, lat] = enuToLonLat([placement.centerLongitude, placement.centerLatitude], east, north);
  return withPlacement(placement, { centerLongitude: lon, centerLatitude: lat }, now);
}

/**
 * Rotate to face a point, measured in the local horizontal plane rather than in screen pixels.
 *
 * Screen angles are wrong under an oblique camera: the same drag reads as a different rotation
 * depending on how far the view is tilted. The ENU offset from the centre to the cursor has no
 * such distortion, so the angle is computed there and the camera never enters into it.
 */
export function rotatePlacementToward(placement, [lon, lat], { snap = true, now } = {}) {
  const [east, north] = lonLatToEnu(
    [placement.centerLongitude, placement.centerLatitude], [lon, lat]);
  if (Math.hypot(east, north) < 0.5) return placement;   // too close to the centre to mean an angle
  const heading = snapHeading(Math.atan2(east, north) / DEG, { enabled: snap });
  return withPlacement(placement, { headingDegrees: heading }, now);
}

/**
 * Resize by dragging a handle, about a FIXED CENTRE.
 *
 * The cursor's offset is read in the building's own frame, so a length handle changes the length
 * however the building is rotated and however the camera is turned. Symmetric about the centre:
 * the handle's own half-dimension is what the cursor sets, and the opposite side moves with it.
 */
export function resizePlacementTo(placement, handle, [lon, lat], { now } = {}) {
  const [east, north] = lonLatToEnu(
    [placement.centerLongitude, placement.centerLatitude], [lon, lat]);
  const [along, across] = enuToBuilding(placement.headingDegrees, east, north);
  const patch = {};
  if (handle.kind === 'LENGTH' || handle.kind === 'CORNER') {
    patch.lengthM = clampToLimit(Math.abs(along) * 2, PLACEMENT_LIMITS.lengthM);
  }
  if (handle.kind === 'WIDTH' || handle.kind === 'CORNER') {
    patch.widthM = clampToLimit(Math.abs(across) * 2, PLACEMENT_LIMITS.widthM);
  }
  return Object.keys(patch).length ? withPlacement(placement, patch, now) : placement;
}

/**
 * A drag is clamped; a TYPED value is not.
 *
 * Dragging past the limit is the pointer running on, and stopping the building at the limit is
 * the only sensible reading of it. A number someone typed means something, so it goes through
 * `validatePlacement` and comes back as an error they can see.
 */
const clampToLimit = (value, { min, max }) => Math.min(max, Math.max(min, value));

// ---- what a placement implies ----------------------------------------------------------------

export const footprintAreaM2 = placement =>
  (placement && finite(placement.lengthM) && finite(placement.widthM)
    ? placement.lengthM * placement.widthM : null);

/**
 * The parking area a placement offers.
 *
 * A building stacks its footprint: area x floors. A surface lot does not stack, so its parking
 * area IS its footprint — multiplying by a floor count of zero would report no capacity at all,
 * and multiplying by one would quietly pretend a lot is a single-storey building.
 */
export const grossFloorAreaM2 = placement => {
  const area = footprintAreaM2(placement);
  if (area === null) return null;
  if (isSurfaceLot(placement)) return area;
  return finite(placement.floors) ? area * placement.floors : null;
};

export const totalHeightM = placement => {
  if (!placement) return null;
  if (isSurfaceLot(placement)) return 0;
  return finite(placement.floors) && finite(placement.floorHeightM)
    ? placement.floors * placement.floorHeightM : null;
};

/**
 * How many spaces this geometry supports, and whether that meets the target.
 *
 * The target is the user's own `additionalSpaces` and is NEVER changed by resizing the building:
 * the point of the editor is to show whether a shape can hold the number that was asked for, and
 * quietly rewriting the number would answer the question by erasing it. `usesTargetInSimulation`
 * is the honest statement that the simulation still runs on the requested figure, so a deficit is
 * a warning about the model's own input rather than something the model has accounted for.
 */
export function capacityFeasibility(placement, { targetSpaces, grossAreaPerSpaceM2 }) {
  const gross = grossFloorAreaM2(placement);
  if (gross === null || !finite(grossAreaPerSpaceM2) || grossAreaPerSpaceM2 <= 0) {
    return {
      grossFloorAreaM2: gross, grossAreaPerSpaceM2: finite(grossAreaPerSpaceM2) ? grossAreaPerSpaceM2 : null,
      targetSpaces: finite(targetSpaces) ? targetSpaces : null,
      estimatedSpaces: null, differenceSpaces: null, meetsTarget: null,
      reason: 'Not evaluated — the placement or the area-per-space assumption is incomplete.',
      usesTargetInSimulation: true,
    };
  }
  const estimated = Math.floor(gross / grossAreaPerSpaceM2);
  const target = finite(targetSpaces) ? targetSpaces : null;
  return {
    grossFloorAreaM2: gross,
    grossAreaPerSpaceM2,
    targetSpaces: target,
    estimatedSpaces: estimated,
    differenceSpaces: target === null ? null : estimated - target,
    meetsTarget: target === null ? null : estimated >= target,
    reason: null,
    usesTargetInSimulation: true,
  };
}

// ---- validation ------------------------------------------------------------------------------

const range = (label, value, { min, max }, unit) => {
  if (!finite(value)) return `${label} must be a number.`;
  if (value <= 0 && min > 0) return `${label} must be greater than zero.`;
  if (value < min) return `${label} is below the ${min}${unit} minimum this editor allows.`;
  if (value > max) return `${label} is above the ${max}${unit} maximum this editor allows.`;
  return null;
};

/**
 * Every reason a placement cannot be saved, as sentences.
 *
 * Reasons rather than a boolean, and all of them rather than the first, so the panel can show the
 * user everything that needs fixing instead of one thing at a time.
 */
export function validatePlacement(placement) {
  const errors = [];
  if (!placement) return { ok: false, errors: ['No placement has been made yet.'] };
  const { centerLongitude: lon, centerLatitude: lat } = placement;
  if (!finite(lon) || !finite(lat)) {
    errors.push('The placement has no centre. Pick a location on the map.');
  } else {
    if (lon < PLACEMENT_LIMITS.longitude.min || lon > PLACEMENT_LIMITS.longitude.max
      || lat < PLACEMENT_LIMITS.latitude.min || lat > PLACEMENT_LIMITS.latitude.max) {
      errors.push('The centre is outside the PortMiami study area.');
    }
  }
  for (const [label, value, limit, unit] of [
    ['Length', placement.lengthM, PLACEMENT_LIMITS.lengthM, ' m'],
    ['Width', placement.widthM, PLACEMENT_LIMITS.widthM, ' m'],
    // A surface lot has no storeys, so there is nothing to range-check and a zero is correct.
    ...(isSurfaceLot(placement) ? [] : [
      ['Floors', placement.floors, PLACEMENT_LIMITS.floors, ''],
      ['Floor-to-floor height', placement.floorHeightM, PLACEMENT_LIMITS.floorHeightM, ' m'],
    ]),
  ]) {
    const problem = range(label, value, limit, unit);
    if (problem) errors.push(problem);
  }
  if (!finite(placement.headingDegrees)) errors.push('Rotation must be a number of degrees.');
  const area = footprintAreaM2(placement);
  if (area !== null) {
    const problem = range('Footprint area', area, PLACEMENT_LIMITS.areaM2, ' m²');
    if (problem) errors.push(problem);
  }
  return { ok: errors.length === 0, errors };
}
