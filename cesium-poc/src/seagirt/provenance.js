/**
 * Where each fact about an asset comes from, in four separate dimensions, so one "synthetic" tag
 * never hides the differences: what the asset IS (identity), WHERE it is (location), WHAT it
 * connects to (topology), and its CONDITION and maintenance records.
 *
 * A public GIS feature does not verify an asset: an OpenStreetMap footprint can be a CANDIDATE
 * location for an illustrative substation, and stays a candidate until an authoritative source
 * (drawing, single-line diagram, asset register) confirms it.
 */

export const IDENTITY = Object.freeze({ VERIFIED: 'Verified', PUBLICLY_MAPPED: 'Publicly mapped', ILLUSTRATIVE: 'Illustrative' });
export const LOCATION = Object.freeze({
  SURVEYED: 'Surveyed', PUBLIC_GIS: 'Public GIS', CANDIDATE_ASSOCIATION: 'Candidate association', ILLUSTRATIVE: 'Illustrative',
  IN_CONTAINER: 'Inside its switchgear', SCHEMATIC: 'Schematic segment', NONE: 'Not recorded',
});
export const TOPOLOGY = Object.freeze({ VERIFIED: 'Verified', IMPORTED_MODEL: 'Imported engineering model', ILLUSTRATIVE: 'Illustrative' });
export const RECORDS = Object.freeze({ CONNECTED_SYSTEM: 'Connected system', IMPORTED_RECORD: 'Imported record', SYNTHETIC_DEMO: 'Synthetic demonstration', NONE: 'None recorded' });

const VERIFIED_SOURCES = new Set(['VERIFIED_SURVEY', 'VERIFIED_DRAWING']);

/**
 * @param {object} asset            a registry record
 * @param {object[]} [associations] GIS associations (`gis-associations.json`)
 * @param {object[]} [records]      inspection / maintenance records
 * @returns {{ identity, location, topology, records, association, locationNote, summary }}
 */
export function assetProvenance(asset, { associations = [], records = [] } = {}) {
  const verified = asset.verificationStatus === 'VERIFIED' || VERIFIED_SOURCES.has(asset.dataProvenance);
  const synthetic = asset.dataProvenance === 'SYNTHETIC_DEMO';
  // An imported model that says of itself it is illustrative (the IFC's DataStatus) is not a public record.
  const illustrative = synthetic || asset.illustrative === true;
  const association = associations.find(a => a.electricalAssetId === asset.id) ?? null;
  const hasPoint = Number.isFinite(asset.location?.longitude);
  const location = !hasPoint
    ? asset.location?.containerAssetId ? 'IN_CONTAINER' : asset.assetType === 'FEEDER' ? 'SCHEMATIC' : 'NONE'
    : asset.dataProvenance === 'VERIFIED_SURVEY' ? 'SURVEYED'
      : asset.dataProvenance === 'IMPORTED_GIS' ? 'PUBLIC_GIS'
        : association && !association.verified ? 'CANDIDATE_ASSOCIATION' : 'ILLUSTRATIVE';
  const own = records.filter(r => r.assetId === asset.id);
  const recordSource = own.length
    ? own.every(r => r.dataProvenance === 'SYNTHETIC_DEMO') ? 'SYNTHETIC_DEMO' : 'IMPORTED_RECORD'
    : asset.lastInspectionDate ? (synthetic ? 'SYNTHETIC_DEMO' : 'IMPORTED_RECORD') : 'NONE';
  const locationNote = location === 'CANDIDATE_ASSOCIATION'
    ? `Illustrative position; a mapped OpenStreetMap substation ${association.distanceM} m away is a candidate match (unverified).`
    : location === 'IN_CONTAINER' ? `Inside ${asset.location.containerAssetId}${asset.location.cubicle ? `, cubicle ${asset.location.cubicle}` : ''}; no map position of its own.`
      : location === 'SCHEMATIC' ? 'No cable route is recorded; drawn as a schematic segment between its equipment.'
        : location === 'ILLUSTRATIVE' ? 'Illustrative position, not a surveyed location.'
          : location === 'NONE' ? 'No position recorded.' : LOCATION[location];
  const out = {
    identity: verified ? 'VERIFIED' : illustrative ? 'ILLUSTRATIVE' : 'PUBLICLY_MAPPED',
    location,
    topology: verified ? 'VERIFIED' : synthetic ? 'ILLUSTRATIVE' : 'IMPORTED_MODEL',
    records: recordSource,
    association,
    locationNote,
  };
  out.summary = `Identity ${IDENTITY[out.identity].toLowerCase()} · location ${LOCATION[out.location].toLowerCase()} · topology ${TOPOLOGY[out.topology].toLowerCase()} · records ${RECORDS[out.records].toLowerCase()}`;
  return out;
}

/** The provenance of a whole answer: the weakest of each dimension over the assets it is about. */
export function answerProvenance(assets, opts) {
  const rows = assets.map(a => assetProvenance(a, opts));
  const pick = (key, order) => order.find(v => rows.some(r => r[key] === v)) ?? null;
  return {
    identity: pick('identity', ['ILLUSTRATIVE', 'PUBLICLY_MAPPED', 'VERIFIED']),
    location: pick('location', ['ILLUSTRATIVE', 'CANDIDATE_ASSOCIATION', 'SCHEMATIC', 'IN_CONTAINER', 'NONE', 'PUBLIC_GIS', 'SURVEYED']),
    topology: pick('topology', ['ILLUSTRATIVE', 'IMPORTED_MODEL', 'VERIFIED']),
    records: pick('records', ['SYNTHETIC_DEMO', 'IMPORTED_RECORD', 'CONNECTED_SYSTEM', 'NONE']),
    candidateAssociations: rows.filter(r => r.association && !r.association.verified).map(r => r.association.electricalAssetId),
  };
}
