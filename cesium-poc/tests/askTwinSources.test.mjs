import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSources, normalizeSources, presetFor, saveSources, scopeLine, SOURCE_IDS, sourcesForScreen, toggleSource } from '../src/askTwinSources.js';

test('toggles never leave an empty selection, keep config order, and the default sends nothing', () => {
  assert.deepEqual(normalizeSources(['finance', 'maintenance']), ['maintenance', 'finance']);
  assert.deepEqual(normalizeSources([]), SOURCE_IDS);
  assert.deepEqual(toggleSource(['maintenance'], 'maintenance'), ['maintenance'], 'the last source stays on');
  assert.deepEqual(toggleSource(['maintenance'], 'finance'), ['maintenance', 'finance']);
  assert.equal(sourcesForScreen([...SOURCE_IDS]), undefined);
  assert.deepEqual(sourcesForScreen(['maintenance']), ['maintenance']);
  assert.deepEqual(presetFor('maintenance_manager'), ['maintenance']);
  assert.deepEqual(presetFor(null), SOURCE_IDS);
});

test('scope line and storage', () => {
  assert.equal(scopeLine({ used: ['Maintenance & assets'], excluded: ['Tolling & revenue'] }), 'Answered from Maintenance & assets · Toggled off: Tolling & revenue');
  assert.equal(scopeLine(null), '');
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  saveSources(['finance'], storage);
  assert.deepEqual(loadSources(storage), ['finance']);
  assert.deepEqual(loadSources({ getItem: () => { throw new Error('blocked'); } }), SOURCE_IDS);
});
