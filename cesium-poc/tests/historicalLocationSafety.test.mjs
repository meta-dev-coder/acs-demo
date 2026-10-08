/**
 * Historical location safety.
 *
 * The register is an operational and asset-damage record with some crash attributes, not an official
 * crash report: `root_cause` is empty on all 178 records. So the danger here is not a crash — it is
 * a screen that quietly turns a count into a cause, or reads crashes from after the incident it is
 * explaining. These tests exist mostly to prove neither can happen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import {
  analysisWindow, analyzeHistoricalLocation, corridorBaseline, crashesNear, isConfirmedCrashRecord,
  LOCATION_SOURCES, MATCH_CONFIDENCE,
} from '../src/tmc/historicalLocationSafety.js';
import { HISTORICAL_SAFETY_CONFIG, concentrationLevelFor, timeBucketFor } from '../src/tmc/historicalSafetyConfig.js';

// 17:00 corridor time. June, so daylight saving is in force throughout and the arithmetic below
// needs one offset rather than two.
const AT = Date.parse('2026-06-01T21:00:00Z');
const DAY = 86_400_000;
const EDT_OFFSET_HOURS = 4;
/** A straight east-west centreline running THROUGH the test location, about 4 km of it. */
const CENTERLINE = Array.from({ length: 81 }, (_, i) => [-80.22 + i * 0.0005, 26.10]);

/** Metres east of the anchor, as a longitude. */
const east = metres => -80.20 + metres / (111_320 * Math.cos(26.10 * Math.PI / 180));

const crash = ({ id, metresEast = 0, daysBefore = 10, type = 'Rear-end crash', cause = 'Driver behavior',
  weather = 'Clear', fatal = 'No', hosp = 'No', injury = 'No', carriageway = null, hour = null } = {}) => {
  let at = AT - daysBefore * DAY;
  if (hour != null) { const d = new Date(at); d.setUTCHours(hour + EDT_OFFSET_HOURS); at = d.getTime(); }
  return {
    id, type: 'INCIDENT', title: type, longitude: east(metresEast), latitude: 26.10,
    reportedAtMs: at,
    sdna: { reported_at: new Date(at).toISOString() },
    liveOps: carriageway ? { carriageway } : {},
    raw: { attributes: { incident_type: type, root_cause_category: cause, weather, fatalities: fatal, hospitalizations: hosp, injuries_y_n: injury } },
  };
};

const selected = (over = {}) => ({
  id: 'SEL', longitude: east(0), latitude: 26.10, reportedAtMs: AT,
  sdna: { reported_at: new Date(AT).toISOString() }, liveOps: {}, raw: { attributes: {} }, ...over,
});

const analyse = (records, over = {}) => analyzeHistoricalLocation({
  selectedIncident: selected(over.selected), historicalCrashes: records, centerline: CENTERLINE, ...over,
});

test('the search radius is honoured, and is configurable', () => {
  const records = [crash({ id: 'A', metresEast: 50 }), crash({ id: 'B', metresEast: 200 }), crash({ id: 'C', metresEast: 400 })];
  const at = { radiusMeters: 100 };
  assert.deepEqual(crashesNear(selected(), records, at).map(m => m.record.id), ['A']);
  assert.deepEqual(crashesNear(selected(), records, { radiusMeters: 250 }).map(m => m.record.id), ['A', 'B']);
  assert.deepEqual(crashesNear(selected(), records, { radiusMeters: 500 }).map(m => m.record.id), ['A', 'B', 'C']);
  // The bands the UI offers are the ones the service accepts.
  assert.deepEqual(HISTORICAL_SAFETY_CONFIG.radiusBandsMeters, [100, 250, 500]);
  // Nearest first, with the distance carried.
  assert.deepEqual(crashesNear(selected(), records, { radiusMeters: 500 }).map(m => m.metres), [50, 200, 400]);
});

test('a crash on the other carriageway is excluded only when BOTH sides state one', () => {
  const eb = selected({ liveOps: { carriageway: CARRIAGEWAYS.EB_GENERAL } });
  const records = [
    crash({ id: 'EB-near', metresEast: 60, carriageway: CARRIAGEWAYS.EB_GENERAL }),
    crash({ id: 'WB-nearer', metresEast: 20, carriageway: CARRIAGEWAYS.WB_GENERAL }),
    crash({ id: 'UNKNOWN-way', metresEast: 40 }),
  ];
  const matched = crashesNear(eb, records, { radiusMeters: 250 });
  assert.ok(!matched.some(m => m.record.id === 'WB-nearer'), 'closer, but on the other carriageway');
  assert.deepEqual(matched.map(m => m.record.id).sort(), ['EB-near', 'UNKNOWN-way']);
  // A record that states no carriageway is kept, but never claimed as a carriageway match.
  assert.equal(matched.find(m => m.record.id === 'EB-near').matchConfidence, MATCH_CONFIDENCE.CARRIAGEWAY);
  assert.equal(matched.find(m => m.record.id === 'UNKNOWN-way').matchConfidence, MATCH_CONFIDENCE.LOCATION);
});

