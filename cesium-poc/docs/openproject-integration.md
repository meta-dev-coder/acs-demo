# OpenProject Cloud — live schedule integration (Phases 8A and 8B)

The Construction Integration Demo's **second real external connection**. The first, added in Phase
7A/7C, reads cost from an SAP S/4HANA sandbox. This one reads a construction **schedule** from an
OpenProject Cloud instance, detects what changed in it between reads, and offers — but does not
apply — a link to the demo's synthetic Primavera P6 activity.

**Phase 8B** added a background worker, so the screen now updates on its own: the backend polls
OpenProject every 60 seconds, detects and records what changed, and notifies open browsers over
Server-Sent Events. §11–§17 cover it. The worker changed nothing about what this integration is
allowed to do — it is the same read-only adapter, on a timer.

Everything else in the demo remains synthetic and labelled as such. Nothing on this screen writes
to OpenProject, to SYNCHRO 4D, to P6, to SAP or to ACC.

---

## 1. Architecture and data flow

```text
OpenProject Cloud  (superdnatechnolab.openproject.com, project 3 "Construction")
        │  HTTPS GET, API v3, HAL+JSON, Basic apikey:<token>
        ▼
server/construction/openProjectHttp.mjs      hardened client: allowlisted host, timeout,
        │                                    redirect:'error', body cap, token scrub
        ▼
server/construction/openProject.mjs          adapter: pagination, normalization, relations
        │
        ├──► openProjectDuration.mjs         ISO 8601 durations, on a STATED basis
        ├──► openProjectChanges.mjs          pure diff: what changed since last read
        ├──► openProjectStore.mjs            live_schedule_* tables only
        └──► openProjectMapping.mjs          candidate link + read-only comparison
        │
        ▼
server/construction/api.mjs                  /api/construction/openproject/*
        │  same-origin JSON; the token never crosses this line
        ▼
src/construction/openProjectSchedule.js      "OpenProject Live Schedule" subtab
```

The shared, system-agnostic HTTP guarantees live in `server/construction/httpCore.mjs`, which the
SAP client also uses. That extraction was the point: two copies of "read the body, but not an
unbounded one" is how the second copy ends up missing the cap the first one has.

### Where it sits in the UI

**Construction Integration Demo → Integration Overview → OpenProject Live Schedule**
(`http://localhost:5188/?demo=construction-integration`)

Three subtabs, each a different kind of claim:

| Subtab | What it shows |
|---|---|
| Integration Overview | the five synthetic pilot interfaces (INT-01…INT-05) + SAP sandbox connectivity |
| SAP Live Cost | real S/4HANA project cost (Phase 7C) |
| **OpenProject Live Schedule** | **real OpenProject schedule (this phase)** |

The two live sources get a tab **each** rather than one "live data" tab: SAP cost and the
OpenProject schedule are unrelated systems holding unrelated records, and a single tab would invite
exactly the inference — that the cost belongs to the schedule — that neither supports.

---

## 2. API endpoints

All read-only against OpenProject. All under `/api/construction/openproject`.

| Method | Route | What it does | Calls OpenProject? |
|---|---|---|---|
| GET | `/health` | authentication + reachability, one small request | yes, 1 |
| GET | `/project` | project header | yes, 1 |
| GET | `/work-packages` | the **stored** snapshot, dated, with staleness | **no** |
| GET | `/work-packages/:id` | one activity live, with relations, candidates, link, comparison | yes, 2–3 |
| POST | `/refresh` | read now, diff, store snapshots and findings | yes, 2 + 1/page |
| GET | `/changes` | the change log | **no** |
| GET | `/links` | candidate links with their comparisons | **no** |
| POST | `/links/:id/approve` \| `/reject` | decide a candidate link | **no** |

`POST /refresh` is a POST because it **records** something locally — a read event, snapshots,
change rows. It issues no write to OpenProject.

### Why `/work-packages` does not call OpenProject

Opening a tab must not poll somebody else's server, and a reader has to be able to tell *"this is
what we last saw"* from *"this is what it says right now"*. The stored view is always dated and
carries `stale` + `staleReason`; **Refresh Schedule** is the live read.

### Routes that do not exist, deliberately

No generic proxy. There is no route that takes an OpenProject URL, path or query from the browser.
Every API path is a module constant in `openProjectConfig.mjs`; the only browser-influenced value
is a work-package id, validated as 1–9 digits before interpolation.

---

## 3. Authentication configuration

Server-side only, in the git-ignored `cesium-poc/.env.local`:

```env
OPENPROJECT_BASE_URL=https://superdnatechnolab.openproject.com
OPENPROJECT_API_TOKEN=<paste the token here>
OPENPROJECT_PROJECT_ID=3
```

**The dev server reads `.env*` once per process.** An edit while it is running has no effect —
restart it.

OpenProject API v3 uses HTTP Basic with the **literal username `apikey`** and the token as the
password. The header is built in `openProjectHttp.mjs` and nowhere else.

### Security boundaries

