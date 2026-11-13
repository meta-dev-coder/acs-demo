/**
 * The operational model behind Asset Operations & Maintenance.
 *
 * Pure functions over the records the workspace has already loaded: no fetching, no DOM, no Cesium.
 * Everything the Operations Overview shows is computed here so it can be tested against the real
 * export rather than eyeballed on a map.
 *
 * The one rule that shapes all of it: an association between an incident and an asset is either
 * stated by the data or it is not. Proximity is not proof, and an asset near a crash is not a
 * damaged asset. `ASSOCIATION` names which of the four kinds each link is, and every count that
 * depends on a link says which kind it counted.
 */
import { assetKey, field, isHighPriority, isOpen } from './maintenanceRecords.js';
import { metresBetween } from '../assetExplorer/corridorPosition.js';

/**
 * How an incident came to be attached to an asset.
 *
 * CONFIRMED  the incident record names the asset and the registry carries it.
 * INFERRED   derived from another record that is itself confirmed (an asset's own work history).
 * CANDIDATE  spatial only — close enough to be worth a look, never close enough to be a fact.
 * UNLINKED   nothing connects them, which is an answer and not a gap to be filled.
 */
export const ASSOCIATION = Object.freeze({
  CONFIRMED: 'CONFIRMED', INFERRED: 'INFERRED', CANDIDATE: 'CANDIDATE', UNLINKED: 'UNLINKED',
});

export const ASSOCIATION_LABELS = Object.freeze({
  CONFIRMED: 'Confirmed', INFERRED: 'Inferred', CANDIDATE: 'Candidate — needs review', UNLINKED: 'Unlinked',
});

/**
 * How near an asset has to be before an unlinked incident is worth offering as a candidate.
 *
 * Deliberately tight. The corridor carries 5,015 assets over 22 km, so a generous radius returns
 * a lighting pole for every crash and means nothing. A candidate is a prompt to a human, not a
 * finding, and the UI labels it as one.
 */
export const CANDIDATE_RADIUS_M = 30;

/**
 * One incident's link to an asset.
 *
 * @param {object} incident  a normalised incident record
 * @param {Map<string, object>} assets  assetIndex() output
 * @returns {{incidentId: string, relationship: string, assetId: string|null,
 *            distanceM: number|null, reason: string}}
 */
export function associateIncident(incident, assets = new Map(), { candidateRadiusM = CANDIDATE_RADIUS_M } = {}) {
  const incidentId = String(incident?.id ?? '');
  const named = assetKey(incident?.assetId);
  if (named && assets.has(named)) {
    return Object.freeze({ incidentId, relationship: ASSOCIATION.CONFIRMED, assetId: named,
      distanceM: 0, reason: 'The incident record names the damaged asset and the registry carries it.' });
  }
  if (named) {
    return Object.freeze({ incidentId, relationship: ASSOCIATION.UNLINKED, assetId: null, distanceM: null,
      reason: `The incident names asset ${named}, which the registry does not carry.` });
  }
  const hasPosition = Number.isFinite(incident?.longitude) && Number.isFinite(incident?.latitude);
  if (!hasPosition) {
    return Object.freeze({ incidentId, relationship: ASSOCIATION.UNLINKED, assetId: null, distanceM: null,
      reason: 'The incident names no damaged asset and carries no coordinates, so there is nothing to match on.' });
  }
  let nearest = null;
  let best = Infinity;
  for (const [id, asset] of assets) {
    if (!Number.isFinite(asset?.longitude) || !Number.isFinite(asset?.latitude)) continue;
    const distance = metresBetween(incident.longitude, incident.latitude, asset.longitude, asset.latitude);
    if (distance < best) { best = distance; nearest = id; }
  }
  if (nearest && best <= candidateRadiusM) {
    return Object.freeze({ incidentId, relationship: ASSOCIATION.CANDIDATE, assetId: nearest,
      distanceM: Math.round(best),
      reason: `No asset is named. ${nearest} is ${Math.round(best)} m away — a proximity match for a `
        + 'reviewer to confirm or reject, not a damaged asset.' });
  }
  return Object.freeze({ incidentId, relationship: ASSOCIATION.UNLINKED, assetId: null, distanceM: null,
    reason: `No asset is named and none lies within ${candidateRadiusM} m of the incident.` });
}

