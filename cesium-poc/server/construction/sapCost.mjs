/**
 * The live SAP S/4HANA cost read: project → WBS hierarchy → actual expense.
 *
 * Phase 7B established that a naive implementation of this gets the number wrong in four separate
 * ways, each of which produces a plausible figure. Every one is guarded here, and each guard is
 * reported to the screen rather than applied quietly:
 *
 *  1. FIVE PARALLEL LEDGERS. `0C`, `0E`, `0L`, `2L` and `ZS` are copies of the same postings.
 *     Omitting the ledger filter multiplies cost by exactly five. We filter to `0L` and show it.
 *  2. THE ENTITY AGGREGATES SERVER-SIDE. `A_JournalEntryItemBasic` is an ANALYTICAL entity: the
 *     rows returned are aggregates over the dimensions in `$select`, so the same filter yields 40,
 *     8, 5 or 1 row depending only on the projection. `$count` counts base rows, NOT returned
 *     rows — 1,175 against 225 for this project. So `$count` is reported as what it is, a source
 *     row count, and never used as a row total or re-summed.
 *  3. GL ACCOUNT SEMANTICS. The net of every account on `0L` is NEGATIVE, because WIP, deferred
 *     revenue and billed revenue dominate. Only the three expense accounts are cost.
 *  4. WBS CODES DO NOT ENCODE THE HIERARCHY. `RNG002.1.2`'s parent is `RNG002.0.3`. The tree is
 *     built from `ParentObjectUUID` alone; the dotted code is a label.
 *
 * And one API constraint: `$skip` is unreliable on the analytical entity — it returns HTTP 501
 * `CX_SADL_GW_ANALYT_GENERATED_ID` for some projections and silently truncates for others. Every
 * query here is PROJECT-SCOPED with an explicit `$select` and no `$skip`. Nothing bulk-extracts.
 *
 * Read-only throughout. The journal service declares itself non-creatable, non-updatable and
 * non-deletable in its own metadata, so SAP enforces that as well as we do.
 */
import {
  CONNECTION, FAILURE, LIMITS, createSapClient, odataDate, odataDecimal,
} from './sapHttp.mjs';
import {
  ENTITY, EXCLUDED_ACCOUNTS, EXPECTED, EXPENSE_ACCOUNTS, JOURNAL_SERVICE, LEDGER, NULL_GUID,
  PROJECT_ID, PROJECT_SERVICE, SOURCE,
} from './sapCostConfig.mjs';

export { CONNECTION, FAILURE };

/** The `$select` projections. Explicit, because the projection decides what the server returns. */
const SELECT = Object.freeze({
  project: 'Project,ProjectDescription,ProjectUUID,ProjectInternalID,CompanyCode,ControllingArea,'
    + 'ProjectCurrency,ProcessingStatus,ProjectStartDate,ProjectEndDate,ProfitCenter,'
    + 'ResponsibleCostCenter,LastChangeDateTime',
  /*
   * No `SortingNumber`. It exists on v1 of this service and NOT on v2, where selecting it fails
   * the whole query with `404 Resource not found for the segment 'SortingNumber'` — a 404 that
   * looks like a wrong URL and is actually a wrong field. Found by selecting each field alone.
   */
  element: 'ProjectElement,ProjectElementDescription,ProjectElementUUID,ParentObjectUUID,'
    + 'ProjectUUID,WBSElementInternalID,ProcessingStatus,PlannedStartDate,'
    + 'PlannedEndDate,CompanyCode,ControllingArea,ResponsibleCostCenter',
  /**
   * The cost projection, and the aggregation level it implies.
   *
   * These dimensions and no others: the server groups by exactly this list, so adding a field
   * silently changes the row count and removing one silently merges rows. This is the level the
   * screen shows — one row per WBS element, GL account, fiscal period and debit/credit code.
   */
  expense: 'WBSElement,WBSElementDescription,GLAccount,GLAccountName,FiscalYearPeriod,'
    + 'ControllingDebitCreditCode,JrnlEntryItemObsoleteReason,CompanyCode,Ledger,'
    + 'AmountInCompanyCodeCurrency,CompanyCodeCurrency',
});

