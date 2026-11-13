# Speckle Cloud → Cesium: the real BIM model (Phases 9B and 9C)

The Construction Integration Demo's **third real external connection**, and the first that puts
real external *geometry* on screen. SAP supplies cost, OpenProject supplies a live schedule, and
this supplies the actual building: a Speckle Cloud model, retrieved through the API, converted
server-side, and rendered in Cesium with its real IFC identifiers intact.

**The locally downloaded IFC file is not used.** Every vertex and every property on this screen
came down from Speckle.

It **replaces nothing**. The synthetic BIM elements, P6 activities, SYNCHRO records, SAP values and
ACC models are exactly where they were; Construction Progress still shows its own synthetic Tower A
model. The two sit side by side in the navigation on purpose.

---

## 1. Architecture

```text
Speckle Cloud
   │  POST /graphql  { latest version id }          ← one small query, every 60 s
   ▼
server/construction/speckle.mjs ──── allowlisted host, Bearer token, scrubbed errors
   │  version id changed?
   │      no  → record UNCHANGED, stop. Nothing is downloaded.
   │      yes ↓
   │  spawn (no shell, argv array, token in the child env)
   ▼
tools/speckle/convert_speckle.py ─── operations.receive3 → decode → transform → GLB
   │      ├── speckle_common.py   the same retrieval the 9A verifier uses
   │      └── gltf_writer.py      EXT_mesh_features + EXT_structural_metadata
   ▼
.data/speckle/<versionId>/{model.glb, elements.json, manifest.json}
   │  rename staging → final, then ONE transaction: rows + elements + the active switch
   ▼
speckle_version / speckle_element / speckle_sync   (SQLite, never ALL_TABLES)
   ▼
GET /api/construction/speckle/model.glb  →  Cesium Model  →  pick → IFC GlobalId
```

**Node owns scheduling, caching, HTTP and the database; Python owns geometry.** The bundle is
parquet and `operations.receive3` is the supported reader — there is no Node equivalent — so the
split is forced by the format rather than chosen.

---

## 2. The three facts the converter is built on

Each was established against the real model in Phase 9A, and each has a test that fails if the
handling regresses.

**The placement transform is row-major.** The 16 floats end `0,0,0,1` — a row-major bottom row —
and only that reading puts the six girders at six different heights. Read as column-major they
collapse to a single plane, which is what a wrong frame looks like.

**`faces` is run-length encoded** as `[n, i0..i(n-1), …]`, so a triangle occupies **four** entries.
`len(faces) // 3` is not a triangle count.

**The IFC class is not `speckle_type`.** Every object reports `Objects.Data.DataObject` — the
generic wrapper, identical for a beam, a roof and a site. The real entity is the root property
`ifcType`, cross-checked against `collection_path`; both are stored and the manifest records
whether they agree.

A fourth, found while building this: **the decodable geometry hangs off the objects.**
`model.geometries` is a `dict[int, Geometry]` of raw records whose iteration yields integer keys and
which has no `decode_mesh`. Getting that wrong reports "0 meshes" against a model with sixteen.

---

## 3. Element picking

One GLB, one node/mesh/primitive per element — nothing merged into an anonymous mesh.

| | |
|---|---|
| `_FEATURE_ID_0` | a **constant** attribute per element, equal to its property-table row |
| `EXT_mesh_features` | `{featureCount: 1, attribute: 0, propertyTable: 0}` per primitive |
| `EXT_structural_metadata` | `name`, `ifcGuid`, `ifcType`, `elementIndex` |

A Cesium pick returns a `ModelFeature`; `getProperty('ifcGuid')` is the IFC GlobalId. The node is
*also* named with the GUID, so identity survives a reader that ignores the extensions.

> A constant attribute rather than an implicit feature id matters: implicit ids number features by
> **vertex**, so a pick would resolve to a vertex rather than to an element.

