# SAP S/4HANA API discovery and integration feasibility

**Phase 7B — discovery and documentation. No production integration was built.**

Every claim below carries one of four labels:

| Label | Means |
|---|---|
| **LIVE** | Verified by a request this phase actually made to `sandbox.api.sap.com`, with the HTTP status and record counts recorded here. |
| **DOC** | Verified in SAP documentation only. Not called. |
| **TENANT** | Requires a real SAP S/4HANA tenant. Blocked by customer access. |
| **NONE** | Searched for and not found, or found and shown not to exist. |

Nothing in this document is labelled from the *name* of an API. Several names that sound exactly
right — `API_PROJECTBUDGET_SRV`, `API_PROJECTPROGRESS_SRV`, `API_BILLOFSERVICES_SRV` — were
probed and are not reachable; one of them, project progress, appears not to exist as an API at all.

---

## 1. Executive summary

**We can read a real S/4HANA project structure today.** Project definitions and the full WBS
hierarchy, with parent-child links, are live in the SAP Business Accelerator Hub sandbox and
answer to the API key already configured for Phase 7A. The sandbox holds **193 projects and 1,692
WBS elements**. This is genuine S/4HANA Project System data, not the SuccessFactors records of
Phase 7A.

**We can read real actual cost by WBS element.** 34,757 journal entry items in the sandbox carry
a WBS element, with amount, currency and fiscal period.

**We cannot get budget, planned cost, BOQ quantities or unit rates from any API we can reach**,
and for two of those the obstacle is not access — it is that the data is not in the project APIs
at all. The Enterprise Project API, in both v1 and v2, has **no** budget, planned-cost,
actual-cost, progress or earned-value field. I verified this by scanning every property of all 15
v2 entity types, not by reading a summary.

**Earned value cannot be posted to SAP through any API.** S/4HANA calculates earned value in a
batch Progress Analysis run from a progress version and planned costs. There is no OData service
for it. INT-05 as currently conceived — "write earned value to SAP" — has no API to write to, in
any tenant, with any credential.

**There is a credible real write path for INT-05, and it is a different one.** Service Entry
Sheets confirm performed quantity against a purchase order item carrying a WBS assignment. That
is how S/4HANA records a measured construction progress claim, and `A_ServiceEntrySheet` is
creatable. This is a design change, not an access problem, and it is the single most important
finding in this phase.

**Nothing in the running demo changed.** INT-04 still reads `src_sap_*`; INT-05 still posts to the
mock. No schema change, no new adapter, no live call added to the application. The only code
change is the banner.

---

## 2. Verified SAP APIs

All five below answered **HTTP 200** to the existing Phase 7A key at
`https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/`.

### 2.1 Enterprise Project — `API_ENTERPRISE_PROJECT_SRV` — **LIVE**

| | |
|---|---|
| Official name | Enterprise Project |
| Product | SAP S/4HANA Cloud (also S/4HANA on-premise, activated via `/IWFND/MAINT_SERVICE`) |
| Versions reachable | **v1** at `…/API_ENTERPRISE_PROJECT_SRV/` (8 entity sets) and **v2** at `…/API_ENTERPRISE_PROJECT_SRV;v=0002/` (15 entity sets) |
| Protocol | OData v2 |
| Documentation | `https://api.sap.com/api/API_ENTERPRISE_PROJECT_SRV` |
| Communication scenario | **SAP_COM_0308**, Enterprise Project — Create, Read, Update, Delete Integration (**DOC**) |
| Authentication | The sandbox accepts the `APIKey` header. A tenant requires a communication arrangement for SAP_COM_0308 with a communication user — **TENANT** |
| Sandbox | Yes, with data |
| Try Out | Not verified; the hub's catalog API requires an interactive OAuth login, so I called the sandbox directly instead |

**Version warning.** SAP deprecated v1 in S/4HANA Cloud 2102 and decommissioned it in 2202
(**DOC**). The sandbox still serves v1 at the unversioned path. **Any real client must target
v2.** Both were read in this phase; the field findings below hold for both.