| Guarantee | How |
|---|---|
| No token in the browser | not `VITE_`-prefixed, so Vite cannot compile it in; asserted against the built bundle by a test |
| No token in a response | `redacted()` asserted over every payload; a body echoing the token is **discarded**, not forwarded |
| No token in a log | `scrub()` removes it from any upstream reason before it is logged or returned |
| No token to the wrong host | host allowlist + `https` only + `redirect: 'error'` |
| No unbounded body | 2 MB cap, excess **discarded** rather than truncated-and-parsed |
| No request without a token | a missing token returns `NOT_CONFIGURED` and makes **zero** requests |
| No path traversal | ids validated as digits; `_links` hrefs re-checked against the allowlist before being followed |
| No writes | every outgoing request is a GET, asserted by counting recorded requests |

The `scrub()` step was added because a test made the upstream echo the token back in its 401 body,
and the reason string — which we deliberately keep, because a screen that cannot say *why* is
useless — carried it into both the log and the browser response. It was a real leak path, not a
hypothetical one. The same fix was applied to the SAP client, which had the identical hazard.

---

## 4. Field mapping

| OpenProject (HAL) | Normalized | Note |
|---|---|---|
| `id` | `externalActivityId` | string; falls back to the id in `_links.self.href` |
| `subject` | `activityName` | |
| `_links.type.title` | `activityType` | |
| `_links.status.title` | `status` | |
| `startDate` | `plannedStart` | date-only |
| `dueDate` | `plannedFinish` | date-only |
| `percentageDone` | `reportedProgressPct` | `null` stays `null`, never 0 |
| `estimatedTime` | `estimatedTimeRaw` + `estimatedHours` | both kept; see §5 |
| `remainingTime` | `remainingTimeRaw` + `remainingHours` | both kept; see §5 |
| `duration` | `scheduledDurationDays` | OpenProject's scheduling field, **not** the work estimate |
| `lockVersion` | `sourceRevision` | optimistic-locking counter |
| `updatedAt` | `sourceUpdatedAt` | |
| `_links.parent` | `parentExternalId`, `parentName` | **only** from this link |
| relations API | `dependencies` | `null` = not known, `[]` = none |
| `description.raw` | `description` | capped at 2 000 chars |

### What is never inferred

- **Hierarchy** comes from `_links.parent`. Not from a dotted code, not from a name, not from id
  ordering. An activity named `Cast Level 2 Columns — Phase 2` with id 39, right after id 38, still
  has no parent unless OpenProject says so.
- **Dependencies** come from `/api/v3/work_packages/:id/relations`. If that read fails,
  `dependencies` is `null` — *not known* — and the screen says "Not known", because `[]` would
  claim the activity has no predecessors.
- **A work estimate is not a duration.** `estimatedTime` is an amount of work; `startDate`/`dueDate`
  are the schedule. WP 38 is 40 h of work across a 7-day window. Separate fields, separate meanings.

### Verified record (work package 38)

| Field | Value |
|---|---|
| ID / Subject | `38` / `Cast Level 2 Columns` |
| Type / Status | `Task` / `New` |
| Start / Finish | `2026-11-12` / `2026-11-18` |
| Estimated / Remaining | `P1DT16H` (40 h) / `P1DT6H` (30 h) |
| Progress | `25%` |
| `lockVersion` | `1` |
| `updatedAt` | `2026-11-10T12:08:45.431Z` |

Held in `openProjectConfig.mjs` as `EXPECTED` — a **regression expectation**, never a displayed
value. The screen always shows what the API returned just now.

---

## 5. Duration conversion rules

`P1DT16H` means 40 hours only if a `D` is worth 24. **That is a project setting, not a property of
the string.** ISO 8601 defines the nominal day as 24 h; a tool configured for an 8-hour working day
means something entirely different by the same text — 24 h, not 40 h.

So `openProjectDuration.mjs`:

1. **preserves the raw string, always.** `estimatedTimeRaw` sits beside `estimatedHours`, and the
   screen shows both: `40 h` with `P1DT16H` underneath.
2. **converts on an explicit basis and reports which.** Work converts on the **ISO 8601 nominal
   24-hour day** — which is what an ISO duration literally means — and the basis is printed beside
   every figure.
3. **refuses months and years.** `P1M` has no fixed hour count. `hours` is `null`, the raw value is
   shown, and a warning says why. A plausible conversion would be a fabricated figure.
4. **weeks are allowed** — a fixed 7 days.

### `hoursPerDay` is a display setting and must NOT be applied to work

The live instance reports:

```json
{ "durationFormat": "hours_only", "hoursPerDay": 8, "daysPerMonth": 20 }
```

An earlier version of this adapter adopted `hoursPerDay: 8` for work durations and rendered
`P1DT6H` as **14 h**. That was wrong, and the instance's own data proves it:

| Basis | `estimatedTime` `P1DT16H` | `remainingTime` `P1DT6H` | implied by 25% done | agrees? |
|---|---|---|---|---|
| **24 h/day (ISO nominal)** | **40 h** | **30 h** | 40 × 0.75 = **30 h** | **exact** |
| 8 h/day (instance setting) | 24 h | 14 h | 24 × 0.75 = 18 h | no relationship |

