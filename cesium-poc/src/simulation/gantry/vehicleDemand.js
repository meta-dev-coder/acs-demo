/**
 * How many toll-eligible vehicles cross, and where.
 *
 * Deliberately the only place demand is decided, and deliberately separate from the money: when
 * SUMO arrives it replaces this file's output and nothing downstream changes. `demandFromCrossings`
 * already accepts the event shape that work will produce.
 *
 * The constant-rate assumption is stated rather than hidden: a scenario is an assessment over a
 * duration, so demand is the hourly rate prorated by that duration and split across zones by their
 * configured share. No peaking, no time of day — the twin has no data for either.
 */

/** How the number was arrived at, so a reader never has to guess. */
export const DEMAND_BASIS = Object.freeze({
  CONSTANT_RATE: 'CONSTANT_RATE',
  CROSSING_EVENTS: 'CROSSING_EVENTS',
});

/**
 * Crossings per zone for one scenario.
 *
 * @param {{zones: object[], vehiclesPerHour: number, durationMinutes: number}} input
 * @returns {{basis: string, durationHours: number, total: number, byZone: Record<string, number>}}
 */
export function demandForDuration({ zones = [], vehiclesPerHour = 0, durationMinutes = 0 } = {}) {
  const durationHours = Math.max(0, Number(durationMinutes) || 0) / 60;
  const total = Math.max(0, Number(vehiclesPerHour) || 0) * durationHours;
  const byZone = {};
  for (const zone of zones) byZone[zone.zoneId] = total * (Number(zone.demandShare) || 0);
  return Object.freeze({
    basis: DEMAND_BASIS.CONSTANT_RATE,
    durationHours,
    total,
    byZone: Object.freeze(byZone),
  });
}

/**
 * The same shape, built from individual crossing events.
 *
 * Unused in this phase and tested as an interface only: it is what a SUMO run will hand in, so the
 * transaction engine never has to know which of the two it is reading.
 *
 * @param {{tollingZoneId: string, tollEligible?: boolean, applicableTollUSD?: number}[]} crossings
 */
export function demandFromCrossings(crossings = [], { durationMinutes = 0 } = {}) {
  const byZone = {};
  let total = 0;
  for (const crossing of crossings) {
    if (crossing?.tollEligible === false) continue;
    const zoneId = crossing?.tollingZoneId;
    if (!zoneId) continue;
    byZone[zoneId] = (byZone[zoneId] ?? 0) + 1;
    total += 1;
  }
  return Object.freeze({
    basis: DEMAND_BASIS.CROSSING_EVENTS,
    durationHours: Math.max(0, Number(durationMinutes) || 0) / 60,
    total,
    byZone: Object.freeze(byZone),
  });
}