Entity sets (v2): `A_EnterpriseProject`, `A_EnterpriseProjectElement`, `A_EnterpriseProjectRole`,
`A_EnterpriseProjectTeamMember`, `A_EntTeamMemberEntitlement`, `A_EntProjElmntWorkItem`,
`A_EntProjElmntCnfgrdWrkItmTxt`, `A_EntProjElmntDlvbrl`, `A_EntProjElmntDlvbrlDistr`,
`A_EnterpriseProjBlkFunc`, `A_EntProjElmntBlockFunc`, `A_EnterpriseProjectJVA`,
`A_EntProjectElementJVA`, `A_EntProjectPublicSector`, `A_EntProjectElmntPublicSector`.

**Fields confirmed live on `A_EnterpriseProjectElement`:** `ProjectElement` (the WBS code, e.g.
`TEMP002.1.1`), `ProjectElementDescription`, `ProjectElementUUID`, `ParentObjectUUID`,
`ProjectUUID`, `WBSElementInternalID`, `ProcessingStatus`, `SortingNumber`, `PlannedStartDate`,
`PlannedEndDate`, `ResponsibleCostCenter`, `CompanyCode`, `ProfitCenter`, `ControllingArea`,
`Plant`, `WBSIsStatisticalWBSElement`, `WBSElementIsBillingElement`, `CostingSheet`,
`CreationDateTime`, `LastChangeDateTime`.

**Fields confirmed live on `A_EnterpriseProject`:** `Project`, `ProjectDescription`,
`ProjectUUID`, `ProjectInternalID`, `ProjectStartDate`, `ProjectEndDate`, `ProcessingStatus`,
`ProjectProfileCode`, `CompanyCode`, `ControllingArea`, `ProjectCurrency`, `ResponsibleCostCenter`,
`ProfitCenter`, `EnterpriseProjectType`, `LastChangeDateTime`.

**Hierarchy.** Parent-child is `ParentObjectUUID` plus the navigations `to_ParentProjElement` and
`to_SubProjElement`. A root element carries the null GUID
`00000000-0000-0000-0000-000000000000`, which must be read as "no parent" and not as a parent that
failed to resolve. Verified live: `TEMP001.1.1` has the null GUID, `TEMP002.1.1` has a real parent
UUID.

**HTTP methods.** v2 declares `A_EnterpriseProject` and `A_EnterpriseProjectElement` as creatable,
with `updatable-path` and `deletable-path` — update and delete are conditional per record, decided
by the service at runtime. **No write of any kind was attempted in this phase.**

**The finding that matters.** I scanned every property of all 15 v2 entity types for the strings
`cost`, `budget`, `progress`, `percent`, `earnedvalue`, `amount`, `quantity`, `unitrate` and
`price`. The complete set of matches is: `ResponsibleCostCenter`, `CostCenter`, `CostingSheet`,
`JointVentureCostRecoveryCode`, `EntProjElmntDlvbrlQuantity`, `EntProjElmntDlvbrlQuantityUnit` —
and the `_fc` field-control bytes that accompany them. **There is no budget, no planned cost, no
actual cost, no percent complete and no earned value on the project or on the WBS element.** The
project APIs carry structure; money lives elsewhere.

### 2.2 Journal Entry Item Basic — `API_JOURNALENTRYITEMBASIC_SRV` — **LIVE**

| | |
|---|---|
| Protocol | OData v2 |
| Documentation | `https://api.sap.com/api/API_JOURNALENTRYITEMBASIC_SRV` |
| Entity sets | `A_JournalEntryItemBasic`, `A_CompanyCode`, `A_CostCenter`, `A_GLAccountInChartOfAccounts`, `A_ProfitCenter` |
| HTTP methods | **GET only.** Every entity set declares `creatable=false updatable=false deletable=false` |
| Sandbox | Yes — **34,757 items carry a WBS element** |

This is the actual-cost ledger, and the metadata enforces what the integration proposal already
says in words: **SAP stays the only cost ledger.** No client, however it is written, can post a
cost through this service.

