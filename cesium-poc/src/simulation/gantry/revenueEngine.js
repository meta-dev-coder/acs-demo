/**
 * Money, from transactions.
 *
 * Three separate things, kept separate because conflating them is how a model starts
 * double-counting: revenue that is NOT collected is a reduction in revenue, and the cost of trying
 * to collect it is a cost. The one is never added to the other.
 *
 *     gross            = crossings × toll
 *     collected        = (read by transponder + recovered on video) × toll
 *     unrecovered      = gross − collected
 *     processing cost  = transponder transactions × unit + video transactions × unit
 *     net contribution = collected − processing cost
 *
 * "Net tolling contribution" is not profit: this model knows nothing about maintenance, staff,
 * capital or overhead, and the name says so.
 */
import { VIDEO_CHARGE } from './syntheticTollingBaseline.js';

/** Where a financial figure stands. Never a silent zero. */
export const FINANCIAL_STATUS = Object.freeze({
  CALCULATED_SYNTHETIC: 'CALCULATED_SYNTHETIC',
  PARTIALLY_ASSESSED: 'PARTIALLY_ASSESSED',
  NOT_ASSESSED: 'NOT_ASSESSED',
});

const round = (value, places = 2) => Number(Number(value).toFixed(places));

/**
 * One run's money, from one run's transactions.
 *
 * @param {object} transactions the output of `runTransactions`
 * @param {object} baseline the synthetic assumptions
 */
export function revenueFor(transactions, baseline) {
  const tolling = baseline.tolling;
  const totals = transactions.totals;
  const toll = Number(tolling.averageTollUSD) || 0;
  // Per attempt by default: handling an image costs whether or not the toll is eventually billed.
  // Per recovered is the alternative, and which one is in force is stated in the result.
  const videoCharged = tolling.videoProcessingCharge === VIDEO_CHARGE.PER_RECOVERED
    ? totals.videoRecovered : totals.videoAttempts;
  const grossRevenue = totals.crossings * toll;
  const collectedRevenue = (totals.rfidSuccess + totals.videoRecovered) * toll;
  const rfidProcessingCost = totals.rfidSuccess * (Number(tolling.rfidProcessingCostUSD) || 0);
  const videoProcessingCost = videoCharged * (Number(tolling.videoProcessingCostUSD) || 0);
  return Object.freeze({
    transactions: Object.freeze({
      crossings: round(totals.crossings, 1),
      rfidSuccess: round(totals.rfidSuccess, 1),
      videoAttempts: round(totals.videoAttempts, 1),
      videoRecovered: round(totals.videoRecovered, 1),
      unrecovered: round(totals.unrecovered, 1),
    }),
    money: Object.freeze({
      grossRevenueUSD: round(grossRevenue),
      collectedRevenueUSD: round(collectedRevenue),
      unrecoveredRevenueUSD: round(grossRevenue - collectedRevenue),
      rfidProcessingCostUSD: round(rfidProcessingCost),
      videoProcessingCostUSD: round(videoProcessingCost),
      processingCostUSD: round(rfidProcessingCost + videoProcessingCost),
      /**
       * Collected minus the cost of collecting it. Not profit — see the module comment.
       *
       * From the ROUNDED components, so the figures on screen add up: a net computed at full
       * precision and rounded once can differ by a cent from the numbers beside it, and a reader
       * checking the arithmetic should not find it wrong.
       */
      netContributionUSD: round(round(collectedRevenue) - round(rfidProcessingCost) - round(videoProcessingCost)),
    }),
    videoProcessingCharge: tolling.videoProcessingCharge ?? VIDEO_CHARGE.PER_ATTEMPT,
    zones: transactions.zones,
    assessedZoneIds: transactions.assessedZoneIds,
    notAssessedZoneIds: transactions.notAssessedZoneIds,
    excludedCrossings: round(transactions.excludedCrossings, 1),
  });
}

/**
 * Which of the three statuses a run deserves.
 *
 * A gantry where some zones could be assessed and others could not is PARTIALLY_ASSESSED, and the
 * zones left out are named. It is never presented as a complete gantry-wide figure.
 */
export function assessmentStatus(transactions) {
  if (!transactions.zones.length) return FINANCIAL_STATUS.NOT_ASSESSED;
  if (!transactions.assessedZoneIds.length) return FINANCIAL_STATUS.NOT_ASSESSED;
  return transactions.notAssessedZoneIds.length
    ? FINANCIAL_STATUS.PARTIALLY_ASSESSED : FINANCIAL_STATUS.CALCULATED_SYNTHETIC;
}
