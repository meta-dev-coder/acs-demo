# Ask the Twin — reference architecture (Phase 2 "Why" layer) — design

**Date:** 2026-10-11 · **Status:** draft v2: research and adversarial review applied; awaiting user approval · **Scope:** architecture
only; implementation gated on a separate go-ahead. · **Branch:** `askthetwin`

## Why now

Feedback from the October 2026 ACS demo (Robert Finley, Bentley) sets up the POC in two phases. Phase 1
covers personas and problems ("what & where"). Phase 2 covers intelligence, insights and Ask the Twin ("why"):
quality insights across DataConnect silos combined with weather and traffic, LLM context, navigation to
hotspots, and at least one risk-mitigation, forecasting or opportunity scenario. Automated workflows can be
**discussed** but are not part of the POC.

Today Ask the Twin has two backends that have drifted apart:

- `infra/lambdas/ask-the-twin`: no tools, DynamoDB events, hardcoded model.
- `server/liveDc/askTwin.mjs`: tool loop on EC2.

The browser also does the business logic: the TMC risk ranking and the patrol simulation are matched by
regex in the browser. This design replaces that with a structure that new panels, data sources and hosts
can extend.

## Decisions so far

1. **Host: EC2 only for the POC.** Retire the Lambda path (`AskTheTwinFn` in `infra/lib/i595-stack.ts`,
   `VITE_ASK_THE_TWIN_API` in `.github/workflows/deploy.yml`) so only one backend exists. Lambda's timeout
   was not the real constraint (Lambda allows 15 min). CloudFront's origin timeout is, and it applies to EC2
   behind CloudFront too, so responses **stream** either way. Conditions:
   - HTTPS in front (the Pages demo is HTTPS, so plain-HTTP calls are blocked as mixed content);
   - Ask the Twin in its own process or instance, separate from the DataConnect sync (today they share one
     512 MB process on an instance shared with another app);
   - a decision on same-origin vs cross-origin access (open question 1).
2. **The core is independent of the host.** One pure core with thin host adapters. The existing
   `createAskHandler` dependency injection is the starting point; `demoHost.mjs` becomes the EC2 adapter.
3. **An MCP-shaped modular monolith** (POC: plain JS modules with MCP-shaped tool definitions; the MCP SDK
   and transport come after the POC). Domain logic is written as MCP servers using MCP tool shapes and the
   official SDK, but **run in-process** with the orchestrator over the in-memory transport. Moving a server to
   its own deployment, or to Bentley hosting, then means changing the transport, not the code.
4. **The UI exposes no tools.** The browser sends *context in* (a screen snapshot) and receives
   *actions out* (`answer.actions[]`, checked against a client action registry before running). Business
   logic moves out of the browser into `i595-insights`. Pure modules such as `src/tmc/*` are shared by the
   browser and the server, never duplicated.
5. **The role comes from identity checked on the server, never from the browser.** Screen context and the
   browser-held history are useful but untrusted. **POC:** the host has one shared password and its token
   carries no subject, so a persona is a *demo playbook and presentation hint* chosen in a switcher. It never
   grants tool authority, and every session gets the same read-only tool set. Real identity (subject + role
   in the signed token, a server-side session list for revocation) is a prerequisite for `i595-workflows`.
6. **Twin store: SQLite** through Node's built-in `node:sqlite`, so no dependency to install. It is
   verified on Node 22 with R-tree (spatial bounding boxes) and FTS5 (keyword search). Vectors are deferred
   (`sqlite-vec` later, only for free text and documents). `better-sqlite3` is the fallback if the
   experimental `node:sqlite` API changes.
7. **Twin UI API.** One registry of state providers, commands, events and flows. The human UI and Ask the
   Twin both go through it. It uses a contract plus a registry, not class inheritance.
