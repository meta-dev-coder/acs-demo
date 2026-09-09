/**
 * @typedef {'ENTRY_RAMP'|'EXIT_RAMP'|'INTERCHANGE_RAMP'|'INTERCHANGE_CONNECTOR'|'EXPRESS_CONNECTOR'} RampType
 * @typedef {object} I595Ramp
 * @property {string} id
 * @property {RampType} rampType
 * @property {string} direction
 * @property {string} fromRoad
 * @property {string} toRoad
 * @property {string} interchange
 * @property {boolean|undefined} elevated
 * @property {string} structureType
 * @property {string} functionConfidence
 * @property {string} structureConfidence
 * @property {string} connectedFacility
 * @property {string} osmWayId
 * @property {string} source
 */

export const RAMP_CATEGORIES = [
  { type: 'ENTRY_RAMP', label: 'Entry / On-ramps', display: 'Entry / On-ramp', color: '#94ed69' },
  { type: 'EXIT_RAMP', label: 'Exit / Off-ramps', display: 'Exit / Off-ramp', color: '#ff7380' },
  { type: 'INTERCHANGE_RAMP', label: 'Interchange Ramps', display: 'Interchange Ramp', color: '#ffe66d' },
  { type: 'INTERCHANGE_CONNECTOR', label: 'Freeway Connectors', display: 'Freeway Connector', color: '#f38ed8' },
  { type: 'EXPRESS_CONNECTOR', label: 'Express Connectors', display: 'Express Connector', color: '#f0f5ff' },
];

// Labels only: feature membership always comes from the source interchange property.
const INTERCHANGE_LABELS = {
  WESTERN_I75_SAWGRASS: 'Western I-75 / Sawgrass', SW_136TH_AVE: 'SW 136th Avenue',
  FLAMINGO_RD: 'Flamingo Road', HIATUS_RD: 'Hiatus Road', NOB_HILL_RD: 'Nob Hill Road',
  PINE_ISLAND_RD: 'Pine Island Road', UNIVERSITY_DR: 'University Drive', DAVIE_RD: 'Davie Road',
  FLORIDAS_TURNPIKE: "Florida's Turnpike", SR7_US441: 'SR-7 / US-441', I95: 'I-95',
};
export const knownValue = value => value == null || String(value).trim() === '' || String(value).toUpperCase() === 'UNKNOWN' ? 'Unknown' : String(value);
export const interchangeLabel = value => INTERCHANGE_LABELS[value] || knownValue(value);
export const rampDisplayType = type => RAMP_CATEGORIES.find(category => category.type === type)?.display || 'Unknown';

/** @returns {I595Ramp} */
export function rampFromProperties(p) {
  const id = p.osm_way_id || p['@id'];
  if (!id || !RAMP_CATEGORIES.some(category => category.type === p.ramp_type)) {
    throw new Error('Ramp is missing a stable source ID or recognized ramp_type.');
  }
  return {
    id: String(id), rampType: p.ramp_type, direction: knownValue(p.direction),
    fromRoad: knownValue(p.from_road), toRoad: knownValue(p.to_road),
    interchange: knownValue(p.interchange && p.interchange !== 'UNKNOWN' ? p.interchange : p.interchange_group),
    elevated: typeof p.elevated === 'boolean' ? p.elevated : undefined,
    structureType: knownValue(p.structure_type), structureConfidence: knownValue(p.structure_confidence),
    functionConfidence: knownValue(p.function_confidence), connectedFacility: knownValue(p.connected_facility),
    osmWayId: String(id), source: knownValue(p.source),
  };
}

/** Only explicitly allowlisted source values are presented to the user. */
export function rampDetails(ramp) {
  const showStructure = ramp.elevated === true
    && ['MEDIUM', 'HIGH'].includes(ramp.structureConfidence)
    && !['Unknown', 'AT_GRADE_OR_UNKNOWN'].includes(knownValue(ramp.structureType));
  const facilityLabels = { I595_GP_EB: 'I-595 EB', I595_GP_WB: 'I-595 WB', I595_NETWORK: 'I-595 network', I595_EXPRESS: '595 Express' };
  return [
    ['Ramp Type', rampDisplayType(ramp.rampType)], ['Direction', ramp.direction],
    ['From', ramp.fromRoad], ['To', ramp.toRoad], ['Interchange', interchangeLabel(ramp.interchange)],
    ...(showStructure ? [['Elevated', 'Yes'], ['Structure', ramp.structureType]] : []),
    ['Connected Facility', facilityLabels[ramp.connectedFacility] || ramp.connectedFacility],
    ['Source', ramp.source === 'OpenStreetMap / Overpass' ? 'OpenStreetMap' : ramp.source],
  ];
}

export function matchesRamp(ramp, enabledTypes, interchange) {
  return enabledTypes.has(ramp.rampType) && (!interchange || ramp.interchange === interchange);
}
