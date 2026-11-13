# Speckle BIM — verification (9A) and conversion (9B)

Proves — or disproves — that the real BIM model can be pulled out of Speckle Cloud through the
API, with its elements and its geometry. It is a **connectivity and retrieval test only**: nothing
here touches the Cesium frontend, the OpenProject sync, the SAP integration or the synthetic
P6/SYNCHRO/ACC demo.

**The locally downloaded IFC is deliberately not a fallback.** The question this phase answers is
whether Speckle can supply the model; substituting the IFC when retrieval fails would answer a
different question and look like a pass.

## The two tools

| | |
|---|---|
| `verify_speckle.py` | **Phase 9A.** Proves the model can be retrieved at all: auth, project, version, bundle, elements, geometry. Writes `verification-report.json`. |
| `convert_speckle.py` | **Phase 9B.** Turns one version into a Cesium-ready `model.glb` + `elements.json` + `manifest.json`. Called by the Node backend; runnable by hand. |
| `speckle_common.py` | Shared configuration, GraphQL and retrieval. One implementation of "get the model", so the two tools cannot drift. |
| `gltf_writer.py` | A minimal glTF 2.0 / GLB writer with `EXT_mesh_features` + `EXT_structural_metadata`. |

```bash
# convert the configured version into an artifact directory
tools/speckle/.venv/bin/python tools/speckle/convert_speckle.py --out .data/speckle/<versionId>
```

It prints one JSON object on stdout (`{ok, manifest}` or `{ok: false, error, errorClass}`), which
is what the Node connector parses. Nothing is written to Speckle.

### Why a Python child process

The bundle is parquet and `operations.receive3` is the supported reader; there is no Node
equivalent. So the division is deliberate: **Node owns scheduling, caching, HTTP and the database;
Python owns geometry.** The backend spawns this with no shell, an argument array, and the token in
the child's environment rather than on its command line.

## Run it

```bash
cd cesium-poc
python3 -m venv tools/speckle/.venv
tools/speckle/.venv/bin/python -m pip install -r tools/speckle/requirements.txt
tools/speckle/.venv/bin/python tools/speckle/verify_speckle.py
```

Exit codes: `0` every stage passed · `1` a stage failed · `2` not configured.

## Configuration

Server-side only, read from the repo's git-ignored `.env.local` (then `.env`) with the **same
precedence the Node server uses** — shell, then `.env.local`, then `.env`, first one wins. That is
`server/loadEnv.mjs`'s rule, and matching it avoids a token that works for `npm run dev` and not
for this script.

```ini
SPECKLE_SERVER_URL=https://app.speckle.systems
SPECKLE_API_TOKEN=            # personal access token, scope: streams:read
SPECKLE_PROJECT_ID=13347d8410
SPECKLE_MODEL_ID=d1fdafff76
SPECKLE_VERSION_ID=84a80194f5
```

Create the token at `https://app.speckle.systems/profile` → Developer settings → Access tokens.

The token is **never** printed, never written to the report and never passed to the browser. Only
its *length* is recorded, because "set but empty" and "set to something" are different diagnoses.
Anything coming back from the server is scrubbed of the token before it is logged or stored — a
server that echoes a credential in a 401 body is not hypothetical.

`.env.local` is git-ignored; so is `tools/speckle/.venv/` and `verification-report.json`.

## What it checks, and why the stages are separate

| Test | Question |
|---|---|
| **A** Authentication | does the token identify a user on this server? |
| **B** Project and model | are the configured project and model visible, with matching ids? |
| **C** Latest version | what is the latest published version, and is the configured one still it? |
| **D** Bundle retrieval | does the **actual model data** come down? |
| **E** Element extraction | do the elements carry identity, classification, properties, storey? |
| **F** Geometry | are there meshes, with vertices and faces and units? |

The report keeps four claims apart and never collapses them into one "success":

1. GraphQL metadata retrieved
2. Model bundle retrieved
3. BIM elements extracted
4. Geometry extracted

**Stage 1 passing tells you almost nothing about stage 2.** Metadata is a sentence about a model;
it is not the model. A and B and C can all pass against a version whose data cannot be read at
all, which is exactly the situation this phase was asked to investigate.

A failure is classified, because the remedies differ:
`AUTHENTICATION_OR_AUTHORIZATION` · `UNSUPPORTED_SDK_OR_BUNDLE_FORMAT` · `NETWORK` ·
`INVALID_MODEL_REFERENCE` · `DATA_DECODING` · `CONFIGURATION` · `OTHER`.

## The bundle question, answered

The brief asked whether the Python SDK can read a bundle-only version at all, given that

```
GET /objects/13347d8410/bundle.13347d8410.d1fdafff76.84a80194f5/single
→ BUNDLE_REFERENCE_NOT_FOUND
```

**It can.** `specklepy==2026.9.2` ships bundle support, verified by inspecting the installed
package rather than the documentation:

```python
operations.BUNDLE_REFERENCE_PREFIX == "bundle."
operations.receive3(account, project_id, model_id, version_id, *,
                    include_geometry=True, mark_received=True) -> specklepy.bundle.model.Model
```

Two usable paths exist, and this script takes the first:

- **`operations.receive3(...)`** — the supported route for a bundle-only version. Returns a
  `Model` with `.objects`, `.geometries`, `.levels`, `.materials`, `.properties`, `.units`.
- `operations.receive(obj_id)` — detects the `bundle.` prefix and routes to the same bundle
  reader, but is decorated `@deprecated` as of 2026.9 in favour of `receive3`:

  > *"Since 2026.9 — JSON based send/receive pipelines are deprecated and replaced by the parquet
  > bundle pipeline."*

