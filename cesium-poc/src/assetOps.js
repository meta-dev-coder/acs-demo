/*
 * assetOps.js — PURE asset-operations rule engine for the NTTA "camera degradation + rain +
 * peak-hour → missed reads + congestion" scenario. No DOM / renderer / network imports, so it is
 * unit-testable in the node env (mirrors the scenarioA/B pricing/scoring pattern).
 *
 * The toll gantries are all-electronic: revenue depends on LPR/TollTag READ RATE. A degraded camera
 * and rain both raise the missed-read rate; missed reads are revenue at risk and drive a maintenance
 * dispatch. This overlays the SUMO throughput/queue physics — it does not replace them.
 */

// Miss-rate model (fraction of transactions whose plate/tag is not read).
export const ASSET_CONFIG = {
  baseMissRate: 0.015,        // ambient LPR miss under clear conditions on healthy gear
  degradedCameraMiss: 0.14,   // a degraded/obstructed camera at a gantry adds this
  rainMiss: { clear: 0, lightrain: 0.015, heavyrain: 0.045, fog: 0.03, snowice: 0.05 },
  peakThroughputMultiplier: 1.35, // "peak-hour" load applied to the measured throughput
  crewEtaMin: 42,             // field-crew dispatch ETA
};

/** Missed-read fraction given whether any gantry camera is degraded + the weather preset. */
export function missedReadRate({ anyDegraded, weather }, cfg = ASSET_CONFIG) {
  const rain = cfg.rainMiss[weather] ?? 0;
  return cfg.baseMissRate + (anyDegraded ? cfg.degradedCameraMiss : 0) + rain;
}

/**
 * Asset-ops KPIs for a scenario state.
 * @param {object} s
 *   gantries — [{id,name,status,...}]
 *   weather — preset key
 *   throughputVph — measured plaza throughput (from SUMO stats)
 *   avgTollUsd — average toll per transaction
 *   peak — apply the peak-hour multiplier
 * @returns {{missedReadPct,readRatePct,transactionsPerHr,missedPerHr,revenueRiskPerHr,
 *            degraded,maintenance,dispatch,congestionRisk}}
 */
export function assetKpis(s, cfg = ASSET_CONFIG) {
  const degraded = (s.gantries || []).filter((g) => g.status === "degraded");
  const anyDegraded = degraded.length > 0;
  const miss = missedReadRate({ anyDegraded, weather: s.weather }, cfg);
  const txPerHr = Math.round((s.throughputVph || 0) * (s.peak ? cfg.peakThroughputMultiplier : 1));
  const missedPerHr = Math.round(txPerHr * miss);
  const revenueRiskPerHr = Math.round(missedPerHr * (s.avgTollUsd || 0));
  // Congestion risk rises when peak demand meets a read/enforcement slowdown or bad weather.
  const congestionRisk = (s.peak && (anyDegraded || (cfg.rainMiss[s.weather] ?? 0) >= 0.03))
    ? "elevated" : anyDegraded || s.peak ? "moderate" : "nominal";
  return {
    missedReadPct: +(miss * 100).toFixed(1),
    readRatePct: +((1 - miss) * 100).toFixed(1),
    transactionsPerHr: txPerHr,
    missedPerHr,
    revenueRiskPerHr,
    degraded: degraded.map((g) => g.name),
    maintenance: anyDegraded
      ? { priority: "HIGH", target: degraded[0].name, reason: "camera read degradation" }
      : { priority: "nominal", target: null, reason: null },
    dispatch: anyDegraded
      ? `Dispatch crew to ${degraded[0].name} · ETA ${cfg.crewEtaMin} min`
      : null,
    congestionRisk,
  };
}
