# Context-aware Ask the Twin for Asset Operations & Maintenance

Ask the Twin already understood the TMC, Safety Intelligence and a drawn map area. On Asset
Operations & Maintenance it understood almost nothing: it had the screen name and nothing else, so
"why did inspection fail?" had no case and "show it on the map" had no it.

This adds the case to what it knows. It is an extension of the existing assistant — the same button,
the same panel, the same context provider, the same orchestrator, the same tool-result shape. There
is no second chatbot and no second assistant.

## What was already there, and is reused unchanged

| Piece | Where | Reused for |
|---|---|---|
| The panel, suggestion chips, message list, actions | `src/askTheTwin.js` | all of it |
| The context provider (`buildTwinContext`, `describeTwinContext`, `authorisedIds`) | `src/spatial/twinContext.js` | the case context rides in it |
| The capability registry and its `ok`/`unavailable`/`PROVENANCE` contract | `src/twin/capabilities.js` | the case capabilities are in its shape |
| The bounded orchestrator (plan → run under limits → report every step) | `src/twin/orchestrator.js` | runs the case plan |
| The validation engines | `src/qcqa/stageValidation.js`, `src/qcqa/validationEngine.js` | every stage status |
| The workbench model | `src/maintenance/caseWorkbenchModel.js` | headers, findings, timelines |
| The evidence connectors and search | `src/acs/evidence/*` | `search_missing_evidence` |
| The incident-context service | `src/acs/incidentContext.js` | weather and the traffic position |
| The claims model | `src/maintenance/claimsIntelligence.js` | every claim figure |
| The association rule | `src/maintenance/assetOpsModel.js` | related assets |
| Case Map Focus Mode, `openDetail`, the workbench's own stage opening | `src/maintenance/maintenanceWorkspace.js`, `caseWorkbench.js` | every navigation action |

## Why the tools are client-side

The spec asks for the backend tool layer to be extended. The audit found that it cannot be: the
server's tools (`server/liveDc/askTools.mjs`) read DataConnect, and none of this material is in
DataConnect. The seven cases come from a committed JSON file, their statuses are derived in the
browser by the shared validation engine, their evidence search runs against the browser's loaded
records, and their claim figures are computed from the case file. A server-side
`get_case_validation` would be a tool the server could not run.

So the case capabilities join the **existing client registry**, which is where the TMC and Safety
capabilities already live and for the same documented reason. One consequence worth stating: an
answer and the Case Workbench can never disagree, because they are the same call.

## What was added

```
src/maintenance/assetOpsContext.js    the context, the indicator, the derived suggestions   (pure)
src/maintenance/caseCapabilities.js   12 read-only capabilities                              (pure)
src/maintenance/caseAnswers.js        question → plan, results → answer                      (pure)
```

and, in existing files:

- `twinContext.js` carries an `assetOps` block, describes it in prose, and adds its identifiers to
  `authorisedIds`. The block is null on every other screen.
- `maintenanceWorkspace.js` exposes `askServices`: the context, the records the workbench is already
  drawing, the two async services it already uses, and the navigation actions. Plus `onContextChange`,
  so the chips and the indicator follow the selection the way the TMC's already do.
- `caseWorkbench.js` exposes `openStage` / `openSection`, which the click handler now uses too.
- `askTheTwin.js` takes `assetOps`, merges the case capabilities into the one registry, answers case
  questions before anything else while that screen is open, shows the indicator, and offers the
  actions.

### The capabilities

Per case: `get_case_summary`, `get_case_validation`, `get_case_evidence`, `get_case_activity`,
`get_case_claim`, `search_missing_evidence`, `get_incident_weather`, `get_incident_traffic`,
`get_nearby_incidents`, `get_related_assets`.

