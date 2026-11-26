import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTENT, isMaintenancePlan, normalizeQuestion, planQuestion, resolveObjective, resolveScope, resolveTarget, statusFiltersOf } from '../src/ifcSpatial/askIntent.js';

const IDS = new Set(['TX-M1', 'TX-M2', 'TX-3', 'CB-STS-06', 'STS-02', 'STS-11']);
const namedIds = q => [...IDS].filter(id => new RegExp(`\\b${id}\\b`, 'i').test(q));
const categoriesIn = q => (/\btransformers?\b/i.test(q) ? ['Transformer'] : /\bcranes?\b/i.test(q) ? ['Crane'] : /\bbreakers?\b/i.test(q) ? ['Breaker'] : null);
const area = { selectionId: 'area-1', versionKey: 'k5' };
const plan = (q, conversation = {}, a = area) => planQuestion(q, { knownIds: IDS, namedIds, categoriesIn, conversation, area: a });

test('the objective wins over status words, categories and the selected area (the reported failure)', () => {
  const p = plan('For degraded asset, what needs to be fixed?');
  assert.equal(p.primaryIntent, INTENT.CORRECTIVE_ACTIONS);
  assert.deepEqual(p.supportingIntents, [INTENT.ASSET_DIAGNOSIS, INTENT.INSPECTION_HISTORY]);
  assert.deepEqual(p.assetFilters.operationalStatus, ['DEGRADED']);
  assert.equal(p.target.kind, 'FILTER');
  assert.equal(p.scope.type, 'SELECTED_AREA');
  assert.equal(p.scope.selectionId, 'area-1');
  assert.equal(p.responseType, 'MAINTENANCE_ASSESSMENT');
  assert.ok(p.steps.includes('RETRIEVE_LINKED_DOCUMENTS') && p.steps.includes('EXTRACT_CORRECTIVE_ACTIONS'));
  assert.equal(isMaintenancePlan(p), true);
  // Status questions stay status questions.
  assert.equal(plan('Which assets are degraded in this area?').primaryIntent, INTENT.ASSET_STATUS);
  assert.equal(plan('Which assets are degraded?').primaryIntent, INTENT.ASSET_STATUS);
});

test('§6 / §26 objectives', () => {
  const cases = {
    'Why are these assets degraded?': INTENT.ASSET_DIAGNOSIS, 'Why is this asset degraded?': INTENT.ASSET_DIAGNOSIS, 'What is wrong with this transformer?': INTENT.ASSET_DIAGNOSIS,
    'What needs to be fixed?': INTENT.CORRECTIVE_ACTIONS, 'What repairs are required?': INTENT.CORRECTIVE_ACTIONS, 'What maintenance is needed?': INTENT.CORRECTIVE_ACTIONS,
    'What should the maintenance team investigate?': INTENT.CORRECTIVE_ACTIONS, 'Show what needs to be fixed for all degraded assets across Seagirt.': INTENT.CORRECTIVE_ACTIONS,
    'Since when has this asset been degraded?': INTENT.HISTORICAL_STATUS, 'Is its condition getting worse?': INTENT.CONDITION_TREND, 'Is this transformer getting worse?': INTENT.CONDITION_TREND,
    'Has this issue occurred before?': INTENT.RECURRING_DEFECTS, 'Has this problem occurred before?': INTENT.RECURRING_DEFECTS, 'When was this defect first reported?': INTENT.RECURRING_DEFECTS,
    'Which repairs are still outstanding?': INTENT.OUTSTANDING_ACTIONS, 'Which defects are still outstanding?': INTENT.OUTSTANDING_ACTIONS, 'Which actions are still outstanding?': INTENT.OUTSTANDING_ACTIONS,
    'Can we continue operating this asset?': INTENT.OPERATING_RESTRICTIONS, 'Are there any operating restrictions?': INTENT.OPERATING_RESTRICTIONS, 'Can maintenance be deferred?': INTENT.OPERATING_RESTRICTIONS,
    'What happens if we shut it down?': INTENT.OUTAGE_IMPACT, 'What happens if TX-M2 is taken out of service to fix these issues?': INTENT.OUTAGE_IMPACT,
    'Is there an alternate supply?': INTENT.ALTERNATE_SUPPLY, 'What needs to be done before replacement?': INTENT.REPLACEMENT_ASSESSMENT, 'What needs to be done before replacing TX-M2?': INTENT.REPLACEMENT_ASSESSMENT,
    'Prepare a report of these issues.': INTENT.REPORT_GENERATION, 'Generate a maintenance report': INTENT.REPORT_GENERATION, 'Create an Excel register of outstanding corrective actions.': INTENT.REPORT_GENERATION,
    'Inform the maintenance team.': INTENT.EMAIL_DRAFT, 'Draft an email to the maintenance team.': INTENT.EMAIL_DRAFT,
    'How many transformers are in this area?': INTENT.ASSET_INVENTORY, 'Where is TX-M2?': INTENT.ASSET_LOCATION, 'Which transformers supply this area?': INTENT.SUPPLY_DEPENDENCY,
  };
  for (const [q, want] of Object.entries(cases)) assert.equal(resolveObjective(q).primary, want, q);
  // A report and an email in one question: both kept, the report first.
  const both = resolveObjective('Prepare a report of all degraded assets in this area and draft an email to the electrical maintenance team.');
  assert.equal(both.primary, INTENT.REPORT_GENERATION);
  assert.ok(both.supporting.includes(INTENT.EMAIL_DRAFT));
});

