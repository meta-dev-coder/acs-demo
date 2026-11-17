/**
 * The PortMiami infrastructure registry — the verified seed.
 *
 * This file is the one place a named asset enters the application. It is deliberately SEPARATE
 * from the road and building GeoJSON: no GIS attribute is edited to carry an asset identity, and
 * an asset never holds a GIS OBJECTID as its own key. Links between the two live in
 * src/infrastructure/assetLinks.js and are stored apart from both.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT IS AND IS NOT VERIFIED HERE
 *
 * Every name, designation, operator and street address below was read off an official
 * Miami-Dade County PortMiami page on 2026-11-13, and each asset cites the page it came from.
 *
 * NO ASSET HAS A SOURCED COORDINATE. None of the official pages publishes one, and the county's
 * public GIS has no PortMiami facility layer — the nearest candidates are a 1999 county-wide
 * "Ports" point layer and an intranet-only seaport layer, neither of which is a terminal
 * inventory. So `location.status` is:
 *
 *   SOURCED  — a coordinate taken from a cited source.            (used by nothing today)
 *   DERIVED  — interpolated from a verified STREET ADDRESS against the address ranges in the
 *              county's own road centreline file. Provisional, and labelled as such.
 *   UNKNOWN  — the name is verified, the location is not. The asset still exists; the map simply
 *              refuses to fly anywhere for it.
 *
 * Nothing here records a parking capacity, floor count, building height, berth assignment or
 * access relationship, because no cited source states one.
 * ------------------------------------------------------------------------------------------
 */

/** @typedef {'VERIFIED'|'PROVISIONAL'|'UNVERIFIED'} VerificationStatus */

export const ASSET_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'CRUISE_TERMINAL', label: 'Cruise terminal', group: 'CRUISE' }),
  Object.freeze({ id: 'PARKING', label: 'Parking', group: 'PARKING' }),
  Object.freeze({ id: 'CARGO_TERMINAL', label: 'Cargo terminal', group: 'CARGO' }),
  Object.freeze({ id: 'ADMINISTRATION', label: 'Administration', group: 'OTHER' }),
  Object.freeze({ id: 'TUNNEL', label: 'Tunnel', group: 'TRANSPORT' }),
  Object.freeze({ id: 'BRIDGE', label: 'Bridge', group: 'TRANSPORT' }),
]);

/**
 * How firmly a published capacity is established.
 *
 * VERIFIED is reserved for a figure read directly from a cited source. A number supplied by the
 * project team that could not be found in the document it was attributed to is REPORTED — usable,
 * clearly labelled, and never shown as though the source confirmed it.
 */
export const CAPACITY_VERIFICATION = Object.freeze({
  VERIFIED: 'VERIFIED',
  REPORTED: 'REPORTED',
  NONE: 'NONE',
});

export const CAPACITY_VERIFICATION_LABEL = Object.freeze({
  VERIFIED: 'Read from the cited source',
  REPORTED: 'Reported to the project — not confirmed in the cited source',
  NONE: 'No published capacity',
});

/**
 * Port-wide parking capacity, from the MDTPO study's own text.
 *
 * These two ARE verifiable: the report states them in prose, and the extracted text carries them.
 * They are the only parking-capacity figures in it that a machine can read — Table 1-3 "Port
 * Parking Facilities", where any per-garage count would live, is an embedded image.
 */
/**
 * Table 1-3 "Port Parking Facilities", PortMiami 2050 Master Plan (2024).
 *
 * Read from the table, facility by facility. The rows sum to the table's own stated total of
 * 10,842, which is the check that the transcription is complete — a test asserts it.
 *
 * Two rows are NOT registry assets and are carried here only so the total reconciles: RCG, and
 * the combined "Under Bridge / Admin and Tenant Lots". Garage AA and Surface Lot C do not appear
 * in the table at all, so they keep no published capacity rather than being given one.
 */
export const TABLE_1_3 = Object.freeze({
  sourceId: 'portmiami-2050-master-plan',
  statedTotal: 10842,
  rows: Object.freeze([
    Object.freeze({ type: 'Garage', facility: 'A', spaces: 1046, uses: 'Cruise', assetId: 'parking-garage-a' }),
    Object.freeze({ type: 'Garage', facility: 'B', spaces: 809, uses: 'Cruise / Govt Agency', assetId: 'parking-garage-b' }),
    Object.freeze({ type: 'Garage', facility: 'C', spaces: 1355, uses: 'Cruise / Port staff', assetId: 'parking-garage-c' }),
    Object.freeze({ type: 'Garage', facility: 'D', spaces: 822, uses: 'Cruise / Govt Agency', assetId: 'parking-garage-d' }),
    // The table labels this row "V-G"; the county parking page calls the facility Garage G.
    Object.freeze({ type: 'Garage', facility: 'V-G', spaces: 1735, uses: 'Cruise / Tenants', assetId: 'parking-garage-g' }),
    Object.freeze({ type: 'Garage', facility: 'J', spaces: 703, uses: 'Cruise', assetId: 'parking-garage-j' }),
    Object.freeze({ type: 'Garage', facility: 'K', spaces: 2218, uses: 'Tenants / Cruise', assetId: 'parking-garage-k' }),
    Object.freeze({ type: 'Surface Lot', facility: 'D', spaces: 135, uses: 'Cruise / Govt Agency', assetId: 'parking-surface-lot-d' }),
    Object.freeze({ type: 'Surface Lot', facility: 'E', spaces: 511, uses: 'Cruise', assetId: 'parking-surface-lot-e' }),
    Object.freeze({ type: 'Surface Lot', facility: 'RCG', spaces: 1173, uses: 'Tenants', assetId: null }),
    Object.freeze({ type: 'Surface Lot', facility: 'Under Bridge / Admin and Tenant Lots', spaces: 335, uses: 'POM / Visitor', assetId: null }),
  ]),
});

