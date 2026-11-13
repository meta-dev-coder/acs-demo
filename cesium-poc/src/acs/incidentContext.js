/**
 * What the corridor was like at the moment an incident happened.
 *
 * WEATHER is real. `weather/historicalWeather.js` already asks Open-Meteo's historical-forecast
 * endpoint for the conditions at a coordinate and an hour, with units declared and the corridor's
 * own timezone applied; this reuses that service unchanged rather than adding a second way to ask.
 *
 * TRAFFIC is not, and the reason is worth stating plainly because the brief asks for it to be
 * checked rather than assumed. Searched before writing any of this:
 *
 *   - `i595RoadSegmentLayer.js` keeps a `segmentStatus` map and it is deliberately empty —
 *     "Intentionally empty: no fabricated traffic observations."
 *   - `corridorStatusBar.js` leaves out speed, travel time and congestion entirely and says the
 *     corridor "has no traffic-condition feed connected".
 *   - FL511 publishes CURRENT events only; nothing in the feed is a timestamped past observation.
 *   - SunGuide has no integration in this repository at all — only prose references to one.
 *   - The DataConnect classes hold maintenance records and an incident register. The register
 *     carries no speed, volume or occupancy.
 *
 * So there is no historical speed, congestion or volume for this corridor, and none is invented
 * as if there were. What this service does instead:
 *
 *   - reports the REAL facts the source incident and the road network actually carry — the
 *     register's own lane-closure, injury and fatality flags, and the segment's published AADT
 *     with its year;
 *   - supplies speed, congestion and volume for the seven demo cases as clearly labelled synthetic
 *     observations, deterministic from the case so a rehearsal and a demonstration agree;
 *   - states, per value, where it came from, when it was observed, how well it matches this place,
 *     its units and its quality — so the real and the synthetic can never be read as one set.
 */
import { createHistoricalWeatherService, localClockLabel } from '../weather/historicalWeather.js';

export { localClockLabel };

/** Where one value came from. Carried on every value; never inferred by the screen. */
export const OBSERVATION_SOURCE = Object.freeze({
  /** Measured and published by somebody else — Open-Meteo, the register, the FDOT network. */
  OBSERVED: 'OBSERVED',
  /** A published average over a period, not a reading at this instant. */
  PUBLISHED_AVERAGE: 'PUBLISHED_AVERAGE',
  /** Generated for the demonstration because no feed exists. */
  SYNTHETIC: 'SYNTHETIC',
});

/** How confident the value is as a description of THIS place at THIS time. */
export const DATA_QUALITY = Object.freeze({
  MEASURED: 'MEASURED',
  MODELLED: 'MODELLED',
  DERIVED: 'DERIVED',
  SYNTHETIC: 'SYNTHETIC',
  UNAVAILABLE: 'UNAVAILABLE',
});

/** How close the value's own location is to the incident. */
export const SPATIAL_MATCH = Object.freeze({
  EXACT: 'EXACT',
  SEGMENT: 'SEGMENT',
  GRID_CELL: 'GRID_CELL',
  CORRIDOR: 'CORRIDOR',
  NONE: 'NONE',
});

/**
 * One value, with everything needed to judge it.
 *
 * Every field is required. A value with no stated source or quality is exactly the kind of number
 * this application refuses to draw.
 */
export const observation = ({ label, value, unit = null, source, observedAt, spatialMatch,
  quality, note = null, synthetic = false }) => Object.freeze({
  label, value, unit, source, observedAt, spatialMatch, quality, note, synthetic,
});

/** An absence, said as an absence. Never a zero and never a blank. */
export const unavailable = (label, note) => observation({
  label, value: null, source: null, observedAt: null,
  spatialMatch: SPATIAL_MATCH.NONE, quality: DATA_QUALITY.UNAVAILABLE, note,
});

/**
 * What this deployment can actually answer about past traffic.
 *
 * Exported so the panel can state the position rather than implying it, and so a test fails the
 * day somebody connects a feed and forgets to update the wording.
 */
export const TRAFFIC_AVAILABILITY = Object.freeze({
  historicalSpeed: false,
  historicalVolume: false,
  historicalCongestion: false,
  /** The register records whether an incident closed lanes. That IS a real historical fact. */
  historicalLaneClosure: true,
  /** The FDOT segment layer publishes an annual average, which is not an observation. */
  annualAverageVolume: true,
  checkedSources: Object.freeze(['FL511', 'SunGuide', 'DataConnect', 'FDOT road segments']),
  note: 'No timestamped speed, volume or congestion observation exists for this corridor in any '
    + 'connected system. FL511 publishes current events only, SunGuide is not integrated, and the '
    + 'DataConnect incident register carries no traffic measurements. The speed, congestion and '
    + 'volume shown for a demo case are synthetic and labelled as such.',
});

