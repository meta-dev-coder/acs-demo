#!/usr/bin/env python3
"""Phase 9A - prove we can retrieve the real Speckle BIM model through the API.

A PROOF OF RETRIEVAL, not an integration. Nothing here writes to Speckle, touches the Cesium
frontend, or reads the locally downloaded IFC file - the whole point is to establish that the
model's elements and geometry can be obtained from Speckle Cloud, so the IFC is deliberately not
a fallback. If a stage fails, it is reported as failed.

The four stages the report keeps apart, because conflating them is the easy way to claim a
success that did not happen:

  1. GraphQL metadata retrieval   - the server knows about the project, model and version
  2. Bundle retrieval             - the actual model data came down
  3. BIM element extraction       - the elements carry identity, classification and properties
  4. Geometry extraction          - there are meshes with vertices and faces

Stage 1 passing tells you almost nothing about stage 2. This version is bundle-only: its data
lives in a parquet bundle with no legacy object graph, so `GET /objects/.../single` answers
BUNDLE_REFERENCE_NOT_FOUND and is never attempted here.

Run:  tools/speckle/.venv/bin/python tools/speckle/verify_speckle.py
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent.parent          # cesium-poc/
REPORT_PATH = HERE / "verification-report.json"

# The default urllib/requests user agent is refused by the CDN in front of app.speckle.systems
# with HTTP 403 "error code: 1010" - a Cloudflare browser-integrity rejection that looks exactly
# like an authorization failure and is not one. Sending a real agent string avoids an hour spent
# debugging the wrong layer.
USER_AGENT = "acs-demo-speckle-verify/1.0 (+phase-9a)"

GRAPHQL_TIMEOUT = 30


# ───────────────────────────────────────────────────────────────────────────────────────────────
# environment
# ───────────────────────────────────────────────────────────────────────────────────────────────

def load_repo_env() -> None:
    """Read the repo's .env files with the SAME precedence the Node server uses.

    server/loadEnv.mjs is the authority: the real environment wins, then `.env.local`, then
    `.env`, and whichever gets there first keeps the value. Matching it matters - a token that
    works for `npm run dev` and not for this script, or the reverse, is a confusing afternoon.

    Deliberately not python-dotenv: its override semantics differ, and this is twenty lines.
    """
    for name in (".env.local", ".env"):
        path = PROJECT_ROOT / name
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            # By name, never by contents: these files hold credentials.
            print(f"  ! could not read {name}: {type(error).__name__}")
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[len("export "):]
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            else:
                value = value.split(" #")[0].strip()
            os.environ[key] = value


@dataclass
class Config:
    server_url: str
    token: str
    project_id: str
    model_id: str
    version_id: str

    @property
    def configured(self) -> bool:
        return bool(self.token)


def read_config() -> Config:
    return Config(
        server_url=os.environ.get("SPECKLE_SERVER_URL", "https://app.speckle.systems").rstrip("/"),
        token=os.environ.get("SPECKLE_API_TOKEN", "").strip(),
        project_id=os.environ.get("SPECKLE_PROJECT_ID", "13347d8410").strip(),
        model_id=os.environ.get("SPECKLE_MODEL_ID", "d1fdafff76").strip(),
        version_id=os.environ.get("SPECKLE_VERSION_ID", "84a80194f5").strip(),
    )


def scrub(text: Any, token: str) -> Any:
    """Remove the token from anything on its way to a log, a report or a terminal.

    A server that echoes the credential in an error body is not hypothetical - the same guard
    exists on the Node side of this repo because an upstream 401 did exactly that once. A short
    token is not substituted, because replacing a 3-character string would corrupt the message.
    """
    if not isinstance(text, str) or not token or len(token) < 8:
        return text
    return text.replace(token, "[redacted]")


# ───────────────────────────────────────────────────────────────────────────────────────────────
# results
# ───────────────────────────────────────────────────────────────────────────────────────────────

PASS, FAIL, SKIPPED = "PASS", "FAIL", "SKIPPED"

# Failure classes, from the brief. The point of classifying is that the remedies differ: a scope
# problem is fixed on the Speckle side, an SDK problem by upgrading, a network one by waiting.
AUTH_FAILURE = "AUTHENTICATION_OR_AUTHORIZATION"
SDK_FAILURE = "UNSUPPORTED_SDK_OR_BUNDLE_FORMAT"
NETWORK_FAILURE = "NETWORK"
REFERENCE_FAILURE = "INVALID_MODEL_REFERENCE"
DECODE_FAILURE = "DATA_DECODING"
CONFIG_FAILURE = "CONFIGURATION"
OTHER_FAILURE = "OTHER"


@dataclass
class Stage:
    key: str
    title: str
    status: str = SKIPPED
    detail: dict[str, Any] = field(default_factory=dict)
    failure_class: str | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {"stage": self.key, "title": self.title, "status": self.status,
                "failureClass": self.failure_class, "error": self.error, **self.detail}


def classify(error: BaseException, token: str) -> tuple[str, str]:
    """Map a real exception onto one of the brief's classes. Never a guess dressed as a finding."""
    name = type(error).__name__
    message = scrub(str(error), token) or name
    blob = f"{name}: {message}".lower()

    if any(word in blob for word in ("unauthorized", "forbidden", "401", "403",
                                     "not logged in", "invalid token", "scope")):
        return AUTH_FAILURE, message
    if any(word in blob for word in ("timeout", "connection", "dns", "resolve", "ssl",
                                     "network", "unreachable")):
        return NETWORK_FAILURE, message
    if any(word in blob for word in ("not found", "notfound", "404", "no such",
                                     "bundle_reference_not_found")):
        return REFERENCE_FAILURE, message
    if any(word in blob for word in ("pyarrow", "parquet", "unsupported", "attributeerror",
                                     "has no attribute", "importerror", "modulenotfound")):
        return SDK_FAILURE, message
    if any(word in blob for word in ("decode", "parse", "json", "codec", "unicode", "struct")):
        return DECODE_FAILURE, message
    return OTHER_FAILURE, message


