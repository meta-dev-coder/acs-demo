# I-595 Toll-Plaza Flow — SUMO × CesiumJS PoC

A standalone proof-of-concept that proves the **SUMO physics → CesiumJS render** pipeline: real
microscopic traffic (Eclipse SUMO) driving vehicles on the **real I-595 corridor** (Fort Lauderdale)
in a Cesium globe, with a before/after toll-policy comparison.

**Scenario:** a toll plaza fans the mainline out to booths. *Cash* booths each impose an 8 s payment
dwell and queue; *AET / transponder* booths flow free. The operator lever — **convert 2 cash booths
to all-electronic tolling** — visibly dissolves the queue. (I-595 is open-road tolling in reality;
this is the universal AET-conversion business case staged on the real corridor.)

This app is intentionally **separate from the iTwin app** in the repo root (it runs on Node 24 and
doesn't disturb that build). The same Cesium scene can later swap its basemap for the iModel-as-3D-
Tiles + Google Photorealistic hybrid (see the research reports).

## Architecture / data flow

```
sumo/  (Eclipse SUMO, installed via `pip install eclipse-sumo`)
  plaza.nod/edg.xml ──netconvert──▶ plaza.net.xml
  plaza.{baseline,intervention}.rou.xml   (cash 8s dwell vs AET 2s, per booth lane)
        └─ sumo ──▶ FCD trajectories ──▶ fcd2json.py ──▶ public/data/{baseline,intervention}.json
cesium-poc/ (this app)
  src/main.js  loads the JSON, places each vehicle on the real I-595 corridor via an East-North-Up
               frame at the corridor anchor (Transforms.eastNorthUpToFixedFrame — no UTM/proj), as a
               SampledPositionProperty (Hermite-interpolated) so it moves smoothly between SUMO's
               1 Hz samples; orientation follows velocity. Before/after toggle + KPI overlay.
```

Why ENU instead of `--fcd-output.geo` + a CZML converter: it removes the projection/coordinate-offset
risk entirely and lets the client own placement & altitude. See the deep-research notes.

## Run it

```bash
# 1) (Re)generate the SUMO trajectory data — needs the eclipse-sumo pip wheel:
python3 -m pip install eclipse-sumo sumolib
cd ../sumo && ./build.sh            # writes public/data/{baseline,intervention}.json

# 2) Run the Cesium app:
cd ../cesium-poc && npm install && npm run dev   # http://localhost:5180
```

The committed `public/data/*.json` let the app run **without** SUMO; re-run `sumo/build.sh` only to
change the scenario.

## Live gate control (interactive, instead of pre-baked playback)

`sumo/live_server.py` runs SUMO *live* under traci and streams it over a websocket so a client can
**close / open individual booth lanes and watch the physics react** (the closed lane drains, the
mainline queue grows). It loops the baseline scenario continuously.

```bash
export SUMO_HOME="$(python3 -c 'import sumo;print(sumo.SUMO_HOME)')"
python3 -m pip install websockets        # one-time
python3 sumo/live_server.py              # serves ws://localhost:8765  (~10 steps/sec)
```

**Websocket port:** `8765`.

**Message schemas (JSON text frames):**

- Server → client once on connect — `meta`:
  ```json
  {"type":"meta","anchor":{"lon":-80.3061,"lat":26.1124,"height":3.0},"bearing":104.0,
   "center":{"x":467.3,"y":9.0},"lateralOffset":24.0,"plazaWidth":46.8,"plazaLength":924.8,
   "gates":["plL_0","plL_1","plL_2","plL_3","plL_4","plR_0","plR_1","plR_2","plR_3"],
   "closed":[],"stepHz":10.0}
  ```
  `center`, `lateralOffset`, `anchor`, `bearing` are **identical to the baked JSON**, so the client's
  existing ENU placement (`localToWorld`) maps live `x,y` exactly like playback.

- Server → client every step (~10 Hz) — `step`:
  ```json
  {"type":"step","t":123.0,
   "vehicles":[{"id":"cashL0.7","x":12.3,"y":1.4,"angle":100.2,"type":"cash"}],
   "closed":["plL_2"],
   "stats":{"running":80,"queueAp":8,"booth":{"plL_0":3,"plL_1":2,"…":0}}}
  ```
  `x,y` are **local metres** (`sumo_x - center.x`, `sumo_y - center.y + lateralOffset`). `booth` is the
  live car count on each booth lane (a closed lane drains to 0). `queueAp` = cars backed onto the
  mainline approach.

- Client → server commands:
  ```json
  {"cmd":"closeGate","lane":"plL_2"}    // redirect its traffic to an open sibling; the lane empties
  {"cmd":"openGate","lane":"plL_2"}     // new vehicles resume using it
  {"cmd":"reset"}                       // restart the scenario (current closures persist)
  ```

**Gate buttons the client should expose** (the 9 booth lanes): LEFT station `plL_0 plL_1 plL_2 plL_3
plL_4`, RIGHT station `plR_0 plR_1 plR_2 plR_3`. (`plL_0/1/2` are the cash booths.)

How a closure works: every vehicle carries a scheduled `<stop>` on a specific booth lane, so the
server closes a booth by `replaceStop`-ing upstream cars onto an open sibling lane of the same
station (the realistic "booth shut — use the next one"). It does **not** `setDisallowed` the lane
(that fatal-errors a car already routed to stop there) nor choke its speed (that just traps cars).

### Basemap / realism

- **No token (default):** Esri World Imagery (aerial) on a flat ellipsoid — real highway pavement, no
  signup.
- **With a Cesium ion token:** `cp .env.example .env`, add `VITE_CESIUM_ION_TOKEN=…` → adds Cesium
  World Terrain (3D). Next step up is OSM Buildings / Google Photorealistic 3D Tiles (licensing applies).

## Tuning the scenario

- Demand / queue severity: `vehsPerHour` in `sumo/plaza.*.rou.xml`.
- Booth service time: the `<stop duration="…">` per booth lane (8 s cash, 2 s AET).
- Corridor placement / heading: `ANCHOR` and `BEARING` in `sumo/fcd2json.py` (then re-run `build.sh`).
- Vehicles are colored boxes today; swapping to glTF car models (`Model` / `ModelGraphics`, e.g. the
  CC0 Kenney Car Kit) is the main remaining realism upgrade.

## FL511 live road events (I-595 demo)

`?demo=i595` → **Traffic & ITS → Live Events** shows FL511 incidents and closures that fall within
250 m of the real I-595 network geometry. Both feeds start hidden, like every other layer here.

**The browser never talks to FL511.** `server/` polls it and serves a normalized view:

```
GET /api/i595/live-events              # combined; also /incidents and /closures
```

`npm run dev` mounts that handler inside Vite, so the API is same-origin with no second process.
For a static deployment run it on its own: `npm run api` (see `.env.example` for every setting).

### FL511 endpoints used

All three are publicly reachable but **undocumented** parts of FL511's own website. No access
control is bypassed, polling is 60 s by default, and each URL is an environment variable:

| Purpose | Endpoint | Notes |
| --- | --- | --- |
| Incidents | `GET /map/mapIcons/Incidents` | statewide markers: `itemId` + `location` only |
| Closures | `GET /map/mapIcons/Closures` | some carry `secondarylocation` |
| Marker detail | `GET /tooltip/{layerId}/{id}?lang={lang}` | declared by FL511's map as `data-tooltipbaseurl`; returns an **HTML fragment**, not JSON |

The detail fragment yields a heading, a free-text description and a label/value table (`Severity`,
`Region`, `Start Time`, `End Time`, `Last Updated`, `Comment`, `Detour`). FL511 publishes **no**
structured roadway, direction or lanes-blocked value — those exist only inside the prose — so those
model fields stay undefined rather than being parsed out of a sentence.

### Source data vs. digital-twin association

Proximity is not identity. A live example: FL511 closures sit ~15 m from I-595 ramp geometry while
FL511 itself attributes them to **95 Express**. So the details panel keeps two blocks:

* **Source data · FL511** — only values FL511 published. A field it omitted produces no row.
* **Digital twin association** — nearest facility, distance and (only within
  `I595_LIVE_EVENT_SEGMENT_TOLERANCE_METERS`) the nearest FDOT traffic section. Never written back
  over a source field.

For closures with two endpoints the connecting line joins FL511's two published points; it is drawn
dashed and labelled because it is **not** the closed roadway geometry.

### Failure behaviour

`sourceStatus` is `LIVE`, `STALE` (FL511 failed; last successful data still served, with its age) or
`UNAVAILABLE` (nothing cached yet). An outage never empties the map silently. Live events are
visualisation only — they do not change speeds, capacity, AADT or the simulation.

## Google Photorealistic 3D Tiles (base environment)

**Map explorer → Map → Base Environment** switches the *world* the corridor is drawn on. It is a
radio group outside `DataLayer`, because it changes neither which corridor data exists nor what is
switched on:

```
Map
└── Base Environment
    ○ Satellite / Existing Basemap   (default, unchanged startup behaviour)
    ○ Google Photorealistic 3D
```

Uses `createGooglePhotorealistic3DTileset()` from the installed Cesium (1.143.0) — no hand-built
tile URLs. The tileset is created on first activation only, kept for the life of the viewer, and
thereafter merely shown or hidden: switching away sets `show = false` and restores
`scene.globe.show`, it never destroys or re-downloads it. The viewer is never recreated and no data
source, entity, layer-visibility state or panel selection is touched by a switch.

### Setup

Put a key in `.env` (gitignored) as `VITE_GOOGLE_MAPS_API_KEY` — see `.env.example`. The Google
Cloud project needs **billing enabled**, the **Map Tiles API enabled**, and an **API key**.

That key ships inside the browser bundle like every `VITE_` variable and **cannot be hidden**, so
restrict it in Google Cloud: application restriction = **HTTP referrers** for this app's domains
only, API restriction = **Map Tiles API** only, and use separate dev and production keys.

Google's attribution is rendered by Cesium's credit display and must stay visible — do not hide or
cover `.cesium-widget-credits`.

### Without a key, or when Google fails

Missing key, invalid key, billing off, Map Tiles API disabled, quota exceeded or network failure all
behave the same way: a message under the selector, the technical error in the console, the selection
reverted to Satellite, and the existing basemap left exactly as it was. The globe is hidden *only*
after a tileset exists.

### Overlay behaviour over 3D tiles — verify with a key

Because the app has no Google key configured, tile rendering itself is **untested**. What each
overlay type does is unchanged and deliberate:

| Overlay | Rendering | Expectation over Google tiles |
| --- | --- | --- |
| CCTV, signals, incidents, closures | billboards, `disableDepthTestDistance: POSITIVE_INFINITY`, existing `scaleByDistance` | draw over the mesh; no change made |
| Roads, ramps, frontage, FDOT segments, bridges | ground-clamped polylines, Cesium's default `classificationType: BOTH` | **needs checking** — see below |

With `globe.show = false` there is no terrain surface to clamp to, and Google's tiles are not
classifiable by Cesium's 3D-Tiles classification path, so ground-clamped polylines may not appear in
3D mode. No workaround was applied, because guessing at one (height offsets, draping) would mean
inventing elevation. Add a key, switch to 3D and check the road lines; if they are missing, that is
the one follow-up this feature needs.