/** Every incident's association, keyed by incident id. */
export function associateIncidents(incidents = [], assets = new Map(), options = {}) {
  return new Map((incidents ?? []).map(incident => [String(incident.id), associateIncident(incident, assets, options)]));
}

/** How many links of each kind. A kind with none still appears, as 0 rather than as absent. */
export function associationCounts(associations) {
  const counts = Object.fromEntries(Object.values(ASSOCIATION).map(kind => [kind, 0]));
  for (const entry of associations?.values?.() ?? associations ?? []) counts[entry.relationship] += 1;
  return Object.freeze(counts);
}

/**
 * Assets a confirmed incident has damaged more than once.
 *
 * Confirmed links only. A candidate is a proximity guess, and counting two guesses as a pattern of
 * repeated damage would turn an unknown into a maintenance priority.
 */
export function repeatedDamage(associations, assets = new Map(), incidents = []) {
  const byIncident = new Map((incidents ?? []).map(item => [String(item.id), item]));
  const hits = new Map();
  for (const entry of associations?.values?.() ?? associations ?? []) {
    if (entry.relationship !== ASSOCIATION.CONFIRMED || !entry.assetId) continue;
    const list = hits.get(entry.assetId) ?? [];
    list.push(entry.incidentId);
    hits.set(entry.assetId, list);
  }
  return Object.freeze([...hits]
    .filter(([, list]) => list.length > 1)
    .map(([assetId, incidentIds]) => {
      const asset = assets.get(assetId) ?? null;
      const dates = incidentIds.map(id => byIncident.get(id)?.createdDate).filter(Boolean).sort();
      return Object.freeze({
        assetId, incidentIds: Object.freeze([...incidentIds].sort()), count: incidentIds.length,
        category: asset?.category ?? null, segment: asset?.segment ?? null,
        longitude: asset?.longitude ?? null, latitude: asset?.latitude ?? null,
        firstIncidentDate: dates[0] ?? null, lastIncidentDate: dates[dates.length - 1] ?? null,
      });
    })
    .sort((a, b) => b.count - a.count || String(a.assetId).localeCompare(String(b.assetId))));
}

/** Open work orders — the repairs in hand. The class's own status field, nothing derived. */
export const openRepairs = workOrders => (workOrders ?? []).filter(isOpen);

/**
 * Failed inspections with no completed work on the same asset since.
 *
 * INFERRED, and labelled as such wherever it is shown: the inspection sheets and the work orders
 * share no reference, so "the work order that answered this inspection" is a deduction from the
 * asset id and the dates, not a recorded fact. The deduction is deliberately generous to the
 * corridor — any completed work order on the asset after the inspection clears it — because
 * overstating the unresolved count is the direction that wastes a crew's day.
 */
export function unresolvedInspections(inspections = [], workOrders = []) {
  const completedByAsset = new Map();
  for (const order of workOrders ?? []) {
    const id = assetKey(order?.assetId);
    if (!id || isOpen(order)) continue;
    const list = completedByAsset.get(id) ?? [];
    list.push(String(order.createdDate ?? ''));
    completedByAsset.set(id, list);
  }
  return Object.freeze((inspections ?? [])
    .filter(item => /fail/i.test(item?.status ?? ''))
    .filter(item => {
      const id = assetKey(item?.assetId);
      if (!id) return true;   // nothing to clear it with
      const since = String(item?.createdDate ?? '');
      return !(completedByAsset.get(id) ?? []).some(date => date && date >= since);
    }));
}

