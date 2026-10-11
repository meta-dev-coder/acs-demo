/**
 * Insight tools: answers the twin computes, so the model explains them instead of working them out.
 *
 * - `explain_incident` and `rank_incidents` run the TMC's own risk service (src/tmc/tmcService.js,
 *   the code behind the TMC screen) on the live events, so the chat ranks incidents exactly as the
 *   screen does.
 * - `crash_hotspots` ranks corridor segments by recorded crashes, optionally in wet weather.
 * - `weather_risk_forecast` is the forecasting scenario: the next hours' rain forecast against each
 *   segment's wet-weather crash history, with a do-nothing baseline and one pre-approved playbook
 *   rule for pre-positioning a patrol.
 *
 * Every figure comes from records; anything the data cannot say is returned as `notEvaluated` /
 * `gaps`, never estimated. Each tool returns `{output, source, summary}` like the read tools.
 */
import { CARRIAGEWAYS } from '../../src/liveOps/carriagewayModel.js';
import { assessCorridor } from '../../src/tmc/tmcService.js';
import { liveContext } from '../../src/tmc/temporalContext.js';
import { haversineMeters } from '../geo.mjs';
import { originOf } from './twinStore.mjs';

/** A crash further than this from every FDOT section is not placed on one. */
export const PLACE_WITHIN_M = 400;

/** Weather values in the crash register that mean a wet road. */
export const WET = /rain|storm|shower|drizzle|wet|thunder|flood|tropical/i;
/** Playbook rule P-WX-1, agreed wording; the thresholds are the rule's, not the model's. */
export const PLAYBOOK_WX1 = Object.freeze({
  id: 'P-WX-1',
  title: 'Pre-position a patrol ahead of forecast rain',
  rainProbability: 50,
  minWetCrashes: 3,
});
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

/** Corridor sections from the FDOT segment layer, in the shape the TMC service expects. */
export function sectionsFromGeojson(geojson) {
  return (geojson?.features ?? []).map(f => {
    const p = f.properties ?? {};
    return {
      segmentId: p.segment_id,
      sectionId: `SECTION_${String(p.fdot_segment_index).padStart(2, '0')}`,
      sectionIndex: p.fdot_segment_index,
      sectionLabel: `${p.direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(p.fdot_segment_index).padStart(2, '0')}`,
      carriageway: p.direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL,
      travelOrder: p.travel_order,
      coordinates: f.geometry?.coordinates ?? [],
    };
  });
}

/** Cameras from the corridor camera layer, as TMC resources. */
export function camerasFromGeojson(geojson) {
  return (geojson?.features ?? []).map(f => {
    const [lon, lat] = f.geometry?.coordinates ?? [];
    const id = f.properties?.camera_id;
    return { id: id == null ? null : String(id), longitude: lon, latitude: lat, record: f.properties };
  }).filter(c => c.id && Number.isFinite(c.longitude) && Number.isFinite(c.latitude));
}

const round = (n, d = 4) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const factorOf = f => ({ factor: f.label ?? f.type, contribution: f.contribution ?? 0, ...(f.detail ? { detail: String(f.detail).slice(0, 160) } : {}) });

/** One assessed incident, reduced to what an answer needs. */
function compactAssessment(entry, rank, total) {
  const { incident, risk, upstream, mitigation, resources, insight } = entry;
  const camera = resources?.camera?.resource;
  return {
    incident: {
      id: incident.id, title: incident.title ?? null, section: incident.sectionLabel ?? null,
      carriageway: incident.carriageway ?? null, severity: incident.severity ?? null,
      lanesBlocked: incident.lanes?.blockedLanes ?? null, fullClosure: incident.lanes?.fullClosure ?? null,
      minutesActive: incident.durationMinutes ?? null,
      lon: round(incident.longitude ?? incident.event?.longitude), lat: round(incident.latitude ?? incident.event?.latitude),
    },
    risk: { score: risk.score, level: risk.levelLabel, rank, of: total,
      drivers: [...(risk.contributors ?? [])].sort((a, b) => b.contribution - a.contribution).slice(0, 5).map(factorOf) },
    upstream: { status: upstream?.status ?? null, sections: (upstream?.sections ?? []).slice(0, 4).map(s => s.sectionLabel ?? s.sectionId),
      congestion: (entry.upstreamCongestion ?? []).map(e => e.id) },
    headline: insight?.headline ?? null,
    explanation: (insight?.sentences ?? insight?.lines ?? []).slice?.(0, 4) ?? null,
    mitigation: (mitigation ?? []).slice(0, 4).map(m => ({ action: m.text, basis: m.basis ?? null })),
    nearestUpstreamCamera: camera ? { id: camera.id, lon: round(camera.longitude), lat: round(camera.latitude) } : null,
    notEvaluated: [...(risk.unknownFactors ?? []), ...(risk.unavailableFactors ?? [])].map(f => f.label ?? f.type).filter((v, i, a) => a.indexOf(v) === i),
  };
}

