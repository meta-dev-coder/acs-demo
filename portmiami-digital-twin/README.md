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

### Cruise terminals

All ten — AA, A, B, C, D, E, F, G, J, V — are in the registry with names, operators and now
**verified street addresses**.

The addresses did not come from the cruise-terminals page, which publishes none. They come from the
county's own **Cruise Guide Street Map (PDF)**, whose legend pairs each terminal with an address and
is marked *"Revised February 13, 2026"*. The legend is set rotated 90°, one column per entry, so it
was read by grouping the PDF's text runs by x position rather than by reading order — pairing by
reading order would have silently shifted addresses by one row.

| Code | Official address (street map) |
|---|---|
| AA | 2200 N Cruise Blvd |
| A | 2000 N Cruise Blvd |
| B | 1761 N Cruise Blvd |
| C | 1741/1751 N Cruise Blvd |
| D | 1435 N Cruise Blvd |
| E | 1265 N Cruise Blvd |
| F | 1103 N Cruise Blvd |
| G | 909 N Cruise Blvd |
| J | 1120 Caribbean Way |
| V | 718 W Cruise Blvd |

**No latitude or longitude is written into the registry.** Neither official source publishes one.
Every terminal position is derived at runtime by geocoding the address above against the county
road file, and is carried as `DERIVED` — a provisional point on the street, never a verified
building centroid. All ten geocode.

Terminal C's address is two house numbers; it is stored verbatim and geocoded on the first. Both
fall inside the same segment's range (1701–1753 of N CRUISE BLVD), so the choice does not move the
point onto another block. The map also lists a *"Cruise Terminal F - East Ext"*; that is an
extension of F rather than an eleventh terminal, so it is not a separate asset — link it to F as a
secondary footprint if it has its own polygon.

The map also corrected an address this registry already had: the parking page writes Garage D as
"1400 Cruise Blvd." without the N, which does not geocode because the segments named CRUISE BLVD
carry no address ranges. The street map prints "Garage D  1400 N Cruise Blvd", so the registry now
records the prefixed form and the discrepancy is noted in that asset's `supports`.

### Facility detail — what the county publishes, and what it does not

Each parking facility and cruise terminal has a **Facility** tab carrying everything the county
publishes beyond identity. The rule throughout: **a field the source does not publish is shown as
"not published", not hidden.**

**Parking clearances**, floor by floor, exactly as the county's table prints them:

| Facility | First floor | Second floor | Remaining | Lowest posted |
|---|---|---|---|---|
| Garage AA | *not listed* | 7'0" | 7'0" | 7'0" |
| Garage A | 7'2" | 8'0" | 7'2" | 7'2" |
| Garage B | 7'6" | *not listed* | 7'6" | 7'6" |
| Garage C | 9'0" | — | 6'10" | 6'10" |
| Garage D | 8'2" | — | 6'8" | **6'8"** |
| Garage G | 9'6" | — | 6'11" | 6'11" |
| Garage J | 8'2" | — | 6'10" | 6'10" |
| Garage K | 8'2" | — | 8'2" | 8'2" |
| Surface Lot E | *open lot, no overhead clearance* | | | n/a |
| Surface Lots C, D | *not published* | | | |

`lowestInches` is derived from the feet-and-inches the page prints, because that is the number that
decides whether a vehicle can use the garage at all. An **open lot** is recorded distinctly from a
clearance nobody published — the first is a fact, the second is a gap.

**Rates** are held as named schedules and shared by reference, never copied. The county's shared
schedule is headed *"Garages C, D, F, G, and Surface Lot E"* — but **there is no Garage F** in its
own address list or on the cruise street map, so the heading is quoted verbatim and no Garage F is
invented. Garage A publishes no county rate at all; it sends the reader to its operator.

**Oversized vehicles** are recorded only at Surface Lot E, the one place the county says RVs,
oversized vans and trailers are accommodated ($25 per space per day, $50 for two), with the two
help lines it gives.

**Reservations** exist for exactly two facilities, both run by the cruise line's own operator, not
the county: Garage A (Royal Miami Parking) and Garage B (ParkWhiz/Norwegian).

Port-wide rules — payment methods (**debit cards are not accepted**), cruise-day hours, the free
cruise-day-only shuttle, security patrols, disabled-parking provisions and the two Florida statutes
behind them — are held once in `PARKING_POLICIES` and shown under their own heading rather than
copied onto eleven records.

**What the county parking page does NOT publish**, recorded explicitly because these are the
questions people actually ask:

- **Capacity** — no garage or lot has a published space count.
- **Car rental** — the parking page names no rental company, desk or shuttle.
- **Electric-vehicle charging.**
- **Valet parking.**
- Shuttle operator, route, schedule or pickup points.
- Reservations for any facility except Garages A and B.

**Cruise terminal facility detail** is size, levels, LEED certification and dates. One trap handled
explicitly: the county quotes **471,000 sq ft for Terminals D, E and F together**. That is carried
as a *combined* figure on all three, labelled as such — printing it on each would treble the real
area. Terminals the county sizes individually (AA 490,000; A 170,000; B 190,000; V 100,000) keep
their own figure, and Terminal C, which the county says nothing extra about, says so.

### Construction status, kept apart from identity

`operationalStatus` is a separate field from `verificationStatus`, because they answer different
questions and conflating them is how a registry starts lying. **Terminal G is a fully VERIFIED
asset — the county names it, gives it an address and puts it on its own map — and simultaneously a
building site.**

