import assert from 'node:assert/strict';
import test from 'node:test';
import { askLabelImage, HIGHLIGHT_THRESHOLDS, labelModeOf } from '../src/ifcSpatial/askHighlights.js';

test('label mode follows the configurable thresholds', () => {
  assert.equal(labelModeOf(1), 'individual');
  assert.equal(labelModeOf(9), 'individual');
  assert.equal(labelModeOf(HIGHLIGHT_THRESHOLDS.individual), 'individual');
  assert.equal(labelModeOf(16), 'adaptive');
  assert.equal(labelModeOf(50), 'adaptive');
  assert.equal(labelModeOf(51), 'cluster');
  assert.equal(labelModeOf(80), 'cluster');
  assert.equal(labelModeOf(6, { individual: 5, adaptive: 10 }), 'adaptive');
});

test('a result label is a cyan pill with the escaped id; selected is larger and outlined white', () => {
  const plain = askLabelImage({ text: 'TX-M1', kind: 'transformer' });
  const svg = decodeURIComponent(plain.url.split(',')[1]);
  assert.match(svg, />TX-M1</);
  assert.match(svg, /#22d3ee/i);
  const sel = askLabelImage({ text: 'TX-M1', kind: 'transformer', selected: true });
  assert.ok(sel.pill > plain.pill);
  assert.match(decodeURIComponent(sel.url.split(',')[1]), /stroke="#ffffff"/);
  assert.match(decodeURIComponent(askLabelImage({ text: '<b>' }).url.split(',')[1]), /&lt;b&gt;/);
  const below = askLabelImage({ text: 'A', below: true, level: 1 });
  assert.ok(below.height > askLabelImage({ text: 'A', below: true }).height);
});
