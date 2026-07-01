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
from collections import deque

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
# kpi.py lives in the same directory as this script
sys.path.insert(0, HERE)
import kpi  # noqa: E402

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

# ---------------------------------------------------------------------------
# Weather presets — per-vType traci parameters.
# Absolute values for car (etc/cash); truck is scaled proportionally.
# speedFactor: fraction of free-flow speed.
# tau: reaction/headway time (dominant saturation-flow knob).
# decel/accel in m/s²; minGap in metres; sigma=driver imperfection.
# ---------------------------------------------------------------------------
WEATHER_PRESETS = {
    "clear":     {"speedFactor": 1.00, "tau": 1.0, "decel": 4.5, "accel": 2.6, "minGap": 2.5, "sigma": 0.50, "visibilityM": None},
    "lightrain": {"speedFactor": 0.90, "tau": 1.2, "decel": 3.8, "accel": 2.2, "minGap": 3.2, "sigma": 0.55, "visibilityM": None},
    "heavyrain": {"speedFactor": 0.80, "tau": 1.4, "decel": 3.4, "accel": 2.0, "minGap": 3.5, "sigma": 0.60, "visibilityM": None},
    "fog":       {"speedFactor": 0.78, "tau": 1.6, "decel": 4.0, "accel": 2.2, "minGap": 3.0, "sigma": 0.55, "visibilityM": 200},
    "snowice":   {"speedFactor": 0.65, "tau": 2.0, "decel": 2.6, "accel": 1.4, "minGap": 5.0, "sigma": 0.70, "visibilityM": None},
}
# Truck baseline parameters (clear weather)
_TRUCK_BASE = {"decel": 4.0, "accel": 1.3, "minGap": 3.0}
# Car baseline (= WEATHER_PRESETS["clear"])
_CAR_BASE   = {"decel": 4.5, "accel": 2.6, "minGap": 2.5}
# Ordered preset names for the client dropdown
WEATHER_PRESET_ORDER = ["clear", "lightrain", "heavyrain", "fog", "snowice"]