**Fields confirmed live:** `WBSElement`, `WBSElementExternalID`, `WBSElementDescription`,
`Project`, `ProjectExternalID`, `ProjectDescription`, `GLAccount`, `GLAccountName`,
`AmountInCompanyCodeCurrency`, `CompanyCodeCurrency`, `AmountInTransactionCurrency`,
`TransactionCurrency`, `AmountInGlobalCurrency`, `GlobalCurrency`, `FiscalYearPeriod`,
`FiscalPeriod`, `LedgerFiscalYear`, `Ledger`, `ControllingDebitCreditCode`, `Quantity`,
`BaseUnit`, `CostCenter`, `ValuationQuantity`.

A live row, verbatim:

```json
{"WBSElement":"TEMP003.0.1","ProjectExternalID":"TEMP003","GLAccount":"13711100",
 "GLAccountName":"WIP Acc Rev - Time","AmountInCompanyCodeCurrency":"2800.00",
 "CompanyCodeCurrency":"EUR","FiscalYearPeriod":"012/2016"}
```

**One caution.** Actual cost is a **sum over posted line items**, not a field. Totalling it
correctly means filtering by ledger (`0L` is the leading ledger), by fiscal period, and by the
customer's own cost-element ranges, and respecting the debit/credit sign. That filter set is a
Finance decision and is not something an integration can choose on its own. Requesting the entity
without `$select` returned **HTTP 500 `DBSQL_SQL_INTERNAL_DB_ERROR`** from the sandbox; adding
`$select` made the same query work. A real client must project explicitly and page.

### 2.3 Purchase Order — `API_PURCHASEORDER_PROCESS_SRV` — **LIVE**

| | |
|---|---|
| Documentation | `https://api.sap.com/api/API_PURCHASEORDER_PROCESS_SRV` |
| Entity sets | `A_PurchaseOrder`, `A_PurchaseOrderItem`, `A_PurOrdAccountAssignment`, `A_PurOrdPricingElement`, `A_PurchaseOrderScheduleLine`, `A_POSubcontractingComponent`, notes, `YY1_RetentionTypeSet` |
| HTTP methods | `A_PurchaseOrder` and `A_PurchaseOrderItem` creatable, updatable and deletable (**DOC** from metadata; nothing written) |
| Sandbox | Yes, with data |

**This is the closest thing S/4HANA offers to a priced BOQ line**, and the correspondence is only
partial. `A_PurchaseOrderItem` carries `OrderQuantity`, `PurchaseOrderQuantityUnit`,
`NetPriceAmount`, `NetPriceQuantity`, `DocumentCurrency` and `PurchaseOrderItemText`.
`A_PurOrdAccountAssignment` carries `WBSElement`, `Quantity`, `PurchaseOrderQuantityUnit` and
`PurgDocNetAmount`.

Live example: `{"PurchaseOrder":"4500007621","PurchaseOrderItem":"10","WBSElement":"R-10014-1",
"Quantity":"100","PurchaseOrderQuantityUnit":"PC","PurgDocNetAmount":"0.00"}`

**Sandbox data is thin here, and it matters.** Only **7** account assignments carry a WBS element,
and **0 of them have a non-zero net amount**. So the *structure* of the PO → WBS → quantity link
is verified live, but **no priced, WBS-assigned purchase order line could be read**. A unit rate
could not be demonstrated end to end.

### 2.4 Service Entry Sheet — `API_SERVICE_ENTRY_SHEET_SRV` — **LIVE**

| | |
|---|---|
| Documentation | `https://api.sap.com/api/API_SERVICE_ENTRY_SHEET_SRV` |
| Entity sets | `A_ServiceEntrySheet`, `A_ServiceEntrySheetItem`, `A_SrvcEntrShtAcctAssignment` |
| HTTP methods | `A_ServiceEntrySheet`: **creatable and updatable**, not deletable. Items and account assignments: read-only (**DOC** from metadata) |
| Sandbox | Service and items yes; **0** account assignments carry a WBS element |

**The INT-05 candidate.** A service entry sheet is how S/4HANA records that a measured quantity of
work was performed against a contracted item — the SAP-side equivalent of a construction progress
claim or measurement certificate. `A_ServiceEntrySheetItem` carries `ConfirmedQuantity`,
`QuantityUnit`, `NetPriceAmount`, `NetAmount`, `Currency`, `PurchaseOrder` and
`PurchaseOrderItem`. `A_SrvcEntrShtAcctAssignment` carries `WBSElement`, `Quantity`,
`QuantityUnit` and `NetAmount`.

