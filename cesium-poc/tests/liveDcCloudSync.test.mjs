import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudSyncNote, liveDcStatusUrl, watchCloudSync } from '../src/liveDcCloudSync.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const at = secondsAgo => new Date(NOW - secondsAgo * 1000).toISOString();

test('status URL: explicit override, else the CloudFront origin of the live-events API, else none', () => {
  assert.equal(liveDcStatusUrl({ VITE_LIVE_DC_STATUS_URL: 'https://x.example/s.json' }), 'https://x.example/s.json');
  assert.equal(liveDcStatusUrl({ VITE_LIVE_EVENTS_API: 'https://d1.cloudfront.net/api/i595/live-events' }),
    'https://d1.cloudfront.net/status/live-dc-status.json');
  assert.equal(liveDcStatusUrl({ VITE_LIVE_EVENTS_API: '/api/i595/live-events' }), null);
  assert.equal(liveDcStatusUrl({}), null);
  assert.equal(liveDcStatusUrl(undefined), null);
});

test('note: there is no sign-in state any more; old token reasons read as plain error/off', () => {
  for (const reason of ['no_token', 'token_expired', 'token_unreadable', 'token_rejected', 'credentials_unavailable']) {
    const dcWrite = reason === 'no_token' ? 'skipped' : 'error';
    const note = cloudSyncNote({ lastRunAt: at(30), dcWrite, reason }, { now: NOW });
    assert.notEqual(note.text, 'Cloud sync: needs sign-in');
    assert.ok(!/dc:login|sign-in/i.test(note.title));
    assert.equal(note.text, dcWrite === 'error' ? 'Cloud sync: error' : 'Cloud sync: off');
  }
});

test('note: ok, error, not configured and a silent poller', () => {
  assert.deepEqual(cloudSyncNote({ lastRunAt: at(30), dcWrite: 'ok' }, { now: NOW }),
    { text: 'Cloud sync: on', warning: false, title: `Last DataConnect write ${at(30)}` });
  const error = cloudSyncNote({ lastRunAt: at(30), dcWrite: 'error', reason: 'HTTP 500' }, { now: NOW });
  assert.equal(error.text, 'Cloud sync: error');
  assert.equal(error.warning, true);
  assert.equal(error.title, 'HTTP 500');
  assert.equal(cloudSyncNote({ lastRunAt: at(30), dcWrite: 'skipped', reason: 'not_configured' }, { now: NOW }).text, 'Cloud sync: off');
  const silent = cloudSyncNote({ lastRunAt: at(600), dcWrite: 'ok' }, { now: NOW });
  assert.equal(silent.text, 'Cloud sync: not running');
  assert.equal(silent.warning, true);
});

test('note: nothing to say without a readable status', () => {
  assert.equal(cloudSyncNote(null, { now: NOW }), null);
  assert.equal(cloudSyncNote({}, { now: NOW }), null);
  assert.equal(cloudSyncNote('nope', { now: NOW }), null);
});

test('watch: no URL means no fetch; otherwise fetches now and on the interval, reporting notes', async () => {
  let fetches = 0;
  const stopNone = watchCloudSync({ url: null, fetchImpl: async () => { fetches++; }, onChange: () => {} });
  stopNone();
  assert.equal(fetches, 0);

  const notes = [];
  const timers = [];
  const stop = watchCloudSync({
    url: 'https://d1.cloudfront.net/status/live-dc-status.json',
    fetchImpl: async (url, init) => {
      fetches++;
      assert.equal(init.cache, 'no-store');
      return new Response(JSON.stringify({ lastRunAt: at(10), dcWrite: 'ok', reason: null }));
    },
    onChange: note => notes.push(note),
    now: () => NOW,
    setIntervalImpl: (fn, ms) => { timers.push({ fn, ms }); return 1; },
    clearIntervalImpl: () => { timers.length = 0; },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fetches, 1);
  assert.equal(notes.at(-1).text, 'Cloud sync: on');
  timers[0].fn();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fetches, 2);
  stop();
  assert.equal(timers.length, 0);
});

test('watch: an unreachable status reads as nothing, not as an error banner', async () => {
  const notes = [];
  const stop = watchCloudSync({
    url: 'https://d1.cloudfront.net/status/live-dc-status.json',
    fetchImpl: async () => new Response('nope', { status: 403 }),
    onChange: note => notes.push(note),
    setIntervalImpl: () => 1, clearIntervalImpl: () => {},
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(notes, [null]);
  stop();
});

test('cloud sync: a status with a longer intervalSeconds (EC2 host, 300 s) is not reported silent between cycles', () => {
  assert.equal(cloudSyncNote({ lastRunAt: at(330), dcWrite: 'ok', intervalSeconds: 300 }, { now: NOW }).text, 'Cloud sync: on');
  assert.equal(cloudSyncNote({ lastRunAt: at(3 * 300 + 121), dcWrite: 'ok', intervalSeconds: 300 }, { now: NOW }).text, 'Cloud sync: not running');
  assert.equal(cloudSyncNote({ lastRunAt: at(330), dcWrite: 'ok', intervalSeconds: 'x' }, { now: NOW }).text, 'Cloud sync: not running');
});
