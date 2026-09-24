/**
 * The browser's DataConnect client: pagination against totalCount, and one distinct answer per
 * failure. It talks to this app's own origin — the token lives on the server — so these tests only
 * need a stub `fetch`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const load = async responder => {
  globalThis.fetch = responder;
  // Fresh module per test: the client holds no state, but this keeps them independent.
  return import(`../src/maintenance/dataConnectClient.js?${Math.random()}`);
};
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const record = id => ({ id, classId: 'c', className: 'work_orders', keyInSource: id, attributes: { 'Work Order ID': id }, valid: true });

test('every page is followed until totalCount is satisfied', async () => {
  const seen = [];
  const { getCuratedData } = await load(async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push({ url, page: body.page, pageSize: body.pageSize });
    const start = body.page * body.pageSize;
    return json({ data: Array.from({ length: Math.max(0, Math.min(body.pageSize, 250 - start)) }, (_, i) => record(`WO-${start + i}`)), totalCount: 250 });
  });
  const { records, totalCount } = await getCuratedData('class-work-orders', { pageSize: 100 });
  assert.equal(totalCount, 250);
  assert.equal(records.length, 250);
  assert.deepEqual(seen.map(call => call.page), [0, 1, 2]);
  assert.match(seen[0].url, /^\/api\/dataconnect\/class\/class-work-orders\/curated-data$/);
});

test('one page is one request when the class fits in it', async () => {
  let calls = 0;
  const { getCuratedData } = await load(async () => { calls++; return json({ data: [record('WO-1')], totalCount: 1 }); });
  const { records } = await getCuratedData('c', { pageSize: 500 });
  assert.deepEqual([records.length, calls], [1, 1]);
});

test('an empty class is data, not an error', async () => {
  const { getCuratedData } = await load(async () => json({ data: [], totalCount: 0 }));
  assert.deepEqual(await getCuratedData('c'), { records: [], totalCount: 0 });
});

test('each failure is told apart, so the UI can say what actually happened', async () => {
  const cases = [
    [503, { missing: ['DC_BASE_URL'] }, 'unconfigured', 'Not configured'],
    [401, {}, 'auth', 'Sign-in required'],
    [403, {}, 'forbidden', 'Access denied'],
    [404, {}, 'not-found', 'Class not found'],
    [500, { error: 'boom' }, 'service', 'DataConnect error'],
  ];
  for (const [status, body, kind, note] of cases) {
    const { getCuratedData } = await load(async () => json(body, status));
    const error = await getCuratedData('c').catch(caught => caught);
    assert.equal(error.kind, kind, `${status}`);
    assert.equal(error.note, note);
    assert.equal(error.status, status);
  }
  const { getCuratedData } = await load(async () => { throw new TypeError('Failed to fetch'); });
  const offline = await getCuratedData('c').catch(caught => caught);
  assert.equal(offline.kind, 'network');
  assert.equal(offline.note, 'Service unreachable');
});

test('the client sends no Authorization header of its own — the server holds the token', async () => {
  let headers = null;
  const { getCuratedData } = await load(async (url, options) => { headers = options.headers ?? {}; return json({ data: [], totalCount: 0 }); });
  await getCuratedData('c');
  assert.deepEqual(Object.keys(headers).map(key => key.toLowerCase()), ['content-type']);
});
