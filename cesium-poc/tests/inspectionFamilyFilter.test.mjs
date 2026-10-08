/**
 * Narrowing inspections by which form they are.
 *
 * The register carries three: ITS Asset, Roadway Safety and Live Post-Incident. They arrive in one
 * list and ITS is two thirds of it, so reading the roadway safety ones meant scrolling past a
 * thousand records that were not what was being looked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetTypeConfig, inspectionFamilyFilters } from '../src/assetExplorer/assetTypes.js';

/** An inspection as the explorer holds it: the DataConnect row hangs off `source.raw`. */
const inspection = (family, id) => ({ id, source: { raw: { attributes: { inspection_form_family: family } } } });

const CORRIDOR = [
  ...Array.from({ length: 4 }, (_, i) => inspection('ITS Asset Inspection V3', `its-${i}`)),
  ...Array.from({ length: 2 }, (_, i) => inspection('Roadway Safety Inspection V3', `road-${i}`)),
  inspection('Live Post-Incident Inspection', 'post-0'),
];

test('the three forms the register carries each become a choice', () => {
  const filters = inspectionFamilyFilters(CORRIDOR, CORRIDOR);
  assert.deepEqual(filters.map(f => f.label),
    ['ITS Asset Inspection V3', 'Roadway Safety Inspection V3', 'Live Post-Incident Inspection']);
  // Commonest first, which is the order valueFilters sorts by — what an inspector meets most.
  assert.deepEqual(filters.map(f => f.count), [4, 2, 1]);
});

test('they are one group, so the explorer renders them as a dropdown rather than seven chips', () => {
  for (const filter of inspectionFamilyFilters(CORRIDOR, CORRIDOR)) {
    assert.equal(filter.group, 'Inspection form');
  }
});

test('choosing one keeps only that form', () => {
  const filters = inspectionFamilyFilters(CORRIDOR, CORRIDOR);
  const roadway = filters.find(f => f.label === 'Roadway Safety Inspection V3');
  assert.deepEqual(CORRIDOR.filter(roadway.match).map(a => a.id), ['road-0', 'road-1']);
  const post = filters.find(f => f.label === 'Live Post-Incident Inspection');
  assert.deepEqual(CORRIDOR.filter(post.match).map(a => a.id), ['post-0']);
});

test('the labels are the register’s own words, not tidied-up ones', () => {
  // The same string is each record's title, so the dropdown and the cards under it agree.
  const [first] = inspectionFamilyFilters(CORRIDOR, CORRIDOR);
  assert.equal(first.label, 'ITS Asset Inspection V3');
});

test('a record with no form family offers no choice rather than a blank one', () => {
  const nameless = [{ id: 'x', source: { raw: { attributes: {} } } }, { id: 'y', source: {} }];
  assert.deepEqual(inspectionFamilyFilters(nameless, nameless), []);
});

test('the inspection type offers these filters, and other types do not', () => {
  const labels = assetTypeConfig('inspection').getFilters(CORRIDOR, CORRIDOR).map(f => f.label);
  assert.ok(labels.includes('Roadway Safety Inspection V3'));
  const workOrders = assetTypeConfig('workOrder').getFilters(CORRIDOR, CORRIDOR).map(f => f.label);
  assert.ok(!workOrders.includes('Roadway Safety Inspection V3'), 'a work order has no inspection form');
});