8. **View-tier actions auto-run** as an answer streams, under these rules:
   - **Per-category setting** in the panel header: camera/highlight, layer toggles, filters.
   - **Fixed limits no setting can change:** state-tier actions ask unless opted in, and write-tier actions
     always ask.
   - **Every auto-run passes the client registry's checks** (e.g. the corridor-distance limit), because FL511
     and DataConnect text reaching the model is untrusted.
   - **Confidence is computed by the server** only from structured fields of this turn's tool results:
     distinct evidence refs cited by answer blocks (not rows returned), freshness measured against
     `clockFor(temporal)` (so historical replay is not penalised), and agreement with the screen's inputs
     signature. History and free text never count. Low confidence never auto-runs.
   - **Only insight-tool actions auto-run mid-stream** (they carry their own evidence and `as_of`).
     Model-proposed actions wait for the final confidence.
   - **Action targets must be ids or coordinates returned by a tool in this turn.** No exemption based on
     `sources`.
   - **Auto-run is suppressed** (the action becomes a "Fly there" chip) if, since the turn started, the user
     moved the camera or changed the selection, a TMC incident is under investigation, or the target no
     longer exists.
   - Actions that **reduce what is visible** (hide layer, narrowing filter, close panel) are state tier.
   - **Restore view** saves workspace, temporal mode, selection, filters, layers and camera from the state
     providers. It is offered for the latest turn only if the user ran no command since; older turns offer
     "go to this answer's view".
9. **Ask the Twin is a docked, resizable panel on the right side of the whole application**, not a
   floating widget.

## Architecture

```
 BROWSER                       ORCHESTRATOR (thin)                    MCP SERVERS (in-process for POC)
┌───────────────┐   envelope  ┌──────────────────────────┐   tools   ┌──────────────────────────┐
│ context in    │ ──────────► │ verify identity → role   │ ────────► │ i595-data                │
│ actions out   │ ◄────────── │ pick persona playbook    │           │  DataConnect, FL511,     │
│ answer cards  │   stream    │ Claude + tool loop       │           │  weather, GeoJSON        │
└───────────────┘             │ validate answer contract │ ────────► │ i595-insights            │
                              └──────────────────────────┘           │  risk, hotspots,         │
                                                                     │  forecasts, patrols      │
                                                                     │ i595-workflows (PLANNED, │
                                                                     │  out of POC scope)       │
                                                                     └──────────────────────────┘
```

### Request envelope (browser → orchestrator)

History is untrusted. The client sends prior turns as user and assistant text only, and the server caps it
at N turns and M bytes. The server drops any tool blocks and `proposal_id` in it. Badges, KPIs, trend values
and confidence bind only to this turn's server-side tool results. Deictics ("this one") are resolved once on
the server at turn start and echoed in the answer header ("About FL511-876564"). With no envelope, a deictic
question returns a typed gap. Evidence refs carry `as_of`, and a chip whose record has changed shows
"changed since".

`{ question, history, screen: { workspace, temporal, view: {bbox, zoom}, selection: {type, id}, area, panels: {…} } }`.
The browser keeps the conversation history. Each active panel contributes a small snapshot through a
registered context provider: ids, counts and the selection, never raw data. The model fetches details
through tools ("push a summary, let the model pull the rest").

### Prompt assembly (cache-friendly order: tools → system → messages)

1. Tools allowed for this role, in a fixed order. Above roughly 30 tools, rarely used ones become deferred
   and are found through tool search.
2. System: core rules, domain knowledge, answer contract.
3. Persona playbook (cached per persona).
4. Messages: history, then this turn's screen context and question (after the cache breakpoint).

### Answer contract

A `RunError` event after the first byte marks the turn incomplete, keeps the evidence already streamed, and
offers Restore view and Retry. On 429/529 the server retries once with jitter, then falls back to a
configured model or to the insight-only answer.

Streams progress events (tool started/finished, with its source silo), then the final answer:
headline, "why" points each tagged with a source declared by a tool (not written by the model), a
recommended action, `actions[]`, follow-up suggestions and a confidence level.

### Extension unit: the capability

