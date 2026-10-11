# Ask the Twin — reference architecture (Phase 2 "Why" layer) — design

**Date:** 2026-10-11 · **Status:** draft (brainstorming with user; not yet approved) · **Scope:** architecture
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
3. **An MCP-shaped modular monolith.** Domain logic is written as MCP servers using MCP tool shapes and the
   official SDK, but **run in-process** with the orchestrator over the in-memory transport. Moving a server to
   its own deployment, or to Bentley hosting, then means changing the transport, not the code.
4. **The UI exposes no tools.** The browser sends *context in* (a screen snapshot) and receives
   *actions out* (`answer.actions[]`, checked against a client action registry before running). Business
   logic moves out of the browser into `i595-insights`. Pure modules such as `src/tmc/*` are shared by the
   browser and the server, never duplicated.
5. **The role comes from identity checked on the server, never from the browser.** Screen context is useful
   but untrusted.

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

## Open questions

1. Will ACS open the GitHub Pages URL or the EC2-served URL? This decides same-origin cookie auth vs.
   token + CORS.
2. Does Bentley have, or plan, MCP servers for iTwin or DataConnect? If yes, `i595-data` builds on them.
3. How much of `src/tmc/*` is pure (no Cesium or DOM imports)? This sets the cost of moving it to
   `i595-insights`.
4. Personas for Phase 1 (proposed: TMC operator, maintenance manager, safety engineer, maybe an executive),
   and the one forecasting / risk-mitigation scenario (proposed: weather-driven crash risk for the next 6 h,
   with patrol pre-positioning).
5. Identity for the POC: real sign-in vs. a persona switcher.
