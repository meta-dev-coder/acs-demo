/**
 * 595 Express (I-595 reversible managed lanes) presentation data.
 *
 * Every field comes from the FDOT properties already carried in express-way.geojson — nothing
 * about the lanes is inferred, and the operational direction is reported as reversible rather than
 * resolved to a compass direction the source does not claim.
 */
import { formatMilepost } from './i595RoadSegmentData.js';

/** Matches the "--road" swatch already set on the 595 Express label in the layer tree. */
export const EXPRESS_COLOR = '#ffba62';

/**
 * @typedef {object} ExpressLanes
 * @property {string} laneId
 * @property {string} road
 * @property {string} facility
 * @property {string} direction
 * @property {string} fdotRoadway
 * @property {number} beginPost
 * @property {number} endPost
 * @property {string} source
 * @property {string|null} note
 */

/** @returns {Readonly<ExpressLanes>} */
export function expressFromProperties(p) {
  if (!p?.id || !Number.isFinite(p.begin_post) || !Number.isFinite(p.end_post) || p.begin_post > p.end_post) {
    throw new Error('Invalid 595 Express identity or mileposts.');
  }
  return Object.freeze({
    laneId: String(p.id), road: p.road || 'I-595', facility: p.facility, direction: p.direction,
    fdotRoadway: p.roadway == null ? 'Unknown' : String(p.roadway),
    beginPost: p.begin_post, endPost: p.end_post,
    source: p.source || 'Unknown', note: p.note ?? null,
  });
}

export const expressFacilityLabel = facility => facility === 'express_reversible' ? 'Express (reversible managed lanes)' : facility || 'Unknown';
export const expressDirectionLabel = direction => direction === 'REVERSIBLE' ? 'Reversible' : direction || 'Unknown';
export const expressName = () => '595 Express';

export function expressDetails(lanes) {
  return [
    ['Road', lanes.road],
    ['Facility', expressFacilityLabel(lanes.facility)],
    ['Direction', expressDirectionLabel(lanes.direction)],
    ['FDOT Roadway', lanes.fdotRoadway],
    ['Milepost', `${formatMilepost(lanes.beginPost)} – ${formatMilepost(lanes.endPost)}`],
    ['Length', `${formatMilepost(lanes.endPost - lanes.beginPost)} mi`],
    ['Source', lanes.source],
    ['Note', lanes.note],
  ].filter(([, value]) => value != null && String(value).trim() !== '');
}

export function expressTooltip(lanes) {
  return `595 Express\n${expressDirectionLabel(lanes.direction)} · MP ${formatMilepost(lanes.beginPost)} – ${formatMilepost(lanes.endPost)}`;
}
