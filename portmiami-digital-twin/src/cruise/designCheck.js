/**
 * Checks for a parking design being edited, and its before-and-after against the existing layout.
 *
 * GEOMETRY CHECKS ONLY WHERE GEOMETRY EXISTS. An expansion is compared with what its garage's
 * CONFIRMED footprint could hold per added floor; a surface lot with what its confirmed area could
 * hold; a new garage with its placed footprint (the planner's own feasibility estimate). Where no
 * confirmed geometry exists the check says so — it never invents an area. Area per space is the
 * planner's stated assumption, not a measurement.
 */
import { DESIGN_RESULT } from './demandCapacity.js';

const n0 = v => Math.round(v).toLocaleString('en-US');
const R = 6_371_008.8;

/** Area of one polygon (outer ring minus holes) given as [lon, lat] rings, in m². */
export function ringsAreaM2(rings) {
  if (!rings?.length) return 0;
  const lat0 = (rings[0].reduce((t, p) => t + p[1], 0) / rings[0].length) * (Math.PI / 180);
  const ring = r => {
    let a = 0;
    for (let i = 0; i < r.length - 1; i += 1) {
      const [x1, y1] = [r[i][0] * Math.cos(lat0), r[i][1]];
      const [x2, y2] = [r[i + 1][0] * Math.cos(lat0), r[i + 1][1]];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2) * (Math.PI / 180) ** 2 * R * R;
  };
  return Math.max(0, ring(rings[0]) - rings.slice(1).reduce((t, h) => t + ring(h), 0));
}

/** Total footprint area of a facility drawn from one or more polygons. */
export const footprintAreaM2 = polygons => (polygons ?? []).reduce((t, rings) => t + ringsAreaM2(rings), 0);

export const CHECK = Object.freeze({ CONSISTENT: 'CONSISTENT', EXCEEDS: 'EXCEEDS', UNKNOWN: 'UNKNOWN' });

/** Added floors on a garage: does its confirmed footprint hold the added spaces? */
export function checkExpansion({ name, footprints, addedFloors, additionalSpaces, grossAreaPerSpaceM2 }) {
  const area = footprintAreaM2(footprints);
  if (!area) return { status: CHECK.UNKNOWN, message: `${name} has no confirmed footprint, so the added spaces cannot be checked against its size.` };
  if (!(addedFloors > 0)) return { status: CHECK.UNKNOWN, message: 'Enter the added floors to check the added spaces against the footprint.' };
  const perFloor = Math.floor(area / grossAreaPerSpaceM2);
  const fits = perFloor * addedFloors;
  return {
    status: additionalSpaces <= fits ? CHECK.CONSISTENT : CHECK.EXCEEDS,
    areaM2: area, perFloor, fits,
    message: `${name}'s confirmed footprint is about ${n0(area)} m²: about ${n0(perFloor)} spaces per floor at ${grossAreaPerSpaceM2} m² each (assumed), so ${addedFloors} added floor${addedFloors === 1 ? '' : 's'} hold about ${n0(fits)}. `
      + (additionalSpaces <= fits ? `${n0(additionalSpaces)} proposed is consistent.` : `${n0(additionalSpaces)} proposed is ${n0(additionalSpaces - fits)} more than that — add floors or reduce the spaces.`),
  };
}

/** A surface lot restriped: does its confirmed area hold existing plus added spaces? */
export function checkSurfaceLot({ name, footprints, existing, added, surfaceAreaPerSpaceM2 }) {
  const area = footprintAreaM2(footprints);
  if (!Number.isFinite(existing)) return { status: CHECK.UNKNOWN, message: `${name} has no published capacity, so its total after optimisation cannot be stated.` };
  if (!area) return { status: CHECK.UNKNOWN, message: `${name} has no confirmed footprint, so ${n0(added)} added spaces cannot be checked against its area. Restriping cannot add spaces without limit.` };
  const holds = Math.floor(area / surfaceAreaPerSpaceM2);
  const total = existing + added;
  return {
    status: total <= holds ? CHECK.CONSISTENT : CHECK.EXCEEDS,
    areaM2: area, holds,
    message: `${name} covers about ${n0(area)} m²: about ${n0(holds)} spaces at ${surfaceAreaPerSpaceM2} m² each (assumed). ${n0(total)} after optimisation is ${total <= holds ? 'consistent' : `${n0(total - holds)} more than the area holds`}.`,
  };
}

