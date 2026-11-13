#!/usr/bin/env python3
"""Phase 9B — turn a Speckle bundle into a Cesium-ready GLB plus element metadata.

Read-only against Speckle. Retrieval is `speckle_common.open_model`, the same call the Phase 9A
verifier makes, so there is one implementation of "get the model" rather than two that can drift.

What it writes into the output directory:

    model.glb       one GLB, one node/mesh/primitive per BIM element, with EXT_mesh_features and
                    EXT_structural_metadata so a Cesium pick resolves to an IFC GlobalId
    elements.json   every element's identity, properties, storey, bounds and feature index
    manifest.json   what was converted, from which version, with counts, bounds and any errors

The three facts this depends on, each established against the real data in Phase 9A rather than
assumed, and each of which has a test:

  1. THE PLACEMENT TRANSFORM IS ROW-MAJOR. The 16 floats end `0,0,0,1` - a row-major bottom row -
     and only the row-major reading puts the six girders at six different heights. Read as
     column-major they all collapse to z = -0.1, which is what a wrong frame looks like.
  2. `faces` IS RUN-LENGTH ENCODED as `[n, i0..i(n-1), ...]`, so a triangle occupies four entries
     and `len(faces) // 3` is not a triangle count.
  3. THE DECODABLE GEOMETRY HANGS OFF THE OBJECTS. `model.geometries` is a dict of raw records
     whose iteration yields integer keys.

The transform is applied EXACTLY ONCE, here, and the manifest says so, so nothing downstream
applies it again.

Run:
    tools/speckle/.venv/bin/python tools/speckle/convert_speckle.py --out <dir> [--version <id>]
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import speckle_common as sc                                   # noqa: E402
from gltf_writer import GltfBuilder, z_up_to_y_up             # noqa: E402

# A readable default per IFC class, used only when the model supplies no colour of its own. Not a
# classification scheme and not a legend — the UI shows the class in words beside every element.
DEFAULT_COLOURS: dict[str, tuple[int, int, int, int]] = {
    "IfcBeam": (168, 132, 72, 255),
    "IfcWall": (205, 200, 190, 255),
    "IfcFooting": (130, 130, 136, 255),
    "IfcSlab": (175, 175, 180, 255),
    "IfcColumn": (150, 140, 120, 255),
    "IfcRoof": (150, 95, 80, 255),
    "IfcBuildingElementProxy": (140, 160, 185, 255),
}
FALLBACK_COLOUR = (175, 178, 184, 255)


# ───────────────────────────────────────────────────────────────────────────────────────────────
# geometry
# ───────────────────────────────────────────────────────────────────────────────────────────────

def apply_row_major(matrix: list[float], point: tuple[float, float, float]
                    ) -> tuple[float, float, float]:
    """p' = M . p for a ROW-MAJOR 4x4 with translation in the fourth column of each row.

    Verified against the data, not assumed - see the module docstring.
    """
    x, y, z = point
    return (
        matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
        matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
        matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
    )


def normal_matrix(matrix: list[float]) -> list[float]:
    """The inverse transpose of the upper-left 3x3, for transforming normals.

    The rotation alone is correct only when the transform has no scale or shear. These placements
    look rigid, but a converter that assumes so is one non-uniform-scale element away from
    lighting that is subtly, unaccountably wrong — so the general form is used, falling back to
    the rotation when the matrix is singular.
    """
    a, b, c = matrix[0], matrix[1], matrix[2]
    d, e, f = matrix[4], matrix[5], matrix[6]
    g, h, i = matrix[8], matrix[9], matrix[10]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-12:
        return [a, b, c, d, e, f, g, h, i]
    inv = [
        (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
        (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
        (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
    ]
    # transpose of the inverse
    return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]


def apply_normal(m3: list[float], n: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = n
    nx = m3[0] * x + m3[1] * y + m3[2] * z
    ny = m3[3] * x + m3[4] * y + m3[5] * z
    nz = m3[6] * x + m3[7] * y + m3[8] * z
    length = (nx * nx + ny * ny + nz * nz) ** 0.5
    return (nx / length, ny / length, nz / length) if length > 1e-9 else (0.0, 0.0, 1.0)


def geometry_fingerprint(positions: list[tuple[float, float, float]],
                         triangles: list[tuple[int, int, int]],
                         lo: list[float], hi: list[float]) -> dict[str, Any]:
    """A shape signature that survives re-tessellation but not an actual change.

    THE POINT OF THIS FUNCTION. Between V1 and V2 of the real model, the IFC exporter
    re-tessellated five elements: `house - foundation` went from 68 triangles to 64, the back wall
    from 96 to 95. Not one of them moved — every bound is identical to six decimal places — and a
    comparison keyed on vertex or triangle counts would have reported five false "modified"
    elements, which is precisely what the brief says not to do.

    SURFACE AREA is the invariant that distinguishes the two cases: splitting a quad into two
    triangles leaves it unchanged (measured: identical to 1e-5 m² across all five), while moving,
    resizing or reshaping an element changes it. Area and bounds and centroid together are
    sensitive to translation, scale and shape, and blind to triangulation and vertex order.

    Counts are still recorded — they are true, and a reader comparing two versions deserves to see
    that the mesh was rebuilt — but they are NOT part of the equality test.
    """
    area = 0.0
    for a, b, c in triangles:
        p0, p1, p2 = positions[a], positions[b], positions[c]
        ux, uy, uz = (p1[i] - p0[i] for i in range(3))
        vx, vy, vz = (p2[i] - p0[i] for i in range(3))
        cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        area += 0.5 * (cx * cx + cy * cy + cz * cz) ** 0.5

    centroid = [0.0, 0.0, 0.0]
    if positions:
        for point in positions:
            for axis in range(3):
                centroid[axis] += point[axis]
        centroid = [value / len(positions) for value in centroid]

    return {
        # Rounded here, once, so every consumer compares the same numbers rather than each
        # choosing its own tolerance and disagreeing with the others.
        "area": round(area, 4),
        "centroid": [round(value, 4) for value in centroid],
        "bounds": {"min": [round(value, 4) for value in lo],
                   "max": [round(value, 4) for value in hi]},
        "vertexCount": len(positions),
        "triangleCount": len(triangles),
        "note": "area/centroid/bounds are the equality test; the counts are reported but not "
                "compared, because a re-tessellation changes them without changing the shape.",
    }


def _colour_of(geometry: Any, ifc_type: str) -> tuple[int, int, int, int]:
    """The model's own colour when it has one, otherwise a readable default for the class."""
    for attr in ("effective_color", "color"):
        value = getattr(geometry, attr, None)
        if value is None:
            continue
        for field in ("argb", "value", "rgba"):
            raw = getattr(value, field, None)
            if isinstance(raw, int):
                a = (raw >> 24) & 0xFF
                return ((raw >> 16) & 0xFF, (raw >> 8) & 0xFF, raw & 0xFF, a or 255)
        r, g, b = (getattr(value, k, None) for k in ("red", "green", "blue"))
        if all(isinstance(v, (int, float)) for v in (r, g, b)):
            scale = 255 if max(r, g, b) <= 1.0 else 1
            return (int(r * scale), int(g * scale), int(b * scale), 255)
    return DEFAULT_COLOURS.get(ifc_type, FALLBACK_COLOUR)


