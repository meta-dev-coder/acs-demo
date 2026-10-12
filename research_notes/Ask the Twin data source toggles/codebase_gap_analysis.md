# Ask the Twin vs. Dan's "toggle data sources / revenue-aware prioritisation" scenario: codebase gap analysis

Scope: code reading only, at `/home/user/acs-demo` (mostly `cesium-poc/`). Nothing was edited. Paths below are relative to `cesium-poc/` unless they start with `/` or `root:`.
Line numbers are from the working tree on 2026-10-12.

Note on the backends: CLAUDE.md says Vite "does not mount `/api/i595/ask`". That is now stale. `vite.config.js:45` imports `server/ask/localAsk.mjs`, and `src/askTheTwin.js:21-24` sends dev builds to `/api/i595/ask`, which is the `server/ask/` orchestrator. Production builds still default to the CloudFront Lambda (`src/askTheTwin.js:24`). Everything below is about the `server/ask/` orchestrator: twin store, tools, insights and personas.

---

## Q1. What data sources does Ask the Twin's backend see today, and which business unit does each serve?

### Takeaway
The orchestrator sees three kinds of source. (1) A SQLite "twin store" holding 8 historical DataConnect classes from the committed snapshot, plus the 6 SDNA live classes and the historical classes when DataConnect is reachable. (2) Six corridor GeoJSON layers. (3) Live FL511 events and Open-Meteo weather. Every source serves maintenance/ops, safety or TMC/traffic ops. **None carries finance, tolling or transaction data.** The only traffic-volume field available to the model is the static FDOT AADT on the traffic-segment layer.

### Cited Findings
- **Twin store snapshot classes** (`SNAPSHOT_CLASSES`): Florida I595 Assets, Incidents, Tickets, Tasks, Work Orders, ITS Inspections, Roadway Inspections, Safety Inspections. Each class lists its key, date, lon/lat and segment fields. Work Orders has `lon: [], lat: []`, so work orders have **no coordinates** in the store. — [server/ask/twinStore.mjs:36-53](cesium-poc/server/ask/twinStore.mjs)
- **DataConnect pull**: when credentials exist, `pullDataConnect` adds *every* SDNA live class (`liveDc.liveClasses()`) and every historical class in `config/liveDc/historicalClasses.json` (9 entries). Any class it cannot read falls back to the snapshot. — [server/ask/dataConnectPull.mjs:108-146](cesium-poc/server/ask/dataConnectPull.mjs), [server/ask/dataConnectPull.mjs:159-178](cesium-poc/server/ask/dataConnectPull.mjs)
- **Live SDNA classes and their key fields** (from `config/liveDc/liveClasses.json`):
  - Live Events: event_type, status, severity, lane fields, `primary_camera_id`, `nearby_camera_ids`, weather, `queue_length_mi`, `est_delay_min`. Serves TMC and safety.
  - Live Tickets: Ticket ID, Ticket Status, Priority, Asset ID, Asset Type, Ticket Opened Date, source_event_id. Serves maintenance and ops.
  - Live Tasks: Task Type, Task Status, Assigned Team. Serves maintenance and ops.
  - Live Work Orders: Work Type, Work Order Status, Priority, Asset ID, Work Order Open Date, Close Date, Repair Category, x/y. Serves maintenance and ops.
  - Live Inspections: pass_fail, asset_condition, risk_rating_1_5, recommended_action. Serves maintenance and safety.
  - Live Asset Status: asset_id, status, damaged_at. Serves maintenance.
  - Source: [config/liveDc/liveClasses.json](cesium-poc/config/liveDc/liveClasses.json). Purposes are in [config/askTwin/dataGuide.json:12-40](cesium-poc/config/askTwin/dataGuide.json).
- **Historical snapshot fields** (from profiling `public/dataconnect-data/*.json`):
  - `asset_registry.json` (5,015 rows): Asset ID, Asset Category, Asset Description, Criticality, Instal Date, Status, Segment, X/Y Coordinates.
  - `work_orders.json` (854 rows): Work Order ID, Asset ID, Asset Type, Work Type, Work Order Status, Priority, Work Order Open Date, Close Date, Labor/Materials/Total Cost.
  - `tickets.json` (1,021 rows) and `tasks.json` (1,021 rows): Assigned Team is one of Roadway Response, ITS Response, Field Ops A/B, Night Crew, Program Management.
  - `its_inspections_v3.json` (1,046 rows): pass_or_fail, asset_condition, risk_rating_1_5, recommended_action.
  - `incidents_v3.json` (178 rows): weather, lane closure hours, injuries, damaged_asset_id.
  - Source: [public/dataconnect-data/](cesium-poc/public/dataconnect-data/)
