# Live DataConnect: FL511 → "SDNA Florida I595 Live *" classes

The sync polls FL511 the same way the existing live-events API does. It pushes I-595 corridor events into DataConnect, then generates an incident workflow from them:

**Ticket → Tasks → Work Order → Inspection (after the event clears) → Asset Status (Damaged)**

DataConnect is the system of record, and the app's live view reads these classes back.

## Set up on a new machine

There is **no shared token file and no client secret**. Every developer signs in with their own Bentley account (it needs DataConnect `dcm-admin` to write, or read access to only view). `spa-2u82GTzSkDl5CMm0mvqt0SWPv` is a public browser client with no secret. A service client id/secret has been requested from Bentley but does not exist yet.

1. In `cesium-poc/`, create `.env.local` (git-ignored). Use **absolute** paths for the token file:

   ```
   DC_BASE_URL=https://dc-data-mgmt-demo-dqa3.cohesivecloud.app
   DC_CLIENT_ID=spa-2u82GTzSkDl5CMm0mvqt0SWPv
   DC_SCOPE=itwin-platform
   VITE_DATA_SOURCE=dataconnect
   LIVE_DC_READ_BASE_URL=https://dataconnect-demo-dqa3.cohesivecloud.app
   LIVE_DC_READ_ACCESS_TOKEN_FILE=/absolute/path/to/cesium-poc/.dc-access-token
   DC_WRITER_BASE_URL=https://dataconnect-demo-dqa3.cohesivecloud.app
   DC_WRITER_LOAD_BASE_URL=https://dc-load-demo-dqa3.cohesivecloud.app
   DC_WRITER_ACCESS_TOKEN_FILE=/absolute/path/to/cesium-poc/.dc-access-token
   LIVE_DC_LINK_MODE=live
   ```

2. Run `npm install`, then `npm run dc:login`.
   - Port 3000 must be free; stop the root iTwin app first.
   - The command writes `.dc-access-token`, which lasts about an hour. Re-run it when it expires; nothing needs a restart, because the token file is re-read on every call.
   - Never share or commit this file.

3. Run `npm run dev -- --port 5188` and open `http://localhost:5188/?demo=i595`. Traffic, Live Ops and Maintenance read the SDNA Live classes.
   - "⚠ DataConnect not connected" means the token is missing or expired, or a URL is unset.
   - `curl localhost:5188/api/live-dc/status` shows why.

4. **Only one writer at a time.** Run `npm run live-dc:sync` on one machine only, and never while the AWS poller writes.

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

Each SDNA Live Events record also carries these fields. Most are derived deterministically from the record itself and two local files (`public/data/i595_corridor_cameras.geojson`, `public/data/i595_fdot_traffic_segments.geojson`), with no network calls. An unavailable String value is the literal `NA`; an unavailable URL, DateTime, Integer or Decimal is omitted (never `NA`, never `''`), and a URL value must be an absolute http(s) URL (`field_sources` still says `NA` for it).

