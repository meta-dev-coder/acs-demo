/**
 * One timeout helper module for the live-dc pipeline, and one point extraction shared by enrichment
 * and capture. No network: fetch is a fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchWithTimeout, withDeadline } from '../server/liveDc/timeouts.mjs';
import { pointOf } from '../server/liveDc/eventEnrichment.mjs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('withDeadline: resolves or rejects as the promise does, else a timeout error with code "timeout"', async () => {
  assert.equal(await withDeadline(Promise.resolve(1), 50), 1);
  await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 50), /boom/);
  await assert.rejects(withDeadline(new Promise(() => {}), 10), err => err.message === 'timeout' && err.code === 'timeout');
  const pending = Promise.resolve(2);
  assert.equal(withDeadline(pending, undefined), pending, 'no deadline: the promise itself');
  assert.equal(withDeadline(pending, 0), pending);
});

test('fetchWithTimeout: aborts a slow fetch, and passes the response to `read`', async () => {
  const hang = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(fetchWithTimeout(hang, 'https://x.example', {}, 10, r => r), /timeout/);
  const ok = async () => Response.json({ a: 1 });
  assert.deepEqual(await fetchWithTimeout(ok, 'https://x.example', {}, 1000, r => r.json()), { a: 1 });
});

test('pointOf: numeric longitude/latitude from the record or its x/y coordinates, NaN when missing', () => {
  assert.deepEqual(pointOf({ longitude: -80.2, latitude: '26.1' }), { longitude: -80.2, latitude: 26.1 });
  assert.deepEqual(pointOf({ x_coordinates: -80, y_coordinates: 26 }), { longitude: -80, latitude: 26 });
  const empty = pointOf({ longitude: '', latitude: null });
  assert.ok(Number.isNaN(empty.longitude) && Number.isNaN(empty.latitude));
});

test('no module keeps its own timeout or point helper', () => {
  for (const path of ['server/liveDc/eventCapture.mjs', 'server/liveDc/eventWeather.mjs', 'server/liveDc/eventSnapshots.mjs',
    'infra/lambdas/poller/poller.mjs', 'tools/live-dc-apply-update.mjs']) {
    const text = source(path);
    assert.match(text, /from '[./]+(server\/liveDc\/)?timeouts\.mjs'/, path);
    assert.doesNotMatch(text, /new AbortController\(\)|const (withTimeout|withDeadline) =|function fetchWithTimeout/, path);
  }
  const capture = source('server/liveDc/eventCapture.mjs');
  assert.doesNotMatch(capture, /const (pointOf|numberOr) =/);
  assert.match(capture, /pointOf.*from '\.\/eventEnrichment\.mjs'/);
});