Per set: `search_cases` (the queue), `search_claims` and `get_claims_summary` (Claims
Intelligence), `get_operations_overview` (the corridor's own figures).

All fourteen are `readOnly: true` and declare `screens: ['maintenance']`. There is no approve, submit,
close or attach in the vocabulary, and a test asserts that no capability name contains one.

### The navigation actions

`VIEW_CASE_ON_MAP`, `OPEN_VALIDATION_STAGE`, `SHOW_MISSING_EVIDENCE`, `OPEN_CLAIM`,
`OPEN_RELATED_CASE`, `HIGHLIGHT_ASSET`, `SHOW_AUDIT_HISTORY`.

Each is checked twice before a button is offered: the **type** against the vocabulary, and the
**subject** against the records the workspace actually holds. Every one of them runs through
`openDetail`, so exactly one record surface can be on screen — the probe measured one at every step,
and the legacy ACS modal never opens over the workbench.

## The rules this had to keep

- **A synthetic case is not a real one.** `isSynthetic` is in the context, the first line of every
  case answer says so, and the limitations repeat it. Only the case's *location* is real, and the
  answer names the register incident it is borrowed from.
- **Blocked is not failed.** A blocked stage names its gate and reports no findings of its own. The
  context carries `blockedBy`, the prose says "BLOCKED, not failed", and a test holds it.
- **Pending is not failed.** Required, not recorded, not yet due.
- **A candidate is not a recovery.** Every candidate is `UNVERIFIED_CANDIDATE` with
  `requiresHumanReview: true`, nothing is attached, and no stage status changes because a record was
  found. The limitation says so in those words.
- **Unavailable is not empty.** A source with no endpoint reports `SOURCE_UNAVAILABLE`, distinct from
  "nothing found". Only the DataConnect connector queries real data; Office Track, MIMS and SunGuide
  answer with deterministic stand-ins, stamped synthetic.
- **No invented history.** Weather is a real Open-Meteo reanalysis value, labelled MODELLED at a grid
  cell, with the hour it was matched to. There is no historical speed, volume or congestion feed for
  this corridor, so none is reported as one and current FL511 conditions are never substituted.
  Nearby incidents are matched on the **day**, because the register records the day and not the
  minute.
- **Proximity is not association.** `CONFIRMED`, `INFERRED`, `CANDIDATE` and `UNLINKED` stay four
  different claims. Nothing classifies a nearby asset as damaged.
- **Synthetic money is not production money.** Estimated, claimed, approved, recovered and
  outstanding stay five figures; `null` is an em dash, never `$0`; and every total says it covers the
  seven demonstration cases and nothing else.

## One subject per subtab

Each subtab has its own subject, and the context says which:

| Subtab | Subject | Questions |
|---|---|---|
| Operations Overview | the corridor — **no case**, unless Case Map Focus Mode is on | `get_operations_overview` |
| Case Management | the selected case, which includes the one the queue defaulted to | per-case, plus `search_cases` for the queue |
| Claims Intelligence | the selected **claim's** case | `search_claims`, `get_claims_summary` |

This is not cosmetic. Carrying the queue's selection onto Operations Overview made "how many
incidents are linked to an asset?" look like a question about one synthetic case; carrying it onto
Claims Intelligence answered about a case the operator had left two tabs ago. A test holds the
rule that every suggested question plans at least one capability, on every subtab and every case —
without it, the four queue chips were offering questions nothing could answer, and they fell
through to the remote free-form service, which replied about the live FL511 feed.

A question about a SET is answered about the set even with a case selected, and the per-case
synthetic disclaimer is only printed when a per-case section is actually in the answer.

## The UI

The existing panel, with one addition: a compact context indicator at the top of the body —
`ACS-DEMO-005 · lighting - street light · Closed`, or `Claims Intelligence · 7 claims · none
selected`. It is a reminder of what is being investigated, not a second case dashboard.

The panel is the one this app has always had, rather than a new right-side drawer: rebuilding it as
one would be rebuilding the assistant, which the brief rules out, and it is shared with five other
screens. What the brief actually asked for is that it not cover important controls, and it does not:
while it is open, the Case Workbench and the Case Map Focus card give up the strip it occupies
(`body.ask-twin-open`), measured at 0 px overlap. Below 1100 px they take the space back and the
panel floats, as it does on every other screen.

Conversation history survives a subtab change. When the selected case changes, the next answer is
preceded by *"Now investigating ACS-DEMO-005. Everything above was about ACS-DEMO-001."* — said once,
when it changes, rather than stamped on every reply.

## Tests

`tests/caseAwareTwin.test.mjs` — 39 tests, run against the real seven cases, the real validation
engine, the real evidence connectors and the real claim model. It covers all fifteen acceptance
items that can be asserted without a browser, plus missing data, invalid identifiers, unavailable
APIs and a stale selection.

The four that need a real browser — navigating to a case on Cesium, claim → linked case, switching
cases with the assistant open, and no duplicate popup — were measured in Chrome with real clicks and
real typing. JS `.click()` is not enough here: `.maintenance-workspace` is `pointer-events: none`,
so a programmatic click would pass a control that a person could not reach.

## Remaining API dependencies

- **Office Track, MIMS, SunGuide**: no endpoint and no credentials in this deployment. They answer
  with deterministic synthetic stand-ins and report `SOURCE_UNAVAILABLE` where they cannot answer at
  all. `apiConnector` in `src/acs/evidence/connectors.js` is where a real client goes.
- **Historical traffic**: nothing connected publishes a timestamped speed, volume or congestion
  observation for this corridor. `TRAFFIC_AVAILABILITY` is the flag that changes the day one is.
- **Production claims**: no claims system is connected. `PRODUCTION_CLAIMS.available` is the flag.
- **Free-form answers** still go to `POST /api/i595/ask` for anything the deterministic layer does
  not recognise, which needs `ASK_TWIN_ANTHROPIC_SECRET_NAME` on the host.
