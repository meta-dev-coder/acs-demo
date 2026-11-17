/**
 * Comparison and the recommendation.
 *
 * The concept slide marks Scenario B "Recommended". Nothing here hardcodes that. A ranking is
 * produced by normalising four comparable metrics across the runs that actually exist, applying
 * the weights from config, and showing the arithmetic. If B comes first it is because it scored
 * first under stated weights on stated assumptions, and the panel says so in those words.
 *
 * Two rules the scoring follows, both of which exist to stop a ranking from being quietly wrong:
 *
 *   A MISSING METRIC IS NOT A ZERO. A scenario with no access road has no V/C. Scoring that as 0
 *   would make it the best-performing option on traffic by virtue of not having been modelled. It
 *   is excluded from that metric, the weights are renormalised over what remains, and the
 *   exclusion is reported.
 *
 *   TOO LITTLE TO COMPARE IS AN ANSWER. If fewer than two scenarios have a score, or no metric is
 *   available across them, the result is "Recommendation unavailable — additional assumptions
 *   required", not a winner by default.
 */
import { RECOMMENDATION_EXCLUSIONS, RECOMMENDATION_METRICS } from '../config/scenarioPlanner.js';

/** Pull the comparable metrics out of a run. Null where the run did not produce one. */
export function metricsOf(run) {
  const r = run?.results ?? {};
  return {
    capacity: r.capacity?.proposedTotalCapacity ?? null,
    addedSpaces: r.capacity?.additionalSpaces ?? null,
    usableCapacity: r.capacity?.usableCapacity ?? null,
    forecastDemand: r.demand?.forecastDemand ?? null,
    demandServed: r.demand?.served ?? null,
    coveragePct: r.demand?.coveragePct ?? null,
    unmetDemand: r.demand?.unmet ?? null,
    addedVehicles: r.traffic?.addedVehicles ?? null,
    accessVc: r.traffic?.vcRatio ?? null,
    peakQueue: r.traffic?.queue?.peakQueue ?? null,
    clearanceMinutes: r.traffic?.queue?.clearanceMinutes ?? null,
    constructionDisruption: r.construction?.disruptionIndex ?? null,
  };
}

/** The comparison table: one row per run, plus the metrics they share. */
export function compareRuns(runs) {
  return runs.map(run => ({
    runId: run.id,
    scenarioId: run.scenarioId,
    key: run.scenarioKey,
    name: run.scenarioName,
    type: run.scenarioType,
    executedAt: run.executedAt,
    modelVersion: run.modelVersion,
    metrics: metricsOf(run),
    warnings: run.warnings ?? [],
  }));
}

/** Normalise one metric across the rows that have it. Returns null when it cannot discriminate. */
function normalise(rows, id, direction) {
  const present = rows.filter(row => Number.isFinite(row.metrics[id]));
  if (present.length < 2) {
    // Name who was missing it, so the exclusion says something useful rather than "not available".
    const missing = rows.filter(row => !Number.isFinite(row.metrics[id])).map(row => row.name);
    return { tooFew: true, missing };
  }
  const values = present.map(row => row.metrics[id]);
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) {
    // Every scenario scores the same: the metric cannot separate them, so it is not used.
    return { scores: new Map(present.map(row => [row.runId, 0.5])), min, max, flat: true };
  }
  const scores = new Map(present.map(row => {
    const value = row.metrics[id];
    const unit = (value - min) / (max - min);
    return [row.runId, direction === 'higher' ? unit : 1 - unit];
  }));
  return { scores, min, max, flat: false };
}

/**
 * Rank the runs.
 *
 * @param {Array} runs
 * @param {object} [options]
 * @param {Array} [options.metrics]  override the weights
 * @returns {{available: boolean, reason?: string, ranking: Array, metricsUsed: Array, excluded: Array}}
 */
export function recommend(runs, { metrics = RECOMMENDATION_METRICS } = {}) {
  const rows = compareRuns(runs).filter(row => row.type !== 'BASELINE');
  if (rows.length < 2) {
    return {
      available: false,
      reason: 'Recommendation unavailable — additional assumptions required. At least two '
        + 'alternatives must be simulated before one can be ranked against another.',
      ranking: [], metricsUsed: [], excluded: [...RECOMMENDATION_EXCLUSIONS],
    };
  }

  const used = [], excluded = [];
  const normalised = new Map();
  for (const metric of metrics) {
    const result = normalise(rows, metric.id, metric.direction);
    if (result?.tooFew) {
      excluded.push(`${metric.label} — not modelled for ${result.missing.join(', ')}, so fewer `
        + 'than two scenarios could be compared on it and it is excluded entirely.');
      continue;
    }
    if (result.flat) {
      excluded.push(`${metric.label} — identical across every scenario, so it cannot separate them.`);
      continue;
    }
    // A metric only scores the scenarios that HAVE it; the rest are excluded from this metric.
    const missing = rows.filter(row => !result.scores.has(row.runId));
    if (missing.length) {
      excluded.push(`${metric.label} — not modelled for ${missing.map(m => m.name).join(', ')}, `
        + 'so those scenarios are scored on the remaining metrics rather than counted as zero.');
    }
    used.push(metric);
    normalised.set(metric.id, result);
  }

  if (used.length === 0) {
    return {
      available: false,
      reason: 'Recommendation unavailable — additional assumptions required. No metric separates '
        + 'these scenarios.',
      ranking: [], metricsUsed: [], excluded: [...excluded, ...RECOMMENDATION_EXCLUSIONS],
    };
  }

  const ranking = rows.map(row => {
    const parts = [];
    let weighted = 0, weightUsed = 0;
    for (const metric of used) {
      const score = normalised.get(metric.id).scores.get(row.runId);
      if (score === undefined) continue;     // excluded above, and renormalised below
      parts.push({ id: metric.id, label: metric.label, score, weight: metric.weight, value: row.metrics[metric.id] });
      weighted += score * metric.weight;
      weightUsed += metric.weight;
    }
    return {
      ...row,
      // Renormalised over the weight actually available, so a scenario is neither rewarded nor
      // punished for a metric nobody could compute for it.
      score: weightUsed > 0 ? weighted / weightUsed : null,
      weightUsed,
      parts,
    };
  }).filter(row => row.score !== null)
    .sort((a, b) => b.score - a.score);

  if (ranking.length < 2) {
    return {
      available: false,
      reason: 'Recommendation unavailable — additional assumptions required.',
      ranking, metricsUsed: used, excluded: [...excluded, ...RECOMMENDATION_EXCLUSIONS],
    };
  }

  return {
    available: true,
    ranking,
    metricsUsed: used,
    excluded: [...excluded, ...RECOMMENDATION_EXCLUSIONS],
    reason: explainRanking(ranking),
  };
}

