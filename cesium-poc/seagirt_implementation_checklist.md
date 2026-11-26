# Seagirt context-aware intelligence: implementation checklist

Tracks every requirement in [seagirt_implementation.md](seagirt_implementation.md) (the master specification).
Status: `[x]` done and tested · `[~]` partly done · `[ ]` not started. Updated at the end of each phase.

## Confirmed root cause (§3)

Traced in code for "For degraded asset, what needs to be fixed?" with an area selected:

1. `askQuestion` (src/ifcSpatial/networkTwin.js) sends every question to the Select Area router `askArea` before
   document intelligence runs, whenever an area is active.
2. `areaIntentOf` (src/ifcSpatial/areaQuery.js) is a first-match keyword cascade. It has no category for
   corrective actions, diagnosis or repairs. "fixed" matches nothing, and the status word "degraded" matches
   STATUS, so `askAreaStatus` answers with a power status summary.
3. Without an area, `classifyDocumentQuestion` (src/ifcSpatial/docQuestions.js) returns null for the same
   question. It has no fix/repair/"what is wrong" vocabulary, and it only works on one named or in-context
   asset. "Degraded assets" is never resolved into a set of assets for document analysis.
4. Every handler builds the final answer itself (one tool per question). A status lookup cannot pass its
   assets on to the document analysis.

Not causes (checked): document intelligence itself works per asset (`/documents/analysis`); the LLM is not
involved in Seagirt Ask the Twin routing (all routing is deterministic in the browser).

## Phase 1: intent and context foundation (done)
- [x] §4 Questions split into objective, target, scope, time and output: `planQuestion` in src/ifcSpatial/askIntent.js
- [x] §5 Shared intent taxonomy (`INTENT`, the 20 in the spec + HISTORICAL_STATUS), with no per-area copies (the area is `scope`)
- [x] §6 Objective first, by an ordered rule list. Status words and categories become `assetFilters`; one-letter typos in key words are corrected; plurals accepted
- [x] §7 Orchestrator `runInvestigation` (src/ifcSpatial/askOrchestrator.js): steps in order, per-asset document analysis in parallel (limit 3), partial results, `isCurrent` cancellation
- [x] §8 Validated plan: known intents and steps only, asset ids checked against the model, the selection id, the response type
- [x] §9 Conversation context (`conversationContext`): selected asset, previous collection, last investigation; "it" / "these" / "this asset"; one-asset questions with several candidates ask "Which asset do you mean?"
- [x] Maintenance questions are routed before the area and status handlers; the existing document review keeps follow-ups on its own asset
- [x] Follow-ups such as "What happens if we shut it down?" resolve the asset and use the existing engine (the turn keeps the typed question)
- [x] Unit tests: tests/askIntent.test.mjs (7), tests/askOrchestrator.test.mjs (5)
- [x] Browser test 20: area → "Which assets are degraded in this area?" → "For degraded asset, what needs to be fixed?" → document-backed assessment; source preview; follow-ups; terminal scope; asset without documents

## Phase 2: maintenance intelligence (done)
- [x] §10 Workflow: targets → operational status → linked ACC documents → existing document analysis (inspection and test reports) → corrective actions and closure → evidence quality → assessment (src/ifcSpatial/maintenance.js)
- [x] §10 step 3 Maintenance, repair and work-order records are listed as evidence, with a stated limit: their contents are not read, so completed work is not verified from them
- [x] §10 step 5 Kept apart: findings, documented actions (closure not verified / documented not completed), actions documented as completed, further checks derived from the findings (labelled as derived, not instructions), operating restrictions
- [x] §13 Every finding carries document, version, page, inspection date and evidence text; references grouped by document and page; preview opens at the page; per-finding "Evidence" expander
- [x] §14 Evidence cases kept apart (NO_DOCUMENTS, RETRIEVAL_FAILED, UNREADABLE, NO_INSPECTION_RECORDS, NO_RELEVANT_FINDINGS, AVAILABLE); cause NOT_ESTABLISHED unless documented; missing closure ≠ not done; missing history ≠ overdue
- [x] §15 Focused answers (`focusedSay`): since when (status record date ≠ start; inspection date never used as the start), getting worse (actual first/last rating), occurred before (first reported, new findings), outstanding (closure states), §16 restrictions (applicability not verified, energized ≠ safe, engineering approval), why (no claimed cause)
- [x] §11 Single-asset card: identity, status ("still powered" only from the status engine), actual trend chart (hidden below two points), the asked focus first with the findings folded, "What needs to be fixed or investigated" (5 shown, "View all findings"), restrictions, engineering review, latest-inspection source, Show on map / View inspection, ≤3 suggestions
- [x] §22 One contract for one asset or many
- [x] Tests: tests/maintenance.test.mjs (6); browser test 20 extended with six follow-ups (no new document downloads: cached analysis reused)
- [ ] Generate maintenance report button: Phase 4 (left out until it works, so there is no placeholder)