test('spelling mistakes, singular / plural and incomplete sentences', () => {
  assert.equal(normalizeQuestion('for degarded asset what neds to be fixd'), 'for degraded asset what neds to be fixd'.replace('degarded', 'degraded'));
  assert.equal(resolveObjective('for degarded assets, what needs to be fixed').primary, INTENT.CORRECTIVE_ACTIONS);
  assert.equal(resolveObjective('degraded transformer - what needs fixing? which repairs are requried').primary, INTENT.CORRECTIVE_ACTIONS);
  assert.deepEqual(statusFiltersOf('for degarded asset what needs to be fixed', INTENT.CORRECTIVE_ACTIONS), ['DEGRADED']);
  assert.equal(resolveObjective('what is wrong with it').primary, INTENT.ASSET_DIAGNOSIS);
});

test('targets: named ids, status filters, categories, the previous collection, the selected asset, pronouns', () => {
  assert.deepEqual(plan('What needs to be fixed on TX-M2?').target, { kind: 'NAMED', ids: ['TX-M2'], statusFilters: [], categories: null, reference: null });
  const conv = { collection: { ids: ['TX-M2'] } };
  assert.deepEqual(plan('What needs to be fixed?', conv).target.ids, ['TX-M2'], 'a follow-up with no asset words uses the previous answer');
  assert.deepEqual(plan('Has this issue occurred before?', conv).target.ids, ['TX-M2']);
  assert.deepEqual(plan('What happens if we shut it down?', conv).target.ids, ['TX-M2']);
  assert.deepEqual(plan('Why is this asset degraded?', conv).target.ids, ['TX-M2'], 'the status word describes the asset, it does not filter');
  assert.equal(plan('Why is this asset degraded?', { selectedAssetId: 'TX-3', collection: { ids: ['TX-M2', 'STS-02'] } }).target.ids[0], 'TX-3', 'the selected asset first');
  assert.deepEqual(plan('Prepare a report of these issues.', { investigation: { ids: ['TX-M2', 'TX-3'] } }).target.ids, ['TX-M2', 'TX-3']);
  const filtered = plan('For degraded transformers in this area, what needs to be fixed?', conv);
  assert.equal(filtered.target.kind, 'FILTER', 'a status filter, even with a previous collection');
  assert.deepEqual(filtered.assetFilters, { operationalStatus: ['DEGRADED'], assetTypes: ['Transformer'] });
  assert.equal(plan('Which assets are degraded in this area?').target.kind, 'FILTER', '"this area" is the scope, not an asset reference');
  assert.equal(resolveTarget('What needs to be fixed?', { conversation: {} }).kind, 'SCOPE');
  assert.deepEqual(plan('What needs to be fixed on TX-99?').target.kind, 'SCOPE', 'an id the model does not have is not a target');
});

test('ambiguity: one asset needed, several possible: a clarification, never an arbitrary choice', () => {
  const p = plan('What happens if we shut it down?', { collection: { ids: ['TX-M2', 'TX-3'] } });
  assert.deepEqual(p.clarify, { reason: 'ONE_ASSET_NEEDED', options: ['TX-M2', 'TX-3'] });
  assert.equal(plan('What happens if we shut it down?', { collection: { ids: ['TX-M2'] } }).clarify, null);
});

test('scope: the selected area by default, the whole terminal on request (area kept), no area selected', () => {
  assert.equal(resolveScope('What needs to be fixed?', { area }).type, 'SELECTED_AREA');
  const t = resolveScope('Show what needs to be fixed for all degraded assets across Seagirt.', { area });
  assert.equal(t.type, 'TERMINAL');
  assert.equal(resolveScope('What needs to be fixed in this area?', {}).type, 'NO_AREA_SELECTED');
  assert.equal(resolveScope('What needs to be fixed?', {}).type, 'TERMINAL');
  assert.equal(isMaintenancePlan(plan('What needs to be fixed in this area?', {}, null)), false);
});

test('temporal scope: latest inspection, history, historical status', () => {
  assert.equal(plan('What needs to be fixed on TX-M2?').temporal, 'LATEST_INSPECTION');
  assert.equal(plan('Has this issue occurred before?', { collection: { ids: ['TX-M2'] } }).temporal, 'HISTORICAL_INSPECTIONS');
  assert.equal(plan('Since when has TX-M2 been degraded?').temporal, 'HISTORICAL_STATUS');
  assert.equal(plan('Which assets are degraded?').temporal, 'CURRENT');
});

