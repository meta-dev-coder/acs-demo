/**
 * Asset type registry — what the explorer knows about each dataset.
 *
 * Adding a corridor asset type should mean adding an entry here plus a source that feeds normalized
 * records into the store. It should not mean another carousel, another card, another details panel.
 *
 * Every accessor is defensive about missing source fields on purpose: these datasets are FDOT
 * extracts and a live feed, and they genuinely disagree about which fields exist. A field that is
 * absent is reported as absent — nothing here invents a value to fill a row.
 */
import { corridorPositionOf } from './corridorPosition.js';

/** Framing for the close inspection view, per type. Replaces per-layer magic numbers. */
export const ASSET_CAMERA_PRESETS = Object.freeze({
  // An overhead gantry is read from slightly below its own height, looking along the road.
  gantry: Object.freeze({ rangeM: 78, pitchDeg: -16, useModelHeading: true }),
  // A camera is a small object on a pole: closer, and a little steeper to see what it overlooks.
  camera: Object.freeze({ rangeM: 46, pitchDeg: -22 }),
  // A bridge is an extended structure, so its span drives the distance rather than a fixed range.
  // The multiplier is generous on purpose: Cesium's default range just fits a sphere head-on, and
  // at a -28° pitch that leaves the far end of a long span off screen.
  bridge: Object.freeze({ rangeM: 220, pitchDeg: -28, useGeometryExtent: true, extentMultiplier: 3.6 }),
});

/** A moderate look at a selection — deliberately gentler than an inspection. */
export const SELECTION_FOCUS = Object.freeze({ rangeM: 420, pitchDeg: -35 });

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string && string.toUpperCase() !== 'N/A' ? string : null;
};
const number = value => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

/** Midpoint of a bridge's begin/end posts; either post alone if only one is present. */
export function bridgeMilepost(properties) {
  const begin = number(properties?.begin_post), end = number(properties?.end_post);
  if (begin != null && end != null) return (begin + end) / 2;
  return begin ?? end;
}

