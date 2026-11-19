/**
 * The cruise-turnaround parking model's assumptions.
 *
 * EVERY VALUE HERE IS ILLUSTRATIVE. No PortMiami parking count, mode-share survey or garage
 * transaction record has been supplied, so each default is a round, plainly labelled planning
 * figure with a `basis` sentence — the same discipline as the planner's own register
 * (`config/scenarioPlanner.js`). Change one and every result moves; nothing here is observed.
 *
 * Arriving and departing passengers have SEPARATE assumptions: the people coming off a ship and
 * the people boarding it are different groups, and nothing says they park alike.
 */

export const CRUISE_MODEL_VERSION = 'cruise-turnaround-1.3.0';

export const DEMAND_MODE = Object.freeze({ LEGACY: 'LEGACY', CRUISE: 'CRUISE' });

export const DEMAND_MODE_LABEL = Object.freeze({
  LEGACY: 'Legacy forecast',
  CRUISE: 'Cruise-driven',
});

/** What happens to a departing cohort whose return the data cannot place. */
export const VOYAGE_POLICY = Object.freeze({
  NEXT_CALL: 'NEXT_CALL',
  ASSUMED_NIGHTS: 'ASSUMED_NIGHTS',
  EXCLUDE: 'EXCLUDE',
});

export const VOYAGE_POLICY_LABEL = Object.freeze({
  NEXT_CALL: 'Next call of the same ship in the report',
  ASSUMED_NIGHTS: 'Assumed voyage length',
  EXCLUDE: 'Leave the cohort out',
});

/**
 * Where the cars for a returning ship come from when no earlier departure in the report left them.
 *   ASSUMED_VOYAGE_BEFORE  they parked for a sailing that left the assumed voyage length before
 *                          this arrival, at an assumed time; before November 1 they are already
 *                          parked when the simulation starts, otherwise they enter on that day.
 *   PARKED_AT_START        they are all parked from the start of November.
 */
export const RETURNING_COHORT_POLICY = Object.freeze({
  ASSUMED_VOYAGE_BEFORE: 'ASSUMED_VOYAGE_BEFORE',
  PARKED_AT_START: 'PARKED_AT_START',
});

export const RETURNING_COHORT_POLICY_LABEL = Object.freeze({
  ASSUMED_VOYAGE_BEFORE: 'Parked for an earlier sailing, the assumed voyage length before arrival',
  PARKED_AT_START: 'Already parked on November 1',
});

/**
 * Where each figure in the simulation comes from. The workspace shows one of these beside every
 * input so reported data, published figures, assumptions and model outputs are never confused.
 */
export const SOURCE_KIND = Object.freeze({
  REPORTED: 'REPORTED',       // the Dock Report: ships, terminals, arrival and departure times
  PUBLISHED: 'PUBLISHED',     // published figures: ship passenger capacity, garage capacity, garage links
  ASSUMED: 'ASSUMED',         // a planning assumption in this register, editable
  CONFIGURED: 'CONFIGURED',   // a setting chosen in the app (policy, scope, allocation split)
  MODELLED: 'MODELLED',       // vehicle movements produced by the simulation
  CALCULATED: 'CALCULATED',   // arithmetic on the above
});

export const SOURCE_KIND_LABEL = Object.freeze({
  REPORTED: 'Reported dock data',
  PUBLISHED: 'Published',
  ASSUMED: 'Assumption',
  CONFIGURED: 'Configured',
  MODELLED: 'Modelled',
  CALCULATED: 'Calculated',
});

/** How proposed spaces take demand: only from the terminals their garage serves, or as overflow. */
export const PROPOSED_SCOPE = Object.freeze({ OWN_TERMINALS: 'OWN_TERMINALS', ANY_TERMINAL: 'ANY_TERMINAL' });

/**
 * THE REGISTER. Departing and returning passengers each have their own complete set: ship
 * occupancy, a mode-share distribution that must total 100%, a party size per parked car, and a
 * processing window. Nothing is shared between the two sides, so editing one never moves the other.
 *
 * Mode shares are a DISTRIBUTION: long-stay parking, pick-up/drop-off, taxi/rideshare and other
 * (cruise-line transfer, coach, walk-on) are mutually exclusive and must sum to 100%. Only the
 * long-stay share occupies a garage space; the others are recorded so the split is complete and
 * checkable. Occupancy, party size and windows are independent factors and are not summed.
 */
