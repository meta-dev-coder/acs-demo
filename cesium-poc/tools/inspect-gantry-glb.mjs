#!/usr/bin/env node
/**
 * Read a gantry GLB and write the equipment manifest the application browses.
 *
 * The app never parses the 76 MB mesh: it reads this manifest, which is generated from the actual
 * file by this tool. So the inventory is whatever the model really contains — no counts are typed
 * in by hand anywhere, and regenerating after a new export is the whole update.
 *
 * What it takes from the GLB:
 *   • every node name, exactly as exported (Blender's `.001` suffixes included)
 *   • each node's bounds, from the POSITION accessors' own min/max and the node's transform, so a
 *     selected asset can be outlined in the scene without the browser reading the mesh
 *   • a sha256 of the file, so a manifest that no longer matches its model is obvious
 *
 * It does NOT invent assets: a node whose name does not say what it is becomes UNCLASSIFIED.
 *
 *   node tools/inspect-gantry-glb.mjs public/models/i595/gantry-1-toll-plaza-v2.glb \
 *     --gantry I595_G01 --model i595-gantry-1-toll-plaza [--out config/gantryEquipment] [--report]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildEquipmentAssets, inventoryOf } from '../src/tolling/gantryEquipment.js';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** The JSON chunk of a GLB, plus where the binary chunk starts. */
export function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file');
  const total = buffer.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= Math.min(total, buffer.length)) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === CHUNK_JSON) json = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    if (type === CHUNK_BIN) bin = { start, length };
    offset = start + length;
    offset += (4 - (offset % 4)) % 4;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

// ── node transforms ────────────────────────────────────────────────────────────────────────────
// Column-major 4x4, as glTF stores them.
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
};
const fromTRS = (t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) => {
  const [x, y, z, w] = r;
  const rotation = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) rotation[column * 4 + row] *= s[column];
  }
  rotation[12] = t[0]; rotation[13] = t[1]; rotation[14] = t[2];
  return rotation;
};
const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
/**
 * glTF is Y-up and Z-forward; Cesium's model space is Z-up and X-forward, and it applies BOTH
 * corrections when it loads a glTF (`ModelUtility.getAxisCorrectionMatrix`, with the Y/Z defaults
 * an Entity model uses). Composed, Y_UP_TO_Z_UP × Z_UP_TO_X_UP sends (x, y, z) to (z, x, y).
 *
 * Applying only the up-axis half put every part within 60 px of the gantry's centre on screen,
 * which is how this was caught: the manifest stores fully corrected bounds so the browser needs no
 * conversion of its own.
 */
const gltfToCesium = ([x, y, z]) => [z, x, y];

const nodeMatrices = json => {
  const nodes = json.nodes ?? [];
  const parentOf = new Map();
  nodes.forEach((node, index) => (node.children ?? []).forEach(child => parentOf.set(child, index)));
  const local = nodes.map(node => (node.matrix ? [...node.matrix] : fromTRS(node.translation, node.rotation, node.scale)));
  const world = new Array(nodes.length).fill(null);
  const resolve = index => {
    if (world[index]) return world[index];
    const parent = parentOf.get(index);
    world[index] = parent == null ? local[index] : multiply(resolve(parent), local[index]);
    return world[index];
  };
  return nodes.map((_, index) => resolve(index));
};

/** A node's bounds in Cesium model space, from the accessors' published min/max. */
function boundsOf(json, nodeIndex, matrix) {
  const node = json.nodes[nodeIndex];
  if (node.mesh == null) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const primitive of json.meshes[node.mesh]?.primitives ?? []) {
    const accessor = json.accessors?.[primitive.attributes?.POSITION];
    if (!accessor?.min || !accessor?.max) continue;
    found = true;
    // Every corner, because the node's rotation turns the box.
    for (let corner = 0; corner < 8; corner++) {
      const point = [
        corner & 1 ? accessor.max[0] : accessor.min[0],
        corner & 2 ? accessor.max[1] : accessor.min[1],
        corner & 4 ? accessor.max[2] : accessor.min[2],
      ];
      const world = gltfToCesium(apply(matrix, point));
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], world[axis]);
        max[axis] = Math.max(max[axis], world[axis]);
      }
    }
  }
  if (!found) return null;
  return {
    centre: min.map((value, axis) => Number(((value + max[axis]) / 2).toFixed(4))),
    halfSize: min.map((value, axis) => Number((Math.max((max[axis] - value) / 2, 0.05)).toFixed(4))),
  };
}

/** The manifest for one GLB. Exported so the tests can build it without touching the filesystem. */
export function buildManifest(buffer, { gantryId, modelId, file }) {
  const { json } = readGlb(buffer);
  const matrices = nodeMatrices(json);
  const names = (json.nodes ?? []).map(node => node.name ?? '');
  const assets = buildEquipmentAssets(names, { gantryId });
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  return {
    gantryId,
    modelId,
    source: {
      file,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      generator: json.asset?.generator ?? null,
      nodes: names.length,
      meshes: json.meshes?.length ?? 0,
      namedNodes: names.filter(Boolean).length,
      duplicateNames: [...new Set(duplicates)],
      nodeExtras: (json.nodes ?? []).filter(node => node.extras).length,
      meshExtras: (json.meshes ?? []).filter(mesh => mesh.extras).length,
    },
    generatedBy: 'tools/inspect-gantry-glb.mjs',
    inventory: inventoryOf(assets),
    assets: assets.map((asset, index) => ({ ...asset, nodeIndex: index, ...(boundsOf(json, index, matrices[index]) ?? {}) })),
  };
}

const argv = process.argv.slice(2);
if (argv.length && !argv[0].startsWith('--')) {
  const path = argv[0];
  const value = flag => { const at = argv.indexOf(flag); return at === -1 ? null : argv[at + 1]; };
  const manifest = buildManifest(readFileSync(path), {
    gantryId: value('--gantry') ?? 'I595_G01',
    modelId: value('--model') ?? 'i595-gantry-1-toll-plaza',
    file: basename(path),
  });
  const directory = value('--out') ?? 'config/gantryEquipment';
  mkdirSync(directory, { recursive: true });
  const out = join(directory, `${manifest.modelId}.json`);
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  const withoutBounds = manifest.assets.filter(asset => !asset.centre);
  console.log(`${out}: ${manifest.assets.length} assets from ${manifest.source.nodes} nodes`);
  console.log(manifest.inventory.map(row => `  ${String(row.count).padStart(3)}  ${row.label}`).join('\n'));
  if (manifest.source.duplicateNames.length) console.log('  duplicate node names:', manifest.source.duplicateNames.join(', '));
  if (withoutBounds.length) console.log(`  ${withoutBounds.length} nodes publish no POSITION bounds`);
  if (argv.includes('--report')) {
    for (const asset of manifest.assets) {
      console.log([asset.assetId.padEnd(26), asset.identification.padEnd(14), asset.nodeName].join(' '));
    }
  }
}