/**
 * A KPI the Operations Overview shows.
 *
 * `available` is the honest part. A figure the data cannot support is not a zero: it carries
 * `available: false` and the reason, and the panel prints the reason instead of a number.
 */
const kpi = (id, label, value, { available = true, note = null, basis = 'RECORDED', filter = null, demo = false } = {}) =>
  Object.freeze({ id, label, value, available, note, basis, filter, demo });

/**
 * The six operational figures, in the order the brief lists them.
 *
 * `basis` says where each one comes from: RECORDED (a field in the data), DERIVED (counted from
 * recorded fields), INFERRED (a deduction across two datasets that share no key) or DEMO
 * (synthetic, and never added to a production total).
 */
export function operationsKpis({
  incidents = [], associations = new Map(), workOrders = [], inspections = [],
  assets = new Map(), demoBreakdown = null, demoEnabled = false,
} = {}) {
  const counts = associationCounts(associations);
  const repeated = repeatedDamage(associations, assets, incidents);
  const unresolved = unresolvedInspections(inspections, workOrders);
  return Object.freeze([
    kpi('totalIncidents', 'Total incidents', incidents.length,
      { basis: 'RECORDED', note: 'Incident register rows inside the selected period.', filter: { kind: 'all' } }),
    kpi('assetLinked', 'Asset-linked incidents', counts.CONFIRMED,
      { basis: 'RECORDED', filter: { kind: 'relationship', value: ASSOCIATION.CONFIRMED },
        note: `${counts.CONFIRMED} name an asset the registry carries. ${counts.CANDIDATE} proximity `
          + `candidate(s) await review; ${counts.UNLINKED} have nothing to match on.` }),
    kpi('repeatedDamage', 'Assets with repeated damage', repeated.length,
      { basis: 'DERIVED', filter: { kind: 'repeated' },
        note: 'Assets named by more than one incident. Confirmed links only — a proximity candidate is not counted.' }),
    kpi('openRepairs', 'Open repairs', openRepairs(workOrders).length,
      { basis: 'RECORDED', filter: { kind: 'workOrders' }, note: 'Work orders whose own status is not a closed one.' }),
    kpi('unresolvedInspections', 'Unresolved inspection issues', unresolved.length,
      { basis: 'INFERRED', filter: { kind: 'inspections' },
        note: 'Failed inspections with no completed work order on the same asset since. The two datasets '
          + 'share no reference, so this is a deduction from asset id and date, not a recorded link.' }),
    demoEnabled && demoBreakdown
      ? kpi('missingEvidence', 'Incidents with missing evidence', demoBreakdown.missingEvidence,
        { basis: 'DEMO', demo: true, filter: { kind: 'demo' },
          note: `${demoBreakdown.missingEvidence} missing field(s) across the ${demoBreakdown.total} synthetic `
            + 'demonstration cases. The production incident register carries no evidence requirements, so no '
            + 'production incident is counted here.' })
      : kpi('missingEvidence', 'Incidents with missing evidence', null,
        { available: false, basis: 'DEMO',
          note: 'The production incident register defines no required evidence, so this cannot be counted for '
            + 'real incidents. Enable the demonstration cases to see it answered for the synthetic lifecycle.' }),
  ]);
}

/* ── corridor analysis ───────────────────────────────────────────────────────────────────────── */

/**
 * Severity, derived from what the register actually records.
 *
 * The register has no severity column. It has fatalities, injuries and a lane-closure flag, and
 * those are ordered: a death outranks an injury outranks a closure. Anything with none of the
 * three is "Property damage only" — which is what the absence of all three means here, not an
 * assumption about how bad the crash was.
 */