test('an unresolved carriageway does not stop the analysis, it limits the claim', () => {
  const records = [crash({ id: 'A', metresEast: 50, carriageway: CARRIAGEWAYS.EB_GENERAL }),
    crash({ id: 'B', metresEast: 80, carriageway: CARRIAGEWAYS.WB_GENERAL }),
    crash({ id: 'C', metresEast: 90 })];
  const result = analyse(records);
  assert.equal(result.available, true, 'coordinates are enough to analyse a location');
  assert.equal(result.totals.crashes, 3, 'nothing is excluded when the incident states no carriageway');
  assert.equal(result.matchBasis.mode, MATCH_CONFIDENCE.LOCATION);
  assert.equal(result.matchBasis.label, 'Location-based only');
  assert.equal(result.matchBasis.confidence, 'MEDIUM');
  assert.match(result.matchBasis.reason, /carriageway could not be resolved/i);
});

test('the selected incident is never part of its own location history', () => {
  // The register contains the selected incident itself; counting it would turn one crash into
  // "1 previous crash at this location".
  const records = [{ ...crash({ id: 'SEL', metresEast: 0, daysBefore: 0 }), id: 'SEL' }, crash({ id: 'OTHER', metresEast: 30 })];
  const result = analyse(records);
  assert.deepEqual(result.matches.map(m => m.record.id), ['OTHER']);
  assert.equal(result.totals.crashes, 1);
});

test('crashes after the selected incident are never used', () => {
  // Look-ahead leakage: explaining a 1 March incident with a 2 March crash would judge an operator
  // on information nobody had.
  const records = [
    crash({ id: 'before', metresEast: 30, daysBefore: 5 }),
    crash({ id: 'after', metresEast: 30, daysBefore: -1 }),
    crash({ id: 'same-instant', metresEast: 30, daysBefore: 0 }),
  ];
  const result = analyse(records);
  assert.deepEqual(result.matches.map(m => m.record.id), ['before']);
  assert.ok(result.analysisWindow.endMs <= AT);
});

test('the lookback is configurable and excludes what falls outside it', () => {
  const records = [crash({ id: 'recent', metresEast: 30, daysBefore: 30 }), crash({ id: 'old', metresEast: 30, daysBefore: 400 })];
  assert.deepEqual(analyse(records).matches.map(m => m.record.id), ['recent'], '12 months by default');
  assert.deepEqual(analyse(records, { lookbackMonths: 24 }).matches.map(m => m.record.id).sort(), ['old', 'recent']);
  const window = analysisWindow(AT, { lookbackMonths: 12 });
  assert.equal(window.endMs, AT);
  assert.ok(window.startMs < AT);
});

test('the corridor baseline is same-sized windows, not a whole section', () => {
  // Twelve crashes piled at one spot, three spread elsewhere: a typical window holds few.
  const cluster = Array.from({ length: 12 }, (_, i) => crash({ id: `C${i}`, metresEast: 10 + i }));
  const spread = [crash({ id: 'S1', metresEast: 900 }), crash({ id: 'S2', metresEast: 1400 }), crash({ id: 'S3', metresEast: 1800 })];
  const baseline = corridorBaseline([...cluster, ...spread], CENTERLINE, { radiusMeters: 250 });
  assert.ok(Number.isFinite(baseline.value), 'a baseline was formed');
  assert.ok(baseline.value < 12, `a typical window (${baseline.value}) is smaller than the cluster`);
  assert.ok(baseline.windows >= HISTORICAL_SAFETY_CONFIG.baseline.minimumWindows);
});

test('concentration is a ratio against that baseline, banded from config', () => {
  const cluster = Array.from({ length: 12 }, (_, i) => crash({ id: `C${i}`, metresEast: 10 + i }));
  const spread = [crash({ id: 'S1', metresEast: 900 }), crash({ id: 'S2', metresEast: 1400 }), crash({ id: 'S3', metresEast: 1800 })];
  const result = analyse([...cluster, ...spread]);
  assert.equal(result.concentration.localValue, 12);
  assert.ok(result.concentration.corridorBaseline > 0);
  assert.equal(result.concentration.ratio, Math.round((12 / result.concentration.corridorBaseline) * 10) / 10);
  assert.equal(result.concentration.level, concentrationLevelFor(result.concentration.ratio).id);
  assert.ok(['ELEVATED', 'HIGH', 'VERY_HIGH'].includes(result.concentration.level));
});