/**
 * @param {{store: object, getLiveEvents?: () => Promise<object|null>, readLayer?: (file: string) => object|null,
 *   centerline?: {lon: number, lat: number}[], fetchImpl?: typeof fetch, now?: () => number}} deps
 */
export function createInsights({ store, getLiveEvents = null, readLayer = () => null, centerline = [], fetchImpl = globalThis.fetch, now = Date.now }) {
  let sections = null, cameras = null;
  const corridor = () => {
    sections ??= sectionsFromGeojson(readLayer('i595_fdot_traffic_segments.geojson'));
    cameras ??= camerasFromGeojson(readLayer('i595_corridor_cameras.geojson'));
    return { sections, cameras };
  };

  async function assessLive() {
    if (!getLiveEvents) return { gap: { type: 'not_ready', detail: 'Live events are not connected on this host.' } };
    const payload = await getLiveEvents();
    if (!payload) return { gap: { type: 'not_ready', detail: 'The live feed could not be read just now.' } };
    const { sections: s, cameras: c } = corridor();
    if (!s.length) return { gap: { type: 'not_ready', detail: 'The corridor sections could not be loaded.' } };
    const events = payload.events ?? [];
    return { assessed: assessCorridor(events, { sections: s, centerline, cameras: c, signs: [], now: now(), temporal: liveContext() }), events: events.length, asOf: payload.lastUpdated ?? null };
  }

  const historicalGap = temporal => (temporal?.mode === 'HISTORICAL'
    ? { gap: { type: 'not_ready', detail: `Historical replay (${temporal.date ?? 'a past date'}) is assessed on the TMC screen only for now; the twin's server assesses live incidents.` } } : null);

  /**
   * A recorded incident explained from the register: what happened, where, and how its FDOT section
   * compares with the corridor. The live TMC risk model needs live lane and upstream state, which a
   * past record does not carry, so this says plainly that it is a different, record-based view.
   * @returns {{output: object, source: string, summary: string} | null}  null when the id is not recorded
   */
  function explainRecorded(incidentId) {
    const result = store.rows('Florida I595 Incidents');
    if (result.gap) return null;
    const id = String(incidentId ?? '').trim();
    const record = result.records.find(r => r.key === id || String(r.incident_id ?? r.keyInSource ?? '') === id);
    if (!record) return null;
    const { sections: s } = corridor();
    const point = crashPoint(record);
    const section = point && s.length ? nearestSection(point, s) : null;
    const all = result.records;
    const { groups } = section ? groupBySection(all, s) : { groups: new Map() };
    const here = section ? groups.get(section.sectionLabel) : null;
    const wetShare = all.filter(r => WET.test(r.weather ?? '')).length / (all.length || 1);
    const ranked = [...groups.values()].sort((a, b) => b.crashes - a.crashes);
    const near = point ? all.filter(r => r !== record && crashPoint(r) && haversineMeters(point.lon, point.lat, crashPoint(r).lon, crashPoint(r).lat) <= 800).length : null;
    const pick = (...names) => { for (const n of names) if (record[n] !== undefined && record[n] !== null && record[n] !== '') return record[n]; return null; };
    const output = {
      asOf: result.asOf, basis: 'Recorded incident and its section history (crash register). Not the live TMC risk model, which needs live lane and upstream state.',
      incident: { id: record.key, date: pick('incident_date', '_at'), type: pick('incident_type'), weather: pick('weather'), lanesClosed: pick('lane_closure_y_n'),
        closureHours: pick('lane_closure_duration_hours'), injuries: pick('injuries_y_n'), fatalities: pick('fatalities'), rootCause: pick('root_cause_category', 'root_cause'),
        recommendedNextAction: pick('recommended_next_action'), section: section?.sectionLabel ?? null, lon: point ? round(point.lon) : null, lat: point ? round(point.lat) : null },
      section: here ? { crashes: here.crashes, wetCrashes: here.wet, laneClosureHours: round(here.closureHours, 1), injuryCrashes: here.injuries,
        rankOnCorridor: ranked.findIndex(g => g.segment === here.segment) + 1, of: ranked.length,
        wetShare: round(here.wet / here.crashes, 2), corridorWetShare: round(wetShare, 2) } : null,
      incidentsWithin800m: near,
      gaps: [
        ...(section ? [] : ['This record has no position on an FDOT section, so its section history is not shown.']),
        'Traffic volume and speed at the time are not in the twin.',
      ],
    };
    return { output, source: 'Twin insight · crash register (recorded incident)',
      summary: here ? `${record.key} · ${section.sectionLabel}: ${here.crashes} crashes on record (rank ${output.section.rankOnCorridor} of ${ranked.length})` : `${record.key} · recorded incident` };
  }

  const handlers = {
    async explain_incident({ incident_id, temporal } = {}) {
      // A past date, or an id from the crash register, is explained from the record.
      const recorded = explainRecorded(incident_id);
      if (temporal?.mode === 'HISTORICAL') return recorded ?? { output: historicalGap(temporal), source: null };
      const live = await assessLive();
      if (live.gap) return recorded ?? { output: live, source: null };
      const { ranked } = live.assessed;
      const at = ranked.findIndex(entry => String(entry.incident.id) === String(incident_id));
      if (at === -1) {
        if (recorded) return recorded;
        return { output: { gap: { type: 'not_ready', detail: `Incident ${incident_id} is not among the ${ranked.length} active incident(s) in the live feed now — it may have cleared, or the screen and the twin hold different snapshots.` } }, source: null };
      }
      const out = compactAssessment(ranked[at], at + 1, ranked.length);
      return { output: { asOf: live.asOf, eventsAssessed: live.events, ...out }, source: 'Twin insight · TMC risk model (live events)',
        summary: `${out.risk.level} · ${out.risk.score}/100 · rank ${at + 1} of ${ranked.length}` };
    },

    async rank_incidents({ temporal, limit } = {}) {
      const past = historicalGap(temporal);
      if (past) return { output: past, source: null };
      const live = await assessLive();
      if (live.gap) return { output: live, source: null };
      const { ranked } = live.assessed;
      const top = ranked.slice(0, Math.min(10, Math.max(1, Number(limit) || 5)));
      return {
        output: { asOf: live.asOf, activeIncidents: ranked.length, ranked: top.map((entry, i) => {
          const c = compactAssessment(entry, i + 1, ranked.length);
          return { rank: i + 1, id: c.incident.id, section: c.incident.section, score: c.risk.score, level: c.risk.level, lon: c.incident.lon, lat: c.incident.lat };
        }) },
        source: 'Twin insight · TMC risk model (live events)',
        summary: ranked.length ? `${ranked.length} active · top ${top[0].incident.id} at ${top[0].risk.score}/100` : 'no active incidents',
      };
    },

    crash_hotspots({ weather = 'any', limit } = {}) {
      const result = store.rows('Florida I595 Incidents');
      if (result.gap) return { output: result, source: null };
      const all = result.records;
      const wanted = weather === 'wet' ? all.filter(r => WET.test(r.weather ?? '')) : weather === 'dry' ? all.filter(r => !WET.test(r.weather ?? '')) : all;
      const { groups, unplaced } = groupBySection(wanted, corridor().sections);
      const rows = [...groups.values()].sort((a, b) => b.crashes - a.crashes || b.closureHours - a.closureHours).slice(0, Math.min(10, Math.max(1, Number(limit) || 5)));
      return {
        output: { asOf: result.asOf, weather, totalCrashes: wanted.length, hotspots: rows.map(r => ({ section: r.segment, crashes: r.crashes,
          wetCrashes: r.wet, laneClosureHours: round(r.closureHours, 1), injuryCrashes: r.injuries, lon: r.lon, lat: r.lat })),
          ...(unplaced ? { gaps: [`${unplaced} of ${wanted.length} crashes have no position within ${PLACE_WITHIN_M} m of an FDOT section and are not ranked.`] } : {}) },
        source: `Twin insight · crash register (${registerOrigin(store)})`,
        summary: rows.length ? `${rows[0].segment}: ${rows[0].crashes} crashes` : 'no crashes recorded',
      };
    },

    async weather_risk_forecast({ hours = 6 } = {}) {
      const span = Math.min(12, Math.max(1, Number(hours) || 6));
      const all = allIncidents(store);
      if (!all.length) return { output: { gap: { type: 'not_ready', detail: 'The crash register is not loaded.' } }, source: null };
      const mid = centerline[Math.floor(centerline.length / 2)] ?? { lon: -80.25, lat: 26.08 };
      const forecast = await fetchForecast(mid, span);
      const { groups, unplaced } = groupBySection(all, corridor().sections);
      const segments = [...groups.values()];
      const corridorWetShare = all.filter(r => WET.test(r.weather ?? '')).length / all.length;
      const ranked = segments.map(s => ({ section: s.segment, crashes: s.crashes, wetCrashes: s.wet, wetShare: round(s.wet / s.crashes, 2),
        // How much more of this segment's crash history is wet than the corridor's as a whole.
        wetSensitivity: corridorWetShare > 0 ? round((s.wet / s.crashes) / corridorWetShare, 2) : null, lon: s.lon, lat: s.lat }))
        .sort((a, b) => b.wetCrashes - a.wetCrashes || b.wetShare - a.wetShare);
      const gaps = ['Hourly traffic volume (exposure) is not in the twin, so these are shares of recorded crashes, not crash rates per vehicle.',
        'Upstream traffic speed is not available on this corridor.'];
      if (unplaced) gaps.push(`${unplaced} of ${all.length} recorded crashes have no position on an FDOT section and are not ranked.`);
      if (!forecast) gaps.unshift('The rain forecast could not be read just now.');
      const peak = forecast ? Math.max(...forecast.hours.map(h => h.rainProbability ?? 0)) : null;
      const top = ranked[0];
      const fires = forecast && peak >= PLAYBOOK_WX1.rainProbability && top && top.wetCrashes >= PLAYBOOK_WX1.minWetCrashes;
      const recommendation = fires ? {
        rule: PLAYBOOK_WX1.id, title: PLAYBOOK_WX1.title,
        action: `Pre-position a patrol at ${top.section} before the forecast rain (peak ${peak}% in the next ${span} h).`,
        basis: `${top.section} has the most wet-weather crashes on record (${top.wetCrashes} of ${top.crashes}); rule ${PLAYBOOK_WX1.id} fires at ≥ ${PLAYBOOK_WX1.rainProbability}% rain and ≥ ${PLAYBOOK_WX1.minWetCrashes} wet crashes.`,
        location: { lon: top.lon, lat: top.lat },
      } : null;
      return {
        output: {
          window: `next ${span} h`, forecast: forecast ? { point: forecast.point, peakRainProbability: peak, hours: forecast.hours } : null,
          baseline: { description: 'Do nothing: the corridor\'s recorded crash history', crashesOnRecord: all.length, corridorWetShare: round(corridorWetShare, 2) },
          segments: ranked.slice(0, 5), recommendation,
          ruleNotFired: fires ? null : `${PLAYBOOK_WX1.id} needs ≥ ${PLAYBOOK_WX1.rainProbability}% rain${forecast ? ` (forecast peak ${peak}%)` : ''} and a segment with ≥ ${PLAYBOOK_WX1.minWetCrashes} wet crashes.`,
          gaps,
        },
        source: `Twin insight · crash register (${registerOrigin(store)}) + Open-Meteo forecast`,
        summary: forecast ? `rain peak ${peak}% · ${fires ? `${PLAYBOOK_WX1.id} recommends a patrol at ${top.section}` : 'no playbook action'}` : 'forecast unavailable',
      };
    },
  };

  /** The next hours of rain at a point, or null when Open-Meteo does not answer. */
  async function fetchForecast(point, span) {
    const url = `${OPEN_METEO}?latitude=${point.lat}&longitude=${point.lon}&hourly=precipitation_probability,precipitation&forecast_hours=${span}&timezone=America%2FNew_York`;
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      const data = await response.json();
      const times = data?.hourly?.time ?? [];
      return { point: { lon: round(point.lon), lat: round(point.lat) }, hours: times.slice(0, span).map((time, i) => ({
        time, rainProbability: data.hourly.precipitation_probability?.[i] ?? null, precipitationMm: data.hourly.precipitation?.[i] ?? null })) };
    } catch {
      return null;
    }
  }

  return { definitions: INSIGHT_DEFINITIONS, handlers };
}

