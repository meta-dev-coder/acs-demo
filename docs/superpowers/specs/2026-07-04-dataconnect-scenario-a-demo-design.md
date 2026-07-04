# DataConnect-backed Scenario A demo in the Cesium twin — design

**Date:** 2026-07-04 · **Status:** approved (user, this date) · **Scope:** plan/spec only; implementation gated on a separate go-ahead.

## Goal

Demonstrate Scenario A (asset condition scoring, today a synthetic-JSON demo in the root iTwin app)
running in the CesiumJS twin (`cesium-poc/`) with its data **fetched over DataConnect's real API
protocol** — not hardcoded, not file-loaded. The demo must be honest: the client speaks the same
endpoints and JSON envelope as the production Cohesive/Bentley DataConnect instance, so pointing it
at the real instance when credentials arrive is a base-URL + credentials change, with no code
deleted.

Grounding: deep-research report `~/.claude/tmp/scenario-a1-dataconnect-research.md` (11 verified
findings) and the DataConnect API surface extracted from the live demo instance
(`dataconnect-demo-dqa3.cohesivecloud.app`): `POST /api/authenticate` (JWT + refresh),
`POST /api/data-mgmt/v1/curated-data/search` (class-based, paginated), `GET /api/data-mgmt/v1/class`.
Data endpoints verified 401 without auth. **Assumption: no credentials yet** (asked, unanswered;
401s verified). If credentials exist, Phase-2 wiring in this design activates immediately.

## Approach (chosen: shim-first, swap-ready)

Rejected alternatives: live-only via proxy (blocked on credentials — becomes Phase 2 of this
design); static snapshot JSON (is exactly the file-based pattern the demo must move away from).

## Components

1. **Data prep — `tools/dataconnect_export.py`** (new, python, run once, output committed)
   - Reads `V5_Demo_Package_Enriched.xlsx` (path via CLI arg), writes `tools/dataconnect-data/<class>.json`
     for: Asset Registry, Work Orders, Tasks, Tickets, Safety/Roadway/ITS Inspections, Incidents.
   - Coordinate remediation: longitudes missing decimal points (e.g. `-80329552`) repaired by
     magnitude heuristic; sign-flipped longitudes (`+80.32`) negated; rows still out of corridor
     bounds (lon −80.5..−80.0, lat 25.9..26.3) quarantined to `<class>.rejected.json` with reasons.
     Counts printed.
2. **Shim — `tools/dataconnect_shim.py`** (new, python stdlib http.server, port 8787, ~100 lines)
   - `POST /api/authenticate` → `{token, refreshToken}` (JWT-shaped, any demo credentials accepted).
   - `GET /api/data-mgmt/v1/class` → class list.
   - `POST /api/data-mgmt/v1/curated-data/search` → `{items, page, pageSize, total}` with class
     name, pagination, optional field filters. 401 without Bearer token — exercises the client's
     auth path.
   - JSON envelope mirrors what the production bundle implies; envelope details are **inferred, not
     documented** — isolated in one translation function in the client so a mismatch with the real
     instance is a one-function fix.
   - CORS: `Access-Control-Allow-Origin: *` + preflight.
3. **Client — `cesium-poc/src/dataconnect.js`** (new, plain JS, matches repo idiom)
   - `login(baseUrl, user, pass)`, `fetchClass(name, {pageSize})` with pagination loop; 15 s
     timeout per request; token refresh on 401-once-then-fail.
   - Base URL: `?dc=` query param → else `http://localhost:8787`. Credentials: `?dcuser=`/`?dcpass=`
     or demo defaults (shim accepts anything; real instance gets real values).
   - Failure semantics: keep-previous-on-failure (repo pattern) — layer keeps last good data,
     HUD badge flips to "DataConnect: offline".
4. **Scoring — `cesium-poc/src/scoringA.js`** (ported from `src/scenarioA/scoring.ts`)
   - Logic and `scoringConfig.json` copied verbatim (types stripped). No math changes. Maps
     DataConnect Asset Registry fields → `RawAsset` shape in one adapter function; inspections /
     work-order counts joined by Asset ID feed the scoring inputs where the config expects them.
5. **Visualization — `cesium-poc/src/assetLayer.js`** (new)
   - One `PointPrimitiveCollection`; all ~5,022 points added before first render update (research
     finding: O(n) buffer rewrite per add — bulk-add then render). Color by risk band
     (red/amber/green), `scaleByDistance` for legibility, `translucencyByDistance` off.
   - Picking: click → info panel (existing HUD panel style) with asset fields, score breakdown
     (per-factor contributions from the engine), related work-order/inspection/incident counts.
   - HUD: "Assets (DataConnect)" toggle button; KPI row — count per band, top-risk asset id+score.
     Tag entities/primitives so existing e2e `counts()` queries ignore them (same rule as cones).
6. **Out of scope (explicit):** writing scores back into DataConnect's Condition History class
   (research Phase 3); BFF/token-handler for production hosting (Phase 2, needed before the
   deployed Pages site can talk to the real instance — a static SPA must not hold real refresh
   tokens); any root-app changes; any master-branch involvement.

## Data flow

`xlsx → dataconnect_export.py → tools/dataconnect-data/*.json → dataconnect_shim.py (:8787)
→ dataconnect.js (login → paginated fetchClass) → adapter → scoringA.js → assetLayer.js
(PointPrimitiveCollection + HUD KPIs)`. Swap `?dc=https://dataconnect-demo-dqa3.cohesivecloud.app`
+ real credentials → same client, same adapter, live instance (CORS permitting; if the real
instance blocks browser origins, the Phase-2 proxy slots between client and instance with no
client change beyond base URL).

## Error handling

- Shim/instance unreachable or timeout: badge "DataConnect: offline", previous layer data kept.
- Auth failure: badge "DataConnect: auth failed" (distinct from offline).
- Malformed/quarantined rows: skipped, counted, count surfaced in the info panel footer.
- Pagination never loops forever: hard cap `total`-driven with a 100-page guard.

## Testing

- `tools/test_dataconnect_shim.py`: auth required (401 without token), pagination math, envelope
  fields, filter behavior. Plain-script style like `sumo/test_*.py`.
- New e2e `cesium-poc/e2e/dataconnect-assets.spec.ts`: spawns the shim itself in `test.beforeAll`
  (child_process, killed in `afterAll`) — playwright.config's single `webServer` entry stays
  vite-only. Loads app with `?dc=http://localhost:8787`, asserts: layer toggle on → ≥5,000 points, all
  three band colors present, KPI counts sum to point count, pick opens panel with score breakdown,
  shim killed → badge flips offline and points remain.
- Existing 11 spec files stay green (asset layer tagged out of `counts()`); `npx vite build` green.
- Run pattern: single spec files only (session rule).

## Demo script (2 min)

1. Open twin, toggle "Assets (DataConnect)" → 5k scored assets ride the corridor.
2. Click a red asset → score breakdown + its work orders/inspections (the "context → decision" beat).
3. Kill the shim live → badge flips, layer survives (resilience beat).
4. Close: "same client, one URL swap to the production DataConnect instance."