A capability is a folder with optional parts: a context provider (browser), map actions (browser),
suggestions (browser), MCP tools (server, inside `i595-data` / `i595-insights`), a knowledge pack (server)
and evals (both). The browser discovers capabilities with `import.meta.glob` and the server through an
index. Adding a panel, data source or analysis means adding a folder, with no edits to the core.

Existing hardcoded versions this generalizes:

- `TOOL_DEFINITIONS` (`server/liveDc/askTools.mjs`) is the tool registry;
- `TWIN_ACTIONS` (`src/tmc/tmcAnswers.js`) is the action registry;
- `spatialContext` is a context provider;
- `suggestionsNow()` is the suggestion registry;
- `config/askTwin/dataGuide.json` is knowledge.

### Portability

| Moving… | Replace | Unchanged |
|---|---|---|
| EC2 → Lambda / Bentley-hosted compute | host adapter | everything else |
| DataConnect → iTwin APIs / other database | connector inside `i595-data` | tools, prompts |
| Anthropic API → Bedrock / Microsoft Foundry | model provider adapter | prompts, tools, loop |
| Reuse from Claude Desktop / Bentley agents | deploy an MCP server remotely (Messages API MCP connector, beta `mcp-client-2025-11-20`) | tool definitions |

## Twin store (SQLite)

DataConnect stays the system of record. A **sync job** keeps a local SQLite read model up to date. The app
does not load everything at startup.

- **Historical classes:** full refresh nightly or on demand, using the writer's existing paging `readAll`.
- **Live classes:** written by the EC2 live sync, the **only** DataConnect writer (the poller Lambda's schedule
  is retired along with `AskTheTwinFn`). SQLite holds **curated state only**: read-back plus confirmed
  overlay (`curatedKeys`), never unconfirmed upserts.
- **`store_meta`** table: `{table, as_of, cycle_id, row_count, status: loading|ready|stale|failed}`. Every tool
  returns a typed `not_ready` or `stale` gap instead of answering from an empty or old table. On an empty
  store, a historical refresh runs at startup, and `/healthz` reports store age.
- Refreshes load into staging tables and swap in one transaction. Derived tables are computed only from
  committed inputs and are stamped with `as_of`.
- WAL mode, one writer connection (the sync process); Ask opens the file read-only on the same host.
- The sync also caches current and forecast Open-Meteo weather per corridor section each cycle, so no tool
  calls a live upstream on the answer path.
- **Derived tables** are recomputed each cycle: crashes per segment × month × weather, asset risk, closure
  lane-hours. The TMC assessment is **not** read from a table cached for a whole cycle, because the screen's
  assessment depends on the viewer (temporal mode, weather fetched for the selection, a 60 s poll). The
  browser sends the input ids, temporal value and weather it assessed. The server runs `assessCorridor` per
  request from stored events and returns the inputs signature, and a mismatch renders a "screen and twin
  differ" gap.
- **Spatial:** an R-tree over the bounding box of each record, plus milepost columns for corridor-linear
  queries.
- **Text:** FTS5 over `root_cause`, issue summaries, inspection notes and FL511 descriptions.
- Tools use a `TwinStore` interface, so moving to Postgres + PostGIS (+ pgvector) at I-595 scale does not
  touch tools or prompts.
- Today's volume: about 9.6k historical rows (~7 MB). At 100× growth SQLite is still comfortable.
- **Open:** does DataConnect offer a modified-since filter or change feed? The code shows only
  `equals` / `contains`, sort and paging.

Model access to data comes in three tiers:
1. **Insight tools** (computed bundles, the default).
2. **Search tools** (FTS5 now, similarity later), always combined with SQL filters.
3. **Optional:** a guarded read-only SQL tool over curated views, with row and time limits, that shows its
   query in the answer.

## Twin UI API (`src/twin/`)

The twin's equivalent of Jira's REST API for Rovo: every capability of the UI is a registered, typed
operation.

