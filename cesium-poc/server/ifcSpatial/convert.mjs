/**
 * IFC → glTF conversion for the IFC Spatial Twin, with web-ifc (That Open Company's IFC geometry
 * engine, compiled to WebAssembly) running in this Node process.
 *
 * Why web-ifc: it reads IFC2X3 / IFC4 / IFC4X3 STEP files and triangulates their real geometry
 * (extrusions, swept solids, Breps, booleans) with every placement applied, it runs inside the
 * existing Node backend with no Python toolchain, and it keeps each triangle's owning element. The
 * environment has no IfcOpenShell (Python 3.14, no wheel installed).
 *
 * The output is the file's own geometry, nothing added: one GLB (glb.mjs) whose vertices carry the
 * element's feature id, an element index with every IfcProduct (with or without geometry), its
 * attributes and property sets, and diagnostics. Coordinates stay in the IFC's engineering frame
 * (metres, Z up); placement on the globe comes from georef.mjs or from a user calibration.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeGlb } from './glb.mjs';
import { georeferencedPlacement, readGeoreference } from './georef.mjs';

/** Bump when the output changes shape: cached conversions from an older converter are redone. */
export const CONVERTER_VERSION = 7;
const WEB_IFC_VERSION = (() => {
  // The package's export map does not expose package.json; find it next to the resolved entry point.
  try { return JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve('web-ifc')), 'package.json'), 'utf8')).version; } catch { return null; }
})();

export class ConversionError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** A STEP physical file with an IFC schema web-ifc reads, or a ConversionError saying why not. */
export function validateStep(bytes) {
  const head = Buffer.from(bytes.subarray(0, 8192)).toString('latin1');
  if (!/^\s*ISO-10303-21;/.test(head)) throw new ConversionError('INVALID_IFC', 'The file is not an IFC STEP file (no ISO-10303-21 header).');
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 256))).toString('latin1');
  if (!/END-ISO-10303-21;\s*$/.test(tail)) throw new ConversionError('INVALID_IFC', 'The IFC file is truncated (no END-ISO-10303-21).');
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(head)?.[1] ?? null;
  if (!schema || !/^IFC(2X3|4|4X1|4X2|4X3)/i.test(schema)) throw new ConversionError('UNSUPPORTED_SCHEMA', `IFC schema ${schema ?? '(none)'} is not supported.`);
  const fileName = /FILE_NAME\s*\((.*?)\);/is.exec(head)?.[1] ?? '';
  const strings = [...fileName.matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1]);
  return { schema, timestamp: strings[1] ?? null, preprocessor: strings[4] ?? null, originatingSystem: strings[5] ?? null };
}

let engine = null;
async function webIfc() {
  engine ??= (async () => {
    const W = await import('web-ifc');
    const api = new W.IfcAPI();
    await api.Init();
    // Upper-case type names (IFCTRANSFORMER) → the schema's own spelling (IfcTransformer).
    const names = new Map();
    for (const schema of [W.IFC2X3, W.IFC4, W.IFC4X3]) for (const name of Object.keys(schema ?? {})) names.set(name.toUpperCase(), name);
    return { W, api, names };
  })().catch(error => { engine = null; throw error; });
  return engine;
}

const value = attribute => (attribute && typeof attribute === 'object' && 'value' in attribute ? attribute.value : attribute ?? null);
const text = attribute => { const v = value(attribute); return v === null || v === undefined ? null : String(v); };

function flattenPsets(psets) {
  const out = {};
  for (const pset of psets ?? []) {
    const name = text(pset?.Name);
    if (!name) continue;
    const props = {};
    for (const prop of pset.HasProperties ?? pset.Quantities ?? []) {
      const key = text(prop?.Name);
      if (!key) continue;
      const nominal = prop.NominalValue ?? prop.LengthValue ?? prop.AreaValue ?? prop.VolumeValue ?? prop.CountValue ?? prop.WeightValue;
      props[key] = nominal === undefined ? null : value(nominal);
    }
    out[name] = { ...(out[name] ?? {}), ...props };
  }
  return out;
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const ref = attribute => (attribute && typeof attribute === 'object' && 'value' in attribute ? attribute.value : attribute);
const refs = list => (Array.isArray(list) ? list : []).map(ref).filter(id => Number.isInteger(id));
/** IfcCartesianPoint coordinates, whichever shape web-ifc returns them in. */
const coords = point => (point?.Coordinates ?? []).map(c => Number(ref(c)));
/** IfcDirection ratios (its values live in DirectionRatios, not Coordinates). */
const ratios = direction => (direction?.DirectionRatios ?? []).map(c => Number(ref(c)));

/** IfcRelNests: each nested object (a port) → the element it belongs to, by express id. */
function nestOwners(api, W, modelID) {
  const owner = new Map();
  const nests = api.GetLineIDsWithType(modelID, W.IFCRELNESTS);
  for (let i = 0; i < nests.size(); i += 1) {
    const rel = api.GetLine(modelID, nests.get(i));
    for (const nested of refs(rel.RelatedObjects)) owner.set(nested, ref(rel.RelatingObject));
  }
  return owner;
}

const SI_PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };

/**
 * The file's length unit in metres, from IfcUnitAssignment: an IfcSIUnit (METRE with its prefix) or an
 * IfcConversionBasedUnit (FOOT, INCH: its ConversionFactor in an SI unit). 1 when none is stated.
 * web-ifc scales mesh vertices to metres itself; placements and curves read here are scaled with this.
 */
export function lengthUnitScale(api, W, modelID) {
  const scaleOf = (unitId, depth = 0) => {
    if (!unitId || depth > 4) return null;
    const unit = api.GetLine(modelID, unitId);
    if (unit.ConversionFactor) {
      const measure = api.GetLine(modelID, ref(unit.ConversionFactor));
      const factor = Number(value(measure.ValueComponent));
      const base = scaleOf(ref(measure.UnitComponent), depth + 1) ?? 1;
      return Number.isFinite(factor) ? factor * base : null;
    }
    if (String(value(unit.Name) ?? '').toUpperCase() !== 'METRE') return null;
    return SI_PREFIX[String(value(unit.Prefix) ?? '').toUpperCase()] ?? 1;
  };
  const assignments = api.GetLineIDsWithType(modelID, W.IFCUNITASSIGNMENT);
  for (let i = 0; i < assignments.size(); i += 1) {
    for (const unitId of refs(api.GetLine(modelID, assignments.get(i)).Units)) {
      const unit = api.GetLine(modelID, unitId);
      if (String(value(unit.UnitType) ?? '').toUpperCase() !== 'LENGTHUNIT') continue;
      const scale = scaleOf(unitId);
      if (scale) return scale;
    }
  }
  return 1;
}

/**
 * The element-to-element connections the file states: IfcRelNests puts ports on elements,
 * IfcRelConnectsPorts joins ports, and each port's FlowDirection gives the direction. A pair whose
 * ports are SOURCE → SINK is one-way; SOURCEANDSINK at either end makes it two-way. Each pair is
 * reported once even though the file records it in both directions.
 */
function readConnections(api, W, modelID, globalIdOf, portOwner = nestOwners(api, W, modelID)) {
  const flow = port => String(ref(api.GetLine(modelID, port).FlowDirection) ?? '').toUpperCase();
  const pairs = new Map();
  const links = api.GetLineIDsWithType(modelID, W.IFCRELCONNECTSPORTS);
  for (let i = 0; i < links.size(); i += 1) {
    const rel = api.GetLine(modelID, links.get(i));
    const [pa, pb] = [ref(rel.RelatingPort), ref(rel.RelatedPort)];
    const [a, b] = [portOwner.get(pa), portOwner.get(pb)];
    if (!a || !b || a === b) continue;
    const [fa, fb] = [flow(pa), flow(pb)];
    let from = a, to = b, twoWay = fa === 'SOURCEANDSINK' || fb === 'SOURCEANDSINK';
    if (!twoWay && fa === 'SINK' && fb === 'SOURCE') { from = b; to = a; }
    else if (!twoWay && !(fa === 'SOURCE' && fb === 'SINK')) twoWay = true;
    const key = [Math.min(a, b), Math.max(a, b)].join('-');
    if (pairs.has(key)) continue;
    // The ports themselves too: which port of an element a connection uses (a light with an incoming
    // and an outgoing port is a modelled feed-through; one port with two cables is not).
    const portId = p => api.GetLine(modelID, p)?.GlobalId?.value ?? null;
    pairs.set(key, { from: globalIdOf(from), to: globalIdOf(to), twoWay, fromFlow: from === a ? fa : fb, toFlow: from === a ? fb : fa,
      fromPort: portId(from === a ? pa : pb), toPort: portId(from === a ? pb : pa) });
  }
  return [...pairs.values()].filter(c => c.from && c.to);
}