| State | Means | Terminals |
|---|---|---|
| `UNDER_CONSTRUCTION` | a source says so | G |
| `OPEN` | a source states an opening, expansion or renovation year that has passed | AA, A, D, E, F, V |
| `LISTED` | the map lists it with an address; no source read states its current service state | B, C, J |

Nothing is inferred: `LISTED` is not a claim that a terminal is closed, and no terminal is assumed
operational. Each record carries the sentence its state was read from, and the source id.

### Footprint matching, and why distance is not enough

Candidates are footprints within 250 m of the derived point. **Nothing is confirmed automatically**
— a reviewer links and confirms, and only a confirmed link promotes a footprint.

The data shows exactly why that rule matters. OBJECTID **297214** is a 14-part polygon spanning
534 m × 248 m, and it is the *nearest* candidate to Terminals **F, G and V** — three terminals
roughly 400 m apart. Nearest-distance matching would have assigned one aggregate to all three. So
each candidate row now carries its **ground area and part count** beside the distance, which is the
evidence a reviewer needs to tell a 26 m shed from an aggregate covering half the island.

A terminal may span several footprints: the first confirmed link is the `PRIMARY_FOOTPRINT` and
anything linked afterwards is a `SECONDARY_FOOTPRINT`, not a replacement.

A terminal may also stay **unlinked**, and for two measurable reasons. The shipped building file is
a partial 6,000-feature extract of 6,673; and every one of those 6,000 features carries a
`YEARUPDATE` between **2015 and 2023, with none later**. So any structure completed after 2023 is
necessarily absent from it:

| Terminal | County states | Largest footprint within 250 m | Verdict |
|---|---|---|---|
| **AA** | 490,000 sq ft, opened 2025 | 17,408 sq ft | **Not in this extract.** Requires a newer GIS refresh or manual identification. |
| **G** | under construction from summer 2025 | 518,738 sq ft, but a 14-part aggregate shared with E, F and V | **Not in this extract.** The building did not exist when the file was cut. |
| A | 170,000 sq ft | 33,110 sq ft | Under-covered; confirm visually before linking. |
| B | 190,000 sq ft | 29,627 sq ft | Under-covered; confirm visually before linking. |

That caveat is printed above the candidate list in the panel, because a list cannot show what is
missing from it. `FOOTPRINT_COVERAGE` in `src/config/buildings.js` holds the measured numbers, and
a test asserts they still describe the file that ships.

### Where an asset's coordinate comes from

`representativePoint()` is the one definition, used by both the map marker and the details panel:

| Tier | Source of the point |
|---|---|
| `FOOTPRINT` | centroid of the **confirmed** footprint(s). With several, the centre of their combined extent — a terminal spanning two polygons has no single one to point at. |
| `FRONTAGE` | the footprint the address **fronts onto**: the first building met by a short walk perpendicular from the street point, onto the side the county's own address range names. A candidate, not a confirmation — but it stands on the structure. |
| `DERIVED` | the geocoded street address: a point on the road, not the building. |
| `UNKNOWN` | no confirmed footprint and no address that geocodes. No point is invented. |

A **candidate** footprint never produces a `FOOTPRINT` point. Only a reviewer's confirmation does.

#### Reading an address onto the building it fronts

`src/infrastructure/assetFrontage.js`. The geocoder answers "which block?", which left the pin in
the carriageway — often a hundred metres from the garage someone was looking for. The road file
publishes one more piece of evidence the geocoder already reads: `L_ADD_FROM/L_ADD_TO` and
`R_ADD_FROM/R_ADD_TO` are the ranges for the **left and right of the segment as it is digitised**,
so a matched house number states which side of the street the property is on.

Stepping perpendicular onto that side and taking the first footprint entered is a geometric reading
of published evidence, not a nearest-neighbour guess. Four bounds keep it honest:

| Bound | Value | Why |
|---|---|---|
| walk | ≤ 90 m | past a deep setback the ray is reading "some building that way", not this address |
| marker from address | ≤ 120 m | Terminal C enters the 33,891 m² aggregate, whose middle is 304 m away — a pin on a different part of the port |
| footprint ground area | ≥ 1,000 m² | a guard booth or canopy is not the answer to "where is Garage D" |
| footprints met | the **first** only | walking past one to the next building along stops describing what this address fronts onto |

Where it lands inside the footprint matters too. The marker goes to the **deepest interior point of
the part the ray entered** — not a centroid, which falls outside an L-shaped garage, and not the
whole feature's centre, which for the 14-part aggregate OBJECTID 297214 is half a kilometre from
most of its parts. Courtyards are excluded by the same test that found the building.

Assets flagged `OPEN_LOT` (the three surface lots) are **excluded entirely**: asphalt has no
footprint, so a frontage reading could only borrow a neighbour's. 12 of the 22 located assets gain
a footprint marker; the rest keep the kerb point and say so.

The marker is then lifted onto whatever it stands on by sampling the **rendered mesh** height. The
building extract publishes no `HEIGHT` for any footprint here and none is invented — but with the
globe off the photorealistic tiles are the only geometry, and a pin left at 6 m sits at the foot of
a ten-storey garage and appears, under an oblique camera, to float off the side of it.

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

### Marking the selected asset on the map