/** The published capacity for one registry asset, or null where the table does not list it. */
export const publishedCapacityFor = assetId => {
  const row = TABLE_1_3.rows.find(entry => entry.assetId === assetId);
  if (!row) return null;
  return Object.freeze({
    spaces: row.spaces,
    verification: 'VERIFIED',
    sourceId: TABLE_1_3.sourceId,
    asOf: '2024',
    uses: row.uses,
    note: `Read from Table 1-3 "Port Parking Facilities" in the PortMiami 2050 Master Plan (2024), `
      + `row "${row.facility}" (${row.type}), used for ${row.uses}.`
      + (row.facility === 'V-G'
        ? ' The table labels this row “V-G”; the county parking page calls the facility Garage G.'
        : ''),
  });
};

export const PORT_PARKING_TOTALS = Object.freeze({
  todaySpaces: 10000,
  todayQualifier: 'more than',
  todayQuote: 'There are more than 10,000 public parking spaces at the Port for cruise ship '
    + 'passengers, visitors, and employees to use (Table 1-3).',
  forecast2050Low: 13000,
  forecast2050High: 17000,
  forecastQuote: 'The Master Plan estimates that by 2050 the Port will need a total of between '
    + '13,000 and 17,000 parking spaces to meet demand.',
  sourceId: 'mdtpo-port-mia-transit',
});

/** The filter groups the explorer offers, in order. */
export const ASSET_GROUPS = Object.freeze([
  Object.freeze({ id: 'ALL', label: 'All assets' }),
  Object.freeze({ id: 'CRUISE', label: 'Cruise terminals' }),
  Object.freeze({ id: 'PARKING', label: 'Parking' }),
  Object.freeze({ id: 'CARGO', label: 'Cargo' }),
  Object.freeze({ id: 'TRANSPORT', label: 'Transportation' }),
  Object.freeze({ id: 'OTHER', label: 'Other facilities' }),
]);

/** Every source cited below, once. `retrieved` is the day the page was read. */
export const ASSET_SOURCES = Object.freeze({
  'mdc-cruise-terminals': Object.freeze({
    id: 'mdc-cruise-terminals',
    title: 'Cruise Terminals — PortMiami',
    publisher: 'Miami-Dade County',
    url: 'https://www.miamidade.gov/portmiami/cruise-terminals.page',
    retrieved: '2026-11-13',
    authority: 'OFFICIAL',
  }),
  'portmiami-2050-master-plan': Object.freeze({
    id: 'portmiami-2050-master-plan',
    title: 'PortMiami 2050 Master Plan — Table 1-3 Port Parking Facilities',
    publisher: 'PortMiami (Miami-Dade County)',
    url: 'https://www.miamidadetpo.org/library/studies/mdtpo-feasibility-of-implementing-direct-transit-service-connecting-mia-with-portmiami-final-report-2025-09.pdf',
    retrieved: '2026-11-17',
    published: '2024',
    authority: 'OFFICIAL',
    note: 'Capacity per facility is read from Table 1-3, reproduced in the MDTPO PortMiami–MIA '
      + 'transit study (September 2025). The table is an image in that PDF, so the figures were '
      + 'read from the table itself rather than extracted from the document text.',
  }),
  'mdtpo-port-mia-transit': Object.freeze({
    id: 'mdtpo-port-mia-transit',
    title: 'Feasibility of Implementing Direct Transit Service Connecting MIA with PortMiami — Final Report',
    publisher: 'Miami-Dade Transportation Planning Organization',
    url: 'https://www.miamidadetpo.org/library/studies/mdtpo-feasibility-of-implementing-direct-transit-service-connecting-mia-with-portmiami-final-report-2025-09.pdf',
    retrieved: '2026-11-17',
    published: '2025-09',
    authority: 'OFFICIAL',
  }),
  'mdc-parking': Object.freeze({
    id: 'mdc-parking',
    title: 'Parking at PortMiami',
    publisher: 'Miami-Dade County',
    url: 'https://www.miamidade.gov/portmiami/parking-information.page',
    retrieved: '2026-11-13',
    authority: 'OFFICIAL',
  }),
  'mdc-container-terminals': Object.freeze({
    id: 'mdc-container-terminals',
    title: 'Container Terminals — PortMiami',
    publisher: 'Miami-Dade County',
    url: 'https://miamidade.gov/portmiami/container-terminals.asp',
    retrieved: '2026-11-13',
    authority: 'OFFICIAL',
  }),
  'mdc-port-map': Object.freeze({
    id: 'mdc-port-map',
    title: 'PortMiami map (PDF)',
    publisher: 'Miami-Dade County',
    url: 'https://www.miamidade.gov/portmiami/library/portmiami-map.pdf',
    retrieved: '2026-11-13',
    authority: 'OFFICIAL',
  }),
  'mdc-cruise-street-map': Object.freeze({
    id: 'mdc-cruise-street-map',
    title: 'PortMiami Cruise Guide Street Map (PDF)',
    publisher: 'Miami-Dade County',
    url: 'https://www.miamidade.gov/resources-port/documents/portmiami-cruise-guide-street-map.pdf',
    retrieved: '2026-11-16',
    /**
     * The map's own legend carries "Revised February 13, 2026", so the addresses below are the
     * county's as of that date rather than as of the day the file was downloaded.
     */
    revised: '2026-02-13',
    authority: 'OFFICIAL',
  }),
  'wikipedia-port-miami-tunnel': Object.freeze({
    id: 'wikipedia-port-miami-tunnel',
    title: 'Port Miami Tunnel',
    publisher: 'Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Port_Miami_Tunnel',
    retrieved: '2026-11-13',
    // Not an official publisher. Everything sourced only to it is PROVISIONAL, never VERIFIED.
    authority: 'SECONDARY',
  }),
  'aaroads-sr886': Object.freeze({
    id: 'aaroads-sr886',
    title: 'State Road 886 — Port Boulevard',
    publisher: 'AARoads',
    url: 'https://www.aaroads.com/guides/fl-886',
    retrieved: '2026-11-13',
    authority: 'SECONDARY',
  }),
});