/* --- deterministic synthetic traffic ---------------------------------------------------------- */

/** A stable 0..1 from a string, so a case's traffic is the same on every run. */
function unitHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < String(text).length; index += 1) {
    hash ^= String(text).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

/** The corridor-local hour of an ISO instant, which is what time of day means here. */
export function corridorHour(isoTimestamp) {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(parsed));
}

/**
 * The shape of a weekday on an urban interstate: two peaks, a quiet night.
 *
 * A multiplier on free-flow speed, not a speed. It exists so a 04:05 incident does not come back
 * congested and a 17:45 one does not come back free-flowing — which is the whole reason the brief
 * asks for the synthetic values to be coherent with the timestamp.
 */
export function diurnalFactor(hour) {
  if (hour == null) return 1;
  if (hour >= 7 && hour < 9) return 0.55;
  if (hour >= 16 && hour < 19) return 0.5;
  if (hour >= 9 && hour < 16) return 0.85;
  if (hour >= 19 && hour < 22) return 0.9;
  return 1;
}

export const FREE_FLOW_MPH = 65;

/** Congestion band from a speed, using the band names the corridor's own model already uses. */
export function congestionBand(speedMph) {
  if (!Number.isFinite(speedMph)) return null;
  if (speedMph >= 55) return 'FREE_FLOW';
  if (speedMph >= 40) return 'MODERATE';
  if (speedMph >= 25) return 'HEAVY';
  return 'SEVERE';
}

/**
 * Synthetic traffic for one demo case, coherent with its hour and stable across runs.
 *
 * Deliberately NOT a function of the incident's severity: inferring that a collision slowed the
 * road and then showing the slow road as evidence about the collision would be circular.
 */
export function syntheticTraffic(demoCase) {
  const at = demoCase?.incident?.reportedAt ?? null;
  const hour = corridorHour(at);
  const jitter = unitHash(demoCase?.demoCaseId ?? '') * 0.2 - 0.1;
  const factor = Math.max(0.25, Math.min(1, diurnalFactor(hour) + jitter));
  const speed = Math.round(FREE_FLOW_MPH * factor);
  const band = congestionBand(speed);
  // Volume rises as speed falls on an urban interstate until it breaks down; a simple curve is
  // enough here and the figure is labelled synthetic either way.
  const volume = Math.round(1500 + (1 - factor) * 2600);

  const common = {
    observedAt: at, spatialMatch: SPATIAL_MATCH.SEGMENT,
    source: OBSERVATION_SOURCE.SYNTHETIC, quality: DATA_QUALITY.SYNTHETIC, synthetic: true,
  };
  return Object.freeze({
    speed: observation({ ...common, label: 'Average speed', value: speed, unit: 'mph',
      note: `Synthetic. Generated from the incident hour (${hour == null ? 'unknown' : `${hour}:00`} `
        + 'corridor local) and a per-case constant, so it is the same on every run. No speed '
        + 'observation exists for this corridor.' }),
    congestion: observation({ ...common, label: 'Congestion', value: band, unit: null,
      note: `Synthetic. The band a ${speed} mph average falls in, using the corridor's own band `
        + 'definitions.' }),
    volume: observation({ ...common, label: 'Throughput', value: volume, unit: 'veh/h/direction',
      note: 'Synthetic. Not measured, and not derived from the AADT below.' }),
    hour,
  });
}

/* --- the real facts ---------------------------------------------------------------------------- */

/**
 * What the source incident's own register row records about the road at the time.
 *
 * These are real observations about a real incident. They describe the SOURCE incident, not the
 * synthetic damage the demo case narrates, and the note on each says so.
 */
