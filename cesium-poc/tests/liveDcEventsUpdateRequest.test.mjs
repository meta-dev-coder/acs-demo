/**
 * The additive schema change for the existing real "SDNA Florida I595 Live Events" class
 * (config/liveDc/live-events.update-request.json) and the guarded tool that applies it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_CLASS, buildClassUpdateRequest, buildCreateRequests, liveClassDefinition } from '../server/liveDc/classes.mjs';
import { runApplyUpdate } from '../tools/live-dc-apply-update.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = join(ROOT, 'config', 'liveDc', 'live-events.update-request.json');
const readArtifact = () => JSON.parse(readFileSync(ARTIFACT, 'utf8'));
const NEW_ATTRIBUTES = [
  ['incident_time_local', 'String'], ['first_seen_at_dt', 'DateTime'], ['cleared_at_dt', 'DateTime'],
  ['snapshot_first_url', 'URL'], ['snapshot_first_taken_at', 'DateTime'], ['snapshot_first_camera_id', 'String'],
  ['snapshot_cleared_url', 'URL'], ['snapshot_cleared_taken_at', 'DateTime'], ['snapshot_cleared_camera_id', 'String'],
  ['weather_code', 'Integer'], ['temperature_c', 'Decimal'], ['relative_humidity_pct', 'Decimal'], ['precipitation_mm', 'Decimal'],
  ['wind_speed_kmh', 'Decimal'], ['wind_direction_deg', 'Decimal'], ['weather_observed_at', 'DateTime'], ['weather_source', 'String'],
];
const EXISTING = ['keyInSource', 'code', 'name', 'description', 'geometry', 'event_id', 'status', 'reported_at', 'weather_at_event',
  'snapshot_archive_url', 'camera_snapshot_url', 'field_sources'];

describe('update-request artifact', () => {
  test('lists every declared Live Events attribute to ensure (derived from liveClasses.json): exact types, optional, no relationships', () => {
    const artifact = readArtifact();
    assert.deepEqual(artifact, buildClassUpdateRequest(LIVE_CLASS.EVENTS));
    assert.equal(artifact.className, 'SDNA Florida I595 Live Events');
    assert.equal('add' in artifact, false, 'the add set is computed against DataConnect at apply time');
    assert.deepEqual(artifact.ensure.map(a => a.name), liveClassDefinition(LIVE_CLASS.EVENTS).attributes.filter(a => !a.core).map(a => a.name));
    const types = new Map(artifact.ensure.map(a => [a.name, a.type]));
    for (const [name, type] of NEW_ATTRIBUTES) assert.equal(types.get(name), type, name);
    assert.deepEqual(artifact.modify, []);
    assert.deepEqual(artifact.remove, []);
    for (const a of artifact.ensure) {
      assert.equal(a.mandatory, false, a.name);
      assert.equal(a.core, false, a.name);
      assert.equal(a.array, false, a.name);
      assert.equal(a.relatedClassId, undefined, a.name);
      assert.equal(a.relationshipType, undefined, a.name);
    }
    const config = JSON.parse(readFileSync(join(ROOT, 'config', 'liveDc', 'liveClasses.json'), 'utf8'));
    assert.equal('classUpdates' in config, false, 'no second, hand-kept attribute list');
  });

  test('fresh installs get the same attributes through the create-requests', () => {
    const events = buildCreateRequests({ resolveClassId: n => `<id of ${n}>` }).find(r => r.className === LIVE_CLASS.EVENTS);
    const byName = new Map(events.update.add.map(a => [a.name, a]));
    for (const a of readArtifact().ensure) assert.deepEqual(byName.get(a.name), a);
    const committed = JSON.parse(readFileSync(join(ROOT, 'config', 'liveDc', 'live-classes.create-requests.json'), 'utf8'));
    assert.deepEqual(committed.find(r => r.className === LIVE_CLASS.EVENTS).update.add.map(a => a.name), events.update.add.map(a => a.name));
    const names = liveClassDefinition(LIVE_CLASS.EVENTS).attributes.map(a => a.name);
    assert.deepEqual(names.slice(-3), ['x_coordinates', 'y_coordinates', 'project']);
  });

  test('live-dc-classes --check covers the artifact', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'live-dc-classes.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('live-dc-apply-update', () => {
  const TOKEN = 'secret-token-value';
  const CLASS_ID = '6a3d0c2da4e4185131489999';
  const NEW = new Set(NEW_ATTRIBUTES.map(([name]) => name));
  const DECLARED = liveClassDefinition(LIVE_CLASS.EVENTS).attributes.map(a => a.name);
  /** The real class today: every declared attribute except `missing`. */
  const liveEventsDto = (missing = [...NEW]) => ({
    id: CLASS_ID, classId: 101, className: LIVE_CLASS.EVENTS, description: 'Live FL511 road events', owners: ['a@b.c'],
    displayInExplorer: true, includeSecuritySettings: false, geometryAttributeName: 'geometry',
    attributes: DECLARED.filter(name => !missing.includes(name)).map(name => ({ name, type: 'String' })),
  });

  function harness({ classes = [liveEventsDto()], postStatus = 200 } = {}) {
    const calls = [];
    const out = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body, redirect: init.redirect });
      if ((init.method ?? 'GET') === 'GET') return Response.json(classes);
      return new Response(JSON.stringify({ id: CLASS_ID }), { status: postStatus, headers: { 'content-type': 'application/json' } });
    };
    const io = { log: line => out.push(String(line)), error: line => out.push(String(line)) };
    const run = (argv, artifact) => runApplyUpdate({
      argv, env: { DC_WRITER_ACCESS_TOKEN_FILE: '/tmp/never-read' }, fetchImpl, readToken: () => TOKEN,
      ...(artifact ? { readArtifact: () => artifact } : {}), ...io,
    });
    return { calls, out, run };
  }
  const byName = new Map(readArtifact().ensure.map(a => [a.name, a]));

  test('dry run by default: reads the class list, prints the missing attributes, never POSTs', async () => {
    const h = harness();
    assert.equal(await h.run([]), 0);
    assert.deepEqual(h.calls.map(c => `${c.method} ${c.url}`), ['GET https://dc-data-mgmt-demo-dqa3.cohesivecloud.app/api/v1/class']);
    assert.equal(h.calls[0].headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(h.calls[0].redirect, 'manual');
    const text = h.out.join('\n');
    assert.match(text, /dry run/i);
    assert.match(text, /weather_code \(Integer\)/);
    assert.match(text, new RegExp(CLASS_ID));
    assert.ok(!text.includes(TOKEN));
  });

  test('--apply POSTs only the declared attributes the class lacks, keeping the class own settings', async () => {
    const h = harness({ classes: [liveEventsDto(['weather_code', 'temperature_c'])] });
    assert.equal(await h.run(['--apply']), 0);
    const post = h.calls.find(c => c.method === 'POST');
    assert.equal(post.url, `https://dc-data-mgmt-demo-dqa3.cohesivecloud.app/api/v1/class/${CLASS_ID}`);
    assert.equal(post.headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(post.body), {
      className: LIVE_CLASS.EVENTS, description: 'Live FL511 road events', owners: ['a@b.c'], displayInExplorer: true,
      includeSecuritySettings: false, geometryAttributeName: 'geometry', add: [byName.get('weather_code'), byName.get('temperature_c')],
      modify: [], remove: [],
    });
    assert.ok(!h.out.join('\n').includes(TOKEN));
  });

  test('idempotent: a class that already has every declared attribute gets nothing, even with --apply', async () => {
    const h = harness({ classes: [liveEventsDto([])] });
    assert.equal(await h.run(['--apply']), 0);
    assert.ok(!h.calls.some(c => c.method === 'POST'));
    assert.match(h.out.join('\n'), /up to date/i);
  });

  test('the 17 new attributes against the class as it was before the update', async () => {
    const h = harness();
    assert.equal(await h.run(['--apply']), 0);
    const body = JSON.parse(h.calls.find(c => c.method === 'POST').body);
    assert.deepEqual(body.add.map(a => [a.name, a.type]), NEW_ATTRIBUTES);
  });

  test('refuses a class other than SDNA Florida I595 Live Events', async () => {
    const h = harness();
    assert.equal(await h.run(['--apply'], { ...readArtifact(), className: 'Florida I595 Incidents' }), 2);
    assert.equal(h.calls.length, 0);
    assert.match(h.out.join('\n'), /refus/i);
  });

  test('refuses a missing or ambiguous class, modify/remove, and a failed POST exits 1', async () => {
    assert.equal(await harness({ classes: [] }).run(['--apply']), 1);
    assert.equal(await harness({ classes: [liveEventsDto(), liveEventsDto()] }).run(['--apply']), 1);
    const h = harness();
    assert.equal(await h.run(['--apply'], { ...readArtifact(), remove: ['status'] }), 2);
    assert.equal(await h.run(['--apply'], { ...readArtifact(), modify: [{ name: 'status' }] }), 2);
    assert.equal(h.calls.length, 0);
    assert.equal(await harness({ postStatus: 400 }).run(['--apply']), 1);
    assert.equal(await harness().run(['--bogus']), 2);
  });
});
