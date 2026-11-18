/**
 * Three conceptual design alternatives, for the demonstration.
 *
 * EVERY ONE OF THESE IS SYNTHETIC. They are sketches made to exercise the viewer: to show what a
 * new garage, a proposed access road and a surface reconfiguration look like against the real
 * port. They are not Kimley-Horn proposals, not submitted, not approved and not engineering
 * designs, and `SYNTHETIC_LABEL` travels with each so no screen can show one without saying so.
 *
 * WHERE THE COORDINATES COME FROM. Each design is anchored on a point whose ground elevation was
 * sampled from the photorealistic mesh and found to be open apron (about -25 m in the ellipsoidal
 * frame, against roughly -24.8 m for made ground across Dodge Island), and its geometry is then
 * laid out in METRES from that anchor through the same ENU frame the rest of the application
 * uses. Nothing here is a hand-typed degree offset, so a road stated as 180 m long is 180 m long
 * on the ground and a 70 m building plate measures 70 m whichever way it is turned.
 *
 * WHAT IS NOT CLAIMED. The anchors are open ground in the imagery; that is all. No parcel,
 * ownership, zoning, utility or right-of-way data is available to this twin, so none of these
 * sites is claimed to be buildable — the viewer's conflict panel reports those as Not evaluated.
 */
import { enuToLonLat } from '../scenarios/garagePlacement.js';
import {
  CHANGE_TYPE, DESIGN_SOURCE, ELEMENT_TYPE, VERIFICATION, createDesign,
} from './designModel.js';
import { DESIGN_DOMAIN } from './designDomain.js';

/**
 * Anchors, each verified as open apron by mesh sampling during development.
 *
 * They are named constants rather than numbers inline so a reviewer can see exactly how many
 * invented locations there are — three — and replace them when real design files arrive.
 */
export const ANCHORS = Object.freeze({
  /**
   * A published vertex of the PORT BLVD centreline, read from the county road file.
   *
   * Design B's access road ends ON this point so the connectivity check has a real junction to
   * test. The check still decides whether that counts as connected — this only makes sure the
   * question is a fair one rather than one the geometry could never pass.
   */
  portBlvdJunction: [-80.166883, 25.773072],
  /** The registered Garage K structure, which Design A proposes to extend upward. */
  garageK: [-80.17662, 25.77572],
  /** Open surface parking south of the cruise terminals. Sampled ground ≈ -24.9 m. */
  southLot: [-80.16650, 25.77337],
});

/** A rectangle of `lengthM` x `widthM` about an anchor, turned `headingDeg` clockwise of north. */
function plate(anchor, lengthM, widthM, headingDeg = 0) {
  const heading = (headingDeg * Math.PI) / 180;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const corners = [
    [+lengthM / 2, -widthM / 2], [+lengthM / 2, +widthM / 2],
    [-lengthM / 2, +widthM / 2], [-lengthM / 2, -widthM / 2],
  ].map(([along, across]) =>
    enuToLonLat(anchor, along * sin + across * cos, along * cos - across * sin));
  return [[...corners, corners[0]]];
}

/** A polyline through metre offsets from an anchor. */
const line = (anchor, offsets) => offsets.map(([east, north]) => enuToLonLat(anchor, east, north));

/**
 * Design A — expand an existing registered garage.
 *
 * It changes one thing: the structure's height. The footprint is the county's own confirmed
 * geometry, referenced rather than redrawn, so the alternative cannot drift from the asset.
 */
export const designA = () => createDesign({
  id: 'design-a',
  name: 'Design A — Garage Expansion',
  domain: DESIGN_DOMAIN.PARKING_INFRASTRUCTURE,
  description: 'Add floors to a registered garage. Access roads unchanged.',
  source: DESIGN_SOURCE.SYNTHETIC_DEMO,
  verificationStatus: VERIFICATION.CONCEPTUAL,
  elements: [
    {
      id: 'design-a-garage-01',
      type: ELEMENT_TYPE.PARKING_GARAGE,
      changeType: CHANGE_TYPE.MODIFIED,
      baselineRef: { kind: 'ASSET', assetId: 'parking-garage-k' },
      // No geometry of its own: the footprint is the asset's confirmed one, read at draw time.
      geometry: null,
      properties: {
        name: 'Garage K — proposed vertical expansion',
        addedFloors: 3,
        floorHeightM: 3.2,
        targetSpaces: 1000,
        note: 'Added floors only. The footprint is the registry’s confirmed geometry and is '
          + 'not changed by this alternative.',
      },
    },
  ],
});

/**
 * Design B — a new garage and the road that reaches it.
 *
 * The alternative the demonstration turns on: a structure where there is none, and a proposed
 * access road running from it to the existing network. The road's last vertex is placed ON the
 * Caribbean Way alignment so the connectivity check has something real to test — and the check,
 * not this file, decides whether it counts as connected.
 */