/** Where the crash register came from, for the source line: DataConnect once refreshed, else the snapshot. */
function registerOrigin(store) {
  const entry = store.classes().find(c => c.className === 'Florida I595 Incidents');
  return originOf(entry?.source) === 'historical' ? 'DataConnect' : 'DataConnect snapshot';
}

/** Every incident in the register; an empty list when the register is not loaded. */
function allIncidents(store) {
  const result = store.rows('Florida I595 Incidents');
  return result.gap ? [] : result.records;
}

/** A record's position: the store's indexed columns (any source), else the snapshot's own fields. */
const crashPoint = r => {
  const lon = Number(r._lon ?? r['x_coordinate (from asset)']), lat = Number(r._lat ?? r['y_coordinate (from asset)']);
  return r._lon !== null && Number.isFinite(lon) && Number.isFinite(lat) && lon && lat ? { lon, lat } : null;
};

/**
 * The FDOT section nearest a point (by its vertices), or null when none is within PLACE_WITHIN_M.
 * The register's own Segment field is only East/Central/West, too coarse to send a patrol to.
 */
export function nearestSection(point, sections) {
  let best = null;
  for (const section of sections) {
    for (const [lon, lat] of section.coordinates) {
      const d = haversineMeters(point.lon, point.lat, lon, lat);
      if (!best || d < best.d) best = { d, section };
    }
  }
  return best && best.d <= PLACE_WITHIN_M ? best.section : null;
}