1. **State providers.** `twin.provide(id, { describe, get })`. `describe()` returns a small snapshot (ids,
   selection, filters, temporal mode) that goes into the request envelope. `get(id)` returns details on
   demand.
2. **Commands.** `twin.command({ id, title, tier, input (JSON schema), available(ctx), run })`. `run` returns
   an `undo`. There are three tiers:
   - `view` (fly, highlight, pulse, open panel, show/hide layer): auto-runs, can be undone.
   - `state` (select, filter, narrow/hide, switch workspace, draw area, run a *simulation*): offered as
     one-click buttons (today's behaviour), never auto-run in the POC, can be undone.
   - `write`: never runs in the browser. It shows a confirmation card with a preview. Confirming sends the
     `proposal_id` to `i595-workflows` (see Planned).
3. **Events.** `selectionChanged`, `viewChanged`, `workspaceChanged`, `layerChanged`. These update context
   chips, suggestions and follow-up resolution ("this one").
4. **Flows.** Ordered command steps with narration, played by a flow runner (Next / Pause / Stop, undo
   the whole flow). They can be predefined (demo), composed by the model (each step validated), or later
   saved by the user.

The registry exports its command schemas to the server. That list is the complete set of actions Claude may
return. `available(ctx)` gates by role and screen for buttons and AI alike. The same registry also gives a
Cmd-K command palette, e2e tests that drive commands, and a session timeline.

**Migration:** wrap existing methods (`layerStore`, `assetExplorer`, `segments`, the `tmc` methods behind
`TWIN_ACTIONS`) as commands, then replace `runTmcAction`'s switch and the hand-written fly/show code in
`askTheTwin.js` with `twin.run(action)`.

## Ask the Twin panel (UI)

- **Docked on the right of the whole application**, full height, part of the layout (the map resizes; the
  panel does not cover it). It replaces the floating draggable widget. In TMC with an incident open, it
  shares the right column with the TMC panel as a tab, or defaults to the collapsed rail. The resize handle
  keeps at least 50% of the width for the map. Layout is verified at 1366 and 1440 px.
- **Resizable** with a drag handle, from a narrow chat width up to about half the screen. There is also an
  **expand** control for a reading mode where the panel takes most of the screen with the map as a strip,
  and **collapse** to a rail button. Width and mode are remembered per user (localStorage, per-viewer
  convenience only).
- **A document, not a bubble list.** It scrolls freely and each turn is a section: question, live activity,
  answer blocks. Earlier turns stay readable and linked to the map (clicking a past answer's entity flies
  there again).
- **Background activity is visible.** While an answer runs, the turn shows a live trace: tools started and
  finished, each with its source silo and duration, and actions run on the map. It collapses to one summary
  line ("5 sources · 3.2 s · 2 map actions") when done and can be expanded.
- **Context chips** above the input (`Incident FL511-876564 · Live · TMC operator`). They can be removed,
  and clicking a map feature adds one.
- **Settings in the panel header:** auto-run view actions (on by default), show the activity trace
  expanded/collapsed, and later the persona switcher if identity is not ready.

## Performance budget

Something visible in under 300 ms. First useful content (a headline or the map moving) in under 3 s. A
typical full answer in under 10 s. All are measured as p50/p95 per route against the golden question set.
The levers, in order:

0. **The insight tool runs before the model.** For a question with a selection or a recognised intent, the
   orchestrator calls `explain_incident` / `assessCorridor` before the first model round. Its verdict, KPIs
   and view actions stream within about 500 ms, and the model then writes the interpretation. `RunStarted`
   is sent before any upstream I/O, with no per-request live-events prefetch. Interactive routes are capped
   at 2 model rounds.

1. Fewer model rounds through large insight tools (`explain_incident` returns the whole bundle).
2. Tools read SQLite and derived tables, not DataConnect.
3. Stream progress, text and actions (insight-tool view actions run as soon as they are decided; others at
   the end of the answer).
4. Prompt caching on tools, system and persona playbook.
5. Prefetch the context bundle when an incident is selected.
6. The local fast path for plain commands.
7. Effort tuned per route, measured.

## Answer blocks

The model picks blocks from a fixed set and points them at tool results. It never types the numbers
shown in charts.

Block types:
- `verdict`, `kpis`, `evidence` (claim + ref + source), `trend`, `compare`, `ranked_list`, `timeline`;
- `actions` (command ids from the registry);
- `gaps` (data that is not available).

Rendering order is short-answer first: verdict, then KPIs, then evidence on demand. Each answer adds its own
map layer with a legend, cleared on the next question. Hovering an evidence row pulses the matching
feature. Trust signals: source chips, an "as of" time, and "computed by the twin" vs. "interpretation"
labels.

## Industry research (2026-10-11): what changed

Five research angles (twin vendors, transport operations, copilot platforms, structured-data grounding,
copilot UX); full findings are in the workflow output. Items are adopted in the order given in "POC build
order"; items listed there under "After the POC" are not needed for the demo.

**Confirmed precedents**

- **Cesium's own `cesiumjs-ai-starter-app`.** Same stack, same split (agent on the server, view tools
  streamed to and run in the browser). Cesium deprecated its earlier "browser as MCP server" design.