const side = (who, Who) => ({
  [`${who}OccupancyPct`]: { label: `${Who} ship occupancy`, value: 95, unit: '% of capacity', group: who, kind: 'FACTOR',
    basis: who === 'departing'
      ? 'ILLUSTRATIVE. Share of published berths filled on a departing sailing. No manifest data is available.'
      : 'ILLUSTRATIVE, separate from departing occupancy: the passengers coming off are a different sailing.' },
  [`${who}PassengersPerVehicle`]: { label: `${Who} passengers per parked car`, value: 2.5, unit: 'passengers', group: who, kind: 'FACTOR',
    basis: 'ILLUSTRATIVE party size per parked car.' },
  [`${who}LongStayPct`]: { label: 'Long-stay parking', value: 12, unit: '% of passengers', group: `${who}Modes`, kind: 'MODE',
    basis: who === 'departing'
      ? 'ILLUSTRATIVE. Embarking passengers who park for the whole voyage. No PortMiami mode-share survey is available.'
      : 'ILLUSTRATIVE. Used only for ESTIMATED returning cars — those no departure in the report accounts for. Cars from a departure in the report keep the count stored when they parked.' },
  [`${who}PickupDropoffPct`]: { label: 'Pick-up / drop-off', value: 30, unit: '% of passengers', group: `${who}Modes`, kind: 'MODE',
    basis: 'ILLUSTRATIVE. Short-stay kerbside activity; does not occupy a long-stay space.' },
  [`${who}TaxiRidesharePct`]: { label: 'Taxi / rideshare', value: 35, unit: '% of passengers', group: `${who}Modes`, kind: 'MODE',
    basis: 'ILLUSTRATIVE. Does not occupy a long-stay space.' },
  [`${who}OtherModePct`]: { label: 'Other (transfer, coach, walk-on)', value: 23, unit: '% of passengers', group: `${who}Modes`, kind: 'MODE',
    basis: 'ILLUSTRATIVE. Cruise-line transfers, coaches and walk-ons; does not occupy a long-stay space.' },
});

export const CRUISE_ASSUMPTIONS = Object.freeze({
  ...side('departing', 'Departing'),
  ...side('returning', 'Returning'),
  entryStartBeforeDepartureMin: { label: 'Parking arrivals start', value: 330, unit: 'min before departure', group: 'departingWindow', kind: 'FACTOR',
    basis: 'ILLUSTRATIVE embarkation window: cars begin arriving 5½ h before the reported departure.' },
  entryEndBeforeDepartureMin: { label: 'Parking arrivals end', value: 90, unit: 'min before departure', group: 'departingWindow', kind: 'FACTOR',
    basis: 'ILLUSTRATIVE: check-in closes about 90 min before the reported departure.' },
  entryPeakFraction: { label: 'Arrival peak position', value: 0.45, unit: 'of window (0–1)', group: 'departingWindow', kind: 'FACTOR',
    basis: 'ILLUSTRATIVE triangular profile: arrivals peak a little before the middle of the window.' },
  exitStartAfterArrivalMin: { label: 'Parking exits start', value: 45, unit: 'min after arrival', group: 'returningWindow', kind: 'FACTOR',
    basis: 'ILLUSTRATIVE disembarkation: first cars leave about 45 min after the reported arrival.' },
  exitEndAfterArrivalMin: { label: 'Parking exits end', value: 270, unit: 'min after arrival', group: 'returningWindow', kind: 'FACTOR',
    basis: 'ILLUSTRATIVE: the last parked cars leave about 4½ h after arrival.' },
  exitPeakFraction: { label: 'Exit peak position', value: 0.3, unit: 'of window (0–1)', group: 'returningWindow', kind: 'FACTOR',
    basis: 'ILLUSTRATIVE triangular profile: exits peak early in the disembarkation window.' },
  backgroundOccupancyPct: { label: 'Non-cruise background occupancy', value: 0, unit: '% of each facility', group: 'other', kind: 'FACTOR',
    basis: 'EXPLICIT INPUT ONLY. Tenants, staff and visitors are not in the Dock Report; nothing is added for them unless set here.' },
  assumedVoyageNights: { label: 'Assumed voyage length', value: 7, unit: 'nights', group: 'other', kind: 'FACTOR',
    basis: 'ILLUSTRATIVE. Used for a departing cohort only when the unknown-voyage policy is "Assumed voyage length", and for an estimated returning cohort to place the earlier sailing its cars parked for.' },
  utilisationAmberPct: { label: 'Amber threshold', value: 70, unit: '% utilisation', group: 'thresholds', kind: 'FACTOR',
    basis: 'PLANNING THRESHOLD for colouring, not an operating standard.' },
  utilisationRedPct: { label: 'Red threshold', value: 90, unit: '% utilisation', group: 'thresholds', kind: 'FACTOR',
    basis: 'PLANNING THRESHOLD for colouring, not an operating standard.' },
});

