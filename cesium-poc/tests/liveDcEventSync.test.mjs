import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadI595Network } from '../server/i595Network.mjs';
import { attachDetails, enrichForLiveOps, normalizeEvent } from '../server/liveEvents.mjs';
import {
  LIVE_CLASS, PROJECT_CODE, fromCurated, liveClassDefinition, unknownAttributes, validateRecord,
} from '../server/liveDc/classes.mjs';
import {
  DETAIL_ATTRIBUTES, TYPE_LABELS, TYPE_PRIORITY, canClear, liveEventKey, mapEventToRecord, syncLiveEvents,
} from '../server/liveDc/eventSync.mjs';

const network = await loadI595Network(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data'));
const OPTIONS = { bufferMeters: 250, segmentToleranceMeters: 120 };
const EVENTS_DEF = liveClassDefinition(LIVE_CLASS.EVENTS);

const RAMP_CLOSURE = { itemId: '845752', latitude: 26.085906, longitude: -80.169425 };
const DAVIE_INCIDENT = { itemId: '868702', latitude: 26.093417, longitude: -80.226583 };
const DAVIE_DETAIL = {
  title: 'Incident',
  description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.',
  fields: [{ label: 'Severity', value: 'Major' }, { label: 'Start Time', value: 'Sep 25 2026, 7:55 AM' }],
};

const T0 = Date.parse('2026-09-25T12:00:00Z');
const iso = ms => new Date(ms).toISOString();

function build(item, type, detail = null) {
  const event = normalizeEvent(item, type, network, OPTIONS);
  assert.ok(event, `${item.itemId} is inside the corridor buffer`);
  return enrichForLiveOps(attachDetails(event, detail), network, { sectionToleranceMeters: 120 });
}

const davie = (type = 'INCIDENT', detail = DAVIE_DETAIL) => build(DAVIE_INCIDENT, type, detail);
const ramp = () => build(RAMP_CLOSURE, 'CLOSURE');

const healthyFeeds = () => ({
  incidents: { error: null }, closures: { error: null }, construction: { error: null },
  congestion: { error: null }, disabledVehicles: { error: null },
});
const livePayload = events => ({ sourceStatus: 'LIVE', events, diagnostics: { lastError: null, feeds: healthyFeeds() } });

const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

// Curated reads omit '' values; the stand-in in merge mode keeps omitted keys.
const stripEmpty = rec => Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== '' && v != null));
const applyReplace = (existing, upserts) => {
  const map = new Map(existing.map(r => [r.keyInSource, r]));
  for (const u of upserts) map.set(u.keyInSource, stripEmpty(u));
  return [...map.values()];
};
const applyMerge = (existing, upserts) => {
  const raw = new Map(existing.map(r => [r.keyInSource, r]));
  for (const u of upserts) raw.set(u.keyInSource, { ...(raw.get(u.keyInSource) ?? {}), ...u });
  return [...raw.values()].map(stripEmpty);
};

// ---- constants --------------------------------------------------------------------------------

test('constants are frozen and complete', () => {
  assert.deepEqual([...TYPE_PRIORITY], ['INCIDENT', 'CLOSURE', 'DISABLED', 'CONSTRUCTION', 'CONGESTION']);
  assert.ok(Object.isFrozen(TYPE_PRIORITY) && Object.isFrozen(TYPE_LABELS) && Object.isFrozen(DETAIL_ATTRIBUTES));
  assert.equal(TYPE_LABELS.DISABLED, 'Disabled Vehicle');
  const names = new Set(EVENTS_DEF.attributes.map(a => a.name));
  for (const key of DETAIL_ATTRIBUTES) assert.ok(names.has(key), `${key} is a Live Events attribute`);
  assert.equal(DETAIL_ATTRIBUTES.length, 23);
});

test('liveEventKey is independent of the event type', () => {
  assert.equal(liveEventKey(davie('INCIDENT')), 'FL511-868702');
  assert.equal(liveEventKey(davie('CLOSURE')), 'FL511-868702');
  assert.equal(liveEventKey({ rawSourceId: 42 }), 'FL511-42');
});