- **WO cost fields are empty**: `Total Cost` is null on 854 of 854 work orders (for example `"Total Cost": null` at work_orders.json:20). There is no usable cost or finance signal even in the maintenance data. — [public/dataconnect-data/work_orders.json](cesium-poc/public/dataconnect-data/work_orders.json)
- **Corridor layers reachable by tools**: `ASK_LAYER_FILES` = cameras, traffic signals, bridges, express gantries, FDOT traffic segments, ramps. `dnt-gantries.json` is described in dataGuide but is **not** in this list. — [server/liveDc/dataDictionary.mjs:19-22](cesium-poc/server/liveDc/dataDictionary.mjs), [config/askTwin/dataGuide.json:82-93](cesium-poc/config/askTwin/dataGuide.json)
- **Layer fields**:
  - Cameras (74 features): camera_id (an FL511 id such as "1837"), description "I-595 ~MP 8.5", direction, is_express_camera, divas_chan_id.
  - Express gantries (10 features): gantry_id GNT-*, type access_node/ort_mainline, milepost, lane_count, status, dms_text.
  - FDOT segments (16 features): segment_id, direction, aadt, aadt_year=2025, segmentation_source "FDOT RCI Annual Average Daily Traffic".
  - Source: [public/data/i595_corridor_cameras.geojson](cesium-poc/public/data/i595_corridor_cameras.geojson), [public/data/i595_express_gantries.geojson](cesium-poc/public/data/i595_express_gantries.geojson), [public/data/i595_fdot_traffic_segments.geojson](cesium-poc/public/data/i595_fdot_traffic_segments.geojson)
- **Read tools**: describe_store, query_records, count_records, list_live_events, find_corridor_features, records_near, get_weather. — [server/ask/tools.mjs:36-93](cesium-poc/server/ask/tools.mjs)
- **Insight tools**:
  - explain_incident and rank_incidents use the TMC risk model on live events and serve TMC.
  - crash_hotspots and weather_risk_forecast use the crash register and Open-Meteo and serve safety.
  - Source: [server/ask/insights.mjs:318-340](cesium-poc/server/ask/insights.mjs)
- **The insights state the volume gap themselves**: "Traffic volume and speed at the time are not in the twin." and "Hourly traffic volume (exposure) is not in the twin…". — [server/ask/insights.mjs:145](cesium-poc/server/ask/insights.mjs), [server/ask/insights.mjs:216-217](cesium-poc/server/ask/insights.mjs)
- **System prompt**: the full store summary (every class, row count and first 30 fields) is in the cached system prompt for every request. — [server/ask/prompt.mjs:51-56](cesium-poc/server/ask/prompt.mjs), [server/ask/prompt.mjs:62-64](cesium-poc/server/ask/prompt.mjs)
- **Prefetch**: only TMC and safety intents are recognised (explain_incident, rank_incidents, weather_risk_forecast, crash_hotspots, records_near over Incidents). There is no maintenance or finance prefetch. — [server/ask/prefetch.mjs:25-50](cesium-poc/server/ask/prefetch.mjs)
- **Answer blocks**: blocks exist for count_records, records_near, list_live_events, crash_hotspots, rank_incidents, explain_incident and weather_risk_forecast. A generic `table` block type (columns, rows, rowLocations) already exists. — [server/ask/answerBlocks.mjs:9-13](cesium-poc/server/ask/answerBlocks.mjs), [server/ask/answerBlocks.mjs:21-70](cesium-poc/server/ask/answerBlocks.mjs)

### Inferences
- Coverage by business unit:
  - Maintenance/ops: good (assets, tickets, tasks, WOs, inspections).
  - Safety: good (incidents, safety and roadway inspections, hotspots, weather).
  - TMC/traffic ops: good (live events, risk model, cameras, AADT).
  - **Finance/tolling: none.**
- Dan's "macro view" cross-silo story today means cross-silo between maintenance, safety and ops only.

### Gaps
- I did not run a DataConnect pull, so I could not confirm which live classes currently exist in the tenant or their row counts. The analysis relies on the config and the snapshot.

---

## Q2. Is there any transaction / toll / revenue / traffic-volume data anywhere in the repo?

### Takeaway
Yes, in four places, and **none is reachable by Ask the Twin**. All revenue and transaction figures are synthetic or modelled; none comes from real transaction records. The only real measured volume is the FDOT AADT (one annual value per segment, 2025). Ask the Twin can read it through `find_corridor_features`, but no tool turns it into a volume or revenue figure.