Live item: `{"ServiceEntrySheet":"1","ServiceEntrySheetItem":"1","ConfirmedQuantity":"10.000",
"QuantityUnit":"AU","NetPriceAmount":"10.00","NetAmount":"100.00","Currency":"USD",
"PurchaseOrder":"4500004461","PurchaseOrderItem":"10"}`

**It cannot be demonstrated end to end in the sandbox**: zero service entry sheets there are
assigned to a WBS element, so the chain *verified progress → confirmed quantity → WBS* has a gap
in the middle that only a real tenant can close.

### 2.5 Cost Center — `API_COSTCENTER_SRV` — **LIVE**

Read-only master data, `A_CostCenter` and `A_CostCenterText`, with data. Relevant only as the
target of `ResponsibleCostCenter` on a WBS element. Not needed for INT-04 or INT-05.

---

## 3. Sandbox testing results

Every probe below used the **existing Phase 7A API key**, unchanged. Only `GET` was used; no
`POST`, `PUT`, `PATCH` or `DELETE` was issued against anything.

| Service root (under `/s4hanacloud/sap/opu/odata/sap/`) | HTTP | Result |
|---|---|---|
| `API_ENTERPRISE_PROJECT_SRV/` | **200** | 8 entity sets; 193 projects, 1,692 WBS elements |
| `API_ENTERPRISE_PROJECT_SRV;v=0002/` | **200** | 15 entity sets; 12 deliverables |
| `API_JOURNALENTRYITEMBASIC_SRV/` | **200** | 5 entity sets; 34,757 items with a WBS |
| `API_PURCHASEORDER_PROCESS_SRV/` | **200** | 9 entity sets; 7 WBS-assigned account assignments, 0 priced |
| `API_SERVICE_ENTRY_SHEET_SRV/` | **200** | 3 entity sets; 0 WBS-assigned account assignments |
| `API_COSTCENTER_SRV/` | **200** | 2 entity sets, with data |
| `API_OPLACCTGDOCITEMCUBE_SRV/` | **200** | 1 entity set; not explored further |
| `API_BILL_OF_MATERIAL_SRV/` | **200** | 6 entity sets; a *material* BOM, not a construction BOQ |
| `API_MAINTENANCEORDER/` | **200** | 16 entity sets; out of scope |
| `API_ENTERPRISE_PROJECT_SRV_0002/` | 403 | Wrong path form; the correct one is `;v=0002` |
| `API_PROJECT_SRV/`, `API_WBS_ELEMENT_SRV/` | 403 | Guessed names. No evidence either exists |
| `API_PROJECTBUDGET_SRV/`, `API_PROJECT_BUDGET_SRV/`, `API_ENTPROJECTBUDGET_SRV/`, `API_ENTERPRISEPROJECTBUDGET_SRV/` | 403 | No project-budget service reachable under any name tried |
| `API_PROJECTPROGRESS_SRV/` | 403 | And see §6 — no such API appears to exist |
| `API_PROJECTCOSTPLANNING_SRV/`, `API_PROJECTCOSTESTIMATE_SRV/`, `API_FINANCIALPLANNINGENTRYITEM_SRV/`, `API_PROJECTFINANCIALPLANNING_SRV/` | 403 | Planned cost not reachable |
| `API_BILLOFSERVICES_SRV/`, `API_BILL_OF_MATERIAL_SRV_0002/` | 403 | — |
| `API_COMMITMENT_SRV/`, `API_FUNDS_MANAGEMENT_SRV/`, `API_BUDGETPERIOD_SRV/` | 403 | Commitments not reachable |
| `API_PURCHASEREQUISITION_PROCESS_SRV/`, `API_PURCHASECONTRACT_PROCESS_SRV/` | 403 / **200** | Contract reachable, requisition not |
| `…/odata4/sap/api_enterpriseproject/…`, `…/api_projectbudget/…` | 403 | No OData v4 project service reachable |