| Field | Type | Source |
|---|---|---|
| `reported_at` | DateTime (`YYYY-MM-DDTHH:mm:ssZ`) | FL511 `start_time` (America/New_York, DST aware); else `first_seen_at` |
| `updated_at` | DateTime | FL511 `last_updated`; else `last_seen_at` |
| `incident_time_local` | String | `reported_at` as New York wall time, e.g. `2026-09-26 12:26 AM EDT` |
| `first_seen_at_dt`, `cleared_at_dt` | DateTime | `first_seen_at`; `cleared_at` only while `status=cleared` |
| `milepost` | String | interpolated along the record's FDOT segment (`begin_post`..`end_post`), one decimal |
| `cross_street` | String | description: "at / beyond / near / before / past X" |
| `incident_subtype` | String | keywords in title + description |
| `vehicles_involved` | String | "N vehicles", "N-vehicle", "multi-vehicle" (`Multiple`) |
| `impact_level` | String | Live Ops per-event level (`src/liveOps/operationalImpact.js`) from type, severity and lane flags |
| `est_clearance_at` | String | FL511 `end_time` as ISO UTC |
| `primary_camera_id`, `nearby_camera_ids`, `camera_snapshot_url` | String | cameras within 2000 m, same direction first, then nearest; up to 3 as `<camera_id>@<distance>m`; the snapshot is the proxy `/api/i595/camera/<divas_chan_id>/snapshot`, absolute when `LIVE_DC_PUBLIC_API_BASE` is set |
| `snapshot_first_url` (URL), `snapshot_first_taken_at` (DateTime), `snapshot_first_camera_id` | captured | DIVAS still stored once, within an hour of first sight (`eventCapture.mjs`) |
| `snapshot_cleared_url` (URL), `snapshot_cleared_taken_at` (DateTime), `snapshot_cleared_camera_id` | captured | DIVAS still stored once, when the event clears (same camera as the first one when possible) |
| `snapshot_archive_url` | String | = `snapshot_first_url` |
| `weather_at_event`, `weather_source` | String | Open-Meteo current conditions at the event at first sight, e.g. `Clear · 27.4 °C · wind 12 km/h SE` |
| `weather_code` (Integer), `temperature_c`, `relative_humidity_pct`, `precipitation_mm`, `wind_speed_kmh`, `wind_direction_deg` (Decimal), `weather_observed_at` (DateTime) | captured | the same Open-Meteo reading (WMO code, °C, %, mm, km/h, degrees) |
| `injuries`, `fatalities`, `traffic_conditions`, `queue_length_mi`, `est_delay_min`, `recovery_eta`, `responder_status`, `responding_units`, `nearby_dms_ids`, `dms_message`, `recommended_next_action` | String | always `NA` for now |
| `field_sources` | String | JSON object: each field above → `FL511`, `derived`, `DIVAS`, `Open-Meteo` or `NA` |

**Snapshots and weather** are captured, not derived, and are sticky: once a value is in DataConnect it is carried forward and never recaptured. The camera is the first one FL511 lists in the incident tooltip's camera carousel (FL511 camera id, title and a DIVAS video URL `…/chan-<n>_h/…`) that is one of the corridor cameras (same id, else same DIVAS channel); otherwise the nearest corridor camera with a DIVAS channel. The JPEG comes from DIVAS (`https://images-dis.divas.cloud/DGI/chan-<n>_h.jpg`, 5 s timeout) and is stored in the data bucket at `snapshots/<eventKey>/<UTC yyyymmddThhmmssZ>_<cameraId>.jpg`, served by CloudFront's default behaviour; DataConnect stores only the URL. The poller uses S3 `PutObject`; `npm run live-dc:sync` uses `aws s3 cp -` when `LIVE_DC_SNAPSHOT_BUCKET` and `LIVE_DC_SNAPSHOT_PUBLIC_BASE` are set, and takes no snapshots otherwise. With `--feed` nothing is captured. A failed fetch or upload leaves the columns unset and never fails the cycle.

**Schema change for the existing class.** `config/liveDc/live-events.update-request.json` (generated and `--check`ed by `tools/live-dc-classes.mjs`) is the additive ClassUpdate for these attributes. `tools/live-dc-apply-update.mjs` shows the plan (dry run); with `--apply` it POSTs it to `https://dc-data-mgmt-demo-dqa3.cohesivecloud.app/api/v1/class/<id>`. It refuses any other class and any attribute that already exists. Apply it before the sync writes the new fields, otherwise every Live Events load is refused as carrying undeclared attributes.

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
  - The class name must be one of the six Live names or a standalone SDNA class (`standaloneClasses` in `liveClasses.json`, today only `SDNA Florida I595 Historical Chain`), exact and case-sensitive. Every writable name must start with `SDNA `.
  - The class ObjectId must not be a historical id.
  - The numeric `classId` must not be one of the historical ones (8–15, 22). The load service resolves its target only by `CL0000NN`.
