/**
 * The three subtabs, and the card shown over the map while a case is focused.
 *
 * The renderer is a string function, so the assertions here are about what a reader is told —
 * above all that the synthetic case and the real incident whose location it borrows are never
 * presented as the same record.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ASSET_OPS_TABS, DEFAULT_TAB, resolveTab } from '../src/maintenance/assetOpsTabs.js';
import { caseFocusCard } from '../src/maintenance/assetOpsPanels.js';

test('the three subtabs are in the order the brief lists them, and Operations Overview is the default', () => {
  assert.deepEqual(ASSET_OPS_TABS.map(tab => tab.id), ['operations', 'cases', 'claims']);
  assert.deepEqual(ASSET_OPS_TABS.map(tab => tab.label),
    ['Operations Overview', 'Case Management', 'Claims Intelligence']);
  assert.equal(DEFAULT_TAB, 'operations');
});

test('an unknown tab id falls back to the default rather than throwing', () => {
  assert.equal(resolveTab('claims'), 'claims');
  assert.equal(resolveTab('nonsense'), 'operations');
  assert.equal(resolveTab(undefined), 'operations');
});

/* ── Case Map Focus Mode ─────────────────────────────────────────────────────────────────────── */

const focusRecord = (overrides = {}) => ({
  id: 'ACS-DEMO-002',
  demoLabel: 'SYNTHETIC DEMO DATA',
  demoCase: {
    incident: { incidentType: 'Vehicle collision with fixed object' },
    asset: { assetType: 'lighting - street light', assetName: 'Highway lighting pole (synthetic)' },
  },
  evaluation: {
    presentation: { label: 'Blocked at repair', tone: 'bad' },
    nextAction: { text: 'Complete 4 outstanding records on the repair stage.' },
  },
  ...overrides,
});

const focusLocation = (overrides = {}) => ({
  roadway: 'I-595', segmentId: null, direction: null,
  sourceIncidentId: 'INC-200133', sourceIncidentType: 'Guardrail strike',
  sourceIncidentDate: '17/02/2026 00:00', ...overrides,
});

test('the focus card leads with the case, not with the incident under the camera', () => {
  const html = caseFocusCard({ record: focusRecord(), location: focusLocation(), corridorMile: 3.3, error: null });
  assert.ok(html.indexOf('ACS-DEMO-002') < html.indexOf('INC-200133'),
    'the case is named before the incident whose location it borrows');
  // The asset name is shown without the fixtures' "(synthetic)" suffix: the dataset's provenance
  // is a fact about the dataset, not about this pole, and it is stated where it belongs.
  assert.match(html, /Highway lighting pole/);
  assert.ok(!/\(synthetic\)/.test(html), 'no per-asset synthetic suffix');
  assert.ok(!/SYNTHETIC DEMO DATA/.test(html), 'no per-case synthetic chip');
  assert.match(html, /Blocked at repair/);
  assert.match(html, /Complete 4 outstanding records/);
  assert.match(html, /corridor mile 3\.30 \(derived\)/);
  assert.match(html, /data-action="return-to-case"/);
});

test('a source incident of a different kind is called out, never silently presented as the case', () => {
  const html = caseFocusCard({ record: focusRecord(), location: focusLocation(), corridorMile: null, error: null });
  assert.match(html, /real <strong>Guardrail strike<\/strong>/);
  assert.match(html, /different event from this case/);
  assert.match(html, /reuses only this incident/);
});

test('a source incident of the same kind still says the case is synthetic', () => {
  const html = caseFocusCard({
    record: focusRecord(), corridorMile: null, error: null,
    location: focusLocation({ sourceIncidentType: 'Vehicle collision with fixed object' }),
  });
  assert.match(html, /reuses only its location/);
  assert.match(html, /did not happen here/);
  assert.doesNotMatch(html, /different event/);
});

test('an unusable location is reported as an error rather than flown to', () => {
  const html = caseFocusCard({ record: focusRecord(), location: focusLocation(), corridorMile: null,
    error: 'Incident INC-200133 carries no usable coordinates, so there is nowhere to fly to.' });
  assert.match(html, /cw-focus-error/);
  assert.match(html, /nowhere to fly to/);
});

test('the focus card escapes what it is given', () => {
  const html = caseFocusCard({
    record: focusRecord({ id: '<img src=x>' }), location: focusLocation(), corridorMile: null, error: null });
  assert.doesNotMatch(html, /<img/);
});