Filtering and highlighting go through a `Cesium3DTileStyle` (`${ifcType}`, `${ifcGuid}`) rather
than per-feature mutation, because Cesium applies a style across the whole feature table in one
assignment — no walk over private fields.

---

## 4. Coordinates

| | |
|---|---|
| Source | IFC/Speckle, **Z-up**, metres |
| GLB | **Y-up** (`x, z, -y` baked), the glTF convention |
| Placement | one Cesium model matrix at render time |

**The geography is not in the geometry.** `SPECKLE_ANCHOR_LONGITUDE/LATITUDE/HEIGHT/HEADING/
PITCH/ROLL` position the building; the GLB is unchanged by them, so moving the site reconverts
nothing. Baking a longitude into the vertices would make the artifact wrong for every other site.

The model carries **no CRS**. It does contain an element named `geo-reference`
(`IfcBuildingElementProxy`) about 33 m from the origin, which looks like a survey marker — but
nothing states its coordinate system, so it is **not** used for placement. It is also why the
model's bounding sphere is larger than the building, and why the camera fit uses a tight multiplier.

---

## 5. Caching and atomic publication

A Speckle version id is **immutable**, which is the whole reason a 60-second poll is reasonable:
the usual cycle is one small GraphQL query and nothing else.

```text
latest version id  ==  active cached version id   →  UNCHANGED, no download
                   !=                              →  convert, then publish
```

Publication is two steps, both of which must survive a crash:

1. The converter writes into a **staging** directory; it is renamed into place only after the child
   exits 0 with a manifest. A half-written model is never served.
2. The version row, every element row and the **active switch** happen in **one transaction**. A
   GLB marked active whose elements are still the previous version's would make a pick resolve to
   the wrong record — precisely the failure this phase exists to avoid.

**A failed conversion keeps the working model.** `recordFailedConversion` updates only rows that are
*not* active, so a new version that fails to convert cannot take the current building off the
screen. The failure is recorded against the version that failed.

---

## 6. Schema (version 8)

`speckle_version` · `speckle_element` · `speckle_sync`, all prefixed and **deliberately not in
`ALL_TABLES`** — "Reset demo data" restores the synthetic baseline and must not delete the record of
a real external model. No table here has a foreign key into the integration tables and none of them
references one, so the isolation is checkable by reading the SQL.

---

## 7. API

| Route | |
|---|---|
| `GET /api/construction/speckle/status` | worker state, cached model, history. **No upstream call.** |
| `GET …/speckle/models` | every version seen, and which is active |
| `GET …/speckle/model` | the active model, its counts, bounds, GLB url and placement |
| `GET …/speckle/model.glb` | the geometry; `immutable` cache header |
| `GET …/speckle/elements[?ifcType=]` | elements, optionally filtered |
| `GET …/speckle/elements/:guid` | one element with its full property set |
| `POST …/speckle/sync` | check now; convert only if new. Needs a demo session. |
| `GET …/speckle/events` | SSE completion notifications |

**No route accepts a path, a host or a credential.** The GLB endpoint takes a *version id*,
validated as `[A-Za-z0-9_-]{1,64}`, looked up in the database, with the directory coming from the
stored row and the resolved path checked to be inside the artifact root. The token never reaches
the browser, and every upstream error is scrubbed of it before being logged or returned.

---

## 8. Integration boundaries

This phase is **read-only against Speckle** and writes nothing outside `speckle_*` plus one
`audit_event`. It does not map a BIM element to a schedule activity — that is **Phase 9C** and it
requires an approval — and the screen says so rather than leaving the absence to be inferred.

Tests assert that converting leaves `src_p6_activity`, `src_acc_element`, `src_sap_cost`,
`element`, `activity`, `cost`, `sync_run`, `outbound_proposal`, `mapping` and
`progress_observation` byte-identical.

---

## 9. Version history and comparison (Phase 9C)

### What is actually published

Discovered from GraphQL, never hardcoded — and the brief's six versions were not what existed:

