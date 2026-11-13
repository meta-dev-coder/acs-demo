/**
 * What the live SAP cost read is scoped to, and why each choice was made.
 *
 * Its own module because these are not incidental constants — they are the accounting decisions
 * that make a number defensible, and every one of them is shown on screen beside the total. The
 * Phase 7B investigation established each by live query; `docs/sap-s4hana-api-discovery.md` and
 * the Phase 7B findings carry the evidence.
 *
 * NOTHING HERE IS REQUEST DATA. The project, ledger and account list are module constants, so no
 * frontend value can widen the scope of a query or move it to another project.
 */

/* ── the two services, at the paths verified live ──────────────────────────────────────────── */

/**
 * Enterprise Project, **v2**.
 *
 * SAP deprecated v1 in S/4HANA Cloud 2102 and decommissioned it in 2202. The sandbox still serves
 * v1 at the unversioned path, which is a trap: a client built against it is built against a
 * version that no longer exists in any current tenant. The `;v=0002` segment is the correct form —
 * `API_ENTERPRISE_PROJECT_SRV_0002` returns 403.
 */
export const PROJECT_SERVICE = '/s4hanacloud/sap/opu/odata/sap/API_ENTERPRISE_PROJECT_SRV;v=0002';

/** Journal Entry Item Basic. GET-only in its own metadata — SAP enforces the read-only rule. */
export const JOURNAL_SERVICE = '/s4hanacloud/sap/opu/odata/sap/API_JOURNALENTRYITEMBASIC_SRV';

export const ENTITY = Object.freeze({
  project: '/A_EnterpriseProject',
  projectElement: '/A_EnterpriseProjectElement',
  journalItem: '/A_JournalEntryItemBasic',
});

/* ── the scope ─────────────────────────────────────────────────────────────────────────────── */

/** The project this phase reads. One project, fixed. */
export const PROJECT_ID = 'RNG002';

/**
 * The leading ledger, and the single most important filter here.
 *
 * The sandbox carries FIVE parallel ledgers — `0C`, `0E`, `0L`, `2L`, `ZS` — and for RNG002 they
 * are identical copies of the same postings: each totals exactly the same amount. Reading without
 * a ledger filter multiplies actual cost by five. `0L` is the leading ledger.
 */
export const LEDGER = '0L';

/**
 * The expense accounts, by number.
 *
 * Verified live for RNG002 on ledger `0L`. The project's postings span twelve GL accounts, and
 * the NET of all of them is **negative** (−6,022.50 USD) because revenue and WIP dominate. Only
 * these three are cost:
 */
export const EXPENSE_ACCOUNTS = Object.freeze([
  Object.freeze({ account: '61003000', name: 'Trav.Expense Hotel' }),
  Object.freeze({ account: '61005000', name: 'Travel Exp Grd Trnsp' }),
  Object.freeze({ account: '94308000', name: 'Consulting' }),
]);

/**
 * The accounts deliberately EXCLUDED, named so the screen can show what was left out.
 *
 * An exclusion nobody can see is indistinguishable from an account we failed to notice.
 */
export const EXCLUDED_ACCOUNTS = Object.freeze([
  Object.freeze({ account: '13711000', name: 'WIP Acc Rev - Disb', reason: 'Work in progress — balance sheet, not cost' }),
  Object.freeze({ account: '13711100', name: 'WIP Acc Rev - Time', reason: 'Work in progress — balance sheet, not cost' }),
  Object.freeze({ account: '13811000', name: 'Def Rev - Disbursmnt', reason: 'Deferred revenue' }),
  Object.freeze({ account: '13811100', name: 'Def Rev - Time', reason: 'Deferred revenue' }),
  Object.freeze({ account: '41910000', name: 'Billed Rev Dom -Time', reason: 'Billed revenue' }),
  Object.freeze({ account: '41930000', name: 'Billed Reve Dom -Dis', reason: 'Billed revenue' }),
  Object.freeze({ account: '44401000', name: 'Rev Adj - Disbursmnt', reason: 'Revenue adjustment' }),
  Object.freeze({ account: '44401100', name: 'Rev Adj - Time', reason: 'Revenue adjustment' }),
]);

/** SAP's "no parent" sentinel on `ParentObjectUUID`. A root element, not an unresolved one. */
export const NULL_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * What the figure on screen is, and what it is not.
 *
 * Carried as a value so the backend and the frontend cannot drift on the one claim that would
 * mislead a client most: this is a professional-services project, and nothing about it is
 * construction.
 */
export const SOURCE = Object.freeze({
  system: 'SAP S/4HANA',
  environment: 'SAP Business Accelerator Hub — Sandbox',
  services: Object.freeze([
    'Enterprise Project (API_ENTERPRISE_PROJECT_SRV, v0002)',
    'Journal Entry Item Basic (API_JOURNALENTRYITEMBASIC_SRV)',
  ]),
  readOnly: true,
  notConstruction: 'RNG002 "Mount Fuji" is a professional-services project — travel, consulting '
    + 'and billed revenue. It has no quantities, units, BOQ items or physical progress. It '
    + 'demonstrates the SAP cost pipeline faithfully and nothing about construction measurement. '
    + 'The sandbox contains no construction project.',
  notLinked: 'These records are not mapped to the synthetic Tower A project and are not written '
    + 'to the integration database. INT-04 continues to read the mock src_sap_* tables.',
  /** From the Phase 7B stability check: six consecutive runs, byte-identical. */
  stability: 'Sandbox data is static and dated 2020. Six consecutive reads during Phase 7B '
    + 'returned byte-identical results. SAP may refresh the tenant without notice, so a changed '
    + 'result is reported as a warning rather than absorbed.',
});

/**
 * What Phase 7B measured, used as a REGRESSION EXPECTATION only.
 *
 * Never displayed, never substituted, never defaulted to. The screen shows what SAP returned on
 * the day; these drive a warning when the live figure moves, because a demo that silently shows a
 * different number than the one that was reviewed is worse than one that says it changed.
 */
export const EXPECTED = Object.freeze({
  wbsElements: 13,
  wbsWithExpense: 5,
  totalAmount: 5997.00,
  currency: 'USD',
  companyCode: '1710',
  controllingArea: 'A000',
  fiscalPeriods: Object.freeze(['001/2020', '002/2020', '003/2020']),
});
