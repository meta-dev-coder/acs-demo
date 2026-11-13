# Intelligent Evidence Recovery and Incident Context

Two capabilities added to the seven [ACS demo cases](./acs-demo-cases.md). Neither replaces
anything: the KPI card, the slider, the ACS case popup, the validation engines and the case file
are the ones that were already there.

1. **Evidence Recovery** — when validation finds a gap, search the connected systems for the
   record that would close it, rank what comes back, let a reviewer accept or reject, and validate
   again.
2. **Incident Context** — what the weather and the road were like at the moment the incident
   happened.

## What is real

| | Real | Synthetic |
|---|---|---|
| Weather at the incident hour | ✔ Open-Meteo historical, via the existing service | |
| DataConnect record search | ✔ queries the records the app has loaded | |
| Lane closure / injuries / fatalities | ✔ the source incident's own register row | |
| Segment AADT and its year | ✔ FDOT road network | |
| Office Track / MIMS / SunGuide responses | | ✔ no endpoint exists; stand-ins, stamped |
| Speed, congestion, throughput | | ✔ no feed exists; labelled on every value |

### Why the traffic is synthetic

Checked before writing any of it, and the answer is in the code rather than in an assumption:

- `i595RoadSegmentLayer.js` keeps a `segmentStatus` map that is **deliberately empty** —
  *"Intentionally empty: no fabricated traffic observations."*
- `corridorStatusBar.js` omits speed, travel time and congestion and states the corridor *"has no
  traffic-condition feed connected."*
- FL511 publishes **current** events only. Nothing in it is a timestamped past observation.
- **SunGuide has no integration in this repository** — only prose references to one.
- The DataConnect incident register carries no speed, volume or occupancy column.

So there is no historical traffic for this corridor. `TRAFFIC_AVAILABILITY` states that as data, a
test holds it, and the panel prints it above every synthetic value.

## Files

| File | What it is |
|---|---|
| `src/acs/evidence/connectors.js` | the connector interface and four adapters |
| `src/acs/evidence/matching.js` | the configurable match rules and the scorer |
| `src/acs/evidence/orchestrator.js` | the Case Enrichment Orchestrator |
| `src/acs/evidence/auditLog.js` | the append-only session log |
| `src/acs/incidentContext.js` | the Incident Context Enrichment service |
| `src/assetExplorer/DemoEvidenceTabs.jsx` | the two new tabs and their hooks |
| `tests/acsEvidenceRecovery.test.mjs` | 48 tests |

Modified: `public/data/acs-demo-cases.json` (an `evidenceRecovery` block per case),
`src/acs/acsDemoCases.js` (the attachment overlay and the outlook), `src/qcqa/schema.js` already
carried `PENDING`/`BLOCKED`, `AcsCaseDialog.jsx` (two sections), `AcsDemoCasePanel.jsx`,
`assetTypes.js`, `maintenanceWorkspace.js`.

## Reused, not rebuilt

- `weather/historicalWeather.js` — the historical Open-Meteo service the TMC already uses, with its
  nearest-hour rounding, corridor timezone and declared units. Unchanged.
- `qcqa/stageValidation.js` and `qcqa/validationEngine.js` — re-validation after attachment runs
  the same engines as the first pass.
- `qcqa/providers/provider.js` — the connector interface is modelled on it, including the inert
  `apiConnector` that refuses rather than returning an empty result.
- The maintenance record store, the KPI strip, the slider, the asset type registry and the case
  popup.

## The connectors

| System | Status here | Behaviour |
|---|---|---|
| DataConnect | **real** | searches loaded work orders, tickets, tasks, inspections and incidents by identifier only |
| Office Track | no endpoint | deterministic stand-in, `origin: SYNTHETIC`, every record stamped |
| MIMS | no endpoint | same |
| SunGuide | no integration at all | same |

`createDemoConnectors({ clients })` swaps any stand-in for a real adapter the day endpoints exist;
nothing above the connector changes. Without a client, `apiConnector` returns `UNAVAILABLE` with
*"this is not a report that the system holds nothing"* — because an empty result and an unasked
question are different answers.

## Matching

Rules are data (`MATCH_RULES`), each with a weight and a flag for whether it is an identifier.

| Rule | Weight | Identifier |
|---|---|---|
| Incident ID | 45 | ✔ |
| Work order ID | 40 | ✔ |
| Asset ID | 30 | ✔ |
| Location ≤ 50 m / ≤ 150 m | 15 / 8 | |
| Within 2 h / 12 h | 12 / 6 | |
| Same carriageway | 5 | |

**Only an identifier reaches `EXACT`.** Rules in a group are mutually exclusive, so the most a
purely circumstantial candidate can score is 32 — below the `PROBABLE` threshold of 40. A test
asserts that ceiling, so raising a weight cannot quietly erode the guarantee that "same place,
same minute" is never presented as a strong match. Confidence is capped at 99%: nothing is certain.

A reviewer is required when the leading candidate is not an exact match, when two candidates match
on an identifier, when any candidate in the group contradicts another, or when the leader carries a
warning. Warnings cover timestamp mismatch, location mismatch, asset mismatch and conflicting
evidence — and the time and distance warnings are suppressed when an identifier matched, because a
repair filed three days after the crash it answers is normal.

