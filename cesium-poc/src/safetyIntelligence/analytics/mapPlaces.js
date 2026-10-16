/**
 * The corridor's findings, gathered into PLACES for the map.
 *
 * The map was drawing one mark per finding: 19 concentration circles, 190 queue diamonds and a
 * replay dot for every record lit at the cursor. At corridor zoom that is a wall of markers with no
 * reading in it — the operator cannot tell where to look, which is the one thing a map is for.
 *
 * A place is everything the four domains report within `radiusMeters` of each other, counted once
 * and drawn as a single numbered badge, the way the Agency screen already draws its crash hotspots.
 * Choosing a badge is how the detail is reached: the screen flies to the place and draws its
 * members individually.
 *
 * The badges count WHAT THE OPEN TAB IS ABOUT, and nothing else. With Secondary open the map shows
 * only records carrying a secondary-collision category; with Assets open, only open work orders;
 * with Hazards, only inspection findings. Mixing all four into one number meant the map disagreed
 * with the KPI above it — the header said 40 secondary records and the badges added up to 1,100 of
 * everything — and a reader had no way to tell which was answering their question.
 *
 * The rule the tests hold to: **the badge totals equal the open tab's leading KPI**, for the same
 * scope. A count of findings, never a count of crashes; the colour is a band of severity from the
 * records' own fields, with nothing weighted, scored or inferred.
 */
import { metresBetween } from './hotspots.js';

/** How close together findings have to be to be one place. Matches the hotspot radius. */
export const PLACE_RADIUS_M = 250;

/**
 * The colour bands, matching the Agency screen's crash hotspots so one corridor reads one way.
 *
 * A single fatal record sets the top band on its own: a place where somebody was killed is not a
 * low-severity place because only one thing happened there.
 */
export const PLACE_BANDS = Object.freeze({
  SEVERE: { id: 'SEVERE', label: 'Fatal recorded', color: '#e66259' },
  HIGH: { id: 'HIGH', label: 'Injury recorded', color: '#ee9148' },
  MODERATE: { id: 'MODERATE', label: 'Recorded incidents', color: '#e5bc57' },
  LOW: { id: 'LOW', label: 'No injury recorded', color: '#9ad97f' },
});

const positioned = item => Number.isFinite(item?.longitude) && Number.isFinite(item?.latitude);

/**
 * What each tab's badges count, and what they count it in.
 *
 * `count` must return exactly what that tab's leading KPI counts, or the map and the header will
 * disagree about the same question.
 */
export const PLACE_DOMAINS = Object.freeze({
  accidents: {
    id: 'accidents', noun: 'incident records', tone: null,
    members: ({ facts }) => facts.map(item => ({ kind: 'incident', item })),
    count: place => place.facts.length,
  },
  secondary: {
    id: 'secondary', noun: 'secondary-labelled records', tone: '#A78BFA',
    members: ({ facts }) => facts.filter(fact => /secondary/i.test(fact.rootCauseCategory ?? ''))
      .map(item => ({ kind: 'incident', item })),
    count: place => place.facts.length,
  },
  assets: {
    id: 'assets', noun: 'open work orders', tone: '#F97316',
    members: ({ defects }) => defects.filter(defect => defect.open).map(item => ({ kind: 'defect', item })),
    count: place => place.defects.length,
  },
  patrol: {
    id: 'patrol', noun: 'hazard findings', tone: '#14B8A6',
    members: ({ hazardPlaces }) => hazardPlaces.map(item => ({ kind: 'hazard', item })),
    // The hazards KPI counts FINDINGS, not locations, so the badges must too.
    count: place => place.hazardFindings,
  },
});
/** Outcomes has no map question of its own, so it shows the corridor's incident records. */
export const domainFor = tab => PLACE_DOMAINS[tab] ?? PLACE_DOMAINS.accidents;

/** Severity sets the floor; volume can only raise the band from LOW. */
function bandFor(facts) {
  if (facts.some(fact => fact.severity?.level === 'FATAL')) return PLACE_BANDS.SEVERE;
  if (facts.some(fact => fact.severity?.level === 'INJURY')) return PLACE_BANDS.HIGH;
  if (facts.length >= 3) return PLACE_BANDS.MODERATE;
  return PLACE_BANDS.LOW;
}

/**
 * Group everything positioned into places.
 *
 * Greedy, by the same rule the hotspots use: take the point with the most neighbours, claim them,
 * repeat. Deterministic — the same findings always produce the same places.
 *
 * @param {{facts: object[], defects: object[], hazardPlaces: object[], radiusMeters?: number}} input
 */