`hoursPerDay` governs how OpenProject **displays** the day-denominated scheduling `duration` field
(`"P5D"` on WP 38) as days and hours. **Work** is stored in hours and serialized as a plain ISO 8601
duration, in which `P1D` is 24 hours by definition. This instance also reports
`durationFormat: "hours_only"`, so it does not render work in days at all.

So work always converts on the ISO nominal day, and `hoursPerDay` is carried as **context shown on
screen** — explicitly not applied. Both the correction and the arithmetic above are held as tests,
so a future change has to face the evidence.

`corroborate()` is what caught it: it checks whether `remaining ≈ estimate × (1 − pct)` and reports
the result as an observation. When the identity does **not** hold, the three values were set
independently in OpenProject — normal, **not** an error — and **nothing is adjusted**.

An unreadable duration yields `hours: null`, never `0`. (`Number(null)` is `0` **and finite**, which
is how an unreadable value becomes a confident wrong figure.)

---

## 6. Pagination handling

- `pageSize=100`, following `_links.nextByOffset` up to `MAX_PAGES` (20).
- **`filters=[]` is always sent.** OpenProject filters the work-package collection to *open*
  statuses when no filter is given, so a completed activity would be silently absent — and absent
  is indistinguishable from deleted on a screen that does not know this.
- **`returned` and `total` are separate fields**, shown side by side as *"Activities shown"* and
  *"Collection total (reported by OpenProject)"*. They are never reconciled by truncation.
- A next-page href is re-validated against the host allowlist before being followed.

Any of these makes the result **`PARTIAL`**, with a warning naming the cause — never a short list
presented as a whole collection:

| Warning | Cause |
|---|---|
| `PAGE_FAILED` | a later page failed; the rows already read are kept |
| `PAGE_LIMIT` | `MAX_PAGES` reached |
| `UNSAFE_NEXT_LINK` | a next-page link pointed off the allowlisted instance; not followed |
| `COUNT_MISMATCH` | `total` disagrees with what arrived |
| `MISSING_ID` | a work package arrived with no readable id |
| `DURATION_UNREADABLE` | a duration could not be converted |

`PARTIAL` renders as **"Connected — incomplete"** in `warn`, never `ok`. A test asserts that.

---

## 7. Change-detection rules

`diffActivity(previous, current)` is **pure** — two records in, findings out — so every rule is
testable against a fixture.

Tracked fields: `reportedProgressPct`, `plannedStart`, `plannedFinish`, `status`,
`estimatedTimeRaw`, `remainingTimeRaw`.

| Finding | When |
|---|---|
| `NEW_ACTIVITY` | first sighting. **One** finding, no before-values |
| `PROGRESS_CHANGED` | `percentageDone` moved |
| `SCHEDULE_CHANGED` | a planned date moved |
| `STATUS_CHANGED` | status moved |
| `WORK_ESTIMATE_CHANGED` | an estimate or remaining amount moved |
| `METADATA_ONLY` | the revision moved, no tracked field did |
| `SOURCE_CONFLICT` | a tracked field moved while the revision **did not** |
| `REMOVED` | previously seen, no longer returned |
| `UNCHANGED` | nothing moved. A fact, not an event — not persisted |

### The four rules that are rules, not implementation details

1. **The first sighting is a baseline, not history.** A new activity yields exactly one
   `NEW_ACTIVITY` and no `PROGRESS_CHANGED`. *"Progress went from 0% to 25%"* on a first read is a
   sentence about our storage, not about the work, and a reader would believe work happened between
   two observations that never both existed.
2. **`lockVersion` is not a counter we may do arithmetic on.** It moves by however many edits
   happened between two polls, in any increment, and can be reset. It is compared for
   **inequality**; both values are recorded; they are never subtracted.
3. **A revision that moved with no tracked change is `METADATA_ONLY`.** Somebody edited a
   description, added a comment, changed an assignee. Reporting that as a progress change would be
   inventing a figure; reporting it as `UNCHANGED` would hide a real edit.
4. **A tracked field that moved while the revision did not is a `SOURCE_CONFLICT`.** Optimistic
   locking should make that impossible, so if we see it, one of the two is wrong and the screen says
   so rather than picking a winner. The conflict leads the finding list.

One revision can carry **several** findings, each with its own before and after. They are not
collapsed into a count. `summarize()` counts **activities**, not findings — *"3 changed"* where one
activity moved three fields would otherwise read as three activities.

### Idempotency

`UNIQUE (source_system, project_id, external_id, current_revision, kind, field)` on
`live_schedule_change`. Refreshing twice with nothing changed writes one more `live_schedule_fetch`
row — a read *did* happen — and **no** new snapshot values and **no** new change rows.

### Staleness

A failed refresh **preserves** the last snapshot and marks it `stale` with a reason naming the
failure and the date of the last good read. `lastSuccessfulFetchAt` does not move. The stored view
reports the same thing, so a page reload cannot lose the warning. Stale rows are never presented as
freshly retrieved.