// ---- mapping ----------------------------------------------------------------------------------

test('a real incident maps to a complete, valid Live Events record', () => {
  const event = davie();
  const rec = mapEventToRecord(event, { now: T0 });
  assert.equal(rec.keyInSource, 'FL511-868702');
  assert.equal(rec.code, 'FL511-868702');
  assert.equal(rec.name, 'Incident');
  assert.equal(rec.description, DAVIE_DETAIL.description);
  assert.equal(rec.event_id, 'FL511-INCIDENT-868702');
  assert.equal(rec.event_type, 'INCIDENT');
  assert.equal(rec.fl511_item_id, '868702');
  assert.equal(rec.source, 'FL511');
  assert.equal(rec.status, 'active');
  assert.equal(rec.cleared_at, '');
  assert.equal(rec.first_seen_at, iso(T0));
  assert.equal(rec.last_seen_at, iso(T0));
  assert.equal(rec.severity, 'Major');
  assert.equal(rec.start_time, 'Sep 25 2026, 7:55 AM');
  assert.equal(rec.end_time, '');
  assert.equal(rec.latitude, 26.093417);
  assert.equal(rec.longitude, -80.226583);
  assert.equal(rec.x_coordinates, -80.226583);
  assert.equal(rec.y_coordinates, 26.093417);
  assert.deepEqual(rec.geometry, { type: 'Point', coordinates: [-80.226583, 26.093417] });
  assert.equal(rec.project, PROJECT_CODE);
  assert.equal(rec.nearest_facility, 'I595_WB');
  assert.equal(rec.nearest_facility_label, 'I-595 Westbound');
  assert.equal(rec.distance_to_network_m, 11.6);
  assert.equal(rec.fdot_segment_id, 'I595-WB-FDOT-006680-007350');
  assert.equal(rec['segment ID'], '104W');
  assert.equal(rec['segment name'], 'Segment_104W');
  assert.equal(rec.carriageway, 'WB_GENERAL');
  assert.equal(rec.direction, 'WB');
  assert.equal(rec.section_id, 'SECTION_04');
  assert.equal(rec.section_label, 'Westbound Section 04');
  assert.equal(rec.lane_impact_label, '2 lanes blocked');
  assert.equal(rec.blocked_lanes, '2');
  assert.equal(typeof rec.blocked_lanes, 'string');
  assert.equal(rec.full_closure, 'No');
  assert.equal(rec.ramp_closure, 'No');
  assert.equal(rec.shoulder_only, 'No');
  assert.equal(rec.spatial_confidence, 'HIGH');
  assert.equal(rec.secondary_latitude, undefined);
  assert.equal(rec.secondary_longitude, undefined);

  assert.deepEqual(validateRecord(EVENTS_DEF, rec), { valid: true, failures: [] });
  assert.deepEqual(unknownAttributes(EVENTS_DEF, rec), []);
  // Every String-like attribute is present, so a merge-semantics load can't leave a stale value.
  for (const attr of EVENTS_DEF.attributes) {
    if (['String', 'Date', 'DateTime', 'Timestamp', 'URL'].includes(attr.type)) {
      assert.equal(typeof rec[attr.name], 'string', `${attr.name} is always emitted`);
    }
  }
});

test('an unresolved segment is an empty plain attribute and lane flags are omitted without parsed impact', () => {
  const rec = mapEventToRecord(ramp(), { now: T0 });
  assert.equal(rec.keyInSource, 'FL511-845752');
  assert.equal(rec.name, 'Closure on I-595');
  assert.equal(rec.description, 'Closure on I-595');
  assert.equal(rec['segment ID'], '');
  assert.equal(rec['segment name'], '');
  assert.equal(rec.fdot_segment_id, '');
  assert.equal(rec.carriageway, 'UNKNOWN');
  assert.equal(rec.blocked_lanes, '');
  assert.equal(rec.full_closure, '');
  assert.equal(rec.ramp_closure, '');
  assert.equal(rec.shoulder_only, '');
  assert.equal(rec.lane_impact_label, '');
  assert.equal(rec.spatial_confidence, 'LOW');
  assert.equal(validateRecord(EVENTS_DEF, rec).valid, true);
  assert.deepEqual(unknownAttributes(EVENTS_DEF, rec), []);
});