**How to read a 403.** It means *this key cannot reach that path*. It does **not** prove the API
does not exist. SAP's sandbox exposes a curated subset, and entitlement differs per API package.
Where I claim an API does not exist, that claim rests on documentation (§6), not on a 403.

---

## 4. Field-level mapping feasibility

Against the live schema in `server/construction/db.mjs`.

| Our field | Table | Candidate SAP API | SAP field | Availability | Transformation |
|---|---|---|---|---|---|
| `sap_wbs_code` | `src_sap_wbs.code` → `wbs.source_id` | Enterprise Project v2 | `A_EnterpriseProjectElement.ProjectElement` | **LIVE** | Direct. Ours is `1.3.1`; SAP's is `TEMP002.1.1` — project-prefixed and up to 24 chars. Our dotted codes are a local convention and would be replaced, not reformatted. |
| `parent_code` | `src_sap_wbs.parent_code` | Enterprise Project v2 | `ParentObjectUUID`, or `to_ParentProjElement` | **LIVE** | **Not direct.** SAP links by **UUID**, we link by code. Requires a UUID→code map built from the same page. The null GUID means "root" and must not be mapped to a parent. |
| `name` | `src_sap_wbs.name` | Enterprise Project v2 | `ProjectElementDescription` | **LIVE** | Direct. Truncate to 40 chars. |
| `budget` | `src_sap_cost.budget` | — | — | **NONE reachable** | Not on the project APIs at all. Public Sector Budget APIs (Fund, Grant, Budget Period, Budget Account) are a separate product area (**DOC**) and were not reachable. Classical PS budgeting (BP-prefixed value types) has no OData service we found. **TENANT + product question.** |
| `planned_cost` | `src_sap_cost.planned_cost` | — | — | **NONE reachable** | Project cost planning is not exposed by any service we could reach. **TENANT.** |
| `actual_cost` | `src_sap_cost.actual_cost` | Journal Entry Item Basic | `AmountInCompanyCodeCurrency` summed per `WBSElement` | **LIVE** | **An aggregation, not a field.** Sum line items filtered by ledger, period range and cost elements, honouring `ControllingDebitCreditCode`. The filter set is Finance's decision. |
| `currency` | `src_sap_cost.currency` | Journal Entry Item Basic | `CompanyCodeCurrency` / `TransactionCurrency` / `GlobalCurrency` | **LIVE** | Pick one deliberately. Our model has one currency per WBS; SAP carries several in parallel and they are not equal. |
| `boq_item.code` | `src_sap_boq.code` | Purchase Order | `A_PurchaseOrderItem` (`PurchaseOrder` + `PurchaseOrderItem`) | **Partial — LIVE structure** | A PO line is a *contracted* item, not a BOQ master item. One BOQ item may span several POs, or none. This is a modelling decision, not a field map. |
| `boq_item.quantity` | `src_sap_boq.quantity` | Purchase Order | `A_PurOrdAccountAssignment.Quantity`, or `A_PurchaseOrderItem.OrderQuantity` | **LIVE (7 rows)** | Direct where it exists. Contracted quantity, which is not necessarily the BOQ quantity. |
| `boq_item.unit` | `src_sap_boq.unit` | Purchase Order | `PurchaseOrderQuantityUnit` | **LIVE** | SAP unit codes (`PC`, `EA`, `AU`, `H`) need a mapping table to ours (`m3`, `m2`, `t`, `no`). ISO-code conversion is available on the material master, **not verified**. |
| `boq_item.unit_rate` | `src_sap_boq.unit_rate` | Purchase Order | `NetPriceAmount` ÷ `NetPriceQuantity` | **DOC only** | The fields exist and carry values on PO items generally, but **no WBS-assigned PO line in the sandbox has a non-zero amount**, so the full chain was never read. Also: a PO price is a contract price, not necessarily an approved BOQ rate. |
| `earned_value` | `src_sap_earned_value.earned_value` | — | — | **NONE — see §6** | No API. Not an access problem. |
| *(no current field)* | — | Enterprise Project v2 | `A_EntProjElmntDlvbrl.EntProjElmntDlvbrlQuantity` + `…QuantityUnit` | **LIVE, updatable** | The one API-writable quantity on a WBS element. 12 rows in the sandbox. A possible home for an agreed quantity — **unproven for this purpose.** |

