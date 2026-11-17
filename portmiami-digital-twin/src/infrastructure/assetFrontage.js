/**
 * Which footprint does an address FRONT ONTO?
 *
 * The geocoder (src/infrastructure/assetGeocode.js) puts an asset on the street centreline, which
 * is where its house number falls in a block's address range. That is the right answer to "which
 * block is this?" and the wrong-looking answer to "where is the garage?": the pin lands in the
 * carriageway, often a hundred metres from the structure people are looking for.
 *
 * This module uses the one extra piece of evidence the county road file already publishes and the
 * geocoder already reads: the SIDE. L_ADD_FROM/L_ADD_TO and R_ADD_FROM/R_ADD_TO are the ranges for
 * the left and right of the segment as it is digitised, so a matched house number states which
 * side of that street the property is on. Stepping perpendicular from the centreline point onto
 * that side and recording the first footprint entered is a geometric reading of published
 * evidence — not a nearest-neighbour guess, and not an invented coordinate.
 *
 * WHAT THIS IS NOT
 *
 * It is not a confirmation. A fronting footprint is still a candidate: the ray says "the first
 * building on the addressed side of this block", which is usually the facility and is sometimes
 * its neighbour. So the result is labelled FRONTAGE, carries the OBJECTID and the distance it
 * walked, and never writes a link. Confirmation stays what it was — a reviewer picking a polygon.
 *
 * The ray is also deliberately unforgiving: one side only, a bounded walk, and a minimum ground
 * area. If it finds nothing it returns null and the caller keeps the street point, because a pin
 * on the kerb that says "approximate" beats a pin on a shed that says nothing.
 */
import { distanceMetres } from './assetGeocode.js';

const EARTH_RADIUS_M = 6378137;
const RADIANS = Math.PI / 180;
const METRES_PER_DEGREE_LAT = EARTH_RADIUS_M * RADIANS;

/**
 * How far off the centreline the ray may walk before it gives up.
 *
 * 90 m is a deep setback for a frontage and a short walk for a port block, which is the trade this
 * number is making: past it, the ray is no longer reading "the building this address is on" but
 * "some building in that direction". Terminal B is the case that set it — its ray reached a 683 m²
 * structure 116 m back, which is not a 190,000 sq ft terminal, and the kerb point is the better
 * answer there.
 *
 * It bounds the WALK, not the marker. Once a footprint is entered, the marker goes to the middle
 * of it however far that is: the centre of a 120 m-deep garage is 60 m from its own frontage, and
 * that is the thing being pointed at, not a drift away from the evidence.
 */
export const FRONTAGE_MAX_M = 90;
/**
 * How far the MARKER may end up from the address it belongs to.
 *
 * The centre of a deep garage is legitimately tens of metres behind its own frontage, so this is
 * looser than the walk. Past about a block, though, the thing entered is not one addressed
 * building: Terminal C's ray enters the 33,891 m² aggregate and its middle is 304 m away, which
 * would put the pin on a different part of the port. Those fall back to the kerb point, where at
 * least the label says the position is approximate.
 */
export const FRONTAGE_CENTRE_MAX_M = 120;
/** Step along the ray. Small enough not to jump a building, big enough to stay cheap. */
export const FRONTAGE_STEP_M = 2;
/** Ignore slivers: a guard booth, a canopy or a kiosk is not what "where is Garage D" means. */
export const FRONTAGE_MIN_AREA_M2 = 1000;

/** Ray casting in degrees — fine at a port's scale. */
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the point inside the footprint — any part, minus its holes? */
export function footprintContains(point, building) {
  let inside = false;
  for (const ring of building.rings ?? []) {
    if (pointInRing(point, ring)) inside = !inside;   // outer rings add, holes punch out
  }
  return inside;
}

/** Ring area in square degrees — only ever compared against other rings of the same footprint. */
const ringArea = ring => {
  let twice = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(twice) / 2;
};

/** Shortest distance from a point to a segment, in the local metre frame. */
function distanceToEdge([px, py], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

/** Shortest distance from a point to a ring's outline. */
const distanceToRing = (point, ring) => {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i += 1) best = Math.min(best, distanceToEdge(point, ring[i], ring[i + 1]));
  return best;
};

/**
 * The most central point INSIDE a ring: the one furthest from its outline.
 *
 * Not the centroid. A garage is rarely a rectangle — 798221 is a 69-vertex L — and an L's
 * area-weighted centroid sits in the notch, outside the building, which is how a marker ends up
 * hovering over the car park next door. "Furthest from any wall" is inside by construction and
 * reads as the middle of the structure, which is what someone clicking a garage is looking for.
 *
 * A coarse grid over the ring's own extent, then a finer one around the winner. Cheap, and run
 * once per selected asset rather than per frame.
 */
function poleOfInaccessibility(ring, building) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [x, y] of ring) {
    west = Math.min(west, x); east = Math.max(east, x);
    south = Math.min(south, y); north = Math.max(north, y);
  }
  let best = null, bestDistance = -Infinity;
  let [x0, y0, x1, y1, steps] = [west, south, east, north, 24];
  for (let pass = 0; pass < 2; pass += 1) {
    const stepX = (x1 - x0) / steps, stepY = (y1 - y0) / steps;
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps; j += 1) {
        const candidate = [x0 + stepX * i, y0 + stepY * j];
        // Inside the part AND inside the footprint, so a courtyard punched out of it is excluded.
        if (!pointInRing(candidate, ring) || !footprintContains(candidate, building)) continue;
        const distance = distanceToRing(candidate, ring);
        if (distance > bestDistance) { bestDistance = distance; best = candidate; }
      }
    }
    if (!best) return null;
    // Second pass: the same search over one cell either side of the winner.
    [x0, y0, x1, y1, steps] = [best[0] - stepX, best[1] - stepY, best[0] + stepX, best[1] + stepY, 8];
  }
  return best;
}

