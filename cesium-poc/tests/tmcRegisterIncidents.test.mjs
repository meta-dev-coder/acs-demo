/**
 * The incident register as a TMC source.
 *
 * The register answers dates the live feed cannot reach — it goes back to May 2024 where the FL511
 * sync starts in late September 2026. What it does NOT carry is the operational context the
 * secondary-risk model is built around, and the danger these tests exist for is that absence being
 * quietly filled in: a 2025 crash must never be scored against congestion that was recorded in 2026,
 * and a register record that says "lanes were closed" must not become "two lanes blocked".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import {
  INCIDENT_SOURCES, nearestSection, registerCarriageway, registerIncident, registerIncidents,
  registerInstant, registerLaneImpact, registerSeverity,
} from '../src/tmc/registerIncidents.js';
import { laneImpactOf } from '../src/tmc/tmcIncidents.js';
import { assessSecondaryRisk } from '../src/tmc/secondaryIncidentRisk.js';
import { assessCorridor } from '../src/tmc/tmcService.js';
import { dateKeyOf, historicalDate } from '../src/tmc/temporalContext.js';

const GEO = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
const SECTIONS = GEO.features.map(f => {
  const p = f.properties;
  return {
    segmentId: p.segment_id,
    sectionId: `SECTION_${String(p.fdot_segment_index).padStart(2, '0')}`,
    sectionIndex: p.fdot_segment_index,
    sectionLabel: `${p.direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(p.fdot_segment_index).padStart(2, '0')}`,
    carriageway: p.direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL,
    travelOrder: p.travel_order,
    coordinates: f.geometry.coordinates,
  };
});

/** The real December record, as DataConnect publishes it. */
const DEC_18 = {
  id: 'INC-200101', longitude: -80.3321152, latitude: 26.1186123, locationSource: 'asset',
  raw: {
    attributes: {
      code: 'INC-200101', incident_type: 'Multi-vehicle crash', description: 'Multi-vehicle crash',
      incident_date: '18/12/2025 00:00', incident_time: '10:00',
      lane_closure_y_n: 'Yes', lane_closure_duration_hours: '5.0',
      injuries_y_n: 'Yes', hospitalizations: 'Yes', fatalities: 'No',
      weather: 'Storm Recovery', traffic_conditions: 'Heavy', vehicle_count: '3.0',
      police_report_number: 'PR-263778',
    },
  },
};

test('a register date and time become one corridor instant', () => {
  // Day-first, and the time of day lives in its own field. 10:00 in December is EST (UTC-5).
  assert.equal(registerInstant('18/12/2025 00:00', '10:00'), Date.parse('2025-12-18T15:00:00Z'));
  assert.equal(dateKeyOf(registerInstant('18/12/2025 00:00', '10:00')), '2025-12-18');
  // Midsummer is EDT, so the same wall-clock time is a different instant — read, not assumed.
  assert.equal(registerInstant('01/07/2025 00:00', '10:00'), Date.parse('2025-07-01T14:00:00Z'));
  // No time published is midnight, not "now".
  assert.equal(dateKeyOf(registerInstant('18/12/2025 00:00', '')), '2025-12-18');
  assert.equal(registerInstant('', '10:00'), null);
  assert.equal(registerInstant('not a date', '10:00'), null);
});

test('severity comes from the outcomes the register publishes, in severity order', () => {
  assert.equal(registerSeverity({ fatalities: 'Yes', injuries_y_n: 'Yes' }), 'Major');
  assert.equal(registerSeverity({ fatalities: 'No', hospitalizations: 'Yes' }), 'Intermediate');
  assert.equal(registerSeverity({ fatalities: 'No', injuries_y_n: 'Yes' }), 'Intermediate');
  assert.equal(registerSeverity({ fatalities: 'No', injuries_y_n: 'No' }), 'Minor');
  assert.equal(registerSeverity({}), 'Minor');
});

test('a stated closure of unknown size is neither a counted lane nor silence', () => {
  const stated = registerLaneImpact({ lane_closure_y_n: 'Yes' });
  assert.equal(stated.closureStated, true);
  assert.equal(stated.blockedLanes, null, 'the register never says how many');
  const impact = laneImpactOf({ liveOps: { laneImpact: stated } });
  assert.equal(impact.stated, true);
  assert.equal(impact.closureStated, true);
  assert.equal(impact.blockedLanes, null);

  // Scored as the floor it supports — one lane — and the wording says the count is unpublished.
  const risk = assessSecondaryRisk({ id: 'X', lanes: impact, severity: 'Minor', activeMinutes: 0 },
    { upstream: { status: 'UNRESOLVED' }, upstreamCongestion: [], impactLevel: null });
  const lane = risk.factors.find(f => f.type === 'LANE_CLOSURE');
  assert.equal(lane.present, true);
  assert.match(lane.detail, /not published/);
  assert.equal(lane.contribution, 18);

  // "No" is a real answer and must not score.
  const none = laneImpactOf({ liveOps: { laneImpact: registerLaneImpact({ lane_closure_y_n: 'No' }) } });
  assert.equal(none.stated, true);
  assert.equal(none.closureStated, false);
  // And a record that says nothing at all stays unstated.
  assert.equal(laneImpactOf({ liveOps: { laneImpact: registerLaneImpact({}) } }).stated, false);
});

