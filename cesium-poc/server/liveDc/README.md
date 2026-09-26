# Live DataConnect: FL511 → "SDNA Florida I595 Live *" classes

The sync polls FL511 the same way the existing live-events API does. It pushes I-595 corridor events into DataConnect, then generates an incident workflow from them:

**Ticket → Tasks → Work Order → Inspection (after the event clears) → Asset Status (Damaged)**

DataConnect is the system of record, and the app's live view reads these classes back.

## Why the Live classes are separate

Bentley's historical classes must never be corrupted. These are Florida I595 Assets, Incidents, Tickets, Tasks, Work Orders, the three Inspection classes and Roadway Segments.

Every write therefore goes to six new classes, in load and dependency order:

| Key | Class | keyInSource (= code) |
|---|---|---|
| EVENTS | SDNA Florida I595 Live Events | `FL511-<itemId>` |
| TICKETS | SDNA Florida I595 Live Tickets | `TIC-FL511-<itemId>` |
| TASKS | SDNA Florida I595 Live Tasks | `TSK-FL511-<itemId>-NN` |
| WORK_ORDERS | SDNA Florida I595 Live Work Orders | `WO-FL511-<itemId>` |
| INSPECTIONS | SDNA Florida I595 Live Inspections | `INSP-FL511-<itemId>` |
| ASSET_STATUS | SDNA Florida I595 Live Asset Status | `AST-<Assets.code>` |

Every Live class name and every Live relationship type starts with `SDNA` (`SDNA Florida I595 Live …`, `SDNA_Live_…`, labels `SDNA Live …`), so they filter together in DataConnect. The unprefixed `Florida I595 Live …` names are not Live classes and the writer refuses them. Historical class names are unchanged.

- **Links to historical data are by code only.** Live records link to historical records through plain String codes (`Asset ID`, `asset_id`, `segment ID`).
- **Damage goes into Live Asset Status.** It is never written into Florida I595 Assets.
- **Events are never deleted.** An event that leaves the feed is marked `status=cleared` with `cleared_at`. If the same FL511 itemId returns, even as a different type, it reactivates the same record.

## Live Events enrichment (`eventEnrichment.mjs`)

Each SDNA Live Events record also carries these fields. They are derived deterministically from the record itself and two local files (`public/data/i595_corridor_cameras.geojson`, `public/data/i595_fdot_traffic_segments.geojson`), with no network calls. A value that is not available is the literal `NA`.

| Field | Type | Source |
|---|---|---|
| `reported_at` | DateTime (`YYYY-MM-DDTHH:mm:ssZ`) | FL511 `start_time` (America/New_York, DST aware); else `first_seen_at` |
| `updated_at` | DateTime (`YYYY-MM-DDTHH:mm:ssZ`) | FL511 `last_updated`; else `last_seen_at` |
| `milepost` | String | interpolated along the record's FDOT segment (`begin_post`..`end_post`), one decimal |
| `cross_street` | String | description: "at / beyond / near / before / past X" |
| `incident_subtype` | String | keywords in title + description |
| `vehicles_involved` | String | "N vehicles", "N-vehicle", "multi-vehicle" (`Multiple`) |
| `impact_level` | String | Live Ops per-event level (`src/liveOps/operationalImpact.js`) from type, severity and lane flags |
| `est_clearance_at` | String | FL511 `end_time` as ISO UTC |
| `primary_camera_id`, `nearby_camera_ids`, `camera_snapshot_url` | String | cameras within 2000 m, same direction first, then nearest; up to 3 as `<camera_id>@<distance>m`; the snapshot is the same-origin proxy `/api/i595/camera/<divas_chan_id>/snapshot` |
| `injuries`, `fatalities`, `weather_at_event`, `traffic_conditions`, `queue_length_mi`, `est_delay_min`, `recovery_eta`, `responder_status`, `responding_units`, `nearby_dms_ids`, `dms_message`, `recommended_next_action`, `snapshot_archive_url` | String | always `NA` for now |
| `field_sources` | String | JSON object: each field above → `FL511`, `derived` or `NA` |

DataConnect rejects a DateTime with milliseconds ("DateTime type cannot have milliseconds"), so every DateTime is sent in whole seconds (`toDcDateTime` in `classes.mjs`), and `validateRecord` refuses milliseconds before a load. DataConnect reads a DateTime back as `2026-09-26T08:14:32.000+00:00`; the diff normalises zoned ISO timestamps on both sides, so a re-run writes nothing.

