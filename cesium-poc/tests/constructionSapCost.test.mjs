/**
 * Phase 7C — the live SAP S/4HANA cost read.
 *
 * Fixture-driven. The fixtures are the SHAPE of what SAP actually returned during the Phase 7B
 * investigation — OData v2 with `/Date(…)/` values, decimals as strings, the null GUID for a
 * root, and a hierarchy whose dotted codes disagree with its parent links. A test that needs the
 * internet, a shared tenant and a live credential fails on a train and tells you nothing when it
 * does; live verification is reported separately.
 *
 * Every one of the four Phase 7B traps has a test that fails if the guard is removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import {
  CONNECTION, FAILURE, buildHierarchy, createSapCostAdapter, filtersApplied,
} from '../server/construction/sapCost.mjs';
import {
  EXPECTED, EXPENSE_ACCOUNTS, LEDGER, NULL_GUID, PROJECT_ID, SOURCE,
} from '../server/construction/sapCostConfig.mjs';
import { reconcileSapCost, sameMoney, signedAmount } from '../server/construction/sapReconciliation.mjs';
import { odataDecimal } from '../server/construction/sapHttp.mjs';
import { BASE, createConstructionApi } from '../server/construction/api.mjs';
import {
  COST_STATE, WARNING_TONE, money, warningTone,
} from '../src/construction/sapLiveCost.js';

const KEY = 'test-key-never-logged-0002';
const quiet = { warn() {}, error() {}, log() {} };

/* ── fixtures, shaped exactly as SAP returns them ──────────────────────────────────────────── */

const PROJECT_UUID = '00163e37-bedf-1eda-99a2-514d42ad42b0';

const PROJECT_ROW = {
  Project: 'RNG002', ProjectDescription: 'Mount Fuji', ProjectUUID: PROJECT_UUID,
  ProjectInternalID: '00000421', CompanyCode: '1710', ControllingArea: 'A000',
  ProjectCurrency: 'USD', ProcessingStatus: '10',
  ProjectStartDate: '/Date(1577923200000)/', ProjectEndDate: '/Date(1588204800000)/',
  ProfitCenter: 'YB101', ResponsibleCostCenter: '17101902',
  LastChangeDateTime: '/Date(1588204800000+0000)/',
};

/** The real structure: note that `RNG002.1.3` sits under `RNG002.0.2`, not `.0.3`. */
const ELEMENT_TREE = [
  ['RNG002', 'u-root', NULL_GUID, 'Mount Fuji'],
  ['RNG002.0.1', 'u-01', 'u-root', 'Project-Based Service: Time & Expenses'],
  ['RNG002.0.2', 'u-02', 'u-root', 'Project-Based Service: Time & Expenses'],
  ['RNG002.0.3', 'u-03', 'u-root', 'Project-Based Service: Time & Expenses'],
  ['RNG002.0.4', 'u-04', 'u-root', 'Project-Based Service: Usage Based'],
  ['RNG002.0.5', 'u-05', 'u-root', 'Project-Based Service: Usage Based'],
  ['RNG002.0.6', 'u-06', 'u-root', 'Project-Based Service: Fixed Price'],
  ['RNG002.1.1', 'u-11', 'u-01', 'Discover'],
  ['RNG002.1.2', 'u-12', 'u-03', 'Prepare'],
  ['RNG002.1.3', 'u-13', 'u-02', 'Explore'],
  ['RNG002.1.4', 'u-14', 'u-05', 'Realize'],
  ['RNG002.1.5', 'u-15', 'u-04', 'Deploy'],
  ['RNG002.1.6', 'u-16', 'u-06', 'Run'],
];

const elementRow = ([code, uuid, parent, description]) => ({
  ProjectElement: code, ProjectElementDescription: description, ProjectElementUUID: uuid,
  ParentObjectUUID: parent, ProjectUUID: PROJECT_UUID, WBSElementInternalID: '80',
  ProcessingStatus: '10', PlannedStartDate: '/Date(1577923200000)/',
  PlannedEndDate: '/Date(1588204800000)/', CompanyCode: '1710', ControllingArea: 'A000',
  ResponsibleCostCenter: '17101902',
});
const ELEMENT_ROWS = ELEMENT_TREE.map(elementRow);

const expenseRow = (wbs, gl, period, amount, extra = {}) => ({
  WBSElement: wbs, WBSElementDescription: 'x', GLAccount: gl,
  GLAccountName: { 61003000: 'Trav.Expense Hotel', 61005000: 'Travel Exp Grd Trnsp',
    94308000: 'Consulting' }[gl] ?? 'x',
  FiscalYearPeriod: period, ControllingDebitCreditCode: 'D', JrnlEntryItemObsoleteReason: '',
  CompanyCode: '1710', Ledger: '0L',
  AmountInCompanyCodeCurrency: amount.toFixed(2), CompanyCodeCurrency: 'USD', ...extra,
});