test('coordinates round to 7 dp and a parsed full closure without a count leaves blocked_lanes empty', () => {
  const event = {
    id: 'FL511-CLOSURE-9', type: 'CLOSURE', source: 'FL511', rawSourceId: 9,
    latitude: 26.123456789, longitude: -80.2400000049,
    secondaryLatitude: 26.11111111149, secondaryLongitude: -80.23333333351,
    distanceToI595NetworkM: 3.14159, detailsAvailable: false,
    liveOps: {
      carriageway: 'EB_GENERAL', direction: 'EB', sectionId: null, sectionLabel: null, segmentId: null,
      laneImpact: { blockedLanes: null, fullClosure: true, rampClosure: false, shoulderOnly: false, source: 'parsed' },
      laneImpactLabel: 'All lanes closed', spatialMatch: { confidence: 'MEDIUM' },
    },
  };
  const rec = mapEventToRecord(event, { now: T0 });
  assert.equal(rec.latitude, 26.1234568);
  assert.equal(rec.longitude, -80.24);
  assert.equal(rec.secondary_latitude, 26.1111111);
  assert.equal(rec.secondary_longitude, -80.2333333);
  assert.equal(rec.distance_to_network_m, 3.1);
  assert.equal(rec.fl511_item_id, '9');
  assert.equal(rec['segment ID'], '103E');
  assert.equal(rec.blocked_lanes, '');
  assert.equal(rec.full_closure, 'Yes');
  assert.equal(rec.lane_impact_label, 'All lanes closed');
  assert.equal(validateRecord(EVENTS_DEF, rec).valid, true);
});

test('express 106 has no DC segment and the FDOT id is never used as one', () => {
  const event = {
    id: 'FL511-INCIDENT-7', type: 'INCIDENT', rawSourceId: '7', latitude: 26.09, longitude: -80.15,
    nearestSegmentId: 'I595-EB-FDOT-000000-000100', detailsAvailable: true,
    liveOps: { carriageway: 'EXPRESS', laneImpact: { source: 'none' } },
  };
  const rec = mapEventToRecord(event, { now: T0 });
  assert.equal(rec['segment ID'], '');
  assert.equal(rec.fdot_segment_id, 'I595-EB-FDOT-000000-000100');
});

test('first_seen_at prefers previous, then the hint, then now', () => {
  const event = davie();
  assert.equal(mapEventToRecord(event, { now: T0 }).first_seen_at, iso(T0));
  assert.equal(mapEventToRecord(event, { now: T0, firstSeenAt: '2026-09-25T11:00:00.000Z' }).first_seen_at, '2026-09-25T11:00:00.000Z');
  const previous = { first_seen_at: '2026-09-25T10:00:00.000Z' };
  assert.equal(mapEventToRecord(event, { now: T0, previous, firstSeenAt: '2026-09-25T11:00:00.000Z' }).first_seen_at, '2026-09-25T10:00:00.000Z');
});

test('details carry forward from previous when the tooltip fetch failed, including sticky secondary coords', () => {
  const withSecondary = { ...davie(), secondaryLatitude: 26.0931, secondaryLongitude: -80.2261 };
  const previous = mapEventToRecord(withSecondary, { now: T0 });
  delete previous.comment; // a curated read-back omits empty values
  const noDetails = build(DAVIE_INCIDENT, 'INCIDENT', null);
  const rec = mapEventToRecord(noDetails, { now: T0 + 60_000, previous });
  for (const key of DETAIL_ATTRIBUTES) {
    assert.equal(rec[key], previous[key] ?? '', `${key} carried forward`);
  }
  assert.equal(rec.comment, '');
  assert.equal(rec.severity, 'Major');
  assert.equal(rec.blocked_lanes, '2');
  assert.equal(rec.secondary_latitude, 26.0931);
  assert.equal(rec.secondary_longitude, -80.2261);
  assert.equal(rec.last_seen_at, iso(T0 + 60_000));
  assert.equal(validateRecord(EVENTS_DEF, rec).valid, true);

  // With details, the fresh values win (but secondary coords stay sticky).
  const fresh = mapEventToRecord(davie('INCIDENT', { ...DAVIE_DETAIL, fields: [{ label: 'Severity', value: 'Minor' }] }), { now: T0, previous });
  assert.equal(fresh.severity, 'Minor');
  assert.equal(fresh.secondary_latitude, 26.0931);
});

