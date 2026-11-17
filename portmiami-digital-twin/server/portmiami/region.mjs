/**
 * The region this pipeline is pointed at.
 *
 * The whole point of keeping this in its own file is that the FL511 layer under server/fl511/ knows
 * nothing about PortMiami: it fetches statewide feeds and hands them to a filter. Swap this object
 * and the same poller, the same normalizer and the same endpoints serve another study area.
 *
 * WHAT THE BOX IS. A study-area boundary, and nothing more. It is NOT PortMiami's property
 * boundary, and an event inside it is NOT thereby an event affecting the port — the box also
 * contains I-395, the MacArthur Causeway, the Brickell waterfront and a stretch of I-95. That
 * distinction is carried all the way to the UI, which labels a bbox hit as "in the study area" and
 * reserves any stronger statement for the road association in roadAssociation.mjs.
 */

export const PORTMIAMI_REGION = Object.freeze({
  id: 'portmiami',
  name: 'PortMiami',
  /** Matches the bbox the PortMiami GIS explorers were scoped to. */
  bbox: Object.freeze({ west: -80.200, south: 25.755, east: -80.135, north: 25.800 }),
  boundaryKind: 'STUDY_AREA',
  boundaryNote:
    'Study-area boundary, not PortMiami property. It also covers I-395, the MacArthur Causeway, '
    + 'I-95 approaches and the Brickell waterfront, so an event inside it is not necessarily an '
    + 'event affecting the port.',
  timeZone: 'America/New_York',
});

export const DEFAULT_REGION = PORTMIAMI_REGION;
