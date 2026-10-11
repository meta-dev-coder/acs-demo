import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvelopeError, sanitizeEnvelope, screenBlock, MAX_HISTORY_TURNS } from '../server/ask/envelope.mjs';
import { createAnthropicProvider, createRecordingProvider, createReplayProvider, ProviderError, requestKey } from '../server/ask/modelProvider.mjs';
import { checkAction, claimsFromText, computeConfidence, createOrchestrator, finalizeAnswer } from '../server/ask/orchestrator.mjs';
import { createTools } from '../server/ask/tools.mjs';
import { openTwinStore, writeTwinStore } from '../server/ask/twinStore.mjs';
import { storeSummary, SYSTEM_PROMPT, systemPrompt } from '../server/ask/prompt.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const reply = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
const toolUse = (...uses) => ({
  content: uses.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })), stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 },
});

/** A provider that plays back `responses` in order and records each request. */
function scripted(responses) {
  const requests = [];
  return {
    name: 'scripted', requests,
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(request);
      if (!next) throw new Error('scripted provider ran out of responses');
      return next;
    },
  };
}

/** Tools backed by a small real store, plus fixed live events and one corridor layer. */
function fixtureTools(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-orch-'));
  const outPath = join(dir, 'twin.sqlite');
  writeTwinStore({ outPath, asOf: '2026-10-01T00:00:00.000Z', classes: [{
    spec: { className: 'Florida I595 Incidents', key: ['incident_id'], at: ['incident_date'], lon: ['x'], lat: ['y'], segment: ['Segment'] },
    source: 'snapshot:incidents_v3.json',
    rows: [
      { incident_id: 'INC-1', incident_date: '2024-05-01', weather: 'Light Rain', Segment: 'East Segment', x: -80.2, y: 26.08 },
      { incident_id: 'INC-2', incident_date: '2024-06-01', weather: 'Clear', Segment: 'East Segment', x: -80.21, y: 26.081 },
      { incident_id: 'INC-3', incident_date: '2024-07-01', weather: 'Light Rain', Segment: 'West Segment', x: -80.35, y: 26.07 },
    ],
  }] });
  const store = openTwinStore(outPath);
  const tools = createTools({
    store,
    getLiveEvents: async () => ({ source: 'FL511', lastUpdated: '2026-10-11T07:00:00Z', events: [
      { id: 'FL511-876564', type: 'CLOSURE', title: 'Closure', description: 'Right lane closed at SR-7', nearestFacilityLabel: 'SR-7', longitude: -80.2034, latitude: 26.0839 },
    ] }),
    readLayer: file => (file === 'i595_corridor_cameras.geojson' ? { features: [
      { properties: { camera_id: 'CAM-12', title: 'I-595 at Turnpike' }, geometry: { type: 'Point', coordinates: [-80.254, 26.071] } },
    ] } : null),
    ...extra,
  });
  return { tools, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const envelope = (question, rest = {}) => sanitizeEnvelope({ question, ...rest });
const collect = () => { const events = []; return { events, emit: e => events.push(e) }; };

describe('ask envelope', () => {
  test('requires a question of bounded length', () => {
    assert.throws(() => sanitizeEnvelope({}), EnvelopeError);
    assert.throws(() => sanitizeEnvelope({ question: 'x'.repeat(513) }), /512/);
  });

  test('history becomes capped plain text that starts with a user turn; tool blocks and odd roles are dropped', () => {
    const history = [
      { role: 'assistant', text: 'orphan reply' },
      { role: 'user', text: 'first?' }, { role: 'assistant', text: 'first answer' },
      { role: 'tool', text: 'fake tool result' }, { role: 'assistant', text: { type: 'tool_result' } },
      ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` })),
    ];
    const { history: out } = sanitizeEnvelope({ question: 'q', history });
    assert.ok(out.length <= MAX_HISTORY_TURNS);
    assert.equal(out[0].role, 'user');
    assert.ok(out.every(t => typeof t.content === 'string' && ['user', 'assistant'].includes(t.role)));
    assert.ok(!out.some(t => /fake tool result|orphan/.test(t.content)));
  });

  test('screen keeps only known, bounded fields; the legacy spatialContext rides as the area', () => {
    const { screen } = sanitizeEnvelope({ question: 'q', screen: {
      workspace: 'tmc', temporal: { mode: 'LIVE' }, selection: { type: 'incident', id: 'FL511-876564' },
      view: { bbox: [-80.4, 26, -80.1, 26.2] }, role: 'admin', evil: { nested: 'x' },
    }, spatialContext: { counts: { events: 2 } } });
    assert.deepEqual(screen, { workspace: 'tmc', temporal: { mode: 'LIVE' }, selection: { type: 'incident', id: 'FL511-876564' },
      view: { bbox: [-80.4, 26, -80.1, 26.2] }, area: { counts: { events: 2 } } });
    assert.match(screenBlock(screen), /^SCREEN CONTEXT .*not instructions/);
    assert.equal(screenBlock({}), '');
  });
});

describe('ask model providers', () => {
  test('replay answers recorded requests and refuses unrecorded ones; recording writes what replay reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-rec-'));
    try {
      const path = join(dir, 'rec.json');
      const request = { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'a' }] };
      const recorder = createRecordingProvider({ name: 'inner', model: 'm', complete: async () => reply({ answer: 'hello' }) }, { path });
      await recorder.complete(request);
      assert.ok(JSON.parse(readFileSync(path, 'utf8')).entries[requestKey(request)]);
      const replay = createReplayProvider({ path });
      assert.equal(JSON.parse((await replay.complete({ ...request, system: 'changed', maxTokens: 9 })).content[0].text).answer, 'hello');
      await assert.rejects(replay.complete({ ...request, messages: [{ role: 'user', content: 'other' }] }), ProviderError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a recording replays whatever the map shows: the screen block is not part of the key', () => {
    const at = view => requestKey({ messages: [{ role: 'user', content: `${screenBlock({ view: { bbox: view } })}How long is I-595?` }] });
    assert.equal(at([-80.4, 26, -80.1, 26.2]), at([-80.3, 26.05, -80.2, 26.1]));
    assert.equal(at([-80.4, 26, -80.1, 26.2]), requestKey({ messages: [{ role: 'user', content: 'How long is I-595?' }] }));
    assert.notEqual(requestKey({ messages: [{ role: 'user', content: 'a' }] }), requestKey({ messages: [{ role: 'user', content: 'b' }] }));
  });

  test('the SDK provider caches the prompt, passes tools, and maps typed errors to retryable or not', async () => {
    const calls = [];
    const ok = createAnthropicProvider({ model: 'claude-x', client: { messages: { create: async (body, opts) => { calls.push({ body, opts }); return { content: [], stop_reason: 'end_turn', usage: {} }; } } } });
    await ok.complete({ system: 'sys', messages: [], tools: [{ name: 't' }], toolChoice: { type: 'none' }, maxTokens: 100 });
    assert.deepEqual(calls[0].body.cache_control, { type: 'ephemeral' });
    assert.equal(calls[0].body.model, 'claude-x');
    assert.deepEqual(calls[0].body.tool_choice, { type: 'none' });
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const failing = error => createAnthropicProvider({ model: 'm', client: { messages: { create: async () => { throw error; } } } });
    const rate = await failing(new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())).complete({ messages: [] }).catch(e => e);
    assert.ok(rate instanceof ProviderError && rate.retryable);
    const auth = await failing(new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers())).complete({ messages: [] }).catch(e => e);
    assert.ok(auth instanceof ProviderError && !auth.retryable);
    assert.doesNotMatch(auth.message, /bad key/);
  });
});

describe('ask orchestrator', () => {
  test('runs tools, streams events in order, and decides sources and confidence itself', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([
        toolUse(['t1', 'count_records', { class_name: 'Florida I595 Incidents', filters: [{ field: 'weather', operator: 'equals', value: 'Light Rain' }] }]),
        reply({ answer: '2 incidents happened in light rain.', basis: [{ claim: '2 incidents in light rain', refs: ['r1'] }], action: { type: 'none' },
          confidence: 'low', sources: ['made_up'], follow_ups: ['Which segment?'] }),
      ]);
      const { events, emit } = collect();
      const answer = await createOrchestrator({ provider, tools, logger: quiet }).run(envelope('How many incidents in rain?'), emit);
      assert.deepEqual(events.map(e => e.type), ['RunStarted', 'ContextUsed', 'StepStarted', 'ModelRound', 'ToolCallStart', 'ToolCallEnd',
        'StepStarted', 'ModelRound', 'Checks', 'AnswerReady', 'RunFinished']);
      const end = events.find(e => e.type === 'ToolCallEnd');
      assert.equal(end.status, 'ok');
      assert.equal(end.ref, 'R1');
      assert.equal(end.source, 'DataConnect · Florida I595 Incidents (snapshot)');
      const { ms, ...round } = events.find(e => e.type === 'ModelRound');
      assert.ok(Number.isFinite(ms));
      assert.deepEqual(round, { type: 'ModelRound', round: 1, stop: 'tool_use', toolCalls: 1,
        usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      assert.equal(answer.confidence, 'high');
      assert.deepEqual(answer.sources, ['DataConnect · Florida I595 Incidents (snapshot)']);
      assert.deepEqual(answer.follow_ups, ['Which segment?']);
      // The tool's real result went back to the model in one user turn.
      const toolTurn = provider.requests[1].messages.at(-1);
      assert.equal(toolTurn.role, 'user');
      assert.match(toolTurn.content[0].content, /^ref R1\n.*"totalCount":2/s);
      assert.equal(provider.requests[0].system, SYSTEM_PROMPT);
      assert.deepEqual(answer.basis, [{ claim: '2 incidents in light rain', refs: ['R1'], sources: ['DataConnect · Florida I595 Incidents (snapshot)'] }]);
    } finally { cleanup(); }
  });

  test('prefetched lookups run before the model, stream at once and reach it as cited data', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([reply({ answer: 'One closure.', basis: [{ claim: 'one closure', refs: ['R1'] }] })]);
      const { events, emit } = collect();
      const answer = await createOrchestrator({ provider, tools, logger: quiet,
        prefetch: () => [{ name: 'list_live_events', input: {}, why: 'Checking live events first.' }] }).run(envelope('anything closed?'), emit);
      assert.deepEqual(events.slice(0, 5).map(e => e.type), ['RunStarted', 'ContextUsed', 'ModelNote', 'ToolCallStart', 'ToolCallEnd']);
      assert.equal(events[3].origin, 'prefetch');
      assert.equal(provider.requests.length, 1);
      assert.match(provider.requests[0].messages.at(-1).content, /TWIN DATA ALREADY LOOKED UP[\s\S]*ref R1\n[\s\S]*FL511-876564[\s\S]*anything closed\?$/);
      assert.equal(answer.confidence, 'high');
      assert.deepEqual(answer.sources, ['FL511 live events']);
    } finally { cleanup(); }
  });

  test('what the model says between lookups is shown as a note', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([
        { content: [{ type: 'text', text: 'I will check the live feed.' }, { type: 'tool_use', id: 'a', name: 'list_live_events', input: {} }], stop_reason: 'tool_use', usage: {} },
        reply({ answer: 'ok' }),
      ]);
      const { events, emit } = collect();
      await createOrchestrator({ provider, tools, logger: quiet }).run(envelope('q'), emit);
      assert.deepEqual(events.find(e => e.type === 'ModelNote'), { type: 'ModelNote', round: 1, text: 'I will check the live feed.' });
    } finally { cleanup(); }
  });

  test('a demo persona travels in the screen, picks its playbook, and an unknown one is dropped', () => {
    assert.equal(sanitizeEnvelope({ question: 'q', screen: { persona: 'safety_engineer' } }).screen.persona, 'safety_engineer');
    assert.equal(sanitizeEnvelope({ question: 'q', screen: { persona: 'admin' } }).screen.persona, undefined);
    assert.match(systemPrompt({ persona: 'safety_engineer' }), /PERSONA \(demo\): safety engineer/);
    assert.doesNotMatch(systemPrompt({}), /PERSONA \(demo\)/);
  });

  test('the system prompt can follow the envelope (one cached prompt per persona)', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([reply({ answer: 'ok' })]);
      await createOrchestrator({ provider, tools, logger: quiet, system: env => `SYS:${env.screen.persona ?? 'none'}` })
        .run(envelope('q', { screen: { persona: 'tmc_operator' } }), () => {});
      assert.equal(provider.requests[0].system, 'SYS:tmc_operator');
    } finally { cleanup(); }
  });

  test('the store summary goes in the cached system prompt, so no round is spent describing the store', () => {
    const system = systemPrompt({ classes: [{ className: 'Florida I595 Incidents', rowCount: 178, asOf: '2026-10-01T00:00:00Z', fields: ['weather', 'Segment'] }] });
    assert.match(system, /TWIN STORE[\s\S]*Florida I595 Incidents \[other\] \(178 records, loaded 2026-10-01T00:00\): weather, Segment/);
    assert.match(storeSummary([]), /not built yet/);
    assert.doesNotMatch(SYSTEM_PROMPT, /TWIN STORE \(record classes/);
  });

  test('the screen goes in the user turn, never in system; history precedes it', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([reply({ answer: 'ok' })]);
      await createOrchestrator({ provider, tools, logger: quiet }).run(envelope('Why is this high risk?', {
        history: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'earlier answer' }],
        screen: { selection: { type: 'incident', id: 'FL511-876564' } },
      }), () => {});
      const { system, messages } = provider.requests[0];
      assert.doesNotMatch(system, /FL511-876564/);
      assert.deepEqual(messages.slice(0, 2).map(m => m.content), ['earlier', 'earlier answer']);
      assert.match(messages[2].content, /SCREEN CONTEXT[\s\S]*FL511-876564[\s\S]*Why is this high risk\?$/);
    } finally { cleanup(); }
  });

  test('the last round may not call tools, so a turn always ends with an answer', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([
        toolUse(['a', 'describe_store', {}]),
        toolUse(['b', 'describe_store', {}]),
        reply({ answer: 'done' }),
      ]);
      const answer = await createOrchestrator({ provider, tools, logger: quiet, limits: { maxRounds: 3 } }).run(envelope('q'), () => {});
      assert.equal(provider.requests.length, 3);
      assert.equal(provider.requests[0].toolChoice, null);
      assert.deepEqual(provider.requests[2].toolChoice, { type: 'none' });
      assert.equal(answer.answer, 'done');
      // Describing the store is metadata, so nothing backed the answer.
      assert.equal(answer.confidence, 'low');
      assert.deepEqual(answer.sources, ['Corridor knowledge']);
    } finally { cleanup(); }
  });

  test('a gap or failed tool lowers confidence and is reported on its event', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([
        toolUse(['a', 'count_records', { class_name: 'Florida I595 Incidents' }], ['b', 'query_records', { class_name: 'Florida I595 Tickets' }],
          ['c', 'query_records', { class_name: 'Florida I595 Incidents', filters: [{ field: 'bogus', operator: 'equals', value: 'x' }] }]),
        reply({ answer: 'partial', basis: [{ claim: 'count', refs: ['R1'] }, { claim: 'tickets', refs: ['R2'] }] }),
      ]);
      const { events, emit } = collect();
      const answer = await createOrchestrator({ provider, tools, logger: quiet }).run(envelope('q'), emit);
      const ends = Object.fromEntries(events.filter(e => e.type === 'ToolCallEnd').map(e => [e.id, e]));
      assert.equal(ends.a.status, 'ok');
      assert.equal(ends.b.status, 'gap');
      assert.equal(ends.c.status, 'error');
      assert.match(ends.c.detail, /not a field/);
      assert.equal(answer.confidence, 'medium');
      const results = provider.requests[1].messages.at(-1).content;
      assert.equal(results.find(r => r.tool_use_id === 'c').is_error, true);
      assert.equal(results.find(r => r.tool_use_id === 'b').is_error, undefined);
    } finally { cleanup(); }
  });

  test('a slow tool times out without stalling the turn', async () => {
    const { tools, cleanup } = fixtureTools({ fetchWeather: () => new Promise(() => {}) });
    try {
      const provider = scripted([toolUse(['w', 'get_weather', { lon: -80.2, lat: 26.08 }]), reply({ answer: 'no weather' })]);
      const { events, emit } = collect();
      const answer = await createOrchestrator({ provider, tools, logger: quiet, limits: { toolTimeoutMs: 30 } }).run(envelope('weather?'), emit);
      assert.equal(events.find(e => e.type === 'ToolCallEnd').status, 'timeout');
      assert.equal(answer.confidence, 'low');
    } finally { cleanup(); }
  });

  test('a map action survives only when a tool returned its target', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([
        toolUse(['e', 'list_live_events', {}]),
        reply({ answer: 'One closure at SR-7.', basis: [{ claim: 'one closure at SR-7', refs: ['R1'] }],
          action: { type: 'show_event', entity_id: 'FL511-876564', coordinates: { lon: -80.2034, lat: 26.0839 } } }),
      ]);
      const answer = await createOrchestrator({ provider, tools, logger: quiet }).run(envelope('closures?'), () => {});
      assert.deepEqual(answer.action, { type: 'show_event', entity_id: 'FL511-876564', coordinates: { lon: -80.2034, lat: 26.0839 } });
      assert.deepEqual(answer.sources, ['FL511 live events']);
    } finally { cleanup(); }
  });

  test('a retryable model error is retried once; a second failure becomes RunError', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const busy = () => new ProviderError('The model is overloaded.', { retryable: true, status: 529 });
      const once = scripted([busy(), reply({ answer: 'after retry' })]);
      assert.equal((await createOrchestrator({ provider: once, tools, logger: quiet, retryDelayMs: () => 0 }).run(envelope('q'), () => {})).answer, 'after retry');
      const twice = scripted([busy(), busy()]);
      const { events, emit } = collect();
      assert.equal(await createOrchestrator({ provider: twice, tools, logger: quiet, retryDelayMs: () => 0 }).run(envelope('q'), emit), null);
      assert.deepEqual(events.map(e => e.type), ['RunStarted', 'ContextUsed', 'StepStarted', 'RunError']);
      assert.equal(events.at(-1).retryable, true);
    } finally { cleanup(); }
  });

  test('a refusal, an aborted request and the run deadline end in RunError, never a hang', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const refusal = scripted([{ content: [], stop_reason: 'refusal' }]);
      const r1 = collect();
      await createOrchestrator({ provider: refusal, tools, logger: quiet }).run(envelope('q'), r1.emit);
      assert.match(r1.events.at(-1).message, /declined/);

      const controller = new AbortController();
      const hanging = scripted([req => new Promise((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason)); controller.abort(); })]);
      const r2 = collect();
      await createOrchestrator({ provider: hanging, tools, logger: quiet }).run(envelope('q'), r2.emit, { signal: controller.signal });
      assert.equal(r2.events.at(-1).message, 'The request was cancelled.');

      let clock = 0;
      const slow = scripted([toolUse(['a', 'describe_store', {}]), reply({ answer: 'late' })]);
      const r3 = collect();
      await createOrchestrator({ provider: slow, tools, logger: quiet, now: () => (clock += 30_000), limits: { runTimeoutMs: 45_000 } }).run(envelope('q'), r3.emit);
      assert.equal(r3.events.at(-1).type, 'RunError');
      assert.match(r3.events.at(-1).message, /ran out of time/);
    } finally { cleanup(); }
  });

  test('every turn logs one JSON line with rounds, usage and per-tool status', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const lines = [];
      const provider = scripted([toolUse(['a', 'describe_store', {}]), reply({ answer: 'x' })]);
      await createOrchestrator({ provider, tools, logger: { ...quiet, log: l => lines.push(JSON.parse(l)) } }).run(envelope('q'), () => {});
      assert.equal(lines.length, 1);
      assert.equal(lines[0].event, 'ask_turn');
      assert.equal(lines[0].rounds, 2);
      assert.deepEqual(lines[0].usage, { input_tokens: 30, output_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      assert.deepEqual(lines[0].tools.map(t => [t.name, t.status]), [['describe_store', 'ok']]);
    } finally { cleanup(); }
  });
});

describe('ask answer checks', () => {
  const calls = [{ ref: 'R1', name: 'find_corridor_features', status: 'ok', evidence: true, source: 'Corridor layer · cams',
    output: { features: [{ camera_id: 'CAM-12', lon: -80.254, lat: 26.071 }] } }];

  test('an action at coordinates no tool returned is dropped with a reason', () => {
    const { action, dropped } = checkAction({ type: 'fly_to', coordinates: { lon: -80.9, lat: 25.5 } }, calls);
    assert.equal(action.type, 'none');
    assert.match(dropped, /no record returned/);
  });

  test('a returned location keeps its action; an unknown id is removed but the place kept', () => {
    assert.deepEqual(checkAction({ type: 'open_camera', entity_id: 'CAM-12', coordinates: { lon: -80.254, lat: 26.071 } }, calls).action,
      { type: 'open_camera', entity_id: 'CAM-12', coordinates: { lon: -80.254, lat: 26.071 } });
    assert.equal(checkAction({ type: 'fly_to', entity_id: 'CAM-99', coordinates: { lon: -80.254, lat: 26.071 } }, calls).action.entity_id, null);
    assert.equal(checkAction({ type: 'teleport', coordinates: { lon: -80.254, lat: 26.071 } }, calls).action.type, 'none');
  });

  test('confidence comes from the claims and the lookups they cite, not from lookups merely running', () => {
    const gap = { ref: 'R2', status: 'gap', evidence: false };
    assert.equal(computeConfidence([], calls).level, 'low');
    // The express-lane case: lookups ran, but the claim rests on general knowledge.
    const uncited = computeConfidence([{ claim: 'EB is open in the PM peak', refs: [] }], calls);
    assert.equal(uncited.level, 'low');
    assert.match(uncited.reason, /1 lookup ran, but no claim/);
    assert.equal(computeConfidence([{ claim: 'camera CAM-12', refs: ['R1'] }], calls).level, 'high');
    assert.equal(computeConfidence([{ claim: 'camera CAM-12', refs: ['R1'] }, { claim: 'general', refs: [] }], calls).level, 'medium');
    assert.equal(computeConfidence([{ claim: 'camera CAM-12', refs: ['R1'] }], calls, ['no live lane status feed']).level, 'medium');
    assert.equal(computeConfidence([{ claim: 'x', refs: ['R2'] }], [...calls, gap]).level, 'low');
    assert.equal(computeConfidence([{ claim: 'x', refs: ['R9'] }], calls).level, 'low');
  });

  test('sources and basis name only the lookups the answer cites; gaps are passed on', () => {
    const answer = finalizeAnswer(JSON.stringify({ answer: 'a', basis: [{ claim: 'c', refs: ['R1'] }], gaps: ['no lane status feed'] }),
      [...calls, { ref: 'R2', name: 'list_live_events', status: 'ok', evidence: true, source: 'FL511 live events', output: { events: [] } }]);
    assert.deepEqual(answer.sources, ['Corridor layer · cams']);
    assert.deepEqual(answer.cited, ['R1']);
    assert.deepEqual(answer.uncited, ['R2']);
    assert.deepEqual(answer.gaps, ['no lane status feed']);
    assert.equal(answer.confidence, 'medium');
  });

  test('prose instead of JSON still renders, at low confidence with no action', () => {
    const answer = finalizeAnswer('Just some prose.', []);
    assert.equal(answer.answer, 'Just some prose.');
    assert.equal(answer.action.type, 'none');
    assert.equal(answer.confidence, 'low');
  });
});

describe('incomplete answers', () => {
  test('prose with inline refs: claims are read from the text, capped at medium and labelled as inferred', () => {
    assert.deepEqual(claimsFromText('Two closures are near I-95 (R1). None at the Turnpike [R1, r2]. No ref here.'),
      [{ claim: 'Two closures are near I-95 (R1).', refs: ['R1'] }, { claim: 'None at the Turnpike [R1, r2].', refs: ['R1', 'R2'] }]);
    const calls = [{ ref: 'R1', evidence: true, status: 'ok', source: 'DataConnect · Live Events', output: {} }];
    const answer = finalizeAnswer('Two closures are near I-95 (R1).', calls);
    assert.equal(answer.confidence, 'medium');
    assert.match(answer.confidence_reason, /read from the answer text/);
    assert.equal(answer.basis_inferred, true);
    assert.deepEqual(answer.cited, ['R1']);
    assert.deepEqual(answer.uncited, []);
  });

  test("a 'none' tool call after the answer ends the turn instead of costing another round", async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([
        toolUse(['t1', 'list_live_events', {}]),
        { content: [{ type: 'text', text: 'One closure at SR-7 (R1).' }, { type: 'tool_use', id: 't2', name: 'none', input: {} }], stop_reason: 'tool_use', usage: {} },
      ]);
      const orchestrator = createOrchestrator({ provider, tools: tools, logger: quiet, system: 's' });
      const { events, emit } = collect();
      const answer = await orchestrator.run(envelope('closures at the turnpike?'), emit);
      assert.equal(provider.requests.length, 2);
      assert.equal(answer.answer, 'One closure at SR-7 (R1).');
      assert.ok(!events.some(e => e.type === 'ToolCallStart' && e.name === 'none'));
    } finally { cleanup(); }
  });

  test('the round before the last tells the model to reply with the JSON, inside the tool result (no text block after results)', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([toolUse(['t1', 'list_live_events', {}]), toolUse(['t2', 'list_live_events', {}]), reply({ answer: 'ok', basis: [] })]);
      await createOrchestrator({ provider, tools, logger: quiet, system: 's' }).run(envelope('q'), () => {});
      const lastUser = provider.requests[2].messages.at(-1).content;
      assert.ok(lastUser.every(b => b.type === 'tool_result'), 'only tool results in the turn');
      assert.match(lastUser.at(-1).content, /No more lookups are possible/);
      assert.doesNotMatch(provider.requests[1].messages.at(-1).content.at(-1).content, /No more lookups/, 'not before round 2');
    } finally { cleanup(); }
  });

  test('an empty final answer is asked for once more, and fails visibly if still empty', async () => {
    const empty = { content: [], stop_reason: 'end_turn', usage: { output_tokens: 1 } };
    const { tools, cleanup } = fixtureTools();
    try {
      const provider = scripted([toolUse(['t1', 'list_live_events', {}]), empty, reply({ answer: 'One closure at SR-7.', basis: [{ claim: 'One closure at SR-7.', refs: ['R1'] }] })]);
      const answer = await createOrchestrator({ provider, tools, logger: quiet, system: 's' }).run(envelope('closures?'), () => {});
      assert.equal(answer.answer, 'One closure at SR-7.');
      assert.match(provider.requests[2].messages.at(-1).content, /Please continue/);
      const twice = scripted([empty, empty]);
      const { events, emit } = collect();
      assert.equal(await createOrchestrator({ provider: twice, tools, logger: quiet, system: 's' }).run(envelope('q'), emit), null);
      assert.match(events.find(e => e.type === 'RunError').message, /empty answer/);
    } finally { cleanup(); }
  });

  test('records_near counts records around every feature matching a place, with groups and nearest', async () => {
    const { tools, cleanup } = fixtureTools();
    try {
      const near = await tools.run('records_near', { class_name: 'Florida I595 Incidents', place: { layer: 'i595_corridor_cameras.geojson', text: 'turnpike' }, radius_m: 3000, group_by: 'weather' });
      // INC-1/2 are ~5 km east of the Turnpike camera, INC-3 ~10 km west: none within 3 km.
      assert.equal(near.output.totalCount, 0);
      const point = await tools.run('records_near', { class_name: 'Florida I595 Incidents', near: { lon: -80.2, lat: 26.08 }, radius_m: 1500, group_by: 'weather' });
      assert.equal(point.output.totalCount, 2);
      assert.deepEqual(point.output.nearest.map(r => r.key), ['INC-1', 'INC-2']);
      assert.equal(point.output.nearest[0].distance_m, 0);
      assert.deepEqual(point.output.groups, [{ value: 'Light Rain', count: 1 }, { value: 'Clear', count: 1 }]);
      assert.match(point.source, /Florida I595 Incidents \(snapshot\)/);
      assert.match((await tools.run('records_near', { class_name: 'Florida I595 Incidents', place: { layer: 'i595_corridor_cameras.geojson', text: 'nowhere' } })).output.error, /No feature/);
      assert.match((await tools.run('records_near', { class_name: 'Florida I595 Incidents' })).output.error, /place|near/);
      assert.match((await tools.run('records_near', { class_name: 'Florida I595 Incidents', near: { lon: -80.2, lat: 26.08 }, group_by: 'bogus' })).output.error, /not a field/);
    } finally { cleanup(); }
  });

  test('the prompt points place questions at records_near and says action is not a tool', () => {
    assert.match(SYSTEM_PROMPT, /records_near with place/);
    assert.match(SYSTEM_PROMPT, /no tool named "none"/);
  });
});
