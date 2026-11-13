# ACS QC/QA validation framework

A configuration-driven framework that reads the ACS QC/QA checklists as data, decides which apply
to a piece of work, maps the records the application already holds onto them, evaluates every
requirement, and reports the result in the existing Maintenance UI.

It is one engine. There is no validator per PDF, and adding a document means adding a template
object — not code.

---

## Phase 0 — audit of what already existed

**Reused, unchanged:**

| Thing | Where | Note |
|---|---|---|
| Incident / ticket / task / work-order / inspection records | `src/maintenance/maintenanceRecords.js`, DataConnect classes | Already normalised; the framework reads them through adapters rather than re-reading DataConnect |
| Asset registry (5,015 rows) | `maintenance.assetIndex()` | The only source of asset category |
| Record selection and detail panels | `src/assetExplorer/` (React 19 + MUI) | The QC/QA view is a section inside the existing ACS case dialog |
| ACS repair tasks (23) | `public/data/acs-repair-tasks.json` | Real form submissions, added earlier in this work |

**Field inventory found by the audit:**

- **Work orders (967)** carry `Asset Type` (7 values), `Work Type` (7), `Repair Category` (25),
  `Asset ID`, status, open/close dates. These are what drive checklist selection.
- **Inspections (1,661)** carry `inspector_name`, `inspection_date`, `inspection_result`
  (Pass/Fail/Monitor), `pass_fail`, `asset_condition`, `asset_type`, plus **12 OK/Issue roadway
  condition fields** on 502 records.
- **No system holds ACS QC/QA checklist responses.** The 12 OK/Issue fields are a *different*
  checklist — a generic V3 roadway survey — so they are carried as `conditionObservations` and are
  never presented as answers to an ACS question.
- **No QC or QA approval record exists in any class.**
- **No evidence files.** The ACS export carries photo *counts*; the images were not supplied.

**Nothing was duplicated.** No parallel store, no second record service, no separate QC/QA app.

---

## Phase 1–2 — extraction and schema

All **22 supplied PDFs** extracted. Question text is the form's own wording, including units and
FDOT references. No question, threshold or evidence requirement was invented; nothing was omitted.

| Template | Document | Sections | Questions | Conditional | Multi-response | NO=pass | Thresholds | Evidence |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| ACS-526.1 | 526.1 Guardrail Repair QC_QA.pdf | 1 | 12 | 0 | 0 | 0 | 4 | 0 |
| ACS-527.1 | 527.1 Fence Repair QC_QA.pdf | 1 | 12 | 0 | 0 | 0 | 1 | 0 |
| ACS-531.1 | 531.1 Attenuator Repair QC_QA.pdf | 1 | 19 | 1 | 0 | 0 | 4 | 0 |
| ACS-ET-350 | End Treatment Installation (FLEAT 350, SKT 350 & SRT 350)  QC_QA.pdf | 4 | 12 | 3 | 0 | 0 | 3 | 0 |
| ACS-ET-TYPE | End Treatment Installation (TYPE II & TYPE IV )  QC_QA.pdf | 3 | 9 | 2 | 0 | 0 | 1 | 0 |
| ACS-534.1 | 534.1 Pavement Symbols Installation QC_QA.pdf | 1 | 5 | 0 | 0 | 0 | 0 | 0 |
| ACS-537.1 | 537.1 Raised Payment Markers Installation QC_QA.pdf | 1 | 9 | 0 | 0 | 0 | 1 | 2 |
| ACS-787.1 | 787.1 Highway Lighting Maintenance(Lighting Pole Reapiar)QC_QA.pdf | 1 | 12 | 0 | 0 | 0 | 0 | 0 |
| ACS-787.2 | 787.2 Highway Lighting Maintenance(Repair) QC_QA.pdf | 3 | 19 | 3 | 0 | 1 | 0 | 0 |
| ACS-787.3 | 787.3 Highway Lighting Maintenance(Inspection)QC_QA.pdf | 2 | 10 | 2 | 0 | 1 | 2 | 1 |
| ACS-901.1 | 901.1 Bridge Inspection QC_QA.pdf | 2 | 12 | 0 | 0 | 0 | 1 | 3 |
| ACS-CONCRETE | Concrete Repair & Inspection QC_QA.pdf | 2 | 8 | 2 | 0 | 0 | 0 | 1 |
| ACS-STRUCTURE | Structure Maintenance & Repair QC_QA.pdf | 2 | 13 | 0 | 0 | 0 | 0 | 2 |
| ACS-TOLL-ITS | Toll Building and ITS Hubs Annual Inspection QC_QA.pdf | 1 | 7 | 0 | 0 | 0 | 0 | 0 |
| ACS-540.1 | 540.1 Graffiti Removal  QC_QA.pdf | 1 | 5 | 0 | 0 | 1 | 0 | 0 |
| ACS-543.1 | 543.1 Road Sweeping (Mechanical) QC_QA.pdf | 1 | 5 | 0 | 0 | 0 | 0 | 0 |
| ACS-995.1 | 995.1 Service Patrol Checklist  QC_QA.pdf | 3 | 10 | 0 | 0 | 0 | 0 | 4 |
| ACS-996 | 996 Misc. Routine Maintenance QC_QA.pdf | 2 | 7 | 0 | 0 | 0 | 0 | 0 |
| ACS-MOWING | Large, Intermediate, Small, Slope, and Hand Mowing QC_QA.pdf | 1 | 6 | 0 | 0 | 0 | 0 | 0 |
| ACS-LANDSCAPE | Landscaping, Tree & Brush Removal, Herbicide Spray QC_QA.pdf | 4 | 12 | 3 | 0 | 0 | 0 | 1 |
| ACS-SAFETY | ACS Safety Inspection QC.pdf | 5 | 26 | 0 | 0 | 1 | 0 | 0 |
| ACS-PPE | Personal Protection Equipment Compliance_QC.pdf | 2 | 10 | 0 | 6 | 1 | 0 | 0 |
| **Total** | **22 documents** | **44** | **240** | **16** | **6** | **5** | **17** | — |