`updated_at` is ignored by the event diff, like `last_seen_at`, because it can fall back to it. A change in FL511's `last_updated` is still caught through `last_updated` itself.

`/api/i595/live-events?source=dataconnect` passes these on each event under `event.sdna` (snake_case names as stored, plus a parsed `fieldSources` object). Every other event field is unchanged. The browser normaliser keeps them in `related.sdna` (plus `related.cameraId` and `related.cameraSnapshotUrl`), and the Asset Explorer lists them as detail rows of a live incident.

## Link modes and the relationship-type delta

The class definitions live in `config/liveDc/liveClasses.json` and are built by `classes.mjs`. They come in three link modes:

- **`live` (default)**
  - Only Live → Live relationships, such as `source_event_id`, `Related Ticket ID` and `source_inspection_id`.
  - Every link to a historical class is a plain String.
  - Historical class definitions are never touched.
- **`linked`**
  - Adds one relationship: Live Asset Status `asset_id` → Florida I595 Assets.
  - Use it only after Bentley confirms that a reverse link does not modify the historical class.
- **`none`**
  - No relationships at all.
  - This is the fallback if even registering relationship types is unwanted.

Relationship types are a **global, additive** registry.

1. `config/liveDc/live-relationship-types.json` holds the delta: 11 types for `live`, plus 1 `linkedOnly` type.
2. The admin reads the registry with `GET /api/data-mgmt/v1/relationship-types`.
3. The admin appends the delta entries, never removing or renaming existing types.
4. The admin sends the registry back with `PUT`, using the current version.

Skip this whole step in `none` mode.

A relationship must always hold the non-empty code of an existing record. Real DataConnect marks an absent or empty relationship `valid=false` (ValueNotFound). For that reason, every link that can be unresolved is a plain String, and the producers always fill the rest.

## Creating the classes (admin, one time)

Regenerate or verify the artifacts with these commands. Neither makes a network call.

```bash
npm run live-dc:classes                       # (re)generates config/liveDc/*.json artifacts
node tools/live-dc-classes.mjs --check        # exit 1 if a committed artifact drifted
node tools/live-dc-classes.mjs --link-mode none --out /tmp/none.json   # no-relationship variant
```

To create the classes, work through `config/liveDc/live-classes.create-requests.json` (or `.linked.json`) **in order**. For each entry:

1. Send `POST /api/data-mgmt/v1/class` with its `create` body.
2. Send `POST /api/data-mgmt/v1/class/{newId}` with its `update` body, which carries `add`.
3. Before sending, replace each `"<id of SDNA Florida I595 Live …>"` placeholder with the id returned when that class was created. The order guarantees every target already exists.

Two things to avoid:

- **Never use `/admin/data/import`,** and above all never with loadType Full. Full deletes every record that is absent from the payload.
- **`live-classes.reference.json` is documentation only.** Do not send it as a payload.

## Writer guards (`dcWriter.mjs`)

All guards run before any network I/O:

- **Allowlist.**
  - The class name must be one of the six Live names (exact, case-sensitive).
  - The class ObjectId must not be a historical id.
  - The numeric `classId` must not be one of the historical ones (8–15, 22). The load service resolves its target only by `CL0000NN`.
- **Resolved classes only.**
  - `loadRecords` accepts only DTOs returned by this writer's `resolveLiveClasses()`, which reads the server's own class list.
  - That call also cross-checks that each classId is unique.
  - Hand-built or copied DTOs are refused with `unresolved_class`.
- **Configured origins only** (checked per request; the redirect check is on the response).
  - Every request must target the `DC_WRITER_BASE_URL` (data-management reads) or `DC_WRITER_LOAD_BASE_URL` (load service) origin.
  - On the load service only four calls are allowed: `POST /v1/loads`, `POST /v1/loads/{id}/upload/json-file`, `POST /v1/loads/{id}/process` and `GET /v1/loads/{id}`. `purge-all`, load groups, cancel (`DELETE`) and anything else are refused with `load_path_refused`, as is a registered load id that is not a plain token.
  - Redirects are never followed (`redirect: 'manual'`); any 3xx is an `http_error`. This also applies to the client-credentials token request.
