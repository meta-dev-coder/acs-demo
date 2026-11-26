/**
 * The IFC model's electrical network, in the electrical twin's own format, so the same connectivity
 * engine (seagirt/electricalGraph.js), outage simulation and Ask the Twin run on it unchanged.
 *
 * Everything comes from the converted IFC (server/ifcSpatial/convert.mjs): an asset per element
 * that carries a SuperDNA_PowerNetwork NetworkID, its type from the model's NetworkRole and IFC
 * class, its normal state from NormalState, and the connections from the file's port relations
 * (IfcRelConnectsPorts with each port's FlowDirection). Cables are assets too (type FEEDER), so a
 * cable can be cut like any other element. The SCADA fibre network is kept apart from the power
 * graph: it carries control, not power.
 *
 * Positions are the element's bounding-box centre (cables: their route) placed on the globe by the
 * screen's placement, through `toLonLat`. Pure: no Cesium, no DOM.
 */
import { buildTopology } from './topology.js';
import { createNetwork } from '../seagirt/electricalGraph.js';

/** NetworkRole (then IFC class) → the twin's asset type. null = not part of the power network. */
export function assetTypeOf(element) {
  const role = String(element.networkRole ?? '').toLowerCase();
  const name = String(element.name ?? '').toLowerCase();
  if (!element.networkId) return null;
  if (/scada|rtu|fibre|fiber/.test(role) || element.ifcClass === 'IfcController' || element.ifcClass === 'IfcCommunicationsAppliance') return null;
  if (element.ifcClass === 'IfcTransportElement') return null;     // the crane's steel; its power intake is the e-house
  if (role === 'source' || role === 'standby source') return 'UTILITY_SUPPLY';
  if (element.ifcClass === 'IfcTransformer') return 'TRANSFORMER';
  if (role === 'ring main unit') return 'SUBSTATION';
  if (role === 'switchgear bus' || role === 'quay switching station') return 'SWITCHGEAR';
  if (element.ifcClass === 'IfcProtectiveDevice') return 'CIRCUIT_BREAKER';
  if (element.ifcClass === 'IfcSwitchingDevice') return 'SWITCH';
  if (element.ifcClass === 'IfcCableSegment') return 'FEEDER';
  if (element.ifcClass === 'IfcJunctionBox') return 'JUNCTION_BOX';
  if (element.ifcClass === 'IfcLightFixture') return 'LIGHTING_CIRCUIT';
  if (role === 'load') {
    if (/crane|sts-/.test(name) || /^STS-\d+$/.test(element.networkId)) return 'CRANE';
    if (/reefer/.test(name) || element.properties?.SuperDNA_PowerNetwork?.ReeferPlugs) return 'OTHER_LOAD';
    return 'BUILDING';
  }
  return 'OTHER_LOAD';
}

/** The mock's drawing kind for a node (its symbol). */
export function symbolOf(asset) {
  const n = asset.id;
  if (asset.assetType === 'UTILITY_SUPPLY') return asset.standby ? 'gen' : 'src';
  if (asset.assetType === 'TRANSFORMER') return /^TX-M/.test(n) ? 'mtx' : 'tx';
  if (asset.assetType === 'SUBSTATION') return 'rmu';
  if (asset.assetType === 'SWITCHGEAR') return /^BUS-/.test(n) ? 'bus' : 'qss';
  if (asset.assetType === 'CIRCUIT_BREAKER' || asset.assetType === 'SWITCH') return /^ATS/.test(n) ? 'ats' : 'sw';
  if (asset.assetType === 'JUNCTION_BOX') return 'vault';
  if (asset.assetType === 'CRANE') return 'sts';
  if (asset.assetType === 'LIGHTING_CIRCUIT') return 'mast';
  if (asset.assetType === 'OTHER_LOAD') return 'reefer';
  if (asset.assetType === 'BUILDING') return n === 'GATE' ? 'gate' : n === 'OPS' ? 'ops' : n === 'WS' ? 'shop' : 'office';
  return null;
}