- **Resolved classes only.**
  - `loadRecords` accepts only DTOs returned by this writer's `resolveLiveClasses()`, or by `resolveWritableClass(name)` for a standalone SDNA class. Both read the server's own class list.
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

## Historical chain (SDNA Florida I595 Historical Chain)

Bentley's historical data links only Ticket → Task → Work Order, and everything → Asset. This class holds a complete **Incident → Ticket → Task(s) → Work Order → Inspection** chain for every historical incident without modifying any Bentley class. It has one row per step. Links to Bentley records are plain String ids, with no DataConnect relationships. The class is standalone: the live sync never reads or writes it, and `resolveLiveClasses()` does not require it.

**Chain rules** (`historicalChain.mjs`, pure and deterministic). "Days" are calendar days and the window is 0–90 days inclusive. When several records qualify, the earliest wins, then the smallest id.

| Step | Real link | Otherwise |
|---|---|---|
| Ticket | Ticket on the same asset (`damaged_asset_id` == `Asset ID`), opened 0–90 d after the incident: `inferred_same_asset` / Medium, e.g. `same asset, ticket 12 d after` | `TIC-SYN-<n>` |
| Task(s) | Bentley `Related Ticket ID`: `bentley_link` / High, all tasks by id | `TSK-SYN-<n>-01..03` (the live workflow's INCIDENT task templates) |
| Work Order | Bentley `Related Ticket ID` or `Related Task ID`: `bentley_link` / High | `WO-SYN-<n>` |
| Inspection | ITS / Roadway / Safety inspection on the same asset, 0–90 d after the WO open date: `inferred_same_asset` / Medium | `INSP-SYN-<n>` |

- `<n>` is the incident's numeric part (`INC-200062` → `200062`).
- Bentley reuses 34 incident ids in the export (178 incidents, 144 ids). Later occurrences get their own chain, `CHAIN-<id>-DUP2`, and synthetic ids `…-200063-DUP2`. The order is by date, then content.
- Dates can be ISO, `dd/mm/yyyy`, `dd/mm/yyyy HH:MM` or DataConnect's zoned read-back. They are read as America/New_York wall time. `1900-01-00` and years before 1901 are invalid.
- Synthetic step dates follow the previous step with fixed, hash-derived offsets: hours for the ticket and tasks, 1–3 d for the WO, 5–14 d for the inspection.

**Columns.** Core `keyInSource` = `code` = `CHAIN-<incident id>-<step_order>-<step>`, plus `name` and `description`, then:

- `chain_id`, `incident_id`, `step`, `step_order` (Integer), `record_id`, `parent_record_id`, `record_class` (Bentley class or `synthetic`)
- `link_method` (`root` | `bentley_link` | `inferred_same_asset` | `synthetic`), `link_detail`, `confidence` (High | Medium | Synthetic), `is_synthetic` (Boolean)
- `asset_id`, `segment`, `step_date` (DateTime, whole seconds, omitted when unknown)
- `summary`, `status`, `priority`, `assigned_team`, `work_type`, `inspection_result`, `asset_condition`
- `geometry` (the incident's Point), `x_coordinates`, `y_coordinates`

An unavailable String is `NA`.

**Local export numbers** (`--from-local`): 178 chains, 1,170 rows.

| Step | Real | Inferred | Synthetic |
|---|---|---|---|
| Incident | 178 | 0 | 0 |
| Ticket | 0 | 38 | 140 |
| Task | 38 | 0 | 420 |
| Work Order | 33 | 0 | 145 |
| Inspection | 0 | 87 | 91 |

**Tools** (dry runs by default):

```bash
node tools/live-dc-classes.mjs --check                                            # includes historical-chain.create-request.json
node tools/live-dc-create-class.mjs "SDNA Florida I595 Historical Chain"          # plan; checks the class does not exist yet
node tools/live-dc-create-class.mjs "SDNA Florida I595 Historical Chain" --apply  # POST /class, then POST /class/{id} with the attributes
node tools/historical-chain.mjs --from-local                                      # stats + 3 sample chains from public/dataconnect-data
node tools/historical-chain.mjs                                                   # same, reading the 7 Bentley classes from DataConnect (read-only)
node tools/historical-chain.mjs --from-local --out /tmp/chain-rows.json           # write the rows
node tools/historical-chain.mjs --apply                                           # Incremental load of changed rows into the chain class only
```

- `live-dc-create-class.mjs` refuses names without the `SDNA ` prefix, classes with no committed create request, requests that still hold an `<id of …>` placeholder, and classes that already exist.
- `historical-chain.mjs --apply` resolves the class with `resolveWritableClass`, which runs the same guards as for the Live classes. It diffs the rows against the class and sends only changed rows, in chunks of 500.

**Reading a chain (UI).** Filter `chain_id` (or `incident_id`, or `record_id` for any step) and sort by `step_order`. Label each step from `link_method`:

- `root` / `bentley_link` → "Linked"
- `inferred_same_asset` → "Inferred · <link_detail>"
- `synthetic` → "Synthetic (demo)"

See the `TODO(Arpana)` note in `src/maintenance/maintenanceRecords.js`.

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

`runLiveDcCycle` has no timers and no CLI dependencies, so the AWS poller lambda calls it too (below).

## Cloud writer token hand-off (TEMPORARY)

Until Bentley provides refresh tokens or a service client, the AWS poller lambda writes with an access token handed off from a signed-in machine:

1. The machine running the app (`npm run dev` or `npm run api`) holds the token in `.dc-access-token`, renewed by `npm run dc:login`. With `DC_TOKEN_HANDOFF_URL` set (the `DcTokenIntakeFunctionUrl` stack output), `server/dcTokenPusher.mjs` POSTs it as `Authorization: Bearer` whenever the file changes and at least every 50 minutes. It is server-side only (never in browser JS), a no-op when the URL is unset, and never logs the token.
2. The intake lambda (`infra/lambdas/dc-token-intake/`) checks the token has at least 5 minutes left, that `GET /api/user-mgmt/permission` grants `dcm-admin`, and (optionally) that its `sub`/`email` is in `DC_TOKEN_ALLOWED_SUBJECTS`. It then stores it at `secrets/dc-token.txt` in the data bucket, SSE-KMS with a dedicated key. CloudFront cannot decrypt that key and is also explicitly denied `secrets/*`. A lifecycle rule expires `secrets/` objects and old versions after 1 day.
3. Each poller run fetches FL511 once. It writes DynamoDB exactly as before, then runs one `runLiveDcCycle` on the same payload if the token has at least 2 minutes left. Either way it writes the non-secret `status/live-dc-status.json` (`{lastRunAt, dcWrite: ok|skipped|error, reason, tokenExpiresAt, fl511, summary}`), which CloudFront serves at `/status/live-dc-status.json`. The workspace strips show it as "Cloud sync: …", for example "needs sign-in" when there is no valid token (`src/liveDcCloudSync.js`).

**Single writer rule.** Once the lambda is writing (status `dcWrite: ok`), stop any local `npm run live-dc:sync`. Two writers would duplicate loads and fight over the diff.

The token lasts about an hour. If the signed-in machine stops (no `dc:login`, or no dev/api server running), the cloud writer skips with `token_expired` until someone signs in again.

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

- **Single writer per class.** Loads are correlated by their load-service id, but the diff still assumes one sync instance per environment. The local `npm run live-dc:sync` and the AWS poller are two writers, so run only one of them.
- **Curated-process list growth.** Each load adds about 1–3 `curated-data-process` entries. The writer scans the whole list to find the entry for its `loadId`, so this gets slower over months. `GET /class/system-status` is a possible future optimisation.
- **Read volume.** The engine recomputes every chain each cycle, so reads of the Live classes grow over time. The diff keeps writes at zero when nothing changed. Archiving is out of scope.
- **Heuristics.** The DC segment longitude bands (`dcSegments.json`) and the damage mapping (`workflow.json`) are inferred and config-driven. An unresolved segment becomes `''` in a plain attribute, which never makes a record invalid.