/** The twelve aggregated rows that total 5,997.00 USD across five elements. */
const EXPENSE_ROWS = [
  expenseRow('RNG002.0.2', '94308000', '003/2020', 444.00),
  expenseRow('RNG002.1.1', '94308000', '001/2020', 1246.25),
  expenseRow('RNG002.1.2', '94308000', '001/2020', 110.00),
  expenseRow('RNG002.1.2', '94308000', '002/2020', 825.00),
  expenseRow('RNG002.1.2', '61003000', '003/2020', 500.00),
  expenseRow('RNG002.1.2', '61005000', '003/2020', 888.00),
  expenseRow('RNG002.1.3', '94308000', '001/2020', 100.00),
  expenseRow('RNG002.1.3', '94308000', '002/2020', 715.00),
  expenseRow('RNG002.1.3', '61003000', '003/2020', 425.00),
  expenseRow('RNG002.1.3', '61005000', '003/2020', 543.75),
  expenseRow('RNG002.1.4', '61003000', '002/2020', 200.00),
  expenseRow('RNG002.1.4', '61005000', '003/2020', 0.00),
];

/**
 * A fetch that answers from the fixtures, routed by URL.
 *
 * It also RECORDS every request, so the tests can assert on the filters that were sent — which is
 * where the ledger and account guards actually live.
 */
function stubSap({ projectRows = [PROJECT_ROW], elementRows = ELEMENT_ROWS,
  expenseRows = EXPENSE_ROWS, count = '57', status = 200, failOn = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const text = String(url);
    calls.push({ url: text, init, params: new URL(text).searchParams });
    if (failOn && text.includes(failOn)) {
      return { status: 500, ok: false, body: null,
        text: async () => '{"error":{"message":{"value":"upstream"}}}' };
    }
    const json = value => ({ status, ok: status < 300, body: null,
      text: async () => JSON.stringify(value) });
    if (text.includes('/$count')) {
      return { status, ok: status < 300, body: null, text: async () => count };
    }
    if (text.includes('A_EnterpriseProjectElement')) return json({ d: { results: elementRows } });
    if (text.includes('A_EnterpriseProject')) return json({ d: { results: projectRows } });
    if (text.includes('A_JournalEntryItemBasic')) return json({ d: { results: expenseRows } });
    return json({ d: { results: [] } });
  };
  impl.calls = calls;
  return impl;
}

