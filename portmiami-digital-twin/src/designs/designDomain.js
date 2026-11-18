/**
 * Which kind of infrastructure a design — and each of its elements — is about.
 *
 * WHY THIS EXISTS. The three conceptual alternatives this twin shipped with are PARKING sketches:
 * a garage expansion, a new garage with its access road, and a surface-lot re-layout. The Road
 * Design Studio was then built on top of the same three records, so opening it drew garage
 * massing, an orange surface-parking plate and a "1,500 spaces (target)" plate over the port.
 * Those are not road proposals and have no business in a road workflow.
 *
 * DOMAIN IS DECLARED, NOT GUESSED FROM A NAME. A design states its domain; so may each element.
 * Names are never parsed — "Design C — Surface Parking and Road Reconfiguration" is suggestive but
 * a record whose domain is read from its title is a record that changes meaning when someone
 * renames it.
 *
 * A ROAD INSIDE A PARKING SCENARIO STAYS THERE. `design-b-road-01` is a ROAD element, but it is
 * the access road of a parking proposal and belongs to that proposal. Classifying by element type
 * alone would promote it into the road studio and quietly re-home half a parking scheme, so the
 * seeded elements are listed by id below and keep their scenario.
 *
 * CLASSIFICATION IS ADDITIVE AND REVERSIBLE. `classifyDesign` only ever ADDS a `domain` field; it
 * rewrites no geometry, drops no element and renames nothing. A record that already declares a
 * domain is returned untouched. Removing the field puts a store back exactly where it started.
 */
import { ELEMENT_TYPE } from './designModel.js';

export const DESIGN_DOMAIN = Object.freeze({
  ROAD_INFRASTRUCTURE: 'ROAD_INFRASTRUCTURE',
  PARKING_INFRASTRUCTURE: 'PARKING_INFRASTRUCTURE',
  MIXED_INFRASTRUCTURE: 'MIXED_INFRASTRUCTURE',
});

export const DOMAIN_LABEL = Object.freeze({
  ROAD_INFRASTRUCTURE: 'Road infrastructure',
  PARKING_INFRASTRUCTURE: 'Parking infrastructure',
  MIXED_INFRASTRUCTURE: 'Mixed infrastructure',
});

/**
 * The elements of the three shipped parking sketches, by id.
 *
 * Enumerated rather than detected so a reviewer can see exactly which records are being
 * reclassified, and so a user-drawn element can never be caught by the same rule. Two of these
 * are roads; they stay with their parking scenario, which is the whole point of the list.
 */
export const LEGACY_PARKING_ELEMENT_IDS = Object.freeze(new Set([
  'design-a-garage-01',
  'design-b-garage-01',
  'design-b-road-01',
  'design-c-surface-01',
  'design-c-road-01',
]));

/** The ids of the shipped parking alternatives themselves. */
export const LEGACY_PARKING_DESIGN_IDS = Object.freeze(new Set(['design-a', 'design-b', 'design-c']));

const BY_TYPE = Object.freeze({
  [ELEMENT_TYPE.ROAD]: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
  [ELEMENT_TYPE.PARKING_GARAGE]: DESIGN_DOMAIN.PARKING_INFRASTRUCTURE,
  [ELEMENT_TYPE.SURFACE_PARKING]: DESIGN_DOMAIN.PARKING_INFRASTRUCTURE,
});

/**
 * The domain one element belongs to.
 *
 * A declared `domain` wins. Then the legacy list, so a seeded access road stays with its garage.
 * Only then the element's type — and a BUILDING, TERMINAL or piece of ACCESS_INFRASTRUCTURE is
 * neither road nor parking on the face of it, so it reads MIXED rather than being forced either way.
 */
export function elementDomain(element) {
  if (DESIGN_DOMAIN[element?.domain]) return element.domain;
  if (LEGACY_PARKING_ELEMENT_IDS.has(element?.id)) return DESIGN_DOMAIN.PARKING_INFRASTRUCTURE;
  return BY_TYPE[element?.type] ?? DESIGN_DOMAIN.MIXED_INFRASTRUCTURE;
}

/**
 * The domain a design belongs to, from what it actually holds.
 *
 * A declared domain wins. An empty design is whatever it says it is, and MIXED if it says
 * nothing — an empty record cannot be read off its contents, and guessing ROAD would make every
 * blank design appear in the road studio.
 */
export function designDomain(design) {
  if (DESIGN_DOMAIN[design?.domain]) return design.domain;
  const domains = new Set((design?.elements ?? []).map(elementDomain));
  domains.delete(DESIGN_DOMAIN.MIXED_INFRASTRUCTURE);
  if (domains.size === 1) return [...domains][0];
  return DESIGN_DOMAIN.MIXED_INFRASTRUCTURE;
}

export const isRoadDesign = design => designDomain(design) === DESIGN_DOMAIN.ROAD_INFRASTRUCTURE;

/** The elements of `design` that belong to `domain`. MIXED matches everything. */
export function elementsInDomain(design, domain) {
  if (domain === DESIGN_DOMAIN.MIXED_INFRASTRUCTURE) return [...(design?.elements ?? [])];
  return (design?.elements ?? []).filter(element => elementDomain(element) === domain);
}

/**
 * Split a design's elements by domain, without losing any.
 *
 * `mixed` holds what is neither — a BUILDING or TERMINAL change — so the three buckets always
 * add back up to the original and nothing can disappear through classification.
 */
export function splitByDomain(design) {
  const road = [], parking = [], mixed = [];
  for (const element of design?.elements ?? []) {
    const domain = elementDomain(element);
    if (domain === DESIGN_DOMAIN.ROAD_INFRASTRUCTURE) road.push(element);
    else if (domain === DESIGN_DOMAIN.PARKING_INFRASTRUCTURE) parking.push(element);
    else mixed.push(element);
  }
  return { road, parking, mixed };
}

/**
 * Stamp explicit domains onto a design and its elements.
 *
 * Additive only: every other field, including geometry, revision and name, is passed through. A
 * design that already declares a domain is returned as-is so a user's own classification is never
 * overwritten.
 */
export function classifyDesign(design) {
  if (!design) return design;
  if (DESIGN_DOMAIN[design.domain]) return design;
  return {
    ...design,
    domain: designDomain(design),
    elements: (design.elements ?? []).map(element =>
      (DESIGN_DOMAIN[element?.domain] ? element : { ...element, domain: elementDomain(element) })),
  };
}
