/**
 * The server-side design store: validation, atomic writes, revisions.
 *
 * Validation is tested HERE as well as in the browser module because this is the authority: the
 * browser's checks are a courtesy to the user, and anything that can reach the endpoint can send
 * whatever it likes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDesignStore, validateDesign } from '../server/portmiami/designStore.mjs';

const road = (id = 'e1') => ({
  id, type: 'ROAD', changeType: 'NEW',
  geometry: { type: 'LineString', coordinates: [[-80.1665, 25.7733], [-80.1669, 25.7731]] },
  properties: { widthM: 7.5, lanes: 2 },
});
const design = (patch = {}) => ({
  id: 'design-x', name: 'Design X', crs: 'EPSG:4326', elements: [road()], ...patch,
});

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pm-designs-'));
  const path = join(dir, 'designs.json');
  try { await run(createDesignStore({ path }), path); } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- validation ------------------------------------------------------------------------------

test('a well-formed design is accepted', () => {
  assert.equal(validateDesign(design()).ok, true);
});

test('the baseline cannot be stored — it is the county data, not a proposal', () => {
  const check = validateDesign(design({ id: 'baseline' }));
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => /baseline is read-only/.test(e)));
});

test('a projected CRS is refused rather than read as degrees', () => {
  assert.ok(validateDesign(design({ crs: 'EPSG:2236' })).errors.some(e => /EPSG:4326 only/.test(e)));
});

test('unreferenced CAD coordinates are refused', () => {
  const cad = design({ elements: [{ ...road(), geometry: {
    type: 'LineString', coordinates: [[912345.6, 528431.2], [912500, 528600]] } }] });
  assert.ok(validateDesign(cad).errors.some(e => /outside the PortMiami study area/.test(e)));
});

test('swapped latitude and longitude are named as such', () => {
  const swapped = design({ elements: [{ ...road(), geometry: {
    type: 'LineString', coordinates: [[25.7733, -80.1665], [25.7731, -80.1669]] } }] });
  assert.ok(validateDesign(swapped).errors.some(e => /longitude first/.test(e)));
});

test('duplicate element ids are refused', () => {
  assert.ok(validateDesign(design({ elements: [road('dup'), road('dup')] }))
    .errors.some(e => /Duplicate element id/.test(e)));
});

test('a MODIFIED element must name what it changes', () => {
  const bad = design({ elements: [{ ...road(), changeType: 'MODIFIED' }] });
  assert.ok(validateDesign(bad).errors.some(e => /names no baseline feature/.test(e)));
});

test('an absurd road width is refused', () => {
  const wide = design({ elements: [{ ...road(), properties: { widthM: 400 } }] });
  assert.ok(validateDesign(wide).errors.some(e => /between 0 and 60 m/.test(e)));
});

test('every problem is reported, not just the first', () => {
  const bad = design({ id: '', name: '', crs: 'EPSG:2236', elements: [road('dup'), road('dup')] });
  assert.ok(validateDesign(bad).errors.length >= 4, validateDesign(bad).errors.join(' | '));
});

// ---- the store ---------------------------------------------------------------------------------

test('a saved design comes back identical, with a revision and timestamps', async () => {
  await withStore(async store => {
    const { design: saved } = await store.save(design());
    assert.equal(saved.revision, '01');
    assert.ok(saved.createdAt && saved.updatedAt);
    const read = await store.get('design-x');
    assert.deepEqual(read.elements, design().elements);
  });
});

test('saving again replaces the design and increments the revision, keeping createdAt', async () => {
  await withStore(async store => {
    const { design: first } = await store.save(design());
    const { design: second } = await store.save(design({ name: 'Design X rev 2' }));
    assert.equal(second.revision, '02');
    assert.equal(second.createdAt, first.createdAt, 'a re-save does not look newly made');
    assert.notEqual(second.updatedAt, undefined);
    assert.equal((await store.list()).length, 1, 'replaced, not appended');
    assert.equal((await store.get('design-x')).name, 'Design X rev 2');
  });
});

test('designs are kept apart from one another', async () => {
  await withStore(async store => {
    await store.save(design({ id: 'a', name: 'A' }));
    await store.save(design({ id: 'b', name: 'B' }));
    assert.equal((await store.list()).length, 2);
    await store.remove('a');
    assert.equal((await store.list()).map(d => d.id).join(), 'b');
  });
});

test('concurrent saves all land — writes are serialised within the process', async () => {
  await withStore(async (store, path) => {
    await Promise.all([1, 2, 3, 4, 5].map(n => store.save(design({ id: `d${n}`, name: `D${n}` }))));
    const state = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(state.designs.length, 5, 'no write was lost');
    assert.equal(state.version, 1);
  });
});

test('a missing store reads as empty rather than throwing', async () => {
  await withStore(async store => {
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('nothing'), null);
  });
});

test('the store reports whether it can actually write', async () => {
  await withStore(async store => {
    assert.equal((await store.writable()).ok, true);
  });
});

// ---- optimistic concurrency -----------------------------------------------------------------

test('a save against the current revision succeeds', async () => {
  await withStore(async store => {
    const { design: first } = await store.save(design());
    const result = await store.save(design({ name: 'Second edit' }), { ifRevision: first.revision });
    assert.equal(result.ok, true);
    assert.equal(result.design.revision, '02');
  });
});

test('a save against a stale revision is REFUSED, and neither draft is lost', async () => {
  await withStore(async store => {
    const { design: first } = await store.save(design());
    // Someone else saves in the meantime.
    await store.save(design({ name: 'Theirs' }), { ifRevision: first.revision });
    // Our edit still thinks it is building on revision 01.
    const result = await store.save(design({ name: 'Ours' }), { ifRevision: first.revision });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.match(result.reason, /moved on to revision 02/);
    assert.equal(result.current.name, 'Theirs', 'their save is handed back, not overwritten');
    assert.equal((await store.get('design-x')).name, 'Theirs', 'and it is still what is stored');
  });
});

test('omitting the revision forces the write, which is what a first save does', async () => {
  await withStore(async store => {
    await store.save(design());
    const forced = await store.save(design({ name: 'Forced' }));
    assert.equal(forced.ok, true);
    assert.equal((await store.get('design-x')).name, 'Forced');
  });
});

test('saving a design that is no longer stored is refused rather than re-created silently', async () => {
  await withStore(async store => {
    const { design: first } = await store.save(design());
    await store.remove('design-x');
    const result = await store.save(design(), { ifRevision: first.revision });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no longer stored/);
  });
});

test('a first save may state that it expects nothing to be there', async () => {
  await withStore(async store => {
    const result = await store.save(design(), { ifRevision: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.design.revision, '01');
  });
});

test('a save and a delete keep the record they replace in the history file', async () => {
  await withStore(async store => {
    await store.save(design());
    await store.save(design({ name: 'Renamed' }));
    await store.remove('design-x');
    const lines = (await readFile(store.historyPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.reason), ['save', 'delete']);
    assert.equal(lines[0].design.name, 'Design X');
    assert.equal(lines[0].design.revision, '01');
    assert.equal(lines[1].design.name, 'Renamed');
  });
});

test('a design restricted to one operation refuses an element of another', () => {
  const widening = { ...road('w1'), changeType: 'MODIFIED', operation: 'WIDEN', baselineRef: { kind: 'ROAD', objectId: 1 } };
  const newRoad = { ...road('n1'), operation: 'CREATE' };
  assert.equal(validateDesign(design({ allowedOperation: 'WIDEN', elements: [widening] })).ok, true);
  const mixed = validateDesign(design({ allowedOperation: 'WIDEN', elements: [widening, newRoad] }));
  assert.equal(mixed.ok, false);
  assert.ok(mixed.errors.some(e => /accepts WIDEN only/.test(e)));
  assert.equal(validateDesign(design({ allowedOperation: 'TELEPORT', elements: [] })).ok, false);
  // A record that declares no restriction is unaffected.
  assert.equal(validateDesign(design({ elements: [widening, newRoad] })).ok, true);
});
