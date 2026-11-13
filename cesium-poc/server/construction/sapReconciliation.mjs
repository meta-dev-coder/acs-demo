/**
 * Turning SAP rows into a defensible actual-cost total.
 *
 * Pure. No HTTP, no database. Given a hierarchy and a set of aggregated expense rows it produces
 * the totals, the per-WBS breakdown and the warnings — which means every rule below is testable
 * against a fixture, and the live call is only responsible for fetching.
 *
 * The rules it enforces, all four from the Phase 7B investigation:
 *
 *  - amounts are summed ONLY where currency agrees. A mixed-currency set yields a total per
 *    currency and a warning, never one number made of two.
 *  - a debit (`D`) adds, a credit (`C`) subtracts. A row with neither is counted at face value
 *    and reported, because guessing a sign is how a reversal becomes a cost.
 *  - every expense row must name a WBS element that is in the hierarchy. One that does not is an
 *    UNMATCHED reference: it is counted, shown and excluded from the per-element breakdown, and
 *    never quietly dropped.
 *  - the per-element amounts must add up to the project total. That identity is asserted here, so
 *    a breakdown that does not reconcile says so on the screen rather than looking plausible.
 */
import { EXPECTED, EXPENSE_ACCOUNTS, LEDGER, PROJECT_ID } from './sapCostConfig.mjs';

/** Two currency amounts are equal if they agree to the cent. Floats do not, so compare in cents. */
const cents = value => Math.round(Number(value) * 100);
export const sameMoney = (a, b) => cents(a) === cents(b);

/**
 * The signed contribution of one aggregated row.
 *
 * SAP's `ControllingDebitCreditCode` is `D` or `C`. Every RNG002 expense row is `D`; a `C` would
 * be a credit against cost and must reduce the total. A blank code is taken at face value and
 * reported by the caller — the amount already carries SAP's own sign.
 */
export function signedAmount(row) {
  if (row?.amount == null) return null;
  return row.debitCredit === 'C' ? -row.amount : row.amount;
}

/**
 * Reconcile.
 *
 * @param {{elements: Array, rows: Array}} input the hierarchy and the aggregated expense rows
 * @returns a complete reconciliation, including every warning that bears on the total
 */
