/**
 * What becomes of a toll that the transponder did not take.
 *
 * The distinction this module exists to protect: a failed READ is not a lost TOLL. The vehicle is
 * photographed, the plate is matched, and the toll may still be collected — at a higher processing
 * cost. Treating every read failure as revenue lost is the single easiest way to make an equipment
 * what-if produce frightening and wrong numbers.
 *
 * The arithmetic itself lives in `transactionEngine`, which needs it inline to keep the outcomes
 * mutually exclusive. What is here is the reading of that result: how much of the fallback worked,
 * and the words for it.
 */

/** How the fallback performed, as a share of what was sent to it. */
export function recoveryRate(zoneOrTotals) {
  const attempts = zoneOrTotals?.videoAttempts ?? 0;
  if (!attempts) return null;
  return (zoneOrTotals.videoRecovered ?? 0) / attempts;
}

/**
 * The difference a scenario makes to the fallback, in whole transactions.
 *
 * Rounded only here, at the edge, so no rounded figure is ever fed back into the arithmetic.
 */
export function recoveryShift(baselineTotals, scenarioTotals) {
  const additionalAttempts = (scenarioTotals.videoAttempts ?? 0) - (baselineTotals.videoAttempts ?? 0);
  const additionalRecovered = (scenarioTotals.videoRecovered ?? 0) - (baselineTotals.videoRecovered ?? 0);
  const additionalUnrecovered = (scenarioTotals.unrecovered ?? 0) - (baselineTotals.unrecovered ?? 0);
  return Object.freeze({
    additionalAttempts,
    additionalRecovered,
    additionalUnrecovered,
    recoveredShareOfAdditional: additionalAttempts > 0 ? additionalRecovered / additionalAttempts : null,
  });
}