export function registerFacts(sourceIncident) {
  if (!sourceIncident) {
    return Object.freeze([unavailable('Lane closure',
      'This case has no source incident, so the register has nothing to say about it.')]);
  }
  const related = sourceIncident.related ?? {};
  const yes = value => /^y/i.test(String(value ?? ''));
  const stated = value => String(value ?? '').trim() !== '';
  const base = {
    observedAt: sourceIncident.createdDate ?? null, spatialMatch: SPATIAL_MATCH.EXACT,
    source: OBSERVATION_SOURCE.OBSERVED, quality: DATA_QUALITY.MEASURED, synthetic: false,
  };
  const note = `Recorded against incident ${sourceIncident.id} in the DataConnect register. `
    + 'This is a fact about that real incident, not about this case\'s synthetic damage.';

  return Object.freeze([
    stated(related.laneClosure)
      ? observation({ ...base, label: 'Lane closure', value: yes(related.laneClosure) ? 'Yes' : 'No', note })
      : unavailable('Lane closure', `Incident ${sourceIncident.id} has no lane-closure flag recorded.`),
    stated(related.injuries)
      ? observation({ ...base, label: 'Injuries', value: yes(related.injuries) ? 'Yes' : 'No', note })
      : unavailable('Injuries', `Incident ${sourceIncident.id} has no injury flag recorded.`),
    Number.isFinite(related.fatalities)
      ? observation({ ...base, label: 'Fatalities', value: related.fatalities, note })
      : unavailable('Fatalities', `Incident ${sourceIncident.id} has no fatality count recorded.`),
  ]);
}

/**
 * The published annual average for the segment, where the road network has one.
 *
 * An AADT is a real figure and is not an observation at the incident hour. It is reported as a
 * `PUBLISHED_AVERAGE` with its year so nobody reads it as the traffic that evening.
 */
export function annualAverage(segment) {
  if (!segment || !Number.isFinite(segment.aadt)) {
    // The lookup says WHY when it can — "the nearest segment is 998 m away" is a fact about this
    // incident's coordinate, and a far more useful answer than "no segment was matched", which
    // reads as though the road layer were missing.
    return unavailable('Annual average daily traffic',
      segment?.unmatchedReason
        ?? 'No FDOT segment with a published AADT was matched to this location.');
  }
  return observation({
    label: 'Annual average daily traffic',
    value: segment.aadt,
    unit: 'vehicles/day',
    source: OBSERVATION_SOURCE.PUBLISHED_AVERAGE,
    observedAt: segment.aadtYear ? String(segment.aadtYear) : null,
    spatialMatch: SPATIAL_MATCH.SEGMENT,
    quality: DATA_QUALITY.MEASURED,
    synthetic: false,
    note: `FDOT published average for segment ${segment.segmentId ?? 'unknown'}`
      + `${segment.aadtYear ? `, ${segment.aadtYear}` : ''}. An annual average over all days, not `
      + 'a measurement at the incident hour.',
  });
}

/* --- weather ------------------------------------------------------------------------------------ */

/**
 * The one sentence that describes where every weather row came from.
 *
 * Said once for the panel instead of on each row: eight identical paragraphs is the kind of
 * repetition that makes people stop reading the provenance altogether.
 */
export function weatherProvenance(reading) {
  if (!reading) return null;
  const exact = reading.matchedWeatherTime === reading.requestedIncidentTime;
  return `${reading.source} historical reanalysis at a model grid cell, not a roadside sensor`
    + `${exact ? '' : `. Asked for ${reading.requestedIncidentTime}, matched ${reading.matchedWeatherTime}`}`
    + '.';
}

/** The weather reading as observations, each carrying the units the service declared. */
export function weatherObservations(reading, { requestedAt = null } = {}) {
  if (!reading) {
    return Object.freeze([unavailable('Weather at incident time',
      'Open-Meteo did not return a reading for this coordinate and hour. Nothing has been '
      + 'substituted for it.')]);
  }
  const base = {
    observedAt: reading.matchedWeatherTime,
    spatialMatch: SPATIAL_MATCH.GRID_CELL,
    source: OBSERVATION_SOURCE.OBSERVED,
    quality: DATA_QUALITY.MODELLED,
    synthetic: false,
  };
  // The provenance sentence is identical on every row, so it is said ONCE for the panel rather
  // than repeated eight times down it. A row's own note carries only what differs.
  const of = (label, value, unit) => (value == null
    ? unavailable(label, `${reading.source} returned no value for this hour.`)
    : observation({ ...base, label, value, unit, note: null }));

  return Object.freeze([
    of('Condition', reading.condition, null),
    of('Temperature', reading.temperature, reading.units.temperature),
    of('Precipitation', reading.precipitation, reading.units.precipitation),
    of('Visibility', reading.visibility, reading.units.visibility),
    of('Wind', reading.windSpeed, reading.units.windSpeed),
    of('Wind gust', reading.windGust, reading.units.windGust),
    of('Humidity', reading.humidity, reading.units.humidity),
    of('Cloud cover', reading.cloudCover, reading.units.cloudCover),
  ].filter(entry => entry.value !== null || entry.label === 'Condition' || requestedAt === null));
}

/**
 * What the conditions mean for the work, stated only where a reading supports it.
 *
 * Every line names the reading it came from. Nothing is said about an absent value, and nothing
 * here claims the weather caused anything.
 */
