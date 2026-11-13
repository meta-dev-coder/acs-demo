"""A minimal glTF 2.0 / GLB writer with per-element feature metadata.

Hand-written rather than pulled from a library, for one reason: the only hard requirement here is
that **a picked triangle in Cesium resolves to the right IFC GlobalId**, and that rests entirely
on two glTF extensions - `EXT_mesh_features` and `EXT_structural_metadata` - which the convenient
Python exporters either do not emit or emit in a shape their own tests cover rather than Cesium's.
Writing the ~250 lines keeps the only load-bearing part under our own tests.

The output is a single GLB in which:

  * each BIM element is its own node, mesh and primitive, so nothing is merged into an anonymous
    soup and element identity survives the export;
  * every vertex of an element carries a constant `_FEATURE_ID_0` equal to that element's row in
    the property table;
  * the property table carries `ifcGuid`, `ifcType`, `name` and `elementIndex` as real glTF
    metadata, so `ModelFeature.getProperty('ifcGuid')` returns the IFC GUID with no side table
    that could drift out of step with the geometry.

Coordinates are written **Y-up**, which is the glTF convention. See `Z_UP_TO_Y_UP`.
"""

from __future__ import annotations

import json
import struct
from typing import Any

GLB_MAGIC = 0x46546C67       # "glTF"
GLB_VERSION = 2
JSON_CHUNK = 0x4E4F534A      # "JSON"
BIN_CHUNK = 0x004E4942       # "BIN"

# Component types
FLOAT = 5126
UNSIGNED_INT = 5125

ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


def z_up_to_y_up(x: float, y: float, z: float) -> tuple[float, float, float]:
    """IFC/Speckle are Z-up; glTF is Y-up. A -90 degrees rotation about X.

    Baked into the vertices rather than left as a node rotation, so the GLB is a conventional
    Y-up asset that any viewer - Cesium, a glTF validator, a browser preview - renders upright
    without being told. The manifest records the bounds in BOTH frames so a test can check the
    geometry against the Speckle source without having to undo this first.
    """
    return (x, z, -y)


Z_UP_TO_Y_UP = z_up_to_y_up