export const designB = () => createDesign({
  id: 'design-b',
  // A garage AND the road that reaches it: genuinely mixed, and declared as such rather than
  // split, because the access road only means anything alongside the structure it serves.
  name: 'Design B — New Garage and Access Road',
  domain: DESIGN_DOMAIN.MIXED_INFRASTRUCTURE,
  description: 'A new conceptual parking structure on an existing surface lot, with a proposed '
    + 'access road to Port Blvd.',
  source: DESIGN_SOURCE.SYNTHETIC_DEMO,
  verificationStatus: VERIFICATION.CONCEPTUAL,
  elements: [
    {
      id: 'design-b-garage-01',
      type: ELEMENT_TYPE.PARKING_GARAGE,
      changeType: CHANGE_TYPE.NEW,
      /*
       * ON THE SOUTH LOT, AND SIZED TO FIT IT.
       *
       * The first attempt was a 150 x 72 m plate on open apron. There is no such gap: the
       * nearest building was 48 m away and the nearest centreline 50 m, and the conflict checker
       * correctly reported the structure overlapping OBJECTID 321971 and sitting over Port Blvd.
       * Building a garage on an existing surface lot is the realistic move anyway, and 75 x 42 m
       * is what clears at this site — the closest building is 46 m off and the closest centreline
       * 51 m, against a half-diagonal of 43 m.
       *
       * The TARGET stays at 2,000 spaces even though this plate cannot hold them. That gap is the
       * finding, not an error to be tuned away: the panel reports the requested figure and the
       * geometry-supported estimate side by side, and they disagree.
       */
      // It names the surface lot it is proposed ON, so the checker reads the overlap with that
      // footprint as the site rather than a collision. OBJECTID 147945 is the county's record of
      // the lot; its mesh samples are flat at apron level, which is what a surface lot looks like.
      baselineRef: { kind: 'BUILDING', objectId: 147945, note: 'Existing surface lot.' },
      geometry: { type: 'Polygon', coordinates: plate(ANCHORS.southLot, 75, 42, 25) },
      properties: {
        name: 'Proposed Garage N',
        floors: 6,
        floorHeightM: 3.2,
        targetSpaces: 2000,
        buildingType: 'PARKING_STRUCTURE',
        /*
         * A DECLARED entrance, on the structure's south-western face.
         *
         * Connectivity tests a facility end against this point, never against the footprint: a
         * road ending inside a garage is not evidence that the garage has a way in there.
         */
        accessPoint: enuToLonLat(ANCHORS.southLot, -20, -18),
      },
    },
    {
      id: 'design-b-road-01',
      type: ELEMENT_TYPE.ROAD,
      changeType: CHANGE_TYPE.NEW,
      geometry: {
        type: 'LineString',
        // From the garage's south-western face, curving down to the Atlantic Way centreline. The
        // last vertex is the published centreline point itself, not a coordinate near it.
        // Starts AT the declared garage entrance and ends ON the published Port Blvd vertex.
        coordinates: [
          ...line(ANCHORS.southLot, [[-20, -18], [-28, -26]]),
          ANCHORS.portBlvdJunction,
        ],
      },
      properties: {
        name: 'Proposed Garage N Access Road',
        widthM: 7.5,
        lanes: 2,
        roadType: 'ACCESS_ROAD',
        connectsTo: 'PORT BLVD',
        // What each end is FOR. Without these both ends are judged against the road network,
        // which reports a correctly drawn access road as potentially disconnected.
        startRole: 'FACILITY_ENTRANCE',
        endRole: 'ROAD_NETWORK_CONNECTION',
        servesElementId: 'design-b-garage-01',
      },
    },
  ],
});

/**
 * Design C — surface reconfiguration, and the access arrangement that goes with it.
 *
 * NO STRUCTURE is proposed here, which is the whole distinction from Design B: a re-laid-out
 * area and a widened approach, with capacity stated as an assumption rather than derived from a
 * building that does not exist.
 */
export const designC = () => createDesign({
  id: 'design-c',
  name: 'Design C — Surface Parking and Road Reconfiguration',
  domain: DESIGN_DOMAIN.PARKING_INFRASTRUCTURE,
  description: 'Re-lay out an existing surface area and widen its approach. No structure proposed.',
  source: DESIGN_SOURCE.SYNTHETIC_DEMO,
  verificationStatus: VERIFICATION.CONCEPTUAL,
  elements: [
    {
      id: 'design-c-surface-01',
      type: ELEMENT_TYPE.SURFACE_PARKING,
      changeType: CHANGE_TYPE.MODIFIED,
      baselineRef: { kind: 'AREA', note: 'Existing surface parking south of the cruise terminals.' },
      geometry: { type: 'Polygon', coordinates: plate(ANCHORS.southLot, 210, 96, 25) },
      properties: {
        name: 'South Lot — proposed re-layout',
        targetSpaces: 1500,
        surfaceAreaPerSpaceM2: 28,
        note: 'Restriping and aisle rearrangement. No structure is proposed in this alternative.',
      },
    },
    {
      id: 'design-c-road-01',
      type: ELEMENT_TYPE.ROAD,
      changeType: CHANGE_TYPE.MODIFIED,
      baselineRef: { kind: 'AREA', note: 'Approach serving the south lot.' },
      geometry: {
        type: 'LineString',
        coordinates: line(ANCHORS.southLot, [[-130, 70], [-10, 118], [120, 150]]),
      },
      properties: {
        name: 'South Lot approach — proposed widening',
        widthM: 11,
        baselineWidthM: 7,
        lanes: 3,
        baselineLanes: 2,
        roadType: 'ACCESS_ROAD',
      },
    },
  ],
});

/**
 * Every synthetic alternative, in the order the selector shows them.
 *
 * NOT LOADED BY THE ROAD DESIGN STUDIO. All three are parking sketches — a garage expansion, a
 * new garage with its access road, a surface-lot re-layout — and the studio seeds empty road
 * alternatives instead (`roadDesigns()`). These are kept, classified and still stored, for a
 * future parking or mixed-infrastructure workspace; they are no longer anybody's default.
 */
export const syntheticDesigns = () => [designA(), designB(), designC()];

/** The same three, under the name that says what they actually are. */
export const legacyParkingDesigns = syntheticDesigns;
