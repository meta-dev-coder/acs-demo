# ACS I-595 Express — Operational Digital Twin (Demo)

A Bentley **iTwin Viewer** app that turns the published I-595 Express corridor into a **photoreal
operational twin** with predictive-maintenance and safety analytics, presented in a decision-support
dashboard. Built for the ACS pitch demo (collaboration with Bentley).

> Accuracy is not the bar — data is synthetic and shaped to read like I-595 Express (SunPass
> gantries, reversible median express lanes, the Turnpike connector). The point is a working,
> credible decision surface on the real Bentley geometry.
>
> **Note on scope:** this intentionally goes beyond the original `Tolling - ACS _ Scope.pdf` (which
> specified a bare, in-model, map-off twin). At the team's direction it adds an **aerial base map**,
> the **photoreal reality mesh**, and a **dashboard shell** to make it partnership-grade. The
> map/mesh are read-only context; the customer's model is never modified.

---

## What it does

**Shell** — top scenario tabs · left filterable, risk-sorted asset/segment **list** (click a row →
the viewer frames it) · center embedded **iTwin Viewer** (photoreal reality mesh + aerial base map)
· right **inspector** (follows selection) · bottom **KPI bar** · collapsible side panels · a
**guided tour** ("Take a tour").

**Scenario A — ITS Asset Failure Prediction.** Every roadside ITS asset (toll gantries, DMS, CCTV,
detectors, lane-control, access gates, ramp signals, lighting, cabinets) is shown as a
**green/amber/red risk pin** on the corridor. Click → inspector with predicted risk, drivers,
history, **last work order / age-vs-rated-life / condition**, and recommended action. Build a
**proactive work package** (lane closures avoided · crew hours saved · toll revenue protected).

**Scenario B — Safety Hotspot Predictor.** Corridor **segments** colored by safety risk (WorldOverlay
ribbons), a **pin on the top hotspot** (Express↔Turnpike connector), an incident card (count, type,
severity mix, closure impact, contributing factors), and a **Before/After countermeasure toggle**
that recolors the segment and shows crashes/closures avoided + revenue protected.

All weights, thresholds, recommended actions, and countermeasure effects live in
`src/scenarioA/config/scoringConfig.json`, `src/scenarioB/config/safetyConfig.json`, and
`src/scenarioB/data/countermeasures.json` — **nothing scoring-related is hardcoded**.

---

## Prerequisites

- **Node 22** (`.nvmrc` included): `nvm install 22 && nvm use 22`. (Node 24 can fail the iTwin toolchain.)

## Run (local)

```bash
nvm use 22
npm install
npm start                 # http://localhost:3000  (sign in as Mike)
# or auto-restarting dev server with live reload:
bash scripts/dev.sh
```

In the browser console you can run Phase-0 discovery against the loaded model:

```js
await __acsDiscovery()    // ECClasses / categories / labels / extents — confirms assets are
                          // point inventory (markers) vs. discrete elements
```

## Test

```bash
npm test                  # vitest — placement geometry + risk scoring (no auth / model needed)
```

## Step 0 — access & the replica (one-time)

The app must only ever open a **copy** of the customer's model. See **[scripts/REPLICA.md](scripts/REPLICA.md)**.
The copy is made with the transformer (`scripts/transformer/transform.mjs`), which also copies the
**geolocation** (`ecefLocation`) — required for the base map + reality mesh to position correctly.
Fill `.env` (local) / `.env.production` (Pages build) with the SPA client id + the **replica**
iTwin/iModel ids (never the source).

## Deploy (GitHub Pages)

Auto-deploys to https://meta-dev-coder.github.io/acs-demo/ on push to `master`
(`.github/workflows/deploy.yml`). See **[DEPLOY.md](DEPLOY.md)** for the one-time Pages + OIDC
redirect-URI setup and caveats.

---

## Project structure

```
src/components/App.tsx        Viewer host (chrome stripped, base map on, mounts the scene) + Shell
src/components/Authorization  OIDC sign-in (+ callback returns to app for Pages SPA hosting)
src/app/
  Shell.tsx                   Dashboard: top tabs, left list, viewer panel, inspector, KPI bar
  GuidedTour.tsx              Onboarding coach-marks
  shell.css / tour.css        Styles
src/scene/
  init.ts                     onIModelConnected + viewport orchestration (top view, frame, mesh)
  realityModels.ts            Attach BST409 reality meshes (read-only) + zoom
  place.ts                    Corridor centerline (from road geometry) + on-road placement/snap
src/scenarioA/
  data/assets.json, history.json    Synthetic I-595 asset register + maintenance history
  config/scoringConfig.json   Weights, thresholds, actions, work-package math
  scoring.ts                  Rule-based risk score + bands + drivers + age/condition
  decorator.ts                Risk pin markers (Marker/MarkerSet); click → inspect + frame
  workPackage.ts              Proactive work-package rollup
  discovery.ts                Phase-0 ECSQL discovery (await __acsDiscovery())
  store.ts                    Shared UI state for both scenarios (useSyncExternalStore)
  viewportUtils.ts            Clean display (base map, smooth shade) + frame helpers
src/scenarioB/
  data/segments.json, segmentIncidents.json, countermeasures.json
  config/safetyConfig.json    Safety weights/thresholds/economics
  safetyScoring.ts            Segment safety score + deterministic countermeasure deltas
  decorator.ts                Pickable WorldOverlay risk ribbons + hotspot pin
  manager.ts                  Scores segments, builds ribbons, registers the decorator
scripts/                      Replica/transformer tooling + dev.sh (not part of the deployed app)
```

## Placement

The loaded iModel is the **Express↔Turnpike connector** (a corridor-scale copy was deferred due to
checkpoint-download timeouts). Placement derives a clean **corridor centerline** from the model's real
road geometry: element origins are filtered to `projectExtents` (the connector parks ~16% of origins
at the spatial origin `(0,0,0)`), then binned along the dominant axis (median per bin) into an ordered
spine. Each asset/segment's synthetic UTM coordinate maps onto that spine (easting → distance along,
northing → lateral offset); **asset pins additionally snap to the nearest real road element** so they
always sit on the highway, and Scenario B ribbons follow the spine smoothly. The KPI bar shows
`placement: road` and the view opens **top-down**. Guarded by `tests/placement.test.ts` (reproduces
the `(0,0,0)`-stray regression that once flung the camera to the globe).

## Troubleshooting

- **Blank base map / missing mesh** → the iModel must be geolocated (`isGeoLocated: true`); the
  transformer copies `ecefLocation`. Verify offline: `node scripts/transformer/diag.mjs <cached.bim>`.
- **`/signin-callback` 404 on Pages** → handled by the `404.html` SPA fallback (the deploy workflow
  copies `index.html` → `404.html`); the 404 *status* on that one request is expected.
- **Model won't load / 401** → the signed-in account lacks access to the replica iTwin/iModel.