/** The four mutually exclusive transport modes of each side, which must total 100%. */
export const MODE_SHARE_KEYS = Object.freeze({
  departing: Object.freeze(['departingLongStayPct', 'departingPickupDropoffPct', 'departingTaxiRidesharePct', 'departingOtherModePct']),
  returning: Object.freeze(['returningLongStayPct', 'returningPickupDropoffPct', 'returningTaxiRidesharePct', 'returningOtherModePct']),
});

/**
 * Keys that can be set for ONE DATE. A departing key applies to sailings departing that date; a
 * returning key (and the exit window) to ships arriving that date. A cohort's cars are computed
 * once, from the values in force on its own date, so an edit for November 22 never changes cars
 * parked by a November 15 departure.
 */
export const DAY_SCOPED_KEYS = Object.freeze(Object.keys(CRUISE_ASSUMPTIONS)
  .filter(k => /^(departing|returning)/.test(k) || /^(entry|exit)/.test(k)));

/** Which side a key belongs to: 'departing', 'returning' or null. */
export const sideOfKey = key => (/^departing|^entry/.test(key) ? 'departing' : /^returning|^exit/.test(key) ? 'returning' : null);

export const EDIT_SCOPE = Object.freeze({ DATE: 'DATE', MONTH: 'MONTH' });

/** The assumptions in force on `date`: the month's values with that date's own edits on top. */
export function effectiveAssumptions(base, byDate, date) {
  const day = (date && byDate?.[date]) || null;
  return day ? { ...base, ...day } : { ...base };
}

/**
 * The assumptions in force for ONE CRUISE CALL on `date`: the month's values, that date's edits,
 * then the call's own edits (`byCruise[callId]`). The most specific value wins.
 */
export function cruiseAssumptions(base, byDate, byCruise, date, callId) {
  const own = (callId && byCruise?.[callId]) || null;
  const e = effectiveAssumptions(base, byDate, date);
  return own ? { ...e, ...own } : e;
}

/**
 * The inputs one row of the Demand & Turnover table edits. Each side has its own occupancy,
 * long-stay share, party size and window; a departing row never lists a returning key or the
 * reverse. Peak positions stay in Data & Assumptions.
 */
export const ROW_KEYS = Object.freeze({
  departing: Object.freeze(['departingOccupancyPct', 'departingLongStayPct', 'departingPassengersPerVehicle', 'entryStartBeforeDepartureMin', 'entryEndBeforeDepartureMin']),
  returning: Object.freeze(['returningOccupancyPct', 'returningLongStayPct', 'returningPassengersPerVehicle', 'exitStartAfterArrivalMin', 'exitEndAfterArrivalMin']),
});
/** The window keys of each side: the only row inputs a reconstructed returning cohort takes. */
export const WINDOW_KEYS = Object.freeze({
  departing: Object.freeze(['entryStartBeforeDepartureMin', 'entryEndBeforeDepartureMin']),
  returning: Object.freeze(['exitStartAfterArrivalMin', 'exitEndAfterArrivalMin']),
});