A `REMOVED` activity's snapshot is **kept**: it may have been deleted, moved to another project, or
excluded by a filter, and discarding it would destroy the evidence needed to tell those apart.

### Storage, isolated by name

| Table | Holds |
|---|---|
| `live_schedule_fetch` | one row per read attempt — a **read log**, not a sync run |
| `live_schedule_snapshot` | the last thing seen, per activity; `first_seen_at` survives overwrites |
| `live_schedule_change` | one row per detected change; append-only |
| `live_schedule_link` | candidate links to synthetic P6 activities |

None of these is in `ALL_TABLES`, so `countRows()` leaves the demo's own figures unchanged and
**"Reset demo data" does not empty them** — an observation of a real external system is not
synthetic demo state, and resetting the demo must not destroy the change-detection baseline. A test
asserts both.

`live_schedule_fetch` is kept out of `sync_run` deliberately: a row in `sync_run` means records were
written into SYNCHRO 4D, and fetching a schedule writes nothing.

---

## 8. Activity mapping and approval

OpenProject `38 — Cast Level 2 Columns` and the demo's synthetic P6 `A-1020 — Cast Level 2 columns`
are **separate records**. Matching those strings is trivial, and a demo that silently merged them
would look impressive and be wrong: two systems can hold identically named activities covering
different scopes of work, and **a name is not an identifier**.

```text
OpenProject Work Package 38
           ↓
Candidate mapping          basis NAME_EXACT, score 0.9, labelled WEAK
           ↓
Synthetic P6 Activity A-1020
```

States: `UNMAPPED` → `PROPOSED` → `APPROVED` | `REJECTED` (also `CONFLICT`).

- A candidate is produced with its **evidence** at the same rank — *"A matching name is weak
  evidence: two systems can hold identically named activities covering different scopes of work."*
- Only the **strongest** candidate per activity is proposed, and only when nothing is proposed or
  decided for it yet, so a **rejected** link is not re-proposed on the next refresh — a screen
  should not argue with its own reviewer.
- `candidatesFor()` returns **every** plausible target. Choosing silently among several is what the
  existing mapping layer was built to avoid.
- Approval needs `approve:SCHEDULE_LINK`, held by **Project Planner (P6)** and **Integration
  Lead**. The role comes from the **session token**, never from the request body. The BIM
  Coordinator's read-only session is refused in the server's own words, naming who may instead.
- A decided link cannot be decided again.

### What approval unlocks: a read-only comparison

```text
OpenProject reported progress:   25%   LIVE — OpenProject Cloud
Synthetic P6 reported progress:  80%   SYNTHETIC — Primavera P6 demo data
Difference:                     −55 percentage points
```

(80% is the value actually stored for A-1020 in the seed; the live figure is whatever OpenProject
returns.)

The gate is enforced in `compare()` — in the mapping layer, not the screen — so a second caller
cannot bypass it by asking differently. `compare()` returns `null` for anything not `APPROVED`.

**No value is copied in either direction.** A test approves the link and asserts
`/progress/activities` is byte-identical before and after.

### The difference is not a finding

`COMPARISON_CAVEAT` travels with every difference, on screen, every time:

> OpenProject reports the percentage a planner typed against its own baseline; the synthetic P6
> figure is this demo's seeded planned progress against a different baseline. The difference is a
> difference between two sources, not a measurement of the work, and it is not evidence of a
> schedule slip or a defect.

An incomparable pair (either side `null`) reports *"Not comparable"*, never a difference of zero.

---

## 9. Sync History and Audit

Reads are recorded in the **existing** `audit_event` trail via `recordAudit`, with
`interface_id: null` so a live read can never be filed against one of the five pilot interfaces:

| Event | Carries |
|---|---|
| `LIVE_SCHEDULE_READ` | project, fetch id, state, collection total, counts by kind, change rows written |
| `LIVE_SCHEDULE_READ_FAILED` | project, reason, and a note that no snapshot was changed |
| `LIVE_SCHEDULE_LINK_PROPOSED` | basis and evidence |
| `LIVE_SCHEDULE_LINK_DECIDED` | before/after status, who decided, and the read-only warning |

Each `LIVE_SCHEDULE_READ` detail carries, in its own words:

> A READ of an external system. No synchronisation run was opened, no write-back was proposed, and
> no SYNCHRO 4D, P6, SAP or ACC record was created or updated.

Connectivity/read events stay distinct from inbound synchronisation and write-back. A test asserts
that a refresh opens no `sync_run`, creates no outbound proposal, leaves INT-01 reading
`NEVER_RUN`, and that **every** audit event a refresh adds is a `LIVE_SCHEDULE*` event.

---

## 10. Frontend verification steps

### Scenario A — live schedule retrieval

1. `http://localhost:5188/?demo=construction-integration`
2. **Integration Overview → OpenProject Live Schedule**
3. Confirm the chip reads **Connected** and the header names the instance, project and `API v3`
4. **Refresh Schedule**
5. Work package **#38** appears
6. Progress **25%**, remaining work **30 h** (`P1DT6H` shown beneath), source revision **1**
7. Select the row — the contextual panel shows the detail, the conversion cross-check, the
   candidate link and the change history

