import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classSource, createScope, PERSONA_PRESETS, sanitizeSources, scopePrompt, SOURCE_IDS } from '../server/ask/sources.mjs';
import { sanitizeEnvelope } from '../server/ask/envelope.mjs';
import { systemPrompt } from '../server/ask/prompt.mjs';
import { createOrchestrator } from '../server/ask/orchestrator.mjs';
import { createTools, TOOL_DEFINITIONS } from '../server/ask/tools.mjs';
import SOURCES from '../config/askTwin/sources.json' with { type: 'json' };
import { INSIGHT_DEFINITIONS } from '../server/ask/insights.mjs';
import { HISTORICAL_CLASSES, LIVE_CLASS_NAMES } from '../server/liveDc/classes.mjs';

const quiet = { log() {}, warn() {}, error() {} };

test('every live and historical class belongs to exactly one source; presets name real sources and personas', () => {
  for (const name of [...LIVE_CLASS_NAMES, ...HISTORICAL_CLASSES.map(c => c.className)]) assert.ok(classSource(name), `${name} has a source`);
  for (const [persona, ids] of Object.entries(PERSONA_PRESETS)) for (const id of ids) assert.ok(SOURCE_IDS.includes(id), `${persona}: ${id}`);
  assert.deepEqual(PERSONA_PRESETS.executive, SOURCE_IDS, 'the executive preset is the de-siloed view');
  const tools = new Set([...INSIGHT_DEFINITIONS, ...TOOL_DEFINITIONS].map(d => d.name));
  for (const [id, def] of Object.entries(SOURCES.sources)) for (const t of def.tools) assert.ok(tools.has(t) || t === 'prioritize_sites', `${id}: unknown tool ${t}`);
});

test('sources are whitelisted; none or empty means all', () => {
  assert.deepEqual(sanitizeSources(['finance', 'bogus', 'maintenance', 'finance']), ['maintenance', 'finance']);
  assert.equal(sanitizeSources([]), null);
  assert.equal(sanitizeSources('maintenance'), null);
  const env = sanitizeEnvelope({ question: 'q', screen: { persona: 'executive', sources: ['maintenance', 'x'] } });
  assert.deepEqual(env.screen, { persona: 'executive', sources: ['maintenance'] });
});

test('a scope refuses toggled-off tools and classes with a typed gap, and says so in the prompt', () => {
  const scope = createScope(['maintenance']);
  assert.equal(scope.refusal('list_live_events', {}).gap.type, 'out_of_scope');
  assert.match(scope.refusal('query_records', { class_name: 'florida i595 incidents' }).gap.detail, /Safety & crash history/);
  assert.equal(scope.refusal('query_records', { class_name: 'Florida I595 Work Orders' }), null);
  assert.equal(scope.refusal('find_corridor_features', { layer: 'x' }), null, 'corridor layers are always available');
  assert.equal(scope.key, 'maintenance');
  assert.match(scopePrompt(scope), /TOGGLED OFF: Safety & crash history[\s\S]*Tolling & revenue/);
  assert.equal(scopePrompt(createScope(null)), '');
  const classes = [{ className: 'Florida I595 Work Orders', rowCount: 1, asOf: 'x', source: 'snapshot:a', fields: ['a'] }, { className: 'Florida I595 Incidents', rowCount: 1, asOf: 'x', source: 'snapshot:b', fields: ['b'] }];
  const prompt = systemPrompt({ classes, scope });
  assert.match(prompt, /Florida I595 Work Orders \[/);
  assert.doesNotMatch(prompt, /Florida I595 Incidents \[/);
});

test('end to end: a maintenance-only question refuses live events and reports what was toggled off', async () => {
  const store = { classes: () => [], query: () => ({ gap: { type: 'not_ready' } }), count: () => ({ gap: { type: 'not_ready' } }), rows: () => ({ gap: { type: 'not_ready' } }) };
  const tools = createTools({ store, getLiveEvents: async () => { throw new Error('must not be called'); } });
  const responses = [
    { content: [{ type: 'tool_use', id: 't1', name: 'list_live_events', input: {} }], stop_reason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: JSON.stringify({ answer: 'Live events are toggled off.', basis: [], gaps: ['Traffic & live operations is toggled off'], action: { type: 'none', entity_id: null, coordinates: null }, follow_ups: [] }) }], stop_reason: 'end_turn', usage: {} },
  ];
  const requests = [];
  const provider = { name: 's', complete: async r => { requests.push(r); return responses.shift(); } };
  const events = [];
  const answer = await createOrchestrator({ provider, tools, logger: quiet, system: e => systemPrompt({ persona: e.screen.persona, scope: createScope(e.screen.sources) }) })
    .run(sanitizeEnvelope({ question: 'any closures?', screen: { sources: ['maintenance'] } }), e => events.push(e));
  const end = events.find(e => e.type === 'ToolCallEnd');
  assert.equal(end.status, 'gap');
  assert.match(end.detail, /toggled off/);
  assert.match(requests[0].system, /TOGGLED OFF/);
  assert.deepEqual(answer.scope, { used: [], excluded: ['Safety & crash history', 'Traffic & live operations', 'Tolling & revenue'] });
  assert.deepEqual(events.find(e => e.type === 'ContextUsed').sources, ['Maintenance & assets']);
});
