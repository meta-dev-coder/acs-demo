/*
 * workzone.js — MUTCD/RILCA lane-closure Temporary Traffic Control (TTC) overlay + pure math.
 *
 * Two responsibilities, kept in one small module because they share the same constants:
 *
 *  1. A JS mirror of sumo/kpi.py's `taper_length` / `advance_warning_spacing` /
 *     `channelizing_spacing` / `n_cones` / `workzone_queue` / `permissible` / `workzone` functions
 *     (config mirrors sumo/closure_config.json). The Python module is the source of truth for LIVE
 *     mode (real traci arrivals/capacity); this mirror lets the OFFLINE scenarios (baseline/
 *     intervention JSON, no SUMO backend) run the identical MUTCD/RILCA formulas so the taper
 *     length / cone count / sign spacing numbers are IDENTICAL in both modes. Keep these two in
 *     sync if the research numbers ever change.
 *
 *  2. buildWorkZone(viewer, T, spec) — draws the 4 MUTCD Temporary Traffic Control zones (advance
 *     warning signs, taper w/ channelizing cones, buffer/work space, termination) entirely through
 *     T.sumoToWorld(x, y), so the overlay rides the curved centerline and stays coupled to the same
 *     transform as vehicles/booths/marks (mark-coupling invariant — see main.js header).
 *
 * Cone/sign entities are tagged via `properties` (isCone / signText), NOT `.model` / `.ellipse` —
 * e2e helpers.ts `counts()` filters on those two graphics types for vehicles/gates, so the TTC
 * overlay is invisible to existing vehicle/gate assertions by construction (design B6).
 */
import { Color, VerticalOrigin, HeightReference } from "cesium";

const FT_TO_M = 0.3048;

// ---- RILCA / MUTCD config — mirrors sumo/closure_config.json verbatim. --------------------------
export const CLOSURE_CONFIG = {
  taperHighSpeedThresholdMph: 45,
  taperLowSpeedThresholdMph: 40,
  advanceWarningSpacingFt: { freeway: [1000, 1500, 2640], conventional: [500, 500, 500] },
  coneSpacingMaxFactor: 1.0,
  workZoneCapacityVphpl: 1600,
  avgVehicleSpacingFt: 25,
  permissible: { maxQueueMi: 4.0, maxDelayMin: 30.0 },
  diversionQueueThresholdVeh: 8,
  workzonePostPeakFactor: 0.5,
};

const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** MUTCD taper length (ft). Mirrors kpi.py taper_length(). */
export function taperLengthFt(laneWidthFt, speedMph, cfg = CLOSURE_CONFIG) {
  const hi = cfg.taperHighSpeedThresholdMph ?? 45;
  const lo = cfg.taperLowSpeedThresholdMph ?? 40;
  let L;
  if (speedMph >= hi) L = laneWidthFt * speedMph;
  else if (speedMph <= lo) L = (laneWidthFt * speedMph * speedMph) / 60.0;
  else {
    const lLo = (laneWidthFt * lo * lo) / 60.0;
    const lHi = laneWidthFt * hi;
    const t = (speedMph - lo) / (hi - lo);
    L = lLo + t * (lHi - lLo);
  }
  return round1(L);
}

/** MUTCD Table 6B-1 advance-warning sign spacing (ft), 3 signs upstream. */
export function advanceWarningSpacingFt(freeway = true, cfg = CLOSURE_CONFIG) {
  const table = cfg.advanceWarningSpacingFt || {};
  const key = freeway ? "freeway" : "conventional";
  return [...(table[key] || (freeway ? [1000, 1500, 2640] : [500, 500, 500]))];
}

/** MUTCD §6K.01 channelizing device (cone) spacing in the taper: <= 1 x speed(mph) ft. */
export function channelizingSpacingFt(speedMph, cfg = CLOSURE_CONFIG) {
  const factor = cfg.coneSpacingMaxFactor ?? 1.0;
  return Math.round(speedMph * factor);
}

/** Number of channelizing devices needed to cover the taper at the given spacing. */
export function nCones(taperLenFt, spacingFt) {
  if (!spacingFt || spacingFt <= 0) return 0;
  return Math.round(taperLenFt / spacingFt);
}

