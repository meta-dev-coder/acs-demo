/**
 * Ask the Twin tools and data dictionary: every class and layer is described, tool inputs are validated
 * against the dictionary, DataConnect reads get the right filters, results are trimmed, and the handler's
 * tool loop feeds tool results back to the model. Offline: fake DataConnect, layers and Anthropic.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HISTORICAL_CLASSES, LIVE_CLASS_NAMES } from '../server/liveDc/classes.mjs';
import {
  ASK_LAYER_FILES, buildDataDictionary, describeData, dictionarySummary, loadDataDictionary,
} from '../server/liveDc/dataDictionary.mjs';
import { createAskTools, fitResult, flatRecord, liveEventKey, TOOL_DEFINITIONS } from '../server/liveDc/askTools.mjs';
import { createAskHandler } from '../server/liveDc/askTwin.mjs';
import { RUNTIME_DATA_FILES } from '../tools/build-live-dc-bundle.mjs';

const DICT = buildDataDictionary({ generatedAt: '2026-09-30T00:00:00.000Z' });
const quiet = { log() {}, info() {}, warn() {}, error() {} };

describe('data dictionary', () => {
  test('covers every live and historical DataConnect class with its full attribute list', () => {
    assert.deepEqual(DICT.dataConnect.live.map(c => c.className), [...LIVE_CLASS_NAMES]);
    assert.deepEqual(DICT.dataConnect.historical.map(c => c.className), HISTORICAL_CLASSES.map(c => c.className));
    for (const c of [...DICT.dataConnect.live, ...DICT.dataConnect.historical]) {
      assert.ok(c.purpose, c.className);
      assert.ok(c.attributes.some(a => a.name === 'keyInSource'), c.className);
      for (const key of c.keyFields) {
        const bare = key.replace(/ \(.*\)$/, '');
        if (bare === 'weather fields') continue;
        assert.ok(c.attributes.some(a => a.name === bare), `${c.className}: key field '${bare}' is a real attribute`);
      }
    }
    assert.ok(DICT.dataConnect.historical.every(c => /^[0-9a-f]{24}$/.test(c.id)));
  });

  test('covers every corridor layer the tools search, with counts and property names', () => {
    assert.deepEqual(DICT.corridorLayers.map(l => l.file), [...ASK_LAYER_FILES]);
    for (const layer of DICT.corridorLayers) {
      assert.ok(layer.featureCount > 0, layer.file);
      assert.ok(layer.properties.length > 0, layer.file);
    }
    assert.ok(DICT.corridorLayers.find(l => l.file === 'i595_corridor_cameras.geojson').properties.includes('camera_id'));
  });

  test('carries the chain, workflow, event types and scoring the code runs on', () => {
    assert.match(DICT.chain, /source_event_id/);
    assert.ok(DICT.workflow.profiles.demo && DICT.workflow.profiles.realistic);
    assert.deepEqual(Object.keys(DICT.eventTypes).sort(), ['CLOSURE', 'CONGESTION', 'CONSTRUCTION', 'DISABLED', 'INCIDENT']);
    assert.equal(DICT.scoring.bands.redAtOrAbove, 0.62);
  });

  test('a class or layer without a guide entry fails the build instead of shipping undescribed', async () => {
    const { default: guide } = await import('../config/askTwin/dataGuide.json', { with: { type: 'json' } });
    const noClass = structuredClone(guide);
    delete noClass.dataConnectClasses['Florida I595 Work Orders'];
    assert.throws(() => buildDataDictionary({ doc: noClass }), /no entry for DataConnect class 'Florida I595 Work Orders'/);
    const noLayer = structuredClone(guide);
    delete noLayer.corridorLayers['i595_bridges.geojson'];
    assert.throws(() => buildDataDictionary({ doc: noLayer }), /no entry for corridor layer 'i595_bridges.geojson'/);
  });

  test('the prompt summary names every class and layer and stays short', () => {
    const summary = dictionarySummary(DICT);
    for (const c of [...DICT.dataConnect.live, ...DICT.dataConnect.historical]) assert.ok(summary.includes(c.className), c.className);
    for (const l of ASK_LAYER_FILES) assert.ok(summary.includes(l), l);
    assert.ok(summary.length < 6000, `summary is ${summary.length} chars`);
  });

  test('describeData: topics, exact class, section, loose match, ambiguity and unknown', () => {
    assert.ok(describeData(DICT).topics.includes('chain'));
    assert.equal(describeData(DICT, 'florida i595 assets').className, 'Florida I595 Assets');
    assert.ok(describeData(DICT, 'workflow').workflow.profiles);
    assert.equal(describeData(DICT, 'bridges').file, 'i595_bridges.geojson');
    assert.deepEqual(describeData(DICT, 'work orders').matches, ['SDNA Florida I595 Live Work Orders', 'Florida I595 Work Orders']);
    assert.match(describeData(DICT, 'nope').error, /No topic/);
  });

  test('loadDataDictionary reads the release file when present, else builds from the repo', () => {
    assert.equal(loadDataDictionary({ dataDir: '/definitely/missing' }).dataConnect.live.length, LIVE_CLASS_NAMES.length);
  });

  test('the release copies every layer the tools search', () => {
    for (const file of ASK_LAYER_FILES) assert.ok(RUNTIME_DATA_FILES.includes(file), file);
  });
});

describe('ask tools: helpers', () => {
  test('liveEventKey accepts every id form and rejects others', () => {
    for (const id of ['FL511-876564', 'FL511-CLOSURE-876564', 'fl511-closure-876564', '876564']) assert.equal(liveEventKey(id), 'FL511-876564', id);
    for (const id of ['', 'TIC-FL511-1', 'abc', null]) assert.equal(liveEventKey(id), null, String(id));
  });

  test('flatRecord drops geometry and empty/NA values, clips long strings and can pick fields', () => {
    const item = { keyInSource: 'K', attributes: { geometry: 'POINT(1 2)', a: 'x', b: '', c: 'NA', d: 'y'.repeat(400), e: 5 } };
    const flat = flatRecord(item);
    assert.deepEqual(Object.keys(flat), ['keyInSource', 'a', 'd', 'e']);
    assert.equal(flat.d.length, 301);
    assert.deepEqual(flatRecord(item, ['e']), { keyInSource: 'K', e: 5 });
  });

  test('fitResult trims the largest list and says so', () => {
    const big = { total: 50, records: Array.from({ length: 50 }, (_, i) => ({ i, text: 'z'.repeat(400) })) };
    const text = fitResult(big, 5000);
    assert.ok(text.length <= 5000);
    const parsed = JSON.parse(text);
    assert.ok(parsed.records.length < 50);
    assert.match(parsed.truncated, /left out to fit/);
    assert.equal(fitResult({ a: 1 }), '{"a":1}');
  });

  test('tool definitions are well formed for the Messages API', () => {
    assert.deepEqual(TOOL_DEFINITIONS.map(t => t.name), ['describe_data', 'list_live_events', 'get_live_chain', 'query_records', 'find_corridor_features', 'get_weather']);
    for (const t of TOOL_DEFINITIONS) { assert.equal(t.input_schema.type, 'object'); assert.ok(t.description.length > 20); }
  });
});

function fakeDataConnect() {
  const calls = [];
  const liveIds = new Map(DICT.dataConnect.live.map((c, i) => [c.className, `live${i}`]));
  const reply = (id, body) => {
    calls.push({ id, body });
    const source = body.filters?.find(f => f.field === 'attributes.source_event_id' || f.field === 'keyInSource');
    if (source?.value === 'FL511-404') return { totalCount: 0, data: [] };
    return { totalCount: 1, data: [{ keyInSource: `${id}-row`, attributes: { geometry: 'x', source_event_id: source?.value ?? null, status: 'active' } }] };
  };
  return {
    calls,
    liveDc: { liveClasses: async () => [...liveIds].map(([className, id]) => ({ className, id })), curatedData: async (id, body) => reply(id, body) },
    historical: { curatedData: async (id, body) => reply(id, body) },
  };
}

const LAYER = {
  features: [
    { properties: { camera_id: '1837', description: 'I-595 ~MP 8.5' }, geometry: { type: 'Point', coordinates: [-80.16817, 26.0859] } },
    { properties: { camera_id: '2027', description: 'I-595 ~MP 8.7' }, geometry: { type: 'Point', coordinates: [-80.167858, 26.089101] } },
    { properties: { camera_id: '9999', description: 'I-75 far away' }, geometry: { type: 'Point', coordinates: [-80.38, 26.07] } },
  ],
};

describe('ask tools: running', () => {
  const make = (extra = {}) => {
    const dc = fakeDataConnect();
    const tools = createAskTools({
      dictionary: DICT, liveDc: dc.liveDc, historical: dc.historical, readLayer: file => (file === 'i595_corridor_cameras.geojson' ? LAYER : null),
      liveEvents: { dataConnectEvents: async window => ({ events: [
        { id: 'FL511-CLOSURE-1', type: 'CLOSURE', title: 'Closure', dataConnect: { keyInSource: 'FL511-1', status: window === 'active' ? 'active' : 'cleared' } },
        { id: 'FL511-INCIDENT-2', type: 'INCIDENT', title: 'Crash' },
      ] }) },
      fetchWeather: async point => ({ weather_at_event: `ok ${point.latitude}` }),
      ...extra,
    });
    return { dc, run: async (name, input) => JSON.parse(await tools.run(name, input)) };
  };

  test('query_records maps attribute filters, checks names and operators, reads live or historical', async () => {
    const { dc, run } = make();
    const hist = await run('query_records', { class_name: 'florida i595 work orders', filters: [{ field: 'Asset ID', operator: 'equals', value: 'S-1' }], limit: 99 });
    assert.equal(hist.className, 'Florida I595 Work Orders');
    assert.deepEqual(dc.calls[0], { id: DICT.dataConnect.historical.find(c => c.className === 'Florida I595 Work Orders').id,
      body: { page: 0, pageSize: 25, filters: [{ field: 'attributes.Asset ID', operator: 'equals', value: 'S-1' }] } });
    await run('query_records', { class_name: 'SDNA Florida I595 Live Tickets', filters: [{ field: 'keyInSource', operator: 'contains', value: 'TIC' }] });
    assert.deepEqual(dc.calls[1].body.filters, [{ field: 'keyInSource', operator: 'contains', value: 'TIC' }]);
    assert.match(dc.calls[1].id, /^live/);
    assert.match((await run('query_records', { class_name: 'Nope' })).error, /Unknown class/);
    assert.match((await run('query_records', { class_name: 'Florida I595 Assets', filters: [{ field: 'x', operator: 'equals', value: '1' }] })).error, /not an attribute/);
    assert.match((await run('query_records', { class_name: 'Florida I595 Assets', filters: [{ field: 'name', operator: 'regex', value: '.' }] })).error, /Operator/);
    assert.equal(dc.calls.length, 2);
  });

  test('get_live_chain reads the event by key and each chain class by source_event_id', async () => {
    const { dc, run } = make();
    const chain = await run('get_live_chain', { event_id: 'FL511-CLOSURE-876564' });
    assert.equal(chain.event.source_event_id, 'FL511-876564');
    assert.deepEqual(Object.keys(chain), ['event', 'tickets', 'tasks', 'work_orders', 'inspections', 'asset_status']);
    assert.equal(dc.calls.length, 6);
    assert.deepEqual(dc.calls[0].body.filters, [{ field: 'keyInSource', operator: 'equals', value: 'FL511-876564' }]);
    for (const call of dc.calls.slice(1)) assert.deepEqual(call.body.filters, [{ field: 'attributes.source_event_id', operator: 'equals', value: 'FL511-876564' }]);
    assert.match((await run('get_live_chain', { event_id: 'FL511-404' })).error, /No live event/);
    assert.match((await run('get_live_chain', { event_id: 'hello' })).error, /not an FL511 event id/);
  });

  test('list_live_events filters by type and window', async () => {
    const { run } = make();
    const all = await run('list_live_events', { window: '24h' });
    assert.equal(all.total, 2);
    assert.equal(all.events[0].status, 'cleared');
    const incidents = await run('list_live_events', { type: 'INCIDENT' });
    assert.deepEqual(incidents.events.map(e => e.id), ['FL511-INCIDENT-2']);
  });

  test('find_corridor_features by distance (sorted) and by text; unknown layers refused', async () => {
    const { run } = make();
    const near = await run('find_corridor_features', { layer: 'i595_corridor_cameras.geojson', near: { lon: -80.168159, lat: 26.085694, radius_m: 1500 } });
    assert.deepEqual(near.features.map(f => f.camera_id), ['1837', '2027']);
    assert.ok(near.features[0].distance_m < near.features[1].distance_m);
    const text = await run('find_corridor_features', { layer: 'i595_corridor_cameras.geojson', text: 'i-75' });
    assert.deepEqual(text.features.map(f => f.camera_id), ['9999']);
    assert.match((await run('find_corridor_features', { layer: '../../etc/passwd' })).error, /Unknown layer/);
    assert.match((await run('find_corridor_features', { layer: 'i595_bridges.geojson' })).error, /not available/);
  });

  test('get_weather only in South Florida; unknown tools and thrown errors come back as {error}', async () => {
    const { run } = make();
    assert.equal((await run('get_weather', { lon: -80.25, lat: 26.1 })).weather_at_event, 'ok 26.1');
    assert.match((await run('get_weather', { lon: 2.35, lat: 48.85 })).error, /South Florida/);
    assert.match((await run('rm_rf', {})).error, /Unknown tool/);
    const broken = make({ historical: { curatedData: async () => { throw new Error('DataConnect returned 500.'); } } });
    assert.match((await broken.run('query_records', { class_name: 'Florida I595 Assets' })).error, /500/);
  });
});

describe('ask handler: tool loop', () => {
  async function serve(handler) {
    const server = createServer((req, res) => { handler.handle(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      ask: q => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) }),
      close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
    };
  }
  const FINAL = '{"answer":"WO-1 is open.","action":{"type":"none","entity_id":null,"coordinates":null},"confidence":"high","sources":["dataconnect"]}';

  test('runs requested tools, returns their results to the model, then answers', async () => {
    const sent = [];
    const first = [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'query_records', input: { class_name: 'X' } }, { type: 'tool_use', id: 'tu2', name: 'describe_data', input: {} }];
    const replies = [
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'query_records', input: { class_name: 'X' } }, { type: 'tool_use', id: 'tu2', name: 'describe_data', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: FINAL }] },
    ];
    const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => replies.shift() }; };
    const ran = [];
    const tools = { definitions: TOOL_DEFINITIONS, run: async (name, input) => { ran.push([name, input]); return `{"from":"${name}"}`; } };
    const srv = await serve(createAskHandler({ getApiKey: async () => 'k', getLiveEvents: async () => null, tools, dataSummary: 'DATA YOU CAN READ', fetchImpl, logger: quiet }));
    try {
      const response = await srv.ask('Which work orders are open?');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).answer, 'WO-1 is open.');
      assert.deepEqual(ran, [['query_records', { class_name: 'X' }], ['describe_data', {}]]);
      assert.equal(sent.length, 2);
      assert.equal(sent[0].tools.length, TOOL_DEFINITIONS.length);
      assert.match(sent[0].system, /DATA YOU CAN READ/);
      assert.match(sent[0].system, /TOOLS:/);
      assert.deepEqual(sent[1].messages[0], { role: 'user', content: 'Which work orders are open?' });
      assert.deepEqual(sent[1].messages[1], { role: 'assistant', content: first });
      assert.deepEqual(sent[1].messages[2], { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: '{"from":"query_records"}' },
        { type: 'tool_result', tool_use_id: 'tu2', content: '{"from":"describe_data"}' },
      ] });
    } finally { await srv.close(); }
  });

  test('after 6 tool rounds the model is made to answer (tool_choice none)', async () => {
    const sent = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const content = body.tool_choice?.type === 'none'
        ? [{ type: 'text', text: FINAL }]
        : [{ type: 'tool_use', id: `t${sent.length}`, name: 'describe_data', input: {} }];
      return { ok: true, status: 200, json: async () => ({ stop_reason: body.tool_choice ? 'end_turn' : 'tool_use', content }) };
    };
    const tools = { definitions: TOOL_DEFINITIONS, run: async () => '{}' };
    const srv = await serve(createAskHandler({ getApiKey: async () => 'k', getLiveEvents: async () => null, tools, fetchImpl, logger: quiet }));
    try {
      const response = await srv.ask('loop forever');
      assert.equal(response.status, 200);
      assert.equal(sent.length, 7);
      assert.equal(sent[6].tool_choice.type, 'none');
      assert.ok(sent.slice(0, 6).every(b => !b.tool_choice));
    } finally { await srv.close(); }
  });

  test('without tools the request carries no tools field', async () => {
    const sent = [];
    const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: FINAL }] }) }; };
    const srv = await serve(createAskHandler({ getApiKey: async () => 'k', getLiveEvents: async () => null, fetchImpl, logger: quiet }));
    try {
      assert.equal((await srv.ask('hi')).status, 200);
      assert.equal(sent[0].tools, undefined);
      assert.doesNotMatch(sent[0].system, /TOOLS:/);
    } finally { await srv.close(); }
  });
});