- **Incremental only.**
  - Full is unreachable.
  - Deletion is reachable only through `resetLiveClass(dto, { confirm: '<exact class name>' })`. It is never used by the sync.
- **Load flow.** Register `{classId: CL0000NN, classType: DATA_CLASS, loadType}`, upload the flat records as a JSON array, process, then poll `GET /v1/loads/{id}` until `Finished` or `Failed` (`load_failed`, with the load log in `detail`). Curation is matched by that load id in `curated-data-process`; stats come from the `raw-data-process` entry with the same `loadId` when present (optional, `stats=n/a` otherwise).
- **Records.**
  - `keyInSource === code`.
  - No duplicate keys.
  - No attribute that the server's class definition does not declare.
  - Mandatory, type and relationship checks; DateTime without milliseconds.
- **Target and credentials.**
  - DataConnect is the only target: `DC_WRITER_BASE_URL` for class metadata and curated reads, `DC_WRITER_LOAD_BASE_URL` for loads. There is no default host and no local stand-in; without either URL the writer refuses with `not_configured`.
  - The credential is `DC_WRITER_ACCESS_TOKEN`, else `DC_WRITER_ACCESS_TOKEN_FILE` (re-read on every request, so the hourly `npm run dc:login` rewrite needs no restart), else `DC_WRITER_CLIENT_ID` + `DC_WRITER_CLIENT_SECRET`.
  - Tokens never appear in logs or errors.

## Test double (`standin.mjs`)

`standin.mjs` is used **only by the tests**. It has no runtime entry point and no npm script; the app, `/api/live-dc` and the sync talk only to DataConnect. Each test starts it in-process on port 0 and points the writer and reader at it with its own URL and token.

It mimics the parts of the DataConnect data-management API and load service whose behaviour is known:

- class list and search
- paged, filtered and sorted `curated-data`, with DateTime attributes read back as `2026-09-26T08:14:32.000+00:00`
- ascending `raw-data-process` and `curated-data-process` lists
- the load service: `POST /v1/loads`, `POST /v1/loads/{id}/upload/json-file`, `POST /v1/loads/{id}/process` and `GET /v1/loads/{id}`, with async Pending → Running → Finished processing, then curation (carrying the load id) and transitive `DEPENDENCY_UPDATED` re-curation
- DateTime validation: a value with milliseconds makes the record `valid=false` with "DateTime type cannot have milliseconds" (`invalidReasons(className)`)

`/api/loads/class`, `purge-all` and load groups return 403.

It seeds the nine historical classes read-only (5015 Assets from `public/dataconnect-data/asset_registry.json`, all `valid=false` because they have no segment ID, as in reality, and 17 Roadway Segments). Only the Live classes accept loads. Every other mutation returns 403.

`incrementalMode` exists because the real semantics of an Incremental load are unverified. The two modes are:

- **`replace`** swaps the whole record.
- **`merge`** overwrites only the attributes that were sent.

The sync is correct under both modes, and the end-to-end test runs both. To keep diffs stable under either mode, every unset String attribute is sent as `''`, and numeric attributes never go from set to unset.

## Runner (`tools/live-dc-sync.mjs`, `npm run live-dc:sync`)

```bash
npm run live-dc:sync                                  # every 60 s, FL511 -> DataConnect
npm run live-dc:sync -- --once --feed fixture.json    # one cycle from a fixture feed (no FL511)
```

The runner reads from `DC_WRITER_BASE_URL`, writes through `DC_WRITER_LOAD_BASE_URL` and prints `live-dc target: <origin> (DataConnect) loads: <load origin>` before the first cycle. Without either URL or a credential it exits 2 before any request. `--standin` and `--remote` were removed.

**Flags:**
- `--once` runs a single cycle.
- `--interval <s>` overrides `LIVE_DC_INTERVAL_SECONDS` (default 60).
- `--profile demo|realistic` sets the workflow timings.
- `--feed <json>` replaces FL511 with a fixture, which is re-read on every poll.

**Cycle behaviour:**
- Cycles never overlap.
- Each cycle prints one summary line.
- SIGINT stops cleanly.
- If a Live class is missing, the runner exits 1 with a pointer to the create-requests artifacts.