## Phase 3: multiple assets, UI and map (done)
- [x] §12 Multi-asset summary: the direct answer, metrics that add up (matching / with documented findings / without), a separate note when the cause is not established, rows sorted with findings first (then failed reads, then by status), status-specific gaps ("Cause of power loss not documented"), 8 rows then "N more"
- [x] §12 A row opens that asset's assessment in the same answer, focuses it on the map, and offers "Back to results (N)"; Back returns the list, highlights all, and closes the asset panel
- [x] §19 One asset: the existing focus (locator beam, ring, label), area boundary and status indicators kept. Several: highlight and frame them all, labels without beams (existing decluttering), "Show all on map"
- [x] §23–24 Same design language; one implementation with container queries: rows, metrics and actions widen in the expanded panel; switching width keeps the opened asset, the list and the highlights
- [x] §25 Step-by-step progress ("Retrieving linked inspection records…", "Analysing inspection findings (k of n)…"), cached analyses (no repeat downloads), a newer question supersedes a running investigation (its result never lands), the scope fixed when the investigation starts
- [x] Browser test 20 extended: multi-asset list, counts, Show all on map, drill-down, Back to results, both widths, superseded investigation
- [x] Screenshots: single asset (default width), several assets (default and expanded), drill-down

## Phase 4: follow-up workflows (done; IFC Spatial browser suite 20/20)
- [x] §15 "Since when", "getting worse", "occurred before", "still outstanding": focused answers (Phase 2), checked again in browser test 20
- [x] §16 Operating restrictions: documented text, applicability not verified, energized ≠ safe, engineering approval; no safety clearance or shutdown instruction
- [x] §17 Outage, alternate supply, supply and downstream on the investigation's asset: follow-ups that say "it" resolve the asset and use the existing engines (whole network; the outage split by area when an area is selected; simulation kept until the user resets it); the turn keeps the typed question
- [x] §18 Replacement only when asked: "What needs to be done before replacement?" uses the existing replacement review of the resolved asset
- [x] §20 Maintenance report (REPORT_KIND.MAINTENANCE): the server reads the documents and builds the same assessment (server/ifcSpatial/reports/maintenanceSnapshot.mjs, src/ifcSpatial/maintenance.js); PDF with summary, matching assets, area and locations plot, per asset condition and trend, defects, corrective actions and closure, further checks (labelled derived), restrictions, data completeness, sources, limitations, illustrative notice; Corrective Action Register (register, asset summary, restrictions and closure, sources and criteria; editable tracking columns; no duplicate rows); immutable snapshot with the investigation and the area
- [x] §20 "Prepare a report of these issues", "Generate a maintenance report", the "Generate maintenance report" button, "Create an Excel register of …" (Excel only); an inspection report request still goes to the inspection report
- [x] §21 "Inform the maintenance team" / "Draft an email …": the draft from the investigation's report (scope, assets and main findings, open actions, missing evidence, review request, attachments); recipients only from the question or the directory; never sent automatically; existing composer and Gmail flow
- [x] Objective words are not categories ("alternate supply" ≠ the Supply category): unit test
- [x] Tests: reports endpoint test for a maintenance report (PDF text, register sheets and rows, email body, draft state, snapshot); browser test 20 (report, email, alternate supply, replacement)
- [x] Filenames: Transformer_Maintenance_Report_<date>.pdf / Corrective_Action_Register_<date>.xlsx (Selected_Area_… when the investigation was in an area)

## Phase 5: validation (done)
- [x] §26 Every question in the validation list checked for objective, target and response type (tests/askIntent.test.mjs, "§26 validation list"); the same objective for every category
- [x] §27 Unit tests: intent, priority, status words, planning, scope, previous collection, pronouns, ambiguity, multiple and dependent tools, document retrieval failure, findings, actions, condition history, recurrence, closure, missing documents, claimed causes, inspection vs status, source grouping, single and multi contracts, count consistency, report and email from an investigation, stale results
- [x] §27 Browser tests (test 20): area, degraded, what needs to be fixed, documents read, single and multi assessments, source preview, one and all assets on the map, Back to results, both widths, area kept, outage follow-up, real PDF and XLSX, composer, draft kept across width change, cleared area, terminal-wide question. Gmail sign-in with the composer: covered by test 15 (same composer and flow)
- [x] §28 Scenarios A–D on the fixture IFC model and PDF records (not the live ACC project)
- [x] Regression: unit suite (only the earlier road-structure failure); IFC Spatial browser suite 20/20 (test 19 once timed out under a slow full run, passes alone, wait raised to 20 s); Seagirt and smoke suites 11/11; no ACS, I-595 or PortMiami code changed
- [x] §30 Deliverables: seagirt_implementation_report.md, screenshots m1–m9, example PDF, register and email
- [ ] Verification against the live ACC project (needs your sign-in and real documents)
