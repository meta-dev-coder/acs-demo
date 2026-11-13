# Asset Operations & Maintenance

The Maintenance workspace, restructured so the corridor comes first. One screen, one Cesium viewer,
one selection, three subtabs:

1. **Operations Overview** (default) — incidents and assets across I-595.
2. **Case Management** — the seven [ACS demo cases](./acs-demo-cases.md), unchanged.
3. **Claims Intelligence** — the same claims read as a record of what the damage has cost.

Nothing was rebuilt. The KPI strip, the Asset Explorer slider, the ACS case popup, the validation
engines, the [evidence recovery](./acs-evidence-recovery.md) service and the demo case file are the
ones that were already there.

## What is real

| | Real | Not real |
|---|---|---|
| Incident register, work orders, tickets, tasks, inspections, asset registry | ✔ DataConnect | |
| Incident → asset association | ✔ the register's own `damaged_asset_id` | |
| Repeated damage | ✔ counted from confirmed links | |
| Weather at the incident hour | ✔ Open-Meteo historical, existing service | |
| Lane closure, injuries, fatalities, reported conditions | ✔ the incident's own register row | |
| Traffic at the incident hour | | no feed exists — **not shown** for a production incident |
| Claims | | all seven are synthetic, from the demo case file |
| Evidence gaps | | a property of the synthetic cases only |

Every figure carries a tag saying how it was arrived at — **Recorded**, **Derived**, **Inferred**
or **Demo** — and a figure the data cannot support prints its reason instead of a number.

## Three findings that shaped the build

1. **There is no spatial inference to be had.** On the committed export, the 90 incidents with no
   `damaged_asset_id` carry no coordinates either, so there is nothing to match on; on the live
   instance all 178 name an asset the registry carries. Either way the CANDIDATE count is 0. The
   relationship vocabulary (`CONFIRMED` / `INFERRED` / `CANDIDATE` / `UNLINKED`) is implemented and
   tested, and the UI reports the candidate count as zero rather than manufacturing links.
2. **The register's segment names and the FDOT segments share no identifier.** The register writes
   "Central Segment"; the map draws 16 numbered FDOT ribbons. Choosing an area therefore filters
   and flies to its incidents rather than lighting up a ribbon that may be a different stretch of
   road, and the panel says so under the chart.
3. **The register's last incident is 2026-04-03.** With the existing six-month default window the
   Operations Overview can legitimately be empty. The default was not changed; the panel states the
   period is empty, names the most recent incident the register holds, and offers "Count over all
   time".

## Files

| File | What it is |
|---|---|
| `src/maintenance/assetOpsModel.js` | associations, operational figures, distributions, filters, scene facts |
| `src/maintenance/claimsIntelligence.js` | claims as records, their figures and their groupings |
| `src/maintenance/assetOpsPanels.js` | the markup for the three panels |
| `src/maintenance/assetOpsTabs.js` | the tablist |
| `tests/assetOpsModel.test.mjs` | 22 tests |
| `tests/claimsIntelligence.test.mjs` | 15 tests |
| `tests/assetOpsTabs.test.mjs` | 16 tests |

