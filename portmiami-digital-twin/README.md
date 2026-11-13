# PortMiami Digital Twin — Design & Construction Intelligence

A standalone Cesium application that opens on **PortMiami, Dodge Island** in Google Photorealistic
3D Tiles. Phase 1 is the 3D environment and nothing else: no data layers, no dashboard, no
operational screens.

It is a **separate project** from the ACS I-595 twin in `../cesium-poc`. Nothing here imports from
there, and nothing there was changed to make this work. What was reused was copied, with the source
named in the file header.

## Run it

```bash
cd portmiami-digital-twin
cp .env.example .env.local      # then paste the Google Maps browser key in
npm install
npm run dev                     # http://localhost:5200/
```

`npm run build` writes `dist/`; `npm run preview` serves that build.

Port **5200** is fixed (`strictPort`), because the ACS dev server owns 5188 and the repository root
owns 5180. A clash fails loudly rather than silently moving the app mid-demo.

## Environment

Both names are the ACS project's, so a key that works there works here. Everything `VITE_`-prefixed
is compiled into the browser bundle — nothing secret belongs in these files, and `.env*` is
git-ignored.

| Variable | Required | What it does |
| --- | --- | --- |
| `VITE_GOOGLE_MAPS_API_KEY` | yes | The only thing that loads the photorealistic tiles. Its HTTP-referrer restriction must allow `http://localhost:5200/*`, or Google refuses them. |
| `VITE_CESIUM_ION_TOKEN` | no | Enables Cesium World Terrain beneath the tiles. The photorealistic mesh carries its own geometry, so the app is complete without it. |

Without the key the app still opens over PortMiami on the flat Esri basemap and says why, rather
than showing a blank screen.

## How it is put together

```
src/
  config/portMiami.js    WHERE this twin is: project identity, location, camera, provider,
                         and the roadmap of future layers. No Cesium import anywhere in it.
  cesium/                HOW a viewer is built. Site-agnostic: nothing here names PortMiami.
    createViewer.js      the single Viewer, its camera limits and proportional zoom
    camera.js            degrees -> radians, the oblique framing offset, orbit, tilt, north
    basePhotorealistic3D.js   Google 3D Tiles, copied from ACS
  hooks/usePortTwin.js   the one place the two meet, and the only component that touches Cesium
  components/            top bar, camera controls, loading overlay — plain React, no Cesium
```

The split is the point: a second site is a second config file, and a new data layer is a new module
that takes the viewer the hook already owns. Neither needs the other to change.

### Two things worth knowing before changing them

**The camera eye is derived, not given.** `PORT_MIAMI_CAMERA`'s longitude and latitude name the
point you want to *look at*. `cameraPose` steps the eye back along the reverse of the heading by
`height / tan(|pitch|)` so that point lands in the middle of the screen. Passing those coordinates
straight to Cesium as `destination` puts the port behind and below the camera — at the configured
3500 m and -45 degrees, the opening view would be 3.5 km out into Biscayne Bay.

**The viewer is created once.** `src/main.jsx` deliberately does not use `<StrictMode>`: its
development double-mount would build, tear down and rebuild the viewer on every reload — two WebGL
contexts and two rounds of tile fetching. The hook's cleanup is still written to be correct for a
real unmount.

## Not in this phase

Infrastructure and assets, traffic and cameras, historical weather and hurricanes, FEMA flood zones
and elevation, Ask the Twin, construction project visualisation, BIM, and construction impact
simulation. They are listed in `config/portMiami.js` as `FUTURE_LAYERS` so the roadmap is written
down in one place — nothing renders from that list, because a tree of switches that do nothing is
worse than no tree.

## Road Network

`public/data/portmiami_roads_merged.geojson` — 2,362 LineString segments covering PortMiami,
downtown Miami and Miami Beach. Open it from **Layers → Road Network → Explore** (top left).

Validation on load: FeatureCollection, LineString geometry, OBJECTID present and unique, feature
count against the expected 2,362. Failures are reported on screen rather than thrown, so a bad file
produces a message, not a blank map.

### Classification

Port access is derived from the source name fields only — never from proximity. A geographic box
around Dodge Island was tried and rejected: it also catches Star Island Dr, N/S Hibiscus Dr, Palm
Ave and Parrot Jungle Trl, which are causeway residential islands.

