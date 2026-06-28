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
