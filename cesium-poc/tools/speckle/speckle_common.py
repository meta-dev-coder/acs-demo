"""Shared Speckle plumbing: configuration, retrieval, and the facts about this model's shape.

Extracted from `verify_speckle.py` in Phase 9B so the verifier and the converter cannot drift.
Everything the two both need lives here exactly once — most importantly the three things Phase 9A
established by inspecting the real data, each of which is easy to get wrong in a plausible way:

  1. the decodable geometry hangs off the OBJECTS, not off `model.geometries`
  2. `faces` is run-length encoded, so `len(faces) // 3` is not a triangle count
  3. the IFC class is `ifcType` / `collection_path`, never `speckle_type`

Nothing here writes to Speckle. Every call is a read.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent.parent          # cesium-poc/

# The default urllib/requests user agent is refused by the CDN in front of app.speckle.systems
# with HTTP 403 "error code: 1010" - a Cloudflare browser-integrity rejection that looks exactly
# like an authorization failure and is not one.
USER_AGENT = "acs-demo-speckle/1.0"

GRAPHQL_TIMEOUT = 30


# ───────────────────────────────────────────────────────────────────────────────────────────────
# configuration
# ───────────────────────────────────────────────────────────────────────────────────────────────

def load_repo_env() -> None:
    """Read the repo's .env files with the SAME precedence the Node server uses.

    `server/loadEnv.mjs` is the authority: the real environment wins, then `.env.local`, then
    `.env`, and whichever gets there first keeps the value. Matching it matters - a token that
    works for `npm run dev` and not for a script, or the reverse, is a confusing afternoon.

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


