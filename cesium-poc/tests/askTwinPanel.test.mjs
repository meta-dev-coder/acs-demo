import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { activityEntry, activityStep, activitySummary, currentActivity, describeInput, fmtElapsed } from '../src/askTwinActivity.js';
import { clampWidth, DEFAULT_SETTINGS, DEFAULT_WIDTH, loadPrefs, MIN_WIDTH, savePrefs } from '../src/askTwinDock.js';

describe('activity log wording', () => {
  test('context says what travelled with the question', () => {
    assert.equal(activityEntry({ type: 'ContextUsed', workspace: 'tmc', selection: { type: 'incident', id: 'FL511-1' }, temporal: { mode: 'LIVE' }, hasView: true, hasArea: false, historyTurns: 2 }).text,
      'Context sent: TMC screen · incident FL511-1 · live · visible map area · 2 earlier turns');
    assert.equal(activityEntry({ type: 'ContextUsed', historyTurns: 0 }).text, 'Context sent: question only');
  });

  test('a model round shows time, tokens, cache use and what it decided', () => {
    const entry = activityEntry({ type: 'ModelRound', round: 1, ms: 2200, toolCalls: 2,
      usage: { input_tokens: 4210, output_tokens: 180, cache_read_input_tokens: 3900 } });
    assert.equal(entry.text, 'Claude, round 1 · 2.2 s · 4,210 in, 3,900 cached / 180 out → asked for 2 lookups');
    assert.equal(entry.key, activityEntry({ type: 'StepStarted', round: 1 }).key);
    assert.match(activityEntry({ type: 'ModelRound', round: 2, ms: 900, toolCalls: 0, usage: {} }).text, /wrote the answer$/);
  });

  test('a lookup line starts with its ref and inputs, and is replaced by its result', () => {
    const start = activityEntry({ type: 'ToolCallStart', id: 'a', ref: 'R1', name: 'count_records',
      input: { class_name: 'Florida I595 Incidents', filters: [{ field: 'weather', operator: 'equals', value: 'Light Rain' }], group_by: 'Segment' } });
    assert.equal(start.text, 'R1 · Counting records (Florida I595 Incidents · weather = "Light Rain" · by Segment)…');
    assert.equal(start.status, 'running');
    const end = activityEntry({ type: 'ToolCallEnd', id: 'a', ref: 'R1', name: 'count_records', status: 'gap', ms: 4, source: null, detail: 'Unknown class.' });
    assert.equal(end.key, start.key);
    assert.equal(end.text, 'R1 · Counting records · 4 ms — gap: Unknown class.');
    assert.match(activityEntry({ type: 'ToolCallStart', id: 'p', ref: 'R1', name: 'list_live_events', input: {}, origin: 'prefetch' }).text, /before asking Claude/);
  });

  test('checks spell out confidence, unused lookups, gaps and dropped actions', () => {
    const entry = activityEntry({ type: 'Checks', confidence: 'low', reason: '2 lookups ran, but no claim in the answer rests on them.',
      uncited: ['R1', 'R2'], gaps: ['no live express lane status'], actionNote: null });
    assert.equal(entry.text, 'Checked — confidence LOW: 2 lookups ran, but no claim in the answer rests on them. · not used in the answer: R1, R2 · stated gaps: no live express lane status');
    assert.equal(entry.status, 'error');
  });

  test('inputs are described in a few words, and the summary counts the work', () => {
    assert.equal(describeInput('find_corridor_features', { layer: 'i595_corridor_cameras.geojson', near: { lon: -80.25, lat: 26.07, radius_m: 500 } }),
      'corridor_cameras · within 500 m of 26.0700, -80.2500');
    assert.equal(activityEntry({ type: 'Unknown' }), null);
  });
});

