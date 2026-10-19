/**
 * A compound question is answered in the browser only when at least two of its steps can run on the
 * current screen. Otherwise it goes to the model: "camera" plans the TMC upstream check everywhere,
 * and a Maintenance question used to get "only on the tmc screen" and a bare work-order count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCompoundQuestion, planFor, runnablePlan } from '../src/twin/orchestrator.js';

const REGISTRY = {
  analyze_upstream_protection: { screens: ['tmc'] },
  get_incident_analysis: { screens: ['tmc'] },
  search_work_orders: { screens: ['*'] },
  get_asset_history: { screens: ['*'] },
};
const QUESTION = 'Which camera sites have open work orders, and in what order should we fix them first-in-first-out?';

test('the camera work-order question is compound, but only one step runs off the TMC screen', () => {
  assert.equal(isCompoundQuestion(QUESTION), true);
  assert.deepEqual(planFor(QUESTION), ['analyze_upstream_protection', 'search_work_orders']);
  assert.deepEqual(runnablePlan(planFor(QUESTION), REGISTRY, { screen: 'maintenance' }), ['search_work_orders']);
});

test('on the TMC screen both steps still run locally', () => {
  assert.deepEqual(runnablePlan(planFor(QUESTION), REGISTRY, { screen: 'tmc' }), ['analyze_upstream_protection', 'search_work_orders']);
});

test('unknown capabilities are dropped', () => {
  assert.deepEqual(runnablePlan(['nope', 'search_work_orders'], REGISTRY, { screen: 'maintenance' }), ['search_work_orders']);
});
