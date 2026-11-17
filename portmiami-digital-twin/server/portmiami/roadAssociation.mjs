/**
 * Linking FL511 events to the PortMiami GIS road network.
 *
 * The existing Road Network Explorer already holds 2,362 county centrelines keyed by OBJECTID.
 * This module relates live events to those records. It does NOT rebuild the GIS, does not copy the
 * network, and does not write to it: the classification rules and the segment model are imported
 * from the frontend's own pure modules (`src/roads/`), so there is exactly one definition of what
 * a road is and what counts as port access.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THERE IS NO CONFIDENCE NUMBER
 *
 * A `confidence: 0.82` would have to come from somewhere. There is no labelled set of
 * event-to-road truth for PortMiami to calibrate against, so any number here would be a constant
 * I chose dressed up as a measurement. Instead each association carries the three things that are
 * actually known — `status`, `matchMethod` and `distanceMeters` — and the UI prints them. A
 * reviewer can see "47 m away, name agreed" and judge it; they cannot judge "0.82".
 *
 * WHAT MATCHED MEANS
 *
 *   MATCHED    the event's own text names this road AND the event sits within the radius of it.
 *              Two independent signals agree.
 *   CANDIDATE  the event is within the radius, and nothing else supports it. This is the status
 *              the nearest road gets. Nearest is NEVER promoted to MATCHED on distance alone —
 *              an event 12 m from Port Blvd is routinely an event on the ramp beside it.
 *   UNMATCHED  no segment within the radius. Recorded with its reason, not silently dropped.
 *
 * A direction stated in the event text that CONTRADICTS the segment's own PRE_DIR/SUF_DIR
 * demotes a MATCHED to CANDIDATE. Agreement is recorded; absence proves nothing either way.
 *
 * WHAT AN ASSOCIATION IS NOT
 *
 * It is a relation between an event and a centreline, not a state imposed on the road. Nothing
 * here marks a segment closed, congested or restricted — a closure's association says "FL511
 * reported a closure near/on this segment", which is the only thing two points and a sentence of
 * prose can support. Marking 2,362 segments' operational state from point markers would be
 * inventing a traffic model.
 * ---------------------------------------------------------------------------------------------
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildRoadSegments, readableName, validateRoadCollection } from '../../src/roads/roadModel.js';
import { distanceToPolylineMeters } from '../fl511/geo.mjs';

/** How far from a centreline an event can sit and still be worth relating to it. */
export const ROAD_SEARCH_RADIUS_M = 150;
/** Ranked by distance and truncated, so one event cannot carry 300 associations downtown. */
export const MAX_ASSOCIATIONS = 8;

export const LINK_STATUS = Object.freeze({ MATCHED: 'MATCHED', CANDIDATE: 'CANDIDATE', UNMATCHED: 'UNMATCHED' });
export const MATCH_METHOD = Object.freeze({
  /** The road is named as the one the event/asset is ON, and it is within the radius. */
  NAME_AND_PROXIMITY: 'NAME_AND_PROXIMITY',
  /** The road is named as a junction ("US-1 AT Port Boulevard") and is within the radius. */
  CROSS_REFERENCE_AND_PROXIMITY: 'CROSS_REFERENCE_AND_PROXIMITY',
  /** The road is named as a point the event is displaced FROM ("I-395 EAST OF Bridge Road"). */
  OFFSET_REFERENCE: 'OFFSET_REFERENCE',
  /** Nothing but distance. This is what the nearest centreline gets. */
  PROXIMITY_ONLY: 'PROXIMITY_ONLY',
  /** Named as the road it is on, but the stated direction contradicts the segment's own. */
  NAME_AND_PROXIMITY_DIRECTION_CONFLICT: 'NAME_AND_PROXIMITY_DIRECTION_CONFLICT',
});

/**
 * FL511 names a location as "<road> <locator> <landmark>", and the locator decides what the
 * landmark means. This is the difference between "the camera is on Port Boulevard" and "the camera
 * is on I-395, some distance from Bridge Road" — a difference the words themselves make, so
 * reading it is not inference.
 *
 *   JUNCTION  the two roads meet here. Both are genuinely associated with the location.
 *   OFFSET    the location is explicitly displaced from the landmark. It is NOT on it.
 */
const LOCATORS = Object.freeze({
  JUNCTION: Object.freeze([['AT'], ['NEAR'], ['APPROACHING'], ['ON', 'RAMP', 'TO'], ['AND']]),
  OFFSET: Object.freeze([
    ['BEFORE'], ['AFTER'], ['BEYOND'], ['PAST'], ['PRIOR', 'TO'],
    ['EAST', 'OF'], ['WEST', 'OF'], ['NORTH', 'OF'], ['SOUTH', 'OF'],
    ['NORTHEAST', 'OF'], ['NORTHWEST', 'OF'], ['SOUTHEAST', 'OF'], ['SOUTHWEST', 'OF'],
  ]),
});