### What this means for the demo's own data

Of the eight fields the task listed, after live testing:

- **2 are directly available** — SAP WBS ID, parent WBS (via a UUID join).
- **2 are available with real work** — actual cost (aggregate), currency (choose which).
- **3 are partially available and semantically different** — BOQ quantity, unit, unit rate come
  from purchase orders, which are contracts, not a bill of quantities.
- **3 are not available at all** — budget, planned cost, earned value.

---

## 5. INT-04 read integration feasibility

**Verdict: buildable now, for part of what INT-04 claims.**

| INT-04 moves | Feasible? |
|---|---|
| WBS elements | **Yes — LIVE.** Enterprise Project v2. The single largest real win available. |
| Budget | **No.** Not in any reachable API. |
| Planned cost | **No.** Not in any reachable API. |
| Actual cost | **Yes, as an aggregation — LIVE.** Journal Entry Item Basic, with a Finance-approved filter. |
| Approved BOQ quantities and unit rates | **No, not as such.** Purchase order lines are the nearest object and mean something different. |

A real `SapWbsAdapter` reading `A_EnterpriseProjectElement` and emitting the `wbs` batch our sync
engine already consumes is a contained piece of work: the adapter contract in `adapters.mjs` was
built for exactly this substitution, and the normalized `wbs` table needs no change. The honest
scope is **structure now, cost later, budget and BOQ not at all without answers from ANDPL.**

---

## 6. INT-05 write-back feasibility

**Verdict: INT-05 as specified cannot be built, in any tenant. The specification needs to change.**

### Earned value has no API — NONE

S/4HANA does not expose earned value as a writable value. It is **derived**: Progress Analysis
runs as a batch job against a *progress version* (controlling-area specific), computes a
percentage of completion by the configured method, and earned value is **POC × overall planned
cost**. Results Analysis method 07 is the POC method based on project progress analysis
(**DOC**). The standard report is `12EVA1`. Searching SAP's documentation surfaced the
configuration and reporting of progress analysis and **no OData or REST interface for it**, and
`API_PROJECTPROGRESS_SRV` is not reachable.

So "post approved earned value to SAP by WBS" has no endpoint. Even with full ANDPL access and
every authorization, there would be nothing to call. This is the correction this phase exists to
deliver.

### The realistic path — Service Entry Sheet — LIVE service, **TENANT** data

The S/4HANA-native way to record measured construction progress is a **service entry sheet**
confirming performed quantity against a PO item that carries a WBS assignment. Cost and earned
value then follow from SAP's own posting and its own progress run — which is exactly the control
the integration proposal asks for, **SAP stays the only cost ledger**, and is a stronger position
than writing a computed value in.

`A_ServiceEntrySheet` is creatable. What is unproven:

- **Zero** sandbox service entry sheets carry a WBS element, so the chain was never read whole.
- Creating one requires a PO item to confirm against. Our model has no purchase orders at all.
- Approval, release and reversal behaviour is configuration, and unknown.

### The second candidate — deliverable quantity — LIVE, unproven for this purpose

`A_EntProjElmntDlvbrl.EntProjElmntDlvbrlQuantity` is updatable and sits directly on a WBS element.
It is the only API-writable quantity we found on the project structure. Whether ANDPL uses
deliverables at all, and whether writing to one is an acceptable way to record progress, is a
question for them — this is a possibility, not a recommendation.

### What does not change

`PERMITTED_FIELDS['INT-05']` already forbids writing budgets, cost postings, unit rates, BOQ
master data and WBS master data. Everything found here is consistent with that: the actual-cost
service is **GET-only in its own metadata**, so the prohibition is enforced by SAP as well as by
us.

---

## 7. Unsupported or customer-specific requirements

