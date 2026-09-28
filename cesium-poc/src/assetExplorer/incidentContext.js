/**
 * Where an incident happened, resolved from its coordinates.
 *
 * The incident classes carry a point and — sometimes — a coarse segment name ("Central Segment").
 * They do not carry the carriageway, the milepost, the cross street or a camera. All four are things
 * an operator needs before they can act, and all four are already in the corridor's own published
 * geometry, so they are measured from the point rather than left blank or typed in by hand:
 *
 *   carriageway  nearest of the 16 FDOT traffic segments (8 eastbound, 8 westbound) and the
 *                reversible express geometry — whichever line the point actually lies closest to
 *   milepost     the FDOT begin/end posts of that segment, interpolated along it
 *   cross street the segment's own `desc_from` / `desc_to`, verbatim
 *   cameras      the corridor CCTV inventory, ordered by distance from the point
 *
 * Every number here is a measurement with a stated tolerance, never a claim: `offsetM` says how far
 * the point sat off the line it was matched to, and a match beyond CARRIAGEWAY_LIMIT_M is reported
 * as unresolved rather than guessed at. The incidents are positioned from their damaged asset, so a
 * roadside asset genuinely sits tens of metres off both carriageways.
 *
 * Pure except for `loadCorridorContext`, which is the one function that fetches.
 */

import { metresBetween } from './corridorPosition.js';

/** Beyond this the point is not on a carriageway in any useful sense, and none is claimed. */
export const CARRIAGEWAY_LIMIT_M = 250;
/** A camera further away than this is not showing the incident, whatever the ordering says. */
export const CAMERA_RANGE_M = 1600;

export const DIRECTION_LABELS = Object.freeze({ EB: 'Eastbound', WB: 'Westbound', REVERSIBLE: 'Express (reversible)' });

const METRES_PER_MILE = 1609.344;

/**
 * Nearest point on one polyline, in metres, with how far along it that point lies.
 * @param {number[][]} line [lon, lat] pairs
 * @returns {{offsetM: number, fraction: number}}
 */
export function projectOntoLine(longitude, latitude, line) {
  let best = { offsetM: Infinity, fraction: 0 };
  if (!Array.isArray(line) || line.length < 2) return best;
  // Segment lengths are needed twice — once to find the nearest, once to place it along the whole —
  // so they are accumulated in the same pass.
  const lengths = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const length = metresBetween(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return best;
  let travelled = 0;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const length = lengths[i - 1];
    if (length > 0) {
      // A local metre plane: over a 20 km corridor the flat-earth error is far below what a
      // "nearest camera" or a milepost claims.
      const scale = Math.cos((latitude * Math.PI) / 180);
      const dx = (bx - ax) * scale, dy = by - ay;
      const px = (longitude - ax) * scale, py = latitude - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
      const offsetM = metresBetween(longitude, latitude, ax + t * (bx - ax), ay + t * (by - ay));
      if (offsetM < best.offsetM) best = { offsetM, fraction: (travelled + t * length) / total };
    }
    travelled += length;
  }
  return best;
}

/** One usable line per GeoJSON feature: a MultiLineString contributes each of its parts. */
export function carriagewayLines(geojson) {
  const lines = [];
  for (const feature of geojson?.features ?? []) {
    const properties = feature?.properties ?? {};
    const geometry = feature?.geometry;
    const parts = geometry?.type === 'LineString' ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    for (const coordinates of parts) {
      if (Array.isArray(coordinates) && coordinates.length >= 2) lines.push({ properties, coordinates });
    }
  }
  return lines;
}

/**
 * Which carriageway a point lies on, and where along it.
 *
 * @param {{lines: object[]}} corridor lines from `carriagewayLines`, mainline and express together
 * @returns {{direction: string, directionLabel: string, express: boolean, segmentId: string|null,
 *            milepost: number|null, offsetM: number, from: string|null, to: string|null,
 *            road: string|null, resolved: boolean} | null}
 */
export function carriagewayAt(longitude, latitude, lines) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !lines?.length) return null;
  let best = null;
  for (const line of lines) {
    const hit = projectOntoLine(longitude, latitude, line.coordinates);
    if (!best || hit.offsetM < best.offsetM) best = { ...hit, properties: line.properties };
  }
  if (!best) return null;
  const properties = best.properties ?? {};
  const begin = Number(properties.begin_post), end = Number(properties.end_post);
  const milepost = Number.isFinite(begin) && Number.isFinite(end) ? begin + (end - begin) * best.fraction : null;
  const direction = String(properties.direction ?? '').toUpperCase() || 'UNKNOWN';
  const express = /express/i.test(properties.facility ?? '') || direction === 'REVERSIBLE';
  const named = value => {
    const text = String(value ?? '').trim();
    return text && text.toUpperCase() !== 'N/A' ? text : null;
  };
  return {
    direction,
    directionLabel: DIRECTION_LABELS[direction] ?? 'Direction unresolved',
    express,
    segmentId: named(properties.segment_id ?? properties.id),
    road: named(properties.road),
    milepost,
    offsetM: best.offsetM,
    from: named(properties.desc_from),
    to: named(properties.desc_to),
    // Said plainly: a point 400 m off both carriageways has no carriageway, and the panel says so.
    resolved: best.offsetM <= CARRIAGEWAY_LIMIT_M,
  };
}