const unknownLocation = Object.freeze({ status: 'UNKNOWN', latitude: null, longitude: null, basis: null });

/**
 * Operational state, recorded SEPARATELY from whether the asset itself is verified.
 *
 * The two are different questions and conflating them is how a registry starts lying: Terminal G
 * is a fully verified asset — the county names it, gives it an address and puts it on its own map
 * — and it is simultaneously a building site. `verificationStatus` answers "is this a real, named
 * facility"; `operationalStatus` answers "is it in service", and the two never overwrite each
 * other.
 *
 * Nothing here is inferred. A terminal is only OPEN where a source states a date that has passed,
 * only UNDER_CONSTRUCTION where a source says so, and LISTED otherwise — which means "the county
 * lists it as a terminal and neither source read says anything about its current service".
 */
export const OPERATIONAL_STATUS = Object.freeze({
  OPEN: 'OPEN',
  UNDER_CONSTRUCTION: 'UNDER_CONSTRUCTION',
  LISTED: 'LISTED',
  UNKNOWN: 'UNKNOWN',
});

export const OPERATIONAL_STATUS_LABELS = Object.freeze({
  OPEN: 'Open',
  UNDER_CONSTRUCTION: 'Under construction',
  LISTED: 'Listed, service state not stated',
  UNKNOWN: 'Not stated by any source read',
});

const operational = (state, basis, sourceId) => Object.freeze({ state, basis, source: sourceId });

/**
 * Parking rules that apply to EVERY facility, held once rather than copied onto eleven records.
 *
 * All of it is from the county parking page, quoted or closely paraphrased. Where the page says
 * nothing, `null` is recorded and the UI prints "not published" — a gap stated is worth more than
 * a gap hidden, and several of these are things a traveller will go looking for.
 */
export const PARKING_POLICIES = Object.freeze({
  payment: Object.freeze({
    accepted: Object.freeze(['Cash', 'Visa', 'MasterCard', 'American Express', 'Discover',
      "Any major U.S. Traveler's Check"]),
    /** Called out separately because it is the one that strands people at the exit. */
    notAccepted: Object.freeze(['Debit cards']),
  }),
  hours: Object.freeze({
    cruiseDays: 'All garages are open and staffed by a parking attendant from 6 a.m. to 5 p.m.',
    nonCruiseDays: 'Contact PortMiami Cruise Operations or Port Security.',
    nonCruiseDaysPhone: '305-347-4800',
  }),
  shuttle: Object.freeze({
    available: 'Free shuttle service is available only on cruise days.',
    // The page names no operator, route, schedule or pickup point.
    operator: null, routes: null, schedule: null,
  }),
  security: 'All facilities are patrolled by security.',
  accessibility: Object.freeze({
    designatedSpaces: 'Designated disabled permit parking spaces are available in every garage.',
    complimentary: 'Vehicles displaying a disabled permit or licence tag receive two hours of '
      + 'complimentary parking; standard rates apply beyond that except as Florida law provides.',
    statutoryExemptions: Object.freeze([
      'Florida Statute 316.1964 — vehicles with specialised equipment (ramps, lifts, or hand or '
      + 'foot controls) and certain disabled veterans\u2019 plates are exempt from parking charges.',
      'Florida Statute 320.084 — disabled veterans with the Florida plate park free. The veteran '
      + 'must be in the vehicle, and the exit process requires the ticket, driver\u2019s licence '
      + 'and registration, plus a short form.',
    ]),
  }),
  disputes: Object.freeze({
    note: 'Invalid parking transactions can be disputed online, with supporting documents uploaded.',
    url: 'https://www.miamidade.gov/Apps/Seaport/TransactionDispute',
  }),
  garageMapUrl: 'https://www.miamidade.gov/resources-port/documents/portmiami-garages-map.pdf',
  /**
   * What the page does NOT publish. Listed because these are the questions people actually ask,
   * and "we checked and the county does not say" is an answer; silence is not.
   */
  notPublished: Object.freeze([
    'Capacity \u2014 no garage or lot has a published space count.',
    'Car rental companies, desks or shuttles \u2014 the parking page names none.',
    'Electric-vehicle charging.',
    'Valet parking.',
    'Shuttle operator, route, schedule or pickup points.',
    'Reservations for any facility except Garages A and B.',
  ]),
});