### Scenario B — source progress change

1. Open WP 38 in OpenProject, change progress 25% → 50%, save
2. Back in the demo: **Refresh Schedule**
3. Progress reads **50%**
4. A **Progress changed** row appears in the change history with `25 → 50` and both revisions
5. The synthetic P6 record is unchanged — check **Construction Progress**, A-1020 still reports its
   own figure

### Scenario C — mapping

1. Select #38 → **Mapping to synthetic P6**
2. Review candidate **A-1020** and its evidence
3. Choose the **Project Planner (P6)** role, then **Approve mapping**
4. The read-only comparison appears with the caveat
5. No write-back: **Approval Center** shows nothing new

### Scenario D — automatic synchronisation (Phase 8B)

See §17 for the full procedure.

---

## 11. Automatic synchronisation: architecture (Phase 8B)

```text
OpenProject Cloud
      │  GET /api/v3/projects/3/work_packages?filters=[]&pageSize=100   (Basic apikey:TOKEN)
      ▼
openProjectHttp.mjs ── allowlisted host, bounded timeout and body, redirect: 'error', scrub()
      ▼
openProject.mjs ───── normalize, walk every page, PARTIAL if short
      ▼
openProjectSync.mjs ─ THE WORKER: one timer, one lock, one process
      │                  ├── openProjectChanges.mjs   (pure diff, unchanged from 8A)
      │                  ├── openProjectStore.mjs     (one transaction: fetch + snapshots + changes)
      │                  └── openProjectMapping.mjs   (proposes candidates; never approves)
      ▼
sseHub.mjs ────────── publish { syncRunId, counts, completedAt }   ids and counts only
      ▼
browser ───────────── EventSource → re-read GET /openproject/work-packages
```

The worker **reuses** every module Phase 8A built. It is not a second integration and not a second
source of truth: the screen still reads its rows from `/openproject/work-packages`, which still
reads the same `live_schedule_snapshot` table.

### One writer, one lock

Before 8B, `POST /openproject/refresh` did its own `workPackages()` → `applyFetch()`. That would
have been a second code path writing the same tables: press **Refresh Schedule** 200 ms into a
scheduled cycle and both would walk the collection and both would write. `/refresh` now goes
**through the worker**, so there is exactly one writer and one lock. Its response shape is
unchanged — the worker hands the route the adapter result it used to hold itself.

---

## 12. Worker lifecycle

| Stage | What happens |
|---|---|
| import | nothing. No timer, no network. |
| `api.startAutoSync()` | called by the host — `vite.config.js` and `server/index.mjs`. |
| enabled? | `OPENPROJECT_AUTO_SYNC_ENABLED` must be true, or the state is `DISABLED` and no timer is armed. |
| configured? | no token or no numeric project id → `NOT_CONFIGURED`, **and still no timer**. |
| startup run | if `OPENPROJECT_SYNC_ON_STARTUP` (default true). Holds the same lock as the timer. |
| armed | one `setTimeout`, re-armed only once the previous cycle has *settled*. |
| `api.close()` | clears the timer, `await`s the cycle in flight, hangs up the subscribers, closes the file. |

### States

`DISABLED` · `NOT_CONFIGURED` · `IDLE` · `SYNCING` · `AUTH_PARKED` · `STOPPED`

`AUTH_PARKED` is the one worth knowing about: OpenProject rejected the token, so the worker **stops
polling** and says why. A credential that was rejected will be rejected again, and a client that
keeps trying every 60 seconds is indistinguishable from a brute-force attempt. **Sync Now** still
works, which is how you confirm a fix without a restart.

### Why `setTimeout` and not `setInterval`

A one-shot timer re-armed after the previous cycle settles **cannot queue a tick behind a running
cycle**. An interval fires on the clock regardless, and the lock would then be doing all the work.
A slow cycle therefore delays the next one rather than racing it — and the startup run and the
first scheduled tick cannot overlap for the same reason, with no separate guard.

### No duplicate workers

The worker is a **process-wide singleton**, registered on `globalThis` under
`Symbol.for('i595.construction.openProjectSyncWorkers')`. A module-level variable would be per
module *instance*, and Vite re-evaluates the module graph when its config changes — which would arm
a second timer against the same rate-limited cloud instance. `globalThis` is per *process*, which
is the scope the uniqueness claim is actually about.

---

## 13. Polling configuration

```ini
# cesium-poc/.env.local — server-side only. Never VITE_-prefixed: a VITE_ variable is compiled
# into the public browser bundle.
OPENPROJECT_AUTO_SYNC_ENABLED=true
OPENPROJECT_SYNC_INTERVAL_SECONDS=60
OPENPROJECT_SYNC_ON_STARTUP=true
```

Read through the existing `server/loadEnv.mjs`, so precedence is shell → `.env.local` → `.env`, and
**a restart is what picks up a change**.

- **Default off.** An integration that starts talking to somebody's cloud instance on `npm start`
  because a file was present is not a default anybody chose.
