import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSignsApi, normalizeMessageSigns, parseMessageSignDetail } from '../server/messageSigns.mjs';
import { loadConfig } from '../server/config.mjs';
import { createNetwork } from '../server/i595Network.mjs';

const html = message => `<div class="map-tooltip"><table><tr><td><b>SR-84 WB before Nob Hill Road</b></td></tr><tr><td class="msgContent"><div>${message}</div></td></tr><tr><td>Sep 17 2026, 3:46 AM</td></tr></table></div>`;
const network = createNetwork([{ facility: 'SR84_WB', coordinates: [[-80.3, 26.1], [-80.2, 26.1]] }]);
const feed = { item2: [{ itemId: '169860', location: [26.1, -80.25] }] };

test('empty message is valid and retains location and source timestamp', () => {
  assert.deepEqual(parseMessageSignDetail(html('')), { title: 'SR-84 WB before Nob Hill Road', message: '', updatedAt: 'Sep 17 2026, 3:46 AM' });
  assert.equal(parseMessageSignDetail(html('SLOW &amp; SAFE <script>alert(1)</script>')).message, 'SLOW & SAFE');
  assert.throws(() => parseMessageSignDetail('<html>Service unavailable</html>'));
});

test('FL511 latitude/longitude order, corridor filter, duplicate and invalid markers', () => {
  const signs = normalizeMessageSigns({ item2: [...feed.item2, ...feed.item2,
    { itemId: '2', location: [28, -82] }, { itemId: '3', location: [null, -80.25] }] }, network);
  assert.equal(signs.length, 1);
  assert.equal(signs[0].longitude, -80.25);
  assert.equal(signs[0].latitude, 26.1);
});

async function call(api, path = '', method = 'GET') {
  let status, body;
  const handled = await api.handle({ url: `/api/i595/message-signs${path}`, method }, {
    writeHead(code) { status = code; }, end(value) { body = value && JSON.parse(value); },
  });
  return { handled, status, body };
}

test('API fetches details on demand, caches, scopes IDs and reports stale/unavailable', async () => {
  let clock = 0, fail = false;
  const calls = [];
  const api = createMessageSignsApi({ network, config: loadConfig(), now: () => clock,
    fetchImpl: async url => {
      calls.push(url);
      if (fail) throw new Error('upstream down');
      return { ok: true, json: async () => feed, text: async () => html('ROAD WORK') };
    } });
  const list = await call(api);
  assert.equal(list.body.signs.length, 1);
  assert.equal(calls.length, 1);
  assert.equal((await call(api, '/999')).status, 404);
  assert.equal((await call(api, '/169860')).body.message, 'ROAD WORK');
  await call(api, '/169860');
  assert.equal(calls.length, 2);
  assert.equal((await call(api, '/bad')).status, 404);
  assert.equal((await call(api, '', 'POST')).status, 405);
  clock = 61000; fail = true;
  assert.equal((await call(api)).body.sourceStatus, 'STALE');
  assert.equal((await call(api, '/169860')).body.sourceStatus, 'STALE');
  const unavailable = createMessageSignsApi({ network, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await call(unavailable)).status, 503);
});