test('objective words are not asset categories ("alternate supply" is not the Supply category)', () => {
  const cats = q => (/\bsupply\b/i.test(q) ? ['Supply'] : /\btransformers?\b/i.test(q) ? ['Transformer'] : null);
  const p = q => planQuestion(q, { knownIds: IDS, namedIds, categoriesIn: cats, conversation: { investigation: { ids: ['TX-M2'] } }, area });
  assert.deepEqual(p('Is there an alternate supply?').target, { kind: 'PREVIOUS', ids: ['TX-M2'], statusFilters: [], categories: null, reference: 'collection' });
  assert.deepEqual(p('Show all supply assets').target.categories, ['Supply'], 'the category itself still works');
  assert.equal(p('Prepare a maintenance report for transformers').target.categories[0], 'Transformer');
});

test('§26 validation list: each question read with its objective, target and response type, in context', () => {
  const after = { investigation: { ids: ['TX-M2'] }, collection: { ids: ['TX-M2'] } };
  const rows = [
    // [question, context, primary intent, target kind, target ids, response type]
    ['Which assets are degraded in this area?', {}, INTENT.ASSET_STATUS, 'FILTER', null, 'ASSET_COLLECTION'],
    ['For degraded asset, what needs to be fixed?', {}, INTENT.CORRECTIVE_ACTIONS, 'FILTER', null, 'MAINTENANCE_ASSESSMENT'],
    ['What needs to be fixed?', after, INTENT.CORRECTIVE_ACTIONS, 'PREVIOUS', ['TX-M2'], 'MAINTENANCE_ASSESSMENT'],
    ['Why is this asset degraded?', after, INTENT.ASSET_DIAGNOSIS, 'PREVIOUS', ['TX-M2'], 'MAINTENANCE_ASSESSMENT'],
    ['Since when has this asset been degraded?', after, INTENT.HISTORICAL_STATUS, 'PREVIOUS', ['TX-M2'], 'MAINTENANCE_ASSESSMENT'],
    ['Is its condition getting worse?', after, INTENT.CONDITION_TREND, 'PREVIOUS', ['TX-M2'], 'MAINTENANCE_ASSESSMENT'],
    ['Has this issue occurred before?', after, INTENT.RECURRING_DEFECTS, 'PREVIOUS', ['TX-M2'], 'MAINTENANCE_ASSESSMENT'],
    ['Which repairs are still outstanding?', after, INTENT.OUTSTANDING_ACTIONS, 'PREVIOUS', ['TX-M2'], 'MAINTENANCE_ASSESSMENT'],
    ['Can we continue operating this asset?', after, INTENT.OPERATING_RESTRICTIONS, 'PREVIOUS', ['TX-M2'], 'MAINTENANCE_ASSESSMENT'],
    ['What happens if we shut it down?', after, INTENT.OUTAGE_IMPACT, 'PREVIOUS', ['TX-M2'], 'OUTAGE_SIMULATION'],
    ['Is there an alternate supply?', after, INTENT.ALTERNATE_SUPPLY, 'PREVIOUS', ['TX-M2'], 'ALTERNATE_SUPPLY'],
    ['What needs to be done before replacement?', after, INTENT.REPLACEMENT_ASSESSMENT, 'PREVIOUS', ['TX-M2'], 'REPLACEMENT_ASSESSMENT'],
    ['Prepare a report of these issues.', after, INTENT.REPORT_GENERATION, 'PREVIOUS', ['TX-M2'], 'REPORT'],
    ['Inform the maintenance team.', after, INTENT.EMAIL_DRAFT, 'PREVIOUS', ['TX-M2'], 'EMAIL_DRAFT'],
    ['Show what needs to be fixed for all degraded assets across Seagirt.', after, INTENT.CORRECTIVE_ACTIONS, 'FILTER', null, 'MAINTENANCE_ASSESSMENT'],
  ];
  for (const [q, conv, intent, kind, ids, response] of rows) {
    const p = plan(q, conv);
    assert.equal(p.primaryIntent, intent, `${q}: intent`);
    assert.equal(p.target.kind, kind, `${q}: target`);
    if (ids) assert.deepEqual(p.target.ids, ids, `${q}: ids`);
    assert.equal(p.responseType, response, `${q}: response`);
  }
  assert.equal(plan('Show what needs to be fixed for all degraded assets across Seagirt.', after).scope.type, 'TERMINAL', 'scope override, area kept by the caller');
  // Generic asset support: the same objective for every category.
  for (const c of ['transformers', 'circuit breakers', 'cranes', 'lighting circuits', 'switchgear', 'substations', 'feeders'])
    assert.equal(resolveObjective(`For degraded ${c}, what needs to be fixed?`).primary, INTENT.CORRECTIVE_ACTIONS, c);
});