### Cited Findings
- **FDOT AADT (real, annual, per FDOT segment)**:
  - Values are 108,000, 154,256, 229,000, 88,500 and 7,500. aadt_year is 2025 and the source is "FDOT RCI Annual Average Daily Traffic".
  - There are 16 features (8 EB + 8 WB). The granularity is per segment, per year: no hourly or per-gantry values.
  - Source: [public/data/i595_fdot_traffic_segments.geojson](cesium-poc/public/data/i595_fdot_traffic_segments.geojson), [config/askTwin/dataGuide.json:86](cesium-poc/config/askTwin/dataGuide.json)
- **I-595 express gantries (no transactions)**:
  - 10 gantries carry id, type, milepost, lane_count, status and dms_text.
  - There are no transaction, volume or rate fields.
  - Coordinates are rounded (for example GNT-M01 at -80.38, 26.11) and the file has no source field.
  - Source: [public/data/i595_express_gantries.geojson](cesium-poc/public/data/i595_express_gantries.geojson)
- **UC1 "Lane Closure Revenue Optimizer" (synthetic, cesium-poc non-i595 entry)**:
  - `config/demandProfile.json:2` calls itself a "synthetic demand curve". It has baseVph 4200 and AM/PM peak multipliers.
  - `config/segments.json` has 4 coarse segments with `demandScale`.
  - `config/windowConfig.json:6` sets `tollRateUsd: 2.5`. Lines 9-14 hold weights revenue 0.5, delay 0.2, safety 0.3, crew 0.
  - `src/windowEval.js:20-29`, `:148-160` and `:212-224` compute revenue at risk as Σ excess vehicles × slice hours × toll rate, then a weighted Score(w).
  - The granularity is per 15-minute slice, per coarse segment, per candidate closure window.
  - Source: [config/demandProfile.json](cesium-poc/config/demandProfile.json), [config/windowConfig.json](cesium-poc/config/windowConfig.json), [src/windowEval.js](cesium-poc/src/windowEval.js)
- **The same code says no real traffic actuals exist**: "Delay and revenue are explicitly OUT of scope here — there are no traffic actuals in this package" and "exact revenue figures are calibrated in the pilot". — [src/backtest.js:19-27](cesium-poc/src/backtest.js), [src/execKpis.js:27-29](cesium-poc/src/execKpis.js)
- **Seeded decisions**: `public/dataconnect-data/decisions_seed.json` holds 15 seeded decisions with `revenueAtRiskUsd` and `"seeded": true`. — [public/dataconnect-data/decisions_seed.json:28-29](cesium-poc/public/dataconnect-data/decisions_seed.json)
- **NTTA / DNT toll-plaza demo (`src/main.js`, the non-`?demo=i595` entry)**:
  - Gantry lon/lat are real NTTA values from NCTCOG, with a live ArcGIS query and a 3-gantry fallback (`public/data/dnt-gantries.json`).
  - `avgTollUsd: 1.45` is a single constant.
  - `src/assetOps.js:11-17` and `:37-60` compute transactionsPerHr = SUMO throughput × peak multiplier, a missed-read rate from camera degradation and rain, and revenueRiskPerHr = missed × avgToll.
  - This is the closest existing analogue to "camera degradation → revenue impact", but it is modelled, Dallas-based, and per plaza rather than per site.
  - Source: [src/assetOps.js](cesium-poc/src/assetOps.js), [src/main.js:202](cesium-poc/src/main.js), [src/main.js:273-275](cesium-poc/src/main.js), [public/data/dnt-gantries.json](cesium-poc/public/data/dnt-gantries.json)
- **Root iTwin app Scenario C (dynamic tolling)**:
  - `root:src/scenarioC/pricing.ts:1-14` is "config-driven from src/data/tollPricing.json".
  - `:250-251` computes revenuePerHour = postedRate × volume × demandRetained, per express section (EXP-W/C/E) and per time block.
  - Demand comes from stubs: `root:src/stubs/openPathsStub.ts:4` says "STUB - replace with live OpenPaths…", and there is also `root:src/stubs/v2xStub.ts`.
  - It is synthetic and lives in the other app, which CLAUDE.md says never imports cesium-poc.
  - Source: [root src/scenarioC/pricing.ts](src/scenarioC/pricing.ts), [root src/stubs/openPathsStub.ts](src/stubs/openPathsStub.ts)
- **Toll-gantry recommendations**: `src/scoringConfig.json` has recommendedActions for `toll_gantry` ("Replace SunPass reader/antenna head… protect tolling uptime"). It is used by `src/scoringA.js` and `main.js`, not by the i595 demo. The asset registry has no toll-gantry category (categories counted from the snapshot). — [src/scoringConfig.json:28-33](cesium-poc/src/scoringConfig.json), [src/scoringA.js:20](cesium-poc/src/scoringA.js)