- **Bentley Copilot on Bentley MCP servers.** Marketing-level evidence.
- **FDOT SunGuide response plans.** The system drafts, the operator edits and presses Activate. That is
  our propose/commit model, in vocabulary District 4 operators already use.
- **USDOT Dallas US-75 ICM.** Pre-approved rule-based plans that the operator accepts or rejects.
- **Microsoft Fabric data agent.** Read-only, capped results, runs with the user's credentials.
- **dbt / Snowflake / Databricks.** Semantic layers and verified queries beat raw text-to-SQL on numeric
  accuracy, and fail in a way you can see.

**Panel and trust**

- Each turn records a view checkpoint and has **Restore view**.
- Activity-trace rows have states: started, running, awaiting-confirmation, done, error, denied/undone.
  Each row says whether it auto-ran, was clicked, or was skipped. A row expands to show its exact inputs and
  a result digest, and the trace can be copied as JSON.
- Stream event names follow **AG-UI** (RunStarted, ToolCallStart/Args/End/Result, …) instead of a home-made
  set.
- **Rendering order:** the verdict with inline reference chips and the recommended action, KPIs next to
  it, then evidence rows labelled Twin-computed or Interpretation. The trace is collapsed unless it is
  running or has an error. **Interpretation is visually subordinate.** The "Twin-computed" badge appears only
  when a block came directly from a named insight tool with its parameters shown. Those parameters can be
  edited, which re-runs the tool without the model. Everything else is labelled "Interpretation".
- Evidence chips open the source record or map feature, with the time window and filters of that answer.
  The verdict carries inline reference chips. Evidence rows have a "wrong data" feedback action.
- There is a **New conversation** control, because stale history skews answers.

**Grounding and tools**

- Evidence rows come back from tools as `search_result` blocks with stable sources
  (`tool:get_live_chain#ticket/…`), and API citations map to `evidence.ref`. Numbers in `kpis` and `trend`
  are resolved on the server from stored tool results.
- **Fail typed, never guess.** A question outside the curated metrics returns a typed error rendered as
  `gaps`. A question type that keeps missing becomes a new derived table, not a prompt tweak.
- Tool contract:
  - readable labels next to ids;
  - `response_format: concise|detailed`;
  - default row caps with a "narrow by segment/time" hint;
  - `describe_data` returns only the slice of the dictionary that is relevant.
- **Spatial questions only go through corridor-native parameters:** milepost range, carriageway, segment id,
  screen bbox, radius. The model never sees R-tree or spatial SQL.
- The optional SQL tool takes a **structured input**: `{view, measures[], dimensions[], filters[],
  time_range, bbox?}`. Free SQL stays off.
- Tools check deictic ids ("this incident") against `screen.selection`. The envelope may be absent (bridge
  calls, flows).