Selecting an asset marks it, in its own data source (`src/cesium/assetMarkerLayer.js`) so it is
visible whether or not the Road Network and Building layers happen to be switched on. Before this,
"View on map" flew the camera to a derived point and drew nothing: it landed on a close-up with no
indication of which spot it meant.

What the marker is careful **not** to say:

- A derived position is a point on the **street centreline** where the house number falls in a
  block's address range — not a survey of the facility, which stands back from the kerb by an
  unknown distance. The marker is drawn in the registry's provisional amber and labelled
  "Approximate · from street address".
- There is **no accuracy circle**. A ring of some radius would read as a measured tolerance, and no
  such measurement exists: the geocoder knows which block the number falls in, not how far the
  building is from the road.
- A **frontage** position is still a reading of an address, so it is labelled "On the building this
  address fronts" and drawn in the accent blue — a step short of the confirmed green. The panel
  carries a separate **Map marker** row naming the OBJECTID, the walk, the distance from the
  address and the words "a candidate, not a confirmation", so the pin can never quietly pass for
  a confirmed match.
- An asset with a reviewer-**confirmed** footprint is a stronger claim, so the marker moves to the
  building and takes the confirmed green. "View on map" also switches the Building layer on in that
  case, because the footprint is shown by emphasis and flying to it with the layer hidden lands on
  a close-up of nothing.
- An asset the geocoder could not place gets **no marker at all**.

One asset at a time — the selected one. Drawing all eleven derived points together would present a
row of confident pins for positions that are each a provisional inference.

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

## Live Traffic (FL511)

Live road events, traffic cameras and dynamic message signs for the PortMiami study area, read from
FL511 by this app's own server and served same-origin. **The browser never contacts FL511.**

This is a reuse of the FL511 integration already running in the ACS I-595 Safety Twin
(`../cesium-poc`), not a second one built from scratch. What was reused, what was deliberately left
behind, and what had to be new is set out below.

### What was reused from the ACS I-595 twin

The two apps are separate npm projects with their own `node_modules`, so a relative import across
the folder boundary would be exactly the fragile cross-project runtime dependency to avoid. The
generic code was **ported** into `server/fl511/` instead, with its provenance in each file header.

| PortMiami file | Ported from | Changed? |
|---|---|---|
| `server/fl511/tooltip.mjs` | `cesium-poc/server/fl511Tooltip.mjs` | unchanged |
| `server/fl511/geo.mjs` | `cesium-poc/server/geo.mjs` | `segmentIntersectsRectangle` / `polylineIntersectsRectangle` added |
| `server/fl511/client.mjs` | `cesium-poc/server/fl511Client.mjs` | `fetchCameras` / `fetchMessageSigns` added; `videoEnabled` + `iconUrl` kept |
| `server/fl511/config.mjs` | `cesium-poc/server/config.mjs` | `camerasPath`, second refresh clock, second stale threshold |
| `server/fl511/normalize.mjs` | `cesium-poc/server/liveEvents.mjs` | corridor logic removed (below) |
| `server/portmiami/service.mjs` | `cesium-poc/server/fl511Service.mjs` | two clocks; region filter in place of the corridor buffer |
| `server/portmiami/messageSigns.mjs` → `parseMessageSignDetail` | `cesium-poc/server/messageSigns.mjs` | unchanged |
| `server/portmiami/api.mjs` | `cesium-poc/server/api.mjs` | same framework-free handler shape and snapshot scope guard |
| `src/config/liveTraffic.js` → `TRAFFIC_ICONS` | `cesium-poc/src/liveOps/opsIcons.js` | same glyphs, so a closure looks the same in both twins |
| `src/liveTraffic/liveTrafficModel.js` | `cesium-poc/src/liveEventsData.js` | DataConnect and cleared-history parts removed |

The FL511 endpoints themselves are the ACS ones, unchanged:
`/map/mapIcons/{Incidents,Closures,Construction,Congestion,DisabledVehicles,MessageSigns}` and
`/tooltip/{layerId}/{id}?lang=…`. **FL511 needs no authentication and issues no credentials**, so
there is no API key to keep server-side. What is kept server-side is FL511 itself: one poller
serves every viewer.

### What was deliberately NOT carried over

None of this is true of PortMiami, so inheriting it would mean asserting something measured on a
different road:

- carriageway classification (EB / WB / Express) and the reversible express-lane model,
- FDOT traffic sections, milepost ranges and `contributesToImpact`,
- `nearestFacility` and the `I595_EB` / `SR84_WB` / `RAMP_CONNECTOR` vocabulary,
- lane-impact parsing, which reads lane counts from I-595 prose against a known lane layout,
- incident severity and risk scoring, calibrated on I-595's own crash history,
- upstream queue modelling.

### The study area

```js
{ west: -80.200, south: 25.755, east: -80.135, north: 25.800 }   // server/portmiami/region.mjs
```

A **study-area boundary, not PortMiami property.** It also contains I-395, the MacArthur Causeway,
I-95 approaches and the Brickell waterfront — so an event inside it is not thereby an event
affecting the port. That caveat is carried on every API response (`region.boundaryNote`) and printed
in the Overview tab.

Swap that object and the same poller, normalizer and endpoints serve another region.

**FL511 publishes points, never geometry.** A closure carries at most two of them. So:

- a one-point event is tested for containment → `POINT_IN_AREA`;
- a two-point event is tested as the **segment between its endpoints**, not as a centroid and not
  as its primary point alone → `ENDPOINT_IN_AREA` or `SPAN_CROSSES_AREA`. A closure anchored north
  of the box with its far end inside it is ours, and so is one running straight through with both
  ends outside; a centroid test misses the first and an endpoints-only test misses the second;
