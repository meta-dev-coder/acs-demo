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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "dataconnect-data")
DEFAULT_PORT = 8787


def _load_classes(data_dir: str) -> dict:
    """Loads every <class>.json in data_dir (skips *.rejected.json) into memory once."""
    classes = {}
    if not os.path.isdir(data_dir):
        print(f"[dataconnect_shim] WARNING: data dir not found: {data_dir} (run dataconnect_export.py first)",
              file=sys.stderr)
        return classes
    for name in sorted(os.listdir(data_dir)):
        if not name.endswith(".json") or name.endswith(".rejected.json"):
            continue
        class_name = name[: -len(".json")]
        with open(os.path.join(data_dir, name)) as f:
            classes[class_name] = json.load(f)
    return classes


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

        self._send_json(404, {"error": "not found"})


def serve(port: int = DEFAULT_PORT, data_dir: str = DATA_DIR):
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.classes = _load_classes(data_dir)
    print(f"[dataconnect_shim] serving {len(server.classes)} class(es) from {data_dir}")
    for name, records in sorted(server.classes.items()):
        print(f"[dataconnect_shim]   {name}: {len(records)} records")
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