/** Where a row edit is written. */
export const ROW_SCOPE = Object.freeze({ CRUISE: 'CRUISE', DATE: 'DATE', PROFILE: 'PROFILE' });

/**
 * A long-stay share for one side with the distribution kept at 100%: the "other" share (transfer,
 * coach, walk-on) takes the difference. The new "other" value is returned and shown before it is
 * applied — nothing is rescaled silently. `issue` is set when other would fall below 0%.
 */
export function balanceLongStay(current, side, longStayPct) {
  const [ls, pickup, taxi, other] = MODE_SHARE_KEYS[side];
  const otherPct = Math.round((100 - Number(longStayPct) - Number(current[pickup]) - Number(current[taxi])) * 100) / 100;
  return {
    values: { [ls]: Number(longStayPct), [other]: otherPct },
    otherPct,
    issue: otherPct < 0 ? `A ${longStayPct}% long-stay share leaves ${otherPct}% for other modes (pick-up ${current[pickup]}% and taxi ${current[taxi]}% already take the rest). Lower the share, or change the other modes in Data & Assumptions.` : null,
  };
}

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !keys.includes(k)));
const tidy = map => Object.fromEntries(Object.entries(map).filter(([, v]) => v && Object.keys(v).length));

/**
 * Apply one row's edited values (side-specific keys only) at a scope, returning NEW objects:
 *   CRUISE   this call only (`assumptionsByCruise[callId]`)
 *   DATE     every cruise on `date` (`assumptionsByDate[date]`); this call's own values for the
 *            same keys are removed so the row shows what was applied
 *   PROFILE  the month's values every cruise uses; this call's and this date's values for the same
 *            keys are removed for the same reason. Other dates and cruises keep their own values.
 */
export function applyRowEdit(state, { callId, date, values, scope }) {
  const keys = Object.keys(values);
  const byDate = { ...(state.assumptionsByDate ?? {}) };
  const byCruise = { ...(state.assumptionsByCruise ?? {}) };
  let assumptions = state.assumptions;
  if (scope === ROW_SCOPE.CRUISE) {
    byCruise[callId] = { ...(byCruise[callId] ?? {}), ...values };
  } else {
    byCruise[callId] = omit(byCruise[callId], keys);
    if (scope === ROW_SCOPE.DATE) byDate[date] = { ...(byDate[date] ?? {}), ...values };
    else {
      byDate[date] = omit(byDate[date], keys);
      assumptions = { ...assumptions, ...values };
    }
  }
  return { assumptions, assumptionsByDate: tidy(byDate), assumptionsByCruise: tidy(byCruise) };
}

/** Remove this call's and this date's values for `keys`: the month's (profile) values apply again. */
export function resetRowEdit(state, { callId, date, keys }) {
  const byDate = { ...(state.assumptionsByDate ?? {}), [date]: omit(state.assumptionsByDate?.[date], keys) };
  const byCruise = { ...(state.assumptionsByCruise ?? {}), [callId]: omit(state.assumptionsByCruise?.[callId], keys) };
  return { assumptions: state.assumptions, assumptionsByDate: tidy(byDate), assumptionsByCruise: tidy(byCruise) };
}

/**
 * Demand profiles are PRESETS that write explicit values into BOTH sides — fuller ships and a
 * higher long-stay share — never a hidden multiplier on parked cars. Each side's mode shares still
 * total 100%; the "other" share absorbs the change so the distribution stays complete.
 */
const preset = (occupancy, longStay, pickup, taxi, other) => Object.freeze(Object.fromEntries(['departing', 'returning'].flatMap(who => [
  [`${who}OccupancyPct`, occupancy], [`${who}LongStayPct`, longStay], [`${who}PickupDropoffPct`, pickup],
  [`${who}TaxiRidesharePct`, taxi], [`${who}OtherModePct`, other],
])));

export const DEMAND_PROFILES = Object.freeze({
  TYPICAL: { label: 'Typical', description: 'Ships 95% full; 12% of passengers park long-stay.', values: preset(95, 12, 30, 35, 23) },
  HIGH: { label: 'High', description: 'Ships 100% full; 13.5% of passengers park long-stay.', values: preset(100, 13.5, 29, 34, 23.5) },
  PEAK: { label: 'Peak', description: 'Ships 105% full (above double occupancy); 15% of passengers park long-stay.', values: preset(105, 15, 28, 33, 24) },
});

