/**
 * The synthetic tolling zones a financial estimate is built on — and what they are not.
 *
 * Phase 1's `equipmentDependencies` holds what is KNOWN about this gantry: the model's own lane
 * grouping, provisional, with no verified coverage. That file is left exactly as it is. This one
 * sits beside it and adds what a demonstration needs: an assumed share of demand per zone, which
 * antennas and cameras are assumed to serve it, and an assumed redundancy rule.
 *
 * Everything here is marked SYNTHETIC_ASSUMPTION, and the two are never merged: a figure computed
 * from this file can always be told apart from a conclusion drawn from the model.
 *
 * What is deliberately NOT assumed:
 *   • that the six equipment groups are six traffic lanes
 *   • that they carry equal volume (the shares are configurable, and default to equal only because
 *     there is nothing to base anything else on — which the UI says)
 *   • that front and back equipment face opposite directions
 *   • that one antenna covers exactly one lane
 */

export const ZONE_VERIFICATION = Object.freeze({
  /** From the 3D model's grouping; no survey. */
  PROVISIONAL: 'PROVISIONAL',
  /** Added for the demonstration. Not a claim about the road at all. */
  SYNTHETIC_ASSUMPTION: 'SYNTHETIC_ASSUMPTION',
});

/** How a zone's read capability responds to losing antennas. */
export const COVERAGE_MODEL = Object.freeze({
  CONFIGURED_DEMO: 'CONFIGURED_DEMO',
  /** No rule: the zone's financial effect cannot be assessed. */
  UNKNOWN: 'UNKNOWN',
});

/**
 * The demo coverage rule, in one sentence each.
 *
 * `singleFailureReadSuccessMultiplier` is the one number that stops "an antenna failed" from
 * meaning "the lane stopped reading": with a redundant pair, losing one leaves the zone reading at
 * 60% of its usual rate rather than at nothing.
 */
export const DEMO_COVERAGE = Object.freeze({
  type: COVERAGE_MODEL.CONFIGURED_DEMO,
  singleFailureReadSuccessMultiplier: 0.6,
  allFailedReadSuccessMultiplier: 0,
  singleFailureCaptureMultiplier: 0.7,
  allFailedCaptureMultiplier: 0,
});

const pad = value => String(value).padStart(2, '0');

/**
 * Build the synthetic zones from the equipment that actually exists.
 *
 * One zone per (lane group, side) the model states, carrying that zone's RFID antennas and VES
 * cameras. Demand is split equally unless shares are supplied, and the shares are normalised so
 * they always sum to 1 — an allocation that does not add up is a silent way to lose vehicles.
 *
 * Equipment outside any group — the CCTV cameras, the unlaned toll cameras — belongs to no zone and
 * therefore has no modelled financial path. That is reported, not silently treated as harmless.
 *
 * @param {object[]} inventory equipment records
 * @param {{shares?: Record<string, number>, coverage?: object, gantryId?: string}} [options]
 */
export function buildSyntheticZones(inventory = [], { shares = null, coverage = DEMO_COVERAGE } = {}) {
  const zones = new Map();
  const unzoned = [];
  for (const asset of inventory) {
    if (asset?.laneGroup == null || !asset?.side) { if (asset?.assetId) unzoned.push(asset.assetId); continue; }
    const gantry = asset.gantryId ?? 'GANTRY';
    const zoneId = `${gantry.replace(/^I595_/, '')}_L${pad(asset.laneGroup)}_${asset.side}`;
    if (!zones.has(zoneId)) {
      zones.set(zoneId, {
        zoneId,
        gantryId: gantry,
        laneGroup: asset.laneGroup,
        side: asset.side,
        verificationStatus: ZONE_VERIFICATION.SYNTHETIC_ASSUMPTION,
        rfidAssetIds: [],
        vesAssetIds: [],
        otherAssetIds: [],
        rfidCoverageModel: coverage,
        demandShare: 0,
      });
    }
    const zone = zones.get(zoneId);
    if (asset.type === 'RFID_ANTENNA') zone.rfidAssetIds.push(asset.assetId);
    else if (asset.type === 'VES_CAMERA') zone.vesAssetIds.push(asset.assetId);
    else zone.otherAssetIds.push(asset.assetId);
  }

  const list = [...zones.values()].sort((a, b) => a.zoneId.localeCompare(b.zoneId));
  // Only zones that can actually take a toll carry demand: a group with no antenna and no camera
  // has nothing to model, and giving it vehicles would move them out of the zones that do.
  const tolling = list.filter(zone => zone.rfidAssetIds.length || zone.vesAssetIds.length);
  const raw = tolling.map(zone => (shares?.[zone.zoneId] != null ? Number(shares[zone.zoneId]) : 1));
  const sum = raw.reduce((total, value) => total + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  tolling.forEach((zone, index) => {
    const value = Number.isFinite(raw[index]) && raw[index] > 0 ? raw[index] : 0;
    zone.demandShare = sum > 0 ? value / sum : 0;
  });

  for (const zone of list) {
    zone.rfidAssetIds = Object.freeze(zone.rfidAssetIds);
    zone.vesAssetIds = Object.freeze(zone.vesAssetIds);
    zone.otherAssetIds = Object.freeze(zone.otherAssetIds);
    Object.freeze(zone);
  }
  return Object.freeze({
    zones: Object.freeze(list),
    tollingZones: Object.freeze(tolling),
    /** Equipment with no modelled financial path at all. */
    unzonedAssetIds: Object.freeze(unzoned),
    /** True when the shares came from configuration rather than from "split it equally". */
    sharesConfigured: Boolean(shares),
  });
}

/** The share of demand each zone carries, as a plain object — what the UI edits. */
export const sharesOf = zones => Object.fromEntries(zones.map(zone => [zone.zoneId, zone.demandShare]));