test('the mapper never mutates the event', () => {
  const event = deepFreeze(davie());
  const snapshot = JSON.stringify(event);
  mapEventToRecord(event, { now: T0, previous: deepFreeze({ first_seen_at: iso(T0) }) });
  assert.equal(JSON.stringify(event), snapshot);
});

// ---- canClear ---------------------------------------------------------------------------------

test('canClear needs LIVE and a complete healthy feed diagnostic', () => {
  assert.equal(canClear(livePayload([])), true);
  assert.equal(canClear({ ...livePayload([]), sourceStatus: 'STALE' }), false);
  assert.equal(canClear({ ...livePayload([]), sourceStatus: 'UNAVAILABLE' }), false);
  assert.equal(canClear({ sourceStatus: 'LIVE', events: [] }), false);
  assert.equal(canClear({ sourceStatus: 'LIVE', events: [], diagnostics: {} }), false);
  assert.equal(canClear({ sourceStatus: 'LIVE', events: [], diagnostics: { feeds: {} } }), false);
  assert.equal(canClear({ sourceStatus: 'LIVE', events: [], diagnostics: { feeds: { ...healthyFeeds(), closures: { error: 'HTTP 500' } } } }), false);
  assert.equal(canClear({ sourceStatus: 'LIVE', events: [], diagnostics: { feeds: [{ error: null }] } }), true);
  assert.equal(canClear(null), false);
});

// ---- syncLiveEvents ---------------------------------------------------------------------------

test('invalid and non-LIVE payloads are skipped with existing state sorted', () => {
  const existing = [{ keyInSource: 'FL511-2', status: 'active' }, { keyInSource: 'FL511-1', status: 'active' }];
  const invalid = syncLiveEvents({ payload: { sourceStatus: 'LIVE' }, existing, now: T0 });
  assert.equal(invalid.skipped, true);
  assert.equal(invalid.reason, 'invalid_payload');
  assert.deepEqual(invalid.upserts, []);
  assert.deepEqual(invalid.state.map(r => r.keyInSource), ['FL511-1', 'FL511-2']);
  assert.equal(syncLiveEvents({ payload: null, existing, now: T0 }).reason, 'invalid_payload');

  const stale = syncLiveEvents({ payload: { ...livePayload([davie()]), sourceStatus: 'STALE' }, existing, now: T0 });
  assert.equal(stale.skipped, true);
  assert.equal(stale.reason, 'source_stale');
  assert.deepEqual(stale.upserts, []);
  assert.equal(syncLiveEvents({ payload: { events: [], sourceStatus: 'UNAVAILABLE' }, existing, now: T0 }).reason, 'source_unavailable');
});