/** A new garage: the planner's own feasibility estimate for its placed footprint. */
export function checkNewGarage({ capacity, placed }) {
  if (!placed || !capacity || capacity.estimatedSpaces === null || capacity.estimatedSpaces === undefined) {
    return { status: CHECK.UNKNOWN, message: 'No footprint is placed for the new garage yet, so its capacity cannot be checked. Place it in the Parking Scenario Planner (Plan → proposed garage placement).' };
  }
  return {
    status: capacity.meetsTarget ? CHECK.CONSISTENT : CHECK.EXCEEDS,
    message: `The placed footprint holds about ${n0(capacity.estimatedSpaces)} spaces (${n0(capacity.grossFloorAreaM2)} m² gross at ${capacity.grossAreaPerSpaceM2} m² each, assumed). ${capacity.meetsTarget ? 'The proposed capacity is consistent.' : `The proposed ${n0(capacity.targetSpaces)} is ${n0(-capacity.differenceSpaces)} more — enlarge the footprint or add floors.`}`,
  };
}

export const CHANGE = Object.freeze({
  ELIMINATED: 'ELIMINATED', REDUCED: 'REDUCED', NO_IMPROVEMENT: 'NO_IMPROVEMENT', NO_SHORTAGE: 'NO_SHORTAGE', WORSE: 'WORSE',
});

export const CHANGE_LABEL = Object.freeze({
  ELIMINATED: 'Shortage eliminated',
  REDUCED: 'Shortage reduced — a shortage remains',
  NO_IMPROVEMENT: 'No improvement — the shortage remains',
  NO_SHORTAGE: 'No shortage to resolve',
  WORSE: 'Shortage larger',
});

/**
 * Existing → proposed for the focus: capacity, the largest shortage, cars accommodated, the first
 * shortage — and, where the design changes nothing, why: its spaces are where this focus's
 * terminals may not park.
 */
export function beforeAfter({ base, draft, sim }) {
  const sum = (d, key) => d.series.reduce((t, s) => t + s[key], 0);
  const b = base.maxShortage.value, a = draft.maxShortage.value;
  const change = b === 0 && a === 0 ? CHANGE.NO_SHORTAGE : a === 0 ? CHANGE.ELIMINATED : a < b ? CHANGE.REDUCED : a > b ? CHANGE.WORSE : CHANGE.NO_IMPROVEMENT;
  const added = sim.facilities.filter(f => f.addedSpaces > 0 || f.proposed);
  const inGroup = new Set(draft.facilities.map(f => f.id));
  const unreachable = added.filter(f => !inGroup.has(f.id));
  let reason = null;
  if (!added.length) reason = 'This design adds no spaces yet: choose where they go and how many.';
  else if (unreachable.length === added.length && (change === CHANGE.NO_IMPROVEMENT || change === CHANGE.NO_SHORTAGE)) {
    const who = unreachable.map(f => {
      const terms = Array.isArray(f.scope) ? f.scope : f.servesTerminals;
      return `${f.name} (+${n0(f.addedSpaces)}) ${terms.length ? `serves Terminal ${terms.join(', ')}` : f.scope === 'ANY_TERMINAL' ? 'serves any terminal' : 'serves no terminal yet'}`;
    }).join('; ');
    reason = `No effect on ${draft.label}: ${who}, and ${draft.terminals.length ? `Terminal ${draft.terminals.join(', ')}` : 'this focus'} cannot use those spaces.`;
  }
  return {
    capacity: [base.capacity, draft.capacity],
    shortage: [b, a],
    accommodated: [sum(base, 'entries'), sum(draft, 'entries')],
    firstShortage: [base.firstShortage?.time ?? null, draft.firstShortage?.time ?? null],
    peakDemand: [base.peak?.value ?? 0, draft.peak?.value ?? 0],
    shortageIntervals: [base.shortageIntervals, draft.shortageIntervals],
    denied: [base.turnedAway, draft.turnedAway],
    change, reason,
    resolves: change === CHANGE.ELIMINATED,
    designResult: change === CHANGE.ELIMINATED ? DESIGN_RESULT.RESOLVES : change === CHANGE.REDUCED ? DESIGN_RESULT.REDUCES : DESIGN_RESULT.NO_CHANGE,
  };
}