- Each capability folder has **`verified-questions.json`**: canonical question, the tool call that answers
  it, `verified_by` / `verified_at`, and an onboarding flag. It drives the starter chips, the few-shot
  examples in the playbook, and the numeric eval golden set (scored by exact match against the twin store).
- MCP tools carry `readOnlyHint` and other annotations. These are informative only; authority stays with the
  server-side role checks.

**Insights and the scenario**

- **Recommendations come from pre-approved playbooks** in `i595-insights`. The tool names the rule it used,
  and the UI shows Accept / Reject (including "stand down"). The model explains the choice and never writes
  the plan.
- **The single forecasting scenario: weather-driven crash risk for the next 6 h, with patrol
  pre-positioning.**
  - Inputs: historical crash register × weather per segment, month and time of day; the Open-Meteo
    forecast; live events.
  - **Upstream speed is declared as a gap.** There is no traffic-condition feed on this corridor, and the
    TMC replay is explicitly not a forecast.
  - **Baseline:** the historical crash rate per segment × time-of-day bucket × weather bucket, so the
    "Twin-computed" label is honest.
  - Severity and crash type, which FL511 often leaves blank, are not required.
- Tier rationale for ACS:
  - information gathering is automated (view actions);
  - decision selection is computed by the twin (the model never ranks);
  - action implementation is confirmed by a person (writes).

**Deferred:**
- aligning `actions[]` names with `@cesium-ai/tools` and sharing schemas between browser and server;
- explicit ontology relationships in `dataGuide.json` for graph-style traversal;
- MCP Apps `ui://` views for external hosts;
- SOP/TIM documents as retrievable citations;
- shift-handover and bulletin generation;
- an admin-owned supervised/autonomous setting per workflow, with proposals as records in a review queue;
- no arbitrary code execution, ever.

## Planned (out of POC scope): `i595-workflows`

Robert's "automated workflows", shown as the next step after the POC. It is the third MCP server, and the
**only** part of the system with write access. Everything else stays read-only.

**Principle: the model proposes, a person decides, the server executes.** No write happens because of
model output alone.

- **Two-step tools.** Each workflow has a `propose_*` tool that is read-only. It returns a draft plus a
  preview of exactly what would change, and a short-lived single-use `proposal_id`. The `commit` step is
  **never offered to the model**. It runs only from an explicit operator click on the confirmation card in
  the browser, which calls the orchestrator directly with the `proposal_id`.
- **Example workflows** (to be agreed with ACS against their actual operating processes):
  - draft a work order for an at-risk asset;
  - dispatch or pre-position a patrol;
  - open or close a live ticket;
  - schedule an inspection after an event clears;
  - bundle at-risk assets into a planned lane-closure window.
- **Prerequisites:** real identity (see Decision 5). Proposals are stored on the server as
  `{id, subject, role, payload_hash, source_versions, expiry}`, and commit sends only the id. The writer
  consumes an authenticated queue and re-checks role, the SDNA class allowlist and record versions. The
  internet-facing Ask process never holds write credentials.
- **Role-gated.** The verified role decides which `propose_*` tools are offered and who may commit.
  The server checks this again at commit time.
- **Write boundaries carried over from the live pipeline.** Writes go only to the `SDNA Florida I595 Live *`
  classes, never to the historical `Florida I595 *` classes (the existing writer already refuses these).
  The single-writer rule for DataConnect is preserved: workflows go through the same writer, or a queue it
  drains.
- **Safety properties:**
  - idempotency keys per proposal, so a double click commits once;
  - the proposal expires if the underlying record changed since the preview (optimistic check);
  - an audit record of who confirmed what, when, and the question and answer that led to it.
- **Discussion point for ACS:** which steps they would let run *without* confirmation later (for example,
  auto-opening a ticket for a new FL511 closure, which the live sync already does), and which must always
  have a person in the loop.

What the POC shows of this: the architecture slot, plus one *read-only* `propose_*` example rendered as a
confirmation card with a disabled "Commit (not in POC)" button. It's tangible in the demo, with no write path.