Modified: `appNav.js` (the label), `maintenanceWorkspace.js` (tabs, panel, per-tab cards),
`i595Demo.js` (hands the workspace the corridor centerline), `i595Demo.css`,
`AcsCaseDialog.jsx` (tab order and the Overview's lead).

## Reused, not rebuilt

- `workspaceStrip.js` — the KPI strip, with its loading, unavailable and error states. A subtab
  hides the cards that are not its business; the strip is never torn down, so a card's records and
  its error survive a tab change.
- `.tmc-bars` and `.tmc-caveat` — the TMC's history-bar and caveat CSS. No chart library, and no
  second chart component to keep in step with the first.
- `.lab-tabs` — the Simulation Lab's tablist behaviour (roving tabindex, arrow keys).
- `corridorPosition.js` — the derived corridor mile, labelled as derived and never as an FDOT milepost.
- `weather/historicalWeather.js` — the historical Open-Meteo service, unchanged.
- `acs/incidentContext.js` — `TRAFFIC_AVAILABILITY`, `weatherObservations`, `weatherProvenance`.
- The maintenance record store, the Asset Explorer, the asset type registry and the case popup.

## Operations Overview

Map-first, and nothing docked over it: the Cesium corridor, the KPI strip with its period control,
the priority legend, and the Asset Explorer when a class is opened. Each KPI card opens its class
on the map and in the record browser, as it always has.

The analysis panel this screen used to carry on the right — operational figures, corridor incident
distribution, repeated damage, asset operational state and the selected incident's context — was
removed at the user's request. What it showed is still reachable:

- the three figures that mattered most (incidents, open work orders, failed inspections) are on the
  KPI strip;
- the incident's conditions at the time, including the real Open-Meteo reading, are in the Asset
  Explorer's own incident details card, which is the one incident surface on this screen.

What is no longer shown anywhere: the corridor distribution chart and its filters, the repeated
damage list, and the per-asset operational table. `assetOpsModel.js` and its 22 tests remain — the
associations, distributions, filters and scene facts are the data layer, not the panel — so any of
it can be put back on a different surface without being rebuilt.

## Case Management

Now the [Case Workbench](./case-workbench.md): a queue on the left and one case on the right, in
place of the KPI card, the slider, the floating details panel and the modal all showing the same
case at once. The seven cases, their validation results, their evidence recovery and their audit
trails are unchanged.

`AcsCaseDialog` still exists, with its tabs reordered to Overview · Inspection · Repair · QC/QA ·
Evidence Recovery · Incident Context · Claims · Audit Trail and its Overview leading with the
incident and the affected asset. Case Management no longer opens it.

## Claims Intelligence

A two-column workbench, the same shell as the Case Workbench: the claims list on the left, one
claim's detail on the right. Choosing a claim changes the right column and nothing else.

The detail carries the corridor totals, the financial breakdown (including claimed against
approved), the related records, the evidence the claim holds, the validation findings and the
outstanding action. Two explicit navigations sit in its header — **Open linked case**, which hands
over to the Case Workbench, and **View linked incident**, which hands over to the Asset Explorer.
Neither happens as a side effect of selecting a claim.

All of it demonstration money, from the costs already recorded in the committed case file; nothing
was invented to fill the table.

Two distinctions the panel keeps: **"Requires documentation" is our own validation finding the claim
short, not an insurer's rejection** — the demonstration carries no synthetic insurer — and a case
that has not reached the claim yet is *pending*, never failed.

`repeatedClaims` finds nothing on seven distinct assets, and says so rather than drawing an empty
chart. It is implemented because it is the analysis the corridor needs the day real claims arrive.

## Data isolation

- Demo cases and claims are counted only on their own tabs and in their own figures. No production
  card, total or map layer includes them.
- Nothing is written anywhere. There are no write paths to DataConnect, Office Track or any claims
  system in this feature.
- The demonstration is behind `?acsDemo=1`. With it off, the Case Management panel says so and the
  evidence figure on Operations Overview reports itself unavailable.

## Remaining limitations

1. **No historical traffic**, so the Operations Overview shows none. Unchanged from
   [acs-evidence-recovery.md](./acs-evidence-recovery.md): the moment a timestamped speed or volume
   store exists, this is one block to add.
2. **No claims system**, so Claims Intelligence is seven synthetic claims. The model is shaped for
   real ones; `PRODUCTION_CLAIMS.available` is the flag that changes.
3. **No join between register segments and FDOT segments**, so a segment selection cannot highlight
   the map ribbon.
4. **The asset-linked figure is only as good as `damaged_asset_id`.** Where the register leaves it
   out there is nothing to infer from, because those rows carry no coordinates.
