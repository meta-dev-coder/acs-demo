/**
 * Configuration for historical location safety analysis.
 *
 * EVERY NUMBER HERE IS OPERATIONAL/DEMO CONFIGURATION. None of it is calibrated against observed
 * secondary-crash outcomes, and none of it should reach production without validation against real
 * crash data for this corridor. It lives in one frozen block so a traffic engineer can change it in
 * one place and the tests will say what moved.
 *
 * Sized against what was measured on the connected register (178 records, May 2024 - April 2026):
 *   • at a 250 m radius, 29 of 58 corridor windows contain any crash at all
 *   • a typical non-empty 250 m window holds 5; the busiest holds 36
 * So the concentration bands below are spaced to put a typical location at NORMAL and the few genuine
 * clusters above it, rather than to make most of the corridor look alarming.
 */

export const HISTORICAL_SAFETY_CONFIG = Object.freeze({
  /** The analysis window around the selected incident. */
  defaultRadiusMeters: 250,
  /** Offered in the UI; the service accepts any of these. */
  radiusBandsMeters: Object.freeze([100, 250, 500]),
  /** How far back to look from the incident's own time. Never forward — see `analysisWindow`. */
  lookbackMonths: 12,

  /**
   * The corridor baseline: how many crashes a comparable stretch of THIS corridor holds.
   *
   * Sampled as same-sized windows along the centreline, so the comparison is like for like — a
   * 250 m circle against other 250 m circles, not against a whole FDOT section. The FDOT sections
   * were measured and rejected for this: there are only 8 of them and one contains 114 of the 178
   * records, so a "typical section" would be meaningless.
   */
  baseline: Object.freeze({
    /** Spacing of the sample points along the corridor. */
    sampleSpacingMeters: 250,
    /**
     * Only windows that contain at least one crash form the baseline.
     *
     * Including the empty stretches would drop the median to zero and make every ratio enormous.
     * Excluding them biases the denominator UP, so concentrations read conservatively — the safe
     * direction for a number an operator may act on.
     */
    ignoreEmptyWindows: true,
    /** Below this many comparable windows there is nothing to compare against. */
    minimumWindows: 5,
  }),

  /**
   * Concentration bands, as a multiple of the corridor baseline.
   *
   * Demo configuration. A ratio is a frequency comparison, NOT an exposure-adjusted crash rate:
   * the register carries no AADT or VMT, so nothing here is normalised by how much traffic passes.
   */
  concentration: Object.freeze({
    levels: Object.freeze([
      Object.freeze({ id: 'VERY_HIGH', label: 'Very high', fromRatio: 3 }),
      Object.freeze({ id: 'HIGH', label: 'High', fromRatio: 2 }),
      Object.freeze({ id: 'ELEVATED', label: 'Elevated', fromRatio: 1.35 }),
      Object.freeze({ id: 'NORMAL', label: 'Normal', fromRatio: 0 }),
    ]),
    /** Below this many local crashes the ratio is too noisy to band at all. */
    minimumLocalCrashes: 3,
  }),

  /**
   * Time-of-day buckets. Operational periods an I-595 controller would recognise, not quantiles.
   */
  timeBuckets: Object.freeze([
    Object.freeze({ id: 'OVERNIGHT', label: 'Overnight', fromHour: 0, toHour: 6 }),
    Object.freeze({ id: 'AM_PEAK', label: 'AM peak', fromHour: 6, toHour: 10 }),
    Object.freeze({ id: 'MIDDAY', label: 'Midday', fromHour: 10, toHour: 16 }),
    Object.freeze({ id: 'PM_PEAK', label: 'PM peak', fromHour: 16, toHour: 20 }),
    Object.freeze({ id: 'EVENING', label: 'Evening', fromHour: 20, toHour: 24 }),
  ]),

  /**
   * How much a concentration is worth, given where its coordinates came from.
   *
   * DEMO CONFIGURATION, like everything else here. The reasoning: a cluster computed from positions
   * that are really the locations of damaged ASSETS is partly a map of where assets are, not of
   * where vehicles stopped. It is real evidence — assets get hit where traffic conflicts happen —
   * but it is weaker evidence than surveyed crash geometry, and scoring the two identically would
   * present an artefact of the filing system as a safety finding.
   *
   * At LOW the contribution is halved, so a VERY_HIGH concentration on asset-derived coordinates
   * contributes about what an ELEVATED one on surveyed geometry would. It is reduced, never erased.
   */
  spatialConfidenceWeight: Object.freeze({ HIGH: 1, MEDIUM: 0.7, LOW: 0.5 }),

  /** A pattern below this share of the local crashes is not worth calling a pattern. */
  minimumPatternShare: 0.2,

  /** How many of each ranked list the analysis returns. */
  topPatterns: 4,
});

/** The concentration band a ratio falls in. */
export const concentrationLevelFor = ratio => {
  if (!Number.isFinite(ratio)) return null;
  return HISTORICAL_SAFETY_CONFIG.concentration.levels.find(level => ratio >= level.fromRatio)
    ?? HISTORICAL_SAFETY_CONFIG.concentration.levels.at(-1);
};

/** The bucket an hour of the day falls in. */
export const timeBucketFor = hour => (Number.isInteger(hour) && hour >= 0 && hour < 24
  ? HISTORICAL_SAFETY_CONFIG.timeBuckets.find(bucket => hour >= bucket.fromHour && hour < bucket.toHour) ?? null
  : null);