| Rule | Segments |
| --- | --- |
| Name contains PORT or CRUISE | 92 |
| Listed PortMiami terminal street (the continent/ocean grid) | 84 |
| **Port access total** | **176** |
| Surrounding network | 2,186 |

Deliberately *not* port access, recorded in `src/config/roadNetwork.js`: **SR 887** (runs beside
Port Blvd but shares only 4 of its 87 vertices, so a separate alignment), **MACARTHUR CSWY** (a
state causeway serving Miami Beach too), **TERMINAL ISLAND / TERMINAL ISLE** (by the causeway, not
on Dodge Island — the word is a coincidence). Corrections go in `PORT_ACCESS_OVERRIDES`, keyed by
OBJECTID, which wins over every other rule.

### Drawing lines over Google Photorealistic 3D Tiles

`clampToGround` does not work here, and not because of a bug: clamping drapes a line over the
**globe's** terrain, and this app hides the globe so the photorealistic mesh is not punched through
by it. With no globe there is nothing to clamp to and the lines fall to the ellipsoid, roughly 25 m
beneath the city. `GroundPolylinePrimitive` is the other clamping route and needs the surface to
support classification, which Google's tileset does not.

Instead each line is drawn at a fixed height (`ROAD_RENDER.heightOffsetM`, 6 m) with a
`depthFailMaterial`, so where the mesh stands in front of a line — a cruise ship, a terminal roof,
the causeway deck — the line still shows, dimmed, rather than vanishing. One number to turn if the
lines sit wrong.

Known limits:

- One offset for the whole network. It suits PortMiami because Dodge Island and downtown Miami are
  0–3 m above sea level; a hilly site would need per-vertex sampling.
- The source centrelines are 2D and nothing in them marks a bridge, so the MacArthur Causeway's
  elevated spans draw at the same height as the ground beside them and sit below their real deck.
- A dimmed line seen through a tall object is still visible. That is the intent — the alternative
  is a road that disappears behind every building — but it does mean a line can read as crossing a
  ship rather than passing behind it.
- PORT MIAMI TUNNEL is an underground centreline. It is drawn dashed in its own colour and labelled
  as a tunnel wherever it appears, so it is not read as a surface road across the container yard.
  Its height is the same offset: the geometry is a plan trace, not a depth.

### What is deliberately not claimed

- **CLASS** is shown as the code the file carries (0–9). The file ships no lookup table, so naming
  the codes would be inventing data.
- **Length** is `Shape.STLength()` in feet. Evidence: the median ratio to geodesic metres across
  2,358 segments is 3.276, against 3.281 for feet — the 0.15% deficit is the projected CRS's scale
  factor. Stated as inferred, not as a source-declared unit.
- **Impedance** is shown as the raw number. It is *not* labelled travel time or a directional
  access rule: it tracks `Shape.STLength()` almost exactly (median ratio 0.9999 over 2,355
  segments) and 806 segments differ between directions, so its real meaning is undocumented. `-1`
  is shown as a sentinel.
- **Address ranges** of `0 to 0` are shown as "not available" — 705 segments carry that sentinel,
  and every real range in the file starts at 1.
- **Traffic, lanes, speed limit and construction status** are stated as not connected or not in the
  dataset. None is shown as zero.

### Architecture

Four layers, kept apart so an operational overlay can be added without disturbing the ones below:

1. **Source** — `public/data/*.geojson`, never written to.
2. **Model and classification** — `src/roads/roadModel.js`, `src/config/roadNetwork.js`. Pure,
   Cesium-free, testable. `segment.properties` is the original object by reference.
3. **Map state** — `src/hooks/useRoadNetwork.js` owns the selection; `src/cesium/roadNetworkLayer.js`
   owns the entities. Selection changes repaint two entities, not a React tree, and nothing
   subscribes to the camera, so panning re-renders nothing.
4. **Future overlays** — closures, work zones, truck restrictions, detours: each keys off
   `objectId` and sits beside the model rather than inside it.

### Tests

```bash
npm test     # 28 tests against the real shipped file
```

They run against `public/data/*.geojson` rather than a fixture on purpose: the things most worth
pinning are facts about that file.

## Building Footprints