test('lifecycle: new, unchanged, updated and heartbeat', () => {
  const first = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: [], now: T0 });
  assert.equal(first.skipped, false);
  assert.equal(first.stats.seen, 2);
  assert.equal(first.stats.new, 2);
  assert.deepEqual(first.upserts.map(r => r.keyInSource), ['FL511-845752', 'FL511-868702']);
  assert.deepEqual(first.state.map(r => r.keyInSource), ['FL511-845752', 'FL511-868702']);

  const second = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: first.state, now: T0 + 60_000 });
  assert.equal(second.upserts.length, 0);
  assert.equal(second.stats.unchanged, 2);
  assert.deepEqual(second.state, first.state, 'unchanged records keep their previous last_seen_at');

  const worse = davie('INCIDENT', { ...DAVIE_DETAIL, description: 'Crash on I-595 West at Davie Rd. All lanes closed.' });
  const third = syncLiveEvents({ payload: livePayload([worse, ramp()]), existing: first.state, now: T0 + 120_000 });
  assert.equal(third.stats.updated, 1);
  assert.equal(third.stats.unchanged, 1);
  assert.equal(third.upserts.length, 1);
  assert.equal(third.upserts[0].full_closure, 'Yes');
  assert.equal(third.upserts[0].first_seen_at, iso(T0));
  assert.equal(third.upserts[0].last_seen_at, iso(T0 + 120_000));

  const beat = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: first.state, now: T0 + 900_000, heartbeatSeconds: 900 });
  assert.equal(beat.stats.heartbeat, 2);
  assert.equal(beat.upserts.length, 2);
  assert.ok(beat.upserts.every(r => r.last_seen_at === iso(T0 + 900_000)));
  const off = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: first.state, now: T0 + 9_000_000, heartbeatSeconds: 0 });
  assert.equal(off.upserts.length, 0);
});

test('idempotence under replace and merge write-back', () => {
  const feed = () => livePayload([davie(), ramp()]);
  for (const [label, apply] of [['replace', applyReplace], ['merge', applyMerge]]) {
    let existing = [];
    const run1 = syncLiveEvents({ payload: feed(), existing, now: T0 });
    existing = apply(existing, run1.upserts);
    const run2 = syncLiveEvents({ payload: feed(), existing, now: T0 + 30_000 });
    assert.equal(run2.upserts.length, 0, `${label}: no-op re-poll`);

    // Clear and reactivate, round-tripping through the store each time.
    const cleared = syncLiveEvents({ payload: livePayload([ramp()]), existing, now: T0 + 60_000 });
    assert.equal(cleared.stats.cleared, 1);
    existing = apply(existing, cleared.upserts);
    assert.equal(syncLiveEvents({ payload: livePayload([ramp()]), existing, now: T0 + 90_000 }).upserts.length, 0, `${label}: cleared is stable`);

    const back = syncLiveEvents({ payload: feed(), existing, now: T0 + 120_000 });
    assert.equal(back.stats.reactivated, 1);
    existing = apply(existing, back.upserts);
    const davieRow = existing.find(r => r.keyInSource === 'FL511-868702');
    assert.equal(davieRow.status, 'active');
    assert.equal(davieRow.cleared_at, undefined, `${label}: cleared_at is gone from the curated read`);
    assert.equal(syncLiveEvents({ payload: feed(), existing, now: T0 + 150_000 }).upserts.length, 0, `${label}: reactivated is stable`);
  }
});

test('an event leaving a healthy LIVE feed is cleared, never deleted', () => {
  const first = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: [], now: T0 });
  const gone = syncLiveEvents({ payload: livePayload([ramp()]), existing: first.state, now: T0 + 300_000 });
  assert.equal(gone.stats.cleared, 1);
  assert.equal(gone.stats.clearingSuppressed, false);
  assert.equal(gone.upserts.length, 1);
  const cleared = gone.upserts[0];
  assert.equal(cleared.keyInSource, 'FL511-868702');
  assert.equal(cleared.status, 'cleared');
  assert.equal(cleared.cleared_at, iso(T0 + 300_000));
  assert.equal(cleared.last_seen_at, iso(T0), 'last_seen_at is when it was last in the feed');
  assert.equal(validateRecord(EVENTS_DEF, cleared).valid, true);
  assert.equal(gone.state.length, 2, 'nothing is deleted');

  // Already cleared records are not re-cleared.
  const again = syncLiveEvents({ payload: livePayload([ramp()]), existing: gone.state, now: T0 + 400_000 });
  assert.equal(again.stats.cleared, 0);
  assert.equal(again.upserts.length, 0);
});