- an event with no usable coordinates is **counted under `unplaceable` and never given a position**.

A two-point event becomes GeoJSON `MultiPoint`, never `LineString`: a LineString would assert a
path FL511 did not publish. The map draws a **dashed** connector between the two anchors, and both
the API (`geometryBasis`) and the panel say in words that it is not the alignment or the length of
the affected road.

### Road association

Events are related to the existing 2,362-segment Road Network Explorer dataset by OBJECTID. The GIS
is not rebuilt, not copied and not written to — `server/portmiami/roadAssociation.mjs` imports the
classification rules from `src/roads/`, so there is one definition of a road in this app.

| Status | Means |
|---|---|
| `MATCHED` | the event's own text names the road **and** it is within 150 m. Two independent signals. |
| `CANDIDATE` | within 150 m, nothing else. **This is what the nearest road gets.** |
| `UNMATCHED` | nothing within 150 m. Recorded with its reason, not silently dropped. |

Name matching normalises both sides (`PORT BLVD` ↔ `Port Boulevard`, `MACARTHUR CSWY` ↔
`MacArthur Causeway`, `S.W.` ↔ `SW`). **Where a road name appears in the sentence decides what it
proves**, because FL511's own prepositions say so:

- `US-1 **at** Port Boulevard` → a junction. Both roads relate to the location → `MATCHED`.
- `I-395 **East of** Bridge Road` → the location is explicitly displaced from Bridge Road, so it is
  not on it → `CANDIDATE` via `OFFSET_REFERENCE`.
- `Port Blvd WB **before** US-1` → Port Blvd is the road it is on → `MATCHED`.

A direction stated in the text that contradicts the segment's own `PRE_DIR`/`SUF_DIR` demotes a
match to a candidate.

**There is no confidence number**, anywhere. There is no labelled set of event-to-road truth for
PortMiami to calibrate one against, so any figure would be a constant chosen here and presented as
a measurement. Each association carries `status`, `matchMethod` and `distanceMeters` instead, and
the UI prints all three: a reader can weigh "13 m away, named as a junction"; they cannot weigh
"0.82".

An association is a relation between an event and a centreline, **not a state imposed on the road**.
Nothing marks a segment closed, congested or restricted.

### Cameras

FL511's camera layer is **not** part of the ACS integration — ACS uses a frozen 74-camera GeoJSON
extract with DIVAS channels already resolved. PortMiami has no such extract, so it reads
`/map/mapIcons/Cameras` live. Verified 2026-11-16: HTTP 200, the identical `item2` envelope, 4,978
statewide items, and `icon.url` pointing at the same `/Generated/Content/Images/511/map_camera*.svg`
assets the ACS extract recorded as its `source_icon` — i.e. that extract came from this feed.

**The map feed does not carry the DIVAS channel a snapshot needs.** It only appears in a camera's
own tooltip fragment as `data-videourl=".../chan-<n>_h/index.m3u8"`. So a camera's position is known
from the list, and its imagery only after its detail has been read — which is why `snapshotUrl` is
`null` until then rather than guessed from the camera id. **No camera URL is ever constructed from
anything but a channel FL511 itself published.**

Snapshots are proxied same-origin through `/api/portmiami/camera/:channel/snapshot`, scope-guarded
to channels resolved for cameras currently in the study area, so it cannot be used as a general
image proxy. The live HLS stream is **reported, not embedded**: it is served from a third-party host
on a non-standard port, and whether it may be re-broadcast from another page is FL511's and DIVAS's
call, not this app's.

The feed publishes no title for any camera here, so `name` stays `null` until the detail is read —
never "Camera 409", which would read as FL511's name for it.

### Marker colour and size

Pins are **38 x 44 px**. The image is authored at 4x (176x208) so it stays sharp close up, and a
Cesium billboard with no explicit `width`/`height` takes the image's NATURAL size — which rendered
these at roughly 92x108 px, about three and a half times too big. ACS avoids that by stating the
size (`cesium-poc/src/liveEvents.js` uses 44x52); `TRAFFIC_RENDER.pin` does the same here, a little
smaller again.

Colour follows the SDNA palette in `src/theme.css` (from
`sdna_quasar_wf/sdna-frontend/src/css/quasar.variables.scss`):

| | Colour | White glyph |
|---|---|---|
| Traffic cameras | `#1862d0` — `$primary` | 5.68:1 |
| Message signs | `#114592` — a darker step of the same hue | 9.17:1 |
| Incidents | `#e5484d` | 3.91:1 |
| Road closures | `#dc2626` | 4.83:1 |
| Construction | `#c2410c` | 5.18:1 |
| Congestion | `#a15e21` — SDNA's darkened `$warning` | 5.07:1 |
| Disabled vehicles | `#3b82f6` | 3.68:1 |

Cameras and message signs are **infrastructure**: they carry no severity, so they take the brand
blue rather than a status hue, and are told apart by their silhouettes rather than by colour alone.
Event types keep distinct hues because those do encode category.

Two of the hues inherited from ACS were darkened along their own hue, because a white glyph on them
failed even the 3:1 WCAG 1.4.11 bar for a non-text graphic: construction `#f97316` (2.80:1) and
congestion `#eab308` (1.92:1 — close to invisible). A test asserts the 3:1 floor for all seven.