/** "13.8 kV" / "480 V" → { value, unit } as the twin's records hold it. */
export function voltageOf(text) {
  const m = /([\d.]+)\s*(k?V)\b/i.exec(String(text ?? ''));
  return m ? { primary: { value: Number(m[1]), unit: m[2].toLowerCase() === 'kv' ? 'kV' : 'V' }, secondary: null } : null;
}
/** The voltage class the mock colours by: hv (34.5 kV), mv (13.8 kV), lv (480 V). */
export function voltageClass(asset) {
  const v = asset.voltage?.primary;
  if (!v) return null;
  const kv = v.unit === 'kV' ? v.value : v.value / 1000;
  return kv >= 30 ? 'hv' : kv >= 1 ? 'mv' : 'lv';
}

const number = value => (value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
const centre = bbox => bbox && bbox.min.map((v, i) => (v + bbox.max[i]) / 2);

export const IFC_NOTES = Object.freeze({
  connections: 'Connections are the IFC model\'s port relations (IfcRelConnectsPorts); cable routes are the modelled ones. The model itself is an illustrative mock, not as-built.',
  records: 'The IFC model carries no inspection, condition or maintenance records.',
});

/**
 * @param {object} input
 * @param {object[]} input.elements    elements.json `elements`
 * @param {object[]} input.connections elements.json `connections` ({from, to, twoWay} by GlobalId)
 * @param {(x:number, y:number, z:number) => {lon:number, lat:number, height:number}} [input.toLonLat]
 */
/** SuperDNA_ShortCircuit as numbers and text: the modelled fault duty, the rating (nameplate or assumed), the model's own result. */
export function shortCircuitOf(sc) {
  const kA = v => { const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '').replace(/[^0-9.eE+-]/g, '')); return Number.isFinite(n) ? n : null; };
  const nameplate = kA(sc.InterruptingRatingNameplate);
  return {
    studyType: sc.StudyType ?? null, studyDate: sc.StudyDate ?? null, dataStatus: sc.DataStatus ?? null, notes: sc.Notes ?? null,
    governingCase: sc.GoverningCase ?? null, caseAkA: kA(sc.FaultCurrent_CaseA_kA), caseBkA: kA(sc.FaultCurrent_CaseB_kA),
    maxFaultkA: kA(sc.MaxSymmetricalFault_kA), dutykA: kA(sc.InterruptingDuty_kA) ?? kA(sc.MaxSymmetricalFault_kA), xr: kA(sc.XRRatioAtFault), asymmetry: kA(sc.AsymmetryMultiplier),
    nameplatekA: nameplate, nameplateText: sc.InterruptingRatingNameplate ?? null, assumedkA: kA(sc.AssumedInterruptingRating_kA), assumedBasis: sc.AssumedRatingBasis ?? null,
    ratingkA: nameplate ?? kA(sc.AssumedInterruptingRating_kA), ratingAssumed: nameplate === null, minimumRequiredkA: kA(sc.MinimumRequiredRating_kA),
    statedPercent: kA(sc.DutyPercentOfAssumedRating), statedResult: sc.ScreeningResult ?? null,
  };
}

/** SuperDNA_AssetStatus.PowerStatus → 'NO_POWER' | 'POWERED' | null. */
export function reportedPowerOf(value) {
  const text = String(value ?? '').trim();
  if (/^(no|without)[\s_-]*power|^de-?energi[sz]ed|^unpowered|^off$/i.test(text)) return 'NO_POWER';
  if (/^powered|^energi[sz]ed|^on$/i.test(text)) return 'POWERED';
  return null;
}