- **The interval is clamped to 15–86 400 s**, and a clamp is *reported* on screen rather than
  silently honoured. The floor exists because OpenProject Cloud is shared and rate-limited, and a
  one-second interval set by a typo is indistinguishable from an attack on it.
- **A nonsense value falls back to 60**, never to zero.

### Failure and retry behaviour

Retries are **on the schedule, not inside a cycle**. A cycle already walks the collection once with
its own bounded timeouts; retrying inside it would stack minutes of HTTP into a 60-second slot.

| Outcome | Next attempt |
|---|---|
| `SUCCESS` / `PARTIAL` | one interval |
| transient failure (5xx, timeout, network) | 1× → 2× → 4× → 8× → 15× the interval, then plateaus |
| HTTP 429 | whatever `Retry-After` asked for (capped at 900 s), never less than one interval |
| 401 / 403 | **never.** The worker parks — see `AUTH_PARKED` above. |

A failed cycle **keeps the previous snapshot**, writes a `FAILED` run, and the read endpoint then
marks the rows stale because the newest run is no longer the newest *successful* one.

### Turning it off

Set `OPENPROJECT_AUTO_SYNC_ENABLED=false` (or remove it) and restart. The screen then reports
**Auto-sync: Off** as a configured choice, not a failure, and **Refresh Schedule** and **Sync Now**
still read OpenProject on request.

---

## 14. Persistence

**No new table.** The existing `live_schedule_fetch` gained five columns, because a run and a read
are the same event here — one cycle makes one HTTP walk and writes one row, so a parallel
`live_schedule_run` table would have been a 1:1 join and a second place for the counts to disagree.

| Column | Holds |
|---|---|
| `run_id` | a uuid, so an SSE notification can be correlated without guessing from timestamps |
| `trigger` | `STARTUP` / `SCHEDULED` / `MANUAL` |
| `run_status` | `SUCCESS` / `PARTIAL` / `FAILED` / `SKIPPED` |
| `started_at`, `finished_at` | the whole-cycle bracket, which is *not* `elapsed_ms` (time in HTTP) |

`SCHEMA_VERSION` is 7, and `openConstructionDb` now runs an **additive migration**: `SCHEMA` is all
`CREATE TABLE IF NOT EXISTS`, which builds a correct database from nothing and does nothing to one
that already exists. The migration only ever *adds* a column — nothing is dropped, renamed or
retyped — because these rows are the record of what a real external system reported.

> The `run_id` index is created **after** the `ALTER TABLE`s, not in `SCHEMA`. A `CREATE INDEX`
> naming a column that is not there yet fails the whole `exec`, which took the database — and with
> it the entire Construction demo — down on every existing checkout. Found by running the migration
> against a copy of the real `.data` file rather than a fresh one.

### `run_status` vs `state`

Two vocabularies on purpose. `state` answers *what happened on the wire* and is the adapter's to
define. `run_status` answers *what became of this cycle*, and has one value the wire cannot produce:
**`SKIPPED`**, a cycle that never asked because another was still running.

`lastFetch()` **excludes `SKIPPED` rows**, and that exclusion is the whole correctness of the stale
banner: a skip reached no wire, so counting one as "the last fetch" would both put the word
`SKIPPED` where the screen expects a connection state and mark perfectly current data as stale
because a tick coalesced.

### Transactions and idempotency

A cycle's fetch row, snapshot upserts and change rows are written in **one transaction**
(`BEGIN IMMEDIATE`). They are one fact about one cycle: a snapshot that advanced to revision 4 with
no change row explaining how is a record that has lost its own history, and a change row pointing
at a rolled-back fetch id is a dangling reference. It also makes the cycle atomic against a
concurrent reader — a screen loading `/work-packages` sees the state before the run or after it,
never a half-applied one.

Idempotency is unchanged from 8A: `UNIQUE (external_id, current_revision, kind, field)` on
`live_schedule_change`. Four identical cycles write four `SUCCESS` runs — a read *did* happen each
time — and **no** new change rows.

A **PARTIAL** cycle upserts only the activities it actually received and **infers no deletion**;
`REMOVED` is reported only after a `CONNECTED`, explicitly-scoped, complete retrieval, and even then
the snapshot is kept, because deleted / moved / filtered-out are not yet distinguishable.

---

## 15. Frontend update mechanism

**Server-Sent Events**, not a WebSocket: the traffic is one-directional and tiny, SSE is a normal
HTTP response that is never ended (so it passes through Vite's `connect` middleware and
`server/index.mjs` unchanged), and every browser reconnects on its own with backoff.

```text
GET /api/construction/openproject/events     text/event-stream

event: openproject-sync-completed
data: {"event":"openproject-sync-completed","source":"OPENPROJECT","projectId":3,
data: "syncRunId":"f7b54d8b-…","trigger":"SCHEDULED","runStatus":"SUCCESS",
data: "changedActivities":1,"newActivities":0,"unchangedActivities":0,
data: "totalActivities":1,"completedAt":"2026-11-11T03:52:03.118Z"}
```

