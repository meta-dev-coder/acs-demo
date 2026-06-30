#!/usr/bin/env python3
"""
live_server.py — LIVE gate-control pipeline for the I-595 toll-plaza PoC.

Runs the SUMO baseline scenario in near-real-time under traci and serves a websocket so the
CesiumJS client can (a) watch every vehicle move and (b) open/close individual booth lanes and
see the physics react (the closed lane empties, the queue grows elsewhere).

RAW LOCAL-METRES MODE:
  Vehicle positions are emitted as LOCAL SUMO plaza metres (x along-corridor, y lateral) by
  converting the raw UTM traci positions via utm_to_local().  The client places vehicles via
  T.sumoToWorld(x, y) — the same transform used for gate markers — so marking at any location
  moves both traffic AND markers together.

Websocket protocol (JSON text frames)
-------------------------------------
Server -> client, once on connect:
  {"type":"meta",
   "bounds":{"minX","maxX","minY","maxY"},   # local SUMO metres
   "boothX":530.0,
   "gates":["pl_0",.."pl_9"],
   "closed":["pl_2", ...],
   "stepHz":10.0}

Server -> client, every sim step (~10 Hz):
  {"type":"step", "t":123.0,
   "vehicles":[{"id","x","y","angle","type"}, ...],   # x,y in local SUMO metres
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
import math
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

# --- Anchor constants (match georef_nodes.py / fcd2json.py / main.js SITES[0]) ------------------
ANCHOR_LON = -80.306
ANCHOR_LAT = 26.1124
BEARING_DEG = 104.0
SUMO_REF_X = 530.0   # booth stop-line x (local metres)
SUMO_REF_Y = 0.0

N_BOOTHS = 10
CASH_LANE_IDS = {f"pl_{i}" for i in range(3)}   # pl_0, pl_1, pl_2
BOOTHS_EDGE = "pl"
GATES = [f"pl_{i}" for i in range(N_BOOTHS)]    # 10 adjacent booth lanes

# Local Y bounds for the plaza: lane width 3.2 m, 10 lanes centred at y=0.
_LANE_MIN_Y = -14.4
_LANE_MAX_Y = 14.4

# --- SUMO-internal → local plaza metres ----------------------------------------------------------
# SUMO applies a netOffset when building the network (SUMO_internal = UTM + netOffset).
# We read the netOffset from plaza.net.xml once so we can convert raw traci positions to
# the same local plaza metres that CoordinateTransform.sumoToWorld expects.
def _build_sumo_to_local():
    import xml.etree.ElementTree as ET
    from pyproj import Transformer

    # Read netOffset from plaza.net.xml
    net_file = os.path.join(HERE, "plaza.net.xml")
    try:
        tree = ET.parse(net_file)
        loc = tree.getroot().find("location")
        ox, oy = map(float, loc.get("netOffset", "0,0").split(","))
    except Exception:
        ox, oy = 0.0, 0.0   # fallback: assume no offset (shouldn't happen)

    fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
    E0, N0 = fwd.transform(ANCHOR_LON, ANCHOR_LAT)
    b = math.radians(BEARING_DEG)
    return ox, oy, E0, N0, math.sin(b), math.cos(b)

_NET_OX, _NET_OY, _E0, _N0, _SIN, _COS = _build_sumo_to_local()


def sumo_to_local(sx, sy):
    """SUMO-internal x,y → local plaza metres (x along-corridor, y lateral).
    Pipeline: SUMO-internal → UTM (apply netOffset) → local (apply anchor inverse).
    """
    # SUMO-internal → UTM: UTM_E = sx - netOffset_x
    E = sx - _NET_OX
    N = sy - _NET_OY
    # UTM → local (inverse of local_to_utm):
    dE = E - _E0; dN = N - _N0
    dx = dE * _SIN + dN * _COS
    dy = -dE * _COS + dN * _SIN
    return dx + SUMO_REF_X, dy + SUMO_REF_Y


# --- Sim / server config -------------------------------------------------------------------------
SUMOCFG = os.path.join(HERE, "plaza.baseline.sumocfg")
STEP_HZ = 10.0
STEP_LENGTH = 0.1              # seconds of sim time per step
LOOP_SECONDS = 720.0
WS_HOST = "0.0.0.0"
WS_PORT = 8765
QUEUE_SPEED = 0.5              # m/s; below this on 'ap' edge counts as queued


class LiveSim:
    """Owns the traci sim, applies gate commands, and produces per-step vehicle snapshots."""

    def __init__(self):
        self.closed = set()
        self._redirected = set()
        self._started = False
        self._bounds = None     # cached bounds in local metres (set in start())

    def start(self):
        traci.start([
            "sumo", "-c", SUMOCFG,
            "--step-length", str(STEP_LENGTH),
            "--no-step-log", "true",
            "--no-warnings", "true",
            "--time-to-teleport", "120",
        ])
        self._started = True
        self._redirected.clear()
        self._bounds = self._net_local_bounds()

    def close(self):
        if self._started:
            try:
                traci.close()
            except Exception:
                pass
            self._started = False

    # --- gate control ----------------------------------------------------------------------------
    def _apply_close(self, lane):
        pass   # draining driven by _redirect_stops()

    def _apply_open(self, lane):
        pass

    def _redirect_stops(self):
        """Move pending booth stops off closed lanes onto an open sibling."""
        if not self.closed:
            self._redirected.clear()
            return
        for vid in traci.vehicle.getIDList():
            if vid in self._redirected:
                continue
            try:
                stops = traci.vehicle.getStops(vid, 1)
            except traci.TraCIException:
                continue
            if not stops:
                continue
            st = stops[0]
            tl = getattr(st, "lane", None)
            if tl is None or tl not in self.closed:
                continue
            edge = tl.rsplit("_", 1)[0]
            if traci.vehicle.getRoadID(vid) == edge:
                self._redirected.add(vid)
                continue
            alt = self._open_sibling(edge)
            if alt is None:
                continue
            try:
                traci.vehicle.replaceStop(
                    vid, 0, edge,
                    pos=st.endPos, laneIndex=int(alt.rsplit("_", 1)[1]),
                    duration=st.duration, flags=st.stopFlags, teleport=0,
                )
                self._redirected.add(vid)
            except traci.TraCIException:
                self._redirected.add(vid)

    def _open_sibling(self, edge):
        candidates = [g for g in GATES if g.rsplit("_", 1)[0] == edge and g not in self.closed]
        return candidates[0] if candidates else None

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
        self.start()

    # --- stepping --------------------------------------------------------------------------------
    def step(self):
        """Advance one step; loop the scenario when it ends. Returns a step message dict."""
        if traci.simulation.getMinExpectedNumber() <= 0 or traci.simulation.getTime() >= LOOP_SECONDS:
            self.reset()

        traci.simulationStep()
        self._redirect_stops()
        t = round(traci.simulation.getTime(), 1)

        vehicles = []
        queue_ap = 0
        ids = traci.vehicle.getIDList()
        if self._redirected:
            self._redirected &= set(ids)
        for vid in ids:
            sx, sy = traci.vehicle.getPosition(vid)   # SUMO-internal metres
            x, y = sumo_to_local(sx, sy)              # local plaza metres
            vehicles.append({
                "id": vid,
                "x": round(x, 2),
                "y": round(y, 2),
                "angle": round(traci.vehicle.getAngle(vid), 1),
                "type": traci.vehicle.getTypeID(vid),
            })
            if traci.vehicle.getSpeed(vid) < QUEUE_SPEED:
                lane = traci.vehicle.getLaneID(vid)
                if lane.rsplit("_", 1)[0] == "ap":
                    queue_ap += 1

        booth = {g: traci.lane.getLastStepVehicleNumber(g) for g in GATES}

        return {
            "type": "step",
            "t": t,
            "vehicles": vehicles,
            "closed": sorted(self.closed),
            "stats": {"running": len(vehicles), "queueAp": queue_ap, "booth": booth},
        }

    def _net_local_bounds(self):
        """Compute local-metre bounds of the net from lane shapes (used for meta frame)."""
        xs, ys = [], []
        for g in GATES:
            try:
                shp = traci.lane.getShape(g)
                for sx, sy in shp:
                    lx, ly = sumo_to_local(sx, sy)
                    xs.append(lx); ys.append(ly)
            except traci.TraCIException:
                pass
        for e in ("ap", "dp"):
            try:
                shp = traci.lane.getShape(e + "_0")
                for sx, sy in shp:
                    lx, ly = sumo_to_local(sx, sy)
                    xs.append(lx); ys.append(ly)
            except traci.TraCIException:
                pass
        if not xs:
            xs = [0, 930]; ys = [_LANE_MIN_Y, _LANE_MAX_Y]
        return {
            "minX": round(min(xs), 1), "maxX": round(max(xs), 1),
            "minY": round(min(ys), 1), "maxY": round(max(ys), 1),
        }

    def meta(self):
        bounds = (getattr(self, "_bounds", None)
                  or {"minX": 0, "maxX": 930, "minY": _LANE_MIN_Y, "maxY": _LANE_MAX_Y})
        return {
            "type": "meta",
            "bounds": bounds,
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
    SIM.start()
    period = 1.0 / STEP_HZ
    loop = asyncio.get_event_loop()
    next_t = loop.time()
    while True:
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
            next_t = loop.time()


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