**Ambiguities and notes carried in the catalogue:**

- **534.1 Pavement Symbols** is a scanned document. Text was read from the scan and the checklist
  rows verified against it; the header `Name` field carries an inline Spanish annotation in the
  original. Flagged on the template as `extractionNote`.
- **995.1 Service Patrol** has no `Name` header field — it goes straight from SR to WO No.
- **ACS Safety Inspection** and **PPE Compliance** carry a **QC signature only**, no QA block.
- **PPE Compliance** asks for a **Task No.**, not a WO No.
- **ACS Safety Inspection** has one Comments / Action Plan column *per category*, not per row.

**Response types supported:** `YES_NO`, `YES_NO_NA`, `TEXT`, `NUMBER`, `DATE`, `MULTI_RESPONSE`,
`DOCUMENT_REFERENCE`, `APPROVAL`.

**Polarity is per question.** Five questions across the catalogue are satisfied by **NO**, and
treating every NO as a failure would misreport all five:

| Question | Document |
|---|---|
| "Are remnants of graffiti visible through the covering material used?" | 540.1 |
| "Is there visible damage to the sign light?" | 787.2 |
| "Are there any exposed or unsecured cables or wires?" | 787.3 |
| "Employees Working with Back to Traffic" | ACS Safety |
| "Any modifications or misuse of PPE observed?" | PPE |

**Multi-column responses.** The PPE form's six items each carry two independent responses — *worn
properly* and *condition ok* — evaluated separately, so one can pass while the other fails.

---

## Phase 3 — applicability and classification

`selectTemplates({ incidentType, assetType, assetSubtype, workActivity, workOrderId })`

| Rule | Behaviour |
|---|---|
| Incident type alone never selects | `{ incidentType: 'vehicle_collision' }` → UNRESOLVED |
| Asset type and activity decide | Attenuator + Corrective Repair → ACS-531.1, HIGH |
| Subtype refines | + QuadGuard → ACS-531.1, HIGH, reason names the model |
| Multiple matches allowed | Lighting + repair → 787.1 **and** 787.2, MEDIUM, confirmation required |
| Missing input → unresolved | Asset type with no activity → UNRESOLVED, with the reason |
| Generic never silent | Drainage repair → no match; ACS-996 **offered** for a reviewer to confirm |
| Reviewer override | `validateCase(case, { templateIds })` replaces the selection, flagged `overridden` |
| Provenance preserved | Every selection carries `selectionReason`, `confidence`, `basis`, `candidates` |

Universal checklists (995.1 Service Patrol, ACS Safety, PPE) are returned **alongside** the
asset-specific one, never instead of it.

---

## Phase 4 — canonical model and field mapping

The engine only ever sees `buildCase(...)` output: `{ caseId, incident, workOrder, inspection,
asset, acsTask, qcInspection, approvals, evidence, classification }`.

Adapters: `adaptWorkOrder`, `adaptInspection`, `adaptIncident`, `adaptAsset`, `adaptAcsTask`.

**Records are joined only where a record states the relationship** (`related_work_order_id`,
`Related Ticket ID`, `damaged_asset_id`). Nothing is joined by proximity or by date.

The registry (`FIELD_MAPPINGS`) carries canonical name, source system, source path,
transformation, type, confidence and a note. **Five mappings have no source and say so:**