### Traffic speeds — not available

FL511's own map shows speed colouring. **This integration cannot reproduce it, and does not
simulate it.** `/map/mapIcons/TrafficSpeeds` answers HTTP 200 with zero items; the colours on
fl511.com come from a separate tile service outside the endpoint family used here. There is
therefore **no Traffic Speeds map toggle** — a dead toggle would promise data that cannot arrive —
and the Overview tab states the gap in words. Every `/live-events` response carries
`trafficSpeeds: { available: false, reason }`.

### Polling and caching

| Feed | Server cadence | Labelled cached after |
|---|---|---|
| Incidents, closures, construction, congestion, disabled vehicles | 60 s | 180 s |
| Cameras, message signs | 300 s | 900 s |

Two clocks, because the Cameras feed is 814 KB of infrastructure positions: re-fetching that every
minute to watch ten cameras that have not moved would waste FL511's bandwidth for nothing. Two
stale thresholds for the same reason — a single 180 s threshold would label healthy camera data
"cached" for two minutes out of every five. Each threshold is three of its own clock's refreshes,
so "cached" means the same thing in both places.

Refreshes cannot overlap (a second caller joins the one in flight), events are deduplicated by
FL511 id, and a failed poll serves the previous result labelled STALE rather than emptying the map.
Five conditions are kept distinct and never conflated: `LIVE`, `STALE`, `UNAVAILABLE` (our server
runs but never got FL511 data), `SERVICE_UNREACHABLE` (this page cannot reach our server) and
`LOADING`.

### Endpoints

```text
GET /api/portmiami/live-events              study-area events, associated to roads
GET /api/portmiami/cameras                  study-area cameras
GET /api/portmiami/cameras/:id              one camera: name, DIVAS channel, snapshot URL
GET /api/portmiami/camera/:channel/snapshot JPEG, proxied same-origin, scope-guarded
GET /api/portmiami/message-signs            study-area signs
GET /api/portmiami/message-signs/:id        one sign's current message
```

Read-only; no write route. Mounted into the Vite dev and preview servers by `vite.config.js`, and
served standalone in production by `node server/index.mjs` (port `PORTMIAMI_API_PORT`, default 5201).

### What this feature does not claim

- **No reported events is not "conditions are normal."** FL511 shows only what has been reported to
  it, and this twin has no independent traffic measurement. Every empty list says so.
- **A road with no associated events is not a clear road.** The Road details panel says "No FL511
  events currently associated with this road", never "clear" or "flowing".
- **An event near an asset's access road is not an access disruption.** The asset panel lists events
  on *confirmed* access roads and states explicitly that whether access is affected cannot be
  established from a point marker and a line of prose — it would need the closure's real extent and
  the facility's driveway connections, neither of which is in any source wired to this twin.
- **Roadway and direction are not parsed out of FL511's prose.** FL511 publishes them only inside
  its description text, so those fields stay absent rather than guessed.
- **No history is stored.** The ACS twin persists events through Firebase DataConnect with its own
  schema and an EC2 writer; PortMiami has no backend persistence and no new database was introduced
  for this. Only the live picture is available, and FL511 itself offers no historical retrieval.

### Tests

`npm test` — 171 tests, of which 82 cover live traffic. Two kinds, labelled in every test name:

- `[fixture]` — against `tests/fixtures/fl511/`, captured verbatim from fl511.com on 2026-11-16.
- `[synthetic]` — against `SYNTHETIC-study-area-events.json`, written by hand because **FL511 had
  zero events of any kind inside the study area at capture time**. Its coordinates are real
  PortMiami centreline midpoints so association runs on genuine geometry; the events are not real.
  That file is used only by tests and never reaches the application.

Neither kind contacts FL511. Live verification was done separately — see below.

### Live verification, 2026-11-16

Run against the real FL511 service through the real server code:

| | |
|---|---|
| Cameras in the study area | **10** (all `videoEnabled: true`) |
| Camera snapshots that returned a JPEG | **9 of 10** — channel 12074 (Brickell Bridge) answered 404; shown as unavailable, not as a broken image |
| Cameras matched to a named road by their own name | **6 of 10**; the other 4 stay candidates |
| Message signs in the study area | **3**, all three returning a current message |
| Signs matched to a named road | **1 of 3** ("Port Blvd WB before US-1" → PORT BLVD) |
| Incidents / closures / construction / congestion / disabled vehicles in the study area | **0 / 0 / 0 / 0 / 0** (statewide at that moment: 2 / 23 / 113 / 0 / 10) |
| Events associated to GIS roads | **0**, there being no events; association was exercised on the synthetic fixture and on all 13 live cameras and signs |
| Traffic speeds | **not available** (see above) |
| Road segments searched per event | 2,362 |

Browser verification drove the running app: 44 checks on the workspace, cameras, signs, empty
states, the road panel and layout at 1700 px and 1280 px, plus 19 checks on the Cesium layer
(markers drawn, dashed connector, map picking, per-layer toggling, no cross-layer selection
conflict). All passed, with no console errors. The three existing explorers — Road Network,
Buildings and Infrastructure — were re-checked and still work.

### Known limitations

- **The study-area box is coarse.** It is a rectangle, not the port boundary, and it catches
  motorway traffic that has nothing to do with the port. Road association is what narrows this;
  the box only decides what is worth associating.