### Inferences
- A synthetic per-site revenue source could reuse the UC1 conventions: toll rate in config, demand profile × AADT, and an uncertainty band. The `assetOps.js` missed-read model could be reused for camera-specific revenue impact. All of it must be badged synthetic, matching the codebase's SYNTHETIC/REAL badging (`src/glassBox.js:9`).
- **AADT will not differentiate Dan's three camera sites.** The three cameras with open or in-progress WOs (Q3) all lie 24-47 m from the same FDOT segment, I595-*-FDOT-007350-009892 (AADT 229,000). The nearest express gantry to each is GNT-M05, 3.2-3.9 km away (my haversine computation over the GeoJSON). A revenue toggle that changes the ranking therefore needs a per-site revenue attribution (gantry-level transactions, or camera→gantry dependency), not AADT.

### Gaps
- No real toll transactions, gantry counts, toll rates for I-595 Express, or hourly volumes exist anywhere in the repo.
- I could not determine whether the I-595 express gantry positions come from a real source. The file has no provenance field.

---

## Q3. Cameras: representation, "which sites need camera replacement", FIFO and "closest"

### Takeaway
Cameras exist in three ID systems that do not join cleanly:
- 49 registry assets with numeric Asset ID and description "CCTV nnnn".
- 74 FL511 map cameras with FL511 camera_id.
- ITS inspections keyed by the description string.

The data can answer "which camera sites have open WOs, oldest first". Exactly 3 sites qualify, which conveniently matches Dan's example. No record says "replacement", though. "Closest" works only to an arbitrary point: there is no depot or crew location data.

### Cited Findings
- **Registry cameras**: 49 assets have `Asset Category = Camera` (for example Asset ID 11960, "CCTV 0529", with X/Y coordinates). `Status`, `Criticality` and `Instal Date` are **null for all 49**, so age and condition cannot come from the registry. — profiling of [public/dataconnect-data/asset_registry.json](cesium-poc/public/dataconnect-data/asset_registry.json)
- **Map cameras**: the 74 FL511 cameras (`camera_id` "1837", "1871"…) share no key with the registry. The insights load them by `camera_id` as TMC resources. — [server/ask/insights.mjs:52-58](cesium-poc/server/ask/insights.mjs), [public/data/i595_corridor_cameras.geojson](cesium-poc/public/data/i595_corridor_cameras.geojson)
- **Camera WOs**: 13 work orders have Asset Type Camera, and their Asset ID matches the registry's numeric Asset ID. Exactly 3 are not closed:
  - WO-900590, CCTV 5078: Open since 2024-08-21, Preventive Maintenance, "inspection follow-up".
  - WO-900717, CCTV 5075: In Progress since 2025-01-17, Preventive Maintenance, "intermittent fault".
  - WO-900775, CCTV 5079: Awaiting Parts since 2025-05-07, Root Cause Investigation.
  - Work types across all 13 are Corrective Repair, Corridor Mitigation, Preventive Maintenance, Field Restoration, Root Cause Investigation and Parts Replacement. **None is "replacement" of the camera.**
  - Source: profiling of [public/dataconnect-data/work_orders.json](cesium-poc/public/dataconnect-data/work_orders.json)
- **Camera ITS inspections**: 39 inspections (21 Pass, 18 Fail) cover 12 cameras, 9 of which have at least one Fail. recommended_action is "Schedule WO to repair" (18), "Monitor condition" (12) or "Schedule next inspection" (9). asset_id is the description string ("CCTV 5087"), which matches the registry `Asset Description`, not `Asset ID`. — profiling of [public/dataconnect-data/its_inspections_v3.json](cesium-poc/public/dataconnect-data/its_inspections_v3.json)
- **Live chain**: Live Events carry `primary_camera_id` and `nearby_camera_ids` (FL511 ids). Live Asset Status carries asset_id, status and damaged_at. — [config/liveDc/liveClasses.json](cesium-poc/config/liveDc/liveClasses.json)
- **FIFO**: Work Order Open Date exists, and `query_records` returns records "newest first", ordered by the indexed `at` column. The model gets newest-first order but no oldest-first option. — [server/ask/twinStore.mjs:258](cesium-poc/server/ask/twinStore.mjs), [server/ask/tools.mjs:43-52](cesium-poc/server/ask/tools.mjs)
- **Date formats are mixed**: WOs are "Dates are MM/DD/YYYY strings" per dataGuide, but the snapshot shows ISO strings, so sorting by date as text is fragile. — [config/askTwin/dataGuide.json:58-61](cesium-poc/config/askTwin/dataGuide.json)
- **Closest**: `records_near` and `find_corridor_features` take a point or a named place, with a maximum of 3 km and 10 km respectively. — [server/ask/tools.mjs:24](cesium-poc/server/ask/tools.mjs), [server/ask/tools.mjs:67-88](cesium-poc/server/ask/tools.mjs)
- **No depot, yard or crew location data**: a grep for depot, yard, garage, crew location and home base across src, server and config found only `crewEtaMin: 42` (a constant, `src/assetOps.js:16`) and crew cost weights (`config/windowConfig.json`). The tasks "Assigned Team" field has team names but no locations.

