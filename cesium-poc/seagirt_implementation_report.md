# Seagirt Ask the Twin: context-aware maintenance intelligence (implementation report)

Covers [seagirt_implementation.md](seagirt_implementation.md). Requirement-by-requirement status:
[seagirt_implementation_checklist.md](seagirt_implementation_checklist.md).

## 1. Confirmed root cause of the incorrect answer

"For degraded asset, what needs to be fixed?" with an area selected returned a power status summary because of four
problems, each confirmed in the code:

1. **The area router ran first.** `askQuestion` (src/ifcSpatial/networkTwin.js) sent every question to the Select
   Area router before document intelligence whenever an area was active.
2. **It matched keywords and had no maintenance objective.** The router's classifier (`areaIntentOf`,
   src/ifcSpatial/areaQuery.js) took the first keyword match. It had no category for corrective actions,
   diagnosis or repairs. "fixed" matched nothing, and the status word "degraded" matched STATUS, so `askAreaStatus`
   answered.
3. **There was no fallback without an area.** The document classifier (`classifyDocumentQuestion`,
   src/ifcSpatial/docQuestions.js) returned null for the question: it had no fix/repair wording, and it only worked
   on one named or in-context asset. "Degraded assets" was never turned into a set of assets to investigate.
4. **One tool per question.** Every handler produced the final answer itself, so a status lookup could not pass its
   assets to the document analysis.

Checked and ruled out: the per-asset document analysis worked correctly. No LLM was involved in Seagirt routing.

## 2. Routing: before and after

| | Before | After |
|---|---|---|
| First step | Keyword handlers in a fixed order (reports, area, documents, versions, spatial, status, engine) | `planQuestion` reads the objective, target, scope, time and output before any handler |
| Status words and categories | Could decide the answer | Become filters (`assetFilters`) only |
| Selected area | Its own intents, checked first | Part of the scope; the same intents apply to an area, the terminal, a named asset or the previous answer |
| Follow-ups | Only within one asset's document review | Structured context: selected asset, previous collection, last investigation; "it" / "these" resolved; clarification when ambiguous |
| Tools per question | One | An investigation plan run by the orchestrator over several services |

Maintenance objectives go to the orchestrator. Report and email requests about an investigation use it.
Follow-ups that refer back ("it", "this asset") are rewritten for the existing engines (outage, alternate supply,
replacement, supply). Everything else goes through the existing handlers unchanged.

## 3. Investigation orchestration

```
question + conversation context + selected area
  → planQuestion (askIntent.js): validated plan (intents, target, scope, steps, response type)
  → runInvestigation (askOrchestrator.js):
      RESOLVE_SCOPE → FILTER_ASSETS_BY_STATUS → RETRIEVE_OPERATIONAL_STATUS → RETRIEVE_LINKED_DOCUMENTS
      → ANALYSE_INSPECTIONS (per asset, 3 at a time, partial results) → BUILD_MAINTENANCE_ASSESSMENT
  → buildMaintenanceAssessment (maintenance.js): the response contract
  → maintenanceHtml (maintenanceAnswer.js) + map actions (focus one asset / highlight and frame several)
```

- **Stale and cancelled answers.** A newer question cancels a running investigation, and its result never lands on
  the newer turn. The scope is fixed when the investigation starts.
- **No repeat downloads.** Analyses already read in the conversation are reused, so no document is downloaded twice.

## 4. Existing services reused

- **Network, status and simulation:** the operational status engine (operations.js), supply paths and alternate
  routes (topology.js, electricalGraph.js) and the outage simulation.
- **Documents:** document intelligence (server/ifcSpatial/docIntel.mjs: extraction, inspection comparison, closure,
  citations), the document index and preview, and the existing replacement review.
- **Area:** Select Area membership, resolved on the server.
- **Reports and email:** the report job service, PDF and XLSX rendering, the email composer and Gmail sending.

## 5. New components

| File | Role |
|---|---|
| src/ifcSpatial/askIntent.js | Intent taxonomy, objective priority, typo tolerance, target / scope / time resolution, validated plan |
| src/ifcSpatial/askOrchestrator.js | Dependent and parallel steps, controlled concurrency, partial results, cancellation |
| src/ifcSpatial/maintenance.js | The maintenance assessment contract; evidence cases; focused answers |
| src/ifcSpatial/maintenanceAnswer.js | Single-asset card (trend chart, findings, evidence), multi-asset list, suggestions |
| server/ifcSpatial/reports/maintenanceSnapshot.mjs | The maintenance report snapshot (same assessment, built on the server) |

**Modified:**
- networkTwin.js (routing, context, rendering, clicks).
- The report service (MAINTENANCE kind), snapshot.mjs (names), pdfReport.mjs (maintenance body), xlsxRegister.mjs
  (corrective action register), emailDraft.mjs (maintenance email).
- reportAnswer.js (wording), chatAnswer.js (scope chip, suggestion limit), ifcSpatial.css.

**New tests:**
- Unit tests: tests/askIntent.test.mjs, tests/askOrchestrator.test.mjs, tests/maintenance.test.mjs, plus new cases in
  tests/reports.test.mjs.
- Browser test 20 in e2e/ifcSpatial.spec.ts.

## 6. Response contract (MAINTENANCE_ASSESSMENT)

**Top level:**
- `scope`: type, selectionId, ifcVersionId, label.
- `filters`: the asset filters applied.
- `summary`:
  - matchingAssets, assetsWithDocumentedFindings and assetsWithoutDocumentedFindings (always add up);
  - assetsWithVerifiedDegradationCause and assetsWithUnknownDegradationCause;
  - partialEvidence.
- `assets[]`, `mapActions`, `limitations`.