test('direction comes from the register\'s own segment suffix, or not at all', () => {
  assert.equal(registerCarriageway('101E'), CARRIAGEWAYS.EB_GENERAL);
  assert.equal(registerCarriageway('103W'), CARRIAGEWAYS.WB_GENERAL);
  // "101" with no suffix states no direction, and a guess here would hand the upstream resolver a
  // carriageway the source never gave it.
  assert.equal(registerCarriageway('101'), null);
  assert.equal(registerCarriageway(''), null);
  assert.equal(registerCarriageway(null), null);
});

test('a section is only resolved once a direction is known', () => {
  const [lon, lat] = SECTIONS[0].coordinates[0];
  assert.equal(nearestSection(SECTIONS, lon, lat, null), null, 'no direction, no section');
  const eb = nearestSection(SECTIONS, lon, lat, CARRIAGEWAYS.EB_GENERAL);
  assert.equal(eb.carriageway, CARRIAGEWAYS.EB_GENERAL);
  const wb = nearestSection(SECTIONS, lon, lat, CARRIAGEWAYS.WB_GENERAL);
  assert.equal(wb.carriageway, CARRIAGEWAYS.WB_GENERAL, 'the other carriageway is never substituted');
});

test('the December multi-vehicle crash becomes an assessable incident', () => {
  const incident = registerIncident(DEC_18, { sections: SECTIONS });
  assert.equal(incident.id, 'INC-200101');
  assert.equal(incident.type, 'INCIDENT');
  assert.equal(incident.source, INCIDENT_SOURCES.REGISTER);
  assert.equal(incident.title, 'Multi-vehicle crash');
  assert.equal(incident.severity, 'Intermediate', 'injuries and hospitalisations, no fatality');
  assert.equal(dateKeyOf(Date.parse(incident.sdna.reported_at)), '2025-12-18');
  // The five-hour closure the register recorded is how long the corridor was affected.
  assert.equal(Date.parse(incident.clearedAt) - Date.parse(incident.sdna.reported_at), 5 * 3_600_000);
  // The position is the damaged asset's, and says so rather than passing as a surveyed fix.
  assert.equal(incident.liveOps.spatialMatch.confidence, 'LOW');
  assert.equal(incident.liveOps.spatialMatch.basis, 'damaged asset');
  // No segment suffix on this record, so no direction is claimed.
  assert.equal(incident.liveOps.carriageway, CARRIAGEWAYS.UNKNOWN);
  assert.equal(incident.liveOps.sectionId, null);
});

test('a record with no date or no position is left out rather than placed at zero', () => {
  const undated = { ...DEC_18, raw: { attributes: { ...DEC_18.raw.attributes, incident_date: '' } } };
  assert.equal(registerIncident(undated, { sections: SECTIONS }), null);
  const unplaced = { ...DEC_18, longitude: null, latitude: null };
  assert.equal(registerIncident(unplaced, { sections: SECTIONS }), null);
  assert.equal(registerIncidents([undated, unplaced, DEC_18], { sections: SECTIONS }).length, 1);
});

test('a register date is assessed, and never against conditions from another year', () => {
  const live2026 = {
    id: 'FL511-CON-1', type: 'CONGESTION', severity: 'Minor', cleared: true,
    longitude: -80.3321, latitude: 26.1186,
    sdna: { reported_at: '2026-10-01T10:00:00Z', cleared_at_dt: '2026-10-01T11:00:00Z' },
    liveOps: { carriageway: CARRIAGEWAYS.EB_GENERAL, sectionId: 'SECTION_04', sectionIndex: 4,
      spatialMatch: { confidence: 'HIGH' }, laneImpact: { source: 'none' } },
  };
  const events = [...registerIncidents([DEC_18], { sections: SECTIONS }), live2026];
  const day = assessCorridor(events, {
    sections: SECTIONS, centerline: [], cameras: [], signs: [],
    now: Date.parse('2026-10-05T12:00:00Z'), temporal: historicalDate('2025-12-18'),
  });
  assert.equal(day.counts.activeIncidents, 1);
  assert.equal(day.assessments[0].incident.id, 'INC-200101');
  assert.equal(day.assessments[0].upstreamCongestion.length, 0, 'nothing from 2026 reaches a 2025 date');
  // Anchored to its own time, not to the day or to now.
  assert.equal(day.assessments[0].moment.at, Date.parse('2025-12-18T15:00:00Z'));
  // Upstream cannot be resolved without a direction, and the risk reports that rather than scoring it.
  const congestion = day.assessments[0].risk.factors.find(f => f.type === 'UPSTREAM_CONGESTION');
  assert.equal(congestion.present, false);
});

test('a past incident has a duration, not an age', () => {
  // It read "Active 418,584 min" — the minutes since December 2025, which is true of the clock and
  // nonsense about a crash that was cleared in five hours.
  const day = assessCorridor(registerIncidents([DEC_18], { sections: SECTIONS }), {
    sections: SECTIONS, centerline: [], cameras: [], signs: [],
    now: Date.parse('2026-10-05T12:00:00Z'), temporal: historicalDate('2025-12-18'),
  });
  assert.equal(day.incidents[0].activeMinutes, 300, 'the five hours the register recorded');
  const duration = day.assessments[0].risk.factors.find(f => f.type === 'INCIDENT_DURATION');
  assert.match(duration.detail, /300 min/);
});