`/api/i595/live-events?source=dataconnect` reads only `status=active` Live Events records (curated-data filter `attributes.status equals active`, re-checked client-side), pages by `totalCount`, and shares one upstream read across callers for 20 s. A read cut short at the page limit is reported in `diagnostics.dataConnect.truncated`. An empty Live Events class is a valid live zero (`LIVE`, no events). It **never** falls back to direct FL511: when DataConnect is unconfigured, unreachable, missing the class or erroring, it answers 503 with `source: 'DataConnect'`, `sourceStatus: 'UNAVAILABLE'`, `events: []` and a short reason in `diagnostics.lastError` (no token details). The Traffic, Safety and Live Ops strips then show `⚠ DataConnect not connected` with the reason as a tooltip, and Maintenance's `Damaged (live)` card does the same when `/api/live-dc` is unavailable; both clear on the next successful refresh. Without `?source` the endpoint is unchanged. The standalone host (`npm run api`) mounts `/api/live-dc/*` and the DataConnect live-events source the same way the Vite dev server does.

Each cycle (`cycle.mjs`, `runLiveDcCycle`) runs these steps:

1. Resolve the Live classes.
2. Poll FL511.
3. Read all six Live classes back and overlay the records this process sent recently. The overlay makes a lagging read-back harmless.
4. Sync the events, then load them.
5. Run the workflow, which is pure and deterministic because timestamps come from milestones, not from `now`.
6. Diff each workflow class against DataConnect and load only what changed.

What happens when something goes wrong:

- **An Events load error** skips the workflow.
- **Unconfirmed Events curation** limits the workflow to events that are already curated.
- **Unconfirmed curation of a workflow class** defers the classes that depend on it until the next cycle.
- **Parents must be curated.** A record is sent only when every Live relationship it carries points at a code DataConnect has curated: one in the read-back, or one sent in a load whose curation was confirmed. This holds on every cycle, not just the one where curation timed out, so dependants wait until the parent shows up in the read-back.
- **A load where every record reports `notChanged`** raises a loop-detector warning, because it means the diff and the server semantics disagree.

`runLiveDcCycle` has no timers and no CLI dependencies, so the AWS poller lambda can call it later.

## Configuration (env only)

1. The admin registers the relationship-type delta (skip in `none` mode) and creates the six classes as described above.
2. Put these values in `.env.local`, never in a committed file:

   ```
   # writer (npm run live-dc:sync)
   DC_WRITER_BASE_URL=https://dataconnect-demo-dqa3.cohesivecloud.app      # data-mgmt reads (or the dc-data-mgmt host with DC_WRITER_DATA_MGMT_PREFIX=/api/v1)
   DC_WRITER_LOAD_BASE_URL=https://dc-load-demo-dqa3.cohesivecloud.app     # load service writes
   DC_WRITER_ACCESS_TOKEN_FILE=.dc-access-token      # or DC_WRITER_ACCESS_TOKEN / DC_WRITER_CLIENT_ID+SECRET
   LIVE_DC_LINK_MODE=live                            # the mode the classes were created with

   # reader (/api/live-dc and ?source=dataconnect, in `npm run dev` and `npm run api`)
   LIVE_DC_READ_BASE_URL=https://dataconnect-demo-dqa3.cohesivecloud.app
   LIVE_DC_READ_ACCESS_TOKEN_FILE=.dc-access-token   # or LIVE_DC_READ_ACCESS_TOKEN / LIVE_DC_READ_CLIENT_ID+SECRET
   ```

   `npm run dc:login` rewrites `.dc-access-token` about hourly; both sides re-read it on every call.

3. Run `npm run live-dc:sync`.

## Known costs and assumptions

- **Single writer per class.** Loads are correlated by their load-service id, but the diff still assumes one sync instance per environment.
- **Curated-process list growth.** Each load adds about 1–3 `curated-data-process` entries. The writer scans the whole list to find the entry for its `loadId`, so this gets slower over months. `GET /class/system-status` is a possible future optimisation.
- **Read volume.** The engine recomputes every chain each cycle, so reads of the Live classes grow over time. The diff keeps writes at zero when nothing changed. Archiving is out of scope.
- **Heuristics.** The DC segment longitude bands (`dcSegments.json`) and the damage mapping (`workflow.json`) are inferred and config-driven. An unresolved segment becomes `''` in a plain attribute, which never makes a record invalid.
