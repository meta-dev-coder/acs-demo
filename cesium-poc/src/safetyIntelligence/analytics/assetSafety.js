/**
 * Safety-relevant assets, their defects, and what is overdue.
 *
 * Built from maintenance records the app already loads: work orders (open and close dates),
 * tickets, inspections. The one judgement this module makes is which asset classes are
 * SAFETY-RELEVANT — stated as a list rather than inferred, so it can be argued with.
 *
 * What it will not do: attribute an incident to an asset because the two are close together. A
 * defect near a concentration of incidents is a place to look, and the wording says exactly that.
 */

const attributesOf = record => record?.attributes ?? record?.raw?.attributes ?? record ?? {};
const text = value => {
  const string = String(value ?? '').trim();
  return string && string.toUpperCase() !== 'N/A' && string !== '1900-01-00' ? string : null;
};

/**
 * The classes whose failure can affect how safely the road operates: seeing it, warning about it,
 * lighting it, detecting on it, or restraining a vehicle that leaves it.
 */
export const SAFETY_RELEVANT = Object.freeze([
  'CCTV', 'Camera', 'DMS', 'Dynamic Message Sign', 'Sign', 'Signs', 'Lighting', 'Light',
  'Detection', 'Detector', 'Guardrail', 'Attenuator', 'Barrier', 'Gantry', 'Bridge', 'ITS',
]);

export const isSafetyRelevant = value => {
  const subject = String(value ?? '').toLowerCase();
  return SAFETY_RELEVANT.some(term => subject.includes(term.toLowerCase()));
};

const dateOf = value => {
  const text_ = text(value);
  if (!text_) return null;
  const slash = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text_);
  if (slash) return Date.UTC(Number(slash[3]), Number(slash[2]) - 1, Number(slash[1]));
  const iso = Date.parse(text_);
  return Number.isFinite(iso) ? iso : null;
};

const DAY = 86_400_000;

/**
 * Repair-time targets per asset category, from the register's own published class.
 *
 * The class publishes `name` (the category) and `repair_times_days` (its SLA). Matching is by the
 * category name, case-insensitively and nothing cleverer: an asset type with no category of its own
 * — "Lighting" on its own, where the class publishes only the specific lighting families — gets NO
 * target rather than the nearest-looking one, because guessing which SLA applies to an asset is
 * exactly the kind of invention this screen exists to avoid.
 *
 * Where the class publishes the SAME category twice with DIFFERENT targets (it does: Fence at both
 * 10 and 37 days), the category is treated as having no usable target and is listed in `conflicts`,
 * so the screen can say the published data disagrees with itself instead of picking one.
 *
 * Absent entirely, every work order is reported as "no target published" rather than compared
 * against an invented SLA.
 *
 * @returns {Map<string, number>} with a `conflicts` property listing the ambiguous categories
 */
export function repairTargets(records = []) {
  const seen = new Map();
  for (const record of records) {
    const attributes = attributesOf(record);
    const category = text(attributes.name) ?? text(attributes['asset category']) ?? text(attributes.asset_type);
    const days = Number(attributes.repair_times_days ?? attributes.target_repair_days
      ?? attributes.repair_time_days ?? attributes.days);
    if (!category || !Number.isFinite(days)) continue;
    const key = category.toLowerCase();
    const found = seen.get(key) ?? new Set();
    found.add(days);
    seen.set(key, found);
  }
  const targets = new Map();
  const conflicts = [];
  for (const [key, values] of seen) {
    if (values.size === 1) targets.set(key, [...values][0]);
    else conflicts.push({ category: key, published: [...values].sort((a, b) => a - b) });
  }
  targets.conflicts = Object.freeze(conflicts);
  return targets;
}

/**
 * Work orders on safety-relevant assets, with age and target comparison.
 *
 * @param {{workOrders: object[], assets: Map, targets: Map, now: number}} input
 */
