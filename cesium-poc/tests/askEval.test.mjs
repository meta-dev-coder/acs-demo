import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gradeRun } from '../server/ask/evalGrade.mjs';
import { TOOL_DEFINITIONS } from '../server/ask/tools.mjs';
import { INSIGHT_DEFINITIONS } from '../server/ask/insights.mjs';
import { SNAPSHOT_CLASSES } from '../server/ask/twinStore.mjs';
import { HISTORICAL_CLASSES, LIVE_CLASS_NAMES } from '../server/liveDc/classes.mjs';
import { parseArgs } from '../tools/ask-eval.mjs';

const evals = JSON.parse(readFileSync(new URL('../config/askTwin/evals.json', import.meta.url), 'utf8'));
const TOOLS = new Set([...TOOL_DEFINITIONS, ...INSIGHT_DEFINITIONS].map(d => d.name));

test('every verified question names real tools and a class the twin holds', () => {
  const ids = evals.questions.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const classNames = [...SNAPSHOT_CLASSES.map(c => c.className), ...HISTORICAL_CLASSES.map(c => c.className),
    ...LIVE_CLASS_NAMES];
  for (const q of evals.questions) {
    for (const name of [...(q.expect.tools ?? []), ...(q.expect.mustNotUse ?? [])]) assert.ok(TOOLS.has(name), `${q.id}: unknown tool ${name}`);
    if (q.expect.classIncludes) assert.ok(classNames.some(c => c.includes(q.expect.classIncludes)), `${q.id}: no class contains ${q.expect.classIncludes}`);
    assert.ok(q.question.length <= 512);
  }
});

const run = (answer, events = []) => ({ answer, events: [...events, { type: 'ModelRound', round: 2 }] });

test('grading: tools, class, confidence, gaps, text, blocks and the round budget', () => {
  const events = [{ type: 'ToolCallStart', name: 'count_records', input: { class_name: 'Florida I595 Incidents' } }];
  const good = gradeRun(run({ answer: '30 incidents in light rain.', confidence: 'high', gaps: [], blocks: [{}] }, events),
    { tools: ['count_records'], classIncludes: 'Incidents', minConfidence: 'medium', answerMatches: '\\d', blocks: true, maxRounds: 3, mustNotUse: ['records_near'] });
  assert.deepEqual(good.failures, []);
  const bad = gradeRun(run({ answer: '', confidence: 'low', gaps: [] }, [{ type: 'ToolCallStart', name: 'records_near', input: {} }]),
    { tools: ['count_records'], classIncludes: 'Incidents', minConfidence: 'medium', answerMatches: '\\d', blocks: true, maxRounds: 1, mustNotUse: ['records_near'], gaps: true });
  assert.equal(bad.passed, false);
  assert.equal(bad.failures.length, 9);
  assert.match(gradeRun({ answer: null, events: [{ type: 'RunError', message: 'empty answer' }] }, {}).failures[0], /no answer: empty answer/);
  assert.equal(gradeRun(run({ answer: 'No live express data.', confidence: 'high', gaps: ['express status'] }), { maxConfidence: 'medium' }).passed, false);
  // allowGap: a typed gap (e.g. no live feed) excuses the confidence floor.
  assert.equal(gradeRun(run({ answer: 'No live feed.', confidence: 'low', gaps: [] }, [{ type: 'ToolCallStart', name: 'rank_incidents', input: {} }, { type: 'ToolCallEnd', status: 'gap' }]),
    { tools: ['rank_incidents'], minConfidence: 'medium', allowGap: true }).passed, true);
});

test('ask-eval arguments', () => {
  assert.deepEqual(parseArgs(['--only', 'a, b']).only, ['a', 'b']);
  assert.match(parseArgs(['--replay', 'x.json']).replay, /x\.json$/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});