/**
 * Crashes grouped by the FDOT section they happened on. Crashes with no position, or too far from
 * every section, are counted as unplaced rather than lumped into a pseudo-segment.
 */
export function groupBySection(rows, sections) {
  const groups = new Map();
  let unplaced = 0;
  for (const r of rows) {
    const point = crashPoint(r);
    const section = point ? nearestSection(point, sections) : null;
    if (!section) { unplaced++; continue; }
    const g = groups.get(section.sectionLabel) ?? { segment: section.sectionLabel, crashes: 0, wet: 0, closureHours: 0, injuries: 0,
      lon: null, lat: null, mid: section.coordinates[Math.floor(section.coordinates.length / 2)] };
    g.crashes += 1;
    if (WET.test(r.weather ?? '')) g.wet += 1;
    g.closureHours += Number(r.lane_closure_duration_hours) || 0;
    if (/^y/i.test(String(r.injuries_y_n ?? ''))) g.injuries += 1;
    groups.set(section.sectionLabel, g);
  }
  // The map target is the section's own midpoint, a point on the road, not an average of crashes.
  for (const g of groups.values()) { [g.lon, g.lat] = g.mid.map(v => round(v)); delete g.mid; }
  return { groups, unplaced };
}

export const INSIGHT_DEFINITIONS = Object.freeze([
  {
    name: 'explain_incident',
    description: 'Why an active incident has the secondary-incident risk it has: score, rank among active incidents, the factors driving it, upstream sections and congestion, recommended mitigation, nearest upstream camera, and what could not be evaluated. Computed by the TMC risk model the screen uses. For a recorded (past) incident id such as INC-200014, or in historical mode, it explains the record and its section\'s crash history instead.',
    input_schema: { type: 'object', required: ['incident_id'], properties: { incident_id: { type: 'string' },
      temporal: { type: 'object', properties: { mode: { type: 'string' }, date: { type: 'string' } } } } },
  },
  {
    name: 'rank_incidents',
    description: 'Active incidents ranked by secondary-incident risk, exactly as the TMC screen ranks them.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } } },
  },
  {
    name: 'crash_hotspots',
    description: 'Corridor segments ranked by recorded crashes (optionally only wet- or dry-weather crashes), with lane-closure hours, injury crashes and a map location for each.',
    input_schema: { type: 'object', properties: { weather: { type: 'string', enum: ['any', 'wet', 'dry'] }, limit: { type: 'integer', minimum: 1, maximum: 10 } } },
  },
  {
    name: 'weather_risk_forecast',
    description: 'Forecast scenario: rain probability over the next hours against each segment\'s wet-weather crash history, a do-nothing baseline, and the playbook recommendation (rule P-WX-1) for pre-positioning a patrol when it applies.',
    input_schema: { type: 'object', properties: { hours: { type: 'integer', minimum: 1, maximum: 12 } } },
  },
]);
