#!/usr/bin/env bash
# Build the I-595 toll-plaza PoC data: compile the net, run both SUMO scenarios, and convert
# their FCD trajectories into the JSON the Cesium app plays back.
#
# SUMO is installed via the `eclipse-sumo` pip wheel (no Homebrew). We resolve SUMO_HOME from the
# Python package so this works without any global PATH/SUMO_HOME setup.
#
# Demand pipeline (transaction-driven):
#   1. transactions.{baseline,intervention}.csv  — synthetic per-booth, per-bin, per-class counts
#   2. csv2counts.py  — converts CSV → SUMO <routes> with Poisson arrivals; capacity-checked
#   3. sumo -c plaza.{baseline,intervention}.sumocfg  — routes now reference generated .sampled.rou.xml
#   4. fcd2json.py  — FCD → georef JSON for the Cesium app
set -euo pipefail
cd "$(dirname "$0")"

export SUMO_HOME="$(python3 -c 'import sumo; print(sumo.SUMO_HOME)')"
export PATH="$SUMO_HOME/bin:$PATH"
echo "Using SUMO_HOME=$SUMO_HOME"

DATA_DIR="../cesium-poc/public/data"
mkdir -p out "$DATA_DIR"

echo "== georef_nodes.py — write UTM node coords =="
python3 georef_nodes.py

echo "== netconvert =="
netconvert --node-files plaza.nod.xml --edge-files plaza.edg.xml \
           --connection-files plaza.con.xml \
           --proj "+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs" \
           --proj.inverse \
           --output-file plaza.net.xml --no-turnarounds true

echo "== csv2counts — transaction-driven demand =="
python3 csv2counts.py transactions.baseline.csv     plaza.vtypes.xml baseline     out/plaza.baseline.sampled.rou.xml
python3 csv2counts.py transactions.intervention.csv plaza.vtypes.xml intervention  out/plaza.intervention.sampled.rou.xml

echo "== baseline =="
# Emit raw UTM FCD (no --fcd-output.geo): x,y are raw UTM 17N metres.
# fcd2json.py converts them back to local SUMO plaza metres via utm_to_local().
# This keeps CoordinateTransform as the single placement authority: both vehicles
# and gate markers go through T.sumoToWorld(x, y), so marking moves traffic too.
sumo -c plaza.baseline.sumocfg --no-step-log true \
     --fcd-output out/baseline.fcd.xml

echo "== intervention =="
sumo -c plaza.intervention.sumocfg --no-step-log true \
     --fcd-output out/intervention.fcd.xml

echo "== fcd -> json =="
python3 fcd2json.py out/baseline.fcd.xml     out/baseline.tripinfo.xml     "$DATA_DIR/baseline.json"
python3 fcd2json.py out/intervention.fcd.xml out/intervention.tripinfo.xml "$DATA_DIR/intervention.json"

echo "Done. JSON written to $DATA_DIR"
