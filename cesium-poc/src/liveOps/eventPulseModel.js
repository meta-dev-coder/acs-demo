export const NEARBY_ASSET_METERS = 500;
export const EVENT_PULSE_COLORS = Object.freeze({ major: '#e66259', high: '#ee9148', moderate: '#e5bc57', low: '#9ad97f', unknown: '#8594a8' });
export function pulseSeverity(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (/major|severe|serious/.test(text)) return 'major';
  if (/high/.test(text)) return 'high';
  if (/moderate|medium|intermediate/.test(text)) return 'moderate';
  if (/minor|low|minimal/.test(text)) return 'low';
  return 'unknown';
}
export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dlat = (b.latitude - a.latitude) * rad, dlon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function eventPulseStyle(event, assets) {
  const nearby = assets.map(asset => ({ ...asset, distance: distanceMeters(event, asset) }))
    .filter(asset => Number.isFinite(asset.distance) && asset.distance <= NEARBY_ASSET_METERS);
  const severity = pulseSeverity(event.severity);
  return { severity, color: EVENT_PULSE_COLORS[severity], nearby,
    radius: nearby.length ? Math.max(350, ...nearby.map(asset => asset.distance + 50)) : 150 };
}
