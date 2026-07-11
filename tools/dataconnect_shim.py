#!/usr/bin/env python3
"""
dataconnect_shim.py — stdlib-only stand-in for the DataConnect (Cohesive/Bentley) API surface.

Serves the JSON exported by dataconnect_export.py (tools/dataconnect-data/<class>.json) behind
the same three endpoints the live demo instance (dataconnect-demo-dqa3.cohesivecloud.app)
exposes, so the CesiumJS client (Component 3, dataconnect.js — not built yet) can be pointed
at either one with only a base-URL + credentials change (see the design spec's "swap-ready"
approach). This shim is intentionally dumb: it does not validate credentials or verify JWTs,
it just shapes responses to match the protocol so the client's auth/pagination code paths get
real exercise.

Endpoints
---------
POST /api/authenticate
    Body: {username, password} (any values accepted).
    -> 200 {"token": "<jwt-shaped>", "refreshToken": "<jwt-shaped>"}

GET /api/data-mgmt/v1/class
    Requires "Authorization: Bearer <token>".
    -> 200 {"classes": [{"name": "asset_registry", "recordCount": 3504}, ...]}

POST /api/data-mgmt/v1/curated-data/search
    Requires "Authorization: Bearer <token>".
    Body: {"className": "asset_registry", "page": 1, "pageSize": 200, "filters": {...}}
      - page is 1-indexed. filters is an optional {field: value} exact-match map.
    -> 200 {"items": [...], "page": 1, "pageSize": 200, "total": 3504}

POST /api/data-mgmt/v1/curated-data/update
    Requires "Authorization: Bearer <token>".
    Body: {"className": "decisions", "record": {...}}
      - Only "decisions" is writable today (UC1 P4, design spec §5). Other classNames -> 400.
    -> 200 {"ok": true, "record": {...}}
    Appends to the gitignored runtime log (tools/dataconnect-data/runtime/decisions.json), never
    to the committed seed (tools/dataconnect-data/decisions_seed.json). Reads of the "decisions"
    class (both GET /class's recordCount and POST /curated-data/search) merge the seed with the
    runtime log live, so a write is visible on the very next read without restarting the shim.
    The class loader skips both decisions_seed.json (folded into "decisions", not its own class)
    and the runtime/ directory (never becomes a class by accident; e2e runs never dirty the
    working tree — review-mandated fix, design spec §5).

Every response carries "Access-Control-Allow-Origin: *"; OPTIONS is answered for preflight.
Any request to a data-mgmt endpoint without a well-formed "Authorization: Bearer ..." header
gets a 401 — this is what exercises the client's auth path; the shim does not check the token
value itself (any string minted by /api/authenticate, or indeed any non-empty bearer token,
is accepted — this is a demo credentials stand-in, not a security boundary).

Start:
  python3 tools/dataconnect_shim.py            # serves http://localhost:8787
  python3 tools/dataconnect_shim.py --port 9000
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "dataconnect-data")
DEFAULT_PORT = 8787

# --- "decisions" class: committed read-only seed + gitignored runtime log (design spec §5) --------
DECISIONS_CLASS_NAME = "decisions"
DECISIONS_SEED_FILENAME = "decisions_seed.json"
RUNTIME_DIRNAME = "runtime"
WRITABLE_CLASSES = {DECISIONS_CLASS_NAME}

_runtime_lock = threading.Lock()


def _load_classes(data_dir: str) -> dict:
    """Loads every <class>.json in data_dir (skips *.rejected.json) into memory once.

    Deliberately SKIPS decisions_seed.json (loaded separately by _load_decisions_seed and folded
    into the dynamic "decisions" class, never exposed as a class of its own) and the runtime/
    subdirectory (never a class source — os.listdir would skip it anyway since it isn't a
    *.json file, but the check is explicit here because that exclusion is review-mandated, not
    incidental).
    """
    classes = {}
    if not os.path.isdir(data_dir):
        print(f"[dataconnect_shim] WARNING: data dir not found: {data_dir} (run dataconnect_export.py first)",
              file=sys.stderr)
        return classes
    for name in sorted(os.listdir(data_dir)):
        if name == RUNTIME_DIRNAME or name == DECISIONS_SEED_FILENAME:
            continue
        if not name.endswith(".json") or name.endswith(".rejected.json"):
            continue
        class_name = name[: -len(".json")]
        with open(os.path.join(data_dir, name)) as f:
            classes[class_name] = json.load(f)
    return classes


def _load_decisions_seed(data_dir: str) -> list:
    """Loads the committed, read-only decisions_seed.json once at startup. Never rewritten by
    the shim — POST /curated-data/update only ever appends to the runtime log (see
    _append_runtime_decision)."""
    path = os.path.join(data_dir, DECISIONS_SEED_FILENAME)
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f)


def _runtime_decisions_path(data_dir: str) -> str:
    return os.path.join(data_dir, RUNTIME_DIRNAME, "decisions.json")


def _read_runtime_decisions(data_dir: str) -> list:
    """Reads the runtime log live off disk on every call (not cached) so a write is visible on
    the very next read, per-process, without restarting the shim."""
    path = _runtime_decisions_path(data_dir)
    if not os.path.exists(path):
        return []
    with _runtime_lock:
        with open(path) as f:
            return json.load(f)


def _append_runtime_decision(data_dir: str, record: dict) -> dict:
    """Appends `record` to runtime/decisions.json (creating the directory/file on first write).
    Read-modify-write under a lock — fine for this demo shim's write volume."""
    path = _runtime_decisions_path(data_dir)
    with _runtime_lock:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        existing = []
        if os.path.exists(path):
            with open(path) as f:
                existing = json.load(f)
        existing.append(record)
        with open(path, "w") as f:
            json.dump(existing, f, indent=2)
            f.write("\n")
    return record


