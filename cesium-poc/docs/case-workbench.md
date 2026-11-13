# The Case Workbench

Case Management, redesigned as one screen: a queue on the left, one case on the right.

Nothing was rebuilt. The seven cases, the validation engine, the Case Enrichment Orchestrator, the
historical weather service, the claim records, the audit trails and the single Cesium viewer are
all the ones that were already there. What changed is how many places say the same thing.

## The duplication it removed

Before, one case was drawn by four surfaces at once, and the modal repeated itself across eight
tabs:

| Fact | Was rendered in | Now rendered in |
|---|---|---|
| Case ID, incident, asset | slider card, details panel, modal header, modal Overview, cases list | workbench header |
| Overall status | slider card, details panel chip, modal Overview, queue row aside | header (queue row carries the label only) |
| Four-stage lifecycle | details panel StageTrack, modal stage strip, modal Overview | header strip, once |
| Next required action | details panel, modal Overview, cases list note | Action Required, once |
| Missing evidence counts | KPI card note, slider status, details panel tiles, modal Evidence tab | beside the field that is missing |
| Weather and traffic | modal Incident Context tab | Incident Context section |
| Claim amounts | modal Claim tab | Claim & Financial Summary |
| Audit trail | modal Audit tab | Activity History, collapsed |

**Removed from the visible Case Management layout:** the bottom incident slider, the floating
`AcsDemoCasePanel`, the `AcsCaseDialog` modal, the Demo Case Validation KPI card, the side analysis
panel, and `casesPanel()` in `assetOpsPanels.js` (deleted — nothing drew it any more).

All of them except `casesPanel()` still exist and still work. They are what Operations Overview,
search and every other workflow use; they are simply not what Case Management opens.

## Structure

```
Asset Operations & Maintenance
└── Case Management                         ← workbench-first; the other two subtabs stay map-first
    ├── Case queue            ~30%          search · All/Needs action/In progress/Closed ·
    │                                       incident type · asset type · blocking stage · severity ·
    │                                       reported-date range
    │                                       row: id · status · asset type · segment & corridor mile ·
    │                                            blocking stage · last activity
    └── Case workbench        ~70%
        ├── Header            id · summary · location · status · blocking stage · View on map ·
        │                     Inspection → Repair → QC/QA → Claim
        ├── Action required   what failed · why it matters · assigned to · failed checks ·
        │                     open non-conformances · evidence required
        ├── Validation & evidence   one expandable stage per lifecycle step; the failed or active
        │                           stage opens, the rest stay shut; recovered evidence sits beside
        │                           the field it would fill
        ├── Incident context  weather (real) and traffic (synthetic), with source and quality
        ├── Claim & financial summary   amounts, missing documents, link to Claims Intelligence
        └── Activity history  the audit trail, collapsed
```

Below 1040px the two columns stack, queue above case.

## Files

| File | What it is |
|---|---|
| `src/maintenance/caseWorkbenchModel.js` | queue rows, filters, header, action required, the timeline and which stages open |
| `src/maintenance/caseWorkbench.js` | the view, its two asynchronous reads and its events |
| `tests/caseWorkbench.test.mjs` | 23 tests, run against the real seven cases through the real engine |

Modified: `maintenanceWorkspace.js` (shows the workbench on the Case Management subtab and stands
the map surfaces down), `assetOpsPanels.js` (`casesPanel` removed), `claimsIntelligence.js` (a null
amount), `i595Demo.css`.

## Reused, not rebuilt

- `qcqa/stageValidation.js` and `validationEngine.js` — every status, finding and message.
- `acs/acsDemoCases.js` — `evaluateDemoCase`, `explainDemoCase` and `nextActionFor`. The Action
  Required section is assembled from those; there is no per-case prose anywhere in the workbench,
  and the seven outcomes the brief lists all fall out of the engine. A test asserts each one.
- `acs/evidence/orchestrator.js` + `connectors.js` — the same search the old Evidence Recovery tab
  ran, now rendered beside the field it is about.
- `acs/incidentContext.js` and `weather/historicalWeather.js` — unchanged.
- `claimsIntelligence.js` — the claim record for the case.
- `corridorPosition.js` — the derived corridor mile, labelled derived.
- The single Cesium viewer, the Asset Explorer, the record store and the map layer.

## Single-source-of-presentation

Enforced by the model rather than by memory. `queueRow()` returns six display fields and no
lifecycle; `headerOf()` owns the identity, location, status and the stage strip; `actionRequiredOf()`
owns the next step. A test asserts that a queue row carries no `nextAction`, `statuses`, `stages` or
description, and that the search cannot match the incident description because the row does not hold
it.

## What the workbench does not do

- **No save, approve, submit or apply.** The old Evidence Recovery tab let a reviewer accept a
  candidate and re-run validation; the workbench shows what the search found and stops there. A
  recovered record is reported as a prospect beside the field — "Record found in another system",
  "needs a reviewer", "cannot be recovered: a person must record it" — and no case status changes.
  There is no production system to write to, and inventing an Apply that changes a demonstration
  record would be a fake action.
