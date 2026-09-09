import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffLiveEvents, formatMeters, liveEventAssociationRows, liveEventLabel,
  LIVE_EVENT_SOURCE_STATUS, liveEventNotice, liveEventSourceRows, liveEventStatusText, liveEventTooltip,
} from '../src/liveEventsData.js';

// Shaped exactly as GET /api/i595/live-events returns it for real FL511 closure 845752.
const enriched = {
  id: 'FL511-CLOSURE-845752', source: 'FL511', type: 'CLOSURE',
  latitude: 26.085906, longitude: -80.169425,
  title: 'Closure',
  description: 'Planned construction in Broward County on 95 Express South, ramp from I-595 Mainline/Tpk/US-441. On-ramp closed.',
  severity: 'Major', region: 'Southeast', startTime: 'Sep 8 2026, 9:15 PM', lastUpdated: 'Sep 8 2026, 9:15 PM',
  detailsAvailable: true,
  detailFields: [{ label: 'Severity', value: 'Major' }, { label: 'Region', value: 'Southeast' },
    { label: 'Start Time', value: 'Sep 8 2026, 9:15 PM' }, { label: 'Last Updated', value: 'Sep 8 2026, 9:15 PM' }],
  distanceToI595NetworkM: 15.1, nearestFacility: 'RAMP_CONNECTOR', nearestFacilityLabel: 'I-595 Ramp / Connector',
  distanceToNearestFacilityM: 15.1, nearestSegmentId: null, nearestSegmentLabel: null, distanceToSegmentM: null,
  rawSourceId: '845752',
};
// The same event before enrichment: mapIcons gave a position and an id, nothing else.
const bare = {
  id: 'FL511-INCIDENT-845391', source: 'FL511', type: 'INCIDENT', latitude: 26.1, longitude: -80.2,
  detailsAvailable: false, detailFields: [], distanceToI595NetworkM: 82, nearestFacility: 'I595_EB',
  nearestFacilityLabel: 'I-595 Eastbound', distanceToNearestFacilityM: 82, nearestSegmentId: null,
  nearestSegmentLabel: null, distanceToSegmentM: null, rawSourceId: '845391',
};
const label = (rows, name) => rows.find(([key]) => key === name)?.[1];

test('source rows carry FL511 values only', () => {
  const rows = liveEventSourceRows(enriched);
  assert.equal(label(rows, 'Type'), 'Closure');
  assert.equal(label(rows, 'Severity'), 'Major');
  assert.equal(label(rows, 'Started'), 'Sep 8 2026, 9:15 PM');
  assert.equal(label(rows, 'Source'), 'FL511');
  assert.equal(label(rows, 'FL511 Event ID'), '845752');
  assert.equal(label(rows, 'Location'), '26.085906, -80.169425');
  // Not published by FL511 → no row at all, rather than a placeholder.
  for (const missing of ['Road', 'Direction', 'Lanes Blocked', 'Ends', 'Status', 'Detour']) {
    assert.equal(label(rows, missing), undefined, `${missing} must not be invented`);
  }
  // Derived association never appears among source rows.
  assert.equal(label(rows, 'Nearest Facility'), undefined);
});

test('an unenriched event shows only what mapIcons gave', () => {
  const rows = liveEventSourceRows(bare);
  assert.deepEqual(rows.map(([key]) => key), ['Type', 'Location', 'Source', 'FL511 Event ID']);
});

test('extra FL511 rows are passed through once, never duplicated', () => {
  const rows = liveEventSourceRows({ ...enriched, detailFields: [...enriched.detailFields, { label: 'Detour', value: 'Use US-441' }, { label: 'Contact', value: 'District 4' }] });
  assert.equal(rows.filter(([key]) => key === 'Severity').length, 1);
  assert.equal(label(rows, 'Contact'), 'District 4');
});

test('association rows are separate and omit unresolved segments', () => {
  const rows = liveEventAssociationRows(enriched);
  assert.equal(label(rows, 'Nearest Facility'), 'I-595 Ramp / Connector');
  assert.equal(label(rows, 'Distance'), '15 m');
  assert.equal(label(rows, 'Nearest Segment'), undefined, 'a ramp event belongs to no FDOT section');
  const onMainline = liveEventAssociationRows({ ...enriched, nearestSegmentId: 'I595-EB-FDOT-006680-007350', nearestSegmentLabel: 'Eastbound Segment 4', distanceToSegmentM: 23.4 });
  assert.equal(label(onMainline, 'Nearest Segment'), 'Eastbound Segment 4');
  assert.equal(label(onMainline, 'Segment Distance'), '23 m');
});