| | version id | published | elements | triangles | vs previous |
|---|---|---|---|---|---|
| V1 | `84a80194f5` | 11 Nov 09:58 | 20 | 1 496 | baseline |
| V2 | `61df8bc691` | 11 Nov 11:38 | 23 | 1 510 | +3, 20 metadata, 3 reclassified, 5 re-tessellated |
| V3 | `5548fd83f3` | 11 Nov 11:42 | 27 | 1 558 | +4 |
| V4 | `e151fda611` | 11 Nov 11:43 | 33 | 1 630 | +6 |
| V5 | `ea69042f6c` | 11 Nov 11:59 | 52 | 1 850 | +19 |

**Five, not six**, and `V1..Vn` is derived from `createdAt` — Speckle has no such concept, and an
invented label that disagreed with the timestamp would be worse than none. Every version of this
model was published with **no message**, which is shown as "no description published".

A sixth version (`5e3057826f`, 63 elements) existed mid-implementation and was replaced upstream.
That is why `speckle_version.published` exists: a version deleted upstream keeps its row and its
artifacts — history is preserved — but leaves the timeline, so `V1..Vn` always matches what
Speckle currently publishes.

### The comparison engine

`speckleCompare.mjs` is pure and deterministic. Identity is the **IFC GlobalId**, never the name —
this model has six elements called "girder".

**The rule it exists for:** an exporter re-tessellating a shape is not a design change. Between V1
and V2 the exporter rebuilt five meshes (the foundation 68 → 64 triangles, the back wall 96 → 95)
without moving anything: every bound identical to six decimals, every surface area identical to
1e-5 m².

| test | invariant under re-tessellation? |
|---|---|
| triangle / vertex count | ✗ — reported, never compared |
| **surface area** | ✓ — the shape test |
| **bounding box** | ✓ — the position and size test |
| vertex centroid | ✗ — *reported, never compared* |

The centroid is the average of the **vertices**, so re-tessellation moves it: the back wall's
shifted 22 mm while its bounds and area were identical. Comparing it reported a stationary wall as
having moved.

Classifications are `ADDED` / `REMOVED` / `MODIFIED` / `UNCHANGED` / `RECLASSIFIED`, and an element
may be several at once. **Reclassification is tracked apart from modification** — V1 → V2
reclassified three elements (`IfcBuildingElementProxy` → `IfcChimney`, ×2 → `IfcDiscreteAccessory`)
without touching their geometry.

`geometryChanged` and `propertiesChanged` are counted **separately** from `modified`, because
"20 modified" and "0 changed shape, 20 gained an IFC `PredefinedType`" are very different
statements and only the second is true of V1 → V2. Across all five versions **nothing ever changed
shape or position**.

Exporter bookkeeping (`id`, `OwnerHistory`, `CreationDate`, `speckle_type`, …) is ignored, and the
`properties.` prefix is normalised — an unnormalised diff made 17 real changes look like 34.

A missing fingerprint on either side is reported as **unknown, never as changed**. A version cached
by an older converter has none, and the first run after the upgrade reported 16 elements as having
gained geometry. None had.

### Construction Progress, as four subtabs

The existing screen is **mounted unchanged** as *Schedule & Progress*; rebuilding it to add a
timeline would have risked a working feature. The other three are new, and each builds lazily —
two of them create a Cesium context, and browsers cap how many a page may hold.

*Overview* keeps design and construction in separate, visually distinct cards. *BIM Timeline* is
the version strip with previous/next/play/slider and compare-with-previous or -baseline; stepping
reads cached GLBs with an `immutable` cache header and **never reaches Speckle**. *BIM Changes*
filters by kind, IFC class and a search over name or GlobalId.

Added is green, modified amber, reclassified purple, unchanged grey — each paired with a **word**,
never colour alone. The camera is framed once on first load and never re-framed on a version step.

### Construction progress is not derived from the model

With no approved mapping the Overview says, in the brief's own words:

> Construction progress unavailable — BIM elements are not yet linked to verified construction
> activities.

