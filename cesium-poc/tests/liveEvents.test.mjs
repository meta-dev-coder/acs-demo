import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadI595Network } from '../server/i595Network.mjs';
import { EVENT_TYPES, attachDetails, normalizeEvent, normalizeFeed } from '../server/liveEvents.mjs';
import { createFl511Service } from '../server/fl511Service.mjs';
import { loadConfig } from '../server/config.mjs';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const network = await loadI595Network(dataDir);
const options = { bufferMeters: 250, segmentToleranceMeters: 120 };

// Real FL511 closure 845752 (2026-09-09): an on-ramp closure metres from I-595 ramp geometry that
// FL511 itself attributes to 95 Express — the case that must never be relabelled as I-595.
const RAMP_CLOSURE = { itemId: '845752', latitude: 26.085906, longitude: -80.169425 };
// Real FL511 incident 845391: Orange County, ~250 km away.
const STATEWIDE_INCIDENT = { itemId: '845391', latitude: 28.474586, longitude: -81.631436 };

test('corridor filtering keeps a nearby event and drops a statewide one', () => {
  const near = normalizeEvent(RAMP_CLOSURE, EVENT_TYPES.CLOSURE, network, options);
  assert.ok(near);
  assert.ok(near.distanceToI595NetworkM < 250, `expected corridor distance, got ${near.distanceToI595NetworkM}`);
  assert.equal(normalizeEvent(STATEWIDE_INCIDENT, EVENT_TYPES.INCIDENT, network, options), null);
});

test('the buffer is what decides relevance', () => {
  assert.equal(normalizeEvent(RAMP_CLOSURE, EVENT_TYPES.CLOSURE, network, { ...options, bufferMeters: 5 }), null);
  assert.ok(normalizeEvent(RAMP_CLOSURE, EVENT_TYPES.CLOSURE, network, { ...options, bufferMeters: 5000 }));
});

test('proximity produces an association, never a roadway claim', () => {
  const event = normalizeEvent(RAMP_CLOSURE, EVENT_TYPES.CLOSURE, network, options);
  assert.equal(event.nearestFacility, 'RAMP_CONNECTOR');
  assert.ok(Number.isFinite(event.distanceToNearestFacilityM));
  // FL511 published no structured roadway/direction/lane fields, so the model must have none.
  assert.equal(event.roadway, undefined);
  assert.equal(event.direction, undefined);
  assert.equal(event.lanesBlocked, undefined);
  assert.equal(event.status, undefined);
  // A ramp event belongs to no FDOT mainline traffic section at the default tolerance.
  assert.equal(event.nearestSegmentId, null);
  assert.equal(event.distanceToSegmentM, null);
});

test('an event on the mainline does associate with an FDOT traffic section', () => {
  // A point taken from the I-595 eastbound mainline geometry itself.
  const [longitude, latitude] = network.lines.find(line => line.facility === 'I595_EB').coordinates[40];
  const event = normalizeEvent({ itemId: 'x', latitude, longitude }, EVENT_TYPES.INCIDENT, network, options);
  assert.equal(event.nearestFacility, 'I595_EB');
  assert.match(event.nearestSegmentId, /^I595-EB-FDOT-/);
  assert.match(event.nearestSegmentLabel, /^Eastbound Segment \d+$/);
  assert.ok(event.distanceToSegmentM <= 120);
});

test('a closure is kept when only its secondary endpoint reaches the corridor', () => {
  const [longitude, latitude] = network.lines.find(line => line.facility === 'I595_WB').coordinates[30];
  const event = normalizeEvent(
    { itemId: '461840', latitude: 26.3261769, longitude: -80.2030647, secondaryLatitude: latitude, secondaryLongitude: longitude },
    EVENT_TYPES.CLOSURE, network, options,
  );
  assert.ok(event, 'secondarylocation must be evaluated, not discarded');
  assert.equal(event.secondaryLatitude, latitude);
  assert.ok(event.secondaryDistanceToI595NetworkM < 250);
  // The association follows the endpoint that is actually on the corridor.
  assert.equal(event.nearestFacility, 'I595_WB');
});

