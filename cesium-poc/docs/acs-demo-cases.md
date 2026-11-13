# ACS Demo Case Validation

Seven synthetic cases that carry a complete **incident → inspection → repair → QC/QA → claim →
closure** lifecycle, so the corridor twin can show what the validation framework does when a full
record set exists. The production exports do not contain one: the ACS General Accident and Repair
Form has no checklist rows, no labour and no materials (see
[`acs-repair-link-assessment.md`](./acs-repair-link-assessment.md)), and no DataConnect class holds
a QC or QA sign-off (see [`acs-qcqa-framework.md`](./acs-qcqa-framework.md)).

## What is real and what is not

| | Real | Synthetic |
|---|---|---|
| Location of each case | ✔ an existing I-595 incident from the register | |
| The ACS QC/QA checklists the cases are inspected against | ✔ extracted from the ACS PDFs | |
| The validation engines | ✔ the same ones every other record uses | |
| Incident narrative, asset, inspection, repair, QC/QA responses, claim | | ✔ |
| Personnel, work orders, certificates, photographs, claim references | | ✔ all prefixed `DEMO-` |

Every record carries `demo: true` and a `SYNTHETIC DEMO DATA` label, and every surface that can
draw one draws the label with it — the KPI card's badge, the slider card's subtitle, the details
panel's banner and the dialog's banner. Nothing is conditional about that: a case this complete is
the most convincing thing on the screen, so the condition would eventually be wrong.

## Where the pieces live

| File | What it is |
|---|---|
| `public/data/acs-demo-cases.json` | the seven cases: field data, checklist responses, non-conformances, audit trails |
| `src/acs/acsDemoCases.js` | the feature flag, the schema check, the location resolver, the evaluation and the explanations |
| `src/qcqa/stageValidation.js` | the stage-level half of the shared validation framework |
| `src/qcqa/schema.js` | `STATUS`, extended with `PENDING` and `BLOCKED` |
| `src/assetExplorer/AcsDemoCasePanel.jsx` | the details panel, with the lifecycle and **Open ACS Case** |
| `src/assetExplorer/AcsCaseDialog.jsx` | the existing case popup, in its demo mode |
| `src/assetExplorer/assetTypes.js` | the `acsDemoCase` asset type (card, filters, subtitle) |
| `src/maintenance/maintenanceWorkspace.js` | the `Demo Case Validation` KPI card and its dataset |
| `tests/acsDemoCases.test.mjs` | the acceptance checks |

## The seven cases

| Case | Asset | Checklist | Inspection | Repair | QC/QA | Claim | Overall |
|---|---|---|---|---|---|---|---|
| ACS-DEMO-001 | Crash attenuator | ACS-531.1 | **Failed** | Blocked | Blocked | Blocked | `BLOCKED_AT_INSPECTION` |
| ACS-DEMO-002 | Lighting pole | ACS-787.1 | Passed | **Failed** | Blocked | Blocked | `BLOCKED_AT_REPAIR` |
| ACS-DEMO-003 | Raised pavement markers | ACS-537.1 | Passed | Passed | **Failed** | Blocked | `REWORK_REQUIRED` |
| ACS-DEMO-004 | Crash attenuator (QuadGuard) | ACS-531.1 | Passed | Passed | Passed | **Failed** | `CLAIM_ACTION_REQUIRED` |
| ACS-DEMO-005 | Highway lighting equipment | ACS-787.1 | Passed | Passed | Passed | Passed | `CLOSED` |
| ACS-DEMO-006 | Guardrail | ACS-526.1 | Passed | **In progress** | Pending | Pending | `REPAIR_IN_PROGRESS` |
| ACS-DEMO-007 | Pavement symbols | ACS-534.1 | Passed | Passed | Passed | Pending | `AWAITING_CLAIM` |

Four blocked or failed, two pending or in progress, one closed — which is what the KPI card counts,
from these records rather than from a constant in the component.

## Nothing on screen is declared

The JSON states a `declaredStatus` for each stage. **The application never reads it.** Each stage
status is derived:

- every field is evaluated by one function, `evaluateStageField`, against its own `acceptance` rule
  (`notEmpty`, `oneOf`, `min`/`max`, `equalsField`) — there is no per-case validation code;
- a stage passes only when no mandatory field is `FAIL` or `MISSING`, and never because it is empty;
- the QC/QA stage's result comes from the **existing** `validationEngine.js`, run over the case's
  recorded answers to the real ACS checklist, including its evidence and approval rules;
- the overall status comes from a rule table keyed on the first stage that did not pass.