/** A NEW assumptions object with a profile's values written into both sides explicitly. */
export const applyProfile = (base, id) => ({ ...base, ...(DEMAND_PROFILES[id]?.values ?? {}) });

/** The profile whose values the assumptions currently match, or 'CUSTOM'. */
export function matchingProfile(a) {
  return Object.entries(DEMAND_PROFILES).find(([, p]) => Object.entries(p.values).every(([k, v]) => Number(a[k]) === v))?.[0] ?? 'CUSTOM';
}

export const defaultCruiseAssumptions = () => ({
  ...Object.fromEntries(Object.entries(CRUISE_ASSUMPTIONS).map(([key, a]) => [key, a.value])),
  voyagePolicy: VOYAGE_POLICY.NEXT_CALL,
  returningCohortPolicy: RETURNING_COHORT_POLICY.ASSUMED_VOYAGE_BEFORE,
  oneWayVoyagesPark: false,
});

/** Whether an assumption is a planning assumption or a display setting, for source labels. */
export const assumptionSourceKind = key => (CRUISE_ASSUMPTIONS[key]?.group === 'thresholds' ? SOURCE_KIND.CONFIGURED : SOURCE_KIND.ASSUMED);

/**
 * Problems with one set of assumptions, each naming the inputs that cause it.
 * @returns {{ message: string, keys: string[] }[]}
 */
export function assumptionIssues(a) {
  const issues = [];
  const add = (message, keys) => issues.push({ message, keys });
  const v = k => Number(a[k]);
  for (const [key, spec] of Object.entries(CRUISE_ASSUMPTIONS)) {
    if (a[key] === '' || !Number.isFinite(v(key))) add(`${spec.label} is not a number.`, [key]);
  }
  if (issues.length) return issues;
  for (const who of ['departing', 'returning']) {
    const Who = who[0].toUpperCase() + who.slice(1);
    const occ = `${who}OccupancyPct`;
    if (v(occ) < 0 || v(occ) > 110) add(`${Who} ship occupancy must be between 0% and 110% (a sailing can carry more than its double-occupancy berths).`, [occ]);
    const ppv = `${who}PassengersPerVehicle`;
    if (!(v(ppv) > 0) || v(ppv) > 8) add(`${Who} passengers per parked car must be above 0 and at most 8.`, [ppv]);
    const modes = MODE_SHARE_KEYS[who];
    const bad = modes.filter(k => v(k) < 0 || v(k) > 100);
    for (const k of bad) add(`${Who} ${CRUISE_ASSUMPTIONS[k].label.toLowerCase()} must be between 0% and 100%.`, [k]);
    const sum = modes.reduce((t, k) => t + v(k), 0);
    if (!bad.length && Math.abs(sum - 100) > 0.001) {
      add(`${Who} mode shares total ${Math.round(sum * 100) / 100}%, not 100%: ${modes.map(k => `${CRUISE_ASSUMPTIONS[k].label.toLowerCase()} ${v(k)}%`).join(' + ')}. Adjust them so they total exactly 100% — nothing is rescaled automatically.`, [...modes]);
    }
  }
  if (v('backgroundOccupancyPct') < 0 || v('backgroundOccupancyPct') > 100) add('Background occupancy must be between 0% and 100%.', ['backgroundOccupancyPct']);
  if (v('entryStartBeforeDepartureMin') <= v('entryEndBeforeDepartureMin')) add('Parking arrivals must start before they end.', ['entryStartBeforeDepartureMin', 'entryEndBeforeDepartureMin']);
  if (v('exitEndAfterArrivalMin') <= v('exitStartAfterArrivalMin')) add('Parking exits must start before they end.', ['exitStartAfterArrivalMin', 'exitEndAfterArrivalMin']);
  for (const k of ['entryPeakFraction', 'exitPeakFraction']) if (v(k) <= 0 || v(k) >= 1) add(`${CRUISE_ASSUMPTIONS[k].label} must be between 0 and 1.`, [k]);
  if (v('assumedVoyageNights') < 1) add('The assumed voyage length must be at least 1 night.', ['assumedVoyageNights']);
  if (v('utilisationAmberPct') >= v('utilisationRedPct')) add('The amber threshold must be below the red one.', ['utilisationAmberPct', 'utilisationRedPct']);
  return issues;
}