/** Deterministic (RILCA-style) oversaturation queueing. Mirrors kpi.py workzone_queue(). */
export function workzoneQueue(arrivalsVph, capacityVph, t1H, q2Vph, cfg = CLOSURE_CONFIG) {
  const avgSpacingFt = cfg.avgVehicleSpacingFt ?? 25;
  const excessVph = Math.max(0, arrivalsVph - capacityVph);
  const maxQueueVeh = excessVph * t1H;

  let recoveryTimeH = 0;
  if (maxQueueVeh > 0 && capacityVph > q2Vph) {
    recoveryTimeH = ((arrivalsVph - q2Vph) * t1H) / (capacityVph - q2Vph);
  }
  const maxDelayMin = maxQueueVeh > 0 ? 0.5 * (t1H + recoveryTimeH) * 60.0 : 0;
  const maxQueueMi = (maxQueueVeh * avgSpacingFt) / 5280.0;

  return {
    maxQueueVeh: round1(maxQueueVeh),
    maxQueueMi: round3(maxQueueMi),
    recoveryTimeH: round3(recoveryTimeH),
    maxDelayMin: round1(maxDelayMin),
  };
}

/** RILCA permissible-closure-window check: "green" iff both thresholds are met. */
export function permissible(maxQueueMi, maxDelayMin, cfg = CLOSURE_CONFIG) {
  const t = cfg.permissible || {};
  const maxQueueThresh = t.maxQueueMi ?? 4.0;
  const maxDelayThresh = t.maxDelayMin ?? 30.0;
  return maxQueueMi < maxQueueThresh && maxDelayMin < maxDelayThresh ? "green" : "red";
}

/** Assemble the full workzone KPI dict for a single lane closure. Mirrors kpi.py workzone(). */
export function rilcaWorkzone(
  laneWidthFt, speedMph, arrivalsVph, t1H, q2Vph,
  capacityVph = undefined, freeway = true, cfg = CLOSURE_CONFIG,
) {
  const cap = capacityVph ?? cfg.workZoneCapacityVphpl ?? 1600;

  const taperFt = taperLengthFt(laneWidthFt, speedMph, cfg);
  const taperM = round1(taperFt * FT_TO_M);

  const coneSpacingFt = channelizingSpacingFt(speedMph, cfg);
  const cones = nCones(taperFt, coneSpacingFt);

  const signSpacingFt = advanceWarningSpacingFt(freeway, cfg);
  const signStationsM = signSpacingFt.map((ft) => Math.round(ft * FT_TO_M));

  const queue = workzoneQueue(arrivalsVph, cap, t1H, q2Vph, cfg);
  const perm = permissible(queue.maxQueueMi, queue.maxDelayMin, cfg);

  return {
    laneWidthFt, speedMph,
    taperLengthFt: taperFt, taperLengthM: taperM,
    coneSpacingFt, nCones: cones,
    signSpacingFt, signStationsM,
    capacityVph: cap,
    permissible: perm,
    ...queue,
  };
}

// ---------------------------------------------------------------------------------------------- TTC overlay
/** Interpolate the (curved) centerline's lateral y at a given along-corridor x. Clamped to endpoints.
 *  `cl` is window.__meta.centerline / META.centerline — [[x, y], ...] local SUMO metres. */
function centerlineY(cl, x) {
  if (!cl || cl.length < 2) return 0;
  if (x <= cl[0][0]) return cl[0][1];
  if (x >= cl[cl.length - 1][0]) return cl[cl.length - 1][1];
  for (let i = 0; i < cl.length - 1; i++) {
    const [x0, y0] = cl[i], [x1, y1] = cl[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 0;
}

/** Draw a small billboard image (canvas) for a MUTCD-style sign: orange background, bold black text. */
function signImage(text, { bg = "#ff8c00", fg = "#171717" } = {}) {
  const w = 168, h = 92;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#141414";
  ctx.lineWidth = 5;
  ctx.strokeRect(2.5, 2.5, w - 5, h - 5);
  ctx.fillStyle = fg;
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Word-wrap into a small number of lines that fit the sign width.
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (ctx.measureText(trial).width > w - 18 && line) { lines.push(line); line = word; }
    else line = trial;
  }
  if (line) lines.push(line);
  const lineH = 20;
  const startY = h / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, w / 2, startY + i * lineH));
  return canvas;
}

let _entities = [];

