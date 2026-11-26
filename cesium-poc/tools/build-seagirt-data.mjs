#!/usr/bin/env node
/**
 * Builds the Seagirt Marine Terminal data the page reads (public/data/seagirt/):
 *
 *   terminal-geography.geojson   REAL geography, OpenStreetMap (ODbL), every feature attributed:
 *                                the terminal outline, buildings and service roads inside it, the
 *                                berth face (the outline's waterside edge) and the one mapped
 *                                substation (owner and equipment unknown; not part of the network).
 *   electrical-assets.json       SYNTHETIC demonstration equipment (dataProvenance SYNTHETIC_DEMO).
 *   electrical-connectivity.json SYNTHETIC topology: nodes are assets, edges are conductors.
 *   inspections.json             SYNTHETIC inspection and maintenance records.
 *   gis-associations.json        Which public GIS features MAY be which illustrative assets, with the
 *                                evidence for and against (computed here, never typed). Only a
 *                                VERIFIED association is authoritative; none is.
 *
 *   node tools/build-seagirt-data.mjs
 *
 * WHY POSITIONS ARE COMPUTED, NOT TYPED. Kimley-Horn's inventory does not exist yet, so the demo
 * network is placed deliberately rather than surveyed: cranes on the berth apron (a fixed inset
 * from the berth face, which is the real outline edge facing the channel), equipment at stated
 * offsets from named reference points. Nothing is random, every point is checked to lie inside the
 * terminal outline, and every record says it is illustrative.
 *
 * Breakers have NO coordinates: they sit in a switchgear lineup and carry its id and a cubicle.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceM, lerp, offsetM, pointInPolygon, ringCentroid } from '../src/seagirt/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data', 'seagirt', 'source');
const OUT = join(ROOT, 'public', 'data', 'seagirt');
const OSM = Object.freeze({ source: 'OpenStreetMap', licence: 'ODbL 1.0', attribution: '© OpenStreetMap contributors', retrieved: '2026-11-23' });
const ILLUSTRATIVE = 'Illustrative position for the demonstration — not a surveyed location of real equipment.';

// ---- OpenStreetMap ---------------------------------------------------------------------------------------

/** The OSM API's XML, read just enough: nodes with positions, ways with node refs and tags. */
function parseOsmXml(xml) {
  const tags = body => Object.fromEntries([...body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)].map(m => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")]));
  const nodes = new Map();
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"[^>]*?(\/>|>([\s\S]*?)<\/node>)/g)) {
    nodes.set(m[1], { lon: Number(m[3]), lat: Number(m[2]), tags: m[5] ? tags(m[5]) : {} });
  }
  const ways = [];
  for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
    const refs = [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map(r => r[1]);
    ways.push({ id: m[1], coords: refs.map(r => nodes.get(r)).filter(Boolean).map(n => [n.lon, n.lat]), tags: tags(m[2]) });
  }
  return { nodes, ways };
}

const round = p => [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7];