### Inferences
- "Which 3 sites need camera work, FIFO" is answerable today, but only in a multi-step way. The model must run query_records on Work Orders (Asset Type = Camera, status ≠ closed; there is no not-equals operator, so it has to query each status or count by status) and then look up coordinates in the registry by Asset ID. Work orders have no coordinates in the store (Q1).
- For "closest", a depot/crew-base config (for example `config/askTwin/depots.json`) is needed. Without it, "closest" can only mean closest to the operator's selection or view centre (the screen bbox is already sent).

### Gaps
- There is no camera "replacement" signal: no condition or end-of-life field on registry cameras, and no WO type for replacement. A demo would need either a reworded question ("need camera work/repair") or seeded fields.

---

## Q4. Does the UI have a notion of data-source selection, and does the server scope by it?

### Takeaway
No. The UI's layer visibility (`mapLayerStore`) is never sent to Ask the Twin. The envelope's screen block carries workspace, persona, temporal mode, an incident selection, the view bbox and the drawn area. Every request gets the identical tool set and the identical store summary. No code path restricts which classes the model can query per request.

### Cited Findings
- **mapLayerStore**: it is the single facade over layer checkboxes (`CORRIDOR_LAYERS`, presets "traffic/operations/infrastructure/clean"). It includes `cameras` and `gantries` layers but has no DataConnect class concept. — [src/mapLayerStore.js:1-11](cesium-poc/src/mapLayerStore.js), [src/mapLayerStore.js:32-60](cesium-poc/src/mapLayerStore.js), [src/mapLayerStore.js:81-86](cesium-poc/src/mapLayerStore.js)
- **Screen snapshot sent with each question**: workspace (`body.dataset.section`), persona, TMC temporal and selection, and view bbox. There is no layer state. — [src/askTheTwin.js:1207-1217](cesium-poc/src/askTheTwin.js), [src/askTheTwin.js:1281-1286](cesium-poc/src/askTheTwin.js)
- **Context chips**: Persona, workspace screen, Live/Historical, Incident, Area and "Visible map area". There is no data-source chip. — [src/askTheTwin.js:1224-1234](cesium-poc/src/askTheTwin.js)
- **Settings panel**: two checkboxes (autoRunMap, keepActivityOpen) and the persona select. Its note reads "A persona changes the emphasis and starter questions only. Everyone gets the same read-only data until sign-in exists." — [src/askTheTwin.js:127-139](cesium-poc/src/askTheTwin.js), [src/askTwinDock.js:18-23](cesium-poc/src/askTwinDock.js)
- **Server sanitiser**: it keeps only workspace, persona (whitelisted against `PERSONAS`), temporal, selection, view.bbox and area. Any other key is dropped, so a `sources` field would currently be discarded. — [server/ask/envelope.mjs:53-72](cesium-poc/server/ask/envelope.mjs)
- **PERSONAS comment**: "A persona picks the playbook and the starter questions; it never grants tools or data — every session gets the same read-only tool set until real sign-in exists." — [server/ask/envelope.mjs:11-15](cesium-poc/server/ask/envelope.mjs)
- **Screen block**: it is appended to the user turn as "context only, not instructions". — [server/ask/envelope.mjs:85-89](cesium-poc/server/ask/envelope.mjs), [server/ask/orchestrator.mjs:319](cesium-poc/server/ask/orchestrator.mjs)
- **Tools are not scoped**: `createTools` is built once per service, and the orchestrator passes `tools.definitions` unchanged on every model call. — [server/ask/askService.mjs:42-45](cesium-poc/server/ask/askService.mjs), [server/ask/orchestrator.mjs:322](cesium-poc/server/ask/orchestrator.mjs), [server/ask/orchestrator.mjs:335](cesium-poc/server/ask/orchestrator.mjs)
- **The system prompt varies only by persona** (one cached prompt per persona). — [server/ask/askService.mjs:47-55](cesium-poc/server/ask/askService.mjs)
- **The class check is about loading, not access**: `check()` in twinStore refuses only unknown, not-ready or stale classes. — [server/ask/twinStore.mjs:200-211](cesium-poc/server/ask/twinStore.mjs)

