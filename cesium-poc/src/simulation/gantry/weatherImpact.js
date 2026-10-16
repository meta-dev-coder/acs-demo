/**
 * What weather does to equipment, under assumptions somebody can see and change.
 *
 * No weather observation exists for this gantry, and no study relates rainfall at this location to
 * transponder reads or plate captures. So this module holds a SENSITIVITY MODEL — a small table of
 * synthetic assumptions — and applies it. It never fetches a forecast: a what-if asks "suppose it
 * rained", which is a different question from "is it raining".
 *
 * Three rules it keeps:
 *
 *   1. Weather impairs EFFECTIVENESS; it does not break equipment. An operational camera in heavy
 *      rain is an operational camera capturing fewer usable images, and the result says exactly
 *      that rather than marking the asset failed.
 *   2. A class with no configured sensitivity is left alone AND reported. RFID antennas have none
 *      here: rain does not reduce transponder reads in this model, and the result says so rather
 *      than implying that zero was measured.
 *   3. Every factor is clamped to 0..1 and applied once, at the zone, so a condition can never be
 *      counted twice on its way to the money.
 */

/** Demo weather conditions. Illustrative values, not observations or operational thresholds. */
export const WEATHER_PRESETS = Object.freeze([
  Object.freeze({ id: 'CLEAR', label: 'Clear', rainfallMmPerHour: 0, visibilityMeters: 10000, windSpeedKmh: 8 }),
  Object.freeze({ id: 'LIGHT_RAIN', label: 'Light rain', rainfallMmPerHour: 3, visibilityMeters: 6000, windSpeedKmh: 15 }),
  Object.freeze({ id: 'HEAVY_RAIN', label: 'Heavy rain', rainfallMmPerHour: 25, visibilityMeters: 1200, windSpeedKmh: 30 }),
  Object.freeze({ id: 'THUNDERSTORM', label: 'Thunderstorm', rainfallMmPerHour: 40, visibilityMeters: 800, windSpeedKmh: 55 }),
  Object.freeze({ id: 'DENSE_FOG', label: 'Dense fog', rainfallMmPerHour: 0, visibilityMeters: 150, windSpeedKmh: 5 }),
]);

export const weatherPreset = id => WEATHER_PRESETS.find(preset => preset.id === id) ?? null;

/** What a weather input may say, and the bounds it has to stay inside. */
export const WEATHER_LIMITS = Object.freeze({
  rainfallMmPerHour: Object.freeze({ min: 0, max: 150 }),
  visibilityMeters: Object.freeze({ min: 10, max: 20000 }),
  windSpeedKmh: Object.freeze({ min: 0, max: 200 }),
});

/**
 * The sensitivity model: how much of its job each class still does, in given conditions.
 *
 * Piecewise-linear between the stated points, all of them synthetic. `null` means nobody has
 * configured a sensitivity for that class, which is reported rather than read as "no effect".
 */
export const DEMO_SENSITIVITY = Object.freeze({
  VES_CAMERA: Object.freeze({
    label: 'Video enforcement capture',
    rainfall: Object.freeze([[0, 1], [3, 0.97], [25, 0.85], [40, 0.78]]),
    visibility: Object.freeze([[150, 0.6], [500, 0.85], [1200, 0.95], [10000, 1]]),
  }),
  TOLL_CAMERA: Object.freeze({
    label: 'Transaction image capture',
    rainfall: Object.freeze([[0, 1], [3, 0.98], [25, 0.88], [40, 0.82]]),
    visibility: Object.freeze([[150, 0.65], [500, 0.88], [1200, 0.96], [10000, 1]]),
  }),
  CCTV_CAMERA: Object.freeze({
    label: 'Surveillance visibility',
    rainfall: Object.freeze([[0, 1], [25, 0.8], [40, 0.7]]),
    visibility: Object.freeze([[150, 0.4], [500, 0.7], [1200, 0.9], [10000, 1]]),
  }),
  /**
   * Transponder reading. Deliberately unset: this twin has nothing relating rainfall at this
   * gantry to read rates, and inventing a figure would put weather into the revenue estimate on no
   * evidence at all. Configure it here to model it.
   */
  RFID_ANTENNA: null,
  /** Detection and classification sensors are not modelled either. */
  VDAC: null,
});

const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));

/** Piecewise-linear lookup. Outside the stated range the nearest end point holds. */
function interpolate(points, value) {
  if (!points?.length) return 1;
  const x = Number(value);
  if (!Number.isFinite(x)) return 1;
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let index = 1; index < points.length; index++) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

/**
 * How effective each equipment class is in the stated conditions.
 *
 * Rain and visibility are combined by taking the WORSE of the two rather than multiplying them:
 * they are two readings of one sky, and multiplying would punish a rainy, misty hour twice.
 *
 * @param {{rainfallMmPerHour: number, visibilityMeters: number, windSpeedKmh: number}|null} weather
 * @param {object} [sensitivity]
 * @returns {{byType: Record<string, number|null>, unconfigured: string[], clear: boolean}}
 */
export function weatherEffectiveness(weather, sensitivity = DEMO_SENSITIVITY) {
  const byType = {};
  const unconfigured = [];
  for (const [type, model] of Object.entries(sensitivity)) {
    if (!model) { byType[type] = 1; unconfigured.push(type); continue; }
    if (!weather) { byType[type] = 1; continue; }
    byType[type] = clamp01(Math.min(
      interpolate(model.rainfall, weather.rainfallMmPerHour),
      interpolate(model.visibility, weather.visibilityMeters)));
  }
  return Object.freeze({
    byType: Object.freeze(byType),
    /** Classes with no sensitivity model: unaffected here, and said to be unmodelled. */
    unconfigured: Object.freeze(unconfigured),
    clear: !weather || Object.values(byType).every(value => value === 1),
  });
}

/** A weather input, normalised from a preset id or explicit values. */
export function normaliseWeather(input) {
  if (!input) return null;
  const preset = typeof input === 'string' ? weatherPreset(input) : weatherPreset(input.type);
  const merged = {
    type: (typeof input === 'string' ? input : input.type) ?? 'CUSTOM',
    rainfallMmPerHour: Number(input?.rainfallMmPerHour ?? preset?.rainfallMmPerHour ?? 0),
    visibilityMeters: Number(input?.visibilityMeters ?? preset?.visibilityMeters ?? 10000),
    windSpeedKmh: Number(input?.windSpeedKmh ?? preset?.windSpeedKmh ?? 0),
    label: preset?.label ?? 'Custom conditions',
    dataOrigin: 'SYNTHETIC',
  };
  if (merged.type === 'CLEAR') return Object.freeze({ ...merged, rainfallMmPerHour: 0 });
  return Object.freeze(merged);
}

/** Whether a weather input is usable. */
export function validateWeather(weather) {
  const errors = [];
  if (!weather) return Object.freeze({ valid: true, errors: Object.freeze([]) });
  for (const [key, limit] of Object.entries(WEATHER_LIMITS)) {
    const value = Number(weather[key]);
    if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
      errors.push({ code: 'BAD_WEATHER', path: key,
        message: `${key} must be between ${limit.min} and ${limit.max}.` });
    }
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
