/**
 * Ask the Twin: the vocabulary, the search settings and the suggested questions.
 *
 * Like the other files in src/config, this imports nothing from Cesium and holds no geometry. It
 * is the one place to change a radius or a starter question.
 */

/**
 * Default search radii.
 *
 * These are SEARCH SETTINGS, not claims. "4 cameras within 1 km" says where the app looked; it
 * does not say those cameras watch the terminal, or that a closure 2 km away affects it. Every
 * answer that uses one of these states the radius it used, so the reader can judge the span for
 * themselves — and every one of them is overridable in the question ("within 300 metres").
 */
export const SEARCH_RADIUS_M = Object.freeze({
  cameras: 1000,
  buildings: 250,
  roads: 300,
  events: 2000,
});

/** The widest radius a question may ask for. Past this the answer is about the port, not a place. */
export const MAX_RADIUS_M = 5000;

/** How many records one answer will name. A chat reply listing 400 footprints is not an answer. */
export const RESULT_LIMIT = Object.freeze({ assets: 10, buildings: 12, roads: 12, cameras: 10, events: 12 });

/**
 * What a confidence label means here. Nothing produces a label without one of these reasons
 * attached, and the reason is shown with it.
 *
 *   HIGH    answered entirely from data loaded in this app — the registry, the county road file,
 *           the building extract — with the subject resolved by an exact name or an id.
 *   MEDIUM  answered from a live FL511 read that is current, or from a spatial search anchored on
 *           a DERIVED or FRONTAGE position rather than a confirmed footprint.
 *   LOW     the underlying feed is stale, unreachable or has never loaded, so the answer describes
 *           the last data received — or no data at all — rather than the current state. An answer
 *           that could not read its source is never anything but LOW.
 */
export const CONFIDENCE = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

export const CONFIDENCE_BASIS = Object.freeze({
  REGISTRY_EXACT: { level: CONFIDENCE.HIGH, why: 'Read from the loaded registry and GIS; the subject was resolved by name or id.' },
  GIS_SPATIAL: { level: CONFIDENCE.HIGH, why: 'Measured against the county road file and building extract loaded in this app.' },
  PROVISIONAL_ANCHOR: { level: CONFIDENCE.MEDIUM, why: 'Measured from a provisional position derived from a street address, not a confirmed footprint.' },
  LIVE_FEED: { level: CONFIDENCE.MEDIUM, why: 'Read from the latest FL511 data this app holds, which reports only what has been reported to it.' },
  STALE_FEED: { level: CONFIDENCE.LOW, why: 'The FL511 feed is not current, so this describes the last data received rather than the situation now.' },
  NO_FEED: { level: CONFIDENCE.LOW, why: 'The FL511 data behind this answer could not be read at all, so no current state is being reported.' },
});

/**
 * The starter questions. Each one is answerable by a deterministic intent against real data; none
 * is a scripted demo answer. Two of them need a selection first, and say so.
 */
export const SUGGESTED_QUESTIONS = Object.freeze([
  Object.freeze({ text: 'Show me Cruise Terminal A.', needs: null }),
  Object.freeze({ text: 'How many cruise terminals are registered?', needs: null }),
  Object.freeze({ text: 'Show parking garages near Terminal B.', needs: null }),
  Object.freeze({ text: 'Are there any road closures near PortMiami?', needs: null }),
  Object.freeze({ text: 'Show traffic cameras near Terminal A.', needs: null }),
  Object.freeze({ text: 'Which buildings are near the selected road?', needs: 'road' }),
  Object.freeze({ text: 'Show construction events around the port.', needs: null }),
  Object.freeze({ text: 'What infrastructure assets are currently selected?', needs: null }),
]);

/**
 * How to NAME a category in a sentence.
 *
 * `ASSET_CATEGORIES` labels are column headings ("Parking", "Cruise terminal"), which read wrong
 * mid-sentence — "11 Parking are within 2 km" is not a sentence anyone would write. These are the
 * same categories as nouns, singular and plural.
 */
export const CATEGORY_NOUN = Object.freeze({
  CRUISE_TERMINAL: Object.freeze({ one: 'cruise terminal', many: 'cruise terminals' }),
  PARKING: Object.freeze({ one: 'parking facility', many: 'parking facilities' }),
  CARGO_TERMINAL: Object.freeze({ one: 'cargo terminal', many: 'cargo terminals' }),
  ADMINISTRATION: Object.freeze({ one: 'administration facility', many: 'administration facilities' }),
  TUNNEL: Object.freeze({ one: 'tunnel', many: 'tunnels' }),
  BRIDGE: Object.freeze({ one: 'bridge', many: 'bridges' }),
});

/** The noun for a category and a count; falls back to the neutral "infrastructure asset". */
export const categoryNoun = (category, count = 2) => {
  const entry = CATEGORY_NOUN[category];
  if (!entry) return count === 1 ? 'infrastructure asset' : 'infrastructure assets';
  return count === 1 ? entry.one : entry.many;
};

/** Shown instead of an answer when nothing understood the question. Never a fabricated reply. */
export const UNSUPPORTED_MESSAGE =
  'I can’t answer that one from the data this twin holds. In this phase I can find infrastructure '
  + 'assets, count them, list roads, buildings and FL511 cameras near a place, and report FL511 '
  + 'closures, incidents, congestion and construction for the port study area.';

/** The optional model endpoint. Unset or unreachable, the deterministic intents still answer. */
export const ASK_API = Object.freeze({ interpret: '/api/portmiami/ask' });
