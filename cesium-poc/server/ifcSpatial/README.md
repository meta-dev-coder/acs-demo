# IFC Spatial Twin: IFC from Autodesk Forma → glTF → Cesium

The screen `?demo=seagirt&screen=ifc-spatial` (rail entry **IFC Spatial Twin**) draws the IFC models stored
in Autodesk Forma on the Cesium globe. Autodesk is the file repository only; no Autodesk Viewer is
loaded. The earlier Autodesk Viewer explorer is still reachable at `?screen=ifc` as a legacy/debug view.

```
Forma (Data Management)                 server (this folder)                         browser (src/ifcSpatial/)
version → storage object → signed S3 → IFC bytes → web-ifc → GLB + elements.json → Cesium Model at the
         (aps/dataManagement.mjs downloadVersion)    (convert.mjs, glb.mjs)        georeferenced matrix
```

| File | Role |
|---|---|
| `api.mjs` | `/api/ifc-spatial/*`: models, prepare (download + convert), cached assets, placements |
| `convert.mjs` | STEP validation, web-ifc geometry and properties, diagnostics |
| `glb.mjs` | GLB writer: `EXT_mesh_features` feature id per vertex, `EXT_structural_metadata` table (GlobalId, name, class, tag, NetworkID) |
| `georef.mjs` | IfcMapConversion / IfcProjectedCRS / IfcSite parsing, EPSG:26985 Lambert Conformal Conic |

## Conversion

- **Library:** `web-ifc` (pinned 0.0.80), That Open Company's IFC geometry engine compiled to WebAssembly,
  running in the existing Node process. IfcOpenShell is not installed here (Python 3.14).
- **Output:** one GLB per Autodesk version. Coordinates are the IFC's engineering frame (metres, Z up); the
  client loads it with `upAxis: Z, forwardAxis: X`, so Cesium applies no axis swap. Each IfcProduct with
  geometry is one feature; a pick returns its `globalId`. Primitives are grouped by colour, not merged
  across identities.
- **Sidecar:** `elements.json` lists every IfcProduct (with or without geometry): GlobalId, class,
  predefined type, tag, property sets (element and type), bounding box, feature id, STEP id.
- **Cache:** `.data/ifc-spatial/<sha256(versionId)[0..24]>/` (git-ignored): `source.ifc`, `model.glb`,
  `elements.json`, `diagnostics.json`, `meta.json`. A cached version is reused unless `CONVERTER_VERSION`
  changed or `?force=1`. A failure writes `error.json` and is reported; nothing is substituted.

## Placement

- **IFC_GEOREFERENCED:** from the file's IfcMapConversion. The server projects the model origin and points
  100 m along +x and +y to longitude/latitude; the client builds the model matrix from those points, which
  carries the grid rotation, meridian convergence and scale. Only EPSG:26985 is implemented; another CRS
  is reported as unsupported.
- **USER_CALIBRATED:** longitude, latitude, heading, scale set in the placement panel and saved per model
  version (`placements.json` in the cache folder).
- **Vertical:** Cesium heights are ellipsoidal and no geoid model is loaded, so the model origin (IFC z = 0,
  NAVD88 height from IfcMapConversion) is placed on the terrain sampled under it, plus the elevation offset.
  Without a Cesium ion token there is no terrain and the origin sits on the ellipsoid.

## The IFC network twin (converter v3)

Besides geometry, the converter extracts what the IFC says about the network:

- **Connections:** IfcRelNests (ports on elements) + IfcRelConnectsPorts (port pairs) → one connection per
  element pair, directed SOURCE → SINK, two-way for SOURCEANDSINK. Written to `elements.json` `connections`.
- **Cable routes:** each IfcCableSegment's IfcSweptDiskSolid directrix (an IfcPolyline), placed through the
  cable's own IfcLocalPlacement chain (Location, Axis, RefDirection), in IFC model metres.