/**
 * Issues for the month's values, every date with its own edits, and every cruise with its own
 * edits (checked on each of its dates), the date or cruise named.
 * @param {Record<string, { label: string, dates: string[] }>} cruiseInfo  callId → name and dates
 */
export function scopedAssumptionIssues(base, byDate = {}, byCruise = {}, cruiseInfo = {}) {
  const out = assumptionIssues(base).map(i => ({ ...i, date: null }));
  for (const date of Object.keys(byDate).sort()) {
    if (!Object.keys(byDate[date] ?? {}).length) continue;
    const seen = new Set(out.map(i => i.message));
    for (const i of assumptionIssues(effectiveAssumptions(base, byDate, date))) {
      if (!seen.has(i.message)) out.push({ ...i, date, message: `${date}: ${i.message}` });
    }
  }
  for (const callId of Object.keys(byCruise).sort()) {
    if (!Object.keys(byCruise[callId] ?? {}).length) continue;
    const info = cruiseInfo[callId] ?? { label: callId, dates: [] };
    for (const date of info.dates.length ? info.dates : [null]) {
      const seen = new Set(out.map(i => i.message));
      for (const i of assumptionIssues(cruiseAssumptions(base, byDate, byCruise, date, callId))) {
        const message = `${info.label}: ${i.message}`;
        if (!seen.has(message) && !seen.has(i.message)) out.push({ ...i, date, callId, message });
      }
    }
  }
  return out;
}

/** Reasons a set of assumptions cannot be used, as sentences. */
export const validateCruiseAssumptions = a => assumptionIssues(a).map(i => i.message);

/**
 * Bring a saved configuration from the earlier register forward: shared pick-up and taxi shares
 * become each side's own, the remainder becomes "other", and a High/Peak profile — formerly a
 * hidden multiplier — becomes its explicit preset values.
 */
export function migrateAssumptions(saved = {}, profile = 'TYPICAL') {
  const out = defaultCruiseAssumptions();
  for (const k of Object.keys(out)) if (k in saved) out[k] = saved[k];
  if ('pickupDropoffPct' in saved || 'taxiRidesharePct' in saved) {
    for (const who of ['departing', 'returning']) {
      out[`${who}PickupDropoffPct`] = Number(saved.pickupDropoffPct ?? 30);
      out[`${who}TaxiRidesharePct`] = Number(saved.taxiRidesharePct ?? 35);
      const rest = 100 - Number(out[`${who}LongStayPct`]) - out[`${who}PickupDropoffPct`] - out[`${who}TaxiRidesharePct`];
      out[`${who}OtherModePct`] = Math.round(rest * 100) / 100;   // may be negative: then validation says so
    }
  }
  return profile === 'HIGH' || profile === 'PEAK' ? applyProfile(out, profile) : out;
}

/**
 * The one way an edit reaches the assumptions (used by the hook and the tests). A day-scoped key
 * with the DATE scope is written to that date only; anything else to the month's values. Only the
 * named key changes — departing and returning keys are distinct, so one side never writes the
 * other — and the result is new objects, never a mutation of the old ones.
 *
 * @returns {{ assumptions: object, assumptionsByDate: object }}
 */
export function editAssumption({ assumptions, assumptionsByDate = {}, editScope = EDIT_SCOPE.DATE }, date, key, value) {
  if (editScope === EDIT_SCOPE.DATE && DAY_SCOPED_KEYS.includes(key) && date) {
    return { assumptions, assumptionsByDate: { ...assumptionsByDate, [date]: { ...(assumptionsByDate[date] ?? {}), [key]: value } } };
  }
  return { assumptions: { ...assumptions, [key]: value }, assumptionsByDate };
}
