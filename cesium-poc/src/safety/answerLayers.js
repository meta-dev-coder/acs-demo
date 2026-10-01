/**
 * Which map layers to switch on so an answer's events can actually be seen.
 *
 * Ask the Twin flew the camera to the right place and left the corridor bare, because the layer
 * that draws what it was describing was switched off and nothing turned it on. This decides what to
 * turn on; `askTheTwin.js` does the turning.
 *
 * Pure: events in, layer ids out. No DOM, no Cesium, no layer store.
 */

/** The Map Explorer layer that draws each FL511 event type. */
export const EVENT_LAYER = Object.freeze({
  INCIDENT: 'incidents', CLOSURE: 'closures', CONSTRUCTION: 'construction',
  CONGESTION: 'congestion', DISABLED: 'disabled-vehicles',
});

/** Close enough to the place the camera is going to be the events the answer is about. */
export const NEAR_ANSWER_M = 2_000;

const placed = event => Number.isFinite(event?.longitude) && Number.isFinite(event?.latitude);

/** Straight-line metres between two lon/lat points — near enough over a few kilometres. */
export function metresApart(lonA, latA, lonB, latB) {
  const toRad = Math.PI / 180;
  const x = (lonB - lonA) * toRad * Math.cos(((latA + latB) / 2) * toRad);
  const y = (latB - latA) * toRad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/**
 * The layers an answer needs, preferring what is near the camera's destination.
 *
 * Near the target first: when the answer is about one closure, turning on the four other event
 * layers would bury it. But a distance rule alone is what failed in practice — the service answers
 * with a coordinate for the interchange it names while the events themselves sit kilometres along
 * the corridor, so nothing was within reach and nothing was switched on. So when nothing is near,
 * fall back to every type the feed is actually carrying: bounded by what exists on the corridor
 * right now, and it always leaves the thing being discussed visible.
 *
 * @param {object[]} events       the live events the map holds
 * @param {{lon: number, lat: number}|null} [target]  where the camera is going, when known
 * @returns {string[]} layer ids, in the order the layers are listed
 */
export function eventLayersToShow(events, target = null) {
  const placedEvents = (events ?? []).filter(placed);
  const order = Object.values(EVENT_LAYER);
  const idsOf = list => order.filter(id => list.some(event => EVENT_LAYER[event.type] === id));

  if (target && Number.isFinite(Number(target.lon)) && Number.isFinite(Number(target.lat))) {
    const near = placedEvents.filter(event =>
      metresApart(Number(target.lon), Number(target.lat), event.longitude, event.latitude) <= NEAR_ANSWER_M);
    if (near.length) return idsOf(near);
  }
  return idsOf(placedEvents);
}