test('too few nearby crashes is UNKNOWN, not NORMAL', () => {
  // Two crashes is not evidence that a location is safe, and must not be banded as if it were.
  const result = analyse([crash({ id: 'A', metresEast: 30 }), crash({ id: 'B', metresEast: 40 })]);
  assert.equal(result.totals.crashes, 2);
  assert.equal(result.concentration.level, 'UNKNOWN');
  assert.match(result.concentration.reason, /too few/i);
});

test('patterns are counted out of what states the field, and sorted', () => {
  const records = [
    ...Array.from({ length: 5 }, (_, i) => crash({ id: `R${i}`, metresEast: 20 + i, type: 'Rear-end crash', cause: 'Driver behavior' })),
    ...Array.from({ length: 3 }, (_, i) => crash({ id: `S${i}`, metresEast: 30 + i, type: 'Sideswipe merge conflict', cause: 'Environmental' })),
  ];
  const result = analyse(records);
  assert.equal(result.crashTypes[0].value, 'Rear-end crash');
  assert.equal(result.crashTypes[0].count, 5);
  assert.equal(result.crashTypes[0].of, 8);
  assert.ok(Math.abs(result.crashTypes[0].share - 5 / 8) < 1e-9);
  assert.equal(result.contributingFactors[0].value, 'Driver behavior');
});

test('severity is counted from the register\'s own outcome fields', () => {
  const records = [
    crash({ id: 'A', metresEast: 20, fatal: 'Yes', hosp: 'Yes', injury: 'Yes' }),
    crash({ id: 'B', metresEast: 25, hosp: 'Yes', injury: 'Yes' }),
    crash({ id: 'C', metresEast: 30, injury: 'Yes' }),
    crash({ id: 'D', metresEast: 35 }),
  ];
  const result = analyse(records);
  assert.equal(result.totals.crashes, 4);
  assert.equal(result.totals.fatalCrashes, 1);
  assert.equal(result.totals.severeCrashes, 2, 'hospitalisation or fatality');
  assert.equal(result.totals.injuryCrashes, 3);
});

test('time of day is bucketed, and the incident is placed in a bucket', () => {
  assert.equal(timeBucketFor(17).id, 'PM_PEAK');
  assert.equal(timeBucketFor(3).id, 'OVERNIGHT');
  assert.equal(timeBucketFor(25), null);
  const records = Array.from({ length: 5 }, (_, i) => crash({ id: `P${i}`, metresEast: 20 + i, hour: 17 }));
  const result = analyse(records);
  assert.equal(result.timePatterns[0].value, 'PM peak');
  assert.equal(result.selectedTimeBucket.label, 'PM peak', 'the incident itself is at 17:00 EDT');
  assert.equal(result.selectedTimeBucket.isMostCommon, true);
});

test('a field no record states produces no pattern rather than an empty category', () => {
  const records = Array.from({ length: 4 }, (_, i) => crash({ id: `N${i}`, metresEast: 20 + i, cause: '', weather: '' }));
  const result = analyse(records);
  assert.deepEqual(result.contributingFactors, []);
  assert.deepEqual(result.weatherPatterns, []);
  assert.ok(result.dataQuality.unavailableFields.includes('Contributing circumstance'));
  // The reported cause is unavailable on every record in the connected register, always.
  assert.ok(result.dataQuality.unavailableFields.includes('Reported cause'));
});

test('no nearby crashes is an honest zero, not an error', () => {
  const result = analyse([crash({ id: 'far', metresEast: 5_000 })]);
  assert.equal(result.available, true);
  assert.equal(result.totals.crashes, 0);
  assert.equal(result.concentration.level, 'UNKNOWN');
  assert.equal(result.dataQuality.confidence, 'LOW');
});

test('an unusable incident or an absent register is reported, never guessed', () => {
  assert.equal(analyzeHistoricalLocation({ selectedIncident: { id: 'x' }, historicalCrashes: [crash({ id: 'a' })] }).available, false);
  assert.match(analyzeHistoricalLocation({ selectedIncident: { id: 'x' }, historicalCrashes: [] }).reason, /coordinates/i);
  const noRegister = analyse([]);
  assert.equal(noRegister.available, false);
  assert.match(noRegister.reason, /No historical crash records/i);
  assert.equal(noRegister.concentration.level, 'UNKNOWN');
  const undated = analyzeHistoricalLocation({ selectedIncident: { id: 'x', longitude: -80.2, latitude: 26.1 }, historicalCrashes: [crash({ id: 'a' })] });
  assert.equal(undated.available, false);
  assert.match(undated.reason, /timestamp/i);
});