/** The OData filter for the expense accounts, built from the constant list. */
const accountFilter = () =>
  `(${EXPENSE_ACCOUNTS.map(entry => `GLAccount eq '${entry.account}'`).join(' or ')})`;

/** What was asked of SAP, in the operator's words, shown beside every figure. */
export function filtersApplied() {
  return Object.freeze({
    project: PROJECT_ID,
    ledger: LEDGER,
    ledgerReason: 'The sandbox carries five parallel ledgers (0C, 0E, 0L, 2L, ZS) holding the '
      + 'same postings. Without this filter the total is multiplied by five.',
    expenseAccounts: EXPENSE_ACCOUNTS,
    excludedAccounts: EXCLUDED_ACCOUNTS,
    excludedReason: 'The net of all accounts on this ledger is negative, because work in '
      + 'progress, deferred revenue and billed revenue outweigh cost. Only expense accounts are '
      + 'actual cost.',
    odataFilter: `ProjectExternalID eq '${PROJECT_ID}' and Ledger eq '${LEDGER}' and ${accountFilter()}`,
    select: SELECT.expense,
    paging: 'Project-scoped, no $skip. A_JournalEntryItemBasic is an analytical entity and $skip '
      + 'is not dependable on it.',
  });
}

/* ── the hierarchy ─────────────────────────────────────────────────────────────────────────── */

/**
 * Build the parent-child tree from UUIDs, and say what is wrong with it.
 *
 * Validation is not a formality here. A real SAP hierarchy can arrive paged, partial or
 * cross-project, and every one of those produces a tree that renders perfectly while being wrong.
 * Each finding is returned rather than thrown: a hierarchy with one unresolved parent is still
 * worth showing, with the problem named.
 *
 * @returns {{roots, byUuid, ordered, warnings}}
 */