export function buildIfcNetwork({ elements = [], connections = [], toLonLat = null } = {}) {
  const byGlobalId = new Map(elements.filter(e => e.globalId).map(e => [e.globalId, e]));
  const place = point => (toLonLat && point ? toLonLat(...point) : null);
  const assets = [];
  for (const element of elements) {
    const assetType = assetTypeOf(element);
    if (!assetType) continue;
    const net = element.properties?.SuperDNA_PowerNetwork ?? {};
    const status = element.properties?.SuperDNA_AssetStatus ?? {};
    const sc = element.properties?.SuperDNA_ShortCircuit ?? null;
    const at = place(centre(element.bbox));
    const asset = {
      // IFC names start with the id ("TX-M1 Main transformer TX-M1"); answers print the id beside the name.
      id: element.networkId, name: String(element.name ?? element.networkId).replace(new RegExp(`^${element.networkId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`), '') || element.networkId,
      assetType, projectId: 'seagirt-ifc',
      globalId: element.globalId, featureId: element.featureId, ifcClass: element.ifcClass, networkRole: element.networkRole,
      standby: /standby/i.test(element.networkRole ?? ''),
      voltage: voltageOf(element.voltageLevel), voltageLevel: element.voltageLevel,
      rating: null, ratingText: net.Rating ?? null,
      demandKw: number(net.DemandkW), capacityKw: number(net.CapacitykW), reeferPlugs: number(net.ReeferPlugs), critical: /yes|true/i.test(String(net.CriticalLoad ?? '')),
      circuit: net.Circuit ?? null, routeLengthM: number(net.RouteLengthM),
      normalState: /open/i.test(String(net.NormalState ?? '')) ? 'OPEN' : (assetType === 'SWITCH' || assetType === 'CIRCUIT_BREAKER') ? 'CLOSED' : undefined,
      location: at ? { longitude: at.lon, latitude: at.lat, height: at.height } : { longitude: null, latitude: null },
      route: element.route && toLonLat ? element.route.map(p => toLonLat(...p)) : null,
      operationalStatus: 'IN_SERVICE', condition: null, lastInspectionDate: null, nextInspectionDate: null, parentAssetId: null,
      dataProvenance: 'IFC_MODEL', verificationStatus: 'UNVERIFIED', illustrative: /illustrative|mock/i.test(net.DataStatus ?? ''),
      description: element.description ?? null,
      // The status recorded in the model (SuperDNA_AssetStatus): "No power" is the reported live state,
      // which the network twin applies on top of what the connectivity would supply.
      reportedPower: reportedPowerOf(status.PowerStatus), statusFlag: status.StatusFlag ?? null, statusDate: status.StatusDate ?? null,
      // A short-circuit screening recorded in the model (SuperDNA_ShortCircuit), kept as the model states it.
      shortCircuit: sc ? shortCircuitOf(sc) : null,
      interruptingRating: sc && Number.isFinite(number(sc.InterruptingRatingNameplate)) ? { value: number(sc.InterruptingRatingNameplate), unit: 'kA' } : null,
    };
    assets.push(asset);
  }
  const ids = new Set(assets.map(a => a.id));
  const idOf = globalId => byGlobalId.get(globalId)?.networkId ?? null;
  const edges = [], scadaLinks = [];
  for (const c of connections) {
    const [from, to] = [idOf(c.from), idOf(c.to)];
    if (!from || !to) continue;
    if (!ids.has(from) || !ids.has(to)) { scadaLinks.push({ from, to }); continue; }
    const edge = (a, b) => ({ id: `E-${a}-${b}`, fromAssetId: a, toAssetId: b, connectionType: 'ELECTRICAL', normallyClosed: true, operationalState: 'CLOSED',
      dataProvenance: 'IFC_MODEL', verificationStatus: 'UNVERIFIED', twoWay: Boolean(c.twoWay) });
    edges.push(edge(from, to));
    if (c.twoWay) edges.push(edge(to, from));
  }
  // The crane steel (STS-nn-STRUCT) belongs to the crane whose intake it names.
  const structures = new Map();
  for (const element of elements) {
    const intake = element.properties?.SuperDNA_PowerNetwork?.IntakeNetworkID;
    if (intake && ids.has(intake)) structures.set(element.globalId, intake);
  }
  // The physical topology with roles, ports and evidence (topology.js); a load with a modelled
  // loop-in / loop-out (two ports) keeps passing the circuit on when the load itself is out.
  const topology = buildTopology({ elements, connections, idOf: g => (ids.has(idOf(g)) ? idOf(g) : null) });
  for (const a of assets) {
    const node = topology.nodes.get(a.id);
    a.electricalRole = node?.role ?? null;
    a.feedThrough = node?.feedThrough === 'EXPLICIT';
  }
  for (const e of edges) {
    const t = topology.edges.find(x => (x.from === e.fromAssetId && x.to === e.toAssetId) || (x.to === e.fromAssetId && x.from === e.toAssetId));
    e.direction = t?.direction ?? null;
    e.evidence = t?.evidence ?? null;
  }
  const network = { ...createNetwork({ assets, edges }), notes: IFC_NOTES };
  return { network, assets, edges, scadaLinks, structures, byGlobalId, topology,
    assetByGlobalId: new Map(assets.map(a => [a.globalId, a])) };
}