### Inferences
- The plumbing for per-request scoping already exists. The envelope is extensible, `system` is already a function of the envelope, and `tools.run` is a single choke point. Scoping is a moderate change, not an architectural one.

### Gaps
- None found.

---

## Q5. Personas (PERSONA_PLAYBOOKS)

### Takeaway
The three personas are tmc_operator, maintenance_manager and safety_engineer. They change only prompt emphasis and starter questions, not data access. There is no executive or finance persona.

### Cited Findings
- "What each demo persona cares about. Wording only steers emphasis and the order of the answer; the tools, the data and the rules are the same for everyone." — [server/ask/prompt.mjs:40-48](cesium-poc/server/ask/prompt.mjs)
- Starter questions per persona: [src/askTheTwin.js:36-40](cesium-poc/src/askTheTwin.js)
- The persona whitelist covers only those 3: [server/ask/envelope.mjs:15](cesium-poc/server/ask/envelope.mjs)

### Inferences
- An "executive" persona could be added cheaply (one playbook line, one select option, one whitelist entry). On its own it would not deliver Dan's point, because the data would stay the same.

### Gaps
- None found.

---

## Q6. Existing multi-criteria scoring that could power a switchable-criteria ranking

### Takeaway
Three weighted, config-driven scorers already exist. The closest pattern is UC1's `scoreWindow`: revenue, delay, safety and crew weights, normalised, with weights editable at runtime through trust-panel sliders. None of them ranks *assets or sites*, and none is exposed to Ask the Twin. The Ask insights rank only incidents (TMC) and road sections (crashes).

### Cited Findings
- **UC1 `scoreWindow`**: Score = w1·R̂ + w2·delay + w3·Ê + w4·crew, each term normalised by a reference from config. Weights live in `config/windowConfig.json:9-14`. The trust panel mutates a clone of the config at runtime (sliders, `src/trustPanel.js:25-31`, `:66`). — [src/windowEval.js:211-224](cesium-poc/src/windowEval.js)
- **Asset risk (`scoringConfig.json` / `scoringA.js`)**:
  - Weights: ageRatio 0.28, openTickets 0.2, recentWorkorders 0.16, manufacturerEol 0.16, exposureFactor 0.1, overdueInspection 0.1.
  - Bands: red at 0.62 or above, amber at 0.40 or above.
  - It is used by the NTTA/UC1 entry (`main.js`, `assetLayer.js`, `assetBrowser.js`), not by `i595Demo.js`. dataGuide only *describes* it (`config/askTwin/dataGuide.json:95`).
  - Its inputs (install date, EOL) are null for i595 registry cameras (Q3).
  - Source: [src/scoringConfig.json:1-30](cesium-poc/src/scoringConfig.json), [src/scoringA.js:1-20](cesium-poc/src/scoringA.js)
- **TMC secondary-incident risk**: rule-based, with weights "stated openly so they can be argued with and changed in one place" (`SECONDARY_RISK_CONFIG`). It ranks incidents, not assets, and is exposed through `rank_incidents` and `explain_incident`. — [src/tmc/secondaryIncidentRisk.js:25-40](cesium-poc/src/tmc/secondaryIncidentRisk.js), [server/ask/insights.mjs:170-185](cesium-poc/server/ask/insights.mjs)
- **crash_hotspots and weather_risk_forecast**: these rank FDOT sections by crash counts and the wet share of crashes. — [server/ask/insights.mjs:187-240](cesium-poc/server/ask/insights.mjs)
- **The insight output pattern** is `{output, source, summary}` with `gaps` and `notEvaluated`. It is rendered to a table block in answerBlocks with per-row map locations. — [server/ask/insights.mjs:12-13](cesium-poc/server/ask/insights.mjs), [server/ask/answerBlocks.mjs:42-51](cesium-poc/server/ask/answerBlocks.mjs)
- **Maintenance workspace**: it derives "Assets at risk" from failed inspections, open high-priority WOs and live damage. It is a count, not a weighted rank. — [src/maintenance/maintenanceWorkspace.js:31-34](cesium-poc/src/maintenance/maintenanceWorkspace.js)

### Inferences
- A `prioritize_sites` insight should copy the `scoreWindow` shape: per-criterion normalised components, weights from config, a `criteria` input of FIFO age, distance, revenue impact, open-WO priority and inspection risk, and output of rank plus per-criterion contributions. It would then be a natural "glass-box" answer, with a table block showing the rank under each criterion set.

