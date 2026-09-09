/**
 * @typedef {object} RoadSegment
 * @property {string} segmentId
 * @property {string} road
 * @property {string} facility
 * @property {'EB'|'WB'} direction
 * @property {string} fdotRoadway
 * @property {number} fdotSegmentIndex
 * @property {number} travelOrder
 * @property {number} beginPost
 * @property {number} endPost
 * @property {string} [descriptionFrom]
 * @property {string} [descriptionTo]
 * @property {number} [aadt]
 * @property {number} [aadtYear]
 * @property {string} [cosite]
 *
 * @typedef {object} RoadSegmentStatus
 * @property {string} segmentId
 * @property {string} [timestamp]
 * @property {number} [averageSpeedMph]
 * @property {number} [volume]
 * @property {number} [density]
 * @property {number} [travelTimeMinutes]
 * @property {'FREE_FLOW'|'MODERATE'|'HEAVY'|'SEVERE'} [congestionLevel]
 * @property {number} [incidentCount]
 * @property {'OPEN'|'PARTIAL'|'CLOSED'} [closureState]
 * @property {string} [scenarioImpact]
 */

export const MAINLINE_COLORS = { EB: '#52dcf5', WB: '#c49aff' };
export const segmentDirectionLabel = direction => direction === 'EB' ? 'Eastbound' : direction === 'WB' ? 'Westbound' : 'Unknown';
export const formatMilepost = value => Number.isFinite(value) ? value.toFixed(3) : 'Unknown';
export const formatAadt = value => Number.isFinite(value) ? `${value.toLocaleString('en-US')} vehicles/day` : 'Unknown';

/** Immutable static metadata; live/simulated state belongs in a separate map. @returns {Readonly<RoadSegment>} */
export function roadSegmentFromProperties(p) {
  if (!p.segment_id || !['EB', 'WB'].includes(p.direction)
    || !Number.isFinite(p.begin_post) || !Number.isFinite(p.end_post) || p.begin_post > p.end_post) {
    throw new Error('Invalid FDOT road segment identity, direction or mileposts.');
  }
  return Object.freeze({
    segmentId: String(p.segment_id), road: p.road, facility: p.facility, direction: p.direction,
    fdotRoadway: String(p.fdot_roadway), fdotSegmentIndex: p.fdot_segment_index, travelOrder: p.travel_order,
    beginPost: p.begin_post, endPost: p.end_post, descriptionFrom: p.desc_from, descriptionTo: p.desc_to,
    aadt: p.aadt, aadtYear: p.aadt_year, cosite: p.cosite == null ? undefined : String(p.cosite),
  });
}
export function roadSegmentDetails(segment, sectionCount = 8) {
  return [
    ['Road', segment.road], ['Direction', segmentDirectionLabel(segment.direction)],
    ['FDOT Roadway', segment.fdotRoadway],
    ['FDOT Section', `${segment.fdotSegmentIndex} of ${sectionCount}`],
    ['Milepost', `${formatMilepost(segment.beginPost)} – ${formatMilepost(segment.endPost)}`],
    ['From', segment.descriptionFrom ?? 'Unknown'], ['To', segment.descriptionTo ?? 'Unknown'],
    ['AADT', formatAadt(segment.aadt)], ['AADT Year', segment.aadtYear == null ? 'Unknown' : String(segment.aadtYear)],
  ];
}
export function roadSegmentTooltip(segment) {
  return `${segment.road} ${segmentDirectionLabel(segment.direction)}\nMP ${formatMilepost(segment.beginPost)} – ${formatMilepost(segment.endPost)}`;
}
