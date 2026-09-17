/**
 * Web Mercator maths for the mini-map.
 *
 * The mini-map draws raster map tiles, so its projection has to be the tiles' own — a plain
 * lon/lat stretch would put the corridor line and the markers slightly off the roads underneath
 * them, which is exactly the kind of small wrongness that makes a map feel untrustworthy.
 *
 * Pure, and free of both React and Cesium, so the arithmetic is testable on its own.
 */

export const TILE_SIZE = 256;
/** Below 8 the corridor is a dot; above 14 the tile count for a 22 km corridor stops being free. */
export const ZOOM_RANGE = Object.freeze({ min: 8, max: 14 });

export const lonToWorldX = (lon, zoom) => ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;

export function latToWorldY(lat, zoom) {
  // Clamped to the Mercator limit so a bad latitude cannot produce Infinity.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radians = (clamped * Math.PI) / 180;
  const y = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
  return ((1 - y / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

/** Bounding box of a corridor centerline. */
export function boundsOf(points) {
  const lons = points.map(point => point.lon), lats = points.map(point => point.lat);
  return {
    minLon: Math.min(...lons), maxLon: Math.max(...lons),
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
  };
}

/**
 * The largest zoom at which the whole corridor still fits, with a margin so the line does not run
 * into the panel edge.
 */
export function fittingZoom(bounds, width, height, padding = 8) {
  for (let zoom = ZOOM_RANGE.max; zoom > ZOOM_RANGE.min; zoom--) {
    const spanX = lonToWorldX(bounds.maxLon, zoom) - lonToWorldX(bounds.minLon, zoom);
    const spanY = latToWorldY(bounds.minLat, zoom) - latToWorldY(bounds.maxLat, zoom);
    if (spanX <= width - padding * 2 && spanY <= height - padding * 2) return zoom;
  }
  return ZOOM_RANGE.min;
}

/**
 * Everything the canvas needs: the zoom, the world-pixel origin of the top-left corner, and a
 * projection from lon/lat to canvas pixels.
 */
export function miniMapView(points, width, height) {
  const bounds = boundsOf(points);
  const zoom = fittingZoom(bounds, width, height);
  const centerX = (lonToWorldX(bounds.minLon, zoom) + lonToWorldX(bounds.maxLon, zoom)) / 2;
  const centerY = (latToWorldY(bounds.minLat, zoom) + latToWorldY(bounds.maxLat, zoom)) / 2;
  const originX = centerX - width / 2;
  const originY = centerY - height / 2;
  return {
    zoom, originX, originY, width, height,
    project: (lon, lat) => ({
      x: lonToWorldX(lon, zoom) - originX,
      y: latToWorldY(lat, zoom) - originY,
    }),
  };
}

/** The tiles covering the view, as {x, y, z, left, top} in canvas pixels. */
export function tilesFor(view) {
  const tiles = [];
  const span = 2 ** view.zoom;
  const firstX = Math.floor(view.originX / TILE_SIZE);
  const lastX = Math.floor((view.originX + view.width) / TILE_SIZE);
  const firstY = Math.floor(view.originY / TILE_SIZE);
  const lastY = Math.floor((view.originY + view.height) / TILE_SIZE);
  for (let x = firstX; x <= lastX; x++) {
    for (let y = firstY; y <= lastY; y++) {
      // Off the top or bottom of the world there is no tile; wrap around it east-west.
      if (y < 0 || y >= span) continue;
      tiles.push({
        x: ((x % span) + span) % span, y, z: view.zoom,
        left: x * TILE_SIZE - view.originX,
        top: y * TILE_SIZE - view.originY,
      });
    }
  }
  return tiles;
}