/**
 * Rate schedules, named because several facilities share one.
 *
 * The page's shared schedule is headed "Garages C, D, F, G, and Surface Lot E". There is no
 * Garage F in its own address list, nor on the cruise street map, so `SHARED` records the heading
 * verbatim in `appliesToText` and is attached only to the facilities that actually exist. A
 * Garage F is not invented here on the strength of one heading.
 */
export const PARKING_RATES = Object.freeze({
  SHARED: Object.freeze({
    id: 'SHARED',
    appliesToText: 'Garages C, D, F, G, and Surface Lot E',
    lines: Object.freeze([
      Object.freeze({ label: 'Short term (no overnight)', amount: '$10 per vehicle, per space, per day or fraction' }),
      Object.freeze({ label: 'Long term (overnight or greater)', amount: '$28 per vehicle, per space, per day or fraction' }),
      Object.freeze({ label: 'High-density long term', amount: '$28 per vehicle, per space, per day or fraction' }),
      Object.freeze({ label: 'Special events', amount: 'No less than $15 per vehicle, per space' }),
      Object.freeze({ label: 'Lost ticket (equivalent to an 11-day cruise)', amount: 'Up to $275 per vehicle, per space' }),
      Object.freeze({ label: 'Crew member parking', amount: '$50 per week' }),
    ]),
  }),
  GARAGE_AA: Object.freeze({
    id: 'GARAGE_AA',
    appliesToText: 'Garage AA',
    lines: Object.freeze([
      Object.freeze({ label: 'Short term (no overnight)', amount: '$20 per vehicle, per space, per day' }),
      Object.freeze({ label: 'Long term (overnight or greater)', amount: '$35 per day' }),
    ]),
  }),
  GARAGE_B: Object.freeze({
    id: 'GARAGE_B',
    appliesToText: 'Garage B',
    lines: Object.freeze([
      Object.freeze({ label: 'All parking', amount: '$35 per vehicle, per space, per day', effective: '2025-01-01' }),
    ]),
  }),
  /** Surface Lot E only. The one place the port publishes an oversized-vehicle rate. */
  OVERSIZED: Object.freeze({
    id: 'OVERSIZED',
    appliesToText: 'Surface Lot E, oversized vehicles',
    lines: Object.freeze([
      Object.freeze({ label: 'Oversized vehicle (one space)', amount: '$25 per space, per day' }),
      Object.freeze({ label: 'Oversized vehicle (two spaces)', amount: '$50 per day' }),
    ]),
  }),
  /** Garage A publishes no rate on the county page; it sends the reader to its operator. */
  EXTERNAL: Object.freeze({
    id: 'EXTERNAL',
    appliesToText: 'Published by the garage operator, not by the county',
    lines: Object.freeze([]),
  }),
});

/** Feet-and-inches as the page prints it, plus the number a driver actually needs. */
const feetInches = text => {
  const m = /^(\d+)'(?:\s*(\d+)")?$/.exec(String(text ?? '').trim());
  return m ? Number(m[1]) * 12 + Number(m[2] ?? 0) : null;
};

/**
 * A garage's posted clearances. `null` for a floor the page does not list — Garage AA has no
 * first-floor entry and Garage B no second-floor entry, and neither absence is filled in.
 *
 * `lowestInches` is the number that decides whether a vehicle can use the garage at all, derived
 * from whichever floors ARE published. It is a minimum over what is known, not over what exists.
 */
const clearance = (firstFloor, secondFloor, remainingFloors) => {
  const known = [firstFloor, secondFloor, remainingFloors].map(feetInches).filter(Number.isFinite);
  return Object.freeze({
    firstFloor: firstFloor ?? null,
    secondFloor: secondFloor ?? null,
    remainingFloors: remainingFloors ?? null,
    lowestInches: known.length ? Math.min(...known) : null,
    openAir: false,
  });
};

