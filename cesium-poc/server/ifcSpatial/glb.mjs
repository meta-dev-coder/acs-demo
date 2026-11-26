/**
 * A binary glTF (GLB) writer for converted IFC geometry, with element identity kept per vertex.
 *
 * Every vertex carries `_FEATURE_ID_0`, the index of the IFC element it belongs to
 * (EXT_mesh_features), and a property table (EXT_structural_metadata) maps that index to the
 * element's IFC GlobalId, name, class, tag and NetworkID. Cesium reads both: a pick on the model
 * returns the feature, and the feature's `globalId` is the stable identifier. Elements are grouped
 * into one primitive per colour to keep draw calls low, without merging their identities.
 *
 * Coordinates are written as the IFC states them: metres, Z up, in the model's engineering frame.
 * The glTF declares this in `asset.extras`, and the client loads it with upAxis Z / forwardAxis X so
 * Cesium applies no axis swap; the georeferenced model matrix does the rest.
 */

const ALIGN = 8;
const FLOAT = 5126, UINT32 = 5125, UINT16 = 5123;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
export const METADATA_PROPERTIES = Object.freeze(['globalId', 'name', 'ifcClass', 'tag', 'networkId']);

const pad = (length, to = ALIGN) => (to - (length % to)) % to;

/**
 * @param {object} input
 * @param {Array<{rgba:number[], positions:Float32Array, normals:Float32Array, featureIds:Float32Array, indices:Uint32Array}>} input.primitives
 * @param {Array<object>} input.features  one entry per feature id: the METADATA_PROPERTIES strings
 * @param {object} [input.extras]          written to asset.extras (provenance, units, axes)
 */
export function writeGlb({ primitives, features, extras = {} }) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];
  const addView = (bytes, target) => {
    const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) };
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    byteLength += bytes.byteLength;
    const extra = pad(byteLength);
    if (extra) { chunks.push(Buffer.alloc(extra)); byteLength += extra; }
    bufferViews.push(view);
    return bufferViews.length - 1;
  };
  const addAccessor = (array, type, componentType, target, withBounds = false) => {
    const size = { SCALAR: 1, VEC3: 3 }[type];
    const accessor = { bufferView: addView(array, target), componentType, count: array.length / size, type };
    if (withBounds) {
      const min = Array(size).fill(Infinity), max = Array(size).fill(-Infinity);
      for (let i = 0; i < array.length; i += size) for (let k = 0; k < size; k += 1) { min[k] = Math.min(min[k], array[i + k]); max[k] = Math.max(max[k], array[i + k]); }
      Object.assign(accessor, { min, max });
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const materials = [];
  const meshPrimitives = primitives.filter(p => p.indices.length).map(p => {
    const [r, g, b, a] = p.rgba;
    materials.push({
      pbrMetallicRoughness: { baseColorFactor: [r, g, b, a], metallicFactor: 0, roughnessFactor: 0.85 },
      alphaMode: a < 1 ? 'BLEND' : 'OPAQUE', doubleSided: true,
    });
    return {
      attributes: {
        POSITION: addAccessor(p.positions, 'VEC3', FLOAT, ARRAY_BUFFER, true),
        NORMAL: addAccessor(p.normals, 'VEC3', FLOAT, ARRAY_BUFFER),
        _FEATURE_ID_0: addAccessor(p.featureIds, 'SCALAR', FLOAT, ARRAY_BUFFER),
      },
      // 16-bit indices wherever a primitive has fewer than 65 536 vertices: the widely supported form,
      // and the one Cesium's wireframe view reads correctly.
      indices: p.positions.length / 3 <= 65535
        ? addAccessor(Uint16Array.from(p.indices), 'SCALAR', UINT16, ELEMENT_ARRAY_BUFFER)
        : addAccessor(p.indices, 'SCALAR', UINT32, ELEMENT_ARRAY_BUFFER),
      material: materials.length - 1,
      mode: 4,
      extensions: { EXT_mesh_features: { featureIds: [{ featureCount: features.length, attribute: 0, propertyTable: 0, label: 'ifcElement' }] } },
    };
  });

  // Property table: one STRING column per property, UTF-8 values plus UINT32 offsets.
  const encoder = new TextEncoder();
  const tableProperties = {};
  for (const name of METADATA_PROPERTIES) {
    const encoded = features.map(feature => encoder.encode(String(feature[name] ?? '')));
    const offsets = new Uint32Array(encoded.length + 1);
    let total = 0;
    encoded.forEach((bytes, i) => { offsets[i] = total; total += bytes.length; });
    offsets[encoded.length] = total;
    const values = new Uint8Array(Math.max(total, 1));
    let at = 0;
    for (const bytes of encoded) { values.set(bytes, at); at += bytes.length; }
    tableProperties[name] = { values: addView(values), stringOffsets: addView(offsets), stringOffsetType: 'UINT32' };
  }

  const gltf = {
    asset: { version: '2.0', generator: extras.generator ?? 'acs-demo IFC to glTF', extras },
    extensionsUsed: ['EXT_mesh_features', 'EXT_structural_metadata'],
    extensions: {
      EXT_structural_metadata: {
        schema: { id: 'ifc_elements', classes: { element: { name: 'IFC element', properties: Object.fromEntries(METADATA_PROPERTIES.map(name => [name, { type: 'STRING' }])) } } },
        propertyTables: [{ name: 'IFC elements', class: 'element', count: features.length, properties: tableProperties }],
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: extras.sourceFile ?? 'ifc', mesh: 0 }],
    meshes: [{ name: 'ifc-elements', primitives: meshPrimitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };

  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonChunk = Buffer.concat([json, Buffer.alloc(pad(json.length, 4), 0x20)]);
  const binChunk = Buffer.concat(chunks);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunkHeader = (length, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binChunk.length, 0x004e4942), binChunk]);
}

/** Parse a GLB back into its JSON and binary chunk (tests and diagnostics). */
export function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file.');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8;
  return { json, bin: buffer.subarray(binStart, binStart + buffer.readUInt32LE(20 + jsonLength)) };
}

/** Read a STRING column of the property table back (tests and diagnostics). */
export function readStringColumn(glb, name) {
  const { json, bin } = readGlb(glb);
  const property = json.extensions.EXT_structural_metadata.propertyTables[0].properties[name];
  const view = index => { const v = json.bufferViews[index]; return bin.subarray(v.byteOffset, v.byteOffset + v.byteLength); };
  const values = view(property.values);
  const offsets = view(property.stringOffsets);
  const count = json.extensions.EXT_structural_metadata.propertyTables[0].count;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(values.subarray(offsets.readUInt32LE(i * 4), offsets.readUInt32LE((i + 1) * 4)).toString('utf8'));
  return out;
}
