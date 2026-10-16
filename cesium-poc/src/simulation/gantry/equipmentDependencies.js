/**
 * What depends on what, on a gantry nobody has surveyed.
 *
 * The 3D model groups equipment into six "lanes". Those groups are the modeller's, not a survey of
 * the carriageway, and nothing published says which antenna covers which tolling zone, how many
 * antennas a zone needs, or what shares a power circuit with what. This module is therefore mostly
 * a statement of what is NOT known:
 *
 *   • Zones are built from the model's own grouping and carry `verificationStatus: PROVISIONAL`.
 *   • `coverageRule` is UNKNOWN and `minimumOperationalAssets` is null until someone supplies them.
 *   • Dependency links start empty. A power failure spreads to another asset only along a link that
 *     is both present AND verified — never because two things sit on the same gantry.
 *
 * So a failure produces "this antenna cannot read" (certain) and "what that does to the zone is not
 * determined" (honest), rather than a confident sentence about a lane that nobody has checked.
 *
 * Rules are data, so the day a survey arrives it is configuration rather than a rewrite.
 */

/** How sure we are that a zone's composition reflects the road. Nothing here is VERIFIED yet. */
export const VERIFICATION = Object.freeze({ PROVISIONAL: 'PROVISIONAL', VERIFIED: 'VERIFIED' });

/** What a zone's capability becomes under a scenario. */
export const ZONE_ASSESSMENT = Object.freeze({
  UNAFFECTED: 'UNAFFECTED',
  REDUCED: 'REDUCED',
  UNAVAILABLE: 'UNAVAILABLE',
  /** Equipment in this zone failed, and the rules to say what that means do not exist. */
  UNKNOWN: 'UNKNOWN',
});

/** The equipment that reads a transponder — what a tolling zone's coverage is about. */
const TOLLING_TYPES = Object.freeze(['RFID_ANTENNA']);

/**
 * Tolling zones, built from the inventory's own grouping.
 *
 * One zone per (lane group, side) the model states. Equipment the model does not place in a group
 * belongs to no zone and is listed separately rather than assigned to a plausible one.
 *
 * @param {object[]} inventory equipment records (assetId, type, laneGroup, side, gantryId)
 * @param {{rules?: Record<string, {coverageRule?: string, minimumOperationalAssets?: number|null}>}} [options]
 */
export function buildZones(inventory = [], { rules = {} } = {}) {
  const zones = new Map();
  const ungrouped = [];
  for (const asset of inventory) {
    if (asset?.laneGroup == null || !asset?.side) { if (asset?.assetId) ungrouped.push(asset.assetId); continue; }
    const gantry = asset.gantryId ?? 'GANTRY';
    const zoneId = `${gantry.replace(/^I595_/, '')}_L${String(asset.laneGroup).padStart(2, '0')}_${asset.side}`;
    if (!zones.has(zoneId)) {
      zones.set(zoneId, {
        zoneId,
        gantryId: gantry,
        laneGroup: asset.laneGroup,
        side: asset.side,
        // The model's grouping, and said to be exactly that.
        verificationStatus: VERIFICATION.PROVISIONAL,
        assetIds: [],
        rfidAssets: [],
        coverageRule: 'UNKNOWN',
        minimumOperationalAssets: null,
      });
    }
    const zone = zones.get(zoneId);
    zone.assetIds.push(asset.assetId);
    if (TOLLING_TYPES.includes(asset.type)) zone.rfidAssets.push(asset.assetId);
  }
  for (const zone of zones.values()) {
    const rule = rules[zone.zoneId];
    if (rule) {
      if (rule.coverageRule) zone.coverageRule = rule.coverageRule;
      if (rule.minimumOperationalAssets != null) zone.minimumOperationalAssets = Number(rule.minimumOperationalAssets);
      if (rule.verificationStatus) zone.verificationStatus = rule.verificationStatus;
    }
    Object.freeze(zone.assetIds);
    Object.freeze(zone.rfidAssets);
    Object.freeze(zone);
  }
  return Object.freeze({
    zones: Object.freeze([...zones.values()].sort((a, b) => a.zoneId.localeCompare(b.zoneId))),
    ungroupedAssetIds: Object.freeze(ungrouped),
  });
}