### Gaps
- None found.

---

## Q7. Cross-silo joins: can current tools join camera asset → open WOs → nearby incidents → transactions?

### Takeaway
No tool joins classes. The model has to chain single-class lookups itself. Filters support only `equals` and `contains`, at most 5 per call (AND only), with no not-equals, range, date or sort options. Results are capped at 50 records and 25 groups. Transactions do not exist to join to.

### Cited Findings
- **Operators**: `OPERATORS = ['equals', 'contains']`. MAX_LIMIT is 50 and MAX_GROUPS is 25. — [server/ask/twinStore.mjs:55-59](cesium-poc/server/ask/twinStore.mjs)
- **WHERE builder**: AND of filters on JSON fields. Unknown fields are refused, with no OR, negation or range. — [server/ask/twinStore.mjs:214-234](cesium-poc/server/ask/twinStore.mjs)
- **Filter schema**: maxItems 5, enum of the operators. — [server/ask/tools.mjs:27-34](cesium-poc/server/ask/tools.mjs)
- **query_records and count_records** take one `class_name` each. count supports one `group_by`. — [server/ask/tools.mjs:43-61](cesium-poc/server/ask/tools.mjs), [server/ask/twinStore.mjs:251-282](cesium-poc/server/ask/twinStore.mjs)
- **records_near** is the only cross-source operation: layer feature(s) as anchor → records of one class within at most 3 km. It needs record coordinates, so Work Orders (no lon/lat in the snapshot spec) are always reported as "unplaced". — [server/ask/tools.mjs:155-197](cesium-poc/server/ask/tools.mjs), [server/ask/twinStore.mjs:45-46](cesium-poc/server/ask/twinStore.mjs)
- **The orchestrator allows at most 6 rounds**, with parallel tool calls encouraged ("Request independent lookups together in one step"). — [server/ask/prompt.mjs:22](cesium-poc/server/ask/prompt.mjs), CLAUDE.md "tool-use loop (≤6 rounds)"
- **Join-key inconsistencies in the data**: WO and ticket `Asset ID` is numeric (11942) and matches the registry `Asset ID`. ITS inspection `asset_id` is "CCTV 5078" and matches the registry `Asset Description`. FL511 map `camera_id` matches neither. — profiling of the snapshot JSON files

### Inferences
- Asking the LLM to do a 4-hop join plus a weighted ranking in at most 6 rounds is exactly what the codebase's own rule forbids ("never rank incidents or estimate risk yourself", [server/ask/prompt.mjs:18](cesium-poc/server/ask/prompt.mjs)). The ranking should be a computed insight that does the joins in code.

### Gaps
- None found.

---

## Q8. Minimum changes to support (a)-(d)

### Takeaway
All four pieces fit the existing architecture with no new frameworks. Roughly: one envelope field, one source registry, per-request filtering of tool definitions and store summary, one synthetic revenue layer and config, and one new insight tool with an answer block. The main design risk is honesty: the revenue data must be badged synthetic, and gaps must be declared per the "state the gap" convention.

### Cited Findings (anchors for each change)
- **(a) Data-sources toggle UI, sent with each question**:
  - Add a checkbox group to the settings panel ([src/askTheTwin.js:127-139](cesium-poc/src/askTheTwin.js)), or as context chips ([src/askTheTwin.js:1224-1234](cesium-poc/src/askTheTwin.js)).
  - Persist it as a per-viewer preference in `askTwinDock` settings ([src/askTwinDock.js:18-31](cesium-poc/src/askTwinDock.js)).
  - Add `screen.sources: ['maintenance','safety','traffic','finance']` in `screenSnapshot()` ([src/askTheTwin.js:1207-1217](cesium-poc/src/askTheTwin.js)).
  - Optionally seed the defaults from mapLayerStore state (for example the gantries layer on → finance) through `stateOf` ([src/mapLayerStore.js:126](cesium-poc/src/mapLayerStore.js)).