test('details are folded in without inventing anything', () => {
  const base = normalizeEvent(RAMP_CLOSURE, EVENT_TYPES.CLOSURE, network, options);
  assert.equal(base.detailsAvailable, false);
  const event = attachDetails(base, {
    title: 'Closure',
    description: 'Planned construction in Broward County on 95 Express South, ramp from I-595 Mainline/Tpk/US-441.',
    fields: [{ label: 'Severity', value: 'Major' }, { label: 'Start Time', value: 'Sep 8 2026, 9:15 PM' }],
  });
  assert.equal(event.detailsAvailable, true);
  assert.equal(event.severity, 'Major');
  assert.equal(event.startTime, 'Sep 8 2026, 9:15 PM');
  assert.equal(event.endTime, undefined);
  assert.equal(event.roadway, undefined, 'roadway lives only in FL511 prose and must not be parsed out');
  assert.equal(event.nearestFacility, 'RAMP_CONNECTOR', 'association survives enrichment');
  assert.equal(attachDetails(base, null).detailsAvailable, false);
});

test('one unusable item does not fail the feed', () => {
  const logged = [];
  const broken = { get itemId() { return 'boom'; }, get latitude() { throw new Error('bad item'); } };
  const events = normalizeFeed([RAMP_CLOSURE, broken], EVENT_TYPES.CLOSURE, network, options, { warn: message => logged.push(message) });
  assert.equal(events.length, 1);
  assert.equal(logged.length, 1);
});

// ---- service caching / status ------------------------------------------------------------------

const config = { ...loadConfig({}), refreshSeconds: 60, staleAfterSeconds: 180, detailTtlSeconds: 300 };
const silent = { warn() {}, error() {}, log() {} };

function stubClient({ incidents = [RAMP_CLOSURE], closures = [], detail = null, fail = false } = {}) {
  const calls = { details: 0, feeds: 0 };
  return {
    calls,
    fetchIncidents: async () => { calls.feeds++; if (fail) throw new Error('FL511 down'); return incidents; },
    fetchClosures: async () => { calls.feeds++; if (fail) throw new Error('FL511 down'); return closures; },
    fetchEventDetails: async () => { calls.details++; if (fail) throw new Error('FL511 down'); return detail; },
  };
}

test('a healthy poll reports LIVE with corridor counts', async () => {
  const service = createFl511Service({ config, network, client: stubClient({ closures: [STATEWIDE_INCIDENT] }), logger: silent });
  const payload = await service.getI595LiveEvents();
  service.stop();
  assert.equal(payload.sourceStatus, 'LIVE');
  assert.equal(payload.counts.total, 1);
  assert.equal(payload.counts.incidents, 1);
  assert.equal(payload.counts.closures, 0, 'the Orange County closure is not ours');
  assert.equal(payload.bufferMeters, config.bufferMeters);
  assert.equal(payload.events[0].source, 'FL511');
});

test('details are cached per event rather than refetched every poll', async () => {
  const client = stubClient({ detail: { title: 'Incident', description: 'Crash', fields: [] } });
  const service = createFl511Service({ config, network, client, logger: silent });
  await service.getI595LiveEvents();
  await service.refresh();
  service.stop();
  assert.equal(client.calls.details, 1);
});

test('an FL511 outage serves the last good data as STALE instead of emptying the map', async () => {
  let failing = false, clock = Date.parse('2026-09-09T12:00:00Z');
  const client = {
    fetchIncidents: async () => { if (failing) throw new Error('FL511 down'); return [RAMP_CLOSURE]; },
    fetchClosures: async () => { if (failing) throw new Error('FL511 down'); return []; },
    fetchEventDetails: async () => null,
  };
  const service = createFl511Service({ config, network, client, logger: silent, now: () => clock });
  assert.equal((await service.getI595LiveEvents()).sourceStatus, 'LIVE');

  failing = true;
  clock += 200_000; // past staleAfterSeconds
  await service.refresh();
  const stale = await service.getI595LiveEvents();
  service.stop();
  assert.equal(stale.sourceStatus, 'STALE');
  assert.equal(stale.counts.total, 1, 'cached events are still served');
  assert.equal(stale.diagnostics.feeds.incidents.error, 'FL511 down');
  assert.ok(stale.lastSuccessfulUpdate);
  assert.equal(stale.dataFreshness.ageSeconds, 200);
});

test('a source that never answered is UNAVAILABLE, not empty-but-live', async () => {
  const service = createFl511Service({ config, network, client: stubClient({ fail: true }), logger: silent });
  const payload = await service.getI595LiveEvents();
  service.stop();
  assert.equal(payload.sourceStatus, 'UNAVAILABLE');
  assert.deepEqual(payload.events, []);
  assert.equal(payload.lastSuccessfulUpdate, null);
  assert.equal(payload.diagnostics.lastError, 'FL511 down');
});