# ───────────────────────────────────────────────────────────────────────────────────────────────
# GraphQL
# ───────────────────────────────────────────────────────────────────────────────────────────────

def graphql(config: Config, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    """One POST to /graphql. Raises on transport, HTTP or GraphQL-level errors alike.

    GraphQL answers HTTP 200 with an `errors` array, so a status check alone would read a
    permission refusal as a success with empty data.
    """
    import requests

    response = requests.post(
        f"{config.server_url}/graphql",
        json={"query": query, "variables": variables},
        headers={
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            **({"authorization": f"Bearer {config.token}"} if config.token else {}),
        },
        timeout=GRAPHQL_TIMEOUT,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"HTTP {response.status_code} from {config.server_url}/graphql: "
            f"{scrub(response.text[:400], config.token)}"
        )
    try:
        payload = response.json()
    except ValueError as error:
        raise RuntimeError(f"The GraphQL endpoint returned a non-JSON body: {error}") from error
    if payload.get("errors"):
        first = payload["errors"][0]
        code = (first.get("extensions") or {}).get("code", "GRAPHQL_ERROR")
        raise RuntimeError(f"{code}: {scrub(first.get('message', 'no message'), config.token)}")
    return payload.get("data") or {}


# ───────────────────────────────────────────────────────────────────────────────────────────────
# tests
# ───────────────────────────────────────────────────────────────────────────────────────────────

def test_a_authentication(config: Config, stage: Stage) -> dict[str, Any] | None:
    """Who the token belongs to, and whether it can see this server at all."""
    stage.detail["serverUrl"] = config.server_url
    stage.detail["projectId"] = config.project_id
    # The token itself is never recorded. Its LENGTH is, because "the variable is set but empty"
    # and "the variable is set to something" are different diagnoses.
    stage.detail["tokenPresent"] = bool(config.token)
    stage.detail["tokenLength"] = len(config.token)

    data = graphql(config, "query { activeUser { id name email } serverInfo { name version } }", {})
    user = data.get("activeUser")
    if not user:
        raise RuntimeError(
            "The server accepted the request but reports no active user, which means the token "
            "is not a personal access token for this server."
        )
    # The id and name identify the account for the operator; the email is account data the brief
    # asks us to keep out of the report, so it is checked and dropped.
    stage.detail["authenticatedUser"] = {"id": user.get("id"), "name": user.get("name")}
    stage.detail["server"] = data.get("serverInfo")
    stage.status = PASS
    return user


def test_b_project_and_model(config: Config, stage: Stage) -> dict[str, Any]:
    data = graphql(
        config,
        """query($projectId: String!, $modelId: String!) {
             project(id: $projectId) {
               id name description visibility createdAt updatedAt
               model(id: $modelId) { id name description updatedAt }
             }
           }""",
        {"projectId": config.project_id, "modelId": config.model_id},
    )
    project = data.get("project")
    if not project:
        raise RuntimeError(f"No project {config.project_id} is visible to this token.")
    model = project.get("model")
    if not model:
        raise RuntimeError(
            f"Project {config.project_id} is visible but has no model {config.model_id}."
        )

    stage.detail["project"] = {"id": project.get("id"), "name": project.get("name"),
                               "visibility": project.get("visibility"),
                               "createdAt": project.get("createdAt")}
    stage.detail["model"] = {"id": model.get("id"), "name": model.get("name"),
                             "updatedAt": model.get("updatedAt")}
    stage.detail["idsMatchConfiguration"] = (
        project.get("id") == config.project_id and model.get("id") == config.model_id
    )
    stage.status = PASS if stage.detail["idsMatchConfiguration"] else FAIL
    if stage.status == FAIL:
        stage.error = "The server returned a different project or model id than was configured."
        stage.failure_class = REFERENCE_FAILURE
    return project


def test_c_latest_version(config: Config, stage: Stage) -> dict[str, Any]:
    """The latest published version - NOT assumed to be the configured one.

    The brief fixes a version id, and a model that has been published again since then would make
    that id stale. Both are reported, and whether they agree is a finding rather than something
    the script quietly papers over.
    """
    data = graphql(
        config,
        """query($projectId: String!, $modelId: String!) {
             project(id: $projectId) {
               model(id: $modelId) {
                 versions(limit: 5) {
                   totalCount
                   items { id message sourceApplication createdAt referencedObject }
                 }
               }
             }
           }""",
        {"projectId": config.project_id, "modelId": config.model_id},
    )
    versions = (((data.get("project") or {}).get("model") or {}).get("versions") or {})
    items = versions.get("items") or []
    if not items:
        raise RuntimeError(f"Model {config.model_id} has no published versions.")

    latest = items[0]
    referenced = latest.get("referencedObject") or ""
    stage.detail["versionCount"] = versions.get("totalCount")
    stage.detail["latestVersion"] = {
        "id": latest.get("id"), "createdAt": latest.get("createdAt"),
        "referencedObject": referenced, "sourceApplication": latest.get("sourceApplication"),
        "message": latest.get("message"),
    }
    stage.detail["configuredVersionId"] = config.version_id
    stage.detail["configuredVersionIsLatest"] = latest.get("id") == config.version_id
    stage.detail["isBundleReference"] = referenced.startswith("bundle.")
    stage.detail["recentVersions"] = [
        {"id": v.get("id"), "createdAt": v.get("createdAt"),
         "referencedObject": v.get("referencedObject")} for v in items
    ]
    if not stage.detail["configuredVersionIsLatest"]:
        stage.detail["note"] = (
            f"The configured version {config.version_id} is not the latest; the model has been "
            f"published again since. Retrieval below uses the CONFIGURED version, because that is "
            f"what this phase was asked to verify."
        )
    stage.status = PASS
    return latest


def test_d_bundle_retrieval(config: Config, stage: Stage):
    """Pull the actual model data down with the SDK's bundle-aware receive.

    `operations.receive3` is the supported path for a bundle-only version. The legacy
    `operations.receive(obj_id)` also detects a `bundle.` prefix and routes to the bundle reader,
    but it is marked deprecated from 2026.9 in favour of this one, so that is what is used.

    Returns the open Model. The CALLER closes it - the model owns a download directory and the
    geometry is parsed from disk on first access, so closing here would break tests E and F.
    """
    from specklepy.api import credentials, operations

    account = credentials.get_account_from_token(config.token, config.server_url)
    model = operations.receive3(
        account,
        project_id=config.project_id,
        model_id=config.model_id,
        version_id=config.version_id,
        include_geometry=True,
        # This is a verification run, not a consumer catching up on a feed. Marking the version
        # received would alter state on somebody's Speckle project for a read-only test.
        mark_received=False,
    )

    objects = list(model.objects)
    stage.detail["receiveMethod"] = "specklepy.api.operations.receive3"
    stage.detail["rootObjectType"] = type(model).__module__ + "." + type(model).__name__
    stage.detail["units"] = model.units
    stage.detail["objectCount"] = len(objects)
    # Lazy: geometry is parsed from disk on first access, so this is False until stage F asks.
    stage.detail["geometryLoadedAtReceive"] = bool(model.is_geometry_loaded)
    stage.detail["structure"] = {
        "objects": len(objects),
        "nodes": len(list(model.nodes)),
        "levels": len(list(model.levels)),
        "materials": len(list(model.materials)),
        "collections": len(list(model.collections)),
        "definitions": len(list(model.definitions)),
        "colors": len(list(model.colors)),
        # Reachable through the objects, which is the only place a DECODABLE wrapper lives.
        "geometryRecords": len(model.geometries),
        "geometriesOnObjects": sum(len(list(o.geometries)) for o in objects),
    }
    stage.detail["propertyPaths"] = sorted(model.property_paths)[:40]
    stage.detail["propertyPathCount"] = len(model.property_paths)
    stage.status = PASS if objects else FAIL
    if not objects:
        stage.error = "The bundle was retrieved but contains no objects."
        stage.failure_class = DECODE_FAILURE
    return model


def _describe_element(obj: Any) -> dict[str, Any]:
    """One element, described from what is ACTUALLY there.

    No IFC field is invented. Every lookup below is attempted against the real object and recorded
    as null when absent, because "this model has no IfcGUID" is a finding a Cesium integration
    needs, and a fabricated one would be discovered much later and much more expensively.
    """
    def safe(fn, default=None):
        try:
            return fn()
        except Exception:
            return default

    properties = safe(lambda: dict(obj.properties.items()), {}) or {}
    type_properties = safe(lambda: dict(obj.type_properties.items()), {}) or {}
    root_properties = safe(lambda: dict(obj.root_properties.items()), {}) or {}
    merged = {**root_properties, **type_properties, **properties}

    # Candidate keys for the IFC identity, matched case-insensitively against what the model
    # actually carries rather than assumed. The winner is reported with the key it came from, so
    # a reader can see WHERE the value was found.
    def find(*needles) -> tuple[str | None, Any]:
        for key, value in merged.items():
            flat = key.lower().replace("_", "").replace(".", "")
            if any(needle in flat for needle in needles):
                return key, value
        return None, None

    guid_key, guid = find("globalid", "ifcguid")

    geometries = safe(lambda: list(obj.geometries), []) or []
    level = safe(lambda: obj.level)
    path = safe(lambda: list(obj.collection_path), []) or []

    """
    THE IFC ENTITY IS IN THE COLLECTION PATH, not in `speckle_type`.

    Every object in this model reports `speckle_type == "Objects.Data.DataObject"` — the generic
    Speckle wrapper, identical for a beam, a roof and a site, and useless as a classification.
    The actual IFC entity is the collection the object sits in: `["IfcBeam"]`, `["IfcSite"]`,
    `["IfcRoof"]`. Reporting the former as "the classification" would have been technically a
    field lookup and practically a wrong answer, so both are reported and the IFC one is named as
    such.
    """
    ifc_entity = next((part for part in path if str(part).lower().startswith("ifc")), None)
    class_key, classification = find("ifcclass", "ifctype", "entitytype")

    return {
        "name": safe(lambda: obj.name),
        "collectionPath": path,
        "ifcGuid": {"key": guid_key, "value": guid},
        "ifcEntity": {"key": "collection_path", "value": ifc_entity},
        "ifcClassification": {"key": class_key, "value": classification},
        # From the merged dict: `properties.get("speckle_type")` does not resolve a bare key on a
        # PropertyView, and reporting None for a value that is plainly there reads as "absent".
        "speckleType": merged.get("speckle_type"),
        "level": safe(lambda: level.name if level else None),
        "material": safe(lambda: obj.material.name if obj.material else None),
        "propertyCount": len(merged),
        "propertySample": {k: merged[k] for k in list(merged)[:12]},
        "geometryCount": len(geometries),
    }


def test_e_elements(model: Any, stage: Stage) -> list[dict[str, Any]]:
    objects = list(model.objects)
    sample = [_describe_element(obj) for obj in objects[:10]]

    # Coverage is counted over EVERY object, not just the ten printed. "0 of 10 have a level"
    # would read as "the model has no storeys" when it has one with six members in it.
    all_described = [_describe_element(obj) for obj in objects]
    def coverage(predicate) -> int:
        return sum(1 for e in all_described if predicate(e))

    entities: dict[str, int] = {}
    for element in all_described:
        key = element["ifcEntity"]["value"] or "(none)"
        entities[key] = entities.get(key, 0) + 1

    stage.detail["elementCount"] = len(objects)
    stage.detail["sampleSize"] = len(sample)
    stage.detail["sample"] = sample
    stage.detail["identity"] = {
        "withIfcGuid": coverage(lambda e: e["ifcGuid"]["value"] is not None),
        "withIfcEntity": coverage(lambda e: e["ifcEntity"]["value"] is not None),
        "withLevel": coverage(lambda e: bool(e["level"])),
        "withGeometry": coverage(lambda e: e["geometryCount"] > 0),
        "outOf": len(all_described),
    }
    stage.detail["ifcEntityBreakdown"] = dict(sorted(entities.items(),
                                                     key=lambda kv: -kv[1]))
    stage.detail["levels"] = [
        {"name": lvl.name, "objectCount": len(list(lvl.objects))}
        for lvl in list(model.levels)[:20]
    ]
    stage.status = PASS if objects else FAIL
    if not objects:
        stage.error = "No elements to extract."
    return sample


def test_f_geometry(model: Any, stage: Stage) -> None:
    """Is there geometry a Cesium tileset could be built from?

    Counts come from DECODING real meshes, not from trusting a flag. A bundle can report geometry
    rows and still decode to nothing, and the difference matters entirely to Phase 9B.

    THE GEOMETRY IS REACHED THROUGH THE OBJECTS. `model.geometries` is a `dict[int, Geometry]` of
    the raw, still-encoded records — `Geometry` has `content`/`type` and no `decode_mesh`. The
    decodable wrapper is `ModelGeometry`, which is what `object.geometries` yields and which
    carries the placement transform as well. Iterating the model-level dict gets you its integer
    keys, which is how this first reported "0 meshes" against a model that has sixteen.
    """
    raw_records = len(model.geometries)
    pairs = [(obj, geometry) for obj in model.objects for geometry in obj.geometries]

    stage.detail["rawGeometryRecords"] = raw_records
    stage.detail["geometryReachableFromObjects"] = len(pairs)
    stage.detail["units"] = model.units
    stage.detail["geometryLoaded"] = bool(model.is_geometry_loaded)

    decoded, failed = 0, 0
    vertices = faces = 0
    with_transform = 0
    kinds: dict[str, int] = {}
    roles: dict[str, int] = {}
    unit_set: set[str] = set()
    samples: list[dict[str, Any]] = []
    first_error: str | None = None

    for obj, geometry in pairs:
        role = getattr(getattr(geometry, "role", None), "name", None)
        if role:
            roles[role] = roles.get(role, 0) + 1
        transform = getattr(geometry, "transform", None)
        if transform is not None and len(list(transform)) == 16:
            with_transform += 1
        try:
            mesh = geometry.decode_mesh()
        except Exception as error:   # noqa: BLE001 - a per-mesh failure is data, not a crash
            failed += 1
            if first_error is None:
                first_error = f"{type(error).__name__}: {error}"
            continue
        if mesh is None:
            continue
        decoded += 1
        kind = type(mesh).__name__
        kinds[kind] = kinds.get(kind, 0) + 1

        vertex_count = len(getattr(mesh, "vertices", []) or []) // 3
        face_count = _count_faces(getattr(mesh, "faces", []) or [])
        vertices += vertex_count
        faces += face_count
        if getattr(mesh, "units", None):
            unit_set.add(str(mesh.units))
        if len(samples) < 5:
            samples.append({
                "object": getattr(obj, "name", None),
                "meshType": kind,
                "role": role,
                "vertexCount": vertex_count,
                "faceCount": face_count,
                "hasNormals": bool(getattr(mesh, "vertex_normals", None)),
                "hasVertexColors": bool(getattr(mesh, "colors", None)),
                "hasTextureCoordinates": bool(getattr(mesh, "texture_coordinates", None)),
                "units": getattr(mesh, "units", None),
                "hasPlacementTransform": transform is not None,
            })

    stage.detail["decodedMeshes"] = decoded
    stage.detail["failedMeshes"] = failed
    stage.detail["firstDecodeError"] = first_error
    stage.detail["meshKinds"] = kinds
    stage.detail["geometryRoles"] = roles
    stage.detail["meshUnits"] = sorted(unit_set)
    stage.detail["totalVertices"] = vertices
    stage.detail["totalTriangles"] = faces
    stage.detail["meshesWithPlacementTransform"] = with_transform
    stage.detail["meshSamples"] = samples
    stage.detail["geometryAvailable"] = decoded > 0 and vertices > 0 and faces > 0
    stage.detail["cesiumConvertible"] = bool(
        stage.detail["geometryAvailable"] and (model.units or unit_set)
    )
    # The instancing finding, which changes how Phase 9B must be built.
    stage.detail["instanced"] = with_transform > 0
    stage.detail["placementNote"] = (
        f"{with_transform} of {len(pairs)} meshes carry a 4x4 placement transform: the vertices "
        "are in definition-local coordinates and the transform places each instance in the world. "
        "A converter that ignores it will pile every element onto the origin."
        if with_transform else
        "No placement transforms are present; vertices appear to be in world coordinates."
    )
    stage.detail["cesiumNote"] = (
        "Sufficient. Indexed triangles with per-mesh units and a placement transform are enough "
        "to build glTF/GLB and then 3D Tiles. Georeferencing is NOT in the model - an origin and "
        "orientation must be supplied at placement, exactly as the existing I-595 models are."
        if stage.detail["cesiumConvertible"] else
        "Not enough geometry was decoded to claim Cesium convertibility."
    )
    stage.status = PASS if stage.detail["geometryAvailable"] else FAIL
    if stage.status == FAIL:
        stage.error = "No mesh decoded to usable vertex data."
        stage.failure_class = DECODE_FAILURE


def _count_faces(faces: list[int]) -> int:
    """Count faces in Speckle's run-length list: [n, i0..i(n-1), n, i0..i(n-1), ...].

    NOT `len(faces) // 3`. The list interleaves a vertex count with its indices, so a triangle
    occupies four entries, and dividing by three both overcounts triangles and silently produces
    nonsense for any quad or n-gon.
    """
    count = index = 0
    length = len(faces)
    while index < length:
        n = int(faces[index])
        if n < 3:
            # Speckle has historically also used 0/1 as markers for triangle/quad. Treat an
            # implausible run length as a malformed list rather than reading past the end.
            return count
        index += n + 1
        count += 1
    return count


# ───────────────────────────────────────────────────────────────────────────────────────────────
# driver
# ───────────────────────────────────────────────────────────────────────────────────────────────

def sdk_versions() -> dict[str, Any]:
    from importlib import metadata
    out: dict[str, Any] = {"python": sys.version.split()[0]}
    for package in ("specklepy", "pyarrow", "requests"):
        try:
            out[package] = metadata.version(package)
        except Exception:
            out[package] = None
    try:
        from specklepy.api import operations
        out["bundleAware"] = hasattr(operations, "receive3")
        out["bundleReferencePrefix"] = getattr(operations, "BUNDLE_REFERENCE_PREFIX", None)
    except Exception as error:
        out["sdkImportError"] = type(error).__name__
    return out


def main() -> int:
    print("Phase 9A - Speckle BIM retrieval verification")
    print("=" * 78)
    load_repo_env()
    config = read_config()
    versions = sdk_versions()

    print(f"Python {versions['python']} | specklepy {versions.get('specklepy')} | "
          f"pyarrow {versions.get('pyarrow')}")
    print(f"Server {config.server_url} | project {config.project_id} | "
          f"model {config.model_id} | version {config.version_id}")
    print()

    stages = {
        "A": Stage("A", "Authentication"),
        "B": Stage("B", "Project and model discovery (GraphQL)"),
        "C": Stage("C", "Latest version (GraphQL)"),
        "D": Stage("D", "SDK bundle retrieval"),
        "E": Stage("E", "BIM element extraction"),
        "F": Stage("F", "Geometry verification"),
    }
    limitations: list[str] = []
    model = None

    if not config.configured:
        message = (
            "SPECKLE_API_TOKEN is not set, so no request was made.\n\n"
            "  Create a personal access token at "
            f"{config.server_url}/profile (Developer settings -> Access tokens)\n"
            "  with at least the `streams:read` scope, then add it to the git-ignored file\n"
            f"  {PROJECT_ROOT / '.env.local'} :\n\n"
            "      SPECKLE_SERVER_URL=https://app.speckle.systems\n"
            "      SPECKLE_API_TOKEN=<your token>\n"
            f"      SPECKLE_PROJECT_ID={config.project_id}\n"
            f"      SPECKLE_MODEL_ID={config.model_id}\n"
            f"      SPECKLE_VERSION_ID={config.version_id}\n\n"
            "  Then re-run:  tools/speckle/.venv/bin/python tools/speckle/verify_speckle.py"
        )
        print("SETUP REQUIRED")
        print(message)
        for stage in stages.values():
            stage.status = SKIPPED
            stage.failure_class = CONFIG_FAILURE
            stage.error = "SPECKLE_API_TOKEN is not set."
        limitations.append("No token was configured, so nothing was retrieved from Speckle.")
        write_report(config, versions, stages, limitations, configured=False)
        return 2

    order = ["A", "B", "C", "D", "E", "F"]
    for key in order:
        stage = stages[key]
        try:
            if key == "A":
                test_a_authentication(config, stage)
            elif key == "B":
                test_b_project_and_model(config, stage)
            elif key == "C":
                test_c_latest_version(config, stage)
            elif key == "D":
                model = test_d_bundle_retrieval(config, stage)
            elif key == "E":
                if model is None:
                    stage.error = "Bundle retrieval did not succeed, so there is nothing to read."
                    break
                test_e_elements(model, stage)
            elif key == "F":
                if model is None:
                    stage.error = "Bundle retrieval did not succeed, so there is no geometry."
                    break
                test_f_geometry(model, stage)
        except Exception as error:   # noqa: BLE001 - every failure is a finding, not a crash
            stage.status = FAIL
            stage.failure_class, stage.error = classify(error, config.token)
            stage.detail["traceback"] = scrub(traceback.format_exc()[-1200:], config.token)
            print(f"  {key}  {stage.title}: FAIL [{stage.failure_class}]")
            print(f"       {stage.error}")
            # A, B and C are preconditions for D: without a readable project there is nothing to
            # receive, and continuing would produce a second, louder copy of the same failure.
            if key in ("A", "B", "C", "D"):
                limitations.append(f"Stage {key} failed, so later stages did not run.")
                break
            continue
        print(f"  {key}  {stage.title}: {stage.status}")

    if model is not None:
        try:
            model.close()      # it owns a download directory; parsed data stays usable
        except Exception:
            pass

    summarize(stages)
    path = write_report(config, versions, stages, limitations, configured=True)
    print(f"\nReport: {path}")
    return 0 if all(s.status == PASS for s in stages.values()) else 1


def summarize(stages: dict[str, Stage]) -> None:
    print()
    print("-" * 78)
    print("STAGE SUMMARY")
    for stage in stages.values():
        mark = {PASS: "PASS", FAIL: "FAIL", SKIPPED: "SKIP"}[stage.status]
        extra = f"  [{stage.failure_class}]" if stage.failure_class else ""
        print(f"  {mark}  {stage.key}  {stage.title}{extra}")
        if stage.error:
            print(f"        {stage.error[:160]}")
    d, e, f = stages["D"], stages["E"], stages["F"]
    print()
    print("THE FOUR CLAIMS, KEPT APART")
    print(f"  1. GraphQL metadata retrieved : {stages['B'].status}")
    print(f"  2. Model bundle retrieved     : {d.status}"
          f"  ({d.detail.get('objectCount', 0)} objects)")
    print(f"  3. BIM elements extracted     : {e.status}"
          f"  ({e.detail.get('elementCount', 0)} elements)")
    print(f"  4. Geometry extracted         : {f.status}"
          f"  ({f.detail.get('decodedMeshes', 0)} meshes, "
          f"{f.detail.get('totalVertices', 0)} vertices)")


def recommendation(stages: dict[str, Stage]) -> str:
    if stages["F"].status == PASS:
        return (
            "Proceed to Phase 9B. The supported path is operations.receive3 server-side, which "
            "returns decoded meshes with units and per-element properties. Build a Node or Python "
            "service that receives a version, converts the meshes to glTF/GLB (and then 3D Tiles "
            "if the element count warrants it), caches the output by version id, and serves it "
            "same-origin. The SPECKLE_API_TOKEN stays server-side exactly as the OpenProject and "
            "SAP tokens do."
        )
    if stages["D"].status == PASS:
        return ("The bundle downloads but geometry did not decode. Resolve that before any Cesium "
                "work: inspect the geometry records in the report and confirm the pyarrow build.")
    if stages["B"].status == PASS:
        return ("GraphQL metadata works and bundle retrieval does not. This is NOT sufficient to "
                "proceed - metadata is not a model. Resolve the failure class in stage D first.")
    return "Resolve authentication and project access before anything else."


def write_report(config: Config, versions: dict[str, Any], stages: dict[str, Stage],
                 limitations: list[str], *, configured: bool) -> Path:
    d, e, f = stages["D"], stages["E"], stages["F"]
    report = {
        "phase": "9A - Speckle BIM retrieval verification",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "server": config.server_url,
        "projectId": config.project_id,
        "modelId": config.model_id,
        "versionId": config.version_id,
        "versions": versions,
        "configured": configured,
        # The four claims, never collapsed into one "success".
        "results": {
            "authentication": stages["A"].status,
            "graphqlMetadata": stages["B"].status,
            "bundleRetrieval": d.status,
            "elementExtraction": e.status,
            "geometryExtraction": f.status,
        },
        "elementCount": e.detail.get("elementCount"),
        "geometryAvailable": f.detail.get("geometryAvailable", False),
        "sampleElements": e.detail.get("sample", []),
        "stages": [stage.to_json() for stage in stages.values()],
        "errors": [
            {"stage": s.key, "class": s.failure_class, "message": s.error}
            for s in stages.values() if s.error
        ],
        "limitations": limitations,
        "recommendedNextStep": recommendation(stages),
        # Stated in the artefact itself, so the file cannot be mistaken for a credential store.
        "note": "No token, email or other account credential is recorded in this report.",
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    return REPORT_PATH


if __name__ == "__main__":
    sys.exit(main())