**`specklepy[bundle]` (pyarrow) is required**, not optional. Plain `specklepy` imports fine and
then fails at the only step that matters.

### The path is reachable — proven, not assumed

Calling `receive3` with a deliberately invalid token against the configured project returns:

```
specklepy.logging.exceptions.SpeckleException:
  Listing artifacts failed with 403: {"error":"Your token is not valid."}
```

That is an **authorization** refusal from the server, reached through the artifacts rail, with no
`ImportError`, no `pyarrow` problem and no "unsupported" anywhere in the traceback. So the bundle
code path loads, runs and talks to Speckle; the only thing between this script and the model is a
valid token.

## Two things that cost time if you don't know them

**The CDN rejects a default user agent.** A plain `urllib` POST to `/graphql` answers
`HTTP 403, error code: 1010` — a Cloudflare browser-integrity rejection that reads exactly like an
auth failure and is not one. The script sends a real `User-Agent`.

**`SpeckleClient.execute_query` is deprecated** in this release, so tests A–C use plain `requests`
POSTs against `/graphql` rather than the SDK client.

## What the model actually contains (verified run, 11 Nov 2026)

All six stages pass against project `13347d8410` / model `d1fdafff76` / version `84a80194f5`
(`sourceApplication: ifc-ifcopenshell-converter`, the only published version).

| | |
|---|---|
| Objects | **20** — 20/20 with an IFC GUID and an IFC entity, 16 with geometry, 6 on a storey |
| Entities | `IfcBeam` ×6, `IfcBuildingElementProxy` ×5, `IfcWall` ×4, `IfcSite`, `IfcRoof`, `IfcBuilding`, `IfcBuildingStorey`, `IfcFooting` |
| Storeys | 1 — "00 groundfloor", 6 members |
| Geometry | **16 meshes, 4 488 vertices, 1 496 triangles**, 0 decode failures, units `m`, role `DISPLAY` |
| Properties | 36 distinct property paths; 46 per structural element |

Three structural facts a converter has to know, each found by inspecting the data rather than
assuming a convention:

**The IFC GUID is at `properties.Attributes.GlobalId`** — e.g. `0fqX614OH1YO1Njdxms2$Q`. That is
the stable key to join a mesh to an element, and to anything outside Speckle.

**`speckle_type` is NOT the classification.** Every object reports
`Objects.Data.DataObject` — the generic wrapper, identical for a beam, a roof and a site. The real
IFC entity appears twice and the two agree: as a root property `ifcType` (`IfcBeam`) and as the
`collection_path` (`["IfcBeam"]`). The report gives both.

**Every mesh is instanced.** All 16 carry a 4×4 placement transform; the vertices are in
definition-local coordinates. *A converter that ignores the transform will pile every element onto
the origin.*

Two more worth noting: `faces` uses Speckle's run-length encoding `[n, i0, i1, i2, n, …]`, so a
triangle occupies **four** entries — `len(faces) // 3` is wrong. And `model.geometries` is a
`dict[int, Geometry]` of raw, still-encoded records with no `decode_mesh`; the decodable wrapper
is `ModelGeometry`, reached via `object.geometries`, and it is what carries the transform.
Iterating the model-level dict gets you integer keys, which is how an early run of this script
reported "0 meshes" against a model with sixteen.

Georeferencing is **not** in the model. An origin and orientation must be supplied at placement
time, exactly as the existing I-595 models are placed.

## What the converter produces (Phase 9B)

`model.glb` — **161 KB**, one node/mesh/primitive per element, 16 elements, 4 488 vertices,
1 496 triangles, 4 materials.

Element picking works through glTF feature metadata rather than a side table:

* each element's vertices carry a constant `_FEATURE_ID_0` equal to its row in the property table;
* `EXT_mesh_features` names that attribute and the table;
* `EXT_structural_metadata` holds `name`, `ifcGuid`, `ifcType`, `elementIndex`.

So in Cesium a pick returns a `ModelFeature` and `getProperty('ifcGuid')` is the IFC GlobalId,
exactly as Speckle reported it. The node is *also* named with the GUID, so identity survives a
reader that ignores the extensions entirely.

A constant attribute rather than an implicit feature id matters: implicit ids number features by
**vertex**, so a pick would resolve to a vertex rather than to an element.

### Two conversions, each applied exactly once

**The placement transform**, row-major, baked into the vertices here. The manifest says
`transform.applied: true` with a note not to apply it again — the one thing worse than forgetting
it is doing it twice.

**Z-up → Y-up** (`x, z, -y`), so the GLB is a conventional Y-up asset that Cesium's defaults handle
and any viewer renders upright. `manifest.boundsModel` is in the source Z-up frame and
`manifest.boundsGltf` in the Y-up one, so a test can check the geometry against Speckle without
undoing anything first.

**The geography is not in the geometry.** The GLB holds the model's own metres; the
longitude/latitude/height/heading anchor is applied once as a Cesium model matrix at render time,
and is configurable through `SPECKLE_ANCHOR_*`.

## Reading the result

`verification-report.json` carries the server, ids, SDK versions, per-stage status, failure
classes, element count, geometry availability, up to 10 real sample elements and a recommended
next step. It contains **no token, email or other account credential** — the script checks the
active user to confirm authentication and then drops the email rather than recording it.

The model is opened read-only and closed afterwards. `mark_received=False` is passed deliberately:
a verification run must not alter state on somebody's Speckle project.