## Safety rules, enforced in the orchestrator

- **Only a `MISSING` field is ever searched for.** `PENDING` is not due yet; `BLOCKED` cannot exist.
- **A `FAIL` is never touched.** A recorded value that failed its rule stays failed however many
  documents turn up. ACS-DEMO-003's two failed spacing measurements survive full recovery.
- **Human-only fields can never be filled.** Technician sign-offs and QC/QA approvals are declared
  `notRecoverable` with a reason; accepting a record for one is refused and logged.
- **Nothing is attached without an explicit decision.** Unambiguous exact matches are *pre-ticked*,
  which is a proposal, not an attachment. Apply is the only thing that changes a case.
- **The original record is never overwritten.** Accepted evidence is an overlay; a field that
  already has a value keeps it, and the case object is frozen.
- **Recovered files become `NEEDS_VERIFICATION`, never `PASS`** — finding a document is not the
  same as checking it is the right one.
- **No claim is submitted and no repair approved.** ACS-DEMO-007 is marked `READY_FOR_REVIEW` only.

Every retrieval attempt, source response, proposed match, reviewer decision, attachment, policy
refusal and validation change is appended to the session audit log, shown in the Audit Trail tab as
a second list kept apart from the case's own history.

## The seven outcomes

| Case | Missing | Recovered | Outcome |
|---|---|---|---|
| 001 | 4 | 2 | SunGuide does not answer; cartridge count unresolved; inspector confirmation is human-only. Conflicting photo set forces review. Stays `BLOCKED_AT_INSPECTION`. |
| 002 | 4 | 3 | Materials, certificates and photographs recovered on the work order id. Technician sign-off human-only → stays `BLOCKED_AT_REPAIR`. |
| 003 | 4 | 2 | Both certificates of analysis recovered → `NEEDS_VERIFICATION`. Two failed spacing measurements preserved → stays `REWORK_REQUIRED`. |
| 004 | 2 | 1 | Third-party details found in SunGuide, circumstantial (32%, needs review). The $2,450 discrepancy is a failed reconciliation no document closes → `CLAIM_ACTION_REQUIRED`. |
| 005 | 0 | — | Nothing missing. Six lineage entries show where each held document came from. |
| 006 | 0 | — | Nothing missing (records are pending). Three related maintenance records enrich the active repair. |
| 007 | 0 | — | Three claim-supporting records gathered; package marked `READY_FOR_REVIEW`, never submitted. |

No case's overall status improves through recovery. That is the point: in every one, what is
actually holding the case is not a missing document.

## Incident context

Every value carries `source`, `observedAt`, `spatialMatch`, `unit`, `quality` and `synthetic`.

- **Weather** — real, from Open-Meteo's historical-forecast endpoint at the incident's coordinate
  and nearest hour, in the corridor's timezone. Quality is `MODELLED` with `GRID_CELL` spatial
  match, because it is reanalysis and not a roadside sensor. The hour actually matched is stated
  when it differs from the hour asked for. A missing reading is reported, never substituted.
- **Traffic** — speed, congestion band and throughput are `SYNTHETIC`, derived from the incident's
  corridor-local hour (two peaks, a quiet night) plus a per-case constant, so they are coherent
  with the timestamp and identical on every run. Deliberately **not** a function of incident
  severity, which would be circular.
- **Recorded at the scene** — the source incident's real lane-closure, injury and fatality flags,
  and the segment's published AADT with its year, marked `PUBLISHED_AVERAGE` so it is not read as
  the traffic that evening.
- **Implications** are drawn only from readings that exist, each naming the reading it came from,
  and none of them claims the weather caused anything.

## Indicators

- **KPI card** — `4 blocked/failed · 2 pending · 1 closed · 14 missing evidence, 8 recoverable`,
  all counted from the data; the tooltip adds the unresolved count and how many cases have context.
- **Slider card** — the existing status line carries the indicator:
  `Blocked at inspection · 4 missing, 2 recoverable`. No extra card height.
- **Details panel** — a four-tile Evidence block (missing / recoverable / unresolved / related) and
  a context-availability dot.
- **Filters** — three new chips: missing evidence, recoverable, unresolved.

The counts come from `recoveryOutlook`, which reads the same data the synthetic connectors answer
from and is computed synchronously so the strip never waits on a search. A test asserts it agrees
with what the search actually finds for all seven cases.

## Remaining integration dependencies

To make this real rather than demonstrated, in order of how much each unlocks:

1. **Office Track, MIMS and SunGuide endpoints and credentials.** Each needs one adapter
   implementing `search()`; `apiConnector` is the stub and refuses until given a client.
2. **A field-level identifier in those systems** that a maintenance record also holds. Without one,
   every match stays circumstantial and every gap needs a reviewer — which is correct, and slow.
3. **A historical traffic feed** (archived SunGuide detector data, or any timestamped speed/volume
   store). The moment `segmentStatus` is populated the synthetic block can be replaced; nothing
   else changes.
4. **An identity service**, so a reviewer decision is attributed to a person rather than to
   "Demo reviewer (this session)".
5. **A durable audit store.** The log is in-memory and per session, deliberately, because these are
   demonstration actions.