describe('activity line and timeline', () => {
  test('the timer shows tenths under a minute, then minutes and seconds', () => {
    assert.equal(fmtElapsed(4210), '4.2 s');
    assert.equal(fmtElapsed(65_400), '1m 05s');
    assert.equal(fmtElapsed(-5), '0.0 s');
  });

  test('the collapsed line says what it is doing now, then a calm summary', () => {
    assert.equal(currentActivity({ type: 'ToolCallStart', name: 'list_live_events' }), 'Reading live FL511 events…');
    assert.equal(currentActivity({ type: 'ToolCallStart', name: 'none' }), 'Looking something up…');
    assert.equal(currentActivity({ type: 'StepStarted', round: 1 }), 'Thinking…');
    assert.equal(currentActivity({ type: 'StepStarted', round: 3, last: true }), 'Writing the answer…');
    assert.equal(currentActivity({ type: 'Checks' }), 'Checking citations…');
    assert.equal(currentActivity({ type: 'ModelNote', round: 1, text: 'x' }), null);
    assert.equal(activitySummary({ running: true, current: 'Thinking…' }), 'Thinking…');
    assert.equal(activitySummary({ lookups: 2, ms: 8900 }), 'Worked for 8.9 s · 2 lookups');
    assert.equal(activitySummary({ lookups: 0, ms: 1200 }), 'Worked for 1.2 s');
    assert.equal(activitySummary({ failed: true, ms: 3100 }), 'Stopped after 3.1 s');
  });

  test('steps put plain words first and the numbers in the detail', () => {
    const round = activityStep({ type: 'ModelRound', round: 2, ms: 2400, toolCalls: 1, usage: { input_tokens: 2, output_tokens: 111, cache_read_input_tokens: 5665 } });
    assert.equal(round.title, 'Decided on 1 lookup');
    assert.equal(round.detail, 'Claude · round 2 · 2.4 s · 2 in, 5,665 cached / 111 out tokens');
    assert.equal(round.key, activityStep({ type: 'StepStarted', round: 2 }).key);
    assert.equal(activityStep({ type: 'ModelRound', round: 3, ms: 900, toolCalls: 0, usage: {} }).title, 'Wrote the answer');
    const tool = activityStep({ type: 'ToolCallEnd', id: 'a', ref: 'R1', name: 'list_live_events', status: 'ok', ms: 581, source: 'DataConnect · Live Events' });
    assert.deepEqual([tool.title, tool.detail, tool.warning], ['Reading live FL511 events', 'R1 · DataConnect · Live Events · 581 ms', undefined]);
    const gap = activityStep({ type: 'ToolCallEnd', id: 'b', ref: 'R2', name: 'count_records', status: 'gap', ms: 4, detail: 'Unknown class.' });
    assert.equal(gap.warning, 'No data: Unknown class.');
    // The input stays on the finished step, so a failed lookup shows what it asked for.
    const near = activityStep({ type: 'ToolCallEnd', id: 'd', ref: 'R3', name: 'records_near', status: 'gap', ms: 25,
      input: { class_name: 'Incidents', place: { layer: 'x', text: 'Turnpike' }, radius_m: 800 }, detail: "Unknown class 'Incidents'." });
    assert.equal(near.detail, 'R3 · Incidents · within 800 m of "Turnpike" · 25 ms');
  });

  test('a call to a tool the twin does not have reads as skipped, not as an error', () => {
    const step = activityStep({ type: 'ToolCallEnd', id: 'c', ref: 'R2', name: 'none', status: 'error', ms: 0, detail: "Unknown tool 'none'." });
    assert.equal(step.title, 'Skipped an invalid lookup');
    assert.equal(step.status, 'skipped');
    assert.equal(step.warning, undefined);
  });

  test('model notes are thoughts grouped under their round; checks keep gaps as a muted warning', () => {
    assert.deepEqual(activityStep({ type: 'ModelNote', round: 2, text: 'Checking the cameras near the crash.' }),
      { key: 'note-2-Checking the cameras nea', kind: 'note', round: 2, title: 'Checking the cameras near the crash.' });
    const checks = activityStep({ type: 'Checks', confidence: 'medium', reason: 'One claim cites nothing.', uncited: ['R2'], gaps: ['no lane status'] });
    assert.equal(checks.title, 'Checked the answer · medium confidence');
    assert.equal(checks.detail, 'One claim cites nothing. · not used in the answer: R2');
    assert.equal(checks.warning, 'Stated gaps: no lane status');
    assert.equal(activityStep({ type: 'RunError', message: 'Out of time.' }).warning, 'Out of time.');
    assert.equal(activityStep({ type: 'AnswerReady' }), null);
  });
});

describe('dock', () => {
  test('width stays between the minimum and half the window; reading mode takes most of it', () => {
    assert.equal(clampWidth(100, 1440), MIN_WIDTH);
    assert.equal(clampWidth(500, 1440), 500);
    assert.equal(clampWidth(1200, 1440), 720);
    assert.equal(clampWidth(500, 1440, { expanded: true }), Math.round(1440 * 0.72));
    assert.equal(clampWidth(500, 600), MIN_WIDTH);
  });

  test('preferences survive a round trip and fall back to defaults when storage is empty, corrupt or blocked', () => {
    const store = new Map();
    const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    assert.deepEqual(loadPrefs(storage), { width: DEFAULT_WIDTH, settings: { ...DEFAULT_SETTINGS } });
    savePrefs({ width: 512, settings: { autoRunMap: false, keepActivityOpen: true } }, storage);
    assert.deepEqual(loadPrefs(storage), { width: 512, settings: { autoRunMap: false, keepActivityOpen: true } });
    store.set('askTwin.panel.v1', '{nope');
    assert.equal(loadPrefs(storage).width, DEFAULT_WIDTH);
    store.set('askTwin.panel.v1', JSON.stringify({ width: 400, settings: { autoRunMap: 'yes', bogus: true } }));
    assert.deepEqual(loadPrefs(storage).settings, { ...DEFAULT_SETTINGS });
    const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.equal(loadPrefs(blocked).width, DEFAULT_WIDTH);
    assert.doesNotThrow(() => savePrefs({ width: 1 }, blocked));
  });
});