test('the corridor is accepted in every shape the application carries it in', () => {
  // {lon, lat} is what i595Demo passes, [lon, lat] is GeoJSON, {longitude, latitude} is the event
  // model. Reading only one silently produced "no corridor centreline available" and left every
  // concentration UNKNOWN.
  const records = [
    ...Array.from({ length: 12 }, (_, i) => crash({ id: `C${i}`, metresEast: 10 + i })),
    ...[600, 900, 1200, 1500, 1800].map((m, i) => crash({ id: `S${i}`, metresEast: m })),
  ];
  const asLonLat = CENTERLINE.map(([lon, lat]) => ({ lon, lat }));
  const asLongLat = CENTERLINE.map(([lon, lat]) => ({ longitude: lon, latitude: lat }));
  for (const [name, line] of [['array', CENTERLINE], ['lon/lat', asLonLat], ['longitude/latitude', asLongLat]]) {
    const baseline = corridorBaseline(records, line, { radiusMeters: 250 });
    assert.ok(Number.isFinite(baseline.value), `${name} produced a baseline`);
  }
});

// ── Spatial provenance ─────────────────────────────────────────────────────────────────────────
// The register publishes no geometry of its own: every position is the damaged asset's. These tests
// exist so that fact can never be lost between the data and the screen.

const assetCrash = (over = {}) => {
  const base = crash(over);
  return { ...base, liveOps: { ...base.liveOps, spatialMatch: { confidence: 'LOW', basis: 'damaged asset' } } };
};

test('asset-derived positions are reported as such, with low spatial confidence', () => {
  const records = Array.from({ length: 6 }, (_, i) => assetCrash({ id: `A${i}`, metresEast: 20 + i }));
  const result = analyzeHistoricalLocation({
    selectedIncident: { ...selected(), liveOps: { spatialMatch: { confidence: 'LOW', basis: 'damaged asset' } } },
    historicalCrashes: records, centerline: CENTERLINE,
  });
  assert.equal(result.provenance.locationSource, LOCATION_SOURCES.ASSET);
  assert.equal(result.provenance.locationSourceLabel, 'Damaged asset location');
  assert.equal(result.provenance.spatialConfidence, 'LOW');
  assert.equal(result.provenance.surveyedCrashGeometry, false);
});

test('records without a police report number are incidents, not crashes', () => {
  const mixed = [
    ...Array.from({ length: 3 }, (_, i) => assetCrash({ id: `P${i}`, metresEast: 20 + i })),
    ...Array.from({ length: 3 }, (_, i) => assetCrash({ id: `N${i}`, metresEast: 30 + i })),
  ];
  // Only the first three carry an official report number.
  for (let i = 0; i < 3; i += 1) mixed[i].raw.attributes.police_report_number = `PR-${i}`;
  const result = analyzeHistoricalLocation({ selectedIncident: selected(), historicalCrashes: mixed, centerline: CENTERLINE });
  assert.equal(result.provenance.confirmedCrashRecords, 3);
  assert.equal(result.provenance.totalRecords, 6);
  assert.equal(result.provenance.recordNoun, 'historical incidents', 'not all confirmed, so not called crashes');
  assert.equal(isConfirmedCrashRecord(mixed[0]), true);
  assert.equal(isConfirmedCrashRecord(mixed[5]), false);
});

test('only an all-confirmed, record-located set may be called crashes', () => {
  const records = Array.from({ length: 4 }, (_, i) => {
    const c = crash({ id: `C${i}`, metresEast: 20 + i });
    c.raw.attributes.police_report_number = `PR-${i}`;
    c.liveOps = { spatialMatch: { confidence: 'HIGH', basis: 'record' } };
    return c;
  });
  const result = analyzeHistoricalLocation({
    selectedIncident: { ...selected(), liveOps: { spatialMatch: { confidence: 'HIGH', basis: 'record' } } },
    historicalCrashes: records, centerline: CENTERLINE,
  });
  assert.equal(result.provenance.recordNoun, 'crashes');
  assert.equal(result.provenance.locationSource, LOCATION_SOURCES.RECORD);
  assert.equal(result.provenance.spatialConfidence, 'HIGH');
  assert.equal(result.provenance.surveyedCrashGeometry, true);
});

test('one asset-derived record is enough to stop the whole set reading as surveyed', () => {
  const records = [
    ...Array.from({ length: 3 }, (_, i) => {
      const c = crash({ id: `R${i}`, metresEast: 20 + i });
      c.liveOps = { spatialMatch: { confidence: 'HIGH', basis: 'record' } };
      return c;
    }),
    assetCrash({ id: 'ASSET', metresEast: 40 }),
  ];
  const result = analyzeHistoricalLocation({
    selectedIncident: { ...selected(), liveOps: { spatialMatch: { confidence: 'HIGH', basis: 'record' } } },
    historicalCrashes: records, centerline: CENTERLINE,
  });
  assert.equal(result.provenance.locationSource, LOCATION_SOURCES.ASSET, 'the weakest source wins');
  assert.equal(result.provenance.spatialConfidence, 'LOW');
  assert.equal(result.provenance.surveyedCrashGeometry, false);
});