function buildGeography() {
  const terminal = JSON.parse(readFileSync(join(SOURCE, 'osm-seagirt-terminal.json'), 'utf8'));
  const outline = terminal.elements.find(e => e.id === 87334858);
  const substation = terminal.elements.find(e => e.id === 336181714);
  const ring = outline.geometry.map(p => [p.lon, p.lat]);
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
  const polygon = [ring];
  const { ways } = parseOsmXml(readFileSync(join(SOURCE, 'osm-seagirt-bbox.xml'), 'utf8'));

  const features = [{
    type: 'Feature', id: 'terminal-boundary',
    geometry: { type: 'Polygon', coordinates: [ring.map(round)] },
    properties: { layer: 'boundary', name: outline.tags.name, osmId: `way/${outline.id}`, ...OSM, dataProvenance: 'IMPORTED_GIS',
      note: 'Community-mapped land-use outline (OpenStreetMap). Approximate — not a surveyed property or security line.' },
  }];
  // Buildings and service roads that lie inside the outline.
  for (const w of ways) {
    if (w.coords.length < 2) continue;
    if (w.tags.building && w.coords.length >= 4 && pointInPolygon(ringCentroid(w.coords), polygon)) {
      features.push({ type: 'Feature', id: `building-${w.id}`, geometry: { type: 'Polygon', coordinates: [w.coords.map(round)] },
        properties: { layer: 'building', name: w.tags.name ?? null, building: w.tags.building, osmId: `way/${w.id}`, ...OSM, dataProvenance: 'IMPORTED_GIS',
          note: 'Building footprint from OpenStreetMap. Its use and electrical supply are not recorded.' } });
    }
    if (w.tags.highway && ['service', 'primary', 'primary_link', 'secondary', 'unclassified'].includes(w.tags.highway)
      && pointInPolygon(w.coords[Math.floor(w.coords.length / 2)], polygon)) {
      features.push({ type: 'Feature', id: `road-${w.id}`, geometry: { type: 'LineString', coordinates: w.coords.map(round) },
        properties: { layer: 'road', name: w.tags.name ?? null, highway: w.tags.highway, osmId: `way/${w.id}`, ...OSM, dataProvenance: 'IMPORTED_GIS' } });
    }
  }
  // The berth face: the outline's straight waterside run facing the channel (its buoys lie to the
  // south-west). Taken from the outline's own vertices, not drawn.
  const berth = ring.filter(([lon, lat]) => lon >= -76.5496 && lon <= -76.5439 && lat <= 39.2558 && lat >= 39.2524);
  features.push({ type: 'Feature', id: 'berth-face', geometry: { type: 'LineString', coordinates: berth.map(round) },
    properties: { layer: 'berth', name: 'Berth face (approximate)', ...OSM, dataProvenance: 'IMPORTED_GIS',
      note: 'The waterside edge of the OpenStreetMap terminal outline facing the shipping channel. Approximate.' } });
  features.push({ type: 'Feature', id: 'osm-substation', geometry: { type: 'Polygon', coordinates: [substation.geometry.map(p => round([p.lon, p.lat]))] },
    properties: { layer: 'osmSubstation', name: 'Mapped substation (OpenStreetMap)', osmId: `way/${substation.id}`, ...OSM, dataProvenance: 'IMPORTED_GIS',
      note: 'A fenced substation mapped in OpenStreetMap (power=substation). Owner, voltage and equipment are not recorded. A CANDIDATE, unverified match for the illustrative Substation SS1 — not a confirmed part of the demonstration network.' } });
  const powerFeatures = ways.filter(w => w.tags.power).length;
  return { type: 'FeatureCollection', name: 'Seagirt Marine Terminal — geography', attribution: OSM.attribution, licence: OSM.licence, features, polygon, berth,
    substationTags: substation.tags, powerFeatures };
}

// ---- the synthetic electrical network --------------------------------------------------------------------

const SYN = Object.freeze({ dataProvenance: 'SYNTHETIC_DEMO', verificationStatus: 'UNVERIFIED' });

/** One asset record in the registry's schema. */
function asset(id, name, assetType, { parent = null, point = null, container = null, rating = null, voltage = null,
  condition = 'GOOD', lastInspection = null, nextInspection = null, tier = 'DETAIL', extra = {} } = {}) {
  return {
    id, name, assetType, projectId: 'seagirt', parentAssetId: parent,
    location: point
      ? { longitude: round(point)[0], latitude: round(point)[1], buildingId: null, roomId: null, cabinetId: null, positionNote: ILLUSTRATIVE }
      : { longitude: null, latitude: null, buildingId: null, roomId: null, cabinetId: container?.cabinet ?? null,
        containerAssetId: container?.asset ?? null, cubicle: container?.cubicle ?? null,
        positionNote: container ? `Inside ${container.asset}, cubicle ${container.cubicle} — no separate map position.` : null },
    rating, voltage,
    operationalStatus: 'IN_SERVICE', condition, lastInspectionDate: lastInspection, nextInspectionDate: nextInspection,
    mapTier: tier,   // MAJOR: shown at overview; DETAIL: shown when the network is explored
    ...SYN, ...extra,
  };
}

