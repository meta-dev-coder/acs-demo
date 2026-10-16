/**
 * What the incident cost, in three separate accounts that are never added into one number without
 * saying so.
 *
 *   A. TRAVEL DELAY — borne by road users. Vehicle-hours × value of time.
 *   B. RESPONSE COST — borne by the operating agency. Crews and equipment, by the hour.
 *   C. TOLL REVENUE — borne by the toll operator, and the one most often got wrong.
 *
 * The toll account is split four ways on purpose. A vehicle sitting in a queue is NOT lost revenue:
 * it pays the same toll fifteen minutes later. A vehicle that turns off and takes the arterial is
 * revenue the operator genuinely did not collect. A vehicle still queued when the model stops is
 * neither — it is unresolved, and saying so is more honest than assigning it. Summing deferred and
 * unrecovered revenue into "revenue lost" would overstate the loss by most of its value.
 *
 * Every rate here is an ASSUMPTION with a default and a note. Nothing in this twin publishes a
 * value of time, a crew cost or the toll schedule in force on a past date.
 */

/** Dollars, all of them. */
export const ECONOMIC_ASSUMPTIONS = Object.freeze({
  /** Value of time per vehicle-hour. */
  valueOfTimePassengerUSD: 19.5,
  valueOfTimeHeavyUSD: 48.0,
  heavyVehicleShare: 0.08,
  /** Hourly cost of a deployed crew, including the vehicle. */
  rangerHourlyUSD: 95,
  towHourlyUSD: 160,
  /** A fixed cost per tow call-out, on top of the hours. */
  towCalloutUSD: 250,
  tmcOperatorHourlyUSD: 72,
  /** Share of corridor demand that would have paid a toll. */
  tollEligibleShare: 0.22,
  /** Average toll paid by an eligible trip. */
  averageTollUSD: 2.4,
  /** Of the vehicles that divert, the share that leaves the tolled facility entirely. */
  divertedTollLossShare: 1,
});

export const ECONOMIC_NOTES = Object.freeze({
  valueOfTimePassengerUSD: 'Value of travel time per vehicle-hour for a passenger vehicle. A '
    + 'planning figure; no value of time is published for this corridor.',
  valueOfTimeHeavyUSD: 'Value of time for a heavy vehicle, where freight and driver cost more per hour.',
  heavyVehicleShare: 'Assumed share of demand that is heavy vehicles. Not a measured classification.',
  rangerHourlyUSD: 'Hourly cost of a deployed Road Ranger unit. No patrol cost data exists on this '
    + 'instance, so this is an assumption.',
  towHourlyUSD: 'Hourly cost of a tow unit on scene.',
  towCalloutUSD: 'Fixed cost of rolling a tow, independent of time on scene.',
  tmcOperatorHourlyUSD: 'TMC operator time attributable to managing the incident.',
  tollEligibleShare: 'Share of the corridor’s demand that would have paid a toll. I-595’s express '
    + 'lanes are tolled and the general-purpose lanes are not; this is the assumed split.',
  averageTollUSD: 'Average toll for an eligible trip. No historical toll schedule is published, so '
    + 'this cannot be read off the record for a past date.',
  divertedTollLossShare: 'Share of diverting vehicles that leave the tolled facility rather than '
    + 'rejoining it downstream.',
});

export const FINANCIAL_STATUS = Object.freeze({
  COLLECTED: 'COLLECTED',
  DEFERRED: 'DEFERRED',
  UNRECOVERED: 'UNRECOVERED',
  UNRESOLVED: 'UNRESOLVED',
});

const round = value => Number(value.toFixed(0));

/**
 * A. What the delay cost road users.
 *
 * Weighted by vehicle class, because an hour of a truck's time is not an hour of a car's.
 */
export function travelDelayCost(vehicleHours, assumptions = ECONOMIC_ASSUMPTIONS) {
  const heavy = vehicleHours * assumptions.heavyVehicleShare;
  const passenger = vehicleHours - heavy;
  const passengerCost = passenger * assumptions.valueOfTimePassengerUSD;
  const heavyCost = heavy * assumptions.valueOfTimeHeavyUSD;
  // Same rule as the response account: the total is the sum of what is shown.
  return Object.freeze({
    vehicleHours,
    passengerVehicleHours: Number(passenger.toFixed(1)),
    heavyVehicleHours: Number(heavy.toFixed(1)),
    passengerCostUSD: round(passengerCost),
    heavyCostUSD: round(heavyCost),
    totalUSD: round(passengerCost) + round(heavyCost),
    bearer: 'ROAD_USERS',
    basis: `${assumptions.heavyVehicleShare * 100}% heavy vehicles at `
      + `$${assumptions.valueOfTimeHeavyUSD}/h, the rest at $${assumptions.valueOfTimePassengerUSD}/h.`,
  });
}

/**
 * B. What the response cost the agency.
 *
 * Crews are charged from dispatch to the moment the scene is vacated: a unit held on the shoulder
 * is a unit being paid for and unavailable elsewhere.
 */
