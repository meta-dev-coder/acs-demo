import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTwinUiApi, logLine } from '../src/twinUiApi.js';

describe('twin UI action registry', () => {
  test('view actions run at once and are logged with their own words', async () => {
    const ran = [];
    const ui = createTwinUiApi({ confirm: () => { throw new Error('views are never confirmed'); }, now: () => 1 });
    ui.register('open_camera', { kind: 'view', label: 'Show cameras', run: (p, ctx) => { ran.push([p.entity_id, ctx.source, ctx.button]); return { layersOn: [] }; },
      describe: p => `Fly to camera ${p.entity_id}` });
    const outcome = await ui.run('open_camera', { entity_id: '5036' }, { source: 'answer', button: 'btn' });
    assert.equal(outcome.status, 'ran');
    assert.deepEqual(outcome.result, { layersOn: [] });
    assert.deepEqual(ran, [['5036', 'answer', 'btn']]);
    assert.equal(logLine(outcome.entry), 'Ran: Fly to camera 5036');
    assert.deepEqual(ui.log(), [{ name: 'open_camera', source: 'answer', at: 1, kind: 'view', label: 'Fly to camera 5036', status: 'ran' }]);
    assert.deepEqual(ui.list(), [{ name: 'open_camera', kind: 'view', label: 'Show cameras' }]);
  });

  test('change actions run only after confirmation, and a refusal to confirm is logged as cancelled', async () => {
    const answers = [false, true];
    const asked = [];
    let decided = null;
    const ui = createTwinUiApi({ confirm: async request => { asked.push([request.label, request.anchor]); return answers.shift(); } });
    ui.register('recommendation_decision', { kind: 'change', label: 'Decide', run: p => { decided = p.verdict; return p.verdict; },
      describe: p => `Accept playbook ${p.rule}` });
    const first = await ui.run('recommendation_decision', { rule: 'P3', verdict: 'Accepted' }, { source: 'recommendation', anchor: 'A' });
    assert.equal(first.status, 'cancelled');
    assert.equal(decided, null);
    const second = await ui.run('recommendation_decision', { rule: 'P3', verdict: 'Accepted' }, { source: 'recommendation', anchor: 'A' });
    assert.equal(second.status, 'ran');
    assert.equal(decided, 'Accepted');
    assert.deepEqual(asked, [['Accept playbook P3', 'A'], ['Accept playbook P3', 'A']]);
    assert.deepEqual(ui.log().map(e => e.status), ['cancelled', 'ran']);
  });

  test('without a confirm function a change never runs; a throwing confirm is a no', async () => {
    let ran = false;
    const ui = createTwinUiApi();
    ui.register('set_layer_visible', { kind: 'change', label: 'Switch layer', run: () => { ran = true; } });
    assert.equal((await ui.run('set_layer_visible', { id: 'x', visible: true })).status, 'cancelled');
    const throwing = createTwinUiApi({ confirm: () => { throw new Error('closed'); } });
    throwing.register('c', { kind: 'change', label: 'C', run: () => { ran = true; } });
    assert.equal((await throwing.run('c')).status, 'cancelled');
    assert.equal(ran, false);
  });

  test('false from run is a refusal, a throw is an error, an unknown name is reported; listeners hear every entry', async () => {
    const heard = [];
    const warn = console.warn; console.warn = () => {};
    try {
      const ui = createTwinUiApi({ onLog: e => heard.push(e.status) });
      ui.register('tmc_action', { kind: 'view', label: 'TMC', run: () => false, describe: p => p.label });
      ui.register('boom', { kind: 'view', label: 'Boom', run: () => { throw new Error('no viewer'); } });
      assert.equal((await ui.run('tmc_action', { label: 'Select patrol 9' })).status, 'refused');
      const failed = await ui.run('boom');
      assert.equal(failed.status, 'error');
      assert.equal(logLine(failed.entry), 'Failed: Boom (no viewer)');
      assert.equal((await ui.run('nope')).status, 'unknown');
      assert.deepEqual(heard, ['refused', 'error', 'unknown']);
      assert.equal(logLine(ui.log()[0]), 'Not available: Select patrol 9');
    } finally { console.warn = warn; }
  });

  test('registration is validated, and the returned function unregisters', () => {
    const ui = createTwinUiApi();
    assert.throws(() => ui.register('x', { kind: 'maybe', run() {} }), /kind/);
    assert.throws(() => ui.register('x', { kind: 'view' }), /run/);
    assert.throws(() => ui.register('', { kind: 'view', run() {} }), /name/);
    const off = ui.register('x', { kind: 'view', run() {} });
    assert.ok(ui.has('x'));
    off();
    assert.ok(!ui.has('x'));
  });
});