const adapterWith = (fetchImpl, env = {}) => createSapCostAdapter({
  fetchImpl, logger: quiet,
  env: { SAP_SANDBOX_API_KEY: KEY, SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com', ...env },
});

/* ── trap 1: five parallel ledgers ─────────────────────────────────────────────────────────── */

test('every expense query filters to the leading ledger', async () => {
  const fetchImpl = stubSap();
  await adapterWith(fetchImpl).expenses();
  const journal = fetchImpl.calls.find(c => c.url.includes('A_JournalEntryItemBasic')
    && !c.url.includes('$count'));
  assert.match(journal.params.get('$filter'), /Ledger eq '0L'/);
});

test('a row from another ledger is reported, never silently added', () => {
  // The sandbox carries 0C, 0E, 0L, 2L and ZS holding the same postings. If one ever came back,
  // the total would be inflated and nothing on screen would say why.
  const rows = [...EXPENSE_ROWS, expenseRow('RNG002.1.1', '94308000', '001/2020', 999, { Ledger: '2L' })];
  const { warnings } = reconcileSapCost({ elements: [], rows: [] });
  assert.equal(warnings.length, 0, 'an empty read raises nothing');
  // The adapter is what inspects the ledger on returned rows.
  return (async () => {
    const result = await adapterWith(stubSap({ expenseRows: rows })).expenses();
    const stray = result.warnings.find(w => w.kind === 'LEDGER_MISMATCH');
    assert.ok(stray, 'a foreign ledger row must raise LEDGER_MISMATCH');
    assert.match(stray.subject, /2L/);
  })();
});

test('the ledger filter is shown to the operator, with its reason', () => {
  const filters = filtersApplied();
  assert.equal(filters.ledger, LEDGER);
  assert.match(filters.ledgerReason, /five parallel ledgers/i);
  assert.match(filters.ledgerReason, /multiplied by five/i);
});

/* ── trap 2: the entity aggregates server-side ─────────────────────────────────────────────── */

test('an explicit $select is always sent, and $skip never is', async () => {
  const fetchImpl = stubSap();
  const adapter = adapterWith(fetchImpl);
  await adapter.project();
  await adapter.hierarchy({ projectUuid: PROJECT_UUID });
  await adapter.expenses();
  for (const call of fetchImpl.calls) {
    if (call.url.includes('/$count')) continue;
    assert.ok(call.params.get('$select'), `no $select on ${call.url}`);
    assert.equal(call.params.get('$skip'), null,
      '$skip is unreliable on the analytical entity and must never be sent');
  }
});

test('aggregated rows and SAP source line items are reported as different figures', async () => {
  const result = await adapterWith(stubSap({ count: '57' })).expenses();
  assert.equal(result.aggregatedRowCount, 12, 'what SAP returned to us');
  assert.equal(result.sourceRowCount, 57, 'the line items behind them, per SAP $count');
  assert.notEqual(result.aggregatedRowCount, result.sourceRowCount);
});

test('$count is requested without $format=json, which the service rejects', async () => {
  const fetchImpl = stubSap();
  await adapterWith(fetchImpl).expenses();
  const count = fetchImpl.calls.find(c => c.url.includes('/$count'));
  assert.ok(count, 'the source count is requested');
  assert.equal(count.params.get('$format'), null,
    '$count returns text/plain and answers 400 when $format=json is sent');
});

test('an unreadable $count is null and warned about, never zero', async () => {
  // `Number(null)` is 0 AND finite, so a naive implementation shows "0 source rows" for "we could
  // not ask" — a confident wrong figure instead of an absent one.
  const result = await adapterWith(stubSap({ count: 'not a number' })).expenses();
  assert.equal(result.sourceRowCount, null);
  assert.ok(result.warnings.some(w => w.kind === 'NO_SOURCE_COUNT'));
});

/* ── trap 3: GL account semantics ──────────────────────────────────────────────────────────── */

test('only the three expense accounts are requested', async () => {
  const fetchImpl = stubSap();
  await adapterWith(fetchImpl).expenses();
  const filter = fetchImpl.calls.find(c => c.url.includes('A_JournalEntryItemBasic')
    && !c.url.includes('$count')).params.get('$filter');
  for (const entry of EXPENSE_ACCOUNTS) {
    assert.ok(filter.includes(`GLAccount eq '${entry.account}'`), `${entry.account} not requested`);
  }
  // And none of the revenue or WIP accounts.
  for (const excluded of ['13711100', '13811100', '41910000', '44401100']) {
    assert.ok(!filter.includes(excluded), `${excluded} must not be requested`);
  }
});

test('a revenue row that came back anyway is reported, not counted as cost', async () => {
  const rows = [...EXPENSE_ROWS,
    expenseRow('RNG002.1.1', '41910000', '001/2020', -9562.50)];
  const result = await adapterWith(stubSap({ expenseRows: rows })).expenses();
  const stray = result.warnings.find(w => w.kind === 'ACCOUNT_MISMATCH');
  assert.ok(stray, 'an account outside the expense list must raise ACCOUNT_MISMATCH');
  assert.match(stray.subject, /41910000/);
});

test('the excluded accounts are named with their reasons, so the exclusion is visible', () => {
  const filters = filtersApplied();
  const excluded = filters.excludedAccounts.map(a => a.account);
  for (const account of ['13711000', '13711100', '13811000', '13811100',
    '41910000', '41930000', '44401000', '44401100']) {
    assert.ok(excluded.includes(account), `${account} is not listed as excluded`);
  }
  for (const entry of filters.excludedAccounts) assert.ok(entry.reason, `${entry.account} has no reason`);
});

/* ── trap 4: the hierarchy comes from UUIDs ────────────────────────────────────────────────── */

test('the tree is built from ParentObjectUUID, not from the dotted code', () => {
  const elements = ELEMENT_TREE.map(([code, uuid, parentUuid, description]) =>
    ({ code, uuid, parentUuid, description }));
  const { ordered, warnings } = buildHierarchy(elements);
  assert.equal(warnings.length, 0);
  const parentOf = code => ordered.find(n => n.code === code).parentCode;
  // The codes suggest `.1.2` sits under `.0.2`. It does not. This is the whole point.
  assert.equal(parentOf('RNG002.1.2'), 'RNG002.0.3');
  assert.equal(parentOf('RNG002.1.3'), 'RNG002.0.2');
  assert.equal(parentOf('RNG002.1.4'), 'RNG002.0.5');
  assert.equal(parentOf('RNG002'), null);
});

test('the null GUID is a root, not an unresolved parent', () => {
  const { roots, warnings } = buildHierarchy([
    { code: 'A', uuid: 'a', parentUuid: NULL_GUID },
    { code: 'A.1', uuid: 'a1', parentUuid: 'a' },
  ]);
  assert.deepEqual(roots.map(r => r.code), ['A']);
  assert.equal(warnings.length, 0, 'the null GUID must not be reported as a missing parent');
});

test('depth is assigned from the tree and drives the indentation', () => {
  const elements = ELEMENT_TREE.map(([code, uuid, parentUuid]) => ({ code, uuid, parentUuid }));
  const { ordered } = buildHierarchy(elements);
  const depth = code => ordered.find(n => n.code === code).depth;
  assert.equal(depth('RNG002'), 0);
  assert.equal(depth('RNG002.0.1'), 1);
  assert.equal(depth('RNG002.1.1'), 2);
});

test('a parent that was not retrieved is shown at the root and reported', () => {
  const { roots, warnings } = buildHierarchy([
    { code: 'A', uuid: 'a', parentUuid: NULL_GUID },
    { code: 'B', uuid: 'b', parentUuid: 'missing-uuid' },
  ]);
  assert.equal(roots.length, 2, 'the orphan is still shown rather than lost');
  const warned = warnings.find(w => w.kind === 'UNRESOLVED_PARENT');
  assert.ok(warned);
  assert.equal(warned.subject, 'B');
});

test('a duplicate UUID keeps the first and reports the clash', () => {
  const { ordered, warnings } = buildHierarchy([
    { code: 'A', uuid: 'a', parentUuid: NULL_GUID },
    { code: 'A-again', uuid: 'a', parentUuid: NULL_GUID },
  ]);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].code, 'A');
  assert.ok(warnings.some(w => w.kind === 'DUPLICATE_UUID'));
});

