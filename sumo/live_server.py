#!/usr/bin/env python3
"""
live_server.py — LIVE gate-control pipeline for the I-595 toll-plaza PoC.

Runs the SUMO baseline scenario in near-real-time under traci and serves a websocket so the
CesiumJS client can (a) watch every vehicle move and (b) open/close individual booth lanes and
see the physics react (the closed lane empties, the queue grows elsewhere).

GEOREFERENCED MODE (since georeference rebuild):
  The SUMO net is authored in UTM 17N (via georef_nodes.py + netconvert --proj.inverse).
  Vehicle positions are emitted as lon/lat degrees via traci.simulation.convertGeo().
  The meta frame carries georef=true + anchor/bearingDeg/boothGeo so the client places
  vehicles via Cartesian3.fromDegrees without any runtime transform fit.

Websocket protocol (JSON text frames)
-------------------------------------
Server -> client, once on connect:
  {"type":"meta",
   "georef":true,
   "anchor":{"lon":-80.306,"lat":26.1124,"height":3},
   "bearingDeg":104.0,
   "boothLon":-80.306,"boothLat":26.1124,
   "boothGeo":[{"lane","lon","lat","cash"}, ...],
   "bounds":{"minX","maxX","minY","maxY"},   # lon/lat bounds for camera framing
   "boothX":530.0,
   "gates":["pl_0",.."pl_9"],
   "closed":["pl_2", ...],
   "stepHz":10.0}

Server -> client, every sim step (~10 Hz):
  {"type":"step", "t":123.0,
   "vehicles":[{"id","lon","lat","angle","type"}, ...],
   "closed":["pl_2", ...],
   "stats":{"running":N, "queueAp":M,
            "booth":{"pl_0":k, ...}}}

Client -> server commands:
  {"cmd":"closeGate","lane":"pl_2"}      # drain + redirect cars off this lane
  {"cmd":"openGate","lane":"pl_2"}       # restore
  {"cmd":"reset"}                        # restart scenario from t=0

Start:
  export SUMO_HOME="$(python3 -c 'import sumo;print(sumo.SUMO_HOME)')"
  python3 sumo/live_server.py            # serves ws://localhost:8765
"""
import asyncio
import json
import os
import sys

# --- Resolve SUMO_HOME / traci -------------------------------------------------------------------
if "SUMO_HOME" not in os.environ:
    try:
        import sumo
        os.environ["SUMO_HOME"] = sumo.SUMO_HOME
    except Exception:
        sys.exit("SUMO_HOME is not set and the 'sumo' wheel is not importable. "
                 "Run: export SUMO_HOME=\"$(python3 -c 'import sumo;print(sumo.SUMO_HOME)')\"")
sys.path.append(os.path.join(os.environ["SUMO_HOME"], "tools"))

import traci  # noqa: E402
import websockets  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# --- Georef anchor (matches georef_nodes.py and main.js SITES[0]) ---
ANCHOR_LON = -80.306
ANCHOR_LAT = 26.1124
ANCHOR_HEIGHT = 3.0
BEARING_DEG = 104.0
SUMO_REF_X = 530.0
SUMO_REF_Y = 0.0
N_BOOTHS = 10
CASH_LANE_IDS = {f"pl_{i}" for i in range(3)}   # pl_0, pl_1, pl_2

BOOTHS_EDGE = "pl"
GATES = [f"pl_{i}" for i in range(N_BOOTHS)]     # single-roadway plaza: 10 adjacent booth lanes


def _build_booth_geo():
    """Compute boothGeo list analytically (without traci) using the same math as fcd2json.py."""
    import math
    from pyproj import Transformer
    fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
    inv = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)
    E0, N0 = fwd.transform(ANCHOR_LON, ANCHOR_LAT)
    b = math.radians(BEARING_DEG)
    s, c = math.sin(b), math.cos(b)
    out = []
    for i in range(N_BOOTHS):
        y = -14.4 + 3.2 * i   # lane centre Y (SUMO, lane width 3.2 m)
        dx = SUMO_REF_X - SUMO_REF_X   # x=530 relative to ref=530 → 0
        dy = y - SUMO_REF_Y
        east = dx * s - dy * c
        north = dx * c + dy * s
        lon, lat = inv.transform(E0 + east, N0 + north)
        lane = f"pl_{i}"
        out.append({"lane": lane, "lon": round(lon, 7), "lat": round(lat, 7),
                    "cash": lane in CASH_LANE_IDS})
    return out