class GltfBuilder:
    """Accumulates elements, then serialises one GLB."""

    def __init__(self, *, generator: str = "acs-demo speckle converter") -> None:
        self.generator = generator
        self._bin = bytearray()
        self.buffer_views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []
        self.meshes: list[dict[str, Any]] = []
        self.nodes: list[dict[str, Any]] = []
        self.materials: list[dict[str, Any]] = []
        self._material_by_colour: dict[tuple[int, int, int, int], int] = {}
        self.features: list[dict[str, Any]] = []

    # ── buffer plumbing ────────────────────────────────────────────────────────────────────────

    def _align(self, boundary: int = 4) -> None:
        # glTF requires each bufferView to start on a 4-byte boundary for the accessor types used
        # here. Misalignment is the classic silent corruption: it loads, and renders nonsense.
        while len(self._bin) % boundary:
            self._bin.append(0)

    def _view(self, data: bytes, target: int | None = None) -> int:
        self._align()
        offset = len(self._bin)
        self._bin.extend(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def _accessor(self, view: int, component_type: int, count: int, kind: str,
                  minimum: list[float] | None = None,
                  maximum: list[float] | None = None) -> int:
        accessor = {"bufferView": view, "componentType": component_type,
                    "count": count, "type": kind}
        if minimum is not None:
            # POSITION accessors MUST carry min/max - Cesium uses them for the bounding sphere,
            # and without them the camera has nothing to frame the model with.
            accessor["min"] = minimum
            accessor["max"] = maximum
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    # ── materials ──────────────────────────────────────────────────────────────────────────────

    def material_for(self, rgba: tuple[int, int, int, int]) -> int:
        """One material per distinct colour, reused. Keeps the asset small and the state changes few."""
        if rgba in self._material_by_colour:
            return self._material_by_colour[rgba]
        r, g, b, a = rgba
        index = len(self.materials)
        self.materials.append({
            "pbrMetallicRoughness": {
                "baseColorFactor": [r / 255, g / 255, b / 255, a / 255],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.85,
            },
            "doubleSided": True,     # IFC tessellations are not reliably wound consistently
            **({"alphaMode": "BLEND"} if a < 255 else {}),
        })
        self._material_by_colour[rgba] = index
        return index

    # ── elements ───────────────────────────────────────────────────────────────────────────────

    def add_element(self, *, name: str, ifc_guid: str, ifc_type: str,
                    positions: list[tuple[float, float, float]],
                    triangles: list[tuple[int, int, int]],
                    normals: list[tuple[float, float, float]] | None = None,
                    rgba: tuple[int, int, int, int] = (190, 190, 190, 255)) -> int:
        """Append one BIM element as its own node + mesh + primitive.

        @returns its feature index, which is also its row in the property table.
        """
        feature_index = len(self.features)

        flat_positions = bytearray()
        lo = [float("inf")] * 3
        hi = [float("-inf")] * 3
        for x, y, z in positions:
            flat_positions.extend(struct.pack("<3f", x, y, z))
            for axis, value in enumerate((x, y, z)):
                lo[axis] = min(lo[axis], value)
                hi[axis] = max(hi[axis], value)
        position_view = self._view(bytes(flat_positions), ARRAY_BUFFER)
        position_accessor = self._accessor(position_view, FLOAT, len(positions), "VEC3", lo, hi)

        attributes = {"POSITION": position_accessor}

        if normals:
            flat_normals = bytearray()
            for nx, ny, nz in normals:
                flat_normals.extend(struct.pack("<3f", nx, ny, nz))
            normal_view = self._view(bytes(flat_normals), ARRAY_BUFFER)
            attributes["NORMAL"] = self._accessor(normal_view, FLOAT, len(normals), "VEC3")

        # A CONSTANT feature id on every vertex of this element. The alternative - an "implicit"
        # feature id with no attribute - numbers features by vertex index, which would make every
        # vertex its own feature and a pick resolve to a vertex rather than an element.
        feature_bytes = struct.pack(f"<{len(positions)}f", *([float(feature_index)] * len(positions)))
        feature_view = self._view(feature_bytes, ARRAY_BUFFER)
        attributes["_FEATURE_ID_0"] = self._accessor(feature_view, FLOAT, len(positions), "SCALAR")

        index_data = bytearray()
        for a, b, c in triangles:
            index_data.extend(struct.pack("<3I", a, b, c))
        index_view = self._view(bytes(index_data), ELEMENT_ARRAY_BUFFER)
        index_accessor = self._accessor(index_view, UNSIGNED_INT, len(triangles) * 3, "SCALAR")

        self.meshes.append({
            "name": name,
            "primitives": [{
                "attributes": attributes,
                "indices": index_accessor,
                "material": self.material_for(rgba),
                "extensions": {
                    "EXT_mesh_features": {
                        # One unique feature in this primitive, read from `_FEATURE_ID_0`, whose
                        # values index propertyTables[0].
                        "featureIds": [{"featureCount": 1, "attribute": 0, "propertyTable": 0}],
                    },
                },
            }],
        })
        mesh_index = len(self.meshes) - 1
        # The node is named with the IFC GUID as well, so the identity survives even for a reader
        # that ignores the metadata extensions entirely.
        self.nodes.append({"name": ifc_guid or name, "mesh": mesh_index})
        self.features.append({"name": name, "ifcGuid": ifc_guid, "ifcType": ifc_type,
                              "elementIndex": feature_index})
        return feature_index

    # ── metadata ───────────────────────────────────────────────────────────────────────────────

    def _string_property(self, values: list[str]) -> dict[str, Any]:
        """A glTF STRING property: UTF-8 bytes plus an offsets table of count+1 entries."""
        blob = bytearray()
        offsets = [0]
        for value in values:
            blob.extend(str(value or "").encode("utf-8"))
            offsets.append(len(blob))
        values_view = self._view(bytes(blob))
        offsets_view = self._view(struct.pack(f"<{len(offsets)}I", *offsets))
        return {"values": values_view, "stringOffsets": offsets_view,
                "stringOffsetType": "UINT32"}

    def _structural_metadata(self) -> dict[str, Any]:
        count = len(self.features)
        names = self._string_property([f["name"] or "" for f in self.features])
        guids = self._string_property([f["ifcGuid"] or "" for f in self.features])
        types = self._string_property([f["ifcType"] or "" for f in self.features])
        indices_view = self._view(
            struct.pack(f"<{count}I", *[f["elementIndex"] for f in self.features]))

        return {
            "schema": {
                "id": "acs_bim",
                "name": "ACS BIM element schema",
                "classes": {
                    "element": {
                        "name": "BIM element",
                        "properties": {
                            "name": {"type": "STRING"},
                            # The IFC GlobalId, preserved exactly as Speckle reported it. This is
                            # the property a Cesium pick reads back.
                            "ifcGuid": {"type": "STRING"},
                            "ifcType": {"type": "STRING"},
                            "elementIndex": {"type": "SCALAR", "componentType": "UINT32"},
                        },
                    },
                },
            },
            "propertyTables": [{
                "name": "elements",
                "class": "element",
                "count": count,
                "properties": {
                    "name": names,
                    "ifcGuid": guids,
                    "ifcType": types,
                    "elementIndex": {"values": indices_view},
                },
            }],
        }

    # ── output ─────────────────────────────────────────────────────────────────────────────────

    def to_gltf(self) -> dict[str, Any]:
        return {
            "asset": {"version": "2.0", "generator": self.generator},
            "extensionsUsed": ["EXT_mesh_features", "EXT_structural_metadata"],
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.nodes)))}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self._bin)}],
            "extensions": {"EXT_structural_metadata": self._structural_metadata()},
        }

    def to_glb(self) -> bytes:
        # The metadata bufferViews are created while building the JSON, so the JSON must be built
        # BEFORE the binary chunk is measured. Doing it the other way round truncates the buffer
        # and produces a file that opens and is missing its metadata.
        gltf = self.to_gltf()
        gltf["buffers"][0]["byteLength"] = len(self._bin)

        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)      # pad with SPACES
        bin_bytes = bytes(self._bin)
        bin_bytes += b"\x00" * ((4 - len(bin_bytes) % 4) % 4)     # pad with ZEROS

        total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
        out = bytearray()
        out.extend(struct.pack("<III", GLB_MAGIC, GLB_VERSION, total))
        out.extend(struct.pack("<II", len(json_bytes), JSON_CHUNK))
        out.extend(json_bytes)
        out.extend(struct.pack("<II", len(bin_bytes), BIN_CHUNK))
        out.extend(bin_bytes)
        return bytes(out)