test('a cleared record read back from a curated list (no geoDetails) is re-sent with its point geometry', () => {
  const first = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: [], now: T0 });
  // Real curated-data list items never carry geoDetails; only the single-record read does.
  const listItem = rec => ({
    id: '6a3bdcf6a4e4185131480000', keyInSource: rec.keyInSource, valid: true,
    attributes: Object.fromEntries(Object.entries(rec).filter(([k, v]) => k !== 'keyInSource' && k !== 'geometry' && v !== '' && v != null)),
  });
  const existing = first.upserts.map(listItem).map(fromCurated);
  assert.equal(existing.every(r => !('geometry' in r)), true);
  const gone = syncLiveEvents({ payload: livePayload([ramp()]), existing, now: T0 + 300_000 });
  const cleared = gone.upserts.find(r => r.status === 'cleared');
  assert.deepEqual(cleared.geometry, { type: 'Point', coordinates: [-80.226583, 26.093417] });

  // Falls back to x/y_coordinates, and keeps a geometry that was read back.
  const xyOnly = { ...existing.find(r => r.keyInSource === 'FL511-868702') };
  delete xyOnly.longitude; delete xyOnly.latitude;
  const viaXy = syncLiveEvents({ payload: livePayload([]), existing: [xyOnly], now: T0 + 300_000 }).upserts[0];
  assert.deepEqual(viaXy.geometry, { type: 'Point', coordinates: [-80.226583, 26.093417] });
  const line = { type: 'LineString', coordinates: [[-80.3, 26.1], [-80.2, 26.1]] };
  const kept = syncLiveEvents({ payload: livePayload([]), existing: [{ ...xyOnly, geometry: line }], now: T0 + 300_000 }).upserts[0];
  assert.deepEqual(kept.geometry, line);
});

test('clearing is suppressed when the feed cannot be trusted', () => {
  const first = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: [], now: T0 });
  const cases = {
    stale: { ...livePayload([ramp()]), sourceStatus: 'STALE' },
    unavailable: { ...livePayload([ramp()]), sourceStatus: 'UNAVAILABLE' },
    feedError: { ...livePayload([ramp()]), diagnostics: { feeds: { ...healthyFeeds(), incidents: { error: 'timeout' } } } },
    noDiagnostics: { sourceStatus: 'LIVE', events: [ramp()] },
  };
  for (const [label, payload] of Object.entries(cases)) {
    const result = syncLiveEvents({ payload, existing: first.state, now: T0 + 300_000 });
    assert.ok(result.upserts.every(r => r.status === 'active'), `${label}: nothing cleared`);
    assert.equal(result.stats.cleared, 0, label);
    assert.equal(result.state.find(r => r.keyInSource === 'FL511-868702').status, 'active', label);
  }
  const feedError = syncLiveEvents({ payload: cases.feedError, existing: first.state, now: T0 + 300_000 });
  assert.equal(feedError.stats.clearingSuppressed, true);
  assert.equal(feedError.skipped, false);
});

test('reactivation sets cleared_at to empty and preserves first_seen_at', () => {
  const first = syncLiveEvents({ payload: livePayload([davie()]), existing: [], now: T0 });
  const gone = syncLiveEvents({ payload: livePayload([]), existing: first.state, now: T0 + 60_000 });
  const back = syncLiveEvents({ payload: livePayload([davie()]), existing: gone.state, now: T0 + 120_000 });
  assert.equal(back.stats.reactivated, 1);
  const rec = back.upserts[0];
  assert.equal(rec.status, 'active');
  assert.equal(rec.cleared_at, '');
  assert.equal(rec.first_seen_at, iso(T0));
  assert.equal(rec.last_seen_at, iso(T0 + 120_000));
});

test('events sharing an itemId merge by type priority', () => {
  const result = syncLiveEvents({ payload: livePayload([davie('CLOSURE'), davie('INCIDENT')]), existing: [], now: T0 });
  assert.equal(result.stats.seen, 1);
  assert.equal(result.stats.merged, 1);
  assert.equal(result.upserts.length, 1);
  assert.equal(result.upserts[0].event_type, 'INCIDENT');
  assert.equal(result.upserts[0].event_id, 'FL511-INCIDENT-868702');

  // Same type, same key: the smaller event id wins deterministically, whatever the order.
  const a = { ...davie(), id: 'FL511-INCIDENT-868702-b', title: 'B' };
  const b = { ...davie(), id: 'FL511-INCIDENT-868702-a', title: 'A' };
  assert.equal(syncLiveEvents({ payload: livePayload([a, b]), existing: [], now: T0 }).upserts[0].title, 'A');
  assert.equal(syncLiveEvents({ payload: livePayload([b, a]), existing: [], now: T0 }).upserts[0].title, 'A');
});