- **Nothing is written anywhere**, and demo data stays out of every production figure.

## View on map, and Case Map Focus Mode

### The bug this replaced

"View on map" used to select the case's source incident in the Asset Explorer, which opened the
**incident's** own details card. That card was correct about the incident and wrong about the case:
ACS-DEMO-002 is a synthetic **highway lighting pole** case that reuses the coordinates of
INC-200133, a real **guardrail strike**. The screen therefore showed a guardrail strike as though
it were the selected case.

Traced end to end, the case id, the source incident id and the coordinates were all correct, and
the camera flew to the right place. Nothing was stale and no id collided. The fault was entirely
presentational: a real incident was being shown in place of the synthetic case that borrows its
location. A second, latent fault sat behind it — the Operations Overview restores its own last
selection when the tab is re-entered, which could race the case's own reveal.

### What it does now

"View on map" enters **Case Map Focus Mode**, a state of the existing Operations Overview. Not a
screen, not a second viewer:

- The map keeps its viewer, its imagery and its navigation.
- Every class is drawn with one record: the source incident. Nothing else is on the corridor.
- The marker is **ringed, not selected** (`maintenanceLayer.highlight`), so the Asset Explorer
  never opens a card for it.
- The KPI strip, the analysis panel, the bottom browser and the floating details panel all stand
  down.
- One card is on screen, and it is the case's: id, asset type, workflow status, the current action
  required, where it is with its derived corridor mile, and the source incident with **its own
  type and date** and a sentence saying the two are different records.
- The camera is framed exactly as the Asset Explorer frames an incident — the same preset, range,
  pitch and ground height.
- **No coordinates means no flight.** The card states the reason instead of the camera moving
  somewhere arbitrary.

Leaving focus mode — by Return to Case, by another subtab, or by opening any class on the map —
redraws the overview. No production filter or dataset is touched on the way in or out; only which
records the layer is drawing.

### Return to Case

Restores the case, the stages the reader had open, both scroll positions, and the queue's own
bucket filter and search text. It never resets to the first case. The workbench exposes
`snapshot()` / `restore()` for this, and the same memory is what stops an arriving evidence search
from closing a stage the reader just opened.

## Refinements

- The failed or active stage opens; completed and blocked stages stay shut but are one click away
  from their header tile, which carries its own counts.
- **Blocked is drawn differently from failed.** A blocked stage has no findings and nothing wrong
  with it — an earlier stage does. Its tile reads "held by inspection" rather than
  "0 failed · 0 missing · 0 passed", and it is dashed and muted rather than red.
- The evidence tally sits compactly beside the Validation & evidence heading
  (`4 missing · 3 recoverable · 1 need review`).

## Remaining limitations

1. **No reviewer actions.** See above; the orchestrator's `apply()` exists and is tested, but no
   surface calls it any more.
2. **Severity stands in for priority.** The cases carry no priority field, so the queue filters on
   the incident's recorded severity and calls it that.
3. **Traffic in Incident Context is synthetic**, as everywhere else — no timestamped feed exists
   for this corridor.
4. **The corridor mile is derived** from the centerline, not an FDOT milepost, and says so.

## One detail surface at a time

Four components can present a primary record: the Case Workbench, the Claims Workbench, the Case
Map Focus card and the Asset Explorer (its bottom browser and floating details card are one
surface). Before this they could all be on screen together.

**The bug.** Choosing a claim in Claims Intelligence called `chooseTab('cases')`, then
`openType(demo cases)`, then `selectFromMap(...)` — three owners of "show this case", in sequence.
`chooseTab` showed the workbench and cleared the explorer; the two calls after it re-opened the
explorer on top. Reproduced before fixing: one click produced the Case Workbench, the floating
`AcsDemoCasePanel` and the bottom browser at once. That handler was written before the workbench
existed and was never re-pointed at it.

**The fix** is one discriminated value in the workspace rather than three booleans:

```js
activeDetail = null | { type: 'incident' | 'case' | 'claim' | 'caseOnMap', id, origin }
```

with selection and presentation kept apart:

| Action | What it does |
|---|---|
| `selectRecord(type, id)` | records the choice; puts nothing on screen |
| `openDetail(type, id, {origin})` | closes whatever owns the screen, then opens the one surface that owns `type` |
| `closeDetail()` | takes the surface down, keeps the ids |
| `focusOnMap(record)` | `closeDetail()` then Case Map Focus Mode |
| `exitCaseFocus({toCase})` | leaves focus, optionally returning to the case |

`DETAIL_TAB` names the one owner per record type — incident → Operations Overview (the Asset
Explorer), case → Case Management, claim → Claims Intelligence — and a tab change drops any surface
that does not belong to the new tab while keeping every selected id. A map pick or an explorer card
is a legitimate owner too, so the store subscription records it rather than letting the state drift
from the screen.

No `setTimeout` is involved anywhere, and no z-index or CSS hiding was used to resolve it.