/**
 * Split a location phrase at its first locator.
 *
 * `primary` is the road the text says the location is on; `reference` is everything the locator
 * introduced, and `kind` says which sort of locator it was. With no locator at all the whole
 * phrase is primary — "Closure on North America Way" names one road and nothing else.
 *
 * @param {string[]} tokens  already expanded by `tokenize`
 * @returns {{primary: string[], reference: string[], kind: 'JUNCTION'|'OFFSET'|null}}
 */
export function splitAtLocator(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    for (const [kind, phrases] of Object.entries(LOCATORS)) {
      for (const phrase of phrases) {
        if (phrase.every((word, offset) => tokens[i + offset] === word)) {
          return { primary: tokens.slice(0, i), reference: tokens.slice(i + phrase.length), kind };
        }
      }
    }
  }
  return { primary: tokens, reference: [], kind: null };
}

/**
 * Street-type and direction abbreviations, expanded both ways so the county's "PORT BLVD" and
 * FL511's "Port Boulevard" reduce to the same tokens. Only unambiguous USPS-standard pairs are
 * listed; a guess here would create false matches, which is the one failure mode that matters.
 */
const EXPANSIONS = new Map(Object.entries({
  BLVD: 'BOULEVARD', ST: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', DR: 'DRIVE', RD: 'ROAD',
  CT: 'COURT', PL: 'PLACE', LN: 'LANE', TER: 'TERRACE', TERR: 'TERRACE', CIR: 'CIRCLE',
  CSWY: 'CAUSEWAY', HWY: 'HIGHWAY', EXPY: 'EXPRESSWAY', EXPWY: 'EXPRESSWAY', PKWY: 'PARKWAY',
  TRL: 'TRAIL', BRG: 'BRIDGE', PT: 'POINT', SQ: 'SQUARE', PLZ: 'PLAZA', WALK: 'WALK',
  N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST',
  NE: 'NORTHEAST', NW: 'NORTHWEST', SE: 'SOUTHEAST', SW: 'SOUTHWEST',
}));

const DIRECTIONS = new Map(Object.entries({
  NORTH: 'N', NORTHBOUND: 'N', NB: 'N', S: 'S', SOUTH: 'S', SOUTHBOUND: 'S', SB: 'S',
  EAST: 'E', EASTBOUND: 'E', EB: 'E', WEST: 'W', WESTBOUND: 'W', WB: 'W',
  N: 'N', E: 'E', W: 'W',
}));

/**
 * Upper-case word tokens with abbreviations expanded. Punctuation and hyphens become breaks.
 *
 * A dotted compound direction is joined back up first. Punctuation is otherwise a word break, so
 * "S.W. 8th Street" would split into S and W and expand to SOUTH WEST, which never matches the
 * county's single SOUTHWEST token. The rule is deliberately narrow — only the four compound
 * directions, only when written with dots — so it cannot touch "St." or any other abbreviation.
 */
export function tokenize(text) {
  return String(text ?? '').toUpperCase()
    .replace(/\b([NS])\.\s*([EW])\.?/g, '$1$2')
    .split(/[^A-Z0-9]+/).filter(Boolean)
    .map(token => EXPANSIONS.get(token) ?? token);
}

