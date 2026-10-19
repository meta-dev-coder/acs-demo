import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { answerBlocks, barsView, BARS_LIMIT, captionText, formatNumber, formatTick, formatValue, normaliseBlock, sourceForRef, tableView, trendView } from '../src/askTwinBlocks.js';

describe('formatting', () => {
  test('numbers are grouped, fractions only as precise as readable, and a missing value is NA', () => {
    assert.equal(formatNumber(12345), '12,345');
    assert.equal(formatNumber(12.345), '12.3');
    assert.equal(formatNumber(0.3849), '0.38');
    assert.equal(formatNumber(1234.56), '1,235');
    assert.equal(formatValue(42, 'min'), '42 min');
    assert.equal(formatValue(87.5, '%'), '87.5%');
    assert.equal(formatValue('Open', null), 'Open');
    assert.equal(formatValue(null, 'mi'), 'NA');
    assert.equal(formatValue('', 'mi'), 'NA');
    assert.equal(formatValue(0, 'mi'), '0 mi');
  });

  test('a date is a calendar day, an hour label stays as sent', () => {
    assert.equal(formatTick('2026-10-03'), 'Oct 3');
    assert.equal(formatTick('07:00'), '07:00');
    assert.equal(formatTick(undefined), '');
  });
});

describe('source for a ref', () => {
  const answer = {
    sources: ['DataConnect', 'FL511 live events'],
    basis: [{ claim: 'a', refs: ['R1'], sources: ['DataConnect · Live Work Orders'] },
      { claim: 'b', refs: ['R2', 'R3'], sources: ['FL511 live events', 'Corridor layers'] },
      { claim: 'c', refs: ['R4', 'R5'], sources: ['Weather'] }],
    evidence: { R6: { source: 'DataConnect · Inspections', records: [] } },
  };
  test('evidence first, then a claim citing only it, then paired lists', () => {
    assert.equal(sourceForRef('R6', answer), 'DataConnect · Inspections');
    assert.equal(sourceForRef('R1', answer), 'DataConnect · Live Work Orders');
    assert.equal(sourceForRef('R3', answer), 'Corridor layers');
  });
  test('an uncertain source is left out, not guessed; a single-source answer can only mean that one', () => {
    assert.equal(sourceForRef('R4', answer), null);
    assert.equal(sourceForRef('R9', { sources: ['Weather'] }), 'Weather');
    assert.equal(captionText('R4', answer), 'R4');
    assert.equal(captionText('R1', answer), 'R1 · DataConnect · Live Work Orders');
  });
});

describe('block model', () => {
  test('unknown types and blocks missing what they need are dropped', () => {
    const blocks = answerBlocks({ blocks: [
      { type: 'kpi', ref: 'R1', label: 'Open work orders', value: 37 },
      { type: 'pie', ref: 'R2' },
      { type: 'kpi', ref: 'R1' },
      { type: 'trend', ref: 'R3', points: [{ t: '2026-10-01', value: 3 }] },
      { type: 'bars', ref: 'R4', items: [{ label: 'x', value: 'n/a' }] },
      { type: 'table', ref: 'R5', columns: [], rows: [] },
      null,
    ] });
    assert.deepEqual(blocks.map(b => b.type), ['kpi']);
    assert.deepEqual(answerBlocks({}), []);
  });

  test('bars are capped and scaled to the largest value', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ label: `S${i}`, value: i + 1 }));
    const block = normaliseBlock({ type: 'bars', ref: 'R1', title: 'By segment', items });
    assert.equal(block.items.length, BARS_LIMIT);
    const view = barsView(normaliseBlock({ type: 'bars', items: [{ label: 'a', value: 10 }, { label: 'b', value: 2.5 }, { label: 'c', value: -1 }] }));
    assert.deepEqual(view.map(b => [b.label, b.pct, b.text]), [['a', 100, '10'], ['b', 25, '2.5'], ['c', 0, '-1']]);
  });

  test('a table shows eight rows until expanded, keeps row locations aligned, and states blanks as NA', () => {
    const rows = Array.from({ length: 11 }, (_, i) => [`CAM ${i}`, i * 100, i === 2 ? null : 'Online']);
    const rowLocations = rows.map((_, i) => (i % 2 ? { lon: Number((-80.2 - i / 100).toFixed(2)), lat: 26.07 } : null));
    rowLocations[4] = { lon: 'x', lat: 26 };
    const block = normaliseBlock({ type: 'table', ref: 'R2', title: 'Cameras', columns: ['Camera', 'Distance (m)', 'Status'], rows, rowLocations });
    const view = tableView(block);
    assert.equal(view.rows.length, 8);
    assert.equal(view.hidden, 3);
    assert.deepEqual(view.rows[2].cells, ['CAM 2', '200', 'NA']);
    assert.deepEqual(view.numeric, [false, true, false]);
    assert.equal(view.rows[0].location, null);
    assert.deepEqual(view.rows[1].location, { lon: -80.21, lat: 26.07 });
    assert.equal(view.rows[4].location, null);
    assert.ok(view.locatable);
    assert.equal(tableView(block, { expanded: true }).rows.length, 11);
  });

  test('a trend line spans the box, flat series draw through the middle, and min/max are labelled', () => {
    const block = normaliseBlock({ type: 'trend', ref: 'R3', title: 'Incidents', unit: '/day',
      points: [{ t: '2026-10-01', value: 2 }, { t: '2026-10-02', value: 6 }, { t: '2026-10-03', value: 4 }] });
    const view = trendView(block, { width: 100, height: 40, pad: 0 });
    assert.equal(view.points, '0,40 50,0 100,20');
    assert.deepEqual([view.minText, view.maxText, view.lastText], ['2 /day', '6 /day', '4 /day']);
    assert.deepEqual([view.firstLabel, view.lastLabel], ['Oct 1', 'Oct 3']);
    const flat = trendView(normaliseBlock({ type: 'trend', points: [{ t: 'a', value: 1 }, { t: 'b', value: 1 }] }), { width: 10, height: 10, pad: 0 });
    assert.equal(flat.points, '0,5 10,5');
  });
});