function buildNetwork(geo) {
  const { polygon, berth } = geo;
  // Reference points, all derived from the real outline.
  const [bA, bB] = [berth[0], berth.at(-1)];   // the berth face's two ends
  const along = t => lerp(bA, bB, t);
  // Inland normal of the berth face (towards the terminal), in metres.
  const apron = (t, inset) => {
    const p = along(t);
    const dx = distanceM(bA, [bB[0], bA[1]]) * Math.sign(bB[0] - bA[0]);
    const dy = distanceM(bA, [bA[0], bB[1]]) * Math.sign(bB[1] - bA[1]);
    const len = Math.hypot(dx, dy);
    // Rotate the berth direction 90° towards the land side (north-east here).
    const nx = -dy / len, ny = dx / len;
    const sign = pointInPolygon(offsetM(p, nx * 50, ny * 50), polygon) ? 1 : -1;
    return offsetM(p, sign * nx * inset, sign * ny * inset);
  };
  const yard = (t, inset) => apron(t, inset);

  const pos = {
    MS1: [-76.5498, 39.2635],                // the utility point of connection, near the north-west gate
    SS1: [-76.5490, 39.2614],
    T1: yard(0.15, 160), T2: yard(0.5, 160), T3: yard(0.85, 160),
    S1: yard(0.15, 125), S2: yard(0.5, 125), S3: yard(0.85, 125),
    C1: apron(0.08, 30), C2: apron(0.26, 30), C3: apron(0.46, 30), C4: apron(0.64, 30), C5: apron(0.86, 30),
    L1: yard(0.2, 330), W1: yard(0.55, 330), DP3: yard(0.88, 260), W2: yard(0.95, 340), EV1: [-76.5513, 39.2630],
  };
  for (const [id, p] of Object.entries(pos)) {
    if (!pointInPolygon(p, polygon)) throw new Error(`${id} at ${p} is outside the terminal outline`);
  }

  const insp = (last, next) => ({ lastInspection: last, nextInspection: next });
  const kv = v => ({ value: v, unit: 'kV' });
  const assets = [
    asset('MS1', 'Main Supply MS1', 'UTILITY_SUPPLY', { point: pos.MS1, tier: 'MAJOR', voltage: { primary: kv(34.5), secondary: null },
      extra: { description: 'Utility point of connection (illustrative).' } }),
    asset('SS1', 'Substation SS1', 'SUBSTATION', { parent: 'MS1', point: pos.SS1, tier: 'MAJOR', voltage: { primary: kv(34.5), secondary: kv(13.8) },
      rating: { value: 30, unit: 'MVA' }, ...insp('2026-05-12', '2027-05-12') }),
    asset('T1', 'Transformer T1', 'TRANSFORMER', { parent: 'SS1', point: pos.T1, tier: 'MAJOR', rating: { value: 5, unit: 'MVA' },
      voltage: { primary: kv(13.8), secondary: kv(4.16) }, condition: 'FAIR', ...insp('2026-03-18', '2027-03-18') }),
    asset('T2', 'Transformer T2', 'TRANSFORMER', { parent: 'SS1', point: pos.T2, tier: 'MAJOR', rating: { value: 5, unit: 'MVA' },
      voltage: { primary: kv(13.8), secondary: kv(4.16) }, condition: 'GOOD', ...insp('2026-06-02', '2027-06-02') }),
    asset('T3', 'Transformer T3', 'TRANSFORMER', { parent: 'SS1', point: pos.T3, tier: 'MAJOR', rating: { value: 3.75, unit: 'MVA' },
      voltage: { primary: kv(13.8), secondary: kv(4.16) }, condition: 'POOR', ...insp('2025-10-07', '2026-10-07'),
      extra: { conditionNote: 'Synthetic: elevated dissolved-gas readings at last inspection; reinspection overdue.' } }),
    asset('S1', 'Switchgear S1', 'SWITCHGEAR', { parent: 'T1', point: pos.S1, tier: 'DETAIL', voltage: { primary: kv(4.16), secondary: null }, ...insp('2026-04-21', '2027-04-21') }),
    asset('S2', 'Switchgear S2', 'SWITCHGEAR', { parent: 'T2', point: pos.S2, tier: 'DETAIL', voltage: { primary: kv(4.16), secondary: null }, ...insp('2026-07-09', '2027-07-09') }),
    asset('S3', 'Switchgear S3', 'SWITCHGEAR', { parent: 'T3', point: pos.S3, tier: 'DETAIL', voltage: { primary: kv(4.16), secondary: null }, condition: 'FAIR', ...insp('2026-02-14', '2027-02-14') }),
  ];
  // Breakers in their lineups; feeders out of them. TB1 is the normally-open tie from S2 to Crane C2.
  const breakers = [
    ['CB1', 'S1', 1, 'F1'], ['CB2', 'S1', 2, 'F2'], ['CB3', 'S1', 3, 'F3'],
    ['CB4', 'S2', 1, 'F4'], ['CB5', 'S2', 2, 'F5'], ['CB6', 'S2', 3, 'F6'],
    ['CB7', 'S3', 1, 'F7'], ['CB8', 'S3', 2, 'F8'],
  ];
  for (const [id, gear, cubicle] of breakers) {
    assets.push(asset(id, `Circuit Breaker ${id}`, 'CIRCUIT_BREAKER', { parent: gear, container: { asset: gear, cubicle, cabinet: `${gear}-${cubicle}` },
      rating: { value: 1200, unit: 'A' }, extra: { normalState: 'CLOSED' } }));
  }
  assets.push(asset('TB1', 'Tie Breaker TB1', 'CIRCUIT_BREAKER', { parent: 'S2', container: { asset: 'S2', cubicle: 4, cabinet: 'S2-4' },
    rating: { value: 1200, unit: 'A' }, extra: { normalState: 'OPEN', description: 'Normally-open tie to Crane C2 (alternate supply from the T2 branch).' } }));
  const feeders = [['F1', 'CB1', 'L1'], ['F2', 'CB2', 'C2'], ['F3', 'CB3', 'C1'], ['F4', 'CB4', 'C3'], ['F5', 'CB5', 'C4'],
    ['F6', 'CB6', 'W1'], ['F7', 'CB7', 'C5'], ['F8', 'CB8', 'DP3'], ['F2A', 'TB1', 'C2']];
  for (const [id, from, to] of feeders) {
    assets.push(asset(id, id === 'F2A' ? 'Alternate Feeder F2A' : `Feeder ${id}`, 'FEEDER', { parent: from,
      voltage: { primary: kv(4.16), secondary: null }, extra: { from, to, geometryNote: 'No cable route is recorded; drawn schematically.' } }));
  }
  assets.push(
    asset('C1', 'Crane C1', 'CRANE', { parent: 'F3', point: pos.C1, tier: 'MAJOR', rating: { value: 1.2, unit: 'MW' }, ...insp('2026-08-11', '2027-02-11') }),
    asset('C2', 'Crane C2', 'CRANE', { parent: 'F2', point: pos.C2, tier: 'MAJOR', rating: { value: 1.2, unit: 'MW' }, ...insp('2026-08-11', '2027-02-11') }),
    asset('C3', 'Crane C3', 'CRANE', { parent: 'F4', point: pos.C3, tier: 'MAJOR', rating: { value: 1.2, unit: 'MW' }, ...insp('2026-07-28', '2027-01-28') }),
    asset('C4', 'Crane C4', 'CRANE', { parent: 'F5', point: pos.C4, tier: 'MAJOR', rating: { value: 1.2, unit: 'MW' }, condition: 'FAIR', ...insp('2026-07-28', '2027-01-28') }),
    asset('C5', 'Crane C5', 'CRANE', { parent: 'F7', point: pos.C5, tier: 'MAJOR', rating: { value: 1.2, unit: 'MW' }, ...insp('2026-09-03', '2027-03-03') }),
    asset('L1', 'Lighting Circuit L1', 'LIGHTING_CIRCUIT', { parent: 'F1', point: pos.L1, rating: { value: 0.25, unit: 'MW' } }),
    asset('W1', 'Warehouse W1', 'WAREHOUSE', { parent: 'F6', point: pos.W1, rating: { value: 0.6, unit: 'MW' } }),
    asset('DP3', 'Distribution Panel DP3', 'DISTRIBUTION_PANEL', { parent: 'F8', point: pos.DP3, voltage: { primary: kv(0.48), secondary: null } }),
    asset('W2', 'Warehouse W2', 'WAREHOUSE', { parent: 'DP3', point: pos.W2, rating: { value: 0.45, unit: 'MW' } }),
    asset('EV1', 'Charging Station EV1', 'EV_CHARGING', { parent: 'DP3', point: pos.EV1, rating: { value: 0.35, unit: 'MW' } }),
  );

  // Connectivity: directed source → load. Switching devices are nodes; conductors are edges.
  const edge = (from, to, extra = {}) => ({ id: `EDGE-${from}-${to}`, fromAssetId: from, toAssetId: to, connectionType: 'ELECTRICAL',
    nominalVoltage: null, normallyClosed: true, operationalState: 'CLOSED', ...SYN, ...extra });
  const edges = [edge('MS1', 'SS1'), edge('SS1', 'T1'), edge('SS1', 'T2'), edge('SS1', 'T3'),
    edge('T1', 'S1'), edge('T2', 'S2'), edge('T3', 'S3')];
  for (const [id, gear] of breakers) edges.push(edge(gear, id));
  edges.push(edge('S2', 'TB1'));
  for (const [id, from, to] of feeders) edges.push(edge(from, id), edge(id, to));
  edges.push(edge('DP3', 'W2'), edge('DP3', 'EV1'));
  // The lighting circuit's return path to the yard lighting mast is not documented: kept, but UNKNOWN.
  edges.push(edge('L1', 'L1-MASTS', { operationalState: 'UNKNOWN', normallyClosed: null,
    note: 'Synthetic example of an undocumented connection: the masts L1 supplies are not in the inventory.' }));
  assets.push(asset('L1-MASTS', 'Yard Lighting Masts (L1)', 'LIGHTING_CIRCUIT', { parent: 'L1', point: offsetM(pos.L1, 60, 40),
    condition: 'UNKNOWN', extra: { description: 'Masts on circuit L1; their connection is undocumented in this synthetic inventory.' } }));

  return { assets, edges };
}