`src/ifcSpatial/ifcNetwork.js` turns these into the electrical twin's asset/connection format (NetworkRole and
IFC class → asset type, NormalState → switch state, DemandkW / CapacitykW / ReeferPlugs kept), so the
existing engine, outage simulation and Ask the Twin run on it. The SCADA fibre stays out of the power graph.
`networkTwin.js` adds the what-if mock's status tiles, scenarios, restore-by-switching (with the capacity check)
and the 30 Ask the Twin questions reworded for this network (`ifcQuestionBank.js`); `networkOverlay.js` draws it
in the mock's style (`mockStyle.js`).

## Version comparison (Compare versions)

The header's **Compare versions** button opens a dialog listing the file's versions in ACC (`GET /versions`:
number, date, uploader; previous vs latest by default) and then shows the two side by side (`src/ifcSpatial/
compareMode.js`): two Cesium viewers with synchronized cameras (the last-used view leads; lockable), a draggable
divider, change markers, the IFC model coloured by change, and a **Changes detected** panel. The screen's own viewer
is paused, not destroyed, so **Exit compare** returns to it as it was. Read-only: nothing is written to ACC.

`POST /compare?file=&base=&target=[&tol=]` converts both versions if needed (versions are accepted only from that
file's own version list, so both are versions of one ACC item) and runs `compare.mjs`:

- **Identity:** IfcRoot.GlobalId. Left-over elements get a secondary match (same class; NetworkID, tag, name, shape,
  distance) with a confidence; only a strong (≥ 0.8), unambiguous one is applied, a weaker one is shown as possible.
- **Position:** placement origin in metres (converter v5 scales by the file's length unit; cables use the midpoint of
  their route), compared on the map grid through each version's own IfcMapConversion when both are georeferenced,
  in model coordinates otherwise. A displacement shared by most elements is reported once as a model origin shift.
  Default tolerance 0.05 m.
- **Change:** ADDED / REMOVED / MOVED / MODIFIED (geometry signature in the element's own frame, cable re-route,
  rotation > 1°, attributes, properties, ports). Moved and modified keeps both. Ports count on their element; spatial
  structure is left out. A property set added to most elements at once is one model-wide group; values that differ
  from what most elements got stay with their element.
- **Cache:** `.data/ifc-spatial/compare/<hash>.json`, keyed by the item, both version ids, the tolerance and
  `COMPARE_VERSION` / `CONVERTER_VERSION`.

## Generated reports (`reports/`)

Ask the Twin can turn a question such as "Prepare a report of all transformers requiring inspection and draft an
email to the electrical maintenance team" into a PDF report, an Excel register and an email draft.

- `eligibility.mjs` decides, with deterministic rules over the asset's documents (docIntel.mjs) and the twin's
  operational status, whether an inspection is **required** (documented due date passed, documented interval
  elapsed, an inspection/test action raised in the latest report or documented as not completed, a restriction
  that sets periodic testing), **recommended for review** (poor documented condition, worsening or recurring
  defects, earlier actions without a record of completion, degraded status), or cannot be established
  (**insufficient evidence**: no readable inspection report). Each reason names its rule, its source and citations.
- `snapshot.mjs` builds one snapshot per report revision; the PDF (`pdfReport.mjs`, PDFKit), the register
  (`xlsxRegister.mjs`, ExcelJS) and the draft (`emailDraft.mjs`) are all generated from it.
- `service.mjs` runs the job (progress steps, cancel, per-file retry), stores files under
  `.data/ifc-spatial/reports/<id>/` for the session and project that made them (deleted after
  `IFC_REPORT_RETENTION_DAYS`, default 7), and reuses an identical earlier report.

No inspection policy is assumed. To configure one, write `.data/ifc-spatial/inspection-policy.json`:

```json
{ "name": "Annual transformer inspection", "intervalsByType": { "TRANSFORMER": 365 }, "conditionRequiresInspection": false }
```

Nothing sends email: the draft can be edited, copied or downloaded as `.eml` (marked unsent, with the files attached).
