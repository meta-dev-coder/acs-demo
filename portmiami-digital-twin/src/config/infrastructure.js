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

/** A street address that the county's road file can geocode. */
const addr = (house, street) => Object.freeze({ house, street });

/**
 * The registry.
 *
 * `sources` lists source ids; `supports` says, per asset, exactly which claim each source backs —
 * the spec's "record its source and the specific information that the source supports".
 */
export const INFRASTRUCTURE_ASSETS = Object.freeze([
  // ---- Cruise terminals. Names, operators and the stated sizes are from the county page. ----
  ...[
    { code: 'AA', name: 'Cruise Terminal AA', operator: 'MSC Cruises',
      description: 'Opened 2025. The county page states 490,000 sq ft over four levels, accommodating up to three ships.' },
    { code: 'A', name: 'Cruise Terminal A — The Crown of Miami', operator: 'Royal Caribbean International',
      description: 'Opened 2018. The county page states 170,000 sq ft.' },
    { code: 'B', name: 'Cruise Terminal B — The Pearl of Miami', operator: 'Norwegian Cruise Line',
      description: 'The county page states 190,000 sq ft.' },
    { code: 'C', name: 'Cruise Terminal C', operator: null,
      description: 'Serves ships from several cruise lines; the county page does not name them.' },
    { code: 'D', name: 'Cruise Terminal D', operator: 'Carnival Cruise Line',
      description: 'Expanded 2018. The county page describes terminals D, E and F together as 471,000 sq ft.' },
    { code: 'E', name: 'Cruise Terminal E', operator: 'Carnival Cruise Line',
      description: 'Expanded 2018. The county page describes terminals D, E and F together as 471,000 sq ft.' },
    { code: 'F', name: 'Cruise Terminal F', operator: 'Carnival Cruise Line',
      description: 'Renovated 2022. The county page describes terminals D, E and F together as 471,000 sq ft.' },
    { code: 'G', name: 'Cruise Terminal G', operator: 'Royal Caribbean International',
      description: 'Under construction. The county page states construction beginning summer 2025 and opening expected 2027, at the west end of PortMiami.' },
    { code: 'J', name: 'Cruise Terminal J', operator: null,
      description: 'A boutique terminal for small vessels and luxury cruises, per the county page.' },
    { code: 'V', name: 'Cruise Terminal V', operator: 'Virgin Voyages',
      description: 'Opened 2022. The county page states 100,000 sq ft over three stories.' },
  ].map(t => ({
    id: `terminal-${t.code.toLowerCase()}`,
    name: t.name,
    code: t.code,
    category: 'CRUISE_TERMINAL',
    description: t.description,
    operator: t.operator,
    location: unknownLocation,
    verificationStatus: 'VERIFIED',
    sources: ['mdc-cruise-terminals'],
    supports: {
      'mdc-cruise-terminals': 'Terminal designation, operator and the quoted size and dates. The page publishes no address or coordinate.',
    },
    attributes: { address: null },
  })),

  // ---- Parking. The county page gives a street address for each, which the road file geocodes. ----
  ...[
    { code: 'AA', kind: 'Garage', house: 2200, street: 'N CRUISE BLVD', serves: ['terminal-aa'] },
    { code: 'A', kind: 'Garage', house: 2000, street: 'N CRUISE BLVD', serves: ['terminal-a'] },
    { code: 'B', kind: 'Garage', house: 1756, street: 'N CRUISE BLVD', serves: ['terminal-b'] },
    { code: 'C', kind: 'Garage', house: 1648, street: 'N CRUISE BLVD', serves: ['terminal-c'] },
    // The page writes this one "1400 Cruise Blvd." — without the N — and the road file has no
    // address ranges on the segments named CRUISE BLVD, so it does not geocode. Recorded as the
    // page writes it rather than silently corrected to N CRUISE BLVD.
    { code: 'D', kind: 'Garage', house: 1400, street: 'CRUISE BLVD', serves: ['terminal-d'] },
    { code: 'G', kind: 'Garage', house: 921, street: 'N AMERICA WAY', serves: ['terminal-f', 'terminal-g', 'terminal-v'] },
    { code: 'J', kind: 'Garage', house: 1122, street: 'CARIBBEAN WAY', serves: ['terminal-j'] },
    { code: 'K', kind: 'Garage', house: 1124, street: 'CARIBBEAN WAY', serves: ['terminal-j'] },
    { code: 'C', kind: 'Surface Lot', house: 1720, street: 'AFRICA WAY', serves: [] },
    { code: 'D', kind: 'Surface Lot', house: 1400, street: 'N CRUISE BLVD', serves: ['terminal-d'] },
    { code: 'E', kind: 'Surface Lot', house: 625, street: 'FLORIDA WAY', serves: ['terminal-e'] },
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
    sources: ['mdc-parking'],
    supports: {
      'mdc-parking': `Facility designation and the street address "${p.house} ${p.street}". The page publishes no coordinate and no capacity.`,
    },
    attributes: { address: addr(p.house, p.street), servesAssetIds: p.serves },
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
    attributes: { address: addr(1015, 'N AMERICA WAY'), addressRange: '1001, 1007 and 1015 N America Way' },
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