- **Two-point closures have no real geometry.** The dashed connector is a straight line between two
  anchors. FL511 publishes nothing better.
- **A matched road name can match several segments.** The county splits PORT BLVD into 35
  centrelines, so an event on it matches the handful within range. Associations are capped at 8 per
  event, matched first, then by distance.
- **Camera and sign names arrive late.** Both feeds publish empty titles, so until a detail fragment
  is read the only association possible is proximity, and every row shows as a candidate.
- **Congestion was empty statewide** at verification time, so the congestion path was exercised
  through fixtures and the synthetic set rather than against live congestion data.

## Street View

Google Street View as a mode of the twin, not a separate page: drop onto the map, look around, and
return to exactly the view you left.

Reused from the ACS I-595 Safety Twin rather than rebuilt. As with the FL511 work, the two apps are
separate npm projects, so the generic code was **ported** rather than imported across the folder
boundary.

| PortMiami file | Ported from | Changed? |
|---|---|---|
| `src/streetView/streetViewService.js` | `cesium-poc/src/streetViewService.js` | **byte-identical** below the header |
| `src/streetView/streetViewSession.js` | `cesium-poc/src/streetViewMode.js` | DOM chrome removed (React); dead cube-map code dropped |
| `src/cesium/streetViewPlacement.js` | `cesium-poc/src/streetViewPlacement.js` | corridor ribbon removed; heading rule replaced |
| `src/streetView/streetViewHeading.js` | — | new; see below |

`VITE_ENABLE_STREET_VIEW=false` switches it off, the same flag name ACS uses. It needs **no key of
its own**: it reads `GoogleMaps.defaultApiKey`, the key `basePhotorealistic3D.js` already sets from
`VITE_GOOGLE_MAPS_API_KEY`, so Street View is available exactly when the 3D basemap is. When it is
off or unkeyed the toolbar button is **not rendered** rather than present and dead.

### Which Google product does what

Two, billed separately, both on the same key:

- **Map Tiles API (Street View Tiles)**, through Cesium's `GoogleStreetViewCubeMapPanoramaProvider` —
  answers "is there a panorama near this point" and "when was it captured". Verified importable in
  this project's **Cesium 1.142**, so no version bump was needed.
- **Maps JavaScript API** — renders the panorama the viewer actually looks at and walks through.
  Loaded on first use, never at application start-up.

### Entering and leaving

The toolbar's pegman button arms **placement**: click anywhere on the map to drop. There is no
coverage layer — Cesium exposes none, and pre-probing the map would mean dozens of Street View
requests every time the tool is opened — so a drop is verified against Google once, when it is
made, widening the search radius once (75 m, then 250 m) rather than dragging the viewer far from
where they clicked. Answers are cached on a ~10 m grid so sweeping the same stretch does not re-ask
for every pixel.

Where you dropped and where Google put you are both marked, joined by a dashed line. Google snaps a
drop to its nearest panorama, which can be tens of metres away; showing the jump is better than
silently moving the viewer and letting them wonder why the street looks wrong.

Entering **saves** the camera, the navigation settings and every layer's visibility, then hides the
scene's content. Nothing is destroyed — only `show` is flipped — and returning puts all of it back.
The camera is restored with `setView` from saved direction/up vectors rather than heading/pitch/roll
(near a nadir view the angles are ill-conditioned and a round trip comes back rotated), and
deliberately **not** via Reset View: you return to where you left, not to the opening PortMiami
frame. Verified in the browser: the camera comes back **0.000 m** from where it was.

Escape leaves a panorama, and disarms placement.

Street View is also offered from two panels, both of which open a panorama at a known point rather
than asking you to aim:

- **A traffic camera** — "Street View here". The panel states plainly that this is Google's imagery
  of the street the camera overlooks, captured on Google's own schedule: it is not the camera's view
  and it is not live.
- **A road segment** — looked up at the segment's midpoint. **A tunnel centreline is not offered
  one**, and says why: the geometry is underground, so a panorama looked up at it would be of the
  surface street above, not of that road.

### Which way the camera faces — and why this is not the ACS rule

ACS reads its heading from one continuous surveyed centreline, averaging the tangent over four
vertices either side of the drop because that centreline carries a vertex roughly every 75 m and a
single vertex-to-vertex tangent jitters enough to face the camera off the carriageway.

**That rule would be wrong on this data.** Measured over all 2,362 PortMiami segments:

- 6,882 vertices in total — a **median of 2 per segment**,
- median segment length **298 ft** (~91 m), median vertex spacing 18 m.

Most segments are a straight city block defined by its two endpoints. There is no jitter to average
away, and averaging over four vertices would reach past the ends of the typical segment into a
different block or a different street. So the heading here is the tangent of the one **edge** the
drop is beside: nearest segment, then nearest edge within it. For a two-point segment that is the
block's own direction, which is exactly what is wanted.

The heading is read at the point **Google** put you, not where the click landed — a drop snapped
40 m onto a different street should face along that street.

Beyond 120 m from any centreline, **no heading is claimed** and the place is labelled "PortMiami
study area": no heading is better than one pointed down a street the viewer is not standing on.
Which of an edge's two directions is used is arbitrary and not a claim about traffic flow — the
source centrelines carry no direction of travel, and this is a two-way network.

### What is different about drawing this here

ACS draws a clamped highlight along I-595 to show where the corridor runs. **Placement here draws
no road overlay at all**, for two reasons:

1. `clampToGround` drapes on the globe, which this app hides, so the ribbon would sink to the
   ellipsoid ~25 m under Miami — the same finding documented at the head of `roadNetworkLayer.js`.
   The drop and snap marks are drawn at a fixed height with `disableDepthTestDistance` instead.
2. PortMiami already **has** a road layer the viewer can switch on. A second set of road lines
   would be a competing copy of the network.

The hint therefore says "click anywhere", rather than pointing at a line to aim for. A drop is valid
anywhere Google has imagery — a terminal road, a causeway, a side street.

Placement uses its own `ScreenSpaceEventHandler`, so the shared pick dispatcher
(`src/cesium/mapPicking.js`) is never touched and no existing layer's picking is displaced while it
is armed.

### What is not claimed

- **Street View imagery is not live.** Google's capture month is shown as "Imagery: Aug 2026" and
  never as a timestamp.
- **A camera's panorama is not that camera's view**, and a road's panorama is not a survey of that
  road — both are Google's kerbside imagery of the street, on Google's schedule.
- **"No panorama here" is an answer, not a fault.** `ZERO_RESULTS` and `NOT_FOUND` are reported as
  "Street View isn't available near this location", leaving placement armed so the next click can
  simply be elsewhere. A denied key, a quota breach and a network failure are told apart from that
  and from each other, and none of them puts a raw Google status on screen.

### Tests

19 tests in `tests/streetView.test.mjs`. The service tests are **ported from ACS**, because the
module they cover is ported unchanged. The heading tests are **not** ported — the ACS ones exercise
the corridor-averaging rule this project deliberately does not use — and run against the real
2,362-segment network, plus a synthetic L-shaped segment that pins the nearest-**edge** behaviour
the whole-segment rule would get wrong.

Browser-verified against the real Google API (30 checks): placement arms and disarms, a drop opens a
panorama that actually renders imagery, the twin's layers and tileset are hidden and restored, the
camera returns to 0.000 m of where it was, Escape works, the road panel offers it and a tunnel does
not. Two bugs were found this way and fixed — the placement tool was being destroyed and rebuilt on
every state change, and Google's own canvas paints over the chrome, which left "Return to Digital
Twin" unclickable until the bar was given an explicit stacking level.

### Known limitations

- **Coverage is unknown until you drop.** There is no coverage layer, so a drop over water or
  inside the container yard simply reports that there is no imagery there.
- **Imagery age varies across the port.** Google re-drives the public streets on its own schedule
  and the terminal aprons rarely, so two drops a block apart can be years apart.
- **The panorama is Google's UI.** Its zoom, compass and navigation arrows are the SDK's, not this
  app's, and the links between panoramas are Google's own.

## Ask the Twin (Phase 1)

A compact assistant beside the map. It answers from the data this application has already loaded —
the registry resolved against the county GIS, the road file, the building extract and the FL511
payloads the live poller holds — and it performs map actions through the layers the explorers
already use. **No answer here is scripted, and no demo question has a canned reply.**

It works with **no language model configured**, which is how it is running now.

### Files

| File | What it is |
|---|---|
| `src/ask/spatial.js` | the spatial engine: metre frames, point-to-edge and point-to-polygon distance, radius search |
| `src/ask/tools.js` | the deterministic read-only tools, each returning a typed gap rather than an empty list |
| `src/ask/intents.js` | the intent router: regex rules, the anchor split, radius reading |
| `src/ask/session.js` | conversation memory and referent resolution |
| `src/ask/actions.js` | the map action contract and its validator |
| `src/ask/askTwin.js` | the orchestrator: question + context + memory → a `TwinResponse` |
| `src/ask/twinContext.js` | the Twin Context, read from the app's existing state |
| `src/ask/dataView.js` | the one object the tools may read |
| `src/config/askTwin.js` | radii, result caps, confidence bases, suggested questions |
| `src/hooks/useAskTwin.js` | the conversation, and the per-question context read |
| `src/components/AskTwinPanel.jsx` | the panel |
| `server/portmiami/askInterpreter.mjs` | the OPTIONAL server-side model route |

Existing pieces it reuses rather than rebuilds: the one `selection` in `App.jsx` and the registry's
`selectedAssetId`; `representativePoint` for where an asset is; `roads`/`buildings`/`traffic`
`layerRef` handles for `flyTo`, `select` and `setEmphasis`; `distanceMetres` and
`footprintContains`; the live payloads' own `sourceStatus` and `dataFreshness`; and the honesty
vocabulary in `liveTrafficModel.js` (`EMPTY_IS_NOT_NORMAL`, `sourceNote`, `statusNotice`).

From the **ACS I-595** twin it reuses architecture only — typed gaps instead of empty lists,
sources set by code rather than claimed by a model, a sanitised request envelope, and validated
actions. None of its code is imported: `cesium-poc/server/ask/` is a 2,882-line LLM orchestrator on
`node:sqlite`, DataConnect and I-595 corridor layers, and its business rules are I-595's. **The ACS
project is not modified.**

### Supported questions