# Pre-compute booth geo (static, doesn't need traci)
BOOTH_GEO = _build_booth_geo()

# --- Sim / server config -------------------------------------------------------------------------
SUMOCFG = os.path.join(HERE, "plaza.baseline.sumocfg")   # baseline route file = live demand
STEP_HZ = 10.0                 # sim steps per wall-clock second
STEP_LENGTH = 0.1              # seconds of sim time per step (matches STEP_HZ for ~real-time)
LOOP_SECONDS = 720.0           # restart the scenario after this much sim time (clears stuck stragglers)
WS_HOST = "0.0.0.0"
WS_PORT = 8765
QUEUE_SPEED = 0.5              # m/s; below this on the approach edge 'ap' counts as queued


class LiveSim:
    """Owns the traci sim, applies gate commands, and produces per-step vehicle snapshots."""

    def __init__(self):
        self.closed = set()                # lane ids currently closed
        self._redirected = set()           # veh ids already handled by _redirect_stops
        self._started = False
        self._geo = None                   # cached net bounds + booth line (set in start())

    def start(self):
        traci.start([
            "sumo", "-c", SUMOCFG,
            "--step-length", str(STEP_LENGTH),
            "--no-step-log", "true",
            "--no-warnings", "true",
            # Teleport cars jammed > 120 s. Our legitimate queue waits avg ~22 s, so this only clears
            # genuine deadlocks (which otherwise sit frozen after the booths forever); spillback survives.
            "--time-to-teleport", "120",
        ])
        self._started = True
        self._redirected.clear()
        self._geo = self.net_geometry()   # cache net bounds + booth line for meta() (constant per net)
        # (Closures are enforced per-step by _redirect_stops; nothing to re-apply at lane level.)

    def close(self):
        if self._started:
            try:
                traci.close()
            except Exception:
                pass
            self._started = False

    # --- gate control ----------------------------------------------------------------------------
    # Closing a booth = REDIRECT every car routed to stop there onto an open sibling lane of the same
    # station (the realistic "this booth is shut, use the next one" behaviour). Cars already at the
    # booth finish their dwell and leave normally; no NEW car is sent to it, so the lane empties out.
    #
    # We deliberately do NOT setDisallowed() and do NOT choke the lane speed:
    #  * setDisallowed(['all']) FATAL-errors the instant a car still routed to stop there reaches it
    #    ("not allowed to stop on lane") — every car carries a booth <stop> (the cash/AET dwell).
    #  * a speed choke just TRAPS the cars already on the lane (they can't reach/clear their booth),
    #    so the lane never empties. Redirecting the stops is what actually drains it.
    def _apply_close(self, lane):
        pass   # nothing to do at the lane level; draining is driven by _redirect_stops()

    def _apply_open(self, lane):
        pass   # new vehicles keep their original booth once it's out of self.closed

    def _redirect_stops(self):
        """Move any pending booth stops off closed lanes onto an open sibling on the same station.

        Only redirects cars still UPSTREAM of the booth edge — a car already on the booth edge has
        committed to (or reached) its stop and SUMO can't replace it; we leave those to dwell and
        depart normally, after which the lane sits empty (no new car is sent to it)."""
        if not self.closed:
            self._redirected.clear()
            return
        for vid in traci.vehicle.getIDList():
            if vid in self._redirected:
                continue
            try:
                stops = traci.vehicle.getStops(vid, 1)   # the single next stop
            except traci.TraCIException:
                continue
            if not stops:
                continue
            st = stops[0]
            tl = getattr(st, "lane", None)
            if tl is None or tl not in self.closed:
                continue
            edge = tl.rsplit("_", 1)[0]
            # Already on (or past) the booth edge? committed — can't replace, leave it.
            if traci.vehicle.getRoadID(vid) == edge:
                self._redirected.add(vid)   # don't retry every step (avoids stderr spam)
                continue
            alt = self._open_sibling(edge)
            if alt is None:
                continue   # whole station closed — nothing to do; vehicle waits upstream
            try:
                traci.vehicle.replaceStop(
                    vid, 0, edge,
                    pos=st.endPos, laneIndex=int(alt.rsplit("_", 1)[1]),
                    duration=st.duration, flags=st.stopFlags, teleport=0,
                )
                self._redirected.add(vid)
            except traci.TraCIException:
                self._redirected.add(vid)   # give up on this one; don't spam retries

    def _open_sibling(self, edge):
        """Pick an open lane on the given booth edge (lowest index), or None if all closed."""
        idx = 0
        candidates = [g for g in GATES if g.rsplit("_", 1)[0] == edge and g not in self.closed]
        return candidates[idx] if candidates else None

    def close_gate(self, lane):
        if lane not in GATES:
            return False
        self.closed.add(lane)
        if self._started:
            self._apply_close(lane)
        return True

    def open_gate(self, lane):
        if lane not in GATES:
            return False
        self.closed.discard(lane)
        if self._started:
            self._apply_open(lane)
        return True

    def reset(self):
        self.close()
        self.start()   # closures in self.closed are re-applied by start()

    # --- stepping --------------------------------------------------------------------------------
    def step(self):
        """Advance one step; loop the scenario when it ends. Returns a step message dict."""
        # Loop when the scenario empties OR once it passes the scenario length. The time cap is
        # essential: with time-to-teleport=-1 a few cars can get permanently stuck at the fan-in
        # merge, so getMinExpectedNumber never reaches 0 — without the cap those cars would sit
        # frozen after the booths forever ("stuck after crossing the booth").
        if traci.simulation.getMinExpectedNumber() <= 0 or traci.simulation.getTime() >= LOOP_SECONDS:
            self.reset()

        traci.simulationStep()
        # Redirect any car routed to stop on a now-closed booth onto an open sibling lane (must run
        # every step to catch freshly-spawned vehicles before they reach the disallowed lane).
        self._redirect_stops()
        t = round(traci.simulation.getTime(), 1)

        vehicles = []
        queue_ap = 0
        ids = traci.vehicle.getIDList()
        # Prune redirect-bookkeeping of vehicles that have left the network.
        if self._redirected:
            self._redirected &= set(ids)
        for vid in ids:
            x, y = traci.vehicle.getPosition(vid)   # UTM net coords
            # Convert to lon/lat via traci geo conversion (uses net's projParameter)
            try:
                lon, lat = traci.simulation.convertGeo(x, y, fromGeo=False)
            except Exception:
                # Fallback: use raw coords (shouldn't happen with a properly projected net)
                lon, lat = x, y
            vehicles.append({
                "id": vid,
                "lon": round(lon, 7),
                "lat": round(lat, 7),
                "angle": round(traci.vehicle.getAngle(vid), 1),
                "type": traci.vehicle.getTypeID(vid),
            })
            if traci.vehicle.getSpeed(vid) < QUEUE_SPEED:
                lane = traci.vehicle.getLaneID(vid)
                if lane.rsplit("_", 1)[0] == "ap":
                    queue_ap += 1

        # Live occupancy of each booth lane (cars currently on it) — lets the client show which
        # booths are busy and makes a closed lane's draining-to-empty directly observable.
        booth = {g: traci.lane.getLastStepVehicleNumber(g) for g in GATES}

        return {
            "type": "step",
            "t": t,
            "vehicles": vehicles,
            "closed": sorted(self.closed),
            "stats": {"running": len(vehicles), "queueAp": queue_ap, "booth": booth},
        }

    def net_geometry(self):
        """Compute the geo bounds from the live net (converts UTM lane shapes to lon/lat).
        The client uses these bounds for camera framing; booth positions come from BOOTH_GEO."""
        lons, lats = [], []
        for g in GATES:
            try:
                shp = traci.lane.getShape(g)
                for x, y in shp:
                    try:
                        lon, lat = traci.simulation.convertGeo(x, y, fromGeo=False)
                        lons.append(lon); lats.append(lat)
                    except Exception:
                        pass
            except traci.TraCIException:
                pass
        for e in ("ap", "dp"):
            try:
                shp = traci.lane.getShape(e + "_0")
                for x, y in shp:
                    try:
                        lon, lat = traci.simulation.convertGeo(x, y, fromGeo=False)
                        lons.append(lon); lats.append(lat)
                    except Exception:
                        pass
            except traci.TraCIException:
                pass
        return {
            "bounds": {
                "minX": round(min(lons or [ANCHOR_LON]), 7),
                "maxX": round(max(lons or [ANCHOR_LON]), 7),
                "minY": round(min(lats or [ANCHOR_LAT]), 7),
                "maxY": round(max(lats or [ANCHOR_LAT]), 7),
            },
            "boothX": SUMO_REF_X,
        }

    def meta(self):
        geo = getattr(self, "_geo", None) or {"bounds": {}, "boothX": SUMO_REF_X}
        return {
            "type": "meta",
            "georef": True,
            "anchor": {"lon": ANCHOR_LON, "lat": ANCHOR_LAT, "height": ANCHOR_HEIGHT},
            "bearingDeg": BEARING_DEG,
            "boothLon": ANCHOR_LON,
            "boothLat": ANCHOR_LAT,
            "boothGeo": BOOTH_GEO,
            "bounds": geo["bounds"],
            "boothX": SUMO_REF_X,
            "gates": GATES,
            "closed": sorted(self.closed),
            "stepHz": STEP_HZ,
        }