# ───────────────────────────────────────────────────────────────────────────────────────────────
# conversion
# ───────────────────────────────────────────────────────────────────────────────────────────────

def convert(config: sc.Config, out_dir: Path) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    out_dir.mkdir(parents=True, exist_ok=True)

    # THE VERSION'S OWN METADATA, not the latest version's. `latest_version()` was used here and
    # stamped every historical version with the newest one's publication time and referenced
    # object — so a five-version timeline showed five identical dates. Found by converting all
    # five and noticing the manifests agreed.
    header = sc.version_meta(config, config.version_id)
    if header is None:
        raise RuntimeError(
            f"Version {config.version_id} is not published for model {config.model_id}.")
    model = sc.open_model(config)
    errors: list[dict[str, Any]] = []

    try:
        builder = GltfBuilder()
        elements: list[dict[str, Any]] = []
        by_guid: dict[str, int] = {}

        # Bounds in the MODEL's own frame (Speckle Z-up metres), which is what a test can compare
        # against the decoded source. The glTF frame is Y-up and reported separately.
        lo = [float("inf")] * 3
        hi = [float("-inf")] * 3
        total_triangles = 0
        total_vertices = 0

        for index, obj in enumerate(model.objects):
            described = sc.describe_element(obj)
            ifc_type = sc.ifc_entity_of(described)
            guid = described.get("ifcGuid")
            geometries = list(obj.geometries)

            element: dict[str, Any] = {
                "index": index,
                "name": described["name"],
                # PRESERVED EXACTLY. No replacement GUID is ever generated: an invented id would
                # join to nothing outside this demo and would look authoritative while doing it.
                "ifcGuid": guid,
                "ifcGuidSource": described["ifcGuidSource"],
                "ifcType": ifc_type,
                "ifcTypeSource": described["ifcTypeSource"],
                "collectionPath": described["collectionPath"],
                # Recorded so a reader can see the two independent sources agree, or do not.
                "ifcTypeAgrees": bool(
                    described["ifcType"] and described["collectionEntity"]
                    and str(described["ifcType"]) == str(described["collectionEntity"])),
                "speckleType": described["speckleType"],
                "level": described["level"],
                "material": described["material"],
                "properties": described["properties"],
                "hasGeometry": bool(geometries),
                "featureIndex": None,
                "vertexCount": 0,
                "triangleCount": 0,
                "bounds": None,
            }

            if not guid:
                errors.append({"element": described["name"], "kind": "MISSING_IFC_GUID",
                               "detail": "No GlobalId; it cannot be joined to anything outside "
                                         "this model."})

            if not geometries:
                # Containers (IfcSite, IfcBuilding, IfcBuildingStorey) legitimately carry none.
                elements.append(element)
                continue

            positions: list[tuple[float, float, float]] = []
            normals: list[tuple[float, float, float]] = []
            triangles: list[tuple[int, int, int]] = []
            e_lo = [float("inf")] * 3
            e_hi = [float("-inf")] * 3
            colour = FALLBACK_COLOUR

            for geometry in geometries:
                try:
                    mesh = geometry.decode_mesh()
                except Exception as error:      # noqa: BLE001 — one bad mesh is data, not a crash
                    errors.append({"element": described["name"], "kind": "MESH_DECODE_FAILED",
                                   "detail": f"{type(error).__name__}: {error}"})
                    continue
                if mesh is None:
                    continue

                raw = list(getattr(mesh, "vertices", []) or [])
                faces = [int(v) for v in (getattr(mesh, "faces", []) or [])]
                raw_normals = list(getattr(mesh, "vertex_normals", []) or [])
                if not raw or not faces:
                    continue

                matrix = list(geometry.transform) if geometry.transform is not None else None
                m3 = normal_matrix(matrix) if matrix else None
                base = len(positions)
                colour = _colour_of(geometry, ifc_type)

                for v in range(0, len(raw) - 2, 3):
                    point = (raw[v], raw[v + 1], raw[v + 2])
                    # APPLIED ONCE, HERE.
                    world = apply_row_major(matrix, point) if matrix else point
                    for axis, value in enumerate(world):
                        e_lo[axis] = min(e_lo[axis], value)
                        e_hi[axis] = max(e_hi[axis], value)
                        lo[axis] = min(lo[axis], value)
                        hi[axis] = max(hi[axis], value)
                    positions.append(z_up_to_y_up(*world))

                    if len(raw_normals) >= v + 3:
                        n = (raw_normals[v], raw_normals[v + 1], raw_normals[v + 2])
                        n = apply_normal(m3, n) if m3 else n
                        normals.append(z_up_to_y_up(*n))

                for a, b, c in sc.triangulate(faces):
                    triangles.append((base + a, base + b, base + c))

            if not positions or not triangles:
                errors.append({"element": described["name"], "kind": "NO_USABLE_GEOMETRY",
                               "detail": "The element reports geometry that decoded to no "
                                         "triangles."})
                elements.append(element)
                continue

            feature_index = builder.add_element(
                name=str(described["name"] or ifc_type),
                ifc_guid=str(guid or ""),
                ifc_type=ifc_type,
                positions=positions,
                triangles=triangles,
                normals=normals if len(normals) == len(positions) else None,
                rgba=colour,
            )
            # NOTE: the fingerprint is computed on the GLB's Y-up positions but its bounds are
            # reported in the MODEL frame, which is what `element["bounds"]` has always been.
            fingerprint = geometry_fingerprint(positions, triangles, e_lo, e_hi)
            element.update({
                "geometryFingerprint": fingerprint,
                "featureIndex": feature_index,
                "vertexCount": len(positions),
                "triangleCount": len(triangles),
                # Model frame (Z-up metres), so this is directly comparable with the Speckle data.
                "bounds": {"min": e_lo, "max": e_hi},
                "colour": list(colour),
            })
            total_vertices += len(positions)
            total_triangles += len(triangles)
            if guid:
                if guid in by_guid:
                    errors.append({"element": described["name"], "kind": "DUPLICATE_IFC_GUID",
                                   "detail": f"GlobalId {guid} appears more than once."})
                by_guid[guid] = feature_index
            elements.append(element)

        glb = builder.to_glb()
        bounds_model = ({"min": lo, "max": hi} if lo[0] != float("inf") else None)
        centre = ([(lo[i] + hi[i]) / 2 for i in range(3)] if bounds_model else None)

        manifest = {
            "phase": "9B",
            "generatedAt": started.isoformat(),
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "source": {
                "server": config.server_url,
                "projectId": config.project_id,
                "projectName": header.get("projectName"),
                "modelId": config.model_id,
                "modelName": header.get("modelName"),
                "versionId": config.version_id,
                # Derived from chronological order, not supplied by Speckle — it has no such
                # concept, and an invented label that disagreed with `createdAt` would be worse
                # than none.
                "ordinal": header.get("ordinal"),
                "label": header.get("label"),
                "versionCount": header.get("versionCount"),
                "sourceApplication": header.get("sourceApplication"),
                "versionCreatedAt": header.get("createdAt"),
                "message": header.get("message"),
                "referencedObject": header.get("referencedObject"),
            },
            "units": model.units,
            "counts": {
                "objects": len(elements),
                "withGeometry": sum(1 for e in elements if e["featureIndex"] is not None),
                "withIfcGuid": sum(1 for e in elements if e["ifcGuid"]),
                "vertices": total_vertices,
                "triangles": total_triangles,
                "materials": len(builder.materials),
            },
            "ifcTypes": _breakdown(elements),
            "levels": sorted({e["level"] for e in elements if e["level"]}),
            "boundsModel": bounds_model,
            # Sorted per axis AFTER the rotation. `z_up_to_y_up` negates Y into -Z, so mapping
            # the corners straight across puts the larger value in "min" on that axis and hands a
            # consumer a box that is inside out.
            "boundsGltf": (_sorted_bounds(z_up_to_y_up(*lo), z_up_to_y_up(*hi))
                           if bounds_model else None),
            "centreModel": centre,
            "sizeMetres": ([hi[i] - lo[i] for i in range(3)] if bounds_model else None),
            "transform": {
                "layout": "row-major, translation in the fourth column of each row",
                "applied": True,
                "appliedAt": "conversion",
                # Said out loud, because the one thing worse than forgetting the transform is
                # applying it twice.
                "note": "Placement transforms are baked into the GLB vertices. Do NOT apply them "
                        "again downstream; the GLB is already in model-world coordinates.",
            },
            "upAxis": {
                "source": "Z-up (IFC/Speckle)",
                "gltf": "Y-up (baked: x, z, -y)",
                "note": "The GLB is a conventional Y-up asset, so Cesium's default glTF handling "
                        "is correct and no upAxis override is needed.",
            },
            "georeferenced": False,
            "georeferenceNote": (
                "The model carries no CRS. It does contain an element named 'geo-reference' "
                "(IfcBuildingElementProxy) offset from the origin, which looks like a survey "
                "marker, but nothing states its coordinate system — so it is NOT used for "
                "placement. Supply a longitude/latitude/height/heading anchor at render time."
            ),
            "artifacts": {"glb": "model.glb", "elements": "elements.json",
                          "manifest": "manifest.json"},
            "glbBytes": len(glb),
            "featureIdAttribute": "_FEATURE_ID_0",
            "featureMetadata": {
                "extensions": ["EXT_mesh_features", "EXT_structural_metadata"],
                "propertyTable": "elements",
                "properties": ["name", "ifcGuid", "ifcType", "elementIndex"],
                "note": "A Cesium pick returns a ModelFeature; getProperty('ifcGuid') is the IFC "
                        "GlobalId exactly as Speckle reported it.",
            },
            "errors": errors,
        }

        (out_dir / "model.glb").write_bytes(glb)
        (out_dir / "elements.json").write_text(
            json.dumps({"elements": elements, "byGuid": by_guid}, indent=1, default=str) + "\n",
            encoding="utf-8")
        (out_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2, default=str) + "\n", encoding="utf-8")
        return manifest
    finally:
        # It owns a download directory; the parsed data stays usable after closing.
        try:
            model.close()
        except Exception:
            pass