- **(b) Server-side scoping**:
  - Whitelist `sources` in `sanitizeScreen` ([server/ask/envelope.mjs:53-72](cesium-poc/server/ask/envelope.mjs)) against a new source→{classes, layers, tools} map. Its natural home is `config/askTwin/dataGuide.json` or a new `config/askTwin/sources.json`, per the config-driven convention.
  - Key the cached prompt by persona plus sources ([server/ask/askService.mjs:47-55](cesium-poc/server/ask/askService.mjs)) and pass only the selected classes into `storeSummary` ([server/ask/prompt.mjs:51-64](cesium-poc/server/ask/prompt.mjs)).
  - In the orchestrator, filter `tools.definitions` per envelope ([server/ask/orchestrator.mjs:322](cesium-poc/server/ask/orchestrator.mjs), [:335](cesium-poc/server/ask/orchestrator.mjs)).
  - Enforce in `tools.run` ([server/ask/tools.mjs:219-229](cesium-poc/server/ask/tools.mjs)) by rejecting a class_name or layer outside the scope with a typed `{gap:{type:'out_of_scope'}}`, so answers say "finance data is toggled off" rather than "none".
  - Update the PERSONAS comment and the settings note, which currently promise identical data for all ([server/ask/envelope.mjs:11-14](cesium-poc/server/ask/envelope.mjs), [src/askTheTwin.js:138](cesium-poc/src/askTheTwin.js)).
- **(c) Transactions/revenue source (synthetic)**:
  - No real data exists (Q2). The minimal option is a synthetic class or layer keyed to the 10 express gantries (`gantry_id`), with hourly or daily transactions, `toll_rate_usd`, `revenue_usd` and `synthetic: true`.
  - Add a camera→gantry (or site→gantry) dependency mapping so each camera site gets a revenue exposure.
  - The three camera sites are about 3-4 km from the nearest gantry and on one AADT segment (Q2 inference), so the mapping must be explicit.
  - It could load through `SNAPSHOT_CLASSES` as a new JSON file ([server/ask/twinStore.mjs:36-53](cesium-poc/server/ask/twinStore.mjs)) or as a layer in `ASK_LAYER_FILES` ([server/liveDc/dataDictionary.mjs:19-22](cesium-poc/server/liveDc/dataDictionary.mjs)).
  - It needs a `dataGuide.json` entry, because a class or layer without one fails the build/test (CLAUDE.md; [config/askTwin/dataGuide.json](cesium-poc/config/askTwin/dataGuide.json) `$comment`).
  - Reuse UC1 knobs where possible: `tollRateUsd` and the uncertainty band in [config/windowConfig.json:6-7](cesium-poc/config/windowConfig.json), the demand shape in [config/demandProfile.json](cesium-poc/config/demandProfile.json), and the missed-read model in [src/assetOps.js:11-24](cesium-poc/src/assetOps.js).
  - It must never be written to DataConnect historical classes (CLAUDE.md).
- **(d) Ranking insight with selectable criteria**:
  - Add `prioritize_sites` to `INSIGHT_DEFINITIONS` ([server/ask/insights.mjs:318-340](cesium-poc/server/ask/insights.mjs)) with input `{asset_type:'Camera', criteria:['fifo','distance','revenue',…], from?:{lon,lat}|depot_id}`.
  - In code it joins registry → open WOs (by Asset ID) → ITS inspections (by description) → revenue exposure, and scores with weights from config, following the `scoreWindow` pattern ([src/windowEval.js:211-224](cesium-poc/src/windowEval.js)).
  - It returns the rank with and without revenue and per-criterion contributions. Missing criteria (for example distance with no depot) go in `notEvaluated`.
  - Add a `case 'prioritize_sites'` table block in [server/ask/answerBlocks.mjs:21-70](cesium-poc/server/ask/answerBlocks.mjs), and a prefetch rule ("prioriti[sz]e|which first|replace") in [server/ask/prefetch.mjs:25-50](cesium-poc/server/ask/prefetch.mjs) that passes `screen.sources` so the ranking includes revenue only when finance is toggled on.
  - Add depot/crew coordinates in a config file to make "closest" meaningful.
  - Tests to extend: `tests/liveDcAskTwin.test.mjs` and `tests/liveDcAskTools.test.mjs` (CLAUDE.md), plus `config/askTwin/evals.json` (eval set).

### Inferences
- Rough sizing (my estimate, not from code):
  - (a) and (b) are small to medium, about 150-250 lines plus tests. The hooks exist.
  - (c) is mostly data authoring plus a dataGuide entry.
  - (d) is the largest piece, at about 200-300 lines plus tests.
- The demo story works with existing real data for the maintenance side: 3 camera sites with open WOs and FIFO dates 2024-08-21, 2025-01-17 and 2025-05-07. Only the revenue side is synthetic.
- If the three sites are kept, FIFO order would be CCTV 5078 → 5075 → 5079. The synthetic revenue mapping can then be authored to reorder them for the executive view. That authoring choice must be disclosed as demo data.

### Gaps
- No product decision exists in the repo on whether source toggles are a UX convenience or an access control. The current comments tie access control to "real sign-in", which does not exist yet.
- No I-595 Express transaction or toll-rate data exists. Real numbers would need a customer or FDOT/FTE data source, which is outside this repo.