export function buildHierarchy(elements) {
  const warnings = [];
  const byUuid = new Map();
  const seenCode = new Map();

  for (const element of elements) {
    const uuid = element.uuid;
    if (!uuid) { warnings.push({ kind: 'MISSING_UUID', detail: `Element ${element.code ?? '(no code)'} has no UUID and was dropped.` }); continue; }
    if (byUuid.has(uuid)) {
      warnings.push({ kind: 'DUPLICATE_UUID', subject: uuid,
        detail: `Two elements share UUID ${uuid}: ${byUuid.get(uuid).code} and ${element.code}. The first was kept.` });
      continue;
    }
    // A duplicate CODE is not fatal — the UUID is the identity — but it means a label on screen
    // will be ambiguous, which is worth saying.
    if (element.code) {
      if (seenCode.has(element.code)) {
        warnings.push({ kind: 'DUPLICATE_CODE', subject: element.code,
          detail: `WBS code ${element.code} appears more than once; the tree uses UUIDs, but the labels are ambiguous.` });
      }
      seenCode.set(element.code, uuid);
    }
    byUuid.set(uuid, { ...element, children: [] });
  }

  const roots = [];
  for (const node of byUuid.values()) {
    const parentUuid = node.parentUuid;
    if (!parentUuid || parentUuid === NULL_GUID) { node.parentCode = null; roots.push(node); continue; }
    const parent = byUuid.get(parentUuid);
    if (!parent) {
      // The element names a parent we did not receive. Shown as a root so it is not lost, and
      // reported, because a silently re-rooted node is a hierarchy quietly reshaped.
      warnings.push({ kind: 'UNRESOLVED_PARENT', subject: node.code,
        detail: `${node.code} names parent UUID ${parentUuid}, which is not in the retrieved set. Shown at the root.` });
      node.parentCode = null;
      node.unresolvedParent = parentUuid;
      roots.push(node);
      continue;
    }
    node.parentCode = parent.code;
    parent.children.push(node);
  }

  // Cycles. A cycle renders as an infinite tree, so it must be found before anything walks it.
  const state = new Map();
  const cycles = [];
  const visit = (node, trail) => {
    const mark = state.get(node.uuid);
    if (mark === 'done') return;
    if (mark === 'open') { cycles.push([...trail, node.code].join(' → ')); return; }
    state.set(node.uuid, 'open');
    for (const child of node.children) visit(child, [...trail, node.code]);
    state.set(node.uuid, 'done');
  };
  for (const root of roots) visit(root, []);
  // Anything never reached from a root is in a cycle of its own, detached from the tree.
  for (const node of byUuid.values()) {
    if (state.get(node.uuid) !== 'done') {
      visit(node, []);
      if (state.get(node.uuid) === 'done' && !roots.includes(node)) {
        warnings.push({ kind: 'DETACHED', subject: node.code,
          detail: `${node.code} is not reachable from any root.` });
      }
    }
  }
  for (const cycle of cycles) {
    warnings.push({ kind: 'CYCLE', subject: cycle, detail: `Parent cycle detected: ${cycle}.` });
  }

  const sortByCode = (a, b) => String(a.code).localeCompare(String(b.code), 'en');
  const ordered = [];
  const walk = (nodes, depth) => {
    for (const node of [...nodes].sort(sortByCode)) {
      node.depth = depth;
      ordered.push(node);
      if (depth < 20) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);

  return { roots, byUuid, ordered, warnings };
}

/** One SAP project element, as we carry it. Only fields we asked for. */
const toElement = row => ({
  code: row.ProjectElement ?? null,
  description: row.ProjectElementDescription ?? null,
  uuid: row.ProjectElementUUID ?? null,
  parentUuid: row.ParentObjectUUID ?? null,
  projectUuid: row.ProjectUUID ?? null,
  internalId: row.WBSElementInternalID ?? null,
  processingStatus: row.ProcessingStatus ?? null,
  plannedStart: odataDate(row.PlannedStartDate),
  plannedEnd: odataDate(row.PlannedEndDate),
  companyCode: row.CompanyCode ?? null,
  controllingArea: row.ControllingArea ?? null,
});

const toProject = row => ({
  project: row.Project ?? null,
  description: row.ProjectDescription ?? null,
  uuid: row.ProjectUUID ?? null,
  internalId: row.ProjectInternalID ?? null,
  companyCode: row.CompanyCode ?? null,
  controllingArea: row.ControllingArea ?? null,
  currency: row.ProjectCurrency || null,
  processingStatus: row.ProcessingStatus ?? null,
  start: odataDate(row.ProjectStartDate),
  end: odataDate(row.ProjectEndDate),
  profitCenter: row.ProfitCenter || null,
  responsibleCostCenter: row.ResponsibleCostCenter || null,
  lastChangedAt: odataDate(row.LastChangeDateTime),
});

/** One aggregated expense row, exactly at the level `SELECT.expense` groups by. */
const toExpense = row => ({
  wbs: row.WBSElement ?? null,
  wbsDescription: row.WBSElementDescription ?? null,
  glAccount: row.GLAccount ?? null,
  glAccountName: row.GLAccountName ?? null,
  fiscalPeriod: row.FiscalYearPeriod ?? null,
  debitCredit: row.ControllingDebitCreditCode ?? null,
  obsoleteReason: row.JrnlEntryItemObsoleteReason || null,
  companyCode: row.CompanyCode ?? null,
  ledger: row.Ledger ?? null,
  amount: odataDecimal(row.AmountInCompanyCodeCurrency),
  currency: row.CompanyCodeCurrency ?? null,
});

/* ── the adapter ───────────────────────────────────────────────────────────────────────────── */

export function createSapCostAdapter({
  env = process.env, fetchImpl = globalThis.fetch, logger = console,
  timeoutMs = LIMITS.costTimeoutMs, now = () => new Date().toISOString(),
} = {}) {
  const client = createSapClient({ env, fetchImpl, logger, timeoutMs, label: 'sap-cost' });

  const sourceMeta = () => Object.freeze({
    ...SOURCE,
    projectId: PROJECT_ID,
    configured: client.configured(),
    endpoints: Object.freeze({
      project: `${PROJECT_SERVICE}${ENTITY.project}`,
      element: `${PROJECT_SERVICE}${ENTITY.projectElement}`,
      journal: `${JOURNAL_SERVICE}${ENTITY.journalItem}`,
    }),
  });

  /** Every response, whatever happened, has this envelope. */
  const envelope = (at, extra = {}) => ({
    source: sourceMeta(),
    filters: filtersApplied(),
    retrievedAt: at,
    state: CONNECTION.FAILED,
    failure: null,
    httpStatus: null,
    reason: null,
    elapsedMs: null,
    warnings: [],
    ...extra,
  });

  const failed = (at, outcome, extra = {}) => ({
    ...envelope(at, extra),
    state: outcome.state,
    failure: outcome.failure,
    httpStatus: outcome.httpStatus,
    reason: outcome.reason,
    elapsedMs: outcome.elapsedMs,
  });

  /** The project header. */
  async function project() {
    const at = now();
    const outcome = await client.collection(`${PROJECT_SERVICE}${ENTITY.project}`, {
      $select: SELECT.project,
      $filter: `Project eq '${PROJECT_ID}'`,
      $top: 10,
    });
    if (outcome.state !== CONNECTION.CONNECTED) return failed(at, outcome, { project: null });

    const rows = outcome.rows.map(toProject);
    const warnings = [];
    if (rows.length === 0) {
      // Reported, never substituted. A demo that quietly falls back to a stored copy is a demo
      // that cannot tell you the sandbox changed.
      warnings.push({ kind: 'PROJECT_NOT_FOUND', subject: PROJECT_ID,
        detail: `SAP returned no project ${PROJECT_ID}. The sandbox dataset may have changed.` });
    }
    if (rows.length > 1) {
      warnings.push({ kind: 'AMBIGUOUS_PROJECT', subject: PROJECT_ID,
        detail: `SAP returned ${rows.length} projects for ${PROJECT_ID}; the first was used.` });
    }
    return { ...envelope(at), state: CONNECTION.CONNECTED, httpStatus: outcome.httpStatus,
      elapsedMs: outcome.elapsedMs, project: rows[0] ?? null, rowsReturned: outcome.rows.length,
      warnings };
  }

  /**
   * The WBS hierarchy.
   *
   * Filtered by `ProjectUUID` when we have one — the authoritative link — and by
   * `startswith(ProjectElement, …)` otherwise. The code filter can over-match a project whose id
   * is a prefix of another, so anything it brings back from a different project is filtered out
   * and reported rather than silently included.
   */
  async function hierarchy({ projectUuid = null } = {}) {
    const at = now();
    const filter = projectUuid
      ? `ProjectUUID eq guid'${projectUuid}'`
      : `startswith(ProjectElement,'${PROJECT_ID}')`;
    const outcome = await client.collection(`${PROJECT_SERVICE}${ENTITY.projectElement}`, {
      $select: SELECT.element,
      $filter: filter,
      $top: 500,
    });
    if (outcome.state !== CONNECTION.CONNECTED) {
      return failed(at, outcome, { elements: [], roots: [], elementCount: 0 });
    }

    let elements = outcome.rows.map(toElement);
    const warnings = [];
    if (projectUuid) {
      const foreign = elements.filter(e => e.projectUuid && e.projectUuid !== projectUuid);
      if (foreign.length) {
        warnings.push({ kind: 'FOREIGN_ELEMENT', subject: String(foreign.length),
          detail: `${foreign.length} element(s) belong to another project and were excluded.` });
        elements = elements.filter(e => !e.projectUuid || e.projectUuid === projectUuid);
      }
    }
    const tree = buildHierarchy(elements);
    warnings.push(...tree.warnings);

    if (tree.ordered.length !== EXPECTED.wbsElements) {
      warnings.push({ kind: 'COUNT_CHANGED', subject: String(tree.ordered.length),
        detail: `SAP returned ${tree.ordered.length} WBS elements; ${EXPECTED.wbsElements} were `
          + 'verified during investigation. The sandbox dataset may have changed.' });
    }

    return { ...envelope(at), state: CONNECTION.CONNECTED, httpStatus: outcome.httpStatus,
      elapsedMs: outcome.elapsedMs, rowsReturned: outcome.rows.length,
      elementCount: tree.ordered.length,
      // Flat and depth-ordered: the frontend builds its own expandable tree from `depth` and
      // `parentCode`, and a flat list cannot carry a cycle into the renderer.
      elements: tree.ordered.map(({ children, ...node }) => node),
      rootCodes: tree.roots.map(node => node.code),
      warnings };
  }

  /**
   * The actual expense rows.
   *
   * Also asks SAP for `$count` — the number of SOURCE line items behind the aggregates. It is
   * reported as its own figure and never used as a row count, because the two differ by design
   * (1,175 source rows behind 225 aggregated rows for this project).
   */
  async function expenses() {
    const at = now();
    const filter = `ProjectExternalID eq '${PROJECT_ID}' and Ledger eq '${LEDGER}' and ${accountFilter()}`;
    const outcome = await client.collection(`${JOURNAL_SERVICE}${ENTITY.journalItem}`, {
      $select: SELECT.expense,
      $filter: filter,
      $top: LIMITS.maxTop,
    });
    if (outcome.state !== CONNECTION.CONNECTED) return failed(at, outcome, { rows: [] });

    const rows = outcome.rows.map(toExpense);
    const warnings = [];

    // The guards that matter, each checked against what actually came back rather than assumed
    // from the filter we sent.
    const strayLedger = [...new Set(rows.map(r => r.ledger).filter(l => l && l !== LEDGER))];
    if (strayLedger.length) {
      warnings.push({ kind: 'LEDGER_MISMATCH', subject: strayLedger.join(', '),
        detail: `Rows returned for ledger(s) ${strayLedger.join(', ')} although only ${LEDGER} was requested.` });
    }
    const allowed = new Set(EXPENSE_ACCOUNTS.map(a => a.account));
    const strayAccount = [...new Set(rows.map(r => r.glAccount).filter(a => a && !allowed.has(a)))];
    if (strayAccount.length) {
      warnings.push({ kind: 'ACCOUNT_MISMATCH', subject: strayAccount.join(', '),
        detail: `Rows returned for GL account(s) ${strayAccount.join(', ')}, which are not in the expense list.` });
    }
    const currencies = [...new Set(rows.map(r => r.currency).filter(Boolean))];
    if (currencies.length > 1) {
      warnings.push({ kind: 'MIXED_CURRENCY', subject: currencies.join(', '),
        detail: `Rows are in ${currencies.join(', ')}. Amounts in different currencies are not added.` });
    }
    const credits = rows.filter(r => r.debitCredit === 'C');
    if (credits.length) {
      warnings.push({ kind: 'CREDIT_POSTINGS', subject: String(credits.length),
        detail: `${credits.length} row(s) are credits (C). They may be reversals or credit memos; `
          + 'this API carries no document number or reversal flag, so they cannot be paired.' });
    }
    const obsolete = rows.filter(r => r.obsoleteReason);
    if (obsolete.length) {
      warnings.push({ kind: 'OBSOLETE_ITEMS', subject: String(obsolete.length),
        detail: `${obsolete.length} row(s) carry an obsolete reason and may be superseded.` });
    }
    const missingAmount = rows.filter(r => r.amount == null);
    if (missingAmount.length) {
      warnings.push({ kind: 'MISSING_AMOUNT', subject: String(missingAmount.length),
        detail: `${missingAmount.length} row(s) have no readable amount and are excluded from the total.` });
    }

    // `$count` is a bare number in text/plain and rejects `$format=json`, so it goes through the
    // client's own count path. `null` when unavailable — never 0, which would read as "no source
    // rows" for what is actually "we could not ask".
    const counted = await client.count(`${JOURNAL_SERVICE}${ENTITY.journalItem}/$count`,
      { $filter: filter });
    const sourceRowCount = counted.count;
    if (sourceRowCount == null) {
      warnings.push({ kind: 'NO_SOURCE_COUNT', subject: String(counted.httpStatus ?? 'no status'),
        detail: 'SAP did not return a source line-item count, so only the aggregated row count '
          + 'is shown.' });
    }

    return { ...envelope(at), state: CONNECTION.CONNECTED, httpStatus: outcome.httpStatus,
      elapsedMs: outcome.elapsedMs, rows,
      /** Rows SAP returned to us, already aggregated by the `$select` dimensions. */
      aggregatedRowCount: rows.length,
      /** Line items behind them, per SAP's own `$count`. A different thing, never a row total. */
      sourceRowCount,
      warnings };
  }

  return {
    system: 'SAP',
    origin: 'SANDBOX_S4HANA',
    /** No `interfaceId`: this belongs to no pilot interface. INT-04 and INT-05 are untouched. */
    interfaceId: null,
    describe: sourceMeta,
    project,
    hierarchy,
    expenses,
  };
}