function buildInspections() {
  const rec = (assetId, date, type, result, notes) => ({ assetId, date, type, result, notes, ...SYN });
  return [
    rec('T1', '2026-03-18', 'Annual transformer inspection', 'SATISFACTORY_WITH_ACTIONS', 'Oil sample within limits; minor gasket weep noted for monitoring.'),
    rec('T1', '2025-03-11', 'Annual transformer inspection', 'SATISFACTORY', 'No findings.'),
    rec('T1', '2024-09-02', 'Corrective maintenance', 'COMPLETED', 'Cooling fan bearing replaced.'),
    rec('T2', '2026-06-02', 'Annual transformer inspection', 'SATISFACTORY', 'No findings.'),
    rec('T3', '2025-10-07', 'Annual transformer inspection', 'UNSATISFACTORY', 'Dissolved-gas analysis elevated (acetylene trace). Follow-up sampling recommended.'),
    rec('T3', '2024-10-15', 'Annual transformer inspection', 'SATISFACTORY_WITH_ACTIONS', 'Bushing cleaning; tap changer counter checked.'),
    rec('S1', '2026-04-21', 'Switchgear thermography and maintenance', 'SATISFACTORY_WITH_ACTIONS', 'Hot spot on CB2 line-side connection re-torqued; rescan clean.'),
    rec('S1', '2025-04-17', 'Switchgear thermography', 'SATISFACTORY', 'No hot spots.'),
    rec('S1', '2024-04-30', 'Breaker trip testing (CB1–CB3)', 'COMPLETED', 'All breakers tripped within tolerance.'),
    rec('S2', '2026-07-09', 'Switchgear thermography and maintenance', 'SATISFACTORY', 'TB1 interlock verified (normally open).'),
    rec('S3', '2026-02-14', 'Switchgear thermography', 'SATISFACTORY_WITH_ACTIONS', 'Enclosure heater fault logged; repair scheduled.'),
    rec('SS1', '2026-05-12', 'Substation annual inspection', 'SATISFACTORY', 'No findings.'),
  ];
}