| Requirement | Status | Why |
|---|---|---|
| Project budget | **TENANT + product** | Not in the project APIs. Which budgeting is in use — classical PS budgeting, Public Sector Funds Management, or SAC planning — changes the answer completely, and may mean no API at all. |
| Planned cost | **TENANT + product** | Same. Cost planning may live in SAP Analytics Cloud rather than S/4HANA. |
| BOQ master with approved unit rates | **NONE found** | No BOQ or "Bill of Services" OData API was found. A community answer equates BoQ with Bill of Services in SD documents (**not official**). Construction BOQ in SAP typically lives in Commercial Project Management, an industry solution with its own availability question, or in a customer-built object. |
| Earned value posting | **NONE** | §6. No API exists. |
| Physical progress posting | **TENANT**, via service entry sheet | §6. |
| Unit-of-measure mapping | **TENANT** | SAP unit codes are client-configured; ours are a local convention. |
| WBS coding convention | **TENANT** | Our `1.3.1` is not SAP's `TEMP002.1.1`. ANDPL's scheme governs. |
| Authentication | **TENANT** | Communication arrangement per scenario (SAP_COM_0308 for Enterprise Project), with a communication user and certificate or basic credentials. The sandbox `APIKey` has no counterpart in a tenant. |

---

## 8. Required information from ANDPL

Ordered by how much it unblocks.

1. **Which SAP product and edition** — S/4HANA Cloud public, private, or on-premise, and the
   release. This decides which APIs exist before anything else.
2. **How project budget and planned cost are held** — classical PS budgeting, Funds Management,
   Commercial Project Management, or SAC. Without this, two of the eight fields have no path.
3. **Whether Commercial Project Management or any BOQ solution is licensed**, and where approved
   unit rates live.
4. **Whether construction progress is recorded through service entry sheets** against POs or
   contracts. If yes, INT-05 has a design. If no, we need to know what they use instead.
5. **Finance's filter definition for actual cost by WBS** — ledger, cost-element ranges, period
   convention, and which currency is authoritative.
6. **A quality-client tenant** with a communication arrangement for SAP_COM_0308 and a
   least-privilege read-only communication user.
7. **Their WBS coding convention** and the project(s) in scope.
8. **Their unit-of-measure list**, to build the mapping table.

Items 1 to 4 are *design* questions and can be answered in a workshop without any system access.
**They are the critical path, not the credentials.**

---

## 9. Recommended implementation sequence

Each step is useful on its own and none requires the next.

**Step 1 — A real read of S/4HANA project structure, in the sandbox, now.** No ANDPL access
needed. Add a `SapProjectStructureAdapter` reading `A_EnterpriseProject` and
`A_EnterpriseProjectElement` from v2, resolving the UUID hierarchy into our parent-code model, and
display it **beside** INT-04 as a second, clearly labelled source — never merged into it. This
proves hierarchy traversal, UUID resolution, paging and the v2 path against real SAP data, and
every line of it is reusable against a tenant. *This is the one meaningful S/4HANA sandbox
integration available today.*

**Step 2 — Actual cost aggregation, in the sandbox.** Sum `A_JournalEntryItemBasic` by
`WBSElement` with an explicit, configurable filter, and display the filter beside the number.
Proves the aggregation and surfaces the Finance question (item 5 above) as a concrete thing to
point at rather than a line in a document.

**Step 3 — The design workshop.** Items 1 to 4. Specifically: get agreement that **INT-05 posts a
service entry sheet, not an earned value**, or learn what replaces it.

**Step 4 — Tenant connection.** Communication arrangement, read-only user, repoint the Step 1 and
2 adapters. Expect WBS codes, units and the cost filter all to change.

**Step 5 — INT-04 for real,** structure and actual cost only, with budget, planned cost and BOQ
explicitly out of scope until items 2 and 3 are answered.

**Step 6 — INT-05 write-back,** against whatever Step 3 decided, in a quality client, through the
approval gate that already exists.

---

## 10. Answers to the questions asked

**Which SAP S/4HANA APIs were found?** Enterprise Project (v1 and v2), Journal Entry Item Basic,
Purchase Order, Service Entry Sheet, Cost Center, Bill of Material, Purchase Contract, Operational
Accounting Document Item, Maintenance Order.