test('a type change updates the same key and keeps first_seen_at', () => {
  const first = syncLiveEvents({ payload: livePayload([davie('INCIDENT')]), existing: [], now: T0 });
  const changed = syncLiveEvents({ payload: livePayload([davie('CLOSURE')]), existing: first.state, now: T0 + 60_000 });
  assert.equal(changed.stats.updated, 1);
  assert.equal(changed.upserts.length, 1);
  assert.equal(changed.upserts[0].keyInSource, 'FL511-868702');
  assert.equal(changed.upserts[0].event_type, 'CLOSURE');
  assert.equal(changed.upserts[0].first_seen_at, iso(T0));
  assert.equal(changed.state.length, 1);
});

test('firstSeenHints seed first_seen_at for a new record only', () => {
  const hints = new Map([['FL511-868702', '2026-09-25T11:30:00.000Z']]);
  const result = syncLiveEvents({ payload: livePayload([davie()]), existing: [], now: T0, firstSeenHints: hints });
  assert.equal(result.stats.new, 1);
  assert.equal(result.upserts[0].first_seen_at, '2026-09-25T11:30:00.000Z');
  const existing = [{ ...result.upserts[0], first_seen_at: '2026-09-25T10:00:00.000Z' }];
  const later = syncLiveEvents({ payload: livePayload([davie()]), existing, now: T0 + 1000, firstSeenHints: hints });
  assert.equal(later.state[0].first_seen_at, '2026-09-25T10:00:00.000Z');
});

test('inputs are never mutated', () => {
  const first = syncLiveEvents({ payload: livePayload([davie(), ramp()]), existing: [], now: T0 });
  const payload = deepFreeze(livePayload([davie('INCIDENT', null)]));
  const existing = deepFreeze(structuredClone(first.state));
  const hints = new Map([['FL511-845752', iso(T0 - 1000)]]);
  const before = JSON.stringify({ payload, existing });
  const result = syncLiveEvents({ payload, existing, now: T0 + 60_000, firstSeenHints: hints });
  assert.equal(JSON.stringify({ payload, existing }), before);
  assert.equal(hints.size, 1);
  assert.equal(result.stats.cleared, 1);
});

test('stats have the documented shape', () => {
  const result = syncLiveEvents({ payload: livePayload([]), existing: [], now: T0 });
  assert.deepEqual(Object.keys(result.stats).sort(), ['cleared', 'clearingSuppressed', 'heartbeat', 'merged', 'new', 'reactivated', 'seen', 'unchanged', 'updated']);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.upserts, []);
});

test('a failed tooltip fetch carries forward text only; position attributes follow the current coordinates', () => {
  const POSITION = ['carriageway', 'direction', 'section_id', 'section_label', 'fdot_segment_id', 'segment ID', 'segment name'];
  const previous = mapEventToRecord(build(RAMP_CLOSURE, 'INCIDENT', DAVIE_DETAIL), { now: T0 });
  const moved = build({ ...DAVIE_INCIDENT, itemId: RAMP_CLOSURE.itemId }, 'INCIDENT', null);
  const bare = mapEventToRecord(moved, { now: T0 + 60_000 });
  assert.notDeepEqual(POSITION.map(k => previous[k]), POSITION.map(k => bare[k]), 'fixture: the two positions differ');
  const rec = mapEventToRecord(moved, { now: T0 + 60_000, previous });
  for (const key of POSITION) assert.equal(rec[key], bare[key], `${key} from the current position`);
  assert.equal(rec.severity, 'Major', 'tooltip text still carried forward');
  assert.equal(rec.description, previous.description);
  assert.equal(rec.latitude, bare.latitude);
  assert.equal(validateRecord(EVENTS_DEF, rec).valid, true);
});