/** Each element's ports (IfcRelNests): GlobalId and FlowDirection, by the owning element's express id. */
function readPorts(api, modelID, portOwner) {
  const byOwner = new Map();
  for (const [port, owner] of portOwner) {
    const line = api.GetLine(modelID, port);
    if (!line || line.FlowDirection === undefined) continue;   // ports only (IfcRelNests nests other things too)
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push({ globalId: line.GlobalId?.value ?? null, flow: String(ref(line.FlowDirection) ?? '').toUpperCase() || null,
      systemType: String(ref(line.SystemType) ?? '').toUpperCase() || null });
  }
  return byOwner;
}

/**
 * The decomposition the file states: IfcRelAggregates (a part → its whole: equipment in a substation
 * assembly) and IfcRelContainedInSpatialStructure (an element → its site, building, storey or space).
 */
function readStructure(api, W, modelID) {
  const parent = new Map(), container = new Map();
  const aggregates = api.GetLineIDsWithType(modelID, W.IFCRELAGGREGATES);
  for (let i = 0; i < aggregates.size(); i += 1) {
    const rel = api.GetLine(modelID, aggregates.get(i));
    for (const part of refs(rel.RelatedObjects)) parent.set(part, ref(rel.RelatingObject));
  }
  const contained = api.GetLineIDsWithType(modelID, W.IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < contained.size(); i += 1) {
    const rel = api.GetLine(modelID, contained.get(i));
    for (const element of refs(rel.RelatedElements)) container.set(element, ref(rel.RelatingStructure));
  }
  return { parent, container };
}

/** The IfcDistributionSystems each element is assigned to (IfcRelAssignsToGroup), by express id. */
function readSystems(api, W, modelID) {
  const out = new Map();
  const rels = api.GetLineIDsWithType(modelID, W.IFCRELASSIGNSTOGROUP);
  for (let i = 0; i < rels.size(); i += 1) {
    const rel = api.GetLine(modelID, rels.get(i));
    const group = ref(rel.RelatingGroup) ? api.GetLine(modelID, ref(rel.RelatingGroup)) : null;
    if (!group || group.type !== W.IFCDISTRIBUTIONSYSTEM) continue;
    const name = group.Name?.value ?? group.LongName?.value ?? null;
    if (!name) continue;
    for (const id of refs(rel.RelatedObjects)) { if (!out.has(id)) out.set(id, []); out.get(id).push(name); }
  }
  return out;
}

/**
 * An IfcObjectPlacement as a column-major 4×4 in the IFC's Z-up frame: each IfcLocalPlacement's
 * IfcAxis2Placement3D (Location, Axis = z, RefDirection = x), composed up its PlacementRelTo chain.
 */
function placementMatrix(api, modelID, placementId, depth = 0) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!placementId || depth > 32) return identity;
  const placement = api.GetLine(modelID, placementId);
  const axes = ref(placement.RelativePlacement) ? api.GetLine(modelID, ref(placement.RelativePlacement)) : null;
  const location = axes && ref(axes.Location) ? coords(api.GetLine(modelID, ref(axes.Location))) : [0, 0, 0];
  const unit = v => { const n = Math.hypot(...v) || 1; return v.map(c => c / n); };
  const z = unit(axes && ref(axes.Axis) ? ratios(api.GetLine(modelID, ref(axes.Axis))) : [0, 0, 1]);
  const r = axes && ref(axes.RefDirection) ? ratios(api.GetLine(modelID, ref(axes.RefDirection))) : [1, 0, 0];
  const d = r[0] * z[0] + r[1] * z[1] + (r[2] ?? 0) * z[2];
  const x = unit([r[0] - d * z[0], r[1] - d * z[1], (r[2] ?? 0) - d * z[2]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const local = [...x, 0, ...y, 0, ...z, 0, location[0] ?? 0, location[1] ?? 0, location[2] ?? 0, 1];
  const parent = placementMatrix(api, modelID, ref(placement.PlacementRelTo), depth + 1);
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let rr = 0; rr < 4; rr += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + rr] += parent[k * 4 + rr] * local[c * 4 + k];
  return out;
}