| Intent | Example | What it does |
|---|---|---|
| `FIND_ASSET` | "Show me Cruise Terminal A." | resolves the registry record, reports its position and the tier that produced it, offers fly-to |
| `ASSET_SUMMARY` | "How many cruise terminals are registered?" | real counts, verified vs provisional, located vs not |
| `NEARBY_ASSETS` | "Show parking garages near Terminal B." | registry assets of a category within a radius, plus the *published* serving relationship |
| `NEARBY_ROADS` | "What roads are near this terminal?" | confirmed access roads, proposed links and nearby segments, kept apart |
| `NEARBY_BUILDINGS` | "Which buildings are within 200 m of this road?" | real OBJECTIDs, measured to the polygon edge |
| `NEARBY_CAMERAS` | "Show cameras near Terminal A." | live FL511 cameras, with FL511's own video field |
| `CLOSURES` / `INCIDENTS` / `CONGESTION` / `CONSTRUCTION` | "Are there any road closures near PortMiami?" | the live feed, with its age and status |
| `SELECTION` | "What infrastructure assets are currently selected?" | whatever is selected right now |
| `SHOW_LAST` | "Show them on the map." | acts on the ids the previous answer returned |

Anything else is answered with the capability list, never with a guess.

### What it will not do

- **It never guesses a referent.** "This terminal" with nothing selected and no name in the
  sentence produces a question, not an answer about the first terminal in the registry. The panel
  shows what "this" currently resolves to *before* you ask, and names every selection when more
  than one kind is selected.
- **Proximity is never reported as access.** A road near a terminal is a candidate; an access road
  is a relationship a reviewer confirmed, and the two are separate fields in every answer.
- **Absence is never normality.** An empty live feed is reported as "no closures were returned by
  the latest available FL511 data", with the standing caveat attached. A feed that could not be
  read says so and is labelled LOW confidence — it never becomes "no closures".
- **A confidence label never travels without its basis.** The four bases are in
  `src/config/askTwin.js` and the reason is printed under the label, not hidden in a tooltip.
- **Radii are search settings, not claims.** Every spatial answer states the radius it used.
  Defaults: cameras 1 km, buildings 250 m, roads 300 m, events 2 km; overridable in the question
  ("within 200 metres"), clamped at 5 km.
- **No action reaches Cesium unvalidated.** Actions are typed values from `src/ask/actions.js`,
  each checked against the loaded registry, road file, footprint extract and current FL511 payload
  before the single dispatcher in `App.jsx` runs it. Ids that do not exist are dropped and the
  answer says so. There is no generated JavaScript and no free-form coordinate.

### The optional model

`POST /api/portmiami/ask` classifies a question the deterministic router did not recognise into
**one of the same intents**. The model sees the sentence and nothing else: no records, no counts,
no coordinates, no actions. Its reply is checked against the intent and category enums server-side;
anything outside them is rejected with 422. The client then runs that intent through the same
tools and the same action validator.

So a wrong or hostile model reply can at worst choose the wrong intent — it cannot inject a fact.
An answer reached this way carries a warning saying a model chose how to read the question.

```text
ASK_TWIN_ANTHROPIC_KEY=…      # or ANTHROPIC_API_KEY. Server-side only; never sent to the browser.
ASK_TWIN_MODEL=claude-sonnet-5-5
```

Unset, the route answers **503** with a sentence saying the supported questions are answered
without it. **No key is configured in this repository, so that is the path that has been
exercised**: the live-model call itself has not been run against Anthropic. The contract around it
is tested — the 503, the enum rejection, a malformed reply, an unreachable model, and a
model-chosen intent producing an answer whose figures come only from the tools.

### Known limitations

- **No traffic speeds.** FL511's `TrafficSpeeds` layer answers 200 with zero items, so congestion
  is reported as events only. Nothing infers a speed or a congestion level.
- **Positions are provisional.** No source publishes a coordinate for any registry asset. Answers
  anchored on a derived or frontage position say so and are labelled MEDIUM.
- **No footprint is confirmed yet**, so "confirmed building" counts are 0 until a reviewer links
  one. The assistant reports that rather than promoting a candidate.
- **The study area bounds every live answer.** "Near PortMiami" means the server's study area, not
  Miami-Dade.
- Phase 1 is **read-only**: nothing here writes a link, a record or a construction plan.

### Tests

`tests/askTwin.test.mjs` — 49 tests over intent recognition, entity resolution, spatial queries,
tool execution, conversation context, action validation, unavailable-data handling and the model
contract. They run against the **real** road, building and registry files. The FL511 payloads are
hand-written and labelled in the file: a live feed cannot be a test oracle, and the stale,
unreachable and non-empty paths will not reproduce on demand.

A browser suite covers the end-to-end demo: the panel, the suggestions, a fly-to that moves the
camera, highlighting that repaints the road layer, the live camera ids checked against the live
payload, follow-up resolution, the honest fallbacks and the 503.

### Five-question client demo

1. **"Show me Cruise Terminal A."** — the record, its position and the tier behind it. Press
   **View on map**: the camera flies and the Infrastructure explorer selects the same asset.
2. **"Show traffic cameras near Terminal A."** — live FL511 cameras with distances and the radius
   used. Press **Show 2 cameras**: the camera layer switches on and the map frames them.
3. **"What roads are near it?"** — "it" is still Terminal A. Confirmed access roads, proposed
   links and nearby segments are three separate statements. Press **Highlight roads**.
4. **"Are there any road closures near PortMiami?"** — the live feed, its age, and the caveat that
   no reported events is not a statement that conditions are normal.
5. **"What is the capital of France?"** — declined, with the real capability list and no map action.

Then select a road in the Road Network explorer and ask **"Which buildings are within 200 metres of
this road?"** to show the context line resolving "this road" to the selection.
