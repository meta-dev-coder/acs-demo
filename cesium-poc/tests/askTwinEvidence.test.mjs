import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceView, knownRefs, splitRefs } from '../src/askTwinEvidence.js';

describe('ref parsing', () => {
  const known = new Set(['R1', 'R2', 'R3']);
  test('bracketed refs become groups; the space before the bracket goes with it', () => {
    assert.deepEqual(splitRefs('Two closures (R1). Cameras [R2][R3] and (R1, R3).', known), [
      { type: 'text', text: 'Two closures' }, { type: 'refs', refs: ['R1'], raw: '(R1)' },
      { type: 'text', text: '. Cameras' }, { type: 'refs', refs: ['R2'], raw: '[R2]' }, { type: 'refs', refs: ['R3'], raw: '[R3]' },
      { type: 'text', text: ' and' }, { type: 'refs', refs: ['R1', 'R3'], raw: '(R1, R3)' }, { type: 'text', text: '.' },
    ]);
  });
  test('a ref the answer does not know, or one outside brackets, stays text', () => {
    assert.deepEqual(splitRefs('Ramp R1 is shut (R9).', known), [{ type: 'text', text: 'Ramp R1 is shut (R9).' }]);
    assert.deepEqual(splitRefs('mixed (R1, R9)', known), [{ type: 'text', text: 'mixed (R1, R9)' }]);
    assert.deepEqual(splitRefs('', known), [{ type: 'text', text: '' }]);
    assert.equal(splitRefs('any (R7)').length, 2);
  });
  test('known refs come from claims, cited, evidence and blocks', () => {
    const refs = knownRefs({ basis: [{ claim: 'a', refs: ['R1'] }], cited: ['R2'], evidence: { R3: {} }, blocks: [{ type: 'kpi', ref: 'R4' }] });
    assert.deepEqual([...refs].sort(), ['R1', 'R2', 'R3', 'R4']);
  });
});

describe('evidence view', () => {
  test('up to four fields per record, a real position or none, and how many were not sent', () => {
    const view = evidenceView({ source: 'DataConnect · Live Work Orders', total: 23, records: [
      { id: 'WO-1', label: 'Lighting repair', lon: -80.25, lat: 26.07, fields: { status: 'Open', priority: 'High', asset: 11063, opened: null, crew: 'B' } },
      { id: 7, fields: {} },
      { id: 'WO-3', lon: 'bad', lat: 26 },
    ] });
    assert.equal(view.source, 'DataConnect · Live Work Orders');
    assert.equal(view.records[0].fields.length, 4);
    assert.deepEqual(view.records[0].fields[3], ['opened', 'NA']);
    assert.deepEqual(view.records[0].fields[2], ['asset', '11,063']);
    assert.deepEqual(view.records[0].location, { lon: -80.25, lat: 26.07 });
    assert.equal(view.records[1].id, '7');
    assert.equal(view.records[2].location, null);
    assert.equal(view.more, 20);
    assert.equal(evidenceView({ records: [{ id: 'a' }] }).more, 0);
    assert.equal(evidenceView(null), null);
  });
});