export function responseCost(timeline, assumptions = ECONOMIC_ASSUMPTIONS) {
  const rangerHours = ((timeline.incidentClearance - timeline.dispatched) / 60)
    * timeline.settings.rangers;
  const towHours = ((timeline.incidentClearance - timeline.towArrival) / 60) * timeline.settings.towTrucks;
  const tmcHours = (timeline.incidentClearance - timeline.detected) / 60;
  const ranger = rangerHours * assumptions.rangerHourlyUSD;
  const tow = Math.max(0, towHours) * assumptions.towHourlyUSD
    + timeline.settings.towTrucks * assumptions.towCalloutUSD;
  const tmc = tmcHours * assumptions.tmcOperatorHourlyUSD;
  return Object.freeze({
    rangerHours: Number(rangerHours.toFixed(2)),
    towHours: Number(Math.max(0, towHours).toFixed(2)),
    tmcHours: Number(tmcHours.toFixed(2)),
    rangerUSD: round(ranger),
    towUSD: round(tow),
    tmcUSD: round(tmc),
    // Summed from the ROUNDED components, not from the raw values. Rounding the raw sum gave $727
    // beside three figures adding to $728 — a penny-level artefact, but one that makes a reader
    // doubt everything else on the panel.
    totalUSD: round(ranger) + round(tow) + round(tmc),
    bearer: 'OPERATING_AGENCY',
    basis: 'Crews charged from dispatch until the scene is vacated, plus a call-out per tow.',
  });
}

/**
 * C. What happened to the toll revenue.
 *
 * Four accounts, kept apart.
 */
export function tollRevenueImpact(queue, assumptions = ECONOMIC_ASSUMPTIONS) {
  const eligible = share => share * assumptions.tollEligibleShare * assumptions.averageTollUSD;
  const collected = eligible(queue.crossed);
  const deferred = eligible(queue.deferred);
  const unrecovered = eligible(queue.diverted * assumptions.divertedTollLossShare + queue.lost);
  const diverting = queue.diverted * (1 - assumptions.divertedTollLossShare);
  const unresolved = eligible(diverting);
  return Object.freeze({
    [FINANCIAL_STATUS.COLLECTED]: round(collected),
    [FINANCIAL_STATUS.DEFERRED]: round(deferred),
    [FINANCIAL_STATUS.UNRECOVERED]: round(unrecovered),
    [FINANCIAL_STATUS.UNRESOLVED]: round(unresolved),
    collectedUSD: round(collected),
    /** Paid later, by the same vehicle. NOT a loss. */
    deferredUSD: round(deferred),
    /** Genuinely not collected: the vehicle left the facility. */
    unrecoveredUSD: round(unrecovered),
    unresolvedUSD: round(unresolved),
    eligibleVehicles: Math.round(queue.demand * assumptions.tollEligibleShare),
    bearer: 'TOLL_OPERATOR',
    separation: 'Deferred revenue is paid later by the same vehicle and is not a loss. Only '
      + 'unrecovered revenue left the facility. The two are never summed.',
    basis: `${(assumptions.tollEligibleShare * 100).toFixed(0)}% of demand toll-eligible at `
      + `$${assumptions.averageTollUSD} average. Both are assumptions: no historical toll schedule `
      + 'is published for this corridor.',
  });
}

/**
 * The three accounts together, and the comparison against a baseline.
 *
 * `totalModelledCostUSD` adds road-user delay, agency response cost and UNRECOVERED toll revenue
 * only. Deferred revenue is excluded by design — including it would charge the operator for money
 * it is about to receive.
 */
export function economicImpact({ queue, timeline, assumptions = ECONOMIC_ASSUMPTIONS } = {}) {
  const delay = travelDelayCost(queue.vehicleHoursOfDelay, assumptions);
  const response = responseCost(timeline, assumptions);
  const toll = tollRevenueImpact(queue, assumptions);
  return Object.freeze({
    delay,
    response,
    toll,
    totalModelledCostUSD: delay.totalUSD + response.totalUSD + toll.unrecoveredUSD,
    totalNote: 'Road-user delay plus agency response cost plus UNRECOVERED toll revenue. Deferred '
      + 'revenue is deliberately excluded: it is collected later, not lost.',
    assumptions,
    assumptionNotes: ECONOMIC_NOTES,
  });
}

/**
 * A scenario against the baseline.
 *
 * Reported per bearer, because "a $64,000 benefit" that is really $70,000 to road users and
 * −$6,000 to the agency is a different decision from one where both improve.
 */
export function compareEconomics(scenario, baseline) {
  if (!scenario || !baseline) return null;
  const avoidedDelay = baseline.delay.totalUSD - scenario.delay.totalUSD;
  const extraResponse = scenario.response.totalUSD - baseline.response.totalUSD;
  const recoveredRevenue = baseline.toll.unrecoveredUSD - scenario.toll.unrecoveredUSD;
  return Object.freeze({
    avoidedDelayCostUSD: avoidedDelay,
    incrementalResponseCostUSD: extraResponse,
    recoveredTollRevenueUSD: recoveredRevenue,
    deferredRevenueChangeUSD: scenario.toll.deferredUSD - baseline.toll.deferredUSD,
    /** What the whole corridor is better off by, with the agency's extra spend taken off. */
    netBenefitUSD: avoidedDelay + recoveredRevenue - extraResponse,
    byBearer: Object.freeze({
      ROAD_USERS: avoidedDelay,
      OPERATING_AGENCY: -extraResponse,
      TOLL_OPERATOR: recoveredRevenue,
    }),
    benefitCostRatio: extraResponse > 0
      ? Number(((avoidedDelay + recoveredRevenue) / extraResponse).toFixed(2)) : null,
    note: 'A modelled difference between two sets of assumptions, not a forecast saving. The '
      + 'deferred-revenue change is shown separately and is not part of the net benefit.',
  });
}