export function buildPlaces({ facts = [], defects = [], hazardPlaces = [],
  radiusMeters = PLACE_RADIUS_M, tab = 'accidents' } = {}) {
  const domain = domainFor(tab);
  const members = domain.members({ facts, defects, hazardPlaces })
    .filter(member => positioned(member.item));
  const remaining = new Set(members.keys());
  const neighboursOf = index => [...remaining].filter(other =>
    metresBetween(members[index].item, members[other].item) <= radiusMeters);

  const places = [];
  while (remaining.size) {
    let best = null;
    for (const index of remaining) {
      const found = neighboursOf(index);
      if (!best || found.length > best.found.length) best = { index, found };
    }
    for (const index of best.found) remaining.delete(index);
    places.push(summarise(best.found.map(index => members[index]), members[best.index].item, domain));
  }
  return Object.freeze(places.sort((a, b) => b.count - a.count));
}

/**
 * What the badges add up to, and what that is a count of.
 *
 * Returned beside the places so a caller — and a test — can check the map against the KPI without
 * re-deriving either.
 */
export const placeTotals = (places = [], tab = 'accidents') => Object.freeze({
  tab,
  noun: domainFor(tab).noun,
  badges: places.length,
  counted: places.reduce((sum, place) => sum + place.count, 0),
});

function summarise(group, seed, domain) {
  const of = kind => group.filter(member => member.kind === kind).map(member => member.item);
  const facts = of('incident');
  const defects = of('defect');
  const hazards = of('hazard');
  const longitude = group.reduce((sum, member) => sum + member.item.longitude, 0) / group.length;
  const latitude = group.reduce((sum, member) => sum + member.item.latitude, 0) / group.length;
  const hazardFindings = hazards.reduce((sum, place) => sum + (place.hazards ?? 0), 0);
  // `count` is read from these three, so it is computed from the same group the badge is drawn for.
  const segment = facts.find(fact => fact.segmentName)?.segmentName ?? null;
  return Object.freeze({
    id: `PL-${seed.id ?? seed.key ?? `${longitude.toFixed(5)},${latitude.toFixed(5)}`}`,
    longitude,
    latitude,
    label: segment
      ?? (facts.length ? `${facts[0].type} and nearby findings`
        : defects.length ? `${defects[0].assetType ?? 'Asset'} ${defects[0].assetId ?? ''}`.trim()
          : hazards[0]?.label ?? 'Findings'),
    facts: Object.freeze(facts),
    defects: Object.freeze(defects),
    hazards: Object.freeze(hazards),
    /** What the badge shows: what the OPEN TAB counts, here. */
    count: domain.count({ facts, defects, hazards, hazardFindings }),
    domain: domain.id,
    noun: domain.noun,
    records: facts.length,
    openDefects: defects.length,
    hazardFindings,
    severeRecords: facts.filter(fact => fact.severity?.rank >= 2).length,
    // Severity bands where the badge counts records; the domain's own tone where it counts work
    // orders or hazard findings, which carry no severity of their own.
    band: domain.tone
      ? Object.freeze({ id: domain.id.toUpperCase(), label: domain.noun, color: domain.tone })
      : bandFor(facts),
    /** How far apart the members actually are, so the camera can frame them. */
    spreadMeters: Math.round(Math.max(...group.map(member =>
      metresBetween({ longitude, latitude }, member.item)), 0) * 2),
    countBasis: `The ${domain.noun} here, counted once each. Not a count of crashes.`,
  });
}

/** Every member of a place, as marks to draw when it is opened. */
export const membersOf = place => Object.freeze([
  ...place.facts.map(fact => Object.freeze({ kind: 'incident', id: fact.id, item: fact,
    longitude: fact.longitude, latitude: fact.latitude,
    label: `${fact.type} · ${fact.severity.label} · ${fact.when.dayKey}` })),
  ...place.defects.map(defect => Object.freeze({ kind: 'defect', id: defect.id, item: defect,
    longitude: defect.longitude, latitude: defect.latitude,
    label: `${defect.assetType ?? 'Asset'} ${defect.assetId ?? ''} · ${defect.ageDays ?? '—'} days open` })),
  ...place.hazards.map(hazard => Object.freeze({ kind: 'hazard', id: hazard.key, item: hazard,
    longitude: hazard.longitude, latitude: hazard.latitude,
    label: `${hazard.label} · ${hazard.hazards} hazard findings` })),
]);
