# ACS I-595 Express — Operational Digital Twin (Demo)

A Bentley **iTwin Viewer** app that turns the published I-595 Express corridor model into an
operational twin. **Scenario A — ITS Asset Failure Prediction** is built and live; Scenario B
(Safety Hotspot) is the documented Phase-2 roadmap.

> Built for the ACS pitch demo. Accuracy is not the bar — the data is synthetic and shaped to read
> like I-595 Express (SunPass gantries, reversible median express lanes, the Turnpike connector).
> The point is a working, credible decision surface running on the real Bentley geometry.

---

## What it does (Scenario A)

- Opens the corridor in the iTwin Viewer with the **background map off** and **all default chrome
  stripped** (no model tree, property grid, measure tools, or toolbars). The only persistent UI is
  the **scenario switch + risk legend**.
- Colors every roadside **ITS asset** (toll gantries, DMS, CCTV, detectors, lane-control, access
  gates, ramp signals, lighting, cabinets) **green / amber / red by predicted failure risk**, shown
  as in-scene markers on the model.
- **Click an asset** → the camera frames it and an **anchored health card** shows the predicted
  risk, the drivers ("why it's at risk"), the recommended action, asset details, and maintenance
  history.
- **Multi-select** several at-risk assets → a **proactive work package**: lane closures avoided,
  crew hours saved, and toll revenue protected (bundling N emergency call-outs into one planned
  window).
- All weights, thresholds, recommended actions, and the work-package math live in
  `src/scenarioA/config/scoringConfig.json` — **nothing is hardcoded**.

---

## Prerequisites

- **Node 22** (an `.nvmrc` is included): `nvm install 22 && nvm use 22`. (Node 24 can fail the
  iTwin toolchain.)

---

## Step 0 — Access & the replica (DO THIS FIRST)

Two things must exist before the app can open the model. **The app must only ever point at a COPY
of the customer's model, never the live BST409 iModel** (customer hard rule).

1. **Register an OIDC SPA client** — developer.bentley.com → My Apps → Register New → type **SPA**,
   redirect URI `http://localhost:3000/signin-callback`, post-logout `http://localhost:3000`, scope
   `itwin-platform`. Copy the **Client ID**. (Use Mike's Bentley account, which has access to BST409.)
2. **Create the replica iModel** — see **[scripts/REPLICA.md](scripts/REPLICA.md)**. Quick version:
   ```bash
   export IMJS_ACCESS_TOKEN="<token from developer.bentley.com 'Try it'>"
   npm run replica:list                              # find the BST409 iTwin + source iModel ids
   npm run replica:create-itwin -- --name "ACS I-595 Demo (SuperDNA copy)"
   npm run replica:clone -- --source <SOURCE_IMODEL_ID> --target-itwin <TARGET_ITWIN_ID>
   ```
   It prints the **replica** `IMJS_IMODEL_ID` and `IMJS_ITWIN_ID`.
3. **Fill `.env`** with the Client ID and the **replica** iTwin/iModel ids (never the source).

---

## Run

```bash
nvm use 22
npm install        # already done if node_modules exists
npm start          # http://localhost:3000  (sign in as Mike on first load)
```

On first connect the console prints how many assets scored red/amber and offers Phase-0 discovery:

```js
await __acsDiscovery()   // enumerate ECClasses/categories/labels/extents of the loaded model
```

Run that **once against the replica** to confirm the two load-bearing facts before the demo:
whether ITS assets are discrete elements (they're likely **not** — markers handle that) and whether
the roadway is segmentable (matters for Phase-2 Scenario B). See **Calibration** below.

---

## Demo flow (the 2-minute story)

1. Open zoomed out on the whole corridor — assets light up green/amber/red.
2. Click the **red SunPass gantry** near the Turnpike connector → health card → "lost reads = lost
   toll revenue; the fix is an emergency closure during a reversal."
3. Click the other reds clustered at the **median reversal point** (gate, lane-control, cabinet).
4. **Add them to a work package** → "3 emergency closures → 1 planned window" with crew hours saved
   and revenue protected. ← the money shot.

> **Live-demo insurance:** bank a screen recording of this flow early and keep it ready to cut to.

---

## Project structure

```
scripts/                 Replica tooling (clone / list / create-itwin) + REPLICA.md
src/components/App.tsx    Viewer: chrome stripped, map off, mounts Scenario A
src/scenarioA/
  data/assets.json        Synthetic I-595 asset register (hero assets)
  data/history.json       Inspection/incident/work-order/ticket/task records
  config/scoringConfig.json  Weights, thresholds, actions, work-package math (tune here)
  scoring.ts              Rule-based risk score + bands + drivers
  placement.ts            Marker placement (extents-normalized now; EPSG:32617 after calibration)
  decorator.ts            Marker / MarkerSet / Decorator colored by risk; click → inspect + frame
  workPackage.ts          Proactive work-package rollup
  discovery.ts            Phase-0 ECSQL discovery (await __acsDiscovery())
  manager.ts              Wires scoring + placement + decorator on iModel connect
  ui/ScenarioAOverlay.tsx Scenario switch, legend, anchored health card, work-package tray/card
```

## Calibration (markers → true position)

Markers default to **extents-normalized placement** (`PLACEMENT_MODE = "extents"` in
`placement.ts`): they lay out along the model's longest horizontal axis using each asset's `u`/`v`,
so they sit along the corridor on **any** loaded model with zero setup. To pin them to true
EPSG:32617 coordinates after discovery, measure the spatial origin against 2–3 known landmarks, set
`EPSG_ORIGIN` in `placement.ts`, and flip `PLACEMENT_MODE` to `"epsg32617"`.

## Scenario B (Phase 2 — roadmap, not built)

Color corridor **segments** by safety risk; click for an incident summary; toggle a countermeasure
before/after. Deferred because segment coloring needs the roadway to exist as discrete linear
elements (unverified) and it's the heaviest mechanic. The scenario switch shows it as "Phase 2."

## Troubleshooting

- **"Please add a valid OIDC client id"** → `.env` `IMJS_AUTH_CLIENT_CLIENT_ID` is empty.
- **Auth redirect loops** → the SPA client's redirect URI must be exactly
  `http://localhost:3000/signin-callback`.
- **Model won't load / 401** → the signed-in account lacks access to the **replica** iTwin/iModel.
- **Markers not where expected** → see Calibration (default placement is approximate by design).