def _sorted_bounds(a: tuple[float, float, float], b: tuple[float, float, float]
                   ) -> dict[str, list[float]]:
    return {"min": [min(a[i], b[i]) for i in range(3)],
            "max": [max(a[i], b[i]) for i in range(3)]}


def _breakdown(elements: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for element in elements:
        key = element["ifcType"] or "Unclassified"
        out[key] = out.get(key, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a Speckle version to GLB + metadata.")
    parser.add_argument("--out", required=True, help="output directory for the artifacts")
    parser.add_argument("--version", default=None, help="version id (default: SPECKLE_VERSION_ID)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    sc.load_repo_env()
    config = sc.read_config(args.version)
    if not config.configured:
        print(json.dumps({"ok": False, "error": "SPECKLE_API_TOKEN is not set on the server.",
                          "errorClass": "CONFIGURATION"}))
        return 2

    try:
        manifest = convert(config, Path(args.out))
    except Exception as error:          # noqa: BLE001 — the caller is a server; give it a value
        message = sc.scrub(str(error), config.token)
        print(json.dumps({
            "ok": False,
            "error": f"{type(error).__name__}: {message}",
            "errorClass": _classify(error, message),
            "traceback": sc.scrub(traceback.format_exc()[-800:], config.token),
        }))
        return 1

    # One JSON object on stdout, so the Node caller parses rather than scrapes.
    print(json.dumps({"ok": True, "manifest": manifest}))
    if not args.quiet:
        counts = manifest["counts"]
        print(f"converted {counts['withGeometry']}/{counts['objects']} elements, "
              f"{counts['triangles']} triangles, {manifest['glbBytes']} bytes",
              file=sys.stderr)
    return 0


def _classify(error: BaseException, message: str) -> str:
    blob = f"{type(error).__name__}: {message}".lower()
    if any(w in blob for w in ("unauthor", "forbidden", "401", "403", "token")):
        return "AUTHENTICATION_OR_AUTHORIZATION"
    if any(w in blob for w in ("timeout", "connection", "dns", "ssl", "network")):
        return "NETWORK"
    if any(w in blob for w in ("not found", "404", "no such", "no published")):
        return "INVALID_MODEL_REFERENCE"
    if any(w in blob for w in ("pyarrow", "parquet", "importerror", "modulenotfound")):
        return "UNSUPPORTED_SDK_OR_BUNDLE_FORMAT"
    if any(w in blob for w in ("decode", "parse", "struct", "unicode")):
        return "DATA_DECODING"
    return "OTHER"


if __name__ == "__main__":
    sys.exit(main())