/**
 * GIS ↔ electrical associations. A public feature is associated with an illustrative asset only as a
 * CANDIDATE, with the evidence that suggests it and the evidence that is missing; VERIFIED needs an
 * authoritative source (drawing, single-line diagram, asset register), and none exists yet.
 */
function buildAssociations(geo, assets) {
  const feature = geo.features.find(f => f.id === 'osm-substation');
  const ss1 = assets.find(a => a.id === 'SS1');
  const ring = feature.geometry.coordinates[0];
  const anchor = round(ringCentroid(ring));
  const ssAt = [ss1.location.longitude, ss1.location.latitude];
  const distance = Math.round(distanceM(anchor, ssAt));
  const [w, s, e, n] = [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))];
  const tags = Object.entries(geo.substationTags).map(([k, v]) => `${k}=${v}`).join(', ');
  const inside = pointInPolygon(anchor, geo.polygon);
  const missingTags = ['operator', 'voltage', 'name', 'ref'].filter(k => !(k in geo.substationTags));
  return [{
    electricalAssetId: 'SS1', geographicFeatureId: feature.id, osmId: feature.properties.osmId, geographicSource: 'OpenStreetMap',
    associationStatus: 'CANDIDATE', geometryConfidence: 'PUBLIC_MAPPED', topologyConfidence: 'ILLUSTRATIVE', verified: false,
    anchor: { longitude: anchor[0], latitude: anchor[1] }, distanceM: distance,
    footprintM: { eastWest: Math.round(distanceM([w, s], [e, s])), northSouth: Math.round(distanceM([w, s], [w, n])) },
    osmTags: geo.substationTags,
    evidence: [
      `Tagged ${tags} in OpenStreetMap.`,
      ...(inside ? ['Lies inside the mapped Seagirt Marine Terminal outline.'] : []),
      ...(geo.powerFeatures === 1 ? ['The only power-tagged feature in the terminal extract.'] : []),
      `Its centroid is ${distance} m from Substation SS1’s illustrative position.`,
    ],
    missingEvidence: [
      `No ${missingTags.length > 1 ? `${missingTags.slice(0, -1).join(', ')} or ${missingTags.at(-1)}` : missingTags[0]} recorded on the OpenStreetMap feature.`,
      'No drawing, single-line diagram or asset register links this footprint to SS1.',
      'SS1 itself is an illustrative asset, not a record of real equipment.',
    ],
    note: 'Candidate geographic match only. Using the footprint as SS1’s map anchor is a display choice; it does not change the asset registry or confirm connectivity.',
  }];
}