| Canonical field | Why it is unresolved |
|---|---|
| `qcInspection.responses` | No system in scope holds per-question ACS responses. **This single mapping is what turns most MISSING into PASS or FAIL.** |
| `approvals.qc` / `approvals.qa` | No sign-off record exists in any class |
| `asset.subtype` | No class records an attenuator make or end-treatment model, so model-specific sections cannot resolve |
| `workOrder.laneDirection` | The ACS header asks for it; no maintenance class carries it |

---

## Phase 5 — the validation engine

Statuses, and the distinctions that matter:

- **PASS** — a recorded response satisfies the question, judged by that question's polarity.
- **FAIL** — a recorded response does not satisfy it.
- **MISSING** — no response was captured. Every MISSING finding's wording says it is *an absent
  record, not an observed defect, and says nothing about the condition of the asset.*
- **NEEDS_VERIFICATION** — information exists but is insufficient or conflicting (one PPE column
  blank; a QC name with no date; a failed inspection against a closed work order).
- **NOT_APPLICABLE** — the section does not apply, always with the reason.
- **NOT_EVALUATED** — no rule or no mapping. Never folded into PASS or NOT_APPLICABLE.

Categories implemented: A required-field completeness, B checklist response, C conditional
applicability, D cross-record consistency, E evidence availability, F approval completeness,
G technical thresholds (captured on 17 questions; evaluated only where a measurement exists —
today none does, so they report MISSING rather than inventing a measurement).

**A case is `approved: true` only when every applicable check passes *and* both sign-off records
exist.** A test asserts that twelve passing answers with no sign-off still leaves it false.

---

## Phase 6 — UI

Inside the existing ACS case dialog, QC/QA section, five sub-views:
**Overview | Checklist | Findings | Evidence | Approvals**, with filters for
All / Failed / Missing / Needs verification / Not evaluated.

Each finding shows the original ACS question, expected response, actual response, status, source
document and page, mapped field, and recommended action.

---

## Phase 7 — providers

```
getCase · getInspection · getWorkOrders · getAssets · getQCResponses · getEvidence · getApprovals
```

`createLocalProvider({ maintenance })` reads the application's own records. `getQCResponses()`
returns **null**, not `{}` — an empty object would read as "answered, all blank".

`apiProviderTemplate({ name })` is the shape Office Track, MIMS, SunGuide and DataConnect
providers take. With no client it **throws on every call** rather than returning an empty case.
No mock pretends to be a real API.

---

## Phase 8 — tests

`tests/qcqa.test.mjs` — **24 tests, all passing**, covering the 15 required scenarios plus
catalogue-wide guarantees:

- No response is ever invented — asserted across **all 22 templates**: with no responses supplied,
  no question may come back PASS.
- A case is never approved without approval records.
- Every finding states what was expected and why.
- The registry declares what has no source.

---

## Phase 9 — known limitations and unresolved mappings

1. **No ACS QC/QA responses exist anywhere.** 56 of 76 checks on the demonstration case are
   MISSING for this reason alone. This is the one gap that matters most.
2. **No approval records**, so no case can be approved.
3. **No asset subtype**, so 19 checks on the attenuator case are NOT_EVALUATED — the form is
   headed *QuadGuard* and nothing records the make.
4. **No evidence files** — photo counts only.
5. **Thresholds are captured but not evaluated.** 17 questions carry a numeric limit (27"–31" rail
   height, 30" clearance, 2% RPM failure). No source holds a measurement, so they report MISSING.
   The thresholds are stored so they are ready when measurements arrive.
6. **Seven questions can only be answered from site attendance** (*"QC/QA verify only if on site
   during repairs"*). These can never be inferred from a record.
7. **The ACS task ↔ maintenance record link is illustrative.** Surfaced as a
   NEEDS_VERIFICATION finding (`XREC-ACS-LINK`) rather than trusted.

### What to ask ACS for, in order

1. **QC/QA checklist responses per task** — item id, response, comment. Closes limitation 1.
2. **QC and QA sign-off records** — signatory and date. Closes 2.
3. **Asset make/model** on the work order. Closes 3.
4. **The Event #** on every repair task. Closes 7 and the wider link problem.
5. **Photo files**, not counts. Closes 4.

---

## Phase 9 — working demonstration

Maintenance → **Work Orders** → an attenuator corrective repair (`WO-900003`) → **Open ACS Case**
→ **QC/QA**:

- Selected **ACS-531.1** at **HIGH** confidence — *"attenuator repair — ACS-531.1 is the only ACS
  checklist covering it"* — from asset type and activity, explicitly not from the incident type.
- **76 applicable checks**: 0 passed · 0 failed · **56 missing** · 1 needs verification ·
  **19 not evaluated**.
- The 19 are the QuadGuard section, held open because no subtype is recorded.
- Both sign-offs outstanding.
- Source documents listed with version and page.

A lighting repair on the same path returns **787.1 and 787.2** at MEDIUM with confirmation
required — the multiple-checklist case.