def _merged_decisions(server) -> list:
    return [*server.decisions_seed, *_read_runtime_decisions(server.data_dir)]


def _b64url(obj: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def _make_jwt(subject: str, ttl_seconds: int) -> str:
    """A JWT-*shaped* (three dot-separated base64url segments) demo token. Not signed, not
    meant to be verified — the shim's own auth check just requires a Bearer header to be
    present (see class comment)."""
    header = {"alg": "none", "typ": "JWT"}
    now = int(time.time())
    payload = {"sub": subject, "iat": now, "exp": now + ttl_seconds}
    return f"{_b64url(header)}.{_b64url(payload)}.dataconnect-shim"


def _matches_filters(record: dict, filters: dict) -> bool:
    return all(record.get(field) == value for field, value in filters.items())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- plumbing -----------------------------------------------------------------------
    def log_message(self, fmt, *args):
        print(f"[dataconnect_shim] {self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and len(auth) > len("Bearer ")

    # --- CORS preflight -------------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # --- routes -----------------------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/data-mgmt/v1/class":
            if not self._authorized():
                self._send_json(401, {"error": "unauthorized"})
                return
            classes = [
                {"name": name, "recordCount": len(records)}
                for name, records in sorted(self.server.classes.items())
            ]
            classes.append({"name": DECISIONS_CLASS_NAME, "recordCount": len(_merged_decisions(self.server))})
            classes.sort(key=lambda c: c["name"])
            self._send_json(200, {"classes": classes})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/authenticate":
            self._read_json_body()  # any credentials accepted; body not otherwise inspected
            self._send_json(200, {
                "token": _make_jwt("demo-user", ttl_seconds=3600),
                "refreshToken": _make_jwt("demo-user-refresh", ttl_seconds=86400),
            })
            return

        if path == "/api/data-mgmt/v1/curated-data/search":
            if not self._authorized():
                self._send_json(401, {"error": "unauthorized"})
                return
            body = self._read_json_body()
            class_name = body.get("className")
            page = max(1, int(body.get("page", 1) or 1))
            page_size = max(1, int(body.get("pageSize", 100) or 100))
            filters = body.get("filters") or {}

            if class_name == DECISIONS_CLASS_NAME:
                records = _merged_decisions(self.server)
            else:
                records = self.server.classes.get(class_name)
                if records is None:
                    self._send_json(404, {"error": f"unknown className: {class_name!r}"})
                    return

            matching = [r for r in records if _matches_filters(r, filters)] if filters else records
            start = (page - 1) * page_size
            items = matching[start:start + page_size]
            self._send_json(200, {
                "items": items,
                "page": page,
                "pageSize": page_size,
                "total": len(matching),
            })
            return

        if path == "/api/data-mgmt/v1/curated-data/update":
            if not self._authorized():
                self._read_json_body()  # drain the body so a keep-alive connection stays in sync
                self._send_json(401, {"error": "unauthorized"})
                return
            body = self._read_json_body()
            class_name = body.get("className")
            if class_name not in WRITABLE_CLASSES:
                self._send_json(400, {"error": f"class not writable: {class_name!r}"})
                return
            record = body.get("record")
            if not isinstance(record, dict):
                self._send_json(400, {"error": "record must be an object"})
                return
            saved = _append_runtime_decision(self.server.data_dir, record)
            self._send_json(200, {"ok": True, "record": saved})
            return

        self._send_json(404, {"error": "not found"})


def serve(port: int = DEFAULT_PORT, data_dir: str = DATA_DIR):
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.data_dir = data_dir
    server.classes = _load_classes(data_dir)
    server.decisions_seed = _load_decisions_seed(data_dir)
    print(f"[dataconnect_shim] serving {len(server.classes)} class(es) from {data_dir}")
    for name, records in sorted(server.classes.items()):
        print(f"[dataconnect_shim]   {name}: {len(records)} records")
    print(f"[dataconnect_shim]   {DECISIONS_CLASS_NAME}: {len(server.decisions_seed)} seeded "
          f"+ {len(_read_runtime_decisions(data_dir))} runtime")
    print(f"[dataconnect_shim] listening on http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--data-dir", default=DATA_DIR)
    args = parser.parse_args()
    serve(port=args.port, data_dir=args.data_dir)


if __name__ == "__main__":
    main()