# --- Single shared sim, fanned out to all connected clients --------------------------------------
SIM = LiveSim()
CLIENTS = set()
CMD_QUEUE = asyncio.Queue()


async def sim_loop():
    """Drive the sim on a fixed wall-clock cadence; apply queued commands; broadcast each step."""
    SIM.start()
    period = 1.0 / STEP_HZ
    loop = asyncio.get_event_loop()
    next_t = loop.time()
    while True:
        # Apply all pending client commands before stepping (traci is single-threaded).
        while not CMD_QUEUE.empty():
            cmd = CMD_QUEUE.get_nowait()
            try:
                _apply_command(cmd)
            except traci.TraCIException as e:
                print(f"[cmd error] {cmd}: {e}", file=sys.stderr)

        try:
            msg = SIM.step()
        except (traci.TraCIException, traci.FatalTraCIError) as e:
            print(f"[step error] {e}; resetting", file=sys.stderr)
            SIM.reset()
            continue

        if CLIENTS:
            payload = json.dumps(msg, separators=(",", ":"))
            await asyncio.gather(*(_safe_send(c, payload) for c in list(CLIENTS)),
                                 return_exceptions=True)

        next_t += period
        delay = next_t - loop.time()
        if delay > 0:
            await asyncio.sleep(delay)
        else:
            next_t = loop.time()   # we fell behind; don't spiral


def _apply_command(cmd):
    c = cmd.get("cmd")
    if c == "closeGate":
        SIM.close_gate(cmd.get("lane"))
    elif c == "openGate":
        SIM.open_gate(cmd.get("lane"))
    elif c == "reset":
        SIM.reset()


async def _safe_send(ws, payload):
    try:
        await ws.send(payload)
    except Exception:
        CLIENTS.discard(ws)


async def handler(ws):
    CLIENTS.add(ws)
    try:
        await ws.send(json.dumps(SIM.meta(), separators=(",", ":")))
        async for raw in ws:
            try:
                cmd = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(cmd, dict) and "cmd" in cmd:
                await CMD_QUEUE.put(cmd)
    except websockets.ConnectionClosed:
        pass
    finally:
        CLIENTS.discard(ws)


async def main():
    print(f"live toll-plaza server on ws://{WS_HOST}:{WS_PORT}  ({STEP_HZ:.0f} steps/s)")
    print(f"gates: {', '.join(GATES)}")
    async with websockets.serve(handler, WS_HOST, WS_PORT, ping_interval=20):
        await sim_loop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    finally:
        SIM.close()