const geo = buildGeography();
const { polygon: _p, berth: _b, substationTags: _t, powerFeatures: _n, ...geography } = geo;
const network = buildNetwork(geo);
const associations = buildAssociations(geo, network.assets);
mkdirSync(OUT, { recursive: true });
const banner = { provenance: 'SYNTHETIC_DEMO', notice: 'Illustrative demonstration data. Not Seagirt Marine Terminal equipment, connectivity or records.', generatedBy: 'tools/build-seagirt-data.mjs' };
writeFileSync(join(OUT, 'terminal-geography.geojson'), `${JSON.stringify(geography)}\n`);
writeFileSync(join(OUT, 'electrical-assets.json'), `${JSON.stringify({ ...banner, assets: network.assets }, null, 2)}\n`);
writeFileSync(join(OUT, 'electrical-connectivity.json'), `${JSON.stringify({ ...banner, edges: network.edges }, null, 2)}\n`);
writeFileSync(join(OUT, 'inspections.json'), `${JSON.stringify({ ...banner, records: buildInspections() }, null, 2)}\n`);
writeFileSync(join(OUT, 'gis-associations.json'), `${JSON.stringify({ provenance: 'DERIVED', notice: 'Candidate links between public GIS features and illustrative electrical assets. Not verified.', generatedBy: banner.generatedBy, associations }, null, 2)}\n`);
const count = layer => geography.features.filter(f => f.properties.layer === layer).length;
console.log(`seagirt: geography ${geography.features.length} features (buildings ${count('building')}, roads ${count('road')}, berth ${count('berth')}); `
  + `assets ${network.assets.length}; edges ${network.edges.length}`);
