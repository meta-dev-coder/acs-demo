#!/usr/bin/env python3
"""
test_dataconnect_shim.py — plain-script tests for dataconnect_shim.py.

Plain assert-based script (no pytest dependency), mirrors sumo/test_*.py's style. Spawns the
shim as a real subprocess on a spare local port (never 8787, so it can't collide with a shim
someone already has running for manual testing), talks to it over plain urllib, and kills it
in `finally` no matter what.

Requires tools/dataconnect-data/*.json to already exist (run dataconnect_export.py first).

Run: python3 tools/test_dataconnect_shim.py
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM_PATH = os.path.join(HERE, "dataconnect_shim.py")
SEED_PATH = os.path.join(HERE, "dataconnect-data", "decisions_seed.json")
RUNTIME_PATH = os.path.join(HERE, "dataconnect-data", "runtime", "decisions.json")

FAILURES = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


# ── shim process management ──────────────────────────────────────────────────

def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_port(port: int, timeout: float = 5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError(f"shim did not start listening on port {port} within {timeout}s")


def _request(port, method, path, body=None, token=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    payload = json.dumps(body).encode() if body is not None else None
    try:
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        data = json.loads(raw) if raw else {}
        return resp.status, data
    finally:
        conn.close()


# ── tests ─────────────────────────────────────────────────────────────────────

def test_401_without_token(port):
    status, _ = _request(port, "GET", "/api/data-mgmt/v1/class")
    check("GET /class without Authorization -> 401", status == 401, f"got {status}")

    status, _ = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                          body={"className": "asset_registry", "page": 1, "pageSize": 10})
    check("POST /curated-data/search without Authorization -> 401", status == 401, f"got {status}")


def test_auth_flow(port):
    status, data = _request(port, "POST", "/api/authenticate", body={"username": "demo", "password": "demo"})
    check("POST /authenticate (any credentials) -> 200", status == 200, f"got {status}")
    check("POST /authenticate: response has token", isinstance(data.get("token"), str) and data["token"], data)
    check("POST /authenticate: response has refreshToken",
          isinstance(data.get("refreshToken"), str) and data["refreshToken"], data)
    check("POST /authenticate: token is JWT-shaped (3 dot-separated segments)",
          data.get("token", "").count(".") == 2, data.get("token"))

    token = data["token"]
    status, class_data = _request(port, "GET", "/api/data-mgmt/v1/class", token=token)
    check("GET /class with a freshly-issued Bearer token -> 200", status == 200, f"got {status}")
    names = {c["name"] for c in class_data.get("classes", [])}
    check("GET /class: includes asset_registry", "asset_registry" in names, names)


def test_envelope_fields(port, token):
    status, data = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                             body={"className": "asset_registry", "page": 1, "pageSize": 5}, token=token)
    check("POST /curated-data/search -> 200", status == 200, f"got {status}")
    for field in ("items", "page", "pageSize", "total"):
        check(f"search envelope has {field!r}", field in data, data.keys())
    check("search envelope: items is a list", isinstance(data.get("items"), list))
    check("search envelope: page echoes request", data.get("page") == 1, data.get("page"))
    check("search envelope: pageSize echoes request", data.get("pageSize") == 5, data.get("pageSize"))
    check("search envelope: items length matches pageSize on a full page",
          len(data.get("items", [])) == 5, len(data.get("items", [])))


def test_pagination_math(port, token):
    _, first = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                         body={"className": "asset_registry", "page": 1, "pageSize": 1000}, token=token)
    total = first["total"]
    check("pagination: total is the full asset_registry.json record count",
          total == 5015, f"got {total}")

    page_size = 1000
    last_full_page = total // page_size  # 1-indexed page number of the last full page
    _, last_full = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                             body={"className": "asset_registry", "page": last_full_page, "pageSize": page_size},
                             token=token)
    check(f"pagination: page {last_full_page} (last full page) has {page_size} items",
          len(last_full["items"]) == page_size, len(last_full["items"]))

    last_page = last_full_page + 1
    remainder = total - last_full_page * page_size
    _, tail = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                        body={"className": "asset_registry", "page": last_page, "pageSize": page_size},
                        token=token)
    check(f"pagination: page {last_page} (partial tail page) has the {remainder} leftover items",
          len(tail["items"]) == remainder, len(tail["items"]))
    check("pagination: tail page total still reports the full count",
          tail["total"] == total, tail["total"])

    beyond = last_page + 1
    _, empty = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                         body={"className": "asset_registry", "page": beyond, "pageSize": page_size},
                         token=token)
    check("pagination: a page past the end returns zero items, not an error",
          empty["items"] == [], empty["items"])
    check("pagination: a page past the end still reports the full total",
          empty["total"] == total, empty["total"])

    # No overlap and no gap between consecutive pages of a small pageSize.
    small = 200
    _, p1 = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                      body={"className": "asset_registry", "page": 1, "pageSize": small}, token=token)
    _, p2 = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                      body={"className": "asset_registry", "page": 2, "pageSize": small}, token=token)
    ids_p1 = {r["Asset ID"] for r in p1["items"]}
    ids_p2 = {r["Asset ID"] for r in p2["items"]}
    check("pagination: page 1 and page 2 (pageSize=200) don't overlap",
          ids_p1.isdisjoint(ids_p2), ids_p1 & ids_p2)
    check("pagination: page 1 has exactly pageSize items", len(p1["items"]) == small, len(p1["items"]))


def test_field_filter(port, token):
    status, filtered = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                                 body={"className": "asset_registry", "page": 1, "pageSize": 5000,
                                       "filters": {"Asset Category": "Lighting"}},
                                 token=token)
    check("filtered search -> 200", status == 200, f"got {status}")
    check("filtered search: total is less than the unfiltered class total",
          0 < filtered["total"] < 5015, filtered["total"])
    check("filtered search: total matches the known Lighting count (2679)",
          filtered["total"] == 2679, filtered["total"])
    check("filtered search: every returned item matches the filter",
          all(r.get("Asset Category") == "Lighting" for r in filtered["items"]),
          {r.get("Asset Category") for r in filtered["items"]})

    status, none_match = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                                   body={"className": "asset_registry", "page": 1, "pageSize": 10,
                                         "filters": {"Asset Category": "Nonexistent Category XYZ"}},
                                   token=token)
    check("filtered search on a value with no matches -> 200 with empty items",
          status == 200 and none_match["items"] == [] and none_match["total"] == 0,
          (status, none_match))


def test_write_401_without_token(port):
    status, _ = _request(port, "POST", "/api/data-mgmt/v1/curated-data/update",
                          body={"className": "decisions", "record": {"id": "no-auth"}})
    check("POST /curated-data/update without Authorization -> 401", status == 401, f"got {status}")


def test_decisions_seed_merge(port, token):
    seed = json.load(open(SEED_PATH))
    seed_count = len(seed)
    check("decisions_seed.json has ~15 seeded rows", seed_count >= 10, seed_count)
    check("every seed row is labelled seeded/source",
          all(r.get("seeded") is True and r.get("source") == "2024-26 closure history" for r in seed),
          [r.get("id") for r in seed if not (r.get("seeded") is True and r.get("source"))])

    # decisions class is readable (merged seed + runtime) even before any write happens.
    status, before = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                               body={"className": "decisions", "page": 1, "pageSize": 1000}, token=token)
    check("search className=decisions -> 200 before any write", status == 200, f"got {status}")
    check("decisions total before write == seed count", before.get("total") == seed_count, before.get("total"))

    new_record = {"id": "TEST-DEC-1", "segmentId": "east", "score": 0.42, "note": "unit-test write"}
    status, written = _request(port, "POST", "/api/data-mgmt/v1/curated-data/update",
                                body={"className": "decisions", "record": new_record}, token=token)
    check("POST /curated-data/update -> 200", status == 200, f"got {status}")
    check("update response echoes the record", written.get("record", {}).get("id") == "TEST-DEC-1", written)

    status, after = _request(port, "POST", "/api/data-mgmt/v1/curated-data/search",
                              body={"className": "decisions", "page": 1, "pageSize": 1000}, token=token)
    check("decisions total after one write == seed count + 1", after.get("total") == seed_count + 1,
          after.get("total"))
    ids = {r.get("id") for r in after.get("items", [])}
    check("written record is present in a subsequent read (read-back merge)", "TEST-DEC-1" in ids, ids)
    check("seed rows are still present alongside the written row",
          all(r["id"] in ids for r in seed), ids)

    check("runtime/decisions.json was created on disk by the write", os.path.exists(RUNTIME_PATH))
    runtime_rows = json.load(open(RUNTIME_PATH))
    check("runtime/decisions.json holds exactly the written row(s), not the seed",
          len(runtime_rows) == 1 and runtime_rows[0]["id"] == "TEST-DEC-1", runtime_rows)


def test_runtime_excluded_from_class_list(port, token):
    status, data = _request(port, "GET", "/api/data-mgmt/v1/class", token=token)
    check("GET /class -> 200", status == 200, f"got {status}")
    names = {c["name"] for c in data.get("classes", [])}
    check("class list includes decisions (merged seed+runtime)", "decisions" in names, names)
    check("class list does NOT include decisions_seed as its own class",
          "decisions_seed" not in names, names)
    check("class list does NOT include a class named runtime",
          "runtime" not in names, names)
    check("class list does NOT include any name containing 'runtime'",
          not any("runtime" in n for n in names), names)


def test_seed_immutable(port, token):
    before = open(SEED_PATH).read()
    # A second write, to make doubly sure repeated writes never touch the seed file.
    _request(port, "POST", "/api/data-mgmt/v1/curated-data/update",
             body={"className": "decisions", "record": {"id": "TEST-DEC-2"}}, token=token)
    after = open(SEED_PATH).read()
    check("decisions_seed.json is byte-identical after writes (seed is immutable)", before == after)


def test_write_unwritable_class_rejected(port, token):
    status, data = _request(port, "POST", "/api/data-mgmt/v1/curated-data/update",
                             body={"className": "asset_registry", "record": {"id": "x"}}, token=token)
    check("POST /curated-data/update on a non-writable class -> 400", status == 400, f"got {status}")


def test_cors_preflight(port):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("OPTIONS", "/api/data-mgmt/v1/curated-data/search")
        resp = conn.getresponse()
        resp.read()
        check("OPTIONS preflight -> 2xx", 200 <= resp.status < 300, resp.status)
        check("OPTIONS preflight: Access-Control-Allow-Origin: *",
              resp.getheader("Access-Control-Allow-Origin") == "*", resp.getheader("Access-Control-Allow-Origin"))
    finally:
        conn.close()

    status, _ = _request(port, "GET", "/api/data-mgmt/v1/class", token="whatever-nonempty-token")
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", "/api/data-mgmt/v1/class", headers={"Authorization": "Bearer x"})
        resp = conn.getresponse()
        resp.read()
        check("normal response also carries Access-Control-Allow-Origin: *",
              resp.getheader("Access-Control-Allow-Origin") == "*", resp.getheader("Access-Control-Allow-Origin"))
    finally:
        conn.close()


def main():
    data_dir = os.path.join(HERE, "dataconnect-data")
    if not os.path.isdir(data_dir) or not os.path.exists(os.path.join(data_dir, "asset_registry.json")):
        sys.exit("tools/dataconnect-data/asset_registry.json not found — run "
                 "`python3 tools/dataconnect_export.py <xlsx>` first.")

    if not os.path.exists(SEED_PATH):
        sys.exit("tools/dataconnect-data/decisions_seed.json not found — run "
                 "`node tools/seed_decisions.mjs` first.")

    # Fresh runtime state for a deterministic test run — the write tests assert exact counts.
    if os.path.exists(RUNTIME_PATH):
        os.remove(RUNTIME_PATH)

    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, SHIM_PATH, "--port", str(port)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        _wait_for_port(port)

        test_401_without_token(port)
        test_write_401_without_token(port)
        test_auth_flow(port)

        # Shared token for the tests that need one — fetched once, not re-derived per test.
        _, auth = _request(port, "POST", "/api/authenticate", body={"username": "demo", "password": "demo"})
        token = auth["token"]

        test_envelope_fields(port, token)
        test_pagination_math(port, token)
        test_field_filter(port, token)
        test_decisions_seed_merge(port, token)
        test_runtime_excluded_from_class_list(port, token)
        test_seed_immutable(port, token)
        test_write_unwritable_class_rejected(port, token)
        test_cors_preflight(port)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        if proc.stdout:
            leftover = proc.stdout.read()
            if leftover and FAILURES:
                print("\n--- shim stdout/stderr ---")
                print(leftover)
        # Leave no runtime artifact behind after a test run (gitignored anyway, but tidy).
        if os.path.exists(RUNTIME_PATH):
            os.remove(RUNTIME_PATH)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        sys.exit(1)
    print("All tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
