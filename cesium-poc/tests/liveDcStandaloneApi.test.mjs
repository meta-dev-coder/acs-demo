/**
 * The standalone API host (`npm run api`, server/index.mjs) serves the same Live DataConnect routes
 * the Vite dev server mounts: the read proxy and the DataConnect-sourced live events.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_CLASS } from '../server/liveDc/classes.mjs';
import { createDcWriter, loadDcWriterConfig } from '../server/liveDc/dcWriter.mjs';
import { createDcStandin } from '../server/liveDc/standin.mjs';
import { loadConfig } from '../server/config.mjs';
import { createApiServer } from '../server/index.mjs';

const silent = { info() {}, log() {}, warn() {}, error() {} };
const iso = ms => new Date(ms).toISOString();
const EVENT = {
  keyInSource: 'FL511-868702', code: 'FL511-868702', name: 'Crash', title: 'Crash', description: 'Crash on I-595 West at Davie Rd.',
  event_id: 'FL511-INCIDENT-868702', event_type: 'INCIDENT', fl511_item_id: '868702', source: 'FL511', status: 'active',
  latitude: 26.093417, longitude: -80.226583, x_coordinates: -80.226583, y_coordinates: 26.093417, project: '2222FL',
  first_seen_at: iso(Date.now() - 600_000), last_seen_at: iso(Date.now() - 30_000),
};

describe('standalone API host', () => {
  let upstream, host, base;
  before(async () => {
    upstream = await createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: [], logger: silent }).listen(0);
    const writer = createDcWriter({
      config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: upstream.url, DC_WRITER_LOAD_BASE_URL: upstream.url, DC_WRITER_ACCESS_TOKEN: 'test-token' }), pollIntervalMs: 5, processTimeoutMs: 5000, curationTimeoutMs: 5000 },
      logger: silent,
    });
    await writer.loadRecords((await writer.resolveLiveClasses()).get(LIVE_CLASS.EVENTS), [EVENT]);
    host = createApiServer({ config: loadConfig({}), env: { LIVE_DC_READ_BASE_URL: upstream.url, LIVE_DC_READ_ACCESS_TOKEN: 'test-token' }, logger: silent });
    await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${host.server.address().port}`;
  });
  after(async () => {
    host?.server.closeAllConnections?.();
    await new Promise(resolve => (host ? host.server.close(resolve) : resolve()));
    await host?.stop();
    await upstream?.close();
  });

  test('mounts the Live DataConnect read proxy', async () => {
    const response = await fetch(`${base}/api/live-dc/classes`);
    assert.equal(response.status, 200);
    const { classes } = await response.json();
    assert.ok(classes.some(entry => entry.className === LIVE_CLASS.EVENTS));
  });

  test('serves live events from DataConnect through the same read proxy', async () => {
    const response = await fetch(`${base}/api/i595/live-events?source=dataconnect`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'DataConnect');
    assert.deepEqual(body.events.map(event => event.id), ['FL511-INCIDENT-868702']);
  });

  test('unknown routes are still a JSON 404', async () => {
    const response = await fetch(`${base}/api/nope`);
    assert.equal(response.status, 404);
    assert.ok((await response.json()).error);
  });
});