export function severityOf(incident) {
  const related = incident?.related ?? {};
  // The register writes this column two ways: a count on the committed export, and "Yes"/"No" on
  // the live class. Both mean the same thing, and reading only one of them silently downgraded
  // every fatal crash on the live instance to "Property damage only".
  const fatal = field(incident?.raw, 'fatalities');
  if (Number(related.fatalities) > 0 || Number(fatal) > 0 || /^y(es)?$/i.test(String(fatal ?? ''))) return 'Fatality';
  if (/^y(es)?$/i.test(String(related.injuries ?? ''))) return 'Injury';
  if (/^y(es)?$/i.test(String(related.laneClosure ?? ''))) return 'Lane closure';
  return 'Property damage only';
}

export const SEVERITY_ORDER = Object.freeze(['Fatality', 'Injury', 'Lane closure', 'Property damage only']);

/** The register writes an unknown segment as "-" or leaves it out. Neither is a segment name. */
export const segmentOf = incident => {
  const text = String(incident?.segmentName ?? '').trim();
  return text && text !== '-' ? text : null;
};

/** What a distribution can be cut by. Each reads a recorded field, or says it is not recorded. */
export const DISTRIBUTION_DIMENSIONS = Object.freeze([
  Object.freeze({ id: 'type', label: 'Incident type', of: item => item.title }),
  Object.freeze({ id: 'segment', label: 'Corridor segment', of: segmentOf }),
  Object.freeze({ id: 'severity', label: 'Severity', of: severityOf, order: SEVERITY_ORDER }),
  Object.freeze({ id: 'assetType', label: 'Affected asset type', of: item => item.assetType }),
  Object.freeze({ id: 'rootCause', label: 'Root cause', of: item => item.related?.rootCause }),
  Object.freeze({ id: 'month', label: 'Month', of: item => String(item.createdDate ?? '').slice(0, 7) || null }),
]);

export const dimensionById = id => DISTRIBUTION_DIMENSIONS.find(entry => entry.id === id) ?? DISTRIBUTION_DIMENSIONS[0];

/**
 * Counts per value for one dimension.
 *
 * A record the dimension cannot read is counted under "Not recorded" rather than dropped: 90
 * incidents silently missing from a 178-incident chart is a lie told by omission.
 */