export const ASSET_TYPES = Object.freeze({
  gantry: Object.freeze({
    id: 'gantry',
    label: 'Toll Gantries',
    singular: 'Gantry',
    detailsTitle: 'Toll Gantry Details',
    icon: 'gantry',
    /** The Map Explorer layer that turns this dataset on. */
    layerId: 'gantries',
    emptyMessage: 'No toll gantries are available in the current dataset.',
    errorMessage: 'Unable to load toll gantries.',
    getTitle: asset => asset.name,
    getSubtitle: asset => positionLabel(asset) ?? text(asset.source?.layerLabel),
    getStatus: asset => (asset.source?.enabled === false ? { label: 'Disabled', tone: 'muted' } : { label: 'Placed', tone: 'ok' }),
    /**
     * Rows for the details panel. Only what the record actually carries — a gantry record has a
     * measured heading and a placement, and no operational status, so none is claimed.
     */
    details: asset => [
      ['Gantry', text(asset.name)],
      ['Corridor position', asset.corridorMiles == null ? null : `${asset.corridorMiles.toFixed(2)} mi along corridor`],
      ['Latitude', asset.coordinates ? asset.coordinates.latitude.toFixed(6) : null],
      ['Longitude', asset.coordinates ? asset.coordinates.longitude.toFixed(6) : null],
      ['Heading', number(asset.source?.heading) == null ? null : `${Number(asset.source.heading).toFixed(1)}°`],
      ['Model', text(asset.source?.modelKey)],
      ['Layer', text(asset.source?.layerLabel)],
    ],
  }),

  camera: Object.freeze({
    id: 'camera',
    label: 'Traffic Cameras',
    singular: 'Camera',
    detailsTitle: 'CCTV Camera Details',
    icon: 'camera',
    layerId: 'cameras',
    // Cameras keep their existing details panel. It carries the live snapshot image and the Street
    // View action, which are real capabilities rather than a different rendering of the same
    // fields — replacing it with a generic field list would be a downgrade dressed as consistency.
    // Selection still flows through the one shared mechanism; only the panel differs.
    legacyDetailsPanel: true,
    emptyMessage: 'No traffic cameras are available in the current dataset.',
    errorMessage: 'Unable to load traffic cameras.',
    getTitle: asset => asset.name,
    // The camera dataset has no milepost field — only a prose description like "I-595 ~MP 8.5".
    // Shown verbatim, approximation and all, rather than parsed into a number it does not claim.
    getSubtitle: asset => text(asset.source?.description) ?? positionLabel(asset),
    // The dataset's `video_enabled` flag does not reflect what the corridor actually serves — the
    // feeds it marks as available are not playable — so no operational status is claimed on the
    // card. An unverified "Video available" is worse than saying nothing, because an operator
    // would act on it. The raw flag stays visible in the details panel as source data.
    getStatus: () => null,
    details: asset => [
      ['Camera ID', text(asset.source?.camera_id)],
      ['Description', text(asset.source?.description)],
      ['Direction', text(asset.source?.direction)],
      ['Distance to I-595', number(asset.source?.distance_to_i595_network_m) == null
        ? null : `${Number(asset.source.distance_to_i595_network_m).toFixed(1)} m`],
      ['Express camera', asset.source?.is_express_camera === true ? 'Yes' : null],
      // Reported as the dataset's own field, not as a promise that a feed will play.
      ['Video flag (source data)', asset.source?.video_enabled === true ? 'Enabled' : null],
      ['Latitude', asset.coordinates ? asset.coordinates.latitude.toFixed(6) : null],
      ['Longitude', asset.coordinates ? asset.coordinates.longitude.toFixed(6) : null],
    ],
  }),

  bridge: Object.freeze({
    id: 'bridge',
    label: 'Bridges',
    singular: 'Bridge',
    detailsTitle: 'Bridge Details',
    icon: 'bridge',
    layerId: 'structures',
    emptyMessage: 'No bridges are available in the current dataset.',
    errorMessage: 'Unable to load bridges.',
    getTitle: asset => asset.name,
    getSubtitle: asset => positionLabel(asset),
    getStatus: asset => {
      const side = text(asset.source?.road_side);
      return side ? { label: `Road side ${side}`, tone: 'muted' } : null;
    },
    details: asset => [
      ['Bridge', text(asset.name)],
      ['Structure ID', text(asset.source?.structureId ?? asset.source?.structure_id)],
      ['Begin post', number(asset.source?.begin_post) == null ? null : Number(asset.source.begin_post).toFixed(3)],
      ['End post', number(asset.source?.end_post) == null ? null : Number(asset.source.end_post).toFixed(3)],
      ['Road side', text(asset.source?.road_side)],
      ['Roadway', text(asset.source?.roadway)],
      ['Length', number(asset.source?.shape_length_m) == null
        ? null : `${Number(asset.source.shape_length_m).toFixed(1)} m`],
      ['County', text(asset.source?.county)],
      ['Source', text(asset.source?.source)],
    ],
  }),

  laneBarrier: Object.freeze({
    id: 'laneBarrier',
    label: 'Lane Barriers',
    singular: 'Barrier',
    detailsTitle: 'Lane Barrier Details',
    icon: 'gantry',
    layerId: 'lane-barriers',
    emptyMessage: 'No lane barriers are available in the current dataset.',
    errorMessage: 'Unable to load lane barriers.',
    getTitle: asset => asset.name,
    getSubtitle: asset => positionLabel(asset) ?? text(asset.source?.layerLabel),
    getStatus: asset => (asset.source?.enabled === false ? { label: 'Disabled', tone: 'muted' } : { label: 'Placed', tone: 'ok' }),
    details: asset => [
      ['Barrier', text(asset.name)],
      ['Corridor position', asset.corridorMiles == null ? null : `${asset.corridorMiles.toFixed(2)} mi along corridor`],
      ['Latitude', asset.coordinates ? asset.coordinates.latitude.toFixed(6) : null],
      ['Longitude', asset.coordinates ? asset.coordinates.longitude.toFixed(6) : null],
      ['Heading', number(asset.source?.heading) == null ? null : `${Number(asset.source.heading).toFixed(1)}°`],
      ['Model', text(asset.source?.modelKey)],
    ],
  }),

  signal: Object.freeze({
    id: 'signal',
    label: 'Traffic Signals',
    singular: 'Signal',
    icon: 'signal',
    layerId: 'signals',
    // Keeps its own panel: it already presents these records, and replacing it would gain nothing.
    legacyDetailsPanel: true,
    emptyMessage: 'No traffic signals are available in the current dataset.',
    errorMessage: 'Unable to load traffic signals.',
    getTitle: asset => asset.name,
    // The title already names the cross street, so the subtitle carries position instead of
    // repeating it back.
    getSubtitle: asset => positionLabel(asset) ?? text(asset.source?.signal_type),
    getStatus: asset => {
      const status = text(asset.source?.section_status);
      return status ? { label: status, tone: 'muted' } : null;
    },
    details: asset => [
      ['Signal ID', text(asset.source?.signal_id)],
      ['Cross street', text(asset.source?.cross_street)],
      ['Type', text(asset.source?.signal_type)],
    ],
  }),

  incident: Object.freeze({
    id: 'incident',
    label: 'Incidents',
    singular: 'Incident',
    icon: 'incident',
    layerId: 'incidents',
    // Its panel carries provenance and source rows the generic one does not reproduce.
    legacyDetailsPanel: true,
    emptyMessage: 'No incidents are reported on the corridor right now.',
    errorMessage: 'Unable to load incidents.',
    getTitle: asset => asset.name,
    getSubtitle: asset => text(asset.source?.roadway) ?? positionLabel(asset),
    getStatus: asset => {
      const severity = text(asset.source?.severity);
      return severity ? { label: severity, tone: 'warn' } : null;
    },
    details: asset => [
      ['Roadway', text(asset.source?.roadway)],
      ['Severity', text(asset.source?.severity)],
      ['Status', text(asset.source?.status)],
    ],
  }),

  closure: Object.freeze({
    id: 'closure',
    label: 'Closures',
    singular: 'Closure',
    icon: 'closure',
    layerId: 'closures',
    legacyDetailsPanel: true,
    emptyMessage: 'No closures are reported on the corridor right now.',
    errorMessage: 'Unable to load closures.',
    getTitle: asset => asset.name,
    getSubtitle: asset => text(asset.source?.roadway) ?? positionLabel(asset),
    getStatus: asset => {
      const status = text(asset.source?.status);
      return status ? { label: status, tone: 'warn' } : null;
    },
    details: asset => [
      ['Roadway', text(asset.source?.roadway)],
      ['Direction', text(asset.source?.direction)],
      ['Status', text(asset.source?.status)],
    ],
  }),

  overlane: Object.freeze({
    id: 'overlane',
    label: 'Overlane Structures',
    singular: 'Structure',
    detailsTitle: 'Overlane Structure Details',
    icon: 'gantry',
    layerId: 'overlane',
    // Keeps the sign-structure panel it already has.
    legacyDetailsPanel: true,
    emptyMessage: 'No overlane structures are available in the current dataset.',
    errorMessage: 'Unable to load overlane structures.',
    getTitle: asset => asset.name,
    getSubtitle: asset => positionLabel(asset),
    getStatus: asset => {
      const kind = text(asset.source?.structureType);
      return kind ? { label: kind, tone: 'muted' } : null;
    },
    details: asset => [
      ['Structure', text(asset.source?.id)],
      ['Type', text(asset.source?.structureType)],
      ['Milepost', number(asset.source?.milepost) == null ? null : Number(asset.source.milepost).toFixed(2)],
      ['Roadway', text(asset.source?.roadwayId)],
      ['HLID', text(asset.source?.hlid)],
    ],
  }),

  cantilever: Object.freeze({
    id: 'cantilever',
    label: 'Cantilever Structures',
    singular: 'Structure',
    detailsTitle: 'Cantilever Structure Details',
    icon: 'gantry',
    layerId: 'cantilever',
    // Keeps the sign-structure panel it already has.
    legacyDetailsPanel: true,
    emptyMessage: 'No cantilever structures are available in the current dataset.',
    errorMessage: 'Unable to load cantilever structures.',
    getTitle: asset => asset.name,
    getSubtitle: asset => positionLabel(asset),
    getStatus: asset => {
      const kind = text(asset.source?.structureType);
      return kind ? { label: kind, tone: 'muted' } : null;
    },
    details: asset => [
      ['Structure', text(asset.source?.id)],
      ['Type', text(asset.source?.structureType)],
      ['Milepost', number(asset.source?.milepost) == null ? null : Number(asset.source.milepost).toFixed(2)],
      ['Roadway', text(asset.source?.roadwayId)],
      ['HLID', text(asset.source?.hlid)],
    ],
  }),

  unclassified: Object.freeze({
    id: 'unclassified',
    label: 'Unclassified Structures',
    singular: 'Structure',
    detailsTitle: 'Structure Details',
    icon: 'gantry',
    layerId: 'unclassified',
    // Keeps the sign-structure panel it already has.
    legacyDetailsPanel: true,
    emptyMessage: 'No unclassified structures are available in the current dataset.',
    errorMessage: 'Unable to load unclassified structures.',
    getTitle: asset => asset.name,
    getSubtitle: asset => positionLabel(asset),
    getStatus: asset => {
      const kind = text(asset.source?.structureType);
      return kind ? { label: kind, tone: 'muted' } : null;
    },
    details: asset => [
      ['Structure', text(asset.source?.id)],
      ['Type', text(asset.source?.structureType)],
      ['Milepost', number(asset.source?.milepost) == null ? null : Number(asset.source.milepost).toFixed(2)],
      ['Roadway', text(asset.source?.roadwayId)],
      ['HLID', text(asset.source?.hlid)],
    ],
  }),
});