**Which were actually tested?** All of the above answered 200 at the service root with our key.
Five were read down to record level: Enterprise Project v1 and v2, Journal Entry Item Basic,
Purchase Order, Service Entry Sheet. `$metadata` was downloaded and parsed for five.

**Which fields can we retrieve today?** WBS code, description, UUID, parent UUID, project id and
description, processing status, planned start and end, company code, controlling area, profit
centre, responsible cost centre — all live. Actual cost amount, currency and fiscal period by WBS
— live, as an aggregation. Purchase-order quantity and unit against a WBS — live but only 7 rows,
none priced.

**Which fields require ANDPL access?** Budget, planned cost, commitments, approved BOQ quantities
and unit rates, and anything resembling physical progress or earned value. Two of those — BOQ
master and earned value — may require more than access; they may require a different product or a
different design.

**Can we build a meaningful S/4HANA sandbox integration now?** **Yes, for project structure, and
yes for actual cost.** Step 1 and Step 2 above are real work on real S/4HANA data that carries
over to a tenant. We cannot build anything meaningful for budget, BOQ or earned value, and for
earned value no amount of access would help.

---

## Sources

Live requests to `https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/…`, made during this
phase with the Phase 7A key; statuses and counts as recorded in §3.

Documentation consulted:

- [Enterprise Project — SAP Help Portal](https://help.sap.com/docs/SAP_S4HANA_CLOUD/988903b47d7040f6ac4ec02e44bb58e4/b467d86283be4a56869f1e6784e47b64.html)
- [Extensibility: Enterprise Project — SAP Help Portal](https://help.sap.com/docs/SAP_S4HANA_CLOUD/988903b47d7040f6ac4ec02e44bb58e4/134dbb0c012e4e4c984889470121d52f.html)
- [Moving from Version 1 to Version 2 of the Enterprise Project OData API — SAP Community](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/moving-from-version-1-to-version-2-of-the-enterprise-project-odata-api/ba-p/13953906)
- [Enterprise Portfolio and Project Management in SAP S/4HANA Cloud 2202 — SAP Community](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/enterprise-portfolio-and-project-management-in-sap-s-4hana-cloud-2202/ba-p/13522517)
- [SAP Cloud SDK VDM — Enterprise Project service](https://help.sap.com/doc/88b0d45562c04571a8d117bc8b6b3b7a/1.0/en-US/classes/_sap_cloud_sdk_vdm_enterprise_project_service.enterpriseproject.html)
- [Progress Calculation — SAP Help Portal](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/4dd8cb7b1c484b4b93af84d00f60fdb8/6703c453f57eb44ce10000000a174cb4.html)
- [Evaluating Project Progress — SAP Help Portal](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/4dd8cb7b1c484b4b93af84d00f60fdb8/9c03c453f57eb44ce10000000a174cb4.html)
- [Using Progress Analysis to Monitor and Evaluate the Project Schedule — SAP Learning](https://learning.sap.com/courses/project-financials-control-in-sap-s-4hana/using-progress-analysis-to-monitor-and-evaluate-the-project-schedule)
- [Results Analysis Method 7, POC Method Based On Project Progress Value Determination — SAP Community](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/results-analysis-method-7-poc-method-based-on-project-progress-value/ba-p/13480153)
- [Bills of Material — SAP Help Portal](https://help.sap.com/docs/SAP_S4HANA_CLOUD/7489fa08cede494cbdf08fa3651598af/8a8b08aab6cd47f4a3e35e8bd8d86ca2.html)
- [APIs for SAP S/4HANA (PDF) — SAP Help Portal](https://help.sap.com/doc/57063b559ae04c86a281dc626f474091/2008.500/en-US/APIsforSAPS4HANA.pdf)
- [Enabling SAP S/4HANA APIs for Administrators — Payhawk](https://payhawk.com/help/enabling-api-services-on-sap-s-4hana-cloud-private-edition) *(third-party; used only for the v2 activation note)*
- [Bill Of Quantities — SAP Community](https://community.sap.com/t5/enterprise-resource-planning-q-a/bill-of-quantities/qaq-p/11711752) *(forum answer, explicitly labelled unverified above)*