## Operational guardrails

- **The HTTPS path is a CloudFront custom origin to EC2:8095.** The origin uses HTTP; the security group is
  limited to CloudFront's origin-facing prefix list. The `/api/i595/ask` behaviour uses CachingDisabled, no
  compression and OriginReadTimeout 60.
- Streaming sends a heartbeat or progress event at least every 10 s. Each tool has a deadline of about 8 s,
  and the whole run about 45 s.
- **`live-dc-ask.service`** is a separate unit with these settings:
  - ReadWritePaths on the store directory;
  - its own MemoryMax and CPUQuota, sized against measured free RAM;
  - a shared session-signing key from Secrets Manager;
  - a **separate read-only DataConnect identity**, since only the sync/writer holds write credentials.
- At startup it warms the key, live class ids, layers and the prompt cache, and reports readiness in
  `/healthz`.
- **Rate limits:** the client IP is trusted only from `CloudFront-Viewer-Address`, and only with the origin
  secret header. Ask limits are keyed on the session id.
- **Cost:** per-session and global daily token budgets from API `usage`. When exceeded, the route falls back
  to the insight-only path. The Anthropic workspace has a spend limit. The model call and tools are aborted
  when the request closes.
- **Telemetry:** one JSON log line per turn: route, model, rounds, input/output/cache tokens, TTFB,
  first-content time, total time, and per-tool ms and status. An alarm fires on the daily token total.

## POC build order

1. **One streaming EC2 backend,** developed locally first (see "Local development and testing": dev host
   adapter, replay model adapter, snapshot store).
   - Retire `AskTheTwinFn`, the poller schedule and `VITE_ASK_THE_TWIN_API`.
   - Split out `live-dc-ask.service`; add the CloudFront origin with heartbeat, deadlines, telemetry and the
     token budget.

   *Exit:* the Pages build streams `RunStarted` in under 300 ms and a log line appears per turn.
2. **Curated SQLite read model with `store_meta`.**
   - The EC2 sync is the only writer; historical data loads with an atomic swap; weather is cached per
     section.
   - No R-tree, FTS5 or MCP SDK yet.

   *Exit:* tools return typed `not_ready` / `stale` gaps on an empty or old store.
3. **`explain_incident` insight tool.**
   - Imports `assessCorridor` and the live chain; confidence is computed by the server.
   - It runs before the first model round, with a cap of 2 rounds.

   *Exit:* headline under 3 s at p50, in live and replay.
4. **Map `actions[]` onto the existing `TWIN_ACTIONS` via `runTmcAction`.**
   - Use the explicit tier table and the auto-run suppression rules, plus full-state Restore view.

   *Exit:* an e2e run where the operator pans mid-stream and the camera does not move.
5. **Hotspot navigation** from the derived crash table, with corridor-native parameters.

   *Exit:* "fly to the worst wet-weather segment" lands correctly, with evidence stamped with `as_of`.
6. **The forecasting scenario,** with its baseline and a playbook rule offering Accept/Reject.

   *Exit:* the scripted demo question renders verdict, KPIs, baseline and factors, all Twin-computed.
7. **Panel and persona polish.**
   - The docked panel shares the right column with TMC; verdict-first rendering; history capped.
   - Demo-persona switcher; one read-only `propose_*` card with a disabled Commit button.

   *Exit:* the full demo script runs at 1366 and 1440 px.
8. **After the POC:**
   - Twin UI API registry and flows, Cmd-K, AG-UI naming;
   - MCP SDK and transport, capability glob discovery;
   - verified-questions eval harness, editable tool parameters;
   - FTS5 / R-tree and the structured SQL tool;
   - turn store, real identity, the workflows write path.

## Local development and testing

Everything below runs on a laptop. **Nothing local ever writes to DataConnect**, because EC2 is the single
writer.