/**
 * What a scenario does to one zone.
 *
 * With no coverage rule, a zone containing failed equipment is UNKNOWN — not "reduced", which would
 * be a guess about redundancy, and certainly not "unaffected".
 *
 * @param {object} zone
 * @param {Set<string>} unavailable asset ids that cannot do their job in this scenario
 * @param {Set<string>} impaired asset ids working at reduced capability
 */
export function assessZone(zone, unavailable = new Set(), impaired = new Set()) {
  const failed = zone.rfidAssets.filter(id => unavailable.has(id));
  const degraded = zone.rfidAssets.filter(id => impaired.has(id));
  const touchedOther = zone.assetIds.filter(id => unavailable.has(id) || impaired.has(id));
  if (!failed.length && !degraded.length && !touchedOther.length) {
    return Object.freeze({ zoneId: zone.zoneId, assessment: ZONE_ASSESSMENT.UNAFFECTED, failed: [], degraded: [],
      reason: 'No equipment in this zone is affected by the scenario.' });
  }
  const minimum = zone.minimumOperationalAssets;
  if (minimum == null || zone.coverageRule === 'UNKNOWN') {
    return Object.freeze({
      zoneId: zone.zoneId, assessment: ZONE_ASSESSMENT.UNKNOWN, failed, degraded,
      // The sentence the brief asks for, word for word, because it is the honest one.
      reason: 'Equipment failure confirmed in scenario; tolling coverage impact not yet determined.',
    });
  }
  const operational = zone.rfidAssets.length - failed.length;
  return Object.freeze({
    zoneId: zone.zoneId,
    assessment: operational <= 0 || operational < minimum ? ZONE_ASSESSMENT.UNAVAILABLE : ZONE_ASSESSMENT.REDUCED,
    failed,
    degraded,
    reason: `${operational} of ${zone.rfidAssets.length} transponder readers remain, against a configured minimum of ${minimum}.`,
  });
}

/**
 * Assets reached THROUGH a failure, along links that have been verified.
 *
 * Empty by default, and deliberately so: no wiring diagram for this gantry exists, so nothing on it
 * is known to share a circuit with anything else. An unverified link is reported as a possibility,
 * never counted as an effect.
 *
 * @param {string[]} failedAssetIds
 * @param {{from: string, to: string, kind: string, verified?: boolean}[]} links
 * @param {{modes: Record<string, string>}} context  failure mode per failed asset
 */
export function propagate(failedAssetIds = [], links = [], { modes = {} } = {}) {
  const failed = new Set(failedAssetIds);
  const confirmed = new Map();
  const unverified = [];
  for (const link of links) {
    if (!failed.has(link.from) || failed.has(link.to)) continue;
    // Power spreads along power links only, and communications along communications links.
    const mode = modes[link.from];
    const relevant = (link.kind === 'POWER' && mode === 'POWER_FAILURE')
      || (link.kind === 'COMMUNICATION' && mode === 'COMMUNICATION_FAILURE');
    if (!relevant) continue;
    if (link.verified === true) confirmed.set(link.to, { assetId: link.to, via: link.from, kind: link.kind });
    else unverified.push({ assetId: link.to, via: link.from, kind: link.kind });
  }
  return Object.freeze({
    affected: Object.freeze([...confirmed.values()]),
    unverified: Object.freeze(unverified),
  });
}

/** No verified dependency links exist for this gantry. Supplying some is configuration, not code. */
export const DEFAULT_DEPENDENCY_LINKS = Object.freeze([]);
export const DEFAULT_COVERAGE_RULES = Object.freeze({});