/** An open lot has no overhead structure, which is different from a clearance nobody published. */
const openAir = Object.freeze({
  firstFloor: null, secondFloor: null, remainingFloors: null, lowestInches: null, openAir: true,
});

/** A street address that the county's road file can geocode. */
const addr = (house, street) => Object.freeze({ house, street });

/**
 * The registry.
 *
 * `sources` lists source ids; `supports` says, per asset, exactly which claim each source backs —
 * the spec's "record its source and the specific information that the source supports".
 */
export const INFRASTRUCTURE_ASSETS = Object.freeze([
  // ---- Cruise terminals ------------------------------------------------------------------
  //
  // Names, operators, sizes and dates: the county's Cruise Terminals page.
  // Street addresses: the county's Cruise Guide Street Map (PDF), whose legend pairs every
  // terminal with an address and is marked "Revised February 13, 2026". The terminals page itself
  // publishes NO address and NO coordinate, which is why the registry carried none until now.
  //
  // No latitude/longitude is written down here. Neither source publishes one. A terminal's
  // position is derived at runtime by geocoding the address below against the county road file,
  // and a derived point is a point on the street, not a survey of the building — see
  // src/infrastructure/assetGeocode.js and the README.
  ...[
    { code: 'AA', name: 'Cruise Terminal AA', operator: 'MSC Cruises',
      house: 2200, street: 'N CRUISE BLVD', addressText: '2200 N Cruise Blvd',
      facility: { floorAreaSqFt: 490000, levels: 4, ships: 'Accommodates up to three ships',
        leed: 'Gold certification in process', opened: 2025 },
      description: 'Opened 2025. The county page states 490,000 sq ft over four levels, accommodating up to three ships.',
      status: ['OPEN', 'The county page states it opened in 2025.', 'mdc-cruise-terminals'] },
    { code: 'A', name: 'Cruise Terminal A — The Crown of Miami', operator: 'Royal Caribbean International',
      house: 2000, street: 'N CRUISE BLVD', addressText: '2000 N Cruise Blvd',
      facility: { floorAreaSqFt: 170000, leed: 'Silver', opened: 2018 },
      description: 'Opened 2018. The county page states 170,000 sq ft.',
      status: ['OPEN', 'The county page states it opened in 2018.', 'mdc-cruise-terminals'] },
    { code: 'B', name: 'Cruise Terminal B — The Pearl of Miami', operator: 'Norwegian Cruise Line',
      house: 1761, street: 'N CRUISE BLVD', addressText: '1761 N Cruise Blvd',
      facility: { floorAreaSqFt: 190000, leed: 'Gold' },
      description: 'The county page states 190,000 sq ft and LEED Gold certification, but gives no opening date.',
      status: ['LISTED', 'Listed on the street map with an address; neither source states an opening date or a current service state.', 'mdc-cruise-street-map'] },
    { code: 'C', name: 'Cruise Terminal C', operator: null,
      // The map prints "1741/1751 N Cruise Blvd" — two house numbers for one terminal. Recorded
      // verbatim in `addressText`; `house` takes the first, and both fall inside the same road
      // segment's range (1701–1753 of N CRUISE BLVD), so the choice does not move the point far.
      house: 1741, street: 'N CRUISE BLVD', addressText: '1741/1751 N Cruise Blvd',
      facility: {},
      description: 'Serves ships from several cruise lines; the county page does not name them.',
      status: ['LISTED', 'Listed on the street map with an address; the terminals page describes it serving several lines but states no date.', 'mdc-cruise-street-map'] },
    { code: 'D', name: 'Cruise Terminal D', operator: 'Carnival Cruise Line',
      house: 1435, street: 'N CRUISE BLVD', addressText: '1435 N Cruise Blvd',
      // 471,000 sq ft is the county's figure for D, E and F TOGETHER. It is carried as a combined
      // figure on all three rather than assigned to each, which would treble the real area.
      facility: { combinedFloorAreaSqFt: 471000,
        combinedWith: 'Terminals D, E and F together', leed: 'Silver', expanded: 2018 },
      description: 'Expanded 2018. The county page describes terminals D, E and F together as 471,000 sq ft.',
      status: ['OPEN', 'The county page states it was expanded in 2018.', 'mdc-cruise-terminals'] },
    { code: 'E', name: 'Cruise Terminal E', operator: 'Carnival Cruise Line',
      house: 1265, street: 'N CRUISE BLVD', addressText: '1265 N Cruise Blvd',
      facility: { combinedFloorAreaSqFt: 471000,
        combinedWith: 'Terminals D, E and F together', leed: 'Silver', expanded: 2018 },
      description: 'Expanded 2018. The county page describes terminals D, E and F together as 471,000 sq ft.',
      status: ['OPEN', 'The county page states it was expanded in 2018.', 'mdc-cruise-terminals'] },
    { code: 'F', name: 'Cruise Terminal F', operator: 'Carnival Cruise Line',
      house: 1103, street: 'N CRUISE BLVD', addressText: '1103 N Cruise Blvd',
      facility: { combinedFloorAreaSqFt: 471000,
        combinedWith: 'Terminals D, E and F together', leed: 'Silver', renovated: 2022 },
      // The map carries a SECOND entry, "Cruise Terminal F - East Ext", at "1103 N Cruise Blvd -
      // East Ext". It is an extension of F rather than an eleventh terminal, so it is not a
      // separate asset; if it has its own footprint, link it to F as a secondary footprint.
      description: 'Renovated 2022. The county page describes terminals D, E and F together as 471,000 sq ft. The street map also lists a "Cruise Terminal F - East Ext" at the same address.',
      status: ['OPEN', 'The county page states it was renovated in 2022.', 'mdc-cruise-terminals'] },
    { code: 'G', name: 'Cruise Terminal G', operator: 'Royal Caribbean International',
      house: 909, street: 'N CRUISE BLVD', addressText: '909 N Cruise Blvd',
      facility: { constructionFrom: 'Summer 2025', openingExpected: 2027 },
      description: 'The county page states construction beginning summer 2025 and opening expected 2027, at the west end of PortMiami.',
      // Both sources agree, and the map prints the words on the terminal itself.
      status: ['UNDER_CONSTRUCTION', 'The street map labels it "Cruise Terminal G (under construction)"; the terminals page states construction from summer 2025 and opening expected 2027.', 'mdc-cruise-street-map'] },
    { code: 'J', name: 'Cruise Terminal J', operator: null,
      house: 1120, street: 'CARIBBEAN WAY', addressText: '1120 Caribbean Way',
      facility: { role: 'Boutique terminal for small vessels and luxury cruises' },
      description: 'A boutique terminal for small vessels and luxury cruises, per the county page.',
      status: ['LISTED', 'Listed on the street map with an address; neither source states a date or a current service state.', 'mdc-cruise-street-map'] },
    { code: 'V', name: 'Cruise Terminal V', operator: 'Virgin Voyages',
      house: 718, street: 'W CRUISE BLVD', addressText: '718 W Cruise Blvd',
      facility: { floorAreaSqFt: 100000, levels: 3, leed: 'Gold', opened: 2022 },
      description: 'Opened 2022. The county page states 100,000 sq ft over three stories.',
      status: ['OPEN', 'The county page states it opened in 2022.', 'mdc-cruise-terminals'] },
  ].map(t => ({
    id: `terminal-${t.code.toLowerCase()}`,
    name: t.name,
    code: t.code,
    category: 'CRUISE_TERMINAL',
    description: t.description,
    operator: t.operator,
    location: unknownLocation,
    verificationStatus: 'VERIFIED',
    operationalStatus: operational(t.status[0], t.status[1], t.status[2]),
    sources: ['mdc-cruise-terminals', 'mdc-cruise-street-map'],
    supports: {
      'mdc-cruise-terminals': 'Terminal designation, operator, and the quoted size and dates. The page publishes no address and no coordinate.',
      'mdc-cruise-street-map': `Street address "${t.addressText}", from the map legend (revised 13 February 2026). The map publishes no coordinate.`,
    },
    attributes: {
      address: addr(t.house, t.street),
      addressText: t.addressText,
      /** A terminal is a building, so its address can be read onto a footprint. See `structure`
       *  on the parking records for what the flag is for. */
      structure: 'BUILDING',
      /** Size, certification and dates, exactly as the county terminals page states them. */
      facility: Object.freeze(t.facility ?? {}),
      /** A terminal has the parking that serves it; the link is resolved from the parking side. */
      servesAssetIds: [],
    },
  })),

  // ---- Parking ---------------------------------------------------------------------------
  //
  // Addresses, clearances, rates, contacts and reservation links all come from the county parking
  // page; the cruise street map corroborates the addresses and supplies the one the parking page
  // writes without its "N". Capacity is published by neither, so no facility carries one.
  ...[
    { code: 'AA', kind: 'Garage', house: 2200, street: 'N CRUISE BLVD', serves: ['terminal-aa'],
      // The page's clearance table has no first-floor entry for AA.
      clearance: clearance(null, "7'", "7'"), rates: 'GARAGE_AA', phone: '(888) 264-1002',
      phoneNote: 'Parking inquiries. The page also shows an email address, but it is obfuscated and cannot be read from the page.' },
    { code: 'A', kind: 'Garage', house: 2000, street: 'N CRUISE BLVD', serves: ['terminal-a'],
      clearance: clearance("7'2\"", "8'", "7'2\""), rates: 'EXTERNAL',
      operatorNote: 'The page labels this garage Royal Caribbean and sends rate and reservation questions to the garage operator.',
      reservations: { operator: 'Royal Miami Parking', url: 'https://www.royalmiamiparking.com/' } },
    { code: 'B', kind: 'Garage', house: 1756, street: 'N CRUISE BLVD', serves: ['terminal-b'],
      // No second-floor entry in the page's table.
      clearance: clearance("7'6\"", null, "7'6\""), rates: 'GARAGE_B', phone: '800-392-1899',
      operatorNote: 'The page labels this garage Norwegian Cruise Line.',
      reservations: { operator: 'ParkWhiz (Norwegian Cruise Line)', url: 'https://www.parkwhiz.com/norwegian-cruise-terminal-miami-parking/' } },
    { code: 'C', kind: 'Garage', house: 1648, street: 'N CRUISE BLVD', serves: ['terminal-c'],
      clearance: clearance("9'", null, "6'10\""), rates: 'SHARED' },
    // The parking page writes this one "1400 Cruise Blvd." — without the N — and the road file
    // carries no address ranges on the segments named CRUISE BLVD, so that form does not geocode.
    // The cruise street map, also official, prints "Garage D  1400 N Cruise Blvd", and the parking
    // page itself writes the N for SURFACE LOT D at the same number. Two official sources supply
    // the prefix, so the address is corrected rather than left unusable.
    { code: 'D', kind: 'Garage', house: 1400, street: 'N CRUISE BLVD', serves: ['terminal-d'],
      mapAddress: '1400 N Cruise Blvd',
      clearance: clearance("8'2\"", null, "6'8\""), rates: 'SHARED' },
    { code: 'G', kind: 'Garage', house: 921, street: 'N AMERICA WAY', serves: ['terminal-f', 'terminal-g', 'terminal-v'],
      clearance: clearance("9'6\"", null, "6'11\""), rates: 'SHARED' },
    { code: 'J', kind: 'Garage', house: 1122, street: 'CARIBBEAN WAY', serves: ['terminal-j'],
      clearance: clearance("8'2\"", null, "6'10\""), rates: null,
      ratesNote: 'The page lists a clearance for Garage J but no rate schedule.' },
    { code: 'K', kind: 'Garage', house: 1124, street: 'CARIBBEAN WAY', serves: ['terminal-j'],
      clearance: clearance("8'2\"", null, "8'2\""), rates: null,
      ratesNote: 'The page lists a clearance for Garage K but no rate schedule.' },
    { code: 'C', kind: 'Surface Lot', house: 1720, street: 'AFRICA WAY', serves: [],
      clearance: null, rates: null,
      ratesNote: 'The page gives this lot an address only — no terminal, clearance or rate.' },
    { code: 'D', kind: 'Surface Lot', house: 1400, street: 'N CRUISE BLVD', serves: ['terminal-d'],
      clearance: null, rates: null,
      ratesNote: 'The page gives this lot an address only; its rates are not listed separately from Garage D\u2019s.' },
    { code: 'E', kind: 'Surface Lot', house: 625, street: 'FLORIDA WAY', serves: ['terminal-e'],
      // An open lot: no overhead structure at all, which is not the same as an unpublished height.
      clearance: openAir, rates: 'SHARED',
      oversized: {
        accepted: 'Accommodates oversized vans, recreational vehicles and vehicles with trailers.',
        note: 'Designated spaces at special rates.',
        rates: 'OVERSIZED',
        phones: ['305-960-5463', '305-960-6454'],
      } },
  ].map(p => ({
    id: `parking-${p.kind.toLowerCase().replace(/\s+/g, '-')}-${p.code.toLowerCase()}`,
    name: `${p.kind} ${p.code}`,
    code: p.code,
    category: 'PARKING',
    description: p.serves.length
      ? `The county parking page lists this facility as serving ${p.serves.length} cruise terminal(s).`
      : 'The county parking page lists this facility without naming the terminal it serves.',
    operator: 'PortMiami (Miami-Dade County)',
    location: unknownLocation,
    verificationStatus: 'VERIFIED',
    /** A car park is either open or it is not; the page states no closure, so none is claimed. */
    operationalStatus: operational('LISTED',
      'Listed on the county parking page with an address; the page states no closure or opening date.',
      'mdc-parking'),
    sources: [
      'mdc-parking',
      ...(p.mapAddress ? ['mdc-cruise-street-map'] : []),
      ...(publishedCapacityFor(`parking-${p.kind.toLowerCase().replace(/\s+/g, '-')}-${p.code.toLowerCase()}`)
        ? [TABLE_1_3.sourceId] : []),
    ],
    supports: {
      'mdc-parking': `Facility designation, the street address, and the clearance, rate, contact and reservation details recorded here. The page publishes no coordinate and no capacity.`,
      ...((cap => (cap ? {
        [cap.sourceId]: `Published capacity of ${cap.spaces.toLocaleString()} spaces. ${cap.note}`,
      } : {}))(publishedCapacityFor(`parking-${p.kind.toLowerCase().replace(/\s+/g, '-')}-${p.code.toLowerCase()}`))),
      ...(p.mapAddress ? { 'mdc-cruise-street-map': `Street address "${p.mapAddress}" \u2014 the parking page writes the same number without the "N", which does not geocode.` } : {}),
    },
    attributes: {
      address: addr(p.house, p.street),
      addressText: p.mapAddress ?? `${p.house} ${p.street}`,
      servesAssetIds: p.serves,
      /**
       * Does this facility have a building footprint at all? A garage is a structure and can be
       * expected to appear in the county's building extract; a surface lot is painted asphalt and
       * never will. The distinction stops the frontage reading (src/infrastructure/assetFrontage.js)
       * from putting a lot's marker on whichever neighbouring building its address faces.
       */
      structure: p.kind === 'Garage' ? 'BUILDING' : 'OPEN_LOT',
      clearance: p.clearance ?? null,
      rateScheduleId: p.rates ?? null,
      ratesNote: p.ratesNote ?? null,
      reservations: p.reservations ?? null,
      phone: p.phone ?? null,
      phoneNote: p.phoneNote ?? null,
      operatorNote: p.operatorNote ?? null,
      oversizedVehicles: p.oversized ?? null,
      /**
       * Published capacity, as an asset-level record rather than a number inside a formula.
       * `null` where no source publishes one, which is the case for every facility but Garage A —
       * the county parking page states no space count at all.
       */
      // From Table 1-3, by asset id. Null for a facility the table does not list.
      capacity: publishedCapacityFor(`parking-${p.kind.toLowerCase().replace(/\s+/g, '-')}-${p.code.toLowerCase()}`),
    },
  })),

  // ---- Cargo terminal operators. Named by the county; no address or berth published. ----
  ...[
    { id: 'cargo-seaboard', name: 'Seaboard Marine', operator: 'Seaboard Marine' },
    { id: 'cargo-pomtoc', name: 'Port of Miami Terminal Operating Company (POMTOC)', operator: 'POMTOC' },
    { id: 'cargo-sfct', name: 'South Florida Container Terminal, LLC', operator: 'South Florida Container Terminal, LLC' },
  ].map(c => ({
    id: c.id,
    name: c.name,
    code: null,
    category: 'CARGO_TERMINAL',
    description: 'Named by Miami-Dade County as a PortMiami container terminal operator. PortMiami is a landlord port and leases to its terminal operators.',
    operator: c.operator,
    location: unknownLocation,
    verificationStatus: 'VERIFIED',
    sources: ['mdc-container-terminals'],
    supports: {
      'mdc-container-terminals': 'That this company operates a container terminal at PortMiami. The page publishes no address, berth numbers or coordinate.',
    },
    attributes: { address: null },
  })),

  // ---- Administration ----
  {
    id: 'admin-portmiami',
    name: 'PortMiami Administration Buildings',
    code: null,
    category: 'ADMINISTRATION',
    description: 'The county PortMiami map labels "PM Admin Buildings" at 1001, 1007 and 1015 N America Way.',
    operator: 'PortMiami (Miami-Dade County)',
    location: unknownLocation,
    verificationStatus: 'VERIFIED',
    sources: ['mdc-port-map'],
    supports: {
      'mdc-port-map': 'The label "PM Admin Buildings" and the address range 1001–1015 N America Way. The map publishes no coordinate.',
    },
    attributes: {
      address: addr(1015, 'N AMERICA WAY'),
      addressRange: '1001, 1007 and 1015 N America Way',
      structure: 'BUILDING',
    },
  },

  // ---- Transportation. Both are PROVISIONAL: only secondary sources back them. ----
  {
    id: 'portmiami-tunnel',
    name: 'PortMiami Tunnel',
    code: 'SR 887',
    category: 'TUNNEL',
    description: 'Twin bored tunnels linking Watson Island and Dodge Island, opened 3 August 2014 and maintained by FDOT. Reported as State Road 887.',
    operator: 'Florida Department of Transportation',
    location: unknownLocation,
    // No official FDOT page was read, so this stays PROVISIONAL however plausible it is.
    verificationStatus: 'PROVISIONAL',
    sources: ['wikipedia-port-miami-tunnel'],
    supports: {
      'wikipedia-port-miami-tunnel': 'The SR 887 designation, FDOT maintenance, the 2014 opening and the Watson Island–Dodge Island portals. Secondary source; not confirmed against an FDOT publication.',
    },
    attributes: { address: null, stateRoad: 'SR 887', roadNameInGis: 'PORT MIAMI TUNNEL' },
  },
  {
    id: 'port-boulevard-bridge',
    name: 'Port Boulevard Bridge',
    code: 'SR 886',
    category: 'BRIDGE',
    description: 'Carries Port Boulevard (State Road 886) over the Intracoastal Waterway from Biscayne Boulevard to Dodge Island. Opened 1991, replacing an adjacent bascule bridge.',
    operator: null,
    location: unknownLocation,
    verificationStatus: 'PROVISIONAL',
    sources: ['aaroads-sr886'],
    supports: {
      'aaroads-sr886': 'The SR 886 designation, the Biscayne Boulevard to Dodge Island routing and the 1991 opening. Secondary source; no official name for the structure was found.',
    },
    attributes: { address: null, stateRoad: 'SR 886', roadNameInGis: 'PORT BLVD' },
  },
]);