test('a duplicate code is reported although the UUID keeps the tree correct', () => {
  const { ordered, warnings } = buildHierarchy([
    { code: 'A', uuid: 'a1', parentUuid: NULL_GUID },
    { code: 'A', uuid: 'a2', parentUuid: NULL_GUID },
  ]);
  assert.equal(ordered.length, 2, 'both are real elements');
  assert.ok(warnings.some(w => w.kind === 'DUPLICATE_CODE'));
});

test('a cycle is detected instead of rendering forever', () => {
  const { warnings } = buildHierarchy([
    { code: 'A', uuid: 'a', parentUuid: 'c' },
    { code: 'B', uuid: 'b', parentUuid: 'a' },
    { code: 'C', uuid: 'c', parentUuid: 'b' },
  ]);
  assert.ok(warnings.some(w => w.kind === 'CYCLE'), 'a parent cycle must be reported');
});

test('an element with no UUID is dropped and reported', () => {
  const { ordered, warnings } = buildHierarchy([
    { code: 'A', uuid: null, parentUuid: NULL_GUID },
    { code: 'B', uuid: 'b', parentUuid: NULL_GUID },
  ]);
  assert.deepEqual(ordered.map(n => n.code), ['B']);
  assert.ok(warnings.some(w => w.kind === 'MISSING_UUID'));
});

/* ── reconciliation ────────────────────────────────────────────────────────────────────────── */

const reconciled = () => reconcileSapCost({
  elements: ELEMENT_TREE.map(([code, uuid, parentUuid, description]) =>
    ({ code, uuid, parentUuid, description })),
  rows: EXPENSE_ROWS.map(r => ({
    wbs: r.WBSElement, wbsDescription: r.WBSElementDescription, glAccount: r.GLAccount,
    glAccountName: r.GLAccountName, fiscalPeriod: r.FiscalYearPeriod,
    debitCredit: r.ControllingDebitCreditCode, obsoleteReason: r.JrnlEntryItemObsoleteReason || null,
    companyCode: r.CompanyCode, ledger: r.Ledger,
    amount: odataDecimal(r.AmountInCompanyCodeCurrency), currency: r.CompanyCodeCurrency,
  })),
});

test('the fixture reconciles to the verified total across five elements', () => {
  const r = reconciled();
  assert.equal(r.total, EXPECTED.totalAmount);
  assert.equal(r.currency, 'USD');
  assert.equal(r.counts.wbsElements, EXPECTED.wbsElements);
  assert.equal(r.counts.wbsWithExpense, EXPECTED.wbsWithExpense);
  assert.equal(r.counts.unmatchedReferences, 0);
  assert.ok(r.balances);
  assert.deepEqual(r.fiscalPeriods, EXPECTED.fiscalPeriods);
});

test('the per-element amounts add up to the project total', () => {
  const r = reconciled();
  const sum = r.elementTotals.reduce((a, e) => a + e.amount, 0);
  assert.ok(sameMoney(sum, r.total), `${sum} does not equal ${r.total}`);
  assert.deepEqual(r.elementTotals.map(e => e.wbs),
    ['RNG002.0.2', 'RNG002.1.1', 'RNG002.1.2', 'RNG002.1.3', 'RNG002.1.4']);
});

