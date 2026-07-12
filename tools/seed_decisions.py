#!/usr/bin/env python3
"""
seed_decisions.py — DEPRECATED (UC1 deck-parity Phase 1, item 5: "seed revenue $0" fix).

This closed-form generator estimated demand with a single constant slice at demandProfile.json's
SHOULDER multiplier, which never exceeds a closed segment's capacity for any segment's
demandScale — so every one of the ~15 seeded decisions' revenueAtRiskUsd.point came out $0, every
time. It has been replaced by tools/seed_decisions.mjs, which runs the same historical rows
through the REAL evaluator (createWindowEvaluator() in cesium-poc/src/windowEval.js, fed by
cesium-poc/src/demand.js's actual 15-minute demand curve) instead of re-deriving the math here.

Run: node tools/seed_decisions.mjs
"""
import sys

sys.exit(
    "tools/seed_decisions.py is deprecated (it produced $0 revenue-at-risk for every seeded row — "
    "see the module docstring). Use the real generator instead:\n\n"
    "    node tools/seed_decisions.mjs\n"
)
