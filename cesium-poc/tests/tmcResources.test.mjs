/**
 * Choosing the cameras and signs that relate to one incident.
 *
 * The two claims this must never make: that a nearby camera is pointed at the incident, and that an
 * upstream sign is warning about it. Both would be inventing operational fact from geometry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';
import { nearestUpstream, upstreamLabel, upstreamResources } from '../src/tmc/tmcResources.js';

/** A straight east-west corridor; 0.001 deg of longitude is ~100 m here. */
const CENTERLINE = Array.from({ length: 121 }, (_, i) => ({ lon: -80.33 + i * 0.001, lat: 26.06 }));
const resolved = { status: UPSTREAM_STATUS.RESOLVED, reason: null, sectionIds: ['SECTION_03'], sections: [] };
const unresolved = { status: UPSTREAM_STATUS.UNRESOLVED, reason: 'Carriageway unresolved', sectionIds: [], sections: [] };

const incidentAt = (lon, carriageway = CARRIAGEWAYS.EB_GENERAL) => ({ longitude: lon, latitude: 26.06, carriageway });
const resource = (id, lon) => ({ id, longitude: lon, latitude: 26.06 });

test('eastbound: only what the traffic has not yet passed', () => {
  const found = upstreamResources(
    [resource('CAM-behind', -80.26), resource('CAM-ahead', -80.24), resource('CAM-further-back', -80.28)],
    incidentAt(-80.25), resolved, { centerline: CENTERLINE },
  );
  assert.deepEqual(found.map(f => f.id), ['CAM-behind', 'CAM-further-back'], 'nearest first, nothing downstream');
  assert.ok(found[0].upstreamMeters > 900 && found[0].upstreamMeters < 1200);
});

test('westbound: upstream is the other way along the same road', () => {
  const found = upstreamResources(
    [resource('CAM-east', -80.24), resource('CAM-west', -80.26)],
    incidentAt(-80.25, CARRIAGEWAYS.WB_GENERAL), resolved, { centerline: CENTERLINE },
  );
  assert.deepEqual(found.map(f => f.id), ['CAM-east'], 'westbound traffic comes from the east');
});

test('no resolved direction means no upstream resources, not the nearest ones', () => {
  const found = upstreamResources([resource('CAM-1', -80.26)], incidentAt(-80.25), unresolved, { centerline: CENTERLINE });
  assert.deepEqual(found, [], 'offering "nearest" here would offer road already passed');
  assert.equal(nearestUpstream([resource('CAM-1', -80.26)], incidentAt(-80.25), unresolved, { centerline: CENTERLINE }), null);
});

test('something far back up the corridor is out of reach', () => {
  const found = upstreamResources([resource('CAM-far', -80.31)], incidentAt(-80.25), resolved,
    { centerline: CENTERLINE, reachMeters: 2000 });
  assert.deepEqual(found, []);
});

test('a resource with no coordinates is skipped rather than placed', () => {
  const found = upstreamResources([{ id: 'CAM-nowhere' }, resource('CAM-ok', -80.26)],
    incidentAt(-80.25), resolved, { centerline: CENTERLINE });
  assert.deepEqual(found.map(f => f.id), ['CAM-ok']);
});

test('without a corridor to measure along, nothing is claimed', () => {
  assert.deepEqual(upstreamResources([resource('CAM-1', -80.26)], incidentAt(-80.25), resolved, { centerline: [] }), []);
});

test('the distance always says which way it points', () => {
  const [first] = upstreamResources([resource('CAM-1', -80.26)], incidentAt(-80.25), resolved, { centerline: CENTERLINE });
  assert.match(upstreamLabel(first), /upstream$/);
  assert.equal(upstreamLabel(null), null);
  // Short distances stay in metres rather than reading "0.1 mi".
  assert.match(upstreamLabel({ upstreamMeters: 120, upstreamMiles: 0.07 }), /^120 m upstream$/);
  assert.match(upstreamLabel({ upstreamMeters: 1100, upstreamMiles: 0.68 }), /^0\.7 mi upstream$/);
});

test('a returned resource is a place to look, carrying no claim about the incident', () => {
  // The shape deliberately has no "warning active", "covers incident" or "shows incident" field:
  // the feed publishes no sign message and no camera bearing, so nothing here can assert either.
  const [first] = upstreamResources([resource('DMS-7', -80.27)], incidentAt(-80.25), resolved, { centerline: CENTERLINE });
  assert.deepEqual(Object.keys(first).sort(), ['id', 'resource', 'upstreamMeters', 'upstreamMiles']);
});
