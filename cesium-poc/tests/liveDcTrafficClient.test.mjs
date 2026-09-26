/**
 * Browser side of the DataConnect live-events source: which URL the shared live-event layer asks
 * for, and how Traffic, Safety, Live Ops and the layer status line name the source they got.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DC_NOT_CONNECTED, liveEventNotice, liveEventSourceName, liveEventSourceNote, liveEventStatusText, liveEventsEndpoint,
} from '../src/liveEventsData.js';
import { WARNING_ICON, sourceLabelText } from '../src/workspaceStrip.js';
import { liveDcEnabled } from '../src/maintenance/liveDcSource.js';

const DC = { source: 'DataConnect', sourceLabel: 'FL511 via DataConnect', sourceStatus: 'LIVE', bufferMeters: 250, counts: { total: 2 } };
const DC_DOWN = {
  source: 'DataConnect', sourceStatus: 'UNAVAILABLE', lastUpdated: null, bufferMeters: 250, counts: { total: 0 }, events: [],
  diagnostics: { lastError: 'Live DataConnect is unavailable.' },
};
const DIRECT = { source: 'FL511', sourceStatus: 'LIVE', bufferMeters: 250, counts: { total: 1 } };

test('asks for the DataConnect source only when live DataConnect is enabled', () => {
  assert.equal(liveEventsEndpoint('/api/i595/live-events', true), '/api/i595/live-events?source=dataconnect');
  assert.equal(liveEventsEndpoint('/api/i595/live-events', false), '/api/i595/live-events');
  assert.equal(liveEventsEndpoint('https://x.cloudfront.net/api/i595/live-events?k=1', true),
    'https://x.cloudfront.net/api/i595/live-events?k=1&source=dataconnect');
});

test('the flag follows liveDcSource semantics: off in a plain production build, on with ?live=1', () => {
  assert.equal(liveDcEnabled({ search: '', env: {} }), false);
  assert.equal(liveDcEnabled({ search: '?live=1', env: {} }), true);
  assert.equal(liveDcEnabled({ search: '?live=0', env: { DEV: true } }), false);
  assert.equal(liveEventsEndpoint('/api/i595/live-events', liveDcEnabled({ search: '', env: {} })), '/api/i595/live-events');
});

test('names the source: via DataConnect, or plain FL511 as today', () => {
  assert.equal(liveEventSourceName(DC), 'FL511 via DataConnect');
  assert.equal(liveEventSourceName(DIRECT), 'FL511');
  assert.equal(liveEventSourceName(undefined), 'FL511');
});

test('Traffic and Safety strips show the source label', () => {
  assert.deepEqual(liveEventSourceNote(DC), { text: 'FL511 via DataConnect · live', live: true });
  assert.deepEqual(liveEventSourceNote(DIRECT), { text: 'FL511 · live', live: true }, 'unchanged without a label');
});

test('the layer status line carries the label; the direct feed reads exactly as before', () => {
  assert.equal(liveEventStatusText(DC), '2 live events within 250 m · live · FL511 via DataConnect');
  assert.equal(liveEventStatusText(DIRECT), '1 live event within 250 m · live');
});

test('a stale DataConnect read blames the sync, not FL511', () => {
  const notice = liveEventNotice({ ...DC, sourceStatus: 'STALE', dataFreshness: { ageSeconds: 1800 } });
  assert.match(notice, /DataConnect/);
  assert.doesNotMatch(notice, /FL511 is not responding/);
  assert.match(liveEventNotice({ ...DIRECT, sourceStatus: 'STALE' }), /FL511 is not responding/);
});

test('DataConnect UNAVAILABLE: the Traffic/Safety/Live Ops label is a warning "DataConnect not connected" with the reason', () => {
  const note = { text: DC_NOT_CONNECTED, live: false, warning: true, title: 'Live DataConnect is unavailable.' };
  assert.equal(DC_NOT_CONNECTED, 'DataConnect not connected');
  assert.deepEqual(liveEventSourceNote(DC_DOWN), note, 'Safety and Traffic use the shared helper');
  const noReason = liveEventSourceNote({ ...DC_DOWN, diagnostics: {} });
  assert.equal(noReason.text, DC_NOT_CONNECTED);
  assert.equal(noReason.title, DC_NOT_CONNECTED);
});

test('connected, not connected, recovered: the label follows each payload', () => {
  const states = [DC, DC_DOWN, DC].map(liveEventSourceNote);
  assert.deepEqual(states, [
    { text: 'FL511 via DataConnect · live', live: true },
    { text: DC_NOT_CONNECTED, live: false, warning: true, title: 'Live DataConnect is unavailable.' },
    { text: 'FL511 via DataConnect · live', live: true },
  ]);
  assert.deepEqual(liveEventSourceNote({ ...DC, sourceStatus: 'STALE' }), { text: 'FL511 via DataConnect · stale', live: false });
});

test('the direct feed is never labelled as a DataConnect connection problem', () => {
  assert.deepEqual(liveEventSourceNote({ source: 'FL511', sourceStatus: 'UNAVAILABLE' }), { text: 'FL511', live: false });
  assert.deepEqual(liveEventSourceNote(DIRECT), { text: 'FL511 · live', live: true });
});

test('the strip renders a warning icon before the text, and the live dot otherwise', () => {
  assert.equal(sourceLabelText(DC_NOT_CONNECTED, { warning: true }), `${WARNING_ICON} DataConnect not connected`);
  assert.equal(sourceLabelText('FL511 via DataConnect · live'), 'FL511 via DataConnect · live ●');
  assert.equal(sourceLabelText(''), '');
});

test('the layer status line and notice say DataConnect is not connected, never that FL511 is', () => {
  assert.match(liveEventStatusText(DC_DOWN), /DataConnect not connected/);
  assert.doesNotMatch(liveEventStatusText(DC_DOWN), /FL511 unavailable/);
  const notice = liveEventNotice(DC_DOWN);
  assert.match(notice, /DataConnect is not connected/);
  assert.match(notice, /Live DataConnect is unavailable\./);
  assert.equal(liveEventStatusText({ ...DIRECT, sourceStatus: 'UNAVAILABLE' }), 'FL511 unavailable — no live events cached yet.');
});