**Per asset:**
- **Identity and status:** assetId, assetType, operationalStatus, powerState (only from the status engine),
  statusDate.
- **Inspection:** latestInspection, conditionTrend (actual dated ratings only).
- **Findings:** each with severity, trend, first and latest reported dates, and a source reference.
- **Actions:** documentedCorrectiveActions (closure NOT_VERIFIED or NOT_COMPLETED_WITH_EVIDENCE), completedActions
  and closureEvidence, additionalInvestigations (marked DERIVED), operatingRestrictions (applicability not verified).
- **Cause:** degradationCause, NOT_ESTABLISHED unless a document states it.
- **Evidence:** evidenceAvailability, maintenanceRecords, sourceRefs, limitations.

One contract serves single and multiple assets; the interface chooses the card or the list by count.

## 7. Context resolution

1. **Objective first.** The objective is chosen from an ordered rule list, most specific first: email, report,
   outage, alternate supply, replacement, restrictions, status history, trend, recurrence, outstanding actions,
   corrective actions, diagnosis, inspection history, specifications, versions, construction, downstream, supply,
   status, location, inventory.
2. **Objective words are removed** before categories are read ("alternate supply" is not the Supply category).
3. **Target**, in order:
   - named ids, validated against the model;
   - an explicit reference ("this asset", "it", "these");
   - a status or category filter phrase ("for degraded assets");
   - no asset words at all: the previous investigation or collection, or the selected asset.
4. **Scope.** The selected area by default; "across Seagirt" means the whole terminal, without clearing the area.
5. **One asset needed but several possible:** "Which asset do you mean?" with the options.

## 8. Evidence validation

- **Every finding is cited.** Each finding, action and restriction comes from the document analysis with its
  citation: document id, version, page, section and the extracted text. References are grouped by document and page.
  Nothing is generated from free text.
- **Evidence cases are kept apart:** no documents, retrieval failed, unreadable, no inspection report, inspected with
  no findings, findings available.
- **Rules that are never broken:**
  - A cause is never claimed from historical findings.
  - Missing closure evidence is "not known to be done or not done".
  - Missing history is not "overdue".
  - Energized does not mean safe.
  - An inspection date is not the start of an operational status.
- **Further checks are labelled.** Defects without a documented action get a suggested check, marked as derived from
  the findings, not a documented instruction.
- **Maintenance and work-order records** are listed as evidence. Their contents are not read, and the answers say so.

## 9. Screenshots and examples

Screenshots come from browser test 20 (set `AREA_SHOTS=<folder>`), using the PDF test fixtures:

| File | Shows |
|---|---|
| m1-single-asset | Single asset, default width |
| m2-multi-default | Several assets, default width |
| m3-multi-expanded | Several assets, expanded width |
| m4-drilldown | One asset opened from the list, with Back to results |
| m5-maintenance-report | The maintenance report card |
| m6-email | The email composer |
| m7-source-preview | A source opened in the document preview |
| m8-email-expanded | The email composer, expanded width |
| m9-missing-evidence | An asset with no documents |

Example report files are produced by a script from the same fixture records:
- `Maintenance_Report_<date>.pdf`
- `Corrective_Action_Register_<date>.xlsx` (sheets: Corrective Action Register, Asset Summary, Restrictions and
  Closure, Sources and Criteria)
- the email draft text.

## 10. Test results (at completion)

- **Unit suite:** all pass except one road-structure test (src/roads), which was already failing before this work
  and is unrelated.
- **Maintenance unit tests:** 9 intent tests, 5 orchestrator tests, 7 assessment tests, and 2 new report tests
  (area report, maintenance report).
- **IFC Spatial browser suite:** 20 of 20 pass. Test 20 covers:
  - Scenario A: area → status → "what needs to be fixed" → sources → six follow-ups → report → email → alternate
    supply → replacement → outage.
  - Scenario B: several assets, drill-down, Back to results, all on the map, both widths.
  - Scenario C: an asset with no documents.
  - Scenario D: expand and restore, area kept, terminal-wide override, cleared area.
- **Regression:** the Seagirt electrical twin and general smoke suites, 11 of 11 pass. No code shared with ACS,
  I-595 or PortMiami was changed: src/askTheTwin.js and src/spatial/ are untouched.
- **Browser suite under load:** in the final full run, which took 30 minutes instead of the usual 13, test 19's
  width check timed out once. The test passes on its own; the width checks now allow 20 seconds.

## 11. Known limitations and incomplete data sources

- **Fixture data only.** Verified on the PDF test fixtures and the fixture IFC model, not on the live ACC project.
  Screenshots and example files are from the fixtures.
- **Maintenance and work-order records** are identified, not read. Completed work is verified only from later
  inspection reports.
- **No status history.** The model holds the current status and its record date only, so "since when" cannot be
  answered beyond that.
- **LLM only for unclear questions, and off by default.** Questions are read by deterministic rules, which tolerate
  one-letter typos in key words. With `SEAGIRT_ASK_LLM=on`, a question the rules do not understand is sent to Claude
  Haiku 5.5 (server/ifcSpatial/interpret.mjs, src/ifcSpatial/askInterpret.js) and rewritten into a form the rules
  support. The rewrite must name only assets in the open model; answers still come from the twin's services and show
  "Understood as: …". Claude is called at two points: the network engine's "not understood" answer, and an area
  question that only matched the generic inventory. Off, unreachable or over budget, the existing handlers answer as
  before (browser test 21, tests/seagirtInterpret.test.mjs).
- **Gmail during an investigation.** Sign-in and sending are covered by the existing report test (15) with the same
  composer. The maintenance flow was not separately signed in to Gmail in tests.
- **Headless preview.** Headless Chromium does not render PDFs inline, so the source preview screenshot shows the
  viewer frame and the cited file and page only.
