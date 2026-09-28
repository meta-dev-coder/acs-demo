/**
 * tools/historical-chain.mjs and tools/live-dc-create-class.mjs: dry runs, refusals and the guarded
 * write paths, all against fake fetches (never a real DataConnect).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORICAL_CHAIN_CLASS, HISTORICAL_CLASSES, LIVE_CLASS, sdnaClassDefinition } from '../server/liveDc/classes.mjs';
import { runHistoricalChain } from '../tools/historical-chain.mjs';
import { runCreateClass, DC_DATA_MGMT_URL } from '../tools/live-dc-create-class.mjs';
import { buildSdnaCreateRequest } from '../server/liveDc/classes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_ARTIFACT = join(ROOT, 'config', 'liveDc', 'historical-chain.create-request.json');
const TOKEN_ENV = { DC_WRITER_ACCESS_TOKEN_FILE: '/fake/token' };
const readToken = () => 'fake-token';

const capture = () => {
  const out = [], err = [];
  return { out, err, log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) };
};
const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const incident = (id, date, assetId) => ({ incident_id: id, incident_date: date, incident_time: '04:00', damaged_asset_id: assetId,
  incident_type: 'Vehicle vs barrier', Segment: 'East Segment', 'x_coordinate (from asset)': -80.2, 'y_coordinate (from asset)': 26.1 });
const smallLocal = () => ({
  incidents: [incident('INC-200001', '2024-03-01T00:00:00', 'A1'), incident('INC-200002', '2024-03-05T00:00:00', null)],
  tickets: [{ 'Ticket ID': 'TIC-1', 'Asset ID': 'A1', 'Ticket Opened Date': '2024-03-03T00:00:00' }],
  tasks: [{ 'Task ID': 'TSK-1', 'Related Ticket ID': 'TIC-1', 'Task Date': '2024-03-03T00:00:00' }],
  workOrders: [], itsInspections: [], roadwayInspections: [], safetyInspections: [],
});

describe('create-request artifact for the chain class', () => {
  test('is generated from the class definition and covered by live-dc-classes --check', () => {
    const artifact = JSON.parse(readFileSync(CHAIN_ARTIFACT, 'utf8'));
    assert.deepEqual(artifact, [buildSdnaCreateRequest(HISTORICAL_CHAIN_CLASS)]);
    const [req] = artifact;
    assert.equal(req.className, HISTORICAL_CHAIN_CLASS);
    assert.equal(req.create.className, HISTORICAL_CHAIN_CLASS);
    assert.equal(req.create.classType, 'DATA_CLASS');
    const def = sdnaClassDefinition(HISTORICAL_CHAIN_CLASS);
    assert.deepEqual(req.update.add.map((a) => [a.name, a.type]), def.attributes.filter((a) => !a.core).map((a) => [a.name, a.type]));
    assert.deepEqual(req.update.modify, []);
    assert.deepEqual(req.update.remove, []);
    assert.equal(JSON.stringify(req).includes('<id of'), false);
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'live-dc-classes.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('live-dc-create-class', () => {
  const classList = (extra = []) => [{ id: 'x1', className: 'SDNA Florida I595 Live Events', classId: 101 }, ...extra];

  function fakeDc({ classes = classList(), createdId = 'abcdef0123456789abcdef01' } = {}) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect });
      if (method === 'GET' && url === `${DC_DATA_MGMT_URL}/class`) return json(200, classes);
      if (method === 'POST' && url === `${DC_DATA_MGMT_URL}/class`) return json(200, { id: createdId });
      if (method === 'POST' && url === `${DC_DATA_MGMT_URL}/class/${createdId}`) return json(200, { id: createdId });
      return json(404, { detail: 'nope' });
    };
    return { calls, fetchImpl };
  }

  test('dry run lists the plan and sends nothing but the class list read', async () => {
    const dc = fakeDc();
    const io = capture();
    const code = await runCreateClass({ argv: [HISTORICAL_CHAIN_CLASS], env: TOKEN_ENV, fetchImpl: dc.fetchImpl, readToken, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    assert.deepEqual(dc.calls.map((c) => c.method), ['GET']);
    const text = io.out.join('\n');
    assert.match(text, /dry run/);
    assert.match(text, /\+ step_order \(Integer\)/);
    assert.match(text, /\+ is_synthetic \(Boolean\)/);
    assert.match(text, /\+ step_date \(DateTime\)/);
  });

  test('dry run without a token still prints the plan, marked unchecked', async () => {
    const io = capture();
    const code = await runCreateClass({ argv: [HISTORICAL_CHAIN_CLASS], env: {}, fetchImpl: async () => { throw new Error('no network'); }, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    assert.match(io.out.join('\n'), /not checked/);
  });

  test('--apply creates the class, then adds the attributes with a ClassUpdate', async () => {
    const dc = fakeDc();
    const io = capture();
    const code = await runCreateClass({ argv: [HISTORICAL_CHAIN_CLASS, '--apply'], env: TOKEN_ENV, fetchImpl: dc.fetchImpl, readToken, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    const [list, create, update] = dc.calls;
    assert.equal(list.method, 'GET');
    assert.equal(create.method, 'POST');
    assert.equal(create.url, `${DC_DATA_MGMT_URL}/class`);
    assert.equal(create.body.className, HISTORICAL_CHAIN_CLASS);
    assert.equal(update.url, `${DC_DATA_MGMT_URL}/class/abcdef0123456789abcdef01`);
    assert.equal(update.body.className, HISTORICAL_CHAIN_CLASS);
    assert.ok(update.body.add.some((a) => a.name === 'chain_id'));
    assert.deepEqual(update.body.modify, []);
    assert.deepEqual(update.body.remove, []);
    assert.equal(dc.calls.length, 3);
    for (const c of dc.calls) assert.equal(c.redirect, 'manual');
  });

  test('refuses non-SDNA names, Bentley classes and unknown classes without any request', async () => {
    for (const name of ['Florida I595 Incidents', 'Florida I595 Historical Chain', 'SDNA Florida I595 Unknown', HISTORICAL_CLASSES[0].className]) {
      const dc = fakeDc();
      const io = capture();
      const code = await runCreateClass({ argv: [name, '--apply'], env: TOKEN_ENV, fetchImpl: dc.fetchImpl, readToken, ...io });
      assert.equal(code, 2, name);
      assert.equal(dc.calls.length, 0, name);
      assert.match(io.err.join('\n'), /refusing/);
    }
  });

  test('refuses a class that already exists', async () => {
    const dc = fakeDc({ classes: classList([{ id: 'x2', className: HISTORICAL_CHAIN_CLASS, classId: 130 }]) });
    const io = capture();
    const code = await runCreateClass({ argv: [HISTORICAL_CHAIN_CLASS, '--apply'], env: TOKEN_ENV, fetchImpl: dc.fetchImpl, readToken, ...io });
    assert.equal(code, 1);
    assert.deepEqual(dc.calls.map((c) => c.method), ['GET']);
    assert.match(io.err.join('\n'), /already exists/);
  });

  test('refuses a create request that still needs a class id placeholder', async () => {
    const dc = fakeDc();
    const io = capture();
    const code = await runCreateClass({ argv: [LIVE_CLASS.TASKS, '--apply'], env: TOKEN_ENV, fetchImpl: dc.fetchImpl, readToken, ...io });
    assert.equal(code, 2);
    assert.equal(dc.calls.length, 0);
    assert.match(io.err.join('\n'), /placeholder/);
  });

  test('--apply needs a token; usage errors exit 2', async () => {
    let io = capture();
    assert.equal(await runCreateClass({ argv: [HISTORICAL_CHAIN_CLASS, '--apply'], env: {}, fetchImpl: async () => { throw new Error('x'); }, ...io }), 2);
    io = capture();
    assert.equal(await runCreateClass({ argv: [], env: TOKEN_ENV, readToken, ...io }), 2);
    io = capture();
    assert.equal(await runCreateClass({ argv: [HISTORICAL_CHAIN_CLASS, '--force'], env: TOKEN_ENV, readToken, ...io }), 2);
  });

  test('a failed create stops before the update', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push(init.method ?? 'GET');
      return (init.method ?? 'GET') === 'GET' ? json(200, classList()) : json(400, { detail: 'bad' });
    };
    const io = capture();
    assert.equal(await runCreateClass({ argv: [HISTORICAL_CHAIN_CLASS, '--apply'], env: TOKEN_ENV, fetchImpl, readToken, ...io }), 1);
    assert.deepEqual(calls, ['GET', 'POST']);
  });
});

describe('historical-chain tool', () => {
  const WRITER_ENV = {
    DC_WRITER_BASE_URL: 'https://dc.example', DC_WRITER_LOAD_BASE_URL: 'https://load.example', DC_WRITER_ACCESS_TOKEN: 'fake-token',
    DC_WRITER_POLL_INTERVAL_MS: '1', DC_WRITER_PROCESS_TIMEOUT_MS: '2000', DC_WRITER_CURATION_TIMEOUT_MS: '2000',
  };
  const CHAIN_DTO = { id: 'cccccccccccccccccccccccc', classId: 130, className: HISTORICAL_CHAIN_CLASS, classType: 'DATA_CLASS',
    attributes: sdnaClassDefinition(HISTORICAL_CHAIN_CLASS).attributes };
  const HIST_DTOS = HISTORICAL_CLASSES.map((c) => ({ id: c.id, classId: c.classId, className: c.className, classType: 'DATA_CLASS', attributes: c.attributes }));

  /** A fake DataConnect: historical classes served from `curated`, loads accepted and recorded. */
  function fakeWriterDc({ classes = [...HIST_DTOS, CHAIN_DTO], curated = {} } = {}) {
    const calls = [], loads = [];
    let uploaded = null;
    const fetchImpl = async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const { origin, pathname } = new URL(url);
      calls.push({ method, origin, pathname });
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (origin === 'https://dc.example') {
        if (pathname === '/api/data-mgmt/v1/class') return json(200, classes);
        const m = pathname.match(/^\/api\/data-mgmt\/v1\/class\/([^/]+)\/(.+)$/);
        const cls = classes.find((c) => c.id === m?.[1]);
        if (m?.[2] === 'curated-data') {
          const items = curated[cls.className] ?? [];
          const page = items.slice(body.page * body.pageSize, (body.page + 1) * body.pageSize);
          return json(200, { data: page, totalCount: items.length });
        }
        if (m?.[2] === 'raw-data-process') return json(200, loads.map((l) => ({ loadId: l.id, stats: { new: l.records.length } })));
        if (m?.[2] === 'curated-data-process') return json(200, loads.map((l) => ({ loadId: l.id, curationType: 'RAW_DATA_LOAD', status: 'Finished' })));
      }
      if (origin === 'https://load.example') {
        if (method === 'POST' && pathname === '/v1/loads') {
          loads.push({ id: `L${loads.length + 1}`, register: body, records: [] });
          return json(200, { id: `L${loads.length}` });
        }
        const m = pathname.match(/^\/v1\/loads\/(L\d+)(\/.*)?$/);
        const load = loads.find((l) => l.id === m?.[1]);
        if (m?.[2] === '/upload/json-file') { uploaded = body; load.records = body; return json(200, {}); }
        if (m?.[2] === '/process') return json(200, {});
        if (!m?.[2]) return json(200, { id: load.id, status: 'Finished' });
      }
      return json(404, { detail: `unexpected ${method} ${pathname}` });
    };
    return { calls, loads, fetchImpl, uploaded: () => uploaded };
  }

  test('--from-local dry run prints stats and samples and makes no network call', async () => {
    const io = capture();
    const code = await runHistoricalChain({ argv: ['--from-local'], env: {}, readLocal: smallLocal,
      fetchImpl: async () => { throw new Error('no network'); }, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    const text = io.out.join('\n');
    assert.match(text, /chains: 2/);
    assert.match(text, /ticket\s+real 0 · inferred 1 · synthetic 1/);
    assert.match(text, /task\s+real 1 · inferred 0 · synthetic 3/);
    assert.match(text, /CHAIN-INC-200001/);
    assert.match(text, /dry run/);
  });

  test('--from-local over the real export reports the computed ticket inference', async () => {
    const io = capture();
    const code = await runHistoricalChain({ argv: ['--from-local', '--dry-run'], env: {}, fetchImpl: async () => { throw new Error('x'); }, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    assert.match(io.out.join('\n'), /chains: 178/);
    assert.match(io.out.join('\n'), /ticket\s+real 0 · inferred 38 · synthetic 140/);
  });

  test('--out writes the rows JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chain-'));
    try {
      const file = join(dir, 'rows.json');
      const io = capture();
      assert.equal(await runHistoricalChain({ argv: ['--from-local', '--out', file], env: {}, readLocal: smallLocal, ...io }), 0);
      const rows = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(rows.length, 5 + 7);
      assert.ok(rows.every((r) => r.keyInSource.startsWith('CHAIN-')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('default input reads the seven Bentley classes from DataConnect, read-only', async () => {
    const dc = fakeWriterDc({ curated: {
      'Florida I595 Incidents': [{ keyInSource: 'INC-9', attributes: { code: 'INC-9', incident_date: '01/03/2024', damaged_asset_id: 'A1' } }],
      'Florida I595 Tickets': [{ keyInSource: 'TIC-9', attributes: { code: 'TIC-9', 'Ticket ID': 'TIC-9', 'Asset ID': 'A1', 'Ticket Opened Date': '02/03/2024' } }],
    } });
    const io = capture();
    const code = await runHistoricalChain({ argv: [], env: WRITER_ENV, fetchImpl: dc.fetchImpl, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    assert.match(io.out.join('\n'), /ticket\s+real 0 · inferred 1 · synthetic 0/);
    assert.equal(dc.calls.some((c) => c.origin === 'https://load.example'), false);
    const read = new Set(dc.calls.filter((c) => c.pathname.endsWith('/curated-data')).map((c) => c.pathname.split('/')[5]));
    assert.equal(read.size, 7);
    assert.equal(read.has(CHAIN_DTO.id), false);
  });

  test('default input without writer configuration exits 2 before any request', async () => {
    const io = capture();
    const code = await runHistoricalChain({ argv: [], env: {}, fetchImpl: async () => { throw new Error('no network'); }, ...io });
    assert.equal(code, 2);
    assert.match(io.err.join('\n'), /DC_WRITER_BASE_URL/);
  });

  test('--apply loads the rows Incremental into the chain class only', async () => {
    const dc = fakeWriterDc();
    const io = capture();
    const code = await runHistoricalChain({ argv: ['--from-local', '--apply'], env: WRITER_ENV, readLocal: smallLocal, fetchImpl: dc.fetchImpl, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    assert.equal(dc.loads.length, 1);
    assert.deepEqual(dc.loads[0].register, { classId: 'CL000130', classType: 'DATA_CLASS', loadType: 'Incremental' });
    assert.equal(dc.loads[0].records.length, 12);
    assert.ok(dc.loads[0].records.every((r) => r.chain_id.startsWith('CHAIN-')));
  });

  test('--apply sends only rows that differ from what the chain class already holds', async () => {
    const io0 = capture();
    const dir = mkdtempSync(join(tmpdir(), 'chain-'));
    try {
      const file = join(dir, 'rows.json');
      await runHistoricalChain({ argv: ['--from-local', '--out', file], env: {}, readLocal: smallLocal, ...io0 });
      const rows = JSON.parse(readFileSync(file, 'utf8'));
      const existing = rows.map(({ keyInSource, geometry, ...attributes }) => ({ keyInSource, attributes }));
      existing[0].attributes.summary = 'changed';
      const dc = fakeWriterDc({ curated: { [HISTORICAL_CHAIN_CLASS]: existing } });
      const io = capture();
      assert.equal(await runHistoricalChain({ argv: ['--from-local', '--apply'], env: WRITER_ENV, readLocal: smallLocal, fetchImpl: dc.fetchImpl, ...io }), 0);
      assert.equal(dc.loads.length, 1);
      assert.deepEqual(dc.loads[0].records.map((r) => r.keyInSource), [rows[0].keyInSource]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('--apply refuses when the chain class is missing, and never loads anything else', async () => {
    const dc = fakeWriterDc({ classes: HIST_DTOS });
    const io = capture();
    const code = await runHistoricalChain({ argv: ['--from-local', '--apply'], env: WRITER_ENV, readLocal: smallLocal, fetchImpl: dc.fetchImpl, ...io });
    assert.equal(code, 1);
    assert.equal(dc.loads.length, 0);
    assert.match(io.err.join('\n'), /SDNA Florida I595 Historical Chain/);
  });

  test('--apply refuses a chain class that carries a historical classId', async () => {
    const dc = fakeWriterDc({ classes: [...HIST_DTOS.filter((c) => c.classId !== 12), { ...CHAIN_DTO, classId: 12 }] });
    const io = capture();
    assert.equal(await runHistoricalChain({ argv: ['--from-local', '--apply'], env: WRITER_ENV, readLocal: smallLocal, fetchImpl: dc.fetchImpl, ...io }), 1);
    assert.equal(dc.loads.length, 0);
  });

  test('refuses unknown arguments and --apply with --dry-run', async () => {
    for (const argv of [['--full'], ['--class', 'Florida I595 Incidents'], ['--apply', '--dry-run'], ['--out']]) {
      const io = capture();
      assert.equal(await runHistoricalChain({ argv, env: {}, readLocal: smallLocal, ...io }), 2, argv.join(' '));
    }
  });
});
