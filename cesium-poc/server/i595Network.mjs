/**
 * Corridor geometry for spatial filtering, read from the GeoJSON the map already ships — the
 * I-595 network is never redefined here. Everything this module produces is *derived* association:
 * a nearest facility is what our own geometry says, never a claim about what FL511 reported.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { distanceToPolylineMeters, lineStringsOf } from './geo.mjs';

/** @typedef {'I595_EB'|'I595_WB'|'I595_EXPRESS'|'SR84_EB'|'SR84_WB'|'RAMP_CONNECTOR'} NearestFacility */

export const FACILITY_LABELS = Object.freeze({
  I595_EB: 'I-595 Eastbound',
  I595_WB: 'I-595 Westbound',
  I595_EXPRESS: '595 Express',
  SR84_EB: 'SR 84 Eastbound',
  SR84_WB: 'SR 84 Westbound',
  RAMP_CONNECTOR: 'I-595 Ramp / Connector',
});

// Each source file already carries the facility identity the explorer uses; `facility` maps a
// feature's own properties onto it so directional files stay directional.
const SOURCES = [
  { file: 'i595_mainline_eb.geojson', facility: () => 'I595_EB' },
  { file: 'i595_mainline_wb.geojson', facility: () => 'I595_WB' },
  { file: 'express-way.geojson', facility: () => 'I595_EXPRESS' },
  { file: 'sr84_frontage_roads.geojson', facility: p => p.direction === 'EB' ? 'SR84_EB' : p.direction === 'WB' ? 'SR84_WB' : null },
  // Only ramps whose I-595 connection was topology-confirmed count as corridor network.
  { file: 'i595_ramps_connectors_classified.geojson', facility: p => p.validation === 'TOPOLOGY_CONFIRMED' ? 'RAMP_CONNECTOR' : null },
];

const readGeoJson = async (dataDir, file) => JSON.parse(await readFile(join(dataDir, file), 'utf8'));

/**
 * Load the corridor once at startup. Returns a network object whose `associate` is a pure
 * function of a point, so callers can be tested against a hand-built network too.
 */
export async function loadI595Network(dataDir) {
  const lines = [];
  for (const source of SOURCES) {
    const data = await readGeoJson(dataDir, source.file);
    for (const feature of data.features ?? []) {
      const facility = source.facility(feature.properties ?? {});
      if (!facility) continue;
      for (const coordinates of lineStringsOf(feature.geometry)) {
        if (coordinates.length > 1) lines.push({ facility, coordinates });
      }
    }
  }
  if (lines.length === 0) throw new Error('I-595 network geometry is empty; corridor filtering would drop every event.');

  const segmentData = await readGeoJson(dataDir, 'i595_fdot_traffic_segments.geojson');
  const segments = [];
  for (const feature of segmentData.features ?? []) {
    const p = feature.properties ?? {};
    for (const coordinates of lineStringsOf(feature.geometry)) {
      if (p.segment_id && coordinates.length > 1) {
        segments.push({
          segmentId: String(p.segment_id), direction: p.direction,
          index: p.fdot_segment_index, descriptionFrom: p.desc_from, descriptionTo: p.desc_to, coordinates,
        });
      }
    }
  }
  return createNetwork(lines, segments);
}

/** @param {{facility: NearestFacility, coordinates: number[][]}[]} lines */
export function createNetwork(lines, segments = []) {
  return {
    lines, segments,
    facilityCount: new Set(lines.map(line => line.facility)).size,
    /**
     * Nearest network geometry to a point. `distanceToNetworkM` decides corridor relevance;
     * the facility and segment fields are spatial inferences and are labelled as such upstream.
     */
    associate(longitude, latitude, { segmentToleranceMeters = Infinity } = {}) {
      let distanceToNetworkM = Infinity, nearestFacility = null;
      for (const line of lines) {
        const distance = distanceToPolylineMeters(longitude, latitude, line.coordinates);
        if (distance < distanceToNetworkM) { distanceToNetworkM = distance; nearestFacility = line.facility; }
      }
      let distanceToSegmentM = Infinity, nearestSegment = null;
      for (const segment of segments) {
        const distance = distanceToPolylineMeters(longitude, latitude, segment.coordinates);
        if (distance < distanceToSegmentM) { distanceToSegmentM = distance; nearestSegment = segment; }
      }
      // Beyond tolerance the event belongs to no FDOT traffic section — SR 84, ramp and
      // interchange events legitimately have none, and forcing one would invent an association.
      const withinTolerance = nearestSegment && distanceToSegmentM <= segmentToleranceMeters;
      return {
        distanceToNetworkM: Number.isFinite(distanceToNetworkM) ? distanceToNetworkM : null,
        nearestFacility,
        distanceToNearestFacilityM: Number.isFinite(distanceToNetworkM) ? distanceToNetworkM : null,
        nearestSegmentId: withinTolerance ? nearestSegment.segmentId : null,
        nearestSegmentLabel: withinTolerance ? segmentLabel(nearestSegment) : null,
        distanceToSegmentM: withinTolerance ? distanceToSegmentM : null,
      };
    },
  };
}

const segmentLabel = segment => Number.isFinite(segment.index)
  ? `${segment.direction === 'WB' ? 'Westbound' : 'Eastbound'} Segment ${segment.index}`
  : segment.segmentId;
