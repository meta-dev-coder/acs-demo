/**
 * Parking demand: how much is wanted, and how much a scenario could hold.
 *
 * A compound-growth forecast off an assumed base, with an assumed peak-day multiplier. That is
 * the whole model, and it is deliberately the whole model: anything more elaborate would look
 * like a calibrated forecast without being one.
 *
 * What it refuses to do:
 *
 *   It does not use the concept slide's "62% cruise growth by 2050". No source for that figure
 *   has been supplied or checked, and cruise passenger growth is not parking demand growth —
 *   mode share, occupancy and crew parking all sit between them. The growth rate here is a
 *   stated annual assumption instead.
 *
 *   It does not add a cruise-passenger term on top of the base demand. The base is already peak
 *   parking occupancy, so a passenger-derived term would count the same cars twice.
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

/**
 * Forecast peak parking demand.
 *
 * Forecast = base × (1 + growth) ^ years × peak multiplier
 */
export function forecastDemand({ baseDemandSpaces, annualGrowthPct, baseYear, forecastYear, peakMultiplier }) {
  const base = finite(baseDemandSpaces);
  const growth = finite(annualGrowthPct);
  const from = finite(baseYear);
  const to = finite(forecastYear);
  const peak = finite(peakMultiplier);
  if (base === null || growth === null || from === null || to === null || peak === null) {
    return { demand: null, years: null, reason: 'A demand assumption is missing.' };
  }
  const years = to - from;
  if (years < 0) {
    return { demand: null, years, reason: 'The forecast year is before the base year.' };
  }
  const grown = base * ((1 + growth / 100) ** years);
  return {
    demand: Math.round(grown * peak),
    averageDayDemand: Math.round(grown),
    years,
    reason: null,
  };
}

/**
 * Supply against demand for one scenario.
 *
 * `served` is capped at demand: a garage with room for 6,000 cars does not serve 6,000 when only
 * 4,000 want to park, and reporting it that way would let spare capacity inflate the ranking.
 */
export function demandResult({ usableCapacity, forecast }) {
  const capacity = Number.isFinite(usableCapacity) ? usableCapacity : null;
  const demand = Number.isFinite(forecast?.demand) ? forecast.demand : null;
  if (capacity === null || demand === null) {
    return {
      forecastDemand: demand, usableCapacity: capacity, served: null, unmet: null,
      surplus: null, utilisationPct: null, coveragePct: null,
    };
  }
  const served = Math.min(capacity, demand);
  return {
    forecastDemand: demand,
    usableCapacity: capacity,
    served,
    unmet: Math.max(0, demand - capacity),
    surplus: Math.max(0, capacity - demand),
    /** Occupancy of the built supply at the forecast peak, capped at 100%. */
    utilisationPct: capacity > 0 ? Math.min(100, (demand / capacity) * 100) : null,
    /** The share of forecast demand the scenario can hold. */
    coveragePct: demand > 0 ? (served / demand) * 100 : null,
  };
}

/** The demand curve between two years, for the chart. One point per year, from the same formula. */
export function demandSeries({ baseDemandSpaces, annualGrowthPct, baseYear, forecastYear, peakMultiplier }, { step = 1 } = {}) {
  const from = Number(baseYear), to = Number(forecastYear);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const points = [];
  for (let year = from; year <= to; year += step) {
    const { demand } = forecastDemand({ baseDemandSpaces, annualGrowthPct, baseYear, forecastYear: year, peakMultiplier });
    if (demand !== null) points.push({ year, demand });
  }
  if (points.length && points[points.length - 1].year !== to) {
    const { demand } = forecastDemand({ baseDemandSpaces, annualGrowthPct, baseYear, forecastYear: to, peakMultiplier });
    if (demand !== null) points.push({ year: to, demand });
  }
  return points;
}
