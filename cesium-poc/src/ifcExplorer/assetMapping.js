/**
 * Read-only comparison of an IFC model's elements with the Seagirt twin's illustrative electrical
 * assets (`public/data/seagirt/electrical-assets.json`). It writes nothing and links nothing: the
 * electrical graph, the asset positions and the IFC model are all left exactly as they are.
 *
 * The rules are deliberately strict:
 *  - Only an exact identifier match counts as a candidate: the asset id equal to the element's
 *    `NetworkID` or IFC `Tag`. "T1" and "TX-1" are different identifiers; similar names are never
 *    treated as a match, and neither is position or visual proximity.
 *  - Even an exact identifier match is only a CANDIDATE. The two networks were authored separately,
 *    so a shared string proves nothing without someone confirming it. A candidate whose IFC class
 *    or voltage contradicts the asset is reported as ambiguous with the reason.
 *  - Autodesk dbId, IFC GlobalId and the electrical graph's asset id stay separate fields.
 */

/** The IFC classes each twin asset type could plausibly be. Used only to flag contradictions. */
export const COMPATIBLE_CLASSES = Object.freeze({
  UTILITY_SUPPLY: ['IfcElectricDistributionBoard', 'IfcElectricGenerator'],
  SUBSTATION: ['IfcElementAssembly', 'IfcElectricDistributionBoard'],
  TRANSFORMER: ['IfcTransformer'],
  SWITCHGEAR: ['IfcElectricDistributionBoard'],
  CIRCUIT_BREAKER: ['IfcProtectiveDevice', 'IfcSwitchingDevice'],
  FEEDER: ['IfcCableSegment'],
  CRANE: ['IfcTransportElement', 'IfcElectricDistributionBoard'],
  LIGHTING_CIRCUIT: ['IfcLightFixture', 'IfcCableSegment', 'IfcElectricDistributionBoard'],
  WAREHOUSE: ['IfcElectricDistributionBoard', 'IfcBuilding', 'IfcBuildingElementProxy'],
  DISTRIBUTION_PANEL: ['IfcElectricDistributionBoard'],
  EV_CHARGING: ['IfcElectricDistributionBoard', 'IfcElectricAppliance'],
});

/** The identity and electrical fields every electrical IFC element is expected to carry here. */
export const EXPECTED_FIELDS = Object.freeze(['globalId', 'tag', 'networkId', 'networkRole', 'voltageLevel']);
const FIELD_LABEL = { globalId: 'IFC GlobalId', tag: 'IFC Tag', networkId: 'NetworkID', networkRole: 'NetworkRole', voltageLevel: 'VoltageLevel' };

/** "13.8 kV" / "480 V" → kV, or null when the text states no voltage. */
export function kilovolts(textValue) {
  const match = /([\d.]+)\s*(k?V)\b/i.exec(String(textValue ?? ''));
  if (!match) return null;
  const value = Number(match[1]);
  return match[2].toLowerCase() === 'kv' ? value : value / 1000;
}

const assetVoltages = asset => [asset.voltage?.primary, asset.voltage?.secondary].filter(Boolean)
  .map(v => (String(v.unit).toLowerCase() === 'kv' ? Number(v.value) : Number(v.value) / 1000));

const ifcRef = element => ({
  dbId: element.dbId, globalId: element.globalId, name: element.name, ifcClass: element.ifcClass,
  networkId: element.networkId, tag: element.tag, networkRole: element.networkRole, voltageLevel: element.voltageLevel,
});

export function compareAssets(elements, assets) {
  const electrical = elements.filter(element => element.electrical);
  const byIdentifier = new Map();
  for (const element of electrical) {
    for (const id of new Set([element.networkId, element.tag].filter(Boolean))) {
      if (!byIdentifier.has(id)) byIdentifier.set(id, []);
      byIdentifier.get(id).push(element);
    }
  }

  const candidates = [], ambiguous = [], assetsOnly = [];
  const matchedDbIds = new Set();
  for (const asset of assets) {
    const hits = byIdentifier.get(asset.id) ?? [];
    if (!hits.length) { assetsOnly.push({ assetId: asset.id, assetName: asset.name, assetType: asset.assetType }); continue; }
    for (const hit of hits) matchedDbIds.add(hit.dbId);
    const reasons = [];
    if (hits.length > 1) reasons.push(`${hits.length} IFC elements carry the identifier ${asset.id}.`);
    for (const hit of hits) {
      const allowed = COMPATIBLE_CLASSES[asset.assetType];
      if (allowed && !allowed.includes(hit.ifcClass)) reasons.push(`${hit.ifcClass} is not a plausible ${asset.assetType.toLowerCase().replaceAll('_', ' ')}.`);
      const ifcKv = kilovolts(hit.voltageLevel);
      const twinKv = assetVoltages(asset);
      if (ifcKv !== null && twinKv.length && !twinKv.some(kv => Math.abs(kv - ifcKv) < 1e-6)) {
        reasons.push(`Voltage differs: IFC ${hit.voltageLevel}, twin ${twinKv.map(kv => `${kv} kV`).join(' / ')}.`);
      }
    }
    const entry = {
      assetId: asset.id, assetName: asset.name, assetType: asset.assetType,
      ifc: hits.map(ifcRef),
      verdict: reasons.length ? 'AMBIGUOUS' : 'CANDIDATE_UNCONFIRMED',
      reasons: reasons.length ? reasons : ['Identifier matches exactly; class and voltage do not contradict it. Not confirmed: the models were authored separately.'],
    };
    (reasons.length ? ambiguous : candidates).push(entry);
  }

  const ifcOnly = electrical.filter(element => !matchedDbIds.has(element.dbId)).map(ifcRef);
  const missingMetadata = electrical.map(element => ({ ...ifcRef(element), missing: EXPECTED_FIELDS.filter(field => !element[field]).map(field => FIELD_LABEL[field]) }))
    .filter(entry => entry.missing.length);

  return {
    candidates, ambiguous, ifcOnly, assetsOnly, missingMetadata,
    summary: {
      ifcElectricalElements: electrical.length, twinAssets: assets.length,
      candidates: candidates.length, ambiguous: ambiguous.length,
      ifcWithoutAsset: ifcOnly.length, assetsNotInIfc: assetsOnly.length,
      elementsMissingMetadata: missingMetadata.length,
    },
    rules: [
      'Only an exact identifier (NetworkID or IFC Tag equal to the asset id) is considered.',
      'Similar names (T1 / TX-1, C1 / STS-01) are not matches.',
      'No relationship is inferred from position or visual proximity.',
      'Nothing is written: the electrical graph and asset positions are unchanged.',
    ],
  };
}