`tests/acsDemoCases.test.mjs` asserts the derived values against the declared ones, so a narrative
that drifts away from its own field data fails the build instead of being drawn as if it were true.

### The four absences, kept apart

| Status | Means |
|---|---|
| `FAIL` | a recorded value does not satisfy its rule — a judgement about data that exists |
| `MISSING` | a mandatory record that should exist and does not |
| `PENDING` | a mandatory record that is **not due yet** (ACS-DEMO-006's completion photographs) |
| `BLOCKED` | a record that cannot be produced because an earlier stage failed |

`BLOCKED` is reserved for a stage held up by a **failure**. A stage waiting on work that is merely
unfinished is `PENDING`: pending is not failure, and an unfinished job must not read as a late one.

## Locations

Resolved at runtime, never written into the file. The incident register's located records are
sorted west to east, cut into seven buckets, and each case takes the first unused incident in its
own bucket — preferring one whose source record states the direction the case asks for. The result
is deterministic, so the same register always yields the same seven, and spread, so the cases sit on
different segments.

- Direction is read from the source incident's own text, or reported as *not recorded*. It is never
  guessed from the case narrative.
- **Milepost is always null.** The register publishes none. The panel shows the distance measured
  along the corridor centreline instead, labelled as such — the app's long-standing rule that a
  derived distance is never printed as an FDOT milepost.
- If the register supplies fewer located incidents than there are cases, the shortfall is *reported*
  and the unplaced cases are listed without a location. No coordinate is ever invented.

## Thresholds

Where an ACS checklist states a figure (30 in clearance, 32 ⅛ in nose height, 1.5 in anchor stud,
0.78 in fender gap, 27–31 in rail height), the case quotes the checklist and names the clause. Where
it states none, none is invented. The single demonstration-only figure — a 40 in RPM centre on
ACS-DEMO-003, used so the observed 52 in has something to be compared with — is marked
`demonstrationOnly: true` in the data and is drawn on screen as an assumption, not as an FDOT
citation. A test fails if a `demonstrationOnly` measurement does not say so.

## Claims

ACS-DEMO-004 fails **ACS's own pre-submission validation**: the third-party details were never
transcribed and the claimed total ($34,250) exceeds the approved repair cost ($31,800) with no
documented variation. `insurerDecision` is `null` and the dialog says no insurer has seen it — an
internal failure is never drawn as an insurer's rejection. ACS-DEMO-005 is the one case with an
insurer decision, and it names the insurer as synthetic.

## Isolation

- Nothing is written to DataConnect or Office Track. The cases are read from a committed JSON file
  and live only in the browser.
- No existing record is altered. The register is read; the cases hang off it.
- The demo card's count feeds no other card, and the demo class is **never drawn as context** beside
  the operational classes on the maintenance overview — its markers appear only while its own card
  is the one being browsed.
- The class is exempt from the workspace's six-month window, so the set is always the same seven.

## Switching it off

`?acsDemo=off` for one visit, or `VITE_ACS_DEMO_CASES=off` at build time. With it off the card does
not exist, no case is loaded, and nothing else on the screen changes. `?acsDemo=on` overrides the
build setting.

## Using it

1. Maintenance Team → the **Demo Case Validation** card (purple, badged `DEMO`).
2. The bottom slider opens on the seven cases, with Previous/Next and the usual filters (state, and
   which stage failed). Selecting a case highlights its source incident on the map.
3. The details panel shows the lifecycle, the location, the checklist and the next required action.
4. **Open ACS Case** opens the existing case popup on six tabs: Overview, Inspection, Repair, QC/QA,
   Claim, Audit Trail. Overview carries the three business-value sentences — what was detected, why
   it matters, what to do — generated from this case's findings by a fixed rule, not by a model.
5. Clicking the card again closes the class and returns the workspace to its normal view.

## Known deviations from the brief

- The brief's narrative calls a stage with no record `NOT_STARTED` even where an earlier stage has
  failed (ACS-DEMO-001's repair and claim, ACS-DEMO-002's claim). The engine reports `BLOCKED` there,
  because "nobody has started this" and "nobody *can* start this" are different facts — and the
  brief's own overall status for those cases is `BLOCKED_AT_…`. All seven **overall** statuses match
  the brief exactly.
- Each slider card shows the case id, its subtitle, the overall status and the date; the full field
  list and the **Open ACS Case** button are on the details panel beside it rather than inside the
  card. A carousel card is 78px tall and three across — twelve fields and a button would not have
  been a card.
