# Ask the Twin orchestrator (`server/ask/`)

The backend for free-form Ask the Twin questions, independent of where it is hosted. The design is
in `docs/superpowers/specs/2026-10-11-ask-the-twin-architecture-design.md`. This folder is build
step 1 of that spec, done locally first.

| File | Role |
|---|---|
| `envelope.mjs` | Cleans up the browser's request: question, plain-text history (capped), screen snapshot (known fields only). The browser is context, never authority. |
| `orchestrator.mjs` | The bounded tool loop (rounds, per-tool and run deadlines). It computes `sources`, `confidence` and map-action provenance from this turn's tool results, emits progress events and writes one JSON log line per turn. |
| `modelProvider.mjs` | The real model through `@anthropic-ai/sdk`, plus **replay** (recorded responses: offline, free, deterministic) and **recording**. |
| `tools.mjs` | Read-only tools: `describe_store`, `query_records`, `count_records`, `list_live_events`, `find_corridor_features`, `get_weather`. Each returns its source; a missing or stale table is a typed gap, never an empty list. |
| `twinStore.mjs` | The SQLite read model (`node:sqlite`) with `store_meta`, atomic rebuilds and read-only opening. |
| `httpAdapter.mjs` | `POST /api/i595/ask`: Server-Sent Events for `Accept: text/event-stream` (with heartbeats), otherwise one JSON answer. A client disconnect aborts the run. |
| `localAsk.mjs` | Environment wiring for `npm run dev` (mounted by `vite.config.js`). |

## Run it locally

```bash
npm install
npm run twin:store          # optional: the dev route builds the store on first use anyway
# .env.local: ANTHROPIC_API_KEY=…  (or ASK_TWIN_REPLAY=<recordings.json> for offline answers)
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

## Not done yet (see the spec's build order)

- The EC2 demo host still uses `server/liveDc/askTwin.mjs`. Moving it onto this orchestrator, as a
  separate `live-dc-ask.service`, comes next.
- The store is built from the committed snapshot. A read-only DataConnect pull and the live-table
  feed from the EC2 sync are still to come.
- `explain_incident` (the insight tool that runs before the model), answer blocks, auto-run rules and
  the docked panel are later steps.