/** How a resolved carriageway reads in one line: "I-595 Eastbound · MP 6.21". */
export function carriagewayLabel(place) {
  if (!place?.resolved) return 'Carriageway unresolved';
  const road = place.road ?? 'I-595';
  const head = place.express ? `${road} Express` : `${road} ${place.directionLabel}`;
  return Number.isFinite(place.milepost) ? `${head} · MP ${place.milepost.toFixed(2)}` : head;
}

/** The cross-street span a segment runs between, as the FDOT description writes it. */
export function segmentSpanLabel(place) {
  if (!place?.from && !place?.to) return null;
  return [place.from, place.to].filter(Boolean).join(' → ');
}

/**
 * The corridor's cameras, nearest first.
 *
 * Distance only — no attempt to work out which way a camera is pointing, because the inventory does
 * not say. `direction` is the camera's own carriageway where the feed reports one.
 *
 * @param {{features: object[]}|object[]} cameras the camera GeoJSON, or already-flattened records
 * @returns {{id: string, label: string, description: string|null, direction: string|null,
 *            metres: number, longitude: number, latitude: number, divasChannelId: string|null,
 *            express: boolean}[]}
 */
export function camerasNear(longitude, latitude, cameras, { limit = 4, rangeM = CAMERA_RANGE_M } = {}) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
  const features = Array.isArray(cameras) ? cameras : cameras?.features ?? [];
  const near = [];
  for (const feature of features) {
    const properties = feature?.properties ?? feature ?? {};
    const point = feature?.geometry?.coordinates;
    const cameraLon = Number(point?.[0] ?? properties.longitude);
    const cameraLat = Number(point?.[1] ?? properties.latitude);
    const id = String(properties.camera_id ?? properties.id ?? '').trim();
    if (!id || !Number.isFinite(cameraLon) || !Number.isFinite(cameraLat)) continue;
    const metres = metresBetween(longitude, latitude, cameraLon, cameraLat);
    if (metres > rangeM) continue;
    near.push({
      id,
      label: String(properties.title ?? '').trim() || `Camera ${id}`,
      description: String(properties.description ?? '').trim() || null,
      direction: properties.direction ? DIRECTION_LABELS[String(properties.direction).toUpperCase()]
        ?? { E: 'Eastbound', W: 'Westbound', N: 'Northbound', S: 'Southbound' }[properties.direction] ?? String(properties.direction) : null,
      metres,
      longitude: cameraLon,
      latitude: cameraLat,
      // Only a camera with a DIVAS channel has a snapshot to show; the rest are listed, not promised.
      divasChannelId: typeof properties.divas_chan_id === 'string' && properties.divas_chan_id ? properties.divas_chan_id : null,
      express: properties.is_express_camera === true,
    });
  }
  near.sort((a, b) => a.metres - b.metres);
  return near.slice(0, limit);
}

/** Distance as an operator reads it: metres up close, miles once it stops being "just there". */
export function distanceLabel(metres) {
  if (!Number.isFinite(metres)) return null;
  return metres < 400 ? `${Math.round(metres)} m away` : `${(metres / METRES_PER_MILE).toFixed(1)} mi away`;
}

/**
 * Load the geometry this module measures against, once per page.
 *
 * A file that fails to load costs only what it provides — no cameras, or no carriageway — rather
 * than the whole panel.
 *
 * @returns {Promise<{lines: object[], cameras: object[]}>}
 */
let pending = null;
export function loadCorridorContext({ fetchImpl = globalThis.fetch, baseUrl = import.meta.env?.BASE_URL ?? '/' } = {}) {
  if (pending) return pending;
  const read = async path => {
    try {
      const response = await fetchImpl(`${baseUrl}data/${path}`);
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  pending = (async () => {
    const [segments, express, cameras] = await Promise.all([
      read('i595_fdot_traffic_segments.geojson'), read('express-way.geojson'), read('i595_corridor_cameras.geojson'),
    ]);
    return {
      lines: [...carriagewayLines(segments), ...carriagewayLines(express)],
      cameras: cameras?.features ?? [],
    };
  })();
  return pending;
}

/** Test hook: drop the cached load so a fresh one can be observed. */
export const resetCorridorContext = () => { pending = null; };
