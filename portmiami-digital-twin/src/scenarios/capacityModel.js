/**
 * Parking capacity: what a scenario would hold.
 *
 * Deterministic and small enough to read. Two ways to arrive at a number:
 *
 *   STATED    the planner types the additional spaces. The concept slide's +1,000 / +2,000 /
 *             +1,500 are this kind, and it is the default.
 *   GEOMETRY  the additional spaces are estimated from a real footprint area and a floor count.
 *
 * The geometry path is where capacity estimates usually go wrong, so it uses a GROSS area per
 * space — the stall plus its share of aisles, ramps, cores and structure. Dividing a footprint by
 * a stall's own 14 m² would roughly double every answer, which is the mistake this file exists to
 * avoid. The assumption is stated with the result, every time.
 *
 * Missing inputs produce `null`, never 0: "not calculated" and "none" are different answers, and
 * a 0 in a capacity table reads as the second.
 */

/**
 * A number, or null. `Number(null)` is 0 and `Number('')` is 0, so a bare `Number.isFinite`
 * turns "not published" into "zero" — which is how an unknown building height becomes a
 * confident 0 m in a results table.
 */
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const CAPACITY_BASIS = Object.freeze({
  STATED: 'STATED', GEOMETRY: 'GEOMETRY', NOT_CALCULATED: 'NOT_CALCULATED',
});

/**
 * Additional spaces from a footprint.
 *
 * @param {{footprintAreaM2: number, parkingFloors: number, grossAreaPerSpaceM2: number}} input
 */
export function spacesFromGeometry({ footprintAreaM2, parkingFloors, grossAreaPerSpaceM2 }) {
  const area = finite(footprintAreaM2);
  const floors = finite(parkingFloors);
  const perSpace = finite(grossAreaPerSpaceM2);
  if (area === null || floors === null || perSpace === null || perSpace <= 0 || floors <= 0 || area <= 0) {
    return { spaces: null, grossFloorAreaM2: null, basis: CAPACITY_BASIS.NOT_CALCULATED };
  }
  const grossFloorAreaM2 = area * floors;
  return {
    spaces: Math.floor(grossFloorAreaM2 / perSpace),
    grossFloorAreaM2,
    basis: CAPACITY_BASIS.GEOMETRY,
    note: `${Math.round(grossFloorAreaM2).toLocaleString()} m² gross over ${floors} parking floors `
      + `at ${perSpace} m² per space (gross: stall plus aisles, ramps, cores and structure).`,
  };
}

/**
 * A scenario's capacity.
 *
 * @param {object} input
 * @param {number} input.existingCapacity      assumed spaces today
 * @param {number|null} input.additionalSpaces stated additional spaces, or null to use geometry
 * @param {object|null} input.geometry         {footprintAreaM2, parkingFloors, grossAreaPerSpaceM2}
 * @param {number} input.utilisationPct        share of built spaces practically occupiable
 * @param {number} input.addedFloors
 * @param {number} input.floorToFloorM
 * @param {number|null} input.existingHeightM  verified height, or null when none is published
 */
export function capacityResult({
  existingCapacity, additionalSpaces, geometry = null, utilisationPct,
  addedFloors = 0, floorToFloorM = 0, existingHeightM = null,
}) {
  const existing = finite(existingCapacity);
  const stated = finite(additionalSpaces);
  const estimated = geometry ? spacesFromGeometry(geometry) : null;
  const added = stated ?? estimated?.spaces ?? null;
  const basis = stated !== null ? CAPACITY_BASIS.STATED
    : estimated?.basis ?? CAPACITY_BASIS.NOT_CALCULATED;

  const total = existing !== null && added !== null ? existing + added : null;
  const utilisation = finite(utilisationPct);
  const usable = total !== null && utilisation !== null
    ? Math.floor(total * (utilisation / 100)) : null;

  const floors = finite(addedFloors) ?? 0;
  const perFloor = finite(floorToFloorM) ?? 0;
  const addedHeightM = floors > 0 && perFloor > 0 ? floors * perFloor : null;

  return {
    existingCapacity: existing,
    additionalSpaces: added,
    additionalSpacesBasis: basis,
    additionalSpacesNote: estimated?.note ?? null,
    grossFloorAreaM2: estimated?.grossFloorAreaM2 ?? null,
    proposedTotalCapacity: total,
    usableCapacity: usable,
    increasePct: existing !== null && existing > 0 && added !== null
      ? (added / existing) * 100 : null,
    addedFloors: floors,
    addedHeightM,
    /**
     * Total height is only reported when the EXISTING height is known. No footprint in the
     * county extract carries a HEIGHT value, so for these garages it is null and the planner
     * says "existing height not published" rather than treating the added height as the whole.
     */
    existingHeightM: finite(existingHeightM),
    proposedTotalHeightM: finite(existingHeightM) !== null && addedHeightM !== null
      ? finite(existingHeightM) + addedHeightM : null,
  };
}