/** The centreline a cable is swept along (IfcSweptDiskSolid.Directrix), in the representation's local frame. */
function sweepCentreline(api, modelID, element) {
  const shape = ref(element.Representation);
  if (!shape) return null;
  for (const repId of refs(api.GetLine(modelID, shape).Representations)) {
    for (const itemId of refs(api.GetLine(modelID, repId).Items)) {
      const item = api.GetLine(modelID, itemId);
      const directrix = ref(item.Directrix);
      if (!directrix) continue;
      const curve = api.GetLine(modelID, directrix);
      const points = refs(curve.Points).map(id => coords(api.GetLine(modelID, id)));
      if (points.length >= 2) return points.map(p => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
    }
  }
  return null;
}

/**
 * Convert one IFC file. Returns `{glb, elements, diagnostics}`; throws ConversionError for a file
 * that is not IFC or yields no renderable geometry. Never substitutes geometry of its own.
 */
export async function convertIfc(bytes, { sourceFile = null, versionId = null, versionNumber = null } = {}) {
  const started = Date.now();
  const header = validateStep(bytes);
  const georef = readGeoreference(Buffer.from(bytes).toString('latin1'));
  const { W, api, names } = await webIfc();
  let modelID;
  try { modelID = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: false }); } catch (error) {
    throw new ConversionError('PARSE_FAILED', `web-ifc could not open the file: ${error?.message ?? error}`);
  }
  if (modelID < 0) throw new ConversionError('PARSE_FAILED', 'web-ifc could not open the file.');
  const warnings = [];
  try {
    const className = id => names.get(api.GetNameFromTypeCode(api.GetLineType(modelID, id)).toUpperCase()) ?? api.GetNameFromTypeCode(api.GetLineType(modelID, id));

    // ---- every IfcProduct: identity, attributes, property sets ----
    const productIds = api.GetLineIDsWithType(modelID, W.IFCPRODUCT, true);
    const elements = [];
    const byExpress = new Map();
    for (let i = 0; i < productIds.size(); i += 1) {
      const expressId = productIds.get(i);
      const line = api.GetLine(modelID, expressId);
      let psets = {};
      try {
        // Type property sets first, then the element's own, which override them. (web-ifc 0.0.80
        // returns nothing when asked for both at once, so they are read separately.)
        const types = await api.properties.getTypeProperties(modelID, expressId, true);
        psets = { ...flattenPsets(types.flatMap(type => type?.HasPropertySets ?? [])), ...flattenPsets(await api.properties.getPropertySets(modelID, expressId, true)) };
      } catch (error) {
        warnings.push(`Property sets of #${expressId} could not be read: ${error?.message ?? error}`);
      }
      const net = psets.SuperDNA_PowerNetwork ?? {};
      const element = {
        expressId, globalId: text(line.GlobalId), name: text(line.Name), ifcClass: className(expressId),
        predefinedType: text(line.PredefinedType), objectType: text(line.ObjectType), tag: text(line.Tag), description: text(line.Description),
        networkId: text(net.NetworkID), networkRole: text(net.NetworkRole), voltageLevel: text(net.VoltageLevel),
        properties: psets, featureId: null, triangles: 0, bbox: null,
      };
      elements.push(element);
      byExpress.set(expressId, element);
    }

    // ---- placements (metres): the origin and axes each element is placed at, for version comparison ----
    const unitScale = lengthUnitScale(api, W, modelID);
    const owners = nestOwners(api, W, modelID);
    const frames = new Map();
    for (const element of elements) {
      try {
        const line = api.GetLine(modelID, element.expressId);
        const host = owners.get(element.expressId);
        if (host) element.hostGlobalId = text(api.GetLine(modelID, host).GlobalId);
        if (!ref(line.ObjectPlacement)) continue;
        const m = placementMatrix(api, modelID, ref(line.ObjectPlacement));
        const origin = [m[12] * unitScale, m[13] * unitScale, m[14] * unitScale];
        const axis = v => { const n = Math.hypot(...v) || 1; return v.map(c => round(c / n, 6)); };
        element.placement = { origin: origin.map(n => round(n)), xAxis: axis([m[0], m[1], m[2]]), zAxis: axis([m[8], m[9], m[10]]) };
        frames.set(element, { origin, x: axis([m[0], m[1], m[2]]), y: axis([m[4], m[5], m[6]]), z: axis([m[8], m[9], m[10]]) });
      } catch (error) { warnings.push(`Placement of ${element.globalId} could not be read: ${error?.message ?? error}`); }
    }
    // The geometry in each element's own placement frame: moving or turning an element leaves it unchanged.
    const shapes = new Map();
    const shapeOf = element => {
      if (!shapes.has(element)) shapes.set(element, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], vertices: 0 });
      return shapes.get(element);
    };

    // ---- geometry: every placed mesh, back in the IFC's Z-up frame, grouped by colour ----
    const groups = new Map();
    const features = [];
    let vertexTotal = 0, triangleTotal = 0;
    api.StreamAllMeshes(modelID, mesh => {
      let element = byExpress.get(mesh.expressID);
      if (!element) {
        element = { expressId: mesh.expressID, globalId: text(api.GetLine(modelID, mesh.expressID).GlobalId), name: null, ifcClass: className(mesh.expressID),
          predefinedType: null, objectType: null, tag: null, description: null, networkId: null, networkRole: null, voltageLevel: null, properties: {}, featureId: null, triangles: 0, bbox: null };
        elements.push(element);
        byExpress.set(mesh.expressID, element);
        warnings.push(`#${mesh.expressID} (${element.ifcClass}) has geometry but is not an IfcProduct.`);
      }
      if (element.featureId === null) {
        element.featureId = features.length;
        features.push(element);
      }
      const min = element.bbox?.min ?? [Infinity, Infinity, Infinity], max = element.bbox?.max ?? [-Infinity, -Infinity, -Infinity];
      for (let g = 0; g < mesh.geometries.size(); g += 1) {
        const placed = mesh.geometries.get(g);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
        const m = placed.flatTransformation;
        const c = placed.color;
        const rgba = [round(c.x), round(c.y), round(c.z), round(c.w)];
        const key = rgba.join(',');
        if (!groups.has(key)) groups.set(key, { rgba, positions: [], normals: [], featureIds: [], indices: [] });
        const group = groups.get(key);
        const base = group.positions.length / 3;
        for (let k = 0; k < vertices.length; k += 6) {
          const [x, y, z, nx, ny, nz] = [vertices[k], vertices[k + 1], vertices[k + 2], vertices[k + 3], vertices[k + 4], vertices[k + 5]];
          // web-ifc's world frame is Y up; the IFC's is Z up: (x, y, z)_web → (x, -z, y)_ifc.
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          const p = [wx, -wz, wy];
          const vx = m[0] * nx + m[4] * ny + m[8] * nz, vy = m[1] * nx + m[5] * ny + m[9] * nz, vz = m[2] * nx + m[6] * ny + m[10] * nz;
          const length = Math.hypot(vx, vy, vz) || 1;
          group.positions.push(p[0], p[1], p[2]);
          group.normals.push(vx / length, -vz / length, vy / length);
          group.featureIds.push(element.featureId);
          for (let a = 0; a < 3; a += 1) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
          const frame = frames.get(element);
          const shape = shapeOf(element);
          const d = frame ? [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]] : p;
          const local = frame ? [frame.x, frame.y, frame.z].map(axis => axis[0] * d[0] + axis[1] * d[1] + axis[2] * d[2]) : d;
          for (let a = 0; a < 3; a += 1) { shape.min[a] = Math.min(shape.min[a], local[a]); shape.max[a] = Math.max(shape.max[a], local[a]); }
          shape.vertices += 1;
        }
        for (let k = 0; k < indices.length; k += 1) group.indices.push(base + indices[k]);
        element.triangles += indices.length / 3;
        triangleTotal += indices.length / 3;
        vertexTotal += vertices.length / 6;
        geometry.delete?.();
      }
      if (Number.isFinite(min[0])) element.bbox = { min: min.map(n => round(n)), max: max.map(n => round(n)) };
    });

    if (!features.length) throw new ConversionError('NO_GEOMETRY', 'The IFC file contains no renderable geometry.');

    // A geometry signature per element: triangle count and local extents to the centimetre. Equal
    // signatures mean the same shape; it does not change when the element is moved or turned.
    for (const [element, shape] of shapes) {
      const extent = { min: shape.min.map(n => round(n, 2)), max: shape.max.map(n => round(n, 2)) };
      element.geometry = { triangles: element.triangles, localExtent: extent,
        signature: createHash('sha1').update(`${element.triangles}|${extent.min.join(',')}|${extent.max.join(',')}`).digest('hex').slice(0, 16) };
    }

    // Cable routes: the sweep centreline, placed by the cable's own IfcLocalPlacement chain (web-ifc's
    // mesh transform re-centres swept solids, so it is right for the mesh and wrong for the curve).
    for (const element of elements) {
      if (element.ifcClass !== 'IfcCableSegment') continue;
      try {
        const line = api.GetLine(modelID, element.expressId);
        const local = sweepCentreline(api, modelID, line);
        if (!local) continue;
        const m = placementMatrix(api, modelID, ref(line.ObjectPlacement));
        element.route = local.map(([x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]].map(n => round(n * unitScale)));
      } catch (error) { warnings.push(`Route of ${element.globalId} could not be read: ${error?.message ?? error}`); }
    }
    const globalIdOf = id => byExpress.get(id)?.globalId ?? null;
    let connections = [];
    try { connections = readConnections(api, W, modelID, globalIdOf, owners); } catch (error) { warnings.push(`Port connections could not be read: ${error?.message ?? error}`); }
    try {
      const ports = readPorts(api, modelID, owners);
      const systems = readSystems(api, W, modelID);
      for (const element of byExpress.values()) {
        if (ports.has(element.expressId)) element.ports = ports.get(element.expressId);
        if (systems.has(element.expressId)) element.systems = systems.get(element.expressId);
      }
    } catch (error) { warnings.push(`Ports and systems could not be read: ${error?.message ?? error}`); }
    try {
      // Which whole each element is part of (an element, not the project's spatial tree), and its spatial container.
      const { parent, container } = readStructure(api, W, modelID);
      const describe = id => { const l = api.GetLine(modelID, id); return { globalId: text(l?.GlobalId), name: text(l?.Name), ifcClass: className(id) }; };
      for (const element of byExpress.values()) {
        const whole = parent.get(element.expressId);
        if (whole && byExpress.has(whole)) element.aggregatedBy = byExpress.get(whole).globalId;
        const space = container.get(element.expressId);
        if (space) element.spatialContainer = describe(space);
      }
    } catch (error) { warnings.push(`Aggregation and containment could not be read: ${error?.message ?? error}`); }

    const primitives = [...groups.values()].map(group => ({
      rgba: group.rgba, positions: Float32Array.from(group.positions), normals: Float32Array.from(group.normals),
      featureIds: Float32Array.from(group.featureIds), indices: Uint32Array.from(group.indices),
    }));
    const glb = writeGlb({
      primitives,
      features: features.map(f => ({ globalId: f.globalId, name: f.name, ifcClass: f.ifcClass, tag: f.tag, networkId: f.networkId })),
      extras: { generator: `acs-demo ifc-spatial converter v${CONVERTER_VERSION} (web-ifc ${WEB_IFC_VERSION})`, sourceFile, versionId,
        units: 'metre', upAxis: 'Z', frame: 'IFC engineering coordinates (IfcMapConversion source frame)' },
    });

    const byClass = {}, geometryByClass = {};
    for (const element of elements) {
      byClass[element.ifcClass] = (byClass[element.ifcClass] ?? 0) + 1;
      if (element.featureId !== null) geometryByClass[element.ifcClass] = (geometryByClass[element.ifcClass] ?? 0) + 1;
    }
    const missingGlobalId = elements.filter(element => !element.globalId).length;
    if (missingGlobalId) warnings.push(`${missingGlobalId} elements have no IFC GlobalId.`);
    const duplicates = elements.length - new Set(elements.map(element => element.globalId).filter(Boolean)).size - missingGlobalId;
    if (duplicates > 0) warnings.push(`${duplicates} IFC GlobalIds are duplicated.`);

    const diagnostics = {
      converterVersion: CONVERTER_VERSION, library: 'web-ifc', libraryVersion: WEB_IFC_VERSION,
      sourceFile, versionId, versionNumber, sourceBytes: bytes.length,
      header, schema: api.GetModelSchema(modelID) ?? header.schema,
      lengthUnitScale: unitScale,
      elements: elements.length, withGeometry: features.length, withoutGeometry: elements.length - features.length,
      connections: connections.length, routes: elements.filter(element => element.route).length,
      byClass, geometryByClass, triangles: triangleTotal, vertices: vertexTotal, primitives: primitives.length, glbBytes: glb.length,
      georeference: georef, placement: georeferencedPlacement(georef),
      durationMs: Date.now() - started, warnings,
    };
    return { glb, elements, connections, diagnostics };
  } finally {
    api.CloseModel(modelID);
  }
}