/** The sentence under the ranking: what won, on what, and at what cost. */
export function explainRanking(ranking) {
  if (ranking.length < 2) return null;
  const [first, second] = ranking;
  const strengths = [...first.parts].sort((a, b) => (b.score * b.weight) - (a.score * a.weight));
  const best = strengths[0];
  const worst = strengths[strengths.length - 1];
  const bits = [`${first.name} ranks highest under the current synthetic assumptions`];
  if (best) bits.push(`because it scores best on ${best.label.toLowerCase()}`);
  if (worst && worst.id !== best?.id && worst.score < 0.5) {
    bits.push(`although it is the weaker option on ${worst.label.toLowerCase()}`);
  }
  return `${bits.join(' ')}. It is ${(first.score - second.score) > 0.05 ? 'clearly ahead of' : 'only narrowly ahead of'} ${second.name}. Change the weights or the assumptions and this order can change.`;
}

/**
 * The Key Findings: calculated statements, never the slide's claims.
 *
 * Nothing here says "reduces congestion" or "improves terminal access". When a scenario adds
 * peak-hour vehicles, the finding says so — adding parking adds trips, and a planning tool that
 * reported the opposite would be worse than useless.
 */
export function keyFindings(run, ranking = null) {
  if (!run) return [];
  const m = metricsOf(run);
  const findings = [];

  if (m.addedSpaces !== null) {
    findings.push({
      tone: 'neutral',
      text: `Adds ${m.addedSpaces.toLocaleString()} spaces for a proposed total of `
        + `${(m.capacity ?? 0).toLocaleString()} — a stated assumption, not a design.`,
    });
  }
  if (m.coveragePct !== null) {
    findings.push({
      tone: m.coveragePct >= 99 ? 'good' : 'warn',
      text: `Serves ${m.coveragePct.toFixed(0)}% of forecast peak demand `
        + `(${(m.demandServed ?? 0).toLocaleString()} of ${(m.forecastDemand ?? 0).toLocaleString()} spaces).`,
    });
  }
  if (m.unmetDemand !== null && m.unmetDemand > 0) {
    findings.push({
      tone: 'bad',
      text: `${m.unmetDemand.toLocaleString()} spaces of forecast demand remain unserved at the `
        + 'forecast year. The deficit is not closed by this alternative.',
    });
  }
  if (m.addedVehicles !== null && m.addedVehicles > 0) {
    findings.push({
      tone: 'warn',
      text: `Generates ${m.addedVehicles.toLocaleString()} additional peak-hour vehicle movements. `
        + 'More parking means more trips; this is a modelled increase, not a reduction.',
    });
  }
  if (m.accessVc !== null) {
    findings.push({
      tone: m.accessVc >= 1 ? 'bad' : m.accessVc >= 0.85 ? 'warn' : 'good',
      text: `Modelled volume-to-capacity on the nominated approach is ${m.accessVc.toFixed(2)}`
        + `${m.accessVc >= 1 ? ' — assumed demand exceeds assumed capacity' : ''}. `
        + 'A ratio, not a measured speed or delay.',
    });
  } else {
    findings.push({
      tone: 'neutral',
      text: 'No access road nominated, so no road loading was modelled for this scenario.',
    });
  }
  if (m.constructionDisruption !== null && m.constructionDisruption > 0) {
    findings.push({
      tone: 'neutral',
      text: `Construction disruption index ${m.constructionDisruption.toFixed(1)} `
        + '(duration × access capacity lost) — for ranking only, in no real unit.',
    });
  }
  const place = ranking?.findIndex(row => row.runId === run.id);
  if (Number.isInteger(place) && place >= 0 && ranking.length > 1) {
    findings.push({
      tone: 'neutral',
      text: `Ranks ${place + 1} of ${ranking.length} under the current weights.`,
    });
  }
  return findings;
}