export const assetTypeConfig = type => ASSET_TYPES[type] ?? null;

/** Rows a details panel should render: the configured pairs, minus everything absent. */
export function detailRows(asset) {
  const config = asset ? assetTypeConfig(asset.assetType) : null;
  if (!config) return [];
  return config.details(asset).filter(([, value]) => text(value) !== null).map(([label, value]) => [label, String(value)]);
}

/**
 * Normalize a source record into the shape every surface consumes. `source` is kept whole, because
 * the details panel legitimately needs fields the normal shape does not carry.
 *
 * @param {object} input
 * @param {{lon: number, lat: number}[]} [centerline] used to place assets with no milepost field
 */
export function normalizeAsset({ id, assetType, name, longitude, latitude, milepost, geometry, source },
  centerline, distances) {
  const coordinates = Number.isFinite(longitude) && Number.isFinite(latitude)
    ? Object.freeze({ longitude, latitude }) : null;
  // Two different measurements, deliberately never merged. `milepost` is FDOT's, and only exists
  // where the dataset publishes one. `corridorMiles` is measured along our own centerline geometry.
  // They are NOT the same scale: checked against the bridge dataset, the measured distance runs
  // about 3.0 miles ahead of the published milepost (spread 0.41 mi), because FDOT's mileposts do
  // not originate at the west end of this centerline. Printing one as the other would invent
  // precision, so the UI labels them differently and the rail positions by fraction, not by miles.
  const position = coordinates && centerline?.length
    ? corridorPositionOf(coordinates.longitude, coordinates.latitude, centerline, distances)
    : { milepost: null, offsetM: null, fraction: null };
  return Object.freeze({
    id: String(id),
    assetType,
    name: text(name) ?? String(id),
    coordinates,
    geometry: geometry ?? null,
    /** FDOT milepost, or null when the dataset does not publish one. Never derived. */
    milepost: number(milepost),
    /** Distance along the corridor centerline, in miles. Geometry, not an FDOT milepost. */
    corridorMiles: position.milepost,
    /** 0..1 along the corridor — what the position rail lays out with. */
    corridorFraction: position.fraction,
    /** How far off the centerline the asset sits; large values mean the projection means little. */
    corridorOffsetM: position.offsetM,
    source: source ?? null,
  });
}

/** The corridor position to show, labelled for whichever measurement it actually is. */
export function positionLabel(asset) {
  if (asset?.milepost != null) return `MP ${asset.milepost.toFixed(1)}`;
  if (asset?.corridorMiles != null) return `${asset.corridorMiles.toFixed(1)} mi along corridor`;
  return null;
}