**Ids and counts only.** No work-package payload and, self-evidently, no token. On an event the
panel re-reads `/openproject/work-packages` — the one endpoint that normalizes and dates this data
— so there is a single source of truth and a dropped event costs a reader one interval, not a wrong
screen.

The hub caps subscribers (50), sends a `: keep-alive` comment every 25 s (under the 30 s a proxy
typically uses to reap an idle connection), sets `x-accel-buffering: no` (nginx buffers a proxied
response by default, which holds every event until the buffer fills), and removes a socket on both
`close` and `error`.

### What the panel preserves across a background update

The panel renders by assigning `innerHTML`, which is fine for a click and wrong for an update
nobody asked for. Captured before the swap and restored after: **page scroll**, the activity
table's **horizontal scroll**, and the **open/closed state** of the query-parameters disclosure.
The **selected activity** survives because it is state rather than markup, and its detail pane is
reloaded in the background — it keeps showing the activity it has rather than blanking to
"Reading work package #38…" every 60 seconds.

No modal is opened, no focus is stolen, and nothing here touches Cesium, so a background cycle
cannot move a camera.

### The fallback, and why there is one anyway

A 10-second poll of **`GET /sync/status`** keeps "next sync in 24 s" honest. It makes **no**
OpenProject request — it reads in-process state and the stored history — so it is cheap, and it
doubles as the catch-up path: if the server's last successful sync differs from the one this tab has
applied, the tab reloads. That covers a backgrounded tab or a proxy that dropped the stream before
the browser reconnected, without a second poller and **without the browser ever calling OpenProject**.

---

## 16. Control endpoints and security

| Route | Does |
|---|---|
| `GET /api/construction/openproject/sync/status` | worker state, interval, next run, last run, recent history. **Makes no upstream request.** |
| `POST /api/construction/openproject/sync/run` | Sync Now. Same worker, same lock. Needs a demo session. |
| `GET /api/construction/openproject/sync/history` | every run, newest first, `SKIPPED` included |
| `GET /api/construction/openproject/events` | the SSE stream |

- **No endpoint accepts an upstream URL, host, path or credential.** The host stays allowlisted and
  every API path is a module constant; the only thing a browser can influence is a numeric id.
- **Sync Now is gated** on a demo session holding `monitor`, and the role comes from the
  server-issued token, never from the request body. Worth being plain about what that is and is
  not: `issueSession` authenticates nobody, so this stops an honest screen from triggering outbound
  reads without a chosen role and stops nothing else.
- **What actually bounds the outbound rate** is the worker's lock plus a 3-second floor between
  consecutive manual runs. The lock makes concurrent runs impossible; it says nothing about
  consecutive ones, and a held-down button would otherwise walk the collection several times a
  second. A throttled click is **not** recorded — nothing happened, and a history full of
  double-clicks buries the runs that mattered.
- **A second press while a run is going JOINS it** and says so (`coalesced: true`), rather than
  returning an error. A *scheduled* tick that arrives mid-run records a `SKIPPED` row and goes back
  to sleep — recorded rather than silent, because when a 60-second poller has produced 40 runs in
  an hour those rows are the explanation.
- The token is read per call, never returned, never logged, and `scrub()` runs over every upstream
  reason before it is stored or shown — so a 401 body that quotes the credential back at us cannot
  get it into the log, the database or the browser.
- **No frontend file names the credential variable.** The sentences about a missing token come from
  the *server* (`configuredReason`, `enableHint`), because a frontend file that names the
  credential variable is one careless edit from holding it. A test fails if one does.

### Integration boundaries

An automatic cycle writes `live_schedule_*` and one `audit_event`, and nothing else. Tests assert
that after a cycle in which the live figure moved, `src_p6_activity`, `activity`, `cost`,
`sync_run`, `outbound_proposal`, `p6_update_draft` and `progress_observation` are **byte-identical**.
It can *propose* a mapping candidate; it can never approve one, so it cannot cause a comparison, let
alone a write.

The three figures stay distinct, and the screen says so on every row:

1. **OpenProject source progress** — a percentage a planner typed, live.
2. **Synthetic P6 planned/reported progress** — this demo's seeded data.
3. **Independently verified physical progress** — a measured observation.

---

## 17. Verification: the 60-second loop

```bash
cd cesium-poc
# .env.local: OPENPROJECT_AUTO_SYNC_ENABLED=true, OPENPROJECT_SYNC_INTERVAL_SECONDS=60
npm run dev
```

The log says, at startup:

```text
[openproject-sync] automatic synchronisation on: every 60 s, starting now
[openproject-sync] STARTUP run <uuid> SUCCESS: 1 read, 0 new, 0 changed, 1 unchanged
```

1. `http://localhost:5188/?demo=construction-integration`
2. **Integration Overview → OpenProject Live Schedule**
3. The status row reads **Auto-sync: On · Every 60 s**, with a **Next scheduled sync** counting down
4. Confirm **#38** is listed at **25%**
5. In OpenProject Cloud, change #38's progress to **50%** and save
6. **Do not press Refresh Schedule.** Wait for the next scheduled sync
7. The table updates to **50%** by itself; the note says `0 new · 1 changed`
8. The change history shows **Progress changed**, `25 → 50`, with both actual revisions
9. **Construction Progress** → the synthetic P6 activity is unchanged
10. `GET /api/construction/openproject/sync/history` shows the `SCHEDULED` run with its counts
11. Restart the server: the log prints **one** `automatic synchronisation on` line, and
    `sync/status` reports one worker