export function safetyDefects({ workOrders = [], assetIndex = null, targets = new Map(), now = Date.now() } = {}) {
  const rows = [];
  for (const order of workOrders) {
    const attributes = attributesOf(order);
    const assetId = text(attributes['Asset ID']) ?? text(attributes.asset_id);
    const assetType = text(attributes['Asset Type']) ?? assetIndex?.get(assetId)?.category ?? null;
    const systemClass = text(attributes['System Class']) ?? assetIndex?.get(assetId)?.systemClass ?? null;
    if (!isSafetyRelevant(assetType) && !isSafetyRelevant(systemClass)) continue;
    const opened = dateOf(attributes['Work Order Open Date']);
    const closed = dateOf(attributes['Close Date']);
    const target = targets.get(String(assetType ?? '').toLowerCase()) ?? null;
    const ageDays = opened ? Math.max(0, Math.round(((closed ?? now) - opened) / DAY)) : null;
    const position = assetIndex?.get(assetId) ?? null;
    rows.push(Object.freeze({
      id: text(attributes['Work Order ID']) ?? text(attributes.code) ?? order?.id,
      assetId,
      assetType,
      systemClass,
      priority: text(attributes.Priority),
      status: text(attributes['Work Order Status']),
      description: text(attributes['Work Description']) ?? text(attributes.description),
      openedMs: opened,
      closedMs: closed,
      open: !closed,
      ageDays,
      targetDays: target,
      /** Only ever true when a target was actually published for the class. */
      overdue: target != null && ageDays != null && !closed && ageDays > target,
      withinTarget: target != null && ageDays != null && closed ? ageDays <= target : null,
      longitude: Number.isFinite(order?.longitude) ? order.longitude
        : Number(attributes.x_coordinates) || position?.longitude || null,
      latitude: Number.isFinite(order?.latitude) ? order.latitude
        : Number(attributes.y_coordinates) || position?.latitude || null,
      record: order,
    }));
  }
  return Object.freeze(rows.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (b.ageDays ?? 0) - (a.ageDays ?? 0)));
}

/** The numbers the asset KPI row needs, counted once. */
export function assetSafetySummary({ defects = [], assets = [], assetIndex = null } = {}) {
  const closedWithDates = defects.filter(defect => defect.closedMs && defect.openedMs);
  const closedWithTarget = closedWithDates.filter(defect => defect.withinTarget != null);
  const withTarget = defects.filter(defect => defect.targetDays != null);
  const safetyAssets = assetIndex
    ? [...assetIndex.values()].filter(asset => isSafetyRelevant(asset.category) || isSafetyRelevant(asset.systemClass)).length
    : assets.filter(asset => isSafetyRelevant(attributesOf(asset)['asset category'])).length;
  return Object.freeze({
    workOrders: defects.length,
    openDefects: defects.filter(defect => defect.open).length,
    overdue: defects.filter(defect => defect.overdue).length,
    withTarget: withTarget.length,
    closedWithDates: closedWithDates.length,
    closedWithTarget: closedWithTarget.length,
    mttrDays: closedWithDates.length
      ? Number((closedWithDates.reduce((sum, defect) => sum + defect.ageDays, 0) / closedWithDates.length).toFixed(1))
      : null,
    slaShare: closedWithTarget.length
      ? closedWithTarget.filter(defect => defect.withinTarget).length / closedWithTarget.length
      : null,
    safetyAssets,
    assets: assetIndex ? assetIndex.size : assets.length,
    targetsPublished: withTarget.length > 0,
  });
}

/**
 * Defects that sit inside a concentration of incidents.
 *
 * Proximity only. The sentence this produces is "a defect of this class is open where records
 * concentrate" — which is a reason to look, not a finding that one caused the other.
 */
export function defectsNearHotspots(defects = [], hotspots = [], { withinMeters = 300 } = {}) {
  const EARTH = 6_371_000;
  const metres = (a, b) => {
    const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
    const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
    const lat = ((a.latitude + b.latitude) * Math.PI) / 360;
    return Math.hypot(dLon * Math.cos(lat), dLat) * EARTH;
  };
  const found = [];
  for (const hotspot of hotspots) {
    const near = defects.filter(defect => Number.isFinite(defect.longitude) && Number.isFinite(defect.latitude)
      && defect.open && metres(hotspot, defect) <= withinMeters);
    if (!near.length) continue;
    found.push(Object.freeze({
      hotspotId: hotspot.id,
      hotspot,
      defects: Object.freeze(near),
      overdue: near.filter(defect => defect.overdue).length,
      relationship: 'PROXIMITY_ONLY',
      caveat: 'These defects are open within '
        + `${withinMeters} m of a records concentration. Proximity is not causation, and the record `
        + 'positions are asset-derived.',
    }));
  }
  return Object.freeze(found);
}