`public/data/portmiami_buildings_partial_6000.geojson` — 6,000 footprints (5,927 Polygon, 73
MultiPolygon) over PortMiami, downtown Miami and Miami Beach. Open it from **Layers → Buildings →
Explore**. The layer is **off by default**: 6,000 outlines over photorealistic buildings is clutter
until asked for.

This is a **partial dataset** — the full ArcGIS layer holds 6,673. Swapping the complete file in is
a change to three values in `src/config/buildings.js` and nothing else; a test asserts a larger file
loads and models with no code change.

Validation on load: FeatureCollection; Polygon or MultiPolygon; OBJECTID present and unique;
longitude/latitude in range; rings of at least four positions. Unclosed rings are warned about and
closed on load.

### Drawing footprints over Google Photorealistic 3D Tiles

A footprint is drawn as its **outline** — one polyline per ring at the same 6 m offset the road
layer uses, with a `depthFailMaterial`. Every filled or extruded option was rejected for a reason:

- **Draped fill** (`classificationType`) needs the surface to support classification. Google's
  tileset does not, and the globe is hidden, so there is nothing to drape onto.
- **Fill at a fixed height** is swallowed by the building it outlines: the mesh roof is tens of
  metres up and the polygon is at 6 m, so it renders *inside* the building — invisible, and
  invisible geometry cannot be picked either.
- **Extrusion to HEIGHT** would be inventing data. HEIGHT is null for 5,423 of the 6,000
  footprints, and the 577 that have it carry no stated unit.

Nothing floats, because nothing is solid.

Limits: the outline is a plan trace at one height, so on a building standing on a podium or a slope
it cuts through the facade rather than following the base. Picking is on the line, not the area, so
selecting means clicking an edge — the line thickens on hover to help. Holes draw as their own
loops, so a courtyard shows as a second outline.

Measured, not assumed, and the measurement found a limit worth stating. On open ground picking is
reliable: checked vertex by vertex on a large quayside footprint, 43/43 top-down and 56/56 at a 45°
oblique returned the right entity. But **where the photorealistic mesh stands in front of the
outline, the outline is visible and not clickable** — `depthFailMaterial` draws it through the
mesh, while `scene.pick` respects depth. On a small building under tree canopy, 2 of its 5
on-screen vertices were occluded by the tileset once the tiles refined, and stayed that way.

So a footprint under canopy, a roof overhang or a gantry can take two or three clicks to catch
along a visible stretch of its edge. Selecting it from the Building Explorer always works and is
the reliable route. Making outlines pickable everywhere would mean
`disableDepthTestDistance: Infinity`, which draws every footprint on top of everything in front of
it — an x-ray view that reads as floating, which is what this approach set out to avoid.

### Units — the finding that matters most here

**`Shape__Area` and `Shape__Length` are Web Mercator (EPSG:3857) measures, not ground
measurements.** Across 5,986 footprints their ratio to the ground figures equals 1/cos(latitude) to
five decimal places (median 1.00000) — exactly the Web Mercator scale distortion. At PortMiami that
is ×1.1106 for length and ×1.2334 for area, so **reading `Shape__Area` as square metres overstates
a footprint by about 23%**.

The panel therefore shows both: the source value labelled as Web Mercator units, and a ground area
and perimeter computed from the geometry with holes subtracted. Building 69 reads 109.26 source
units against 89 m² on the ground.

**HEIGHT has no stated unit** in the source, so none is shown. It is present only for the 577
`D3_Large_NonCorridor_Building` records, ranging 5 to 70.5.

**YEARUPDATE is labelled as when the source record was last updated — never as a construction
year.** It takes two values: 2015 (4,426) and 2023 (1,574).

**TYPE and SOURCE** are single-letter codes with no lookup table in the file, so they are shown as
codes.

**UNIQUEID is not unique** — null for 1,574 features and only 3,940 distinct values across the
4,426 that have one. OBJECTID is the primary identifier, as the brief specifies, and the panel says
so where UNIQUEID is shown.

### The PortMiami asset register

`BUILDING_ASSETS` in `src/config/buildings.js` is **empty, deliberately**. The source carries no
building names or functions, so nothing identifies a cruise terminal, garage or warehouse.
Inferring one from footprint size or position would invent the very thing the register exists to
state reliably.