1. **Offline (no keys, no network).** The model provider adapter has a **replay mode**: recorded Claude
   responses keyed by request, so the tool loop, answer blocks, confidence, envelope sanitising and auto-run
   rules are tested with `node --test`, deterministically and for free. The store builder has a
   **`--from-snapshot`** mode that builds the SQLite file from `public/dataconnect-data/*.json`, plus a
   fixture live feed (the existing `--feed <fixture.json>` pattern).
2. **`npm run dev` with the real model.** Vite mounts the same ask handler through a dev host adapter, so
   `/api/i595/ask` is same-origin and streams, as on EC2. The key comes from `ANTHROPIC_API_KEY` in
   `.env.local` (no `VITE_` prefix, so it never reaches the bundle). The store comes from the snapshot or
   from a **read-only DataConnect pull** using your own `npm run dc:login` token. The store builder has no
   write code path.
3. **The production shape locally.** Run the release bundle from `deploy/ec2/dist` as the two services do on
   EC2: a sync process in **read-only / no-write mode** (feeds the store from DataConnect read-back or a
   fixture), and the ask process with the password gate and the built web app. Check the stream with
   `curl -N`: `RunStarted` first, a heartbeat at least every 10 s, a `RunError` when an upstream is killed.
4. **E2E smoke and evals.** Playwright smoke scripts against localhost:5188 cover the demo questions, the
   case where a pan mid-stream stops auto-run, and Restore view. A golden-question eval runs against the
   real model under a token budget and reports p50/p95 timings from the per-turn log lines.

Not reproducible locally: CloudFront behaviour (verify on a staging behaviour before switching the demo
URL) and the EC2 memory/CPU limits (approximate with `systemd-run --scope -p MemoryMax=…` or a container
with the same limits).

## Open questions

1. Will ACS open the GitHub Pages URL or the EC2-served URL? This decides same-origin cookie auth vs.
   token + CORS.
2. ~~Does Bentley have or plan iTwin/DataConnect MCP servers?~~ **No iTwin or DataConnect MCP server is
   confirmed**, so `i595-data` is our own server. Research correction: Bentley *does* ship MCP servers
   (STAAD.Pro, MicroStation, with a portfolio rollout announced; an iTwin IoT MCP server is listed but
   unconfirmed), and Bentley Copilot uses them as its interface to applications. Our MCP-shaped servers
   follow the same pattern and can later sit beside Bentley's, or be called by Bentley Copilot.
3. ~~How much of `src/tmc/*` is pure?~~ **Answered (2026-10-11): almost all of it.** Of the 27 modules only
   three touch Cesium or the DOM: `tmcWorkspace.js` (the 4,300-line screen), `patrolMapLayer.js` and
   `upstreamProtectionMapLayer.js` (map drawing). `tmcMapMarkers.js` is drawing too. Everything else,
   including `tmcService.assessCorridor`, secondary risk, mitigation, patrol simulation and dispatch, upstream
   protection and historical location safety, is plain JS, and their shared imports outside `tmc/`
   (`carriagewayModel`, `operationalImpact`, `corridorPosition`, `crashRibbon`) are too. 135 TMC unit tests
   pass under Node. `i595-insights` can import these modules as they are.
   **Remaining risk: keeping the screen and the chat consistent.** `assessCorridor` is pure, but its
   *inputs* (live events, historical crash register, weather per incident, sections, cameras, signs,
   temporal mode) are gathered by `tmcWorkspace.js` at that moment. The server must load the same sources,
   and the envelope should carry the screen's temporal mode/date plus an input signature, so a chat answer
   never ranks a different set of incidents than the screen shows. Decide: the server loads its own inputs
   and checks against the screen's signature, or the browser sends the input ids it assessed.
4. Personas for Phase 1 (proposed: TMC operator, maintenance manager, safety engineer, maybe an executive),
   and the one forecasting / risk-mitigation scenario (proposed: weather-driven crash risk for the next 6 h,
   with patrol pre-positioning).
5. Identity for the POC: real sign-in vs. a persona switcher.