test('the per-account amounts also add up to the project total', () => {
  const r = reconciled();
  assert.ok(sameMoney(r.byAccount.reduce((a, e) => a + e.amount, 0), r.total));
  assert.deepEqual(r.byAccount.map(a => a.account), ['61003000', '61005000', '94308000']);
});

test('an element with no postings is absent from the breakdown, not zero', () => {
  const r = reconciled();
  assert.ok(!r.elementTotals.some(e => e.wbs === 'RNG002.1.5'));
  assert.equal(r.counts.wbsWithoutExpense, 8);
});

test('a credit subtracts; a debit adds', () => {
  assert.equal(signedAmount({ amount: 100, debitCredit: 'D' }), 100);
  assert.equal(signedAmount({ amount: 100, debitCredit: 'C' }), -100);
  assert.equal(signedAmount({ amount: 100, debitCredit: '' }), 100);
  assert.equal(signedAmount({ amount: null, debitCredit: 'D' }), null);
});

test('an expense referencing an unknown WBS is unmatched, counted and excluded', () => {
  const base = reconciled();
  const r = reconcileSapCost({
    elements: ELEMENT_TREE.map(([code, uuid, parentUuid]) => ({ code, uuid, parentUuid })),
    rows: [...base.elementTotals.map(e => ({ wbs: e.wbs, amount: e.amount, currency: 'USD',
      debitCredit: 'D', glAccount: '94308000', fiscalPeriod: '001/2020' })),
    { wbs: 'GHOST.1.1', amount: 500, currency: 'USD', debitCredit: 'D',
      glAccount: '94308000', fiscalPeriod: '001/2020' }],
  });
  assert.equal(r.counts.unmatchedReferences, 1);
  assert.equal(r.unmatchedTotal, 500);
  assert.ok(!r.elementTotals.some(e => e.wbs === 'GHOST.1.1'),
    'an unmatched reference must not appear in the per-element breakdown');
  assert.ok(r.warnings.some(w => w.kind === 'UNMATCHED_WBS' && w.subject === 'GHOST.1.1'));
  // It is still in the project total, because the money was posted.
  assert.ok(sameMoney(r.total, base.total + 500));
});

test('two currencies produce no combined total, and say so', () => {
  const r = reconcileSapCost({
    elements: [{ code: 'A', uuid: 'a', parentUuid: NULL_GUID }],
    rows: [
      { wbs: 'A', amount: 100, currency: 'USD', debitCredit: 'D' },
      { wbs: 'A', amount: 50, currency: 'EUR', debitCredit: 'D' },
    ],
  });
  assert.equal(r.total, null, 'USD and EUR must never be added into one number');
  assert.equal(r.currency, null);
  assert.deepEqual(r.totalsByCurrency, { USD: 100, EUR: 50 });
  assert.ok(r.warnings.some(w => w.kind === 'NO_SINGLE_TOTAL'));
});

test('figures that differ from the verified baseline are reported, not corrected', () => {
  const r = reconcileSapCost({
    elements: [{ code: 'A', uuid: 'a', parentUuid: NULL_GUID }],
    rows: [{ wbs: 'A', amount: 1234.56, currency: 'USD', debitCredit: 'D' }],
  });
  // The figure shown is what came back, never the expectation.
  assert.equal(r.total, 1234.56);
  const drift = r.warnings.find(w => w.kind === 'DIFFERS_FROM_VERIFIED');
  assert.ok(drift);
  assert.match(drift.subject, /1234\.56/);
  assert.equal(r.expected.totalAmount, EXPECTED.totalAmount);
});

test('credits and obsolete items are flagged as possible reversals', async () => {
  const rows = [
    expenseRow('RNG002.1.1', '94308000', '001/2020', 100, { ControllingDebitCreditCode: 'C' }),
    expenseRow('RNG002.1.1', '94308000', '001/2020', 50, { JrnlEntryItemObsoleteReason: 'X' }),
  ];
  const result = await adapterWith(stubSap({ expenseRows: rows })).expenses();
  const credit = result.warnings.find(w => w.kind === 'CREDIT_POSTINGS');
  assert.ok(credit);
  assert.match(credit.detail, /no document number or reversal flag/);
  assert.ok(result.warnings.some(w => w.kind === 'OBSOLETE_ITEMS'));
});

/* ── failure handling ──────────────────────────────────────────────────────────────────────── */