def read_config(version_override: str | None = None) -> Config:
    return Config(
        server_url=os.environ.get("SPECKLE_SERVER_URL", "https://app.speckle.systems").rstrip("/"),
        token=os.environ.get("SPECKLE_API_TOKEN", "").strip(),
        project_id=os.environ.get("SPECKLE_PROJECT_ID", "13347d8410").strip(),
        model_id=os.environ.get("SPECKLE_MODEL_ID", "d1fdafff76").strip(),
        version_id=(version_override or os.environ.get("SPECKLE_VERSION_ID", "84a80194f5")).strip(),
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
# retrieval
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


VERSION_HISTORY_QUERY = """query($projectId: String!, $modelId: String!, $limit: Int!, $cursor: String) {
  project(id: $projectId) {
    id name
    model(id: $modelId) {
      id name
      versions(limit: $limit, cursor: $cursor) {
        totalCount
        cursor
        items { id createdAt message sourceApplication referencedObject }
      }
    }
  }
}"""


def version_history(config: Config, *, page_size: int = 100, max_pages: int = 20
                    ) -> dict[str, Any]:
    """EVERY published version, oldest first.

    Paginated through Speckle's cursor: a model with more versions than one page is the normal
    case for a real project, and a timeline built from the first page only would silently begin
    partway through the build.

    Speckle returns newest first; the timeline wants oldest first, and the friendly V1..Vn labels
    are derived from that chronological order rather than from anything Speckle supplies - it has
    no such concept, and inventing one that disagreed with `createdAt` would be worse than none.
    """
    items: list[dict[str, Any]] = []
    cursor = None
    total = None
    project_name = model_name = None
    pages = 0
    truncated = False

    while True:
        data = graphql(config, VERSION_HISTORY_QUERY, {
            "projectId": config.project_id, "modelId": config.model_id,
            "limit": page_size, "cursor": cursor,
        })
        project = data.get("project")
        if not project:
            raise RuntimeError(f"No project {config.project_id} is visible to this token.")
        model = project.get("model")
        if not model:
            raise RuntimeError(f"Project {config.project_id} has no model {config.model_id}.")
        project_name = project.get("name")
        model_name = model.get("name")
        block = model.get("versions") or {}
        total = block.get("totalCount", total)
        page = block.get("items") or []
        items.extend(page)
        pages += 1
        cursor = block.get("cursor")
        if not cursor or not page:
            break
        if pages >= max_pages:
            truncated = True
            break

    # Oldest first. `createdAt` is the authority; the id is the tie-break so the order is stable
    # for two versions published in the same millisecond.
    ordered = sorted(items, key=lambda entry: (str(entry.get("createdAt") or ""),
                                               str(entry.get("id") or "")))
    for index, entry in enumerate(ordered, start=1):
        entry["ordinal"] = index
        entry["label"] = f"V{index}"

    return {
        "projectId": config.project_id, "projectName": project_name,
        "modelId": config.model_id, "modelName": model_name,
        "totalCount": total, "returned": len(ordered), "pages": pages,
        "truncated": truncated or (total is not None and len(ordered) < total),
        "versions": ordered,
    }


def version_meta(config: Config, version_id: str) -> dict[str, Any] | None:
    """One version's OWN metadata.

    Exists because the manifest used to carry the LATEST version's `createdAt` and
    `referencedObject` whatever version was being converted - so every historical version was
    stamped with the newest one's publication time. Caught by converting five versions and
    noticing all five manifests agreed.
    """
    history = version_history(config)
    for entry in history["versions"]:
        if entry.get("id") == version_id:
            return {**entry, "projectName": history["projectName"],
                    "modelName": history["modelName"], "versionCount": history["totalCount"]}
    return None


LATEST_VERSION_QUERY = """query($projectId: String!, $modelId: String!) {
  project(id: $projectId) {
    id name
    model(id: $modelId) {
      id name
      versions(limit: 1) {
        totalCount
        items { id createdAt referencedObject sourceApplication message }
      }
    }
  }
}"""


def latest_version(config: Config) -> dict[str, Any]:
    """The newest published version, with the project and model names beside it."""
    data = graphql(config, LATEST_VERSION_QUERY,
                   {"projectId": config.project_id, "modelId": config.model_id})
    project = data.get("project")
    if not project:
        raise RuntimeError(f"No project {config.project_id} is visible to this token.")
    model = project.get("model")
    if not model:
        raise RuntimeError(f"Project {config.project_id} has no model {config.model_id}.")
    items = ((model.get("versions") or {}).get("items")) or []
    if not items:
        raise RuntimeError(f"Model {config.model_id} has no published versions.")
    version = items[0]
    return {
        "projectId": project.get("id"),
        "projectName": project.get("name"),
        "modelId": model.get("id"),
        "modelName": model.get("name"),
        "versionId": version.get("id"),
        "createdAt": version.get("createdAt"),
        "referencedObject": version.get("referencedObject"),
        "sourceApplication": version.get("sourceApplication"),
        "message": version.get("message"),
        "versionCount": (model.get("versions") or {}).get("totalCount"),
    }


def open_model(config: Config, *, include_geometry: bool = True):
    """Receive a bundle-only version. The CALLER closes the returned model.

    `operations.receive3` is the supported path for a bundle reference; the legacy
    `/objects/.../single` endpoint answers BUNDLE_REFERENCE_NOT_FOUND for this version and is
    never attempted. `mark_received=False` because a read must not alter state on the project.
    """
    from specklepy.api import credentials, operations

    account = credentials.get_account_from_token(config.token, config.server_url)
    return operations.receive3(
        account,
        project_id=config.project_id,
        model_id=config.model_id,
        version_id=config.version_id,
        include_geometry=include_geometry,
        mark_received=False,
    )


# ───────────────────────────────────────────────────────────────────────────────────────────────
# this model's actual shape
# ───────────────────────────────────────────────────────────────────────────────────────────────

def count_faces(faces: list[int]) -> int:
    """Count faces in Speckle's run-length list: [n, i0..i(n-1), n, i0..i(n-1), ...].

    NOT `len(faces) // 3`. The list interleaves a vertex count with its indices, so a triangle
    occupies four entries, and dividing by three both overcounts triangles and produces nonsense
    for any quad or n-gon.
    """
    count = index = 0
    length = len(faces)
    while index < length:
        n = int(faces[index])
        if n < 3:
            # An implausible run length means a malformed list; stop rather than read past the end.
            return count
        index += n + 1
        count += 1
    return count


def triangulate(faces: list[int]) -> list[tuple[int, int, int]]:
    """The same run-length list, as triangles.

    An n-gon is fanned from its first vertex, which is correct for the convex faces an IFC
    tessellation produces and is what every glTF exporter does. A degenerate run stops the walk
    rather than silently emitting garbage triangles.
    """
    out: list[tuple[int, int, int]] = []
    index = 0
    length = len(faces)
    while index < length:
        n = int(faces[index])
        if n < 3 or index + n >= length:
            break
        loop = [int(faces[index + 1 + k]) for k in range(n)]
        for k in range(1, n - 1):
            out.append((loop[0], loop[k], loop[k + 1]))
        index += n + 1
    return out


def element_geometries(model) -> Iterator[tuple[Any, Any]]:
    """Every (object, ModelGeometry) pair in the model.

    THROUGH THE OBJECTS, deliberately. `model.geometries` is a `dict[int, Geometry]` of raw,
    still-encoded records: `Geometry` carries `content`/`type` and has no `decode_mesh`, and
    iterating the dict yields its integer KEYS. The decodable wrapper is `ModelGeometry`, which
    only `object.geometries` yields and which is also what carries the placement transform.
    Getting this wrong reports "0 meshes" against a model with sixteen.
    """
    for obj in model.objects:
        for geometry in obj.geometries:
            yield obj, geometry


def merged_properties(obj) -> dict[str, Any]:
    """Root, type and instance properties flattened into one dict, instance winning."""
    def safe(fn, default):
        try:
            return fn()
        except Exception:
            return default

    return {
        **safe(lambda: dict(obj.root_properties.items()), {}),
        **safe(lambda: dict(obj.type_properties.items()), {}),
        **safe(lambda: dict(obj.properties.items()), {}),
    }


def describe_element(obj) -> dict[str, Any]:
    """One element's identity and properties, from what is ACTUALLY there.

    No IFC field is invented. Every lookup is attempted against the real object and recorded as
    null when absent, because "this model has no IfcGUID" is a finding a Cesium integration needs
    and a fabricated one would be discovered much later and much more expensively.
    """
    def safe(fn, default=None):
        try:
            return fn()
        except Exception:
            return default

    merged = merged_properties(obj)

    def find(*needles) -> tuple[str | None, Any]:
        for key, value in merged.items():
            flat = key.lower().replace("_", "").replace(".", "")
            if any(needle in flat for needle in needles):
                return key, value
        return None, None

    guid_key, guid = find("globalid", "ifcguid")
    class_key, classification = find("ifcclass", "ifctype", "entitytype")
    path = safe(lambda: list(obj.collection_path), []) or []

    # THE IFC ENTITY IS IN `ifcType` AND THE COLLECTION PATH, never in `speckle_type`. Every
    # object in this model reports `Objects.Data.DataObject` - the generic Speckle wrapper,
    # identical for a beam, a roof and a site, and useless as a classification. The two real
    # sources agree, so both are kept and either can check the other.
    path_entity = next((part for part in path if str(part).lower().startswith("ifc")), None)
    level = safe(lambda: obj.level)

    return {
        "name": safe(lambda: obj.name),
        "ifcGuid": guid if isinstance(guid, str) else (str(guid) if guid is not None else None),
        "ifcGuidSource": guid_key,
        "ifcType": classification,
        "ifcTypeSource": class_key,
        "collectionPath": path,
        "collectionEntity": path_entity,
        "speckleType": merged.get("speckle_type"),
        "level": safe(lambda: level.name if level else None),
        "material": safe(lambda: obj.material.name if obj.material else None),
        "properties": {str(k): _plain(v) for k, v in merged.items()},
        "geometryCount": len(safe(lambda: list(obj.geometries), []) or []),
    }


def _plain(value: Any) -> Any:
    """A JSON-safe copy. Anything exotic becomes its string form rather than breaking the dump."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    return str(value)


def ifc_entity_of(element: dict[str, Any]) -> str:
    """The IFC class to group and filter by, with the two sources cross-checked.

    `ifcType` is preferred because it is a property of the element itself; the collection path is
    the fallback and the disagreement is worth knowing about, so the caller can see both fields.
    """
    return str(element.get("ifcType") or element.get("collectionEntity") or "Unclassified")
