import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTUP_STAGES, createI595StartupSequence, createTween, easeInOutCubic, enableLayerCheckbox } from '../src/i595StartupSequence.js';

/**
 * A tween driven by a fake clock that advances itself: each scheduled frame jumps a quarter of the
 * fade and runs as a microtask, so a fade completes deterministically with no real timers.
 */
const fakeTween = fadeMs => {
  let time = 0;
  return createTween({ now: () => time, schedule: step => { time += fadeMs / 4; queueMicrotask(step); } });
};

/** Records what each stage did, in order. */
function harness({ fail = new Set(), fadeMs = 100 } = {}) {
  const log = [], opacity = { mainline: [], express: [], markers: [] };
  const guard = name => (fail.has(name) ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve());
  const layer = name => ({
    enable: () => { log.push(`${name}:enable`); return guard(name); },
    setOpacity: alpha => opacity[name].push(alpha),
  });
  const sequence = createI595StartupSequence({
    base3d: { load: () => { log.push('base3d'); return guard('base3d'); } },
    camera: { flyToCorridor: () => { log.push('fly'); return guard('fly'); } },
    mainline: layer('mainline'),
    express: layer('express'),
    markers: { setOpacity: alpha => opacity.markers.push(alpha) },
    fadeMs, tween: fakeTween(fadeMs), onStage: stage => log.push(`stage:${stage}`), logger: { error() {} },
  });
  return { sequence, log, opacity, run: () => sequence.run() };
}

test('the six stages run in the documented order', async () => {
  assert.deepEqual([...STARTUP_STAGES],
    ['BASE_3D', 'FLY_TO_CORRIDOR', 'MAINLINE', 'EXPRESS', 'MARKERS']);
  const { log, run } = harness();
  const result = await run();
  assert.deepEqual(result.completed, [...STARTUP_STAGES]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(log.filter(entry => entry.startsWith('stage:')),
    [...STARTUP_STAGES.map(stage => `stage:${stage}`), 'stage:READY']);
  // Base world before the flight, then the roads, then their labelling. Nothing else is switched on.
  assert.deepEqual(log.filter(entry => !entry.startsWith('stage:')),
    ['base3d', 'fly', 'mainline:enable', 'express:enable']);
});

test('every faded layer starts invisible and ends fully opaque', async () => {
  const { opacity, run } = harness();
  await run();
  for (const [name, steps] of Object.entries(opacity)) {
    assert.equal(steps[0], 0, `${name} must start invisible`);
    assert.equal(steps.at(-1), 1, `${name} must end fully opaque`);
    assert.ok(steps.length > 2, `${name} must fade rather than snap on`);
    assert.ok(steps.every(value => value >= 0 && value <= 1), `${name} opacity stayed in range`);
    // Monotonic: a fade never dips back down.
    assert.deepEqual(steps, [...steps].sort((a, b) => a - b), `${name} must fade in one direction`);
  }
});

test('a failed stage is reported and the rest still run', async () => {
  const { log, opacity, run } = harness({ fail: new Set(['base3d', 'express']) });
  const result = await run();
  assert.deepEqual(result.failures.map(failure => failure.stage), ['BASE_3D', 'EXPRESS']);
  assert.deepEqual(result.completed, ['FLY_TO_CORRIDOR', 'MAINLINE', 'MARKERS']);
  assert.ok(log.includes('fly'), 'a missing 3D world must not stop the flight');
  assert.equal(opacity.markers.at(-1), 1, 'a failed express stage must not hold back the markers');
});

test('the intro never switches on the optional overlays', async () => {
  const { log, run } = harness();
  await run();
  // CCTV, signals, live events, ramps, frontage and bridges are Map Explorer's business, not the
  // opening scene's: the sequence has no capability that could turn them on.
  assert.ok(log.every(entry => !entry.includes('overlay')));
  assert.deepEqual(log.filter(entry => entry.endsWith(':enable')), ['mainline:enable', 'express:enable']);
});

test('the sequence runs at most once per page', async () => {
  const { sequence, log, run } = harness();
  const first = sequence.run();
  assert.equal(sequence.run(), first, 'a second call returns the run already in flight');
  await run();
  await sequence.run();
  assert.equal(log.filter(entry => entry === 'base3d').length, 1);
});

test('easing is smooth, bounded and anchored at both ends', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  const samples = [...Array(21)].map((_, i) => easeInOutCubic(i / 20));
  assert.deepEqual(samples, [...samples].sort((a, b) => a - b), 'easing must be monotonic');
  assert.ok(samples.every(value => value >= 0 && value <= 1));
});

test('a zero-length fade still lands on full opacity without scheduling a frame', async () => {
  let scheduled = 0;
  const tween = createTween({ now: () => 0, schedule: () => { scheduled++; } });
  const steps = [];
  await tween(0, value => steps.push(value));
  assert.deepEqual(steps, [1]);
  assert.equal(scheduled, 0);
});

test('enableLayerCheckbox waits for the control, then switches it on once', async () => {
  let time = 0, changes = 0;
  const input = { id: 'x', disabled: true, checked: false, onchange: () => { changes++; } };
  const options = { wait: async () => { time += 100; input.disabled = time >= 300; }, now: () => time };
  await enableLayerCheckbox(input, options);
  assert.equal(input.checked, true);
  assert.equal(changes, 1);
  // Already on: no second change event, so a layer is never reloaded or toggled off.
  await enableLayerCheckbox(input, options);
  assert.equal(changes, 1);
});

test('enableLayerCheckbox gives up on a control that never arrives', async () => {
  let time = 0;
  const input = { id: 'never', disabled: true, checked: false };
  await assert.rejects(
    () => enableLayerCheckbox(input, { timeoutMs: 500, wait: async () => { time += 100; }, now: () => time }),
    /"never" never became available/);
  assert.equal(input.checked, false);
  await assert.rejects(() => enableLayerCheckbox(null), /No layer control/);
});
