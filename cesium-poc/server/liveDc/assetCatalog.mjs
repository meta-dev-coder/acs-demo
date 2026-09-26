/**
 * Asset catalog for the live incident workflow: normalises Florida I595 Assets (curated DataConnect
 * items or the shipped asset registry rows) into a flat Asset list and finds the asset an incident
 * most plausibly damaged. Read-only: assets are only ever referenced by code.
 */
import { haversineMeters } from '../geo.mjs';

// Registry rows describing events or encampments, not physical roadside assets.
export const EXCLUDED_CATEGORIES = Object.freeze(new Set(['Accidents', 'Homeless']));

function coordinate(value) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function collect(entries) {
  const byCode = new Map();
  for (const entry of entries) {
    if (!entry.code || !entry.category || EXCLUDED_CATEGORIES.has(entry.category)) continue;
    if (entry.longitude === null || entry.latitude === null) continue;
    if (!byCode.has(entry.code)) byCode.set(entry.code, entry);
  }
  return [...byCode.values()];
}

/** Curated Assets items -> Asset[]. Never filters on `valid`: assets without a segment ID are valid=false. */
export function assetsFromCurated(items) {
  return collect((items ?? []).map((item) => {
    const a = item?.attributes ?? {};
    return {
      code: text(a.code ?? item?.keyInSource),
      category: text(a['asset category']),
      systemClass: text(a['system class']),
      longitude: coordinate(a.x_coordinates ?? a['x coordinates']),
      latitude: coordinate(a.y_coordinates ?? a['y coordinates']),
      segmentCode: text(a['segment ID']),
      name: text(a.name),
    };
  }));
}

/** public/dataconnect-data/asset_registry.json rows -> Asset[]. */
export function assetsFromRegistry(rows) {
  return collect((rows ?? []).map((row) => ({
    code: text(row?.['Asset ID']),
    category: text(row?.['Asset Category']),
    systemClass: text(row?.['System Class']),
    longitude: coordinate(row?.['X Coordinates']),
    latitude: coordinate(row?.['Y Coordinates']),
    segmentCode: text(row?.['Segment ID']),
    name: text(row?.['Asset Description']),
  })));
}

/**
 * Nearest asset of the highest-priority category that has any asset within the radius; a nearer
 * asset of a lower-priority category never wins (a crash cushion beats a light pole behind it).
 */
export function nearestAsset(assets, { longitude, latitude }, { categories, radiusMeters }) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !categories?.length) return null;
  const rank = new Map(categories.map((category, index) => [category, index]));
  let best = null;
  for (const asset of assets ?? []) {
    const r = rank.get(asset.category);
    if (r === undefined) continue;
    const distance = haversineMeters(longitude, latitude, asset.longitude, asset.latitude);
    if (!(distance <= radiusMeters)) continue;
    if (!best || r < best.rank || (r === best.rank && (distance < best.distance
      || (distance === best.distance && asset.code.localeCompare(best.asset.code, 'en') < 0)))) {
      best = { asset, rank: r, distance };
    }
  }
  return best ? { asset: best.asset, distanceM: Math.round(best.distance * 10) / 10 } : null;
}