test('a missing key is NOT_CONFIGURED on every route, and makes no request', async () => {
  const fetchImpl = stubSap();
  const adapter = adapterWith(fetchImpl, { SAP_SANDBOX_API_KEY: '' });
  for (const call of [adapter.project(), adapter.hierarchy(), adapter.expenses()]) {
    const result = await call;
    assert.equal(result.state, CONNECTION.NOT_CONFIGURED);
    assert.equal(result.failure, null, 'not configured is not a connection failure');
    assert.match(result.reason, /SAP_SANDBOX_API_KEY is not set/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('a 401 is an auth failure and names no credential', async () => {
  const result = await adapterWith(stubSap({ status: 401 })).project();
  assert.equal(result.state, CONNECTION.FAILED);
  assert.equal(result.failure, FAILURE.AUTH);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('a 500 from SAP is reported, and no synthetic data is substituted', async () => {
  const result = await adapterWith(stubSap({ failOn: 'A_JournalEntryItemBasic' })).expenses();
  assert.equal(result.state, CONNECTION.FAILED);
  assert.equal(result.failure, FAILURE.HTTP);
  assert.deepEqual(result.rows, [], 'an empty list, never a stored copy');
  assert.match(result.reason, /HTTP 500/);
});

test('a project SAP does not have is reported rather than invented', async () => {
  const result = await adapterWith(stubSap({ projectRows: [] })).project();
  assert.equal(result.state, CONNECTION.CONNECTED, 'the call itself succeeded');
  assert.equal(result.project, null);
  assert.ok(result.warnings.some(w => w.kind === 'PROJECT_NOT_FOUND'));
});

test('a changed element count is reported as drift', async () => {
  const result = await adapterWith(stubSap({ elementRows: ELEMENT_ROWS.slice(0, 9) }))
    .hierarchy({ projectUuid: PROJECT_UUID });
  assert.equal(result.elementCount, 9);
  assert.ok(result.warnings.some(w => w.kind === 'COUNT_CHANGED'));
});

test('elements from another project are excluded and reported', async () => {
  const foreign = { ...elementRow(['OTHER.1', 'u-x', NULL_GUID, 'Another']), ProjectUUID: 'other-uuid' };
  const result = await adapterWith(stubSap({ elementRows: [...ELEMENT_ROWS, foreign] }))
    .hierarchy({ projectUuid: PROJECT_UUID });
  assert.equal(result.elementCount, 13);
  assert.ok(!result.elements.some(e => e.code === 'OTHER.1'));
  assert.ok(result.warnings.some(w => w.kind === 'FOREIGN_ELEMENT'));
});

/* ── the credential ────────────────────────────────────────────────────────────────────────── */

test('the key travels in a header, never in a URL, on every cost request', async () => {
  const fetchImpl = stubSap();
  const adapter = adapterWith(fetchImpl);
  await adapter.project();
  await adapter.hierarchy({ projectUuid: PROJECT_UUID });
  await adapter.expenses();
  assert.ok(fetchImpl.calls.length >= 4);
  for (const call of fetchImpl.calls) {
    assert.ok(!call.url.includes(KEY), 'the key reached a URL');
    assert.equal(call.init.headers.APIKey, KEY);
    assert.equal(call.init.redirect, 'error');
  }
});

test('no cost response contains the key, whatever happened', async () => {
  for (const options of [{}, { status: 401 }, { status: 500 },
    { failOn: 'A_EnterpriseProject' }]) {
    const adapter = adapterWith(stubSap(options));
    for (const call of [adapter.project(), adapter.hierarchy(), adapter.expenses()]) {
      const result = await call;
      assert.ok(!JSON.stringify(result).includes(KEY),
        `the key leaked in a ${result.state}/${result.failure} response`);
    }
  }
});

test('nothing logged can carry the credential', async () => {
  const lines = [];
  const logger = { warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  for (const options of [{ status: 401 }, { status: 500 }]) {
    await createSapCostAdapter({ fetchImpl: stubSap(options), logger,
      env: { SAP_SANDBOX_API_KEY: KEY, SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com' } })
      .expenses();
  }
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(!line.includes(KEY), `the key appeared in a log line: ${line}`);
    assert.ok(!/APIKey\s*[:=]\s*\S/.test(line), `a log line printed the auth header: ${line}`);
  }
});

/* ── the endpoints ─────────────────────────────────────────────────────────────────────────── */

function harness(options = {}) {
  const fetchImpl = stubSap(options);
  const api = createConstructionApi({ path: ':memory:', logger: quiet,
    sandboxOptions: { fetchImpl, logger: quiet,
      env: { SAP_SANDBOX_API_KEY: KEY, SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com' } } });
  const get = route => new Promise((resolve, reject) => {
    const res = { writeHead(s) { this.statusCode = s; },
      end(t) { try { resolve({ status: this.statusCode, body: JSON.parse(t) }); } catch (e) { reject(e); } } };
    api.handle({ url: `${BASE}${route}`, method: 'GET', on() {} }, res)
      .then(h => { if (!h) reject(new Error(`${route} not handled`)); }, reject);
  });
  return { api, get, fetchImpl };
}

test('all four SAP cost endpoints answer', async () => {
  const { api, get } = harness();
  for (const route of ['/sap-cost/project', '/sap-cost/hierarchy', '/sap-cost/expenses',
    '/sap-cost/reconciliation']) {
    const { status, body } = await get(route);
    assert.equal(status, 200, route);
    assert.equal(body.state, CONNECTION.CONNECTED, route);
    // Source metadata, filters, status and timestamp on every one.
    assert.ok(body.source, `${route} has no source metadata`);
    assert.ok(body.filters, `${route} has no filters`);
    assert.ok(body.retrievedAt, `${route} has no timestamp`);
    assert.equal(body.httpStatus, 200);
    assert.ok(Array.isArray(body.warnings), `${route} has no warnings array`);
  }
  api.close();
});

test('the reconciliation endpoint returns the whole picture in one call', async () => {
  const { api, get } = harness();
  const { body } = await get('/sap-cost/reconciliation');
  assert.equal(body.project.project, PROJECT_ID);
  assert.equal(body.elements.length, 13);
  assert.deepEqual(body.rootCodes, ['RNG002']);
  assert.equal(body.reconciliation.total, EXPECTED.totalAmount);
  assert.equal(body.reconciliation.currency, 'USD');
  assert.equal(body.aggregatedRowCount, 12);
  assert.equal(body.sourceRowCount, 57);
  assert.deepEqual(body.warnings, []);
  api.close();
});

test('an unknown SAP cost route is a 404, not a silent empty answer', async () => {
  const { api, get } = harness();
  const { status, body } = await get('/sap-cost/nonsense');
  assert.equal(status, 404);
  assert.match(body.error, /Unknown SAP cost route/);
  api.close();
});

test('one failing leg fails the whole reconciliation rather than reconciling nothing', async () => {
  const { api, get } = harness({ failOn: 'A_JournalEntryItemBasic' });
  const { status, body } = await get('/sap-cost/reconciliation');
  assert.equal(status, 200);
  assert.equal(body.state, CONNECTION.FAILED);
  assert.equal(body.reconciliation, null,
    'a reconciliation over a half-arrived read would reconcile perfectly against nothing');
  api.close();
});

test('the SAP cost routes answer without the SQLite database', async () => {
  const fetchImpl = stubSap();
  const api = createConstructionApi({ path: '/nonexistent-dir-7c/x.sqlite', logger: quiet,
    sandboxOptions: { fetchImpl, logger: quiet,
      env: { SAP_SANDBOX_API_KEY: KEY, SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com' } } });
  const get = route => new Promise(resolve => {
    const res = { writeHead(s) { this.statusCode = s; },
      end(t) { resolve({ status: this.statusCode, body: JSON.parse(t) }); } };
    void api.handle({ url: `${BASE}${route}`, method: 'GET', on() {} }, res);
  });
  assert.equal((await get('/sap-cost/project')).body.state, CONNECTION.CONNECTED);
  assert.equal((await get('/overview')).status, 503);
  api.close();
});

/* ── isolation ─────────────────────────────────────────────────────────────────────────────── */

test('reading SAP cost writes nothing to the integration database', async () => {
  const { api, get, fetchImpl } = harness();
  const before = (await get('/overview')).body;
  await get('/sap-cost/reconciliation');
  await get('/sap-cost/reconciliation');
  const after = (await get('/overview')).body;
  assert.deepEqual(after.totals, before.totals, 'the normalized tables must be untouched');
  assert.equal(after.totals.syncRuns, before.totals.syncRuns, 'no sync run may be opened');
  assert.equal(after.totals.auditEvents, before.totals.auditEvents, 'no audit event may be written');
  assert.ok(fetchImpl.calls.length > 0, 'SAP was in fact called');
  api.close();
});

test('Run Demo Sync never reaches SAP', async () => {
  const { api, fetchImpl } = harness();
  const post = route => new Promise(resolve => {
    const res = { writeHead(s) { this.statusCode = s; },
      end(t) { resolve({ status: this.statusCode, body: JSON.parse(t) }); } };
    void api.handle({ url: `${BASE}${route}`, method: 'POST',
      on(event, handler) { if (event === 'end') handler(); return this; } }, res);
  });
  const { body } = await post('/sync');
  assert.ok(body.runs.length > 0);
  assert.equal(fetchImpl.calls.length, 0,
    'INT-01 to INT-05 must stay entirely local — no interface may reach SAP');
  api.close();
});

test('the cost adapter belongs to no pilot interface', () => {
  const adapter = adapterWith(stubSap());
  assert.equal(adapter.interfaceId, null);
  assert.equal(adapter.origin, 'SANDBOX_S4HANA');
  assert.equal(typeof adapter.fetch, 'undefined', 'the sync engine has nothing to call');
});

test('the source metadata says what this is and what it is not', () => {
  assert.match(SOURCE.notConstruction, /professional-services project/);
  assert.match(SOURCE.notConstruction, /no quantities, units, BOQ items or physical progress/);
  assert.match(SOURCE.notLinked, /not mapped to the synthetic Tower A project/);
  assert.match(SOURCE.notLinked, /INT-04 continues to read the mock src_sap_\* tables/);
  assert.equal(SOURCE.readOnly, true);
});

test('no SAP cost module writes, and none names a write method', async () => {
  const dir = new URL('../server/construction/', import.meta.url);
  for (const name of ['sapCost.mjs', 'sapCostConfig.mjs', 'sapReconciliation.mjs', 'sapHttp.mjs']) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE|MERGE)'/.test(source), `${name} names a write method`);
    assert.ok(!/\$batch/.test(source), `${name} uses $batch, which can carry writes`);
  }
  // And the pilot interfaces still name no SAP host.
  for (const name of ['adapters.mjs', 'sync.mjs', 'outbound.mjs', 'destinations.mjs', 'db.mjs']) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.ok(!/sandbox\.api\.sap\.com/.test(source), `${name} names the SAP host`);
    assert.ok(!/s4hanacloud/.test(source), `${name} names an S/4HANA service path`);
  }
});

test('no frontend file names the SAP host, the service path or the key', async () => {
  const dir = new URL('../src/construction/', import.meta.url);
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.ok(!/sandbox\.api\.sap\.com/.test(source), `${name} names the SAP host`);
    assert.ok(!/s4hanacloud|API_ENTERPRISE_PROJECT_SRV|API_JOURNALENTRYITEMBASIC/.test(source),
      `${name} names an SAP service — the server owns the endpoints`);
    assert.ok(!/SAP_SANDBOX_API_KEY/.test(source), `${name} names the server-side key`);
  }
});

/* ── the screen's own vocabulary ───────────────────────────────────────────────────────────── */

test('an absent amount is a dash, never a zero', () => {
  assert.equal(money(null, 'USD'), '—');
  assert.equal(money(undefined, 'USD'), '—');
  assert.equal(money('nonsense', 'USD'), '—');
  assert.equal(money(0, 'USD'), '0.00 USD', 'a real zero is a real figure');
  assert.equal(money(5997, 'USD'), '5,997.00 USD');
  assert.equal(money(1246.25, 'USD'), '1,246.25 USD');
});

test('every state the adapter reports has a word on the screen', () => {
  for (const state of Object.values(CONNECTION)) {
    assert.ok(COST_STATE[state], `no label for ${state}`);
  }
  assert.equal(COST_STATE.NOT_CONFIGURED.tone, 'warn', 'not configured is not a failure');
  assert.equal(COST_STATE.CONNECTED.tone, 'ok');
  assert.equal(COST_STATE.FAILED.tone, 'bad');
});

test('every warning the backend can raise has a tone, and an unknown one is not reassuring', () => {
  const kinds = ['DOES_NOT_RECONCILE', 'LEDGER_MISMATCH', 'ACCOUNT_MISMATCH', 'CYCLE',
    'DUPLICATE_UUID', 'PROJECT_NOT_FOUND', 'UNMATCHED_WBS', 'UNRESOLVED_PARENT', 'DETACHED',
    'MIXED_CURRENCY', 'NO_SINGLE_TOTAL', 'CREDIT_POSTINGS', 'OBSOLETE_ITEMS', 'MISSING_AMOUNT',
    'UNREADABLE_AMOUNT', 'UNSIGNED_ROWS', 'DUPLICATE_CODE', 'FOREIGN_ELEMENT',
    'AMBIGUOUS_PROJECT', 'COUNT_CHANGED', 'DIFFERS_FROM_VERIFIED', 'MISSING_UUID',
    'NO_SOURCE_COUNT'];
  for (const kind of kinds) assert.ok(WARNING_TONE[kind], `no tone for ${kind}`);
  assert.equal(warningTone('SOMETHING_NEW'), 'warn');
  // The ones that mean the figure cannot be trusted lean 'bad'.
  for (const kind of ['DOES_NOT_RECONCILE', 'LEDGER_MISMATCH', 'ACCOUNT_MISMATCH']) {
    assert.equal(warningTone(kind), 'bad', kind);
  }
});