export function operationalImplications({ reading, traffic, register }) {
  const out = [];
  if (reading?.visibility != null && reading.visibility < 5000) {
    out.push(`Visibility ${Math.round(reading.visibility)} m. Below the 5 km the corridor's own risk `
      + 'model treats as reduced, so sign and marking inspection carried out at this hour would '
      + 'need confirming in daylight.');
  }
  if (reading?.precipitation != null && reading.precipitation > 0.2) {
    out.push(`${reading.precipitation} mm of rain in the hour. Thermoplastic and adhesive work `
      + 'cannot be accepted on a wet pavement, so a marking repair timed near this hour is worth '
      + 'checking against its application-conditions record.');
  }
  if (reading?.windGust != null && reading.windGust >= 40) {
    out.push(`Gusts to ${Math.round(reading.windGust)} km/h. Above the threshold at which bucket `
      + 'and lift work on lighting is normally stood down.');
  }
  const closure = register?.find(entry => entry.label === 'Lane closure');
  if (closure?.value === 'Yes') {
    out.push('The source incident closed lanes, so a repair crew arriving would have found traffic '
      + 'control already in place.');
  }
  if (traffic?.congestion?.value === 'HEAVY' || traffic?.congestion?.value === 'SEVERE') {
    out.push(`Traffic at the incident hour is modelled as ${traffic.congestion.value.toLowerCase().replace('_', ' ')}`
      + ' — synthetic, so treat it as scene-setting rather than as a finding.');
  }
  if (!out.length) {
    out.push('Nothing in the available readings bears on how this work should have been carried '
      + 'out or accepted.');
  }
  return Object.freeze(out);
}

/* --- the service --------------------------------------------------------------------------------- */

/**
 * The Incident Context Enrichment service.
 *
 * @param {{weatherService?: object, segmentFor?: (point: object) => object|null}} [deps]
 *   `segmentFor` resolves the FDOT segment a coordinate sits on, when the road layer has loaded.
 */
export function createIncidentContextService({
  weatherService = createHistoricalWeatherService(),
  segmentFor = null,
} = {}) {
  const cache = new Map();

  /**
   * @param {object} demoCase with its `sourceIncident` resolved
   * @returns {Promise<object>} weather, traffic, availability and implications
   */
  async function contextFor(demoCase) {
    const key = demoCase?.demoCaseId ?? null;
    if (key && cache.has(key)) return cache.get(key);

    const incident = demoCase?.sourceIncident ?? null;
    const timestampMs = Date.parse(demoCase?.incident?.reportedAt ?? '');
    const point = incident && Number.isFinite(timestampMs)
      ? { latitude: incident.latitude, longitude: incident.longitude, timestampMs } : null;

    const reading = point ? await weatherService.weatherAt(point).catch(() => null) : null;
    // Awaited: the segment layer is fetched once and the lookup is a promise until it lands.
    // A resolver that throws must leave the AADT unavailable, not fail the whole context.
    const segment = segmentFor && incident
      ? await Promise.resolve(segmentFor(incident)).catch(() => null) : null;
    const traffic = syntheticTraffic(demoCase);
    const register = registerFacts(incident);

    const context = Object.freeze({
      caseId: demoCase?.demoCaseId ?? null,
      /** What was asked for, so a reader can see it is the incident's own hour. */
      incidentAt: demoCase?.incident?.reportedAt ?? null,
      incidentHourLabel: reading ? localClockLabel(reading.matchedWeatherTime) : null,
      location: Object.freeze({
        latitude: incident?.latitude ?? null,
        longitude: incident?.longitude ?? null,
        sourceIncidentId: incident?.id ?? null,
        segmentId: segment?.segmentId ?? null,
      }),
      weather: Object.freeze({
        reading,
        observations: weatherObservations(reading),
        provenance: weatherProvenance(reading),
        available: Boolean(reading),
        unavailableReason: reading ? null
          : point ? 'Open-Meteo returned no reading for this coordinate and hour.'
            : 'This case has no located source incident, so there is no coordinate to ask about.',
      }),
      traffic: Object.freeze({
        ...traffic,
        annualAverage: annualAverage(segment),
        register,
        availability: TRAFFIC_AVAILABILITY,
      }),
      implications: operationalImplications({ reading, traffic, register }),
    });
    if (key) cache.set(key, context);
    return context;
  }

  return {
    contextFor,
    cached: caseId => cache.get(caseId) ?? null,
    availability: TRAFFIC_AVAILABILITY,
    get size() { return cache.size; },
  };
}