### Expected latency

One polling interval plus the walk plus the notification — about 60–62 s with the instance
reachable. A change saved 5 seconds before a tick appears almost at once; one saved 5 seconds after
takes nearly a full interval.

---

## 18. Known limitations

- **The synthetic P6 integration is unchanged and still synthetic.** INT-01…INT-05 read and write
  the mock `src_*` tables. OpenProject is a *separately identified* live source; no value flows
  between them. Phase 8A deliberately does not replace INT-01.
- **One project.** `OPENPROJECT_PROJECT_ID=3`. There is no multi-project view.
- **Change detection is poll-based.** It compares against the last stored snapshot, so an edit made
  and reverted between two refreshes is invisible, and the sequence of intermediate states is not
  recoverable. OpenProject's own activity journal would be needed for that, and is not read.
- **`METADATA_ONLY` cannot say *what* changed.** We track six business fields; anything else —
  description, assignee, comments, custom fields — registers only as a revision move.
- **The work-conversion basis rests on one activity's arithmetic.** The ISO nominal 24-hour day is
  correct by definition for an ISO 8601 duration, and WP 38's estimate/remaining/percentage
  reconcile exactly under it and not at all under the instance's `hoursPerDay: 8` (§5). That is
  strong evidence, but it is still one activity. If OpenProject ever serialized work against a
  working day, the corroboration check would start disagreeing across the board — which is the
  signal to look again, and is why the check is shown on screen rather than hidden.
- **The name match is weak evidence by construction.** It is the only automatic basis offered. A
  real deployment would key on an external id, a shared WBS code, or an explicit field — none of
  which exists in either dataset here.
- **The role gate is demo authorization, not authentication.** Sessions are issued on request with
  no credential check, exactly as `DEMO_AUTH` says. It demonstrates separation of duties; it does
  not enforce it against a determined user.
- **This is still not construction measurement.** OpenProject reports a percentage a planner typed.
  No quantity, unit, BOQ item or verified observation backs it. The demo's own distinction between
  *planned* and *verified* progress applies: a typed percentage is the former.
- **`/api/v3/workspaces/3/work_packages`, given in the brief, is not a route.** `workspaces` is not
  part of OpenProject API v3 and answers 404. The correct segment is `projects`, which is what the
  adapter uses and what a test asserts.

### Added by Phase 8B

- **SINGLE-PROCESS SCHEDULING. This is the important one.** The worker is a per-process singleton
  with an **in-memory** lock. That is correct for one backend and is *not* distributed scheduling:
  two backend instances against this database would each arm a timer and each write. Nothing
  coordinates them, and the lock does not exist outside a process. The status endpoint says so in
  its own `scheduling` field rather than leaving a reader to assume otherwise.

  Before enabling the worker on more than one instance, a **database-backed lease** is needed —
  roughly: a `live_schedule_lease` row holding an owner id and an expiry, acquired with a
  conditional `UPDATE … WHERE expires_at < now()` inside the existing transaction, renewed each
  cycle, and checked again before the writes commit. A tick that does not hold the lease records
  `SKIPPED` and sleeps. That is deliberately **not** implemented, and no claim is made that it is.
- **Polling, not subscription.** OpenProject has no webhook configured here, so the worker compares
  snapshots. An edit made and reverted inside one interval is invisible, and the intermediate states
  are not recoverable. Shortening the interval narrows the window; it does not close it.
- **The worker runs regardless of what the browser is showing.** Phase 8A stated that OpenProject is
  not called while viewing the I-595 project — that remains true of the *frontend*, which never
  holds a credential and never calls OpenProject. But a background worker is by definition not tied
  to a tab, so with auto-sync on the backend polls whether anybody is looking at the Construction
  demo, at I-595, or at nothing. That is what "continue running independently of browser sessions"
  requires, and it is a real change in behaviour: `OPENPROJECT_AUTO_SYNC_ENABLED=false` is the way
  to have the Phase 8A behaviour back.
- **`AUTH_PARKED` needs a human.** A rejected token stops automatic polling until somebody fixes it
  and either restarts or presses **Sync Now**. That is the intended behaviour, not an oversight —
  but it does mean a token that expires overnight leaves the screen stale until morning, correctly
  marked stale and with the reason on it.
- **A deletion is still only ever *reported*, never applied.** `REMOVED` requires a complete,
  explicitly-scoped retrieval, and the snapshot is kept even then, because source deletion is not
  yet distinguishable from a permission change at the far end.
- **Sync Now's access control is demo authorization.** Same caveat as the role gate above: it binds
  the action to a server-issued session rather than a request body, and anyone who can reach the
  API can still mint a session. The real bound on outbound traffic is the lock and the throttle.