test('tooltip uses FL511 words when present and stays factual when not', () => {
  assert.equal(liveEventTooltip(enriched),
    `Closure\n${enriched.description}\nFL511 Event 845752`);
  assert.equal(liveEventTooltip(bare), 'Incident\nFL511 Event 845391');
  const long = liveEventTooltip({ ...enriched, description: 'x'.repeat(400) });
  assert.ok(long.split('\n')[1].length <= 180);
  assert.equal(liveEventLabel({ type: 'INCIDENT' }), 'Incident');
});

test('status text states freshness rather than implying an empty corridor', () => {
  assert.equal(liveEventStatusText({ sourceStatus: 'LIVE', bufferMeters: 250, counts: { total: 2 } }), '2 live events within 250 m · live');
  assert.equal(liveEventStatusText({ sourceStatus: 'LIVE', bufferMeters: 250, counts: { total: 1 } }), '1 live event within 250 m · live');
  assert.match(liveEventStatusText({ sourceStatus: 'STALE', bufferMeters: 250, counts: { total: 2 }, dataFreshness: { ageSeconds: 600 } }), /cached data from 10 min ago/);
  assert.match(liveEventStatusText({ sourceStatus: 'UNAVAILABLE', counts: { total: 0 } }), /FL511 unavailable/);
  assert.equal(formatMeters(null), null);
  assert.equal(formatMeters(2400), '2.4 km');
});

test('a stopped service is not described as an empty corridor', () => {
  // Markers from an earlier response are still on screen: the wording must match what is visible.
  const holding = { sourceStatus: 'SERVICE_UNREACHABLE', counts: { total: 2 }, dataFreshness: { ageSeconds: 300 }, endpoint: '/api/i595/live-events' };
  assert.equal(liveEventStatusText(holding), 'Live-event service unreachable · still showing 2 events from 5 min ago');
  assert.match(liveEventNotice(holding), /cannot reach \/api\/i595\/live-events\. The events shown were received from 5 min ago and are no longer updating\./);
  const empty = { sourceStatus: 'SERVICE_UNREACHABLE', counts: { total: 0 }, dataFreshness: { ageSeconds: null } };
  assert.equal(liveEventStatusText(empty), 'Live-event service unreachable — no FL511 data received yet.');
  assert.match(liveEventNotice(empty), /so no FL511 data has been received/);
});

test('each source condition gets its own notice, and a healthy one gets none', () => {
  assert.equal(liveEventNotice({ sourceStatus: 'LIVE', counts: { total: 2 } }), null);
  // Cached FL511 data must never be reported as a service that is not running.
  const stale = liveEventNotice({ sourceStatus: 'STALE', counts: { total: 2 }, dataFreshness: { ageSeconds: 600 } });
  assert.match(stale, /^FL511 is not responding; showing the last successful update from 10 min ago\.$/);
  assert.ok(!/not running|unreachable/.test(stale));
  const unavailable = liveEventNotice({ sourceStatus: 'UNAVAILABLE', counts: { total: 0 } });
  assert.match(unavailable, /service is running but has not retrieved any FL511 data yet/);
  assert.deepEqual(Object.keys(LIVE_EVENT_SOURCE_STATUS), ['LIVE', 'STALE', 'UNAVAILABLE', 'SERVICE_UNREACHABLE']);
});

test('refreshes diff by FL511 id so entities are reused', () => {
  const moved = { ...enriched, latitude: 26.086 };
  const other = { ...bare, id: 'FL511-INCIDENT-999' };
  const diff = diffLiveEvents([enriched, bare], [moved, other]);
  assert.deepEqual(diff.added.map(event => event.id), ['FL511-INCIDENT-999']);
  assert.deepEqual(diff.updated.map(event => event.id), ['FL511-CLOSURE-845752']);
  assert.deepEqual(diff.removed, ['FL511-INCIDENT-845391']);
});

test('an unchanged event is not reported as updated', () => {
  const diff = diffLiveEvents([enriched], [{ ...enriched }]);
  assert.deepEqual([diff.added, diff.updated, diff.removed], [[], [], []]);
  // A changed FL511 detail is a real update.
  assert.equal(diffLiveEvents([enriched], [{ ...enriched, severity: 'Minor' }]).updated.length, 1);
});