No percentage is produced, because there would be nothing behind it. A mapping is **proposed by a
person and approved by the planner** (`approve:SCHEDULE_LINK`); nothing automatic creates one. Once
approved, completion still comes from the activity's own reported status, and the weighting
assumption is stated: this model carries no quantities to weight by.

### New endpoints

`GET …/speckle/timeline` · `GET …/speckle/compare?from=&to=[&kind=&ifcType=&q=]` ·
`GET …/speckle/versions/elements?version=` · `GET|POST …/speckle/mappings` ·
`POST …/speckle/mappings/:id/approve|reject`

### Schema (version 9)

`speckle_version_change` (one row per element per comparison, `UNIQUE` on the pair + GUID) and
`speckle_element_activity` (the manual mapping, `PROPOSED`/`APPROVED`/`REJECTED`). `speckle_version`
gained `ordinal`, `label`, `message`, `published`; `speckle_element` gained `area`, `centroid`,
`fingerprint`.

---

## 10. Known limitations

- **One model, one project.** `SPECKLE_PROJECT_ID` / `SPECKLE_MODEL_ID`. There is no model picker.
- **Single-process scheduling.** A per-process singleton with an in-memory lock, correct for one
  backend and *not* distributed scheduling. Two backends would each poll and each convert.
- **Untested at scale.** This model is 20 objects and 1 496 triangles. Pagination of large element
  sets, memory during decode, GLB size and whether a single GLB should become 3D Tiles are all open
  questions for a production model — 3D Tiles would be the answer somewhere above a few hundred
  thousand triangles.
- **The conversion is synchronous within a cycle.** A large model would hold the worker for the
  duration; the lock prevents overlap but the next check waits.
- **No level-of-detail, no draco compression, no texture support.** The model has none; a real one
  would want all three.
- **`Sync Now`'s access control is demo authorization.** It binds the action to a server-issued
  session rather than a request body, and anyone who can reach the API can still mint a session.
- **An IFC GlobalId is assumed unique within a version.** A duplicate is recorded as an error in
  the manifest rather than rejected, because a model that contains one is still worth looking at.

### Added by Phase 9C

- **No element has ever changed shape in this model**, so the geometry side of the comparison
  engine is exercised by unit fixtures rather than by the real data. A real redesign would be the
  first live test of it.
- **Removed elements are not drawn.** Nothing has been removed across these five versions, so the
  red "ghosted from the older version" rendering is specified and coloured but has never had a real
  case to draw. Drawing it means loading the older version's GLB alongside the newer one, which is
  implemented for neither.
- **No approved mapping exists yet**, so the weighted-completion path in the Overview is written
  but has not produced a number against real data. The refusal path is what runs today.
- **Playback steps the cached GLBs**, which is right, but each step is a full `Model.fromGltfAsync`
  rather than a swap between pre-loaded models. At five small versions it is smooth; at fifty large
  ones it would not be.
- **Comparisons are adjacent-plus-baseline only.** An arbitrary pair is computed on demand when
  asked for and then cached, so the first request for an unusual pair is slower.
- **The change-category filter is expressed as a GUID list** in the Cesium style and is capped at
  400 elements. Past that, hiding a category is better done by not loading those elements.
- **The model's bounding sphere is inflated by the `geo-reference` marker** 33 m from the building,
  so the default camera frames the house smaller than it could.

---

## 11. Verification

```bash
cd cesium-poc && npm run dev
```

1. `http://localhost:5188/?demo=construction-integration` → **Real BIM Model**
2. The header names Speckle Cloud, the project, the model and the version
3. The building renders; **Zoom to model** frames it
4. Click a beam → the panel shows its **real IFC GlobalId**, class, storey and property groups
5. Filter to **IfcBeam** → six beams
6. **Sync Now** → `UNCHANGED`, and no conversion runs
7. **Integration Overview → OpenProject Live Schedule** still auto-syncs
8. **Construction Progress** still shows its own synthetic model, unchanged
