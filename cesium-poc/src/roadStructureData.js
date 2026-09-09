import { formatMilepost } from './i595RoadSegmentData.js';

/**
 * @typedef {'bridge'|'sign_structure'|'gantry'|'overpass'} StructureType
 * @typedef {object} RoadStructure
 * @property {string} assetId
 * @property {StructureType} assetType
 * @property {string} structureId
 * @property {string} displayName
 * @property {string} roadway
 * @property {string} roadSide
 * @property {number} beginPost
 * @property {number} endPost
 * @property {string} district
 * @property {string} county
 * @property {number} lengthM
 * @property {string} source
 * @property {string} corridor
 */
/** @returns {Readonly<RoadStructure>} */
export function roadStructureFromProperties(p) {
  if (!p.asset_id || !p.structure_id || !Number.isFinite(p.begin_post) || !Number.isFinite(p.end_post) || p.begin_post > p.end_post) throw new Error('Invalid structure identity or mileposts.');
  return Object.freeze({
    assetId: String(p.asset_id), assetType: p.asset_type, structureId: String(p.structure_id),
    displayName: p.display_name, roadway: String(p.roadway), roadSide: p.road_side,
    beginPost: p.begin_post, endPost: p.end_post, district: p.district, county: p.county,
    lengthM: p.shape_length_m, source: p.source, corridor: p.corridor,
  });
}
/** Road side never implies a travel direction. Link to every overlapping directional section. */
export function structureOverlapsSegment(structure, segment) {
  return structure.roadway === segment.fdotRoadway
    && structure.beginPost <= segment.endPost && structure.endPost >= segment.beginPost;
}
export function structureTooltip(structure) {
  return `${structure.displayName}\nMP ${formatMilepost(structure.beginPost)} – ${formatMilepost(structure.endPost)}\nFDOT Road Side: ${structure.roadSide ?? 'Unknown'}${structure.locationCount > 1 ? `\n${structure.locationCount} structures at this location` : ''}`;
}
export function bridgeDetails(structure, segments = []) {
  // Display each official section once; the relationship retains both directional entities.
  const sections = [...new Map(segments.map(segment => [segment.fdotSegmentIndex, segment])).values()]
    .sort((a, b) => a.fdotSegmentIndex - b.fdotSegmentIndex);
  return [
    ['Structure ID', structure.structureId], ['Road', structure.corridor], ['FDOT Roadway', structure.roadway],
    ['Milepost', `${formatMilepost(structure.beginPost)} – ${formatMilepost(structure.endPost)}`],
    ['FDOT Road Side', structure.roadSide ?? 'Unknown'], ['County', structure.county ?? 'Unknown'],
    ['District', String(structure.district ?? 'Unknown')], ['Length', Number.isFinite(structure.lengthM) ? `${structure.lengthM.toFixed(1)} m` : 'Unknown'],
    ['Source', structure.source === 'FDOT RCI Bridges' ? 'FDOT RCI' : structure.source],
    ...(sections.length ? [['FDOT Traffic Sections', sections.map(segment => `Segment ${segment.fdotSegmentIndex} · MP ${formatMilepost(segment.beginPost)}–${formatMilepost(segment.endPost)}`).join('\n')]] : []),
  ];
}
