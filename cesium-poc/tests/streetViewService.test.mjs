import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLookupFailure, formatImageryDate } from '../src/streetViewService.js';

const failure = status => new Error(`GoogleStreetViewCubeMapPanoramaProvider metadata error: ${status}`);

test('"no panorama here" is an answer, not a fault', () => {
  for (const status of ['ZERO_RESULTS', 'NOT_FOUND']) {
    const result = classifyLookupFailure(failure(status));
    assert.equal(result.status, 'none', `${status} means the corridor simply has no imagery there`);
    assert.match(result.message, /isn’t available near this location/);
    // Nothing raw from Google reaches the user.
    assert.ok(!result.message.includes(status));
  }
});

test('key, quota and request problems are told apart and explained plainly', () => {
  const denied = classifyLookupFailure(failure('REQUEST_DENIED'));
  assert.equal(denied.status, 'unavailable');
  assert.match(denied.message, /not enabled for this map key/);
  const quota = classifyLookupFailure(failure('OVER_QUERY_LIMIT'));
  assert.equal(quota.status, 'unavailable');
  assert.match(quota.message, /quota/);
  // Each keeps the technical status for the log, without putting it on screen.
  assert.equal(denied.reason, 'REQUEST_DENIED');
  assert.equal(quota.reason, 'OVER_QUERY_LIMIT');
});

test('an unrecognised or network failure still yields a usable message', () => {
  for (const error of [failure('UNKNOWN_ERROR'), new Error('NetworkError when fetching'), undefined, null]) {
    const result = classifyLookupFailure(error);
    assert.equal(result.status, 'unavailable');
    assert.ok(result.message.length > 0);
    assert.ok(!/undefined|null|\[object/.test(result.message));
  }
});

test('imagery dates read as dates, and never as a live timestamp', () => {
  assert.equal(formatImageryDate('2016-12'), 'Dec 2016');
  assert.equal(formatImageryDate('2026-02'), 'Feb 2026');
  // Anything Google does not supply in the expected shape shows nothing at all.
  for (const value of ['', undefined, null, '2016', 'yesterday', '2016-13-99']) {
    assert.equal(formatImageryDate(value), null, `"${value}" must not be presented as a date`);
  }
});