/** Whether `needle`'s tokens appear as a contiguous run inside `haystack`'s. */
function containsSequence(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  // A one-token name has to be distinctive. "WAY" or "DR" alone would match half of Miami's prose,
  // so a single short token is not accepted as evidence of anything.
  if (needle.length === 1 && needle[0].length < 5) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The text FL511 itself published for an event: its heading and its prose, never our own fields. */
export const sourceText = event => [event?.title, event?.description,
  ...(event?.detailFields ?? []).map(field => field?.value)].filter(Boolean).join(' . ');

/** Directions named in a piece of text, as compass letters. */
export function directionsIn(text) {
  const found = new Set();
  for (const token of String(text ?? '').toUpperCase().split(/[^A-Z]+/)) {
    const letter = DIRECTIONS.get(token);
    if (letter) found.add(letter);
  }
  return found;
}

/** Directions the segment's own name parts carry (PRE_DIR / SUF_DIR). */
function segmentDirections(segment) {
  const found = new Set();
  for (const part of [segment.properties?.PRE_DIR, segment.properties?.SUF_DIR]) {
    const letter = DIRECTIONS.get(String(part ?? '').trim().toUpperCase());
    if (letter) found.add(letter);
  }
  return found;
}

/**
 * The network, loaded once, with the per-segment lookups association needs precomputed.
 * @param {string} geojsonPath
 */
export async function loadRoadNetwork(geojsonPath) {
  const data = JSON.parse(await readFile(geojsonPath, 'utf8'));
  const report = validateRoadCollection(data);
  if (!report.ok) throw new Error(`PortMiami road network is unusable: ${report.errors.join(' ')}`);
  const segments = buildRoadSegments(data).map(segment => ({
    objectId: segment.objectId,
    name: segment.name,
    isPortAccess: segment.isPortAccess,
    isTunnel: segment.isTunnel,
    coordinates: segment.coordinates,
    bounds: segment.bounds,
    /** The name as tokens, so a per-event match is a comparison and not a re-parse. */
    nameTokens: tokenize(readableName(segment.properties)),
    directions: segmentDirections(segment),
  }));
  return createRoadNetwork(segments);
}

export const DEFAULT_ROADS_PATH = fileURLToPath(
  new URL('../../public/data/portmiami_roads_merged.geojson', import.meta.url));

/** @param {object[]} segments  as prepared by loadRoadNetwork (or hand-built, in tests) */
export function createRoadNetwork(segments) {
  return {
    segments,
    count: segments.length,

    /**
     * Relate one event to the network.
     * @param {object} event
     * @param {{radiusMeters?: number, max?: number}} [options]
     * @returns {{associations: object[], unmatchedReason: string|null}}
     */
    associate(event, { radiusMeters = ROAD_SEARCH_RADIUS_M, max = MAX_ASSOCIATIONS } = {}) {
      const text = sourceText(event);
      const textTokens = tokenize(text);
      const eventDirections = directionsIn(text);
      // Both published points are tested, so a two-point closure is related to the roads at EITHER
      // end rather than only the one its primary anchor happens to sit on.
      const points = [[event.longitude, event.latitude]];
      if (event.secondaryLongitude != null) points.push([event.secondaryLongitude, event.secondaryLatitude]);

      // Where in the sentence a road name may appear decides what the name proves.
      const phrase = splitAtLocator(textTokens);

      const found = [];
      for (const segment of segments) {
        let distance = Infinity;
        for (const [lon, lat] of points) {
          const d = distanceToPolylineMeters(lon, lat, segment.coordinates);
          if (d < distance) distance = d;
        }
        if (distance > radiusMeters) continue;

        const named = segment.nameTokens.length > 0;
        // Named as the road the location is ON.
        const onRoad = named && containsSequence(phrase.primary, segment.nameTokens);
        // Named only after a locator: a junction partner, or a point this location is offset from.
        const referenced = named && !onRoad && containsSequence(phrase.reference, segment.nameTokens);
        const isJunction = referenced && phrase.kind === 'JUNCTION';
        const isOffset = referenced && phrase.kind === 'OFFSET';
        const nameAgrees = onRoad || isJunction;

        // A conflict needs both sides to have said something and to disagree.
        const directionConflict = onRoad && eventDirections.size > 0 && segment.directions.size > 0
          && ![...segment.directions].some(letter => eventDirections.has(letter));

        found.push({
          eventId: event.id,
          roadObjectId: segment.objectId,
          roadName: segment.name || null,
          isPortAccess: segment.isPortAccess,
          isTunnel: segment.isTunnel,
          distanceMeters: Math.round(distance * 10) / 10,
          status: nameAgrees && !directionConflict ? LINK_STATUS.MATCHED : LINK_STATUS.CANDIDATE,
          matchMethod: directionConflict ? MATCH_METHOD.NAME_AND_PROXIMITY_DIRECTION_CONFLICT
            : onRoad ? MATCH_METHOD.NAME_AND_PROXIMITY
            : isJunction ? MATCH_METHOD.CROSS_REFERENCE_AND_PROXIMITY
            : isOffset ? MATCH_METHOD.OFFSET_REFERENCE
            : MATCH_METHOD.PROXIMITY_ONLY,
          evidence: {
            nameAgrees,
            namedAsRoadOn: onRoad,
            namedAsJunction: isJunction,
            /** The source says the location is displaced from this road, so it is not on it. */
            namedAsOffsetFrom: isOffset,
            nameMatchedOn: onRoad || referenced ? segment.nameTokens.join(' ') : null,
            directionsInSourceText: [...eventDirections],
            segmentDirections: [...segment.directions],
            directionConflict,
          },
        });
      }

      // Matched first, then by distance: the evidenced association is what a reader should see at
      // the top, not whichever kerb happened to be closest.
      found.sort((a, b) => (a.status === b.status ? a.distanceMeters - b.distanceMeters
        : a.status === LINK_STATUS.MATCHED ? -1 : 1));

      return {
        associations: found.slice(0, max),
        unmatchedReason: found.length === 0
          ? `No PortMiami road centreline within ${radiusMeters} m of either published point.` : null,
        truncated: Math.max(0, found.length - max),
      };
    },
  };
}

/** Attach associations to every event in a list, in place of each event's empty array. */
export function associateEvents(events, network, options) {
  return events.map(event => {
    const { associations, unmatchedReason, truncated } = network.associate(event, options);
    return {
      ...event,
      roadAssociations: associations,
      /** The OBJECTIDs a reader can act on: the evidenced ones only. */
      affectedRoadObjectIds: associations
        .filter(link => link.status === LINK_STATUS.MATCHED).map(link => link.roadObjectId),
      roadAssociationStatus: associations.length === 0 ? LINK_STATUS.UNMATCHED
        : associations.some(link => link.status === LINK_STATUS.MATCHED) ? LINK_STATUS.MATCHED
        : LINK_STATUS.CANDIDATE,
      ...(unmatchedReason ? { roadAssociationNote: unmatchedReason } : {}),
      ...(truncated ? { roadAssociationsTruncated: truncated } : {}),
    };
  });
}
