# Ask the Twin orchestrator (`server/ask/`)

The backend for free-form Ask the Twin questions, independent of where it is hosted. The design is
in `docs/superpowers/specs/2026-10-11-ask-the-twin-architecture-design.md`. This folder is build
step 1 of that spec, done locally first.

| File | Role |
|---|---|
| `envelope.mjs` | Cleans up the browser's request: question, plain-text history (capped), screen snapshot (known fields only). The browser is context, never authority. |
| `orchestrator.mjs` | The bounded tool loop (rounds, per-tool and run deadlines). It computes `sources`, `confidence` and map-action provenance from this turn's tool results, emits progress events and writes one JSON log line per turn. |
| `modelProvider.mjs` | The real model through `@anthropic-ai/sdk`, plus **replay** (recorded responses: offline, free, deterministic) and **recording**. |
| `tools.mjs` | Read-only tools: `describe_store`, `query_records`, `count_records`, `records_near` (records around a point or a named place), `list_live_events`, `find_corridor_features`, `get_weather`. Each returns its source; a missing or stale table is a typed gap, never an empty list. |
| `twinStore.mjs` | The SQLite read model (`node:sqlite`) with `store_meta`, atomic rebuilds and read-only opening. |
| `httpAdapter.mjs` | `POST /api/i595/ask`: Server-Sent Events for `Accept: text/event-stream` (with heartbeats), otherwise one JSON answer. A client disconnect aborts the run. |
| `localAsk.mjs` | Environment wiring for `npm run dev` (mounted by `vite.config.js`) and `npm run ask:serve`. |
| `dataConnectPull.mjs` | Read-only pull of every SDNA live class and every historical class, compacted into the store (`npm run twin:store:dc`). |
| `evalGrade.mjs` | Grades a run against a verified question (`config/askTwin/evals.json`, `npm run ask:eval`). |
| `answerBlocks.mjs` | KPI/bars/table/trend blocks and evidence records, copied from the lookups an answer cites. |
| `spendGuard.mjs` | Daily token budget (`ASK_TWIN_DAILY_TOKENS`). |
| `askProxy.mjs` | live-dc forwards the ask route to `live-dc-ask.service` (`ASK_TWIN_SERVICE_URL`). |
| `sources.mjs` | Per-question data-source scope (`config/askTwin/sources.json`): refusals, scoped prompt, used/excluded in answers. |
| `prioritize.mjs` | `prioritize_sites`: switchable-criteria site ranking (FIFO, distance, inspection, priority, revenue) with presets. |
| `storeRefresh.mjs` | Keeps the store current: live classes every 5 min, historical daily, atomic swap and reopen; a failed refresh keeps the last good store. |

## Run it locally

```bash
npm install
npm run twin:store          # optional: the dev route builds the store on first use anyway
npm run twin:store:dc       # optional: the store from DataConnect (SDNA live + historical), read-only
npm run ask:serve           # optional: the service as its own process on 127.0.0.1:8787 (what EC2 will run);
                            #   then ASK_TWIN_SERVICE_URL=http://127.0.0.1:8787 npm run dev
# .env.local, one of:
#   ASK_TWIN_ANTHROPIC_SECRET_NAME=i595/anthropic-key   (key from AWS Secrets Manager, as on EC2;
#                                                        needs the aws CLI and an AWS login first)
#   ANTHROPIC_API_KEY=…
#   ASK_TWIN_REPLAY=<recordings.json>                   (offline answers)
# ASK_TWIN_MODEL=claude-sonnet-5  LIVE_DC_AWS_REGION=us-east-1  AWS_PROFILE=<profile, if not default>
npm run dev                 # http://localhost:5188/?demo=i595, open Ask the Twin
```

Dev builds call `/api/i595/ask` on the dev server. Built bundles keep `VITE_ASK_THE_TWIN_API` or the
deployed service.

Watch the stream directly:

```bash
curl -N -X POST localhost:5188/api/i595/ask -H 'accept: text/event-stream' \
  -H 'content-type: application/json' -d '{"question":"How many incidents happened in light rain?"}'
```

**Record once, replay forever.** Set `ANTHROPIC_API_KEY` and `ASK_TWIN_RECORD=.twin-store/rec.json`, ask
your questions, then switch to `ASK_TWIN_REPLAY=.twin-store/rec.json` and drop the key. Replay keys
ignore the screen block, so a recording replays wherever the camera is.

Nothing here writes to DataConnect.

## What is built

- **Panel** (`src/askTheTwin.js`, `askTwinDock.js`, `askTwinActivity.js`):
  - docked on the right, resizable, with a reading mode;
  - a live activity log per answer, showing the context sent, each model round with its tokens, each lookup
    with its ref, and the checks;
  - cited claims, stated gaps and the confidence reason;
  - context chips, a demo persona and settings;
  - auto-run with suppression rules, and Restore view;
  - an Accept/Reject card for playbook recommendations, plus a disabled "Send to dispatch · planned" button.
- **Insight tools** (`insights.mjs`), run first when `prefetch.mjs` recognises the intent:
  - `explain_incident` and `rank_incidents`, using the TMC risk model;
  - `crash_hotspots`, with crashes placed on FDOT sections;
  - `weather_risk_forecast`, with a baseline and playbook rule P-WX-1.
- **The same service on EC2** (`askService.mjs`, wired in `demoServer.mjs`) on Node 22.5+, with a legacy fallback.

## Not done yet (see the spec's build order)

- **EC2:** nothing is deployed. The plan, the packages and the local verification steps are in
  `deploy/ec2/ASK_THE_TWIN.md`. The phase 2 proxy and unit are not built yet.
- **Historical replay** in `explain_incident`. Today it reports a gap and points to the TMC screen.
- **Real sign-in.** Personas only steer emphasis.
- **The full Twin UI API registry** (commands, flows, Cmd-K). Answer actions still use the existing fly and show
  helpers.