export function reconcileSapCost({ elements = [], rows = [] } = {}) {
  const warnings = [];
  const byCode = new Map(elements.map(element => [element.code, element]));

  const perElement = new Map();
  const unmatched = new Map();
  const byCurrency = new Map();
  const periods = new Set();
  const accounts = new Map();
  let unsignedRows = 0;
  let unreadableRows = 0;

  for (const row of rows) {
    const amount = signedAmount(row);
    if (amount == null) { unreadableRows += 1; continue; }
    if (row.debitCredit !== 'D' && row.debitCredit !== 'C') unsignedRows += 1;
    if (row.fiscalPeriod) periods.add(row.fiscalPeriod);
    if (row.currency) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + amount);
    if (row.glAccount) {
      const entry = accounts.get(row.glAccount)
        ?? { account: row.glAccount, name: row.glAccountName, amount: 0, rows: 0 };
      entry.amount += amount; entry.rows += 1;
      accounts.set(row.glAccount, entry);
    }

    const target = byCode.has(row.wbs) ? perElement : unmatched;
    const entry = target.get(row.wbs)
      ?? { wbs: row.wbs, description: row.wbsDescription ?? byCode.get(row.wbs)?.description ?? null,
        amount: 0, rows: 0, currencies: new Set(), periods: new Set(), accounts: new Set() };
    entry.amount += amount;
    entry.rows += 1;
    if (row.currency) entry.currencies.add(row.currency);
    if (row.fiscalPeriod) entry.periods.add(row.fiscalPeriod);
    if (row.glAccount) entry.accounts.add(row.glAccount);
    target.set(row.wbs, entry);
  }

  const currencies = [...byCurrency.keys()].sort();
  /**
   * One currency or none. With two, there is no single total: adding USD to EUR would be a
   * fabricated number, so `total` is null and the per-currency figures are what the screen shows.
   */
  const currency = currencies.length === 1 ? currencies[0] : null;
  if (currencies.length > 1) {
    warnings.push({ kind: 'NO_SINGLE_TOTAL', subject: currencies.join(', '),
      detail: `Rows are in ${currencies.join(' and ')}. No combined total is shown, because `
        + 'amounts in different currencies cannot be added.' });
  }
  if (unsignedRows) {
    warnings.push({ kind: 'UNSIGNED_ROWS', subject: String(unsignedRows),
      detail: `${unsignedRows} row(s) carry neither a debit nor a credit indicator and were `
        + "counted at SAP's own sign." });
  }
  if (unreadableRows) {
    warnings.push({ kind: 'UNREADABLE_AMOUNT', subject: String(unreadableRows),
      detail: `${unreadableRows} row(s) had no readable amount and are excluded from every total.` });
  }

  const shape = entry => ({
    wbs: entry.wbs,
    description: entry.description,
    amount: Math.round(entry.amount * 100) / 100,
    rows: entry.rows,
    currencies: [...entry.currencies].sort(),
    periods: [...entry.periods].sort(),
    accounts: [...entry.accounts].sort(),
  });

  const elementTotals = [...perElement.values()].map(shape)
    .sort((a, b) => a.wbs.localeCompare(b.wbs, 'en'));
  const unmatchedTotals = [...unmatched.values()].map(shape)
    .sort((a, b) => String(a.wbs).localeCompare(String(b.wbs), 'en'));

  for (const entry of unmatchedTotals) {
    warnings.push({ kind: 'UNMATCHED_WBS', subject: entry.wbs,
      detail: `Expense references WBS ${entry.wbs}, which is not in the retrieved hierarchy. `
        + `${entry.rows} row(s), ${entry.amount} excluded from the per-element breakdown.` });
  }

  const matchedTotal = Math.round(elementTotals.reduce((sum, e) => sum + e.amount, 0) * 100) / 100;
  const unmatchedTotal = Math.round(unmatchedTotals.reduce((sum, e) => sum + e.amount, 0) * 100) / 100;
  const total = currency === null ? null : Math.round((matchedTotal + unmatchedTotal) * 100) / 100;

  /**
   * The identity the screen rests on.
   *
   * matched + unmatched must equal the sum over all rows. If it does not, something in this
   * function is wrong, and the screen must say so rather than present a breakdown that does not
   * add up.
   */
  const rowTotal = currency === null ? null
    : Math.round((byCurrency.get(currency) ?? 0) * 100) / 100;
  const balances = total === null || sameMoney(total, rowTotal);
  if (!balances) {
    warnings.push({ kind: 'DOES_NOT_RECONCILE', subject: `${total} vs ${rowTotal}`,
      detail: `The per-element breakdown totals ${total} but the rows total ${rowTotal}. `
        + 'The breakdown is not trustworthy.' });
  }

  // Did the live figures move since they were reviewed? A regression expectation, never a
  // substitute: the screen always shows what SAP returned.
  const drift = [];
  if (elements.length && elements.length !== EXPECTED.wbsElements) {
    drift.push(`${elements.length} WBS elements, not ${EXPECTED.wbsElements}`);
  }
  if (rows.length && elementTotals.length !== EXPECTED.wbsWithExpense) {
    drift.push(`${elementTotals.length} elements with expense, not ${EXPECTED.wbsWithExpense}`);
  }
  if (total !== null && !sameMoney(total, EXPECTED.totalAmount)) {
    drift.push(`total ${total} ${currency}, not ${EXPECTED.totalAmount} ${EXPECTED.currency}`);
  }
  if (drift.length) {
    warnings.push({ kind: 'DIFFERS_FROM_VERIFIED', subject: drift.join('; '),
      detail: `SAP returned ${drift.join('; ')}. The verified baseline was recorded during the `
        + 'Phase 7B investigation; the figures above are what SAP returned just now.' });
  }

  return {
    project: PROJECT_ID,
    ledger: LEDGER,
    currency,
    total,
    /** Per currency, so a mixed set still has honest numbers. */
    totalsByCurrency: Object.fromEntries(
      [...byCurrency].map(([code, amount]) => [code, Math.round(amount * 100) / 100])),
    elementTotals,
    unmatched: unmatchedTotals,
    unmatchedTotal,
    byAccount: [...accounts.values()]
      .map(entry => ({ ...entry, amount: Math.round(entry.amount * 100) / 100 }))
      .sort((a, b) => a.account.localeCompare(b.account, 'en')),
    fiscalPeriods: [...periods].sort(),
    counts: {
      wbsElements: elements.length,
      wbsWithExpense: elementTotals.length,
      wbsWithoutExpense: Math.max(0, elements.length - elementTotals.length),
      unmatchedReferences: unmatchedTotals.length,
      aggregatedRows: rows.length,
      expenseAccountsRequested: EXPENSE_ACCOUNTS.length,
      accountsSeen: accounts.size,
    },
    balances,
    /** What the figures were when they were reviewed. Shown as a comparison, never as the value. */
    expected: EXPECTED,
    warnings,
  };
}