An entry links a curated record to a footprint by OBJECTID — this dataset's only stable identifier
— and carries `assetId`, `name`, `category` and `source`, the last by convention so a curated claim
says who made it. `ASSET_CATEGORIES` lists the five categories. When a record exists, the explorer
and panel use its name; otherwise a building is "Building · ID {OBJECTID}".

### Working with both layers

Roads and buildings toggle independently and can be drawn together: roads are blue (port access) or
blue-grey, footprints a lighter grey, and the Port Tunnel dashed purple.

There is **one selection for the whole map** — `{kind, id}` — so a road and a building can never
both be selected and there is never a second details panel. Clicks reach the layers through a
single shared pick dispatcher (`src/cesium/mapPicking.js`). With a handler per layer, Cesium
delivers every click to both, so clicking a building would also tell the road layer "nothing was
picked" and silently clear the road selection. One pick, routed by entity-id prefix, removes that
whole class of bug.

Future relationships between buildings, garages, access roads and construction projects key off
OBJECTID on both sides and live beside these models, not inside them.

## Weather

Today and the next seven days for PortMiami, from **Open-Meteo** — the same service and the same
field set the ACS I-595 twin uses, so the two projects read the same numbers. Open it from the
**cloud button at the foot of the map control column, directly below Home (⌖)**, which is where
the ACS twin keeps it too.

Nothing is requested until the dialog is opened: a map session that never asks about the weather
makes no call at all. After that the forecast is cached for fifteen minutes, refreshes itself while
the dialog stays open, and `↻ Refresh` forces a new fetch. The cache is also invalidated when the
calendar day rolls over, so "Today" can never point at yesterday.

The coordinates come from `LOCATION` in `src/config/portMiami.js` — the request is built from the
project's geography, not a second copy of it.

What it shows: an eight-day strip with a WMO condition icon and high/low per day; the selected
hour's temperature, condition, humidity, precipitation and 10 m wind; an hourly chart; the hour
cards; wind at 10 / 80 / 120 / 180 m; and sunrise, sunset and daylight length.

### The chart

Temperature and precipitation are **two stacked panels sharing one time axis, never one plot with
two y-scales**. Degrees and millimetres have no common scale, and overlaying them invites reading a
crossing as an event. Each panel carries one series, so neither needs a legend box — the row above
names them.

The two colours were checked with the `dataviz` palette validator against this light surface rather
than chosen by eye: `#c2410c` (temperature, warm) and `#1862d0` (precipitation, the app accent)
pass the lightness band, the chroma floor, CVD separation (ΔE 27.9 protan, 31.1 tritan) and
contrast. The first pair tried — the accent blue with a teal — failed both the chroma floor and the
normal-vision floor, so it was replaced.

A gap in the readings **breaks the temperature line** rather than bridging it, which would draw a
temperature that was never forecast. Hovering anywhere gives a crosshair and a tooltip with both
values. The hour cards below the chart are the table view: every plotted value is also readable as
text, so nothing is carried by colour or position alone.

### What is not claimed

A response missing any requested series, or with a series shorter than its own time axis, is
rejected whole rather than half-rendered — otherwise a chart would silently align the wrong hour to
the wrong temperature. A missing reading shows an em dash, never zero. An unrecognised WMO code
gets a neutral mark and no words, never a fair-weather icon.

## Infrastructure registry

A registry of named PortMiami assets, linked to the footprints and road segments already loaded.
Open it from **Layers → Infrastructure → Explore**. It is not a GIS layer and has no visibility
checkbox: it highlights features on the two layers that are already there.

### Where the data comes from

27 assets, each citing the page it was read from and stating what that page supports:

| Category | Count | Source |
| --- | --- | --- |
| Cruise terminals (AA, A, B, C, D, E, F, G, J, V) | 10 | [Cruise Terminals, Miami-Dade County](https://www.miamidade.gov/portmiami/cruise-terminals.page) |
| Parking garages and surface lots | 11 | [Parking at PortMiami, Miami-Dade County](https://www.miamidade.gov/portmiami/parking-information.page) |
| Container terminal operators | 3 | [Container Terminals, Miami-Dade County](https://miamidade.gov/portmiami/container-terminals.asp) |
| Administration buildings | 1 | [PortMiami map, Miami-Dade County](https://www.miamidade.gov/portmiami/library/portmiami-map.pdf) |
| PortMiami Tunnel, Port Boulevard Bridge | 2 | Secondary only — see below |

25 are **VERIFIED** (an official county source). 2 are **PROVISIONAL**: the tunnel's SR 887
designation and the bridge's SR 886 designation rest on secondary sources, and no official FDOT
page was read. A test enforces that nothing can be VERIFIED on a secondary source alone.

**No source publishes a coordinate for any of these assets**, and the county's public GIS has no
PortMiami facility layer — the nearest candidates are a 1999 county-wide "Ports" point layer and an
intranet-only seaport layer, neither of which is a terminal inventory. So the seed ships **zero**
coordinates, and a test asserts that.

Nothing records a parking capacity, building height, floor count or berth assignment, because no
cited source states one. A test fails the build if an attribute key even looks like one.

### How an asset gets a location

Not by guessing. The county parking page publishes a **street address** for each facility, and the
county's own road file carries address ranges on every segment. Matching the house number into one
of those ranges gives the segment that addresses it, and interpolating along that segment gives a
point on the street.

11 of the 12 assets with an address geocode this way. Garage D does not: the page writes it "1400
Cruise Blvd." without the N, and the four segments named CRUISE BLVD carry no address ranges. It is
recorded as the page writes it rather than silently corrected, and the panel says why.

A derived point is the street frontage, not the building, and never a survey position. It is
marked `DERIVED` everywhere it appears. The other 16 assets have no location at all — **View on
map is disabled for them**, and the panel says the map has nowhere truthful to fly.

### Candidates versus confirmations

Three things are kept distinct, which is the whole point of the feature:

1. A road is classified **port access** — it serves the port. The existing classification is reused
   untouched (176 segments); it is not a claim about any particular asset.
2. A road or footprint is **near** an asset's derived point. A reason to look, nothing more.
3. A link is **CONFIRMED** — a reviewer said this road serves this facility.

The build proposes 11 road links, all `CANDIDATE`, each from an address-range match with the
evidence recorded. **Proximity proposes nothing at all.** Nothing reaches `CONFIRMED` without a
click, and a test asserts the summary shows zero confirmed links on a fresh install.

### Linking workflow

Infrastructure → select an asset → **Buildings** tab → either **Link building** (then click a
footprint on the map) or **Link** on a nearby candidate. The map selection reuses the existing
picker and the existing highlight; there is no second selection engine. Confirmed links draw green
on the existing layers, candidates in the same hue at half strength, and the amber selection
highlight always wins.

The Building Details panel's existing **PortMiami asset** section now shows the linked asset's
name, category, verification status and relationship, with **View infrastructure asset**; unlinked
it reads "No infrastructure asset linked" and offers **Find or link asset**. No second popup was
added — an asset selection supersedes the road or building panel, so exactly one is ever open.

### Persistence, and its limit

There is no backend in this project and no database — it is a static Vite SPA. Adding a server for
a few hundred rows would be the "new database unnecessarily" the brief warns against, so links and
review history go in `localStorage` and survive refreshes and restarts.

**The limit, stated plainly: localStorage is per browser.** Links confirmed on one machine are not
visible on another and are lost if site data is cleared. `src/infrastructure/assetStore.js` is the
only module that touches storage, so a future backend replaces that one file.

The registry itself is **not** stored there. It is source code under version control, because a
verified asset with a cited source should not be editable from a browser console.

On every load, stored links are validated against the registry and the GIS actually loaded. A link
whose asset no longer exists is dropped. A link whose OBJECTID is no longer in the GIS is **flagged
`NEEDS_REVIEW` and kept** — never re-pointed at whatever feature inherited that id.

### Data quality, as loaded

| | |
| --- | --- |
| Roads | 2,362 loaded · 0 errors · 0 warnings · 0 duplicate OBJECTIDs |
| Buildings | 6,000 loaded · 0 errors · 0 warnings · 0 duplicate OBJECTIDs · **partial: 6,000 of the 6,673 in the source layer** |
| Assets | 27 · 25 verified · 2 provisional |
| Locations | 11 derived from an address · 16 with none · **0 with a published coordinate** |
| Links on a fresh install | 11 candidates · 0 confirmed · 0 needing review |
| Missing source information | 15 assets have no published address; all 27 have no published coordinate |