/**
 * A point to put a marker on, given the footprint and the point the ray entered it at.
 *
 * Two traps this avoids. A MultiPolygon in this extract can be an aggregate — OBJECTID 297214 is
 * fourteen parts spanning half a kilometre — so the whole feature's centroid can sit hundreds of
 * metres from the part the address actually fronts; the marker belongs on the PART that was
 * entered. And a part is usually not convex, so the marker is placed at the point furthest inside
 * it — holes excluded — rather than at a centroid that may fall outside the walls altogether.
 */
export function interiorPoint(building, probe) {
  const containing = (building.rings ?? []).filter(ring => pointInRing(probe, ring));
  if (containing.length === 0) return probe;
  // The LARGEST containing ring is the part's outline. Parts of a MultiPolygon do not nest, so the
  // only other ring that can contain the probe is a hole — and a hole's own outline is no place to
  // centre a marker. Holes are then honoured by the inside test, not by the choice of ring.
  const part = containing.reduce((a, b) => (ringArea(a) >= ringArea(b) ? a : b));
  return poleOfInaccessibility(part, building) ?? probe;
}

/** The unit direction of travel at the closest point of `coordinates` to `point`, in metres. */
function tangentAt(coordinates, point, scaleLon) {
  let best = Infinity, dir = null;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const mid = [(coordinates[i][0] + coordinates[i + 1][0]) / 2, (coordinates[i][1] + coordinates[i + 1][1]) / 2];
    const d = distanceMetres(mid, point);
    if (d >= best) continue;
    const dx = (coordinates[i + 1][0] - coordinates[i][0]) * scaleLon;
    const dy = (coordinates[i + 1][1] - coordinates[i][1]) * METRES_PER_DEGREE_LAT;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    best = d;
    dir = [dx / length, dy / length];
  }
  return dir;
}

/**
 * The footprint an address fronts onto, or null.
 *
 * @param {ReturnType<import('./assetGeocode.js').geocodeAddress>} geocode  a MATCHED geocode
 * @param {import('../roads/roadModel.js').RoadSegment[]} segments
 * @param {import('../buildings/buildingModel.js').Building[]} buildings
 * @returns {{objectId: number, point: [number, number], offsetM: number, side: 'L'|'R',
 *            areaM2: number|null, reason: string}|null}
 */
export function frontageFootprint(geocode, segments, buildings, {
  maxM = FRONTAGE_MAX_M, stepM = FRONTAGE_STEP_M, minAreaM2 = FRONTAGE_MIN_AREA_M2,
  centreMaxM = FRONTAGE_CENTRE_MAX_M,
} = {}) {
  if (!geocode?.matched || !geocode.point || !geocode.side) return null;
  const segment = segments.find(s => s.objectId === geocode.roadObjectId);
  if (!segment) return null;

  const [lon0, lat0] = geocode.point;
  const scaleLon = Math.cos(lat0 * RADIANS) * METRES_PER_DEGREE_LAT;
  const direction = tangentAt(segment.coordinates, geocode.point, scaleLon);
  if (!direction) return null;

  // Left of the direction of digitisation is a quarter turn anticlockwise in an east/north frame;
  // right is the same turn the other way. The file's L/R ranges are stated in exactly these terms.
  const [dx, dy] = direction;
  const [nx, ny] = geocode.side === 'L' ? [-dy, dx] : [dy, -dx];

  // Only footprints the ray could reach at all: the walk never leaves a box of `maxM` about the
  // address point, so anything whose own box misses that one cannot be entered.
  const dLon = maxM / scaleLon, dLat = maxM / METRES_PER_DEGREE_LAT;
  const reachable = buildings.filter(b => (b.groundAreaM2 ?? 0) >= minAreaM2
    && b.bounds.west <= lon0 + dLon && b.bounds.east >= lon0 - dLon
    && b.bounds.south <= lat0 + dLat && b.bounds.north >= lat0 - dLat);
  if (reachable.length === 0) return null;

  for (let walked = stepM; walked <= maxM; walked += stepM) {
    const probe = [lon0 + (nx * walked) / scaleLon, lat0 + (ny * walked) / METRES_PER_DEGREE_LAT];
    const entered = reachable.find(building => footprintContains(probe, building));
    // The FIRST footprint the ray meets is the answer or there is none. Walking on past it to the
    // next building along would no longer be describing what this address fronts onto.
    if (!entered) continue;
    const point = interiorPoint(entered, probe);
    // Entered something far too big to be one addressed building: the kerb is the honest answer.
    if (distanceMetres(geocode.point, point) > centreMaxM) return null;
    return {
      objectId: entered.objectId,
      point,
      offsetM: Math.round(walked),
      centreOffsetM: Math.round(distanceMetres(geocode.point, point)),
      side: geocode.side,
      areaM2: entered.groundAreaM2 ?? null,
      reason: `First footprint on the addressed (${geocode.side === 'L' ? 'left' : 'right'}) side of `
        + `${geocode.roadName}, ${Math.round(walked)} m off the centreline: OBJECTID ${entered.objectId}. `
        + `The marker sits at the deepest interior point of the part the ray entered, `
        + `${Math.round(distanceMetres(geocode.point, point))} m from the address. `
        + 'Read from the side the county address range states, not from proximity — a candidate, not a confirmation.',
    };
  }
  return null;
}