/** Remove any previously-built TTC overlay entities. Safe to call with no active closure. */
export function clearWorkZone(viewer) {
  if (!viewer) return;
  for (const e of _entities) {
    try { viewer.entities.remove(e); } catch { /* already gone */ }
  }
  _entities = [];
}

/**
 * buildWorkZone(viewer, T, spec) — draw the TTC overlay for one active lane closure.
 *
 * spec:
 *   lane, offsetFt, speedMph                — the closure request
 *   closureStartX, closureEndX, taperLengthM — local SUMO metres; taper runs start -> end,
 *                                               merge complete (offset 0) at closureEndX
 *   nCones, signStationsM                    — MUTCD geometry (see rilcaWorkzone())
 *   centerline, roadHalfWidthM               — from window.__meta, so cones/signs ride the curve
 *   laneSign                                 — +1/-1, which side of the centerline the closed
 *                                               lane sits on (schematic; defaults to +1)
 */
export function buildWorkZone(viewer, T, spec) {
  clearWorkZone(viewer);
  if (!viewer || !T || !spec) return;

  const {
    closureStartX, closureEndX, taperLengthM,
    nCones: coneCount, signStationsM = [],
    offsetFt = 12, centerline = [], roadHalfWidthM = 20,
    laneSign = 1,
  } = spec;
  if (closureStartX == null || closureEndX == null || !taperLengthM) return;

  // Full lateral shift the taper diverts traffic by: the closed lane's width, capped well inside
  // the road half-width so cones always land on-road regardless of offsetFt.
  const fullOffsetM = Math.min(offsetFt * FT_TO_M, roadHalfWidthM * 0.6);

  // ---- Cones: merging taper, lateral offset ramps full -> 0 from closureStartX to closureEndX ----
  const n = Math.max(coneCount || 0, 2);
  const conePts = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    const x = closureStartX + frac * taperLengthM;
    const lateral = fullOffsetM * (1 - frac);
    const y = centerlineY(centerline, x) + laneSign * lateral;
    conePts.push([x, y]);
    _entities.push(viewer.entities.add({
      position: T.sumoToWorld(x, y),
      cylinder: {
        length: 0.75, topRadius: 0.02, bottomRadius: 0.22,
        material: Color.fromCssColorString("#ff6a00"),
        heightReference: HeightReference.NONE,
      },
      properties: { isCone: true },
    }));
  }

  // ---- Buffer + work-space ribbon: taper through the fully-closed segment downstream ----
  const workSpaceEndX = closureEndX + 40; // schematic work-space length past the merge point
  const ribbonPts = [
    ...conePts,
    [workSpaceEndX, centerlineY(centerline, workSpaceEndX)],
  ].map(([x, y]) => T.sumoToWorld(x, y));
  _entities.push(viewer.entities.add({
    polyline: {
      positions: ribbonPts,
      width: 6,
      material: Color.fromCssColorString("#ff6a00").withAlpha(0.55),
      clampToGround: false,
    },
    properties: { isWorkzoneRibbon: true },
  }));

  // ---- Advance-warning signs upstream of the taper start (MUTCD Table 6B-1) ----
  const labels = ["ROAD WORK AHEAD", "LANE CLOSED AHEAD", "BE PREPARED TO STOP"];
  signStationsM.forEach((stationM, i) => {
    const x = closureStartX - stationM;
    const y = centerlineY(centerline, x);
    _entities.push(viewer.entities.add({
      position: T.sumoToWorld(x, y),
      billboard: {
        image: signImage(labels[i] || `WORK ZONE ${i + 1}`),
        verticalOrigin: VerticalOrigin.BOTTOM,
        scale: 0.5,
      },
      properties: { signText: labels[i] || `WORK ZONE ${i + 1}`, stationM },
    }));
  });

  // ---- END ROAD WORK, downstream of the work space ----
  const endX = workSpaceEndX + 25;
  const endY = centerlineY(centerline, endX);
  _entities.push(viewer.entities.add({
    position: T.sumoToWorld(endX, endY),
    billboard: {
      image: signImage("END ROAD WORK", { bg: "#171717", fg: "#ffffff" }),
      verticalOrigin: VerticalOrigin.BOTTOM,
      scale: 0.5,
    },
    properties: { signText: "END ROAD WORK" },
  }));
}