export function distribution(records = [], dimension) {
  const read = dimension?.of ?? (item => item?.title);
  const counts = new Map();
  for (const record of records) {
    const raw = read(record);
    const value = raw == null || String(raw).trim() === '' ? 'Not recorded' : String(raw).trim();
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const of = records.length;
  const rows = [...counts].map(([value, count]) => ({ value, count, of, share: of ? count / of : 0 }));
  if (dimension?.order) {
    const rank = value => {
      const index = dimension.order.indexOf(value);
      return index < 0 ? dimension.order.length : index;
    };
    rows.sort((a, b) => rank(a.value) - rank(b.value) || b.count - a.count);
  } else if (dimension?.id === 'month') {
    rows.sort((a, b) => String(a.value).localeCompare(String(b.value)));
  } else {
    rows.sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  }
  return Object.freeze(rows.map(Object.freeze));
}

/**
 * Narrow the incidents to what the operator has chosen.
 *
 * Every filter is "all" until it is set, and an unset filter never removes a record. A dimension
 * filter set to "Not recorded" keeps exactly the records the dimension cannot read, so the bucket
 * on the chart and the records behind it are the same set.
 */
export function filterIncidents(incidents = [], filters = {}, { associations = new Map() } = {}) {
  const dimensionFilters = Object.entries(filters?.dimensions ?? {}).filter(([, value]) => value != null);
  return Object.freeze((incidents ?? []).filter(incident => {
    if (filters?.relationship) {
      const entry = associations.get(String(incident.id));
      if ((entry?.relationship ?? ASSOCIATION.UNLINKED) !== filters.relationship) return false;
    }
    for (const [id, wanted] of dimensionFilters) {
      const raw = dimensionById(id).of(incident);
      const value = raw == null || String(raw).trim() === '' ? 'Not recorded' : String(raw).trim();
      if (value !== wanted) return false;
    }
    return true;
  }));
}

/* ── asset-based intelligence ────────────────────────────────────────────────────────────────── */

/**
 * The operational state of the assets the records can say something about.
 *
 * One row per asset, built only from records that name it. An asset no record names is absent
 * rather than healthy: this lists what is known, not what is fine.
 */
export function assetOperations({
  assets = new Map(), associations = new Map(), workOrders = [], inspections = [], claims = [],
} = {}) {
  const rows = new Map();
  const touch = id => {
    const asset = assets.get(id);
    if (!asset) return null;
    if (!rows.has(id)) {
      rows.set(id, {
        assetId: id, category: asset.category ?? null, segment: asset.segment ?? null,
        longitude: asset.longitude ?? null, latitude: asset.latitude ?? null,
        incidents: 0, openRepairs: 0, awaitingInspection: 0, failedInspections: 0,
        unresolvedQc: 0, claims: 0, claimedUSD: 0,
      });
    }
    return rows.get(id);
  };
  for (const entry of associations?.values?.() ?? associations ?? []) {
    if (entry.relationship !== ASSOCIATION.CONFIRMED || !entry.assetId) continue;
    const row = touch(entry.assetId);
    if (row) row.incidents += 1;
  }
  for (const order of workOrders ?? []) {
    const row = touch(assetKey(order?.assetId));
    if (!row) continue;
    if (isOpen(order)) row.openRepairs += 1;
    // An open high-priority work order with no inspection on the asset is work waiting to be looked at.
    if (isOpen(order) && isHighPriority(order)) row.awaitingInspection += 1;
  }
  const unresolved = new Set(unresolvedInspections(inspections, workOrders).map(item => assetKey(item.assetId)));
  for (const inspection of inspections ?? []) {
    const row = touch(assetKey(inspection?.assetId));
    if (!row) continue;
    if (/fail/i.test(inspection?.status ?? '')) {
      row.failedInspections += 1;
      if (unresolved.has(assetKey(inspection.assetId))) row.unresolvedQc += 1;
    }
  }
  for (const claim of claims ?? []) {
    const row = touch(assetKey(claim?.assetId));
    if (!row) continue;
    row.claims += 1;
    row.claimedUSD += Number(claim?.claimedUSD ?? 0) || 0;
  }
  return Object.freeze([...rows.values()]
    .map(row => Object.freeze({ ...row, repeated: row.incidents > 1 }))
    .sort((a, b) => b.incidents - a.incidents || b.openRepairs - a.openRepairs
      || String(a.assetId).localeCompare(String(b.assetId))));
}

/**
 * What the register itself recorded at the scene, for one incident.
 *
 * All of it real and all of it from the incident's own row — which is the point: these are the
 * conditions as reported, not an observation from a sensor and not a reconstruction. The weather
 * and traffic WORDS here ("Heavy", "Storm Recovery") are the register's own categories, not the
 * Open-Meteo reading and not a speed measurement; `incidentContext.js` is where a timestamped
 * reading comes from.
 */
export function recordedAtScene(incident) {
  const related = incident?.related ?? {};
  // Through `field()`, not off `raw` directly: a live DataConnect row nests its columns under
  // `attributes` while the committed export does not, and reading one shape only emptied this
  // whole block on the live instance.
  const value = key => field(incident?.raw, key);
  return Object.freeze({
    laneClosure: related.laneClosure ?? null,
    laneClosureHours: value('lane_closure_duration_hours'),
    injuries: related.injuries ?? null,
    fatalities: Number.isFinite(related.fatalities) ? related.fatalities : value('fatalities'),
    hospitalizations: value('hospitalizations'),
    vehicleCount: value('vehicle_count'),
    reportedWeather: value('weather'),
    reportedTraffic: value('traffic_conditions'),
    rootCause: related.rootCause ?? null,
    recommendedAction: value('recommended_next_action'),
    policeReport: value('police_report_number'),
  });
}