# Theoretical plaza capacity under each weather preset.
# Base = 2849 vph (10 booths, clear, matches fcd2json.py offline measurement).
# Factors encode the tau/minGap/speedFactor degradation on saturation flow:
#   Clear tau=1.0 → base; Heavy rain tau=1.4 → base × (1.0/1.4) ≈ 0.71, floored at 0.80
#   for demo readability.  These numbers drive the "rain costs X% capacity" KPI chip.
BASE_CAP_CLEAR_VPH = 2849   # measured from offline FCD, 10 booths
CAPACITY_FACTORS = {
    "clear":     1.00,   # 2849 vph
    "lightrain": 0.90,   # −10%  ≈ 2564 vph
    "heavyrain": 0.80,   # −20%  ≈ 2279 vph
    "fog":       0.78,   # −22%  ≈ 2222 vph
    "snowice":   0.65,   # −35%  ≈ 1852 vph
}

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
        # --- Weather state ---
        self._active_weather = "clear"
        # --- KPI tracking ---
        self._vid_to_type = {}          # vid -> vType for all live vehicles
        self._cumulative_rev = 0.0      # running total revenue
        self._elapsed_t0 = None         # sim time at start (for elapsed_h)
        self._step_count = 0
        self._window_records = deque(maxlen=600)  # last 600 steps (~60s at 10Hz)
        self._departure_deque = deque() # (sim_t, n) pairs for rolling 60s capacity
        # Booth occupancy accumulators (for kpi.window step_records)
        self._booth_occ = {g: 0 for g in GATES}
        self._booth_tot = {g: 0 for g in GATES}

    def _reset_kpi_state(self):
        """Reset all KPI tracking state (called on start/reset)."""
        self._vid_to_type.clear()
        self._cumulative_rev = 0.0
        self._elapsed_t0 = None
        self._step_count = 0
        self._window_records.clear()
        self._departure_deque.clear()
        self._booth_occ = {g: 0 for g in GATES}
        self._booth_tot = {g: 0 for g in GATES}

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
        self._reset_kpi_state()

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

    def set_weather(self, preset):
        """Apply weather preset to all vTypes and currently live vehicles (no booth dwell change)."""
        if preset not in WEATHER_PRESETS:
            return
        p = WEATHER_PRESETS[preset]
        self._active_weather = preset
        if not self._started:
            return

        # Scale ratios vs clear-weather baseline
        clear = WEATHER_PRESETS["clear"]
        scale_decel  = p["decel"]  / clear["decel"]
        scale_accel  = p["accel"]  / clear["accel"]
        scale_minGap = p["minGap"] / clear["minGap"]

        # Car vTypes (etc, cash)
        for vtype_name in ("etc", "cash"):
            try:
                traci.vehicletype.setSpeedFactor(vtype_name, p["speedFactor"])
                traci.vehicletype.setDecel(vtype_name, p["decel"])
                traci.vehicletype.setAccel(vtype_name, p["accel"])
                traci.vehicletype.setMinGap(vtype_name, p["minGap"])
                traci.vehicletype.setTau(vtype_name, p["tau"])
                traci.vehicletype.setImperfection(vtype_name, p["sigma"])
            except traci.TraCIException:
                pass

        # Truck: same proportional change off truck baseline
        try:
            traci.vehicletype.setSpeedFactor("truck", p["speedFactor"])
            traci.vehicletype.setDecel("truck", round(_TRUCK_BASE["decel"] * scale_decel, 2))
            traci.vehicletype.setAccel("truck", round(_TRUCK_BASE["accel"] * scale_accel, 2))
            traci.vehicletype.setMinGap("truck", round(_TRUCK_BASE["minGap"] * scale_minGap, 2))
            traci.vehicletype.setTau("truck", p["tau"])
            traci.vehicletype.setImperfection("truck", p["sigma"])
        except traci.TraCIException:
            pass

        # Re-apply to all currently live vehicles for immediate effect
        try:
            for vid in traci.vehicle.getIDList():
                vt = self._vid_to_type.get(vid, traci.vehicle.getTypeID(vid))
                if vt in ("etc", "cash"):
                    d, a, mg = p["decel"], p["accel"], p["minGap"]
                else:
                    d  = round(_TRUCK_BASE["decel"]  * scale_decel,  2)
                    a  = round(_TRUCK_BASE["accel"]  * scale_accel,  2)
                    mg = round(_TRUCK_BASE["minGap"] * scale_minGap, 2)
                traci.vehicle.setSpeedFactor(vid, p["speedFactor"])
                traci.vehicle.setDecel(vid, d)
                traci.vehicle.setAccel(vid, a)
                traci.vehicle.setMinGap(vid, mg)
                traci.vehicle.setTau(vid, p["tau"])
                traci.vehicle.setImperfection(vid, p["sigma"])
        except traci.TraCIException:
            pass

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

        # --- Track elapsed time for KPI rates ---
        if self._elapsed_t0 is None:
            self._elapsed_t0 = t

        # --- Collect vehicle data + update type registry ---
        current_ids = set(traci.vehicle.getIDList())
        if self._redirected:
            self._redirected &= current_ids

        vehicles = []
        queue_ap = 0
        for vid in current_ids:
            sx, sy = traci.vehicle.getPosition(vid)
            x, y = sumo_to_local(sx, sy)
            vtype = traci.vehicle.getTypeID(vid)
            self._vid_to_type[vid] = vtype   # register / refresh type
            vehicles.append({
                "id": vid,
                "x": round(x, 2),
                "y": round(y, 2),
                "angle": round(traci.vehicle.getAngle(vid), 1),
                "type": vtype,
            })
            if traci.vehicle.getSpeed(vid) < QUEUE_SPEED:
                lane = traci.vehicle.getLaneID(vid)
                if lane.rsplit("_", 1)[0] == "ap":
                    queue_ap += 1

        # --- Detect departures (vehicles that left the sim this step) ---
        prev_ids = set(self._vid_to_type.keys())
        departed_ids = prev_ids - current_ids
        departed_by_type = {}
        for vid in departed_ids:
            vt = self._vid_to_type.pop(vid, "etc")
            departed_by_type[vt] = departed_by_type.get(vt, 0) + 1

        # Update cumulative revenue from this step's departures
        rates, _ = kpi.load_tolls()
        step_rev = sum(departed_by_type.get(vt, 0) * rates.get(vt, 0.0) for vt in rates)
        self._cumulative_rev += step_rev

        # --- Booth occupancy ---
        booth = {g: traci.lane.getLastStepVehicleNumber(g) for g in GATES}
        for g in GATES:
            self._booth_tot[g] = self._booth_tot.get(g, 0) + 1
            if booth[g] > 0:
                self._booth_occ[g] = self._booth_occ.get(g, 0) + 1

        # --- Theoretical capacity (weather-preset scaled) ---
        # The plaza is normally under-saturated (measured throughput ≈ demand, not capacity),
        # so the rolling departure window would show demand rather than capacity.  Instead,
        # use a preset-calibrated theoretical capacity that encodes weather degradation and
        # is consistent with the offline FCD measurement (BASE_CAP_CLEAR_VPH for clear/10 lanes).
        n_open_lanes = len([g for g in GATES if g not in self.closed])
        cap_factor = CAPACITY_FACTORS.get(self._active_weather, 1.0)
        capacity_vph = round(BASE_CAP_CLEAR_VPH * (n_open_lanes / N_BOOTHS) * cap_factor)

        # --- Rolling 60-second departure window (used for throughput, not capacity) ---
        n_dep = sum(departed_by_type.values())
        if n_dep > 0:
            self._departure_deque.append((t, n_dep))
        # Drop entries older than 60s
        while self._departure_deque and t - self._departure_deque[0][0] > 60.0:
            self._departure_deque.popleft()
        rolling_dep_vph = sum(c for _, c in self._departure_deque) * 60

        # --- Accumulate window record ---
        self._window_records.append({
            "running": len(vehicles),
            "departed_by_type": departed_by_type,
            "booth_counts": booth,
            "time_loss_sum": 0.0,
            "time_loss_n": 0,
        })
        self._step_count += 1

        # --- Emit KPI-rich stats frame every 10 steps (~1 Hz at 10 Hz) ---
        live_stats = None
        if self._step_count % 10 == 0:
            elapsed_t = t - (self._elapsed_t0 or 0.0)
            elapsed_h = max(elapsed_t / 3600.0, 1e-9)
            open_lanes = [g for g in GATES if g not in self.closed]
            kpi_data = kpi.window(list(self._window_records), elapsed_h, open_lanes)
            # Use theoretical capacity (weather-scaled); compute satRatio vs demand
            kpi_data["capacityVph"] = capacity_vph
            demand_vph = kpi_data.get("throughputVph", 0)
            kpi_data["demandVph"] = demand_vph
            kpi_data["satRatio"] = round(demand_vph / capacity_vph, 3) if capacity_vph > 0 else 0.0
            # Patch cumulative revenue and weather
            kpi_data["cumulativeRevenue"] = round(self._cumulative_rev, 2)
            kpi_data["weather"]     = self._active_weather
            kpi_data["visibilityM"] = WEATHER_PRESETS[self._active_weather].get("visibilityM")
            kpi_data["running"]     = len(vehicles)
            kpi_data["queueAp"]     = queue_ap
            kpi_data["booth"]       = booth
            live_stats = kpi_data

        # Base stats frame (always emitted; replaced by live_stats when available)
        base_stats = {"running": len(vehicles), "queueAp": queue_ap, "booth": booth}

        return {
            "type": "step",
            "t": t,
            "vehicles": vehicles,
            "closed": sorted(self.closed),
            "stats": live_stats if live_stats is not None else base_stats,
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
            "weather": self._active_weather,
            "weatherPresets": WEATHER_PRESET_ORDER,
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
    elif c == "setWeather":
        SIM.set_weather(cmd.get("preset", "clear"))


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
