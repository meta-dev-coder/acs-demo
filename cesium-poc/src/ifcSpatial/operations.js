/**
 * Electrical Operations View: each asset's power status, the summary, the active alerts and the
 * outage investigation, from what the application actually has.
 *
 * Sources, and what they are not:
 *  - Reported status: the IFC model's SuperDNA_AssetStatus property set from ACC (PowerStatus,
 *    StatusFlag, StatusDate). It is a status recorded in the model, not live SCADA telemetry; no live
 *    SCADA feed is connected to this screen.
 *  - Connectivity: the network engine (networkState: port connections, normal switch states, reported
 *    no-power equipment passing nothing on).
 *
 * Status per monitored asset (equipment and loads; cables are connections, not counted), one each:
 *   NO_POWER  reported "No power", or no supply path in the model (source TOPOLOGY)
 *   OFFLINE   reported offline / out of service
 *   DEGRADED  powered, with a status flag other than OK (e.g. POOR CONDITION)
 *   POWERED   reported powered, or (no report) energized by the model's connectivity
 *   UNKNOWN   no report and the model cannot tell (the engine's UNKNOWN), never counted as no power
 *
 * Alert severity is a UI rule (the model states none): CRITICAL = a reported power loss; HIGH = no
 * supply path in the model; WARNING = degraded; INFO = offline. Within a severity, loads first.
 */
import { baselineScenario, compareScenario, CONSUMER_TYPES, STATE, traceSupplyPath, withOutage } from '../seagirt/electricalGraph.js';
import { networkState } from './networkTwin.js';

export const STATUS = Object.freeze({ POWERED: 'POWERED', NO_POWER: 'NO_POWER', DEGRADED: 'DEGRADED', OFFLINE: 'OFFLINE', UNKNOWN: 'UNKNOWN' });
export const STATUS_LABEL = Object.freeze({ POWERED: 'Powered', NO_POWER: 'No power', DEGRADED: 'Degraded', OFFLINE: 'Offline', UNKNOWN: 'Unknown' });
export const SEVERITY = Object.freeze({ CRITICAL: 0, HIGH: 1, WARNING: 2, INFO: 3 });

const isMonitored = asset => asset.assetType !== 'FEEDER';
const flagOk = flag => !flag || /^(ok|normal|good|no power)$/i.test(String(flag).trim());
const offlineReport = asset => /offline|out of service|decommission/i.test(String(asset.statusFlag ?? '')) || asset.operationalStatus === 'OUT_OF_SERVICE';

/** Every asset's status (cables included, for drawing), with where it comes from. */
export function assetStatuses(network, { networkState: stateOf = networkState } = {}) {
  const { nodeState, energized } = stateOf(network, null);
  const out = new Map();
  for (const asset of network.assets.values()) {
    const state = nodeState.get(asset.id);
    // The engine's UNKNOWN (it cannot tell, e.g. a switch in an unknown state) is not a power loss.
    const unknown = state === undefined || energized.nodes.get(asset.id) === STATE.UNKNOWN;
    let status, source;
    if (asset.reportedPower === 'NO_POWER') { status = STATUS.NO_POWER; source = 'REPORTED'; }
    else if (offlineReport(asset)) { status = STATUS.OFFLINE; source = 'REPORTED'; }
    else if (unknown) { status = STATUS.UNKNOWN; source = 'NONE'; }
    else if (state === 'dead') { status = STATUS.NO_POWER; source = 'TOPOLOGY'; }
    else if (!flagOk(asset.statusFlag)) { status = STATUS.DEGRADED; source = 'FLAG'; }
    else { status = STATUS.POWERED; source = asset.reportedPower === 'POWERED' ? 'REPORTED' : 'TOPOLOGY'; }
    out.set(asset.id, { id: asset.id, status, source, state, flag: asset.statusFlag ?? null, date: asset.statusDate ?? null, monitored: isMonitored(asset) });
  }
  return out;
}

/** Counts over monitored assets, each counted once; the powered share of those whose status is known. */
export function statusSummary(statuses) {
  const counts = { POWERED: 0, NO_POWER: 0, DEGRADED: 0, OFFLINE: 0, UNKNOWN: 0 };
  const ids = { POWERED: [], NO_POWER: [], DEGRADED: [], OFFLINE: [], UNKNOWN: [] };
  for (const s of statuses.values()) {
    if (!s.monitored) continue;
    counts[s.status] += 1;
    ids[s.status].push(s.id);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const known = total - counts.UNKNOWN;
  // Degraded equipment still has power: it counts as powered in the share.
  const poweredPct = known ? Math.round(((counts.POWERED + counts.DEGRADED) / known) * 1000) / 10 : null;
  const dates = [...statuses.values()].map(s => s.date).filter(Boolean).sort();
  return { total, counts, ids, poweredPct, asOf: dates.at(-1) ?? null, reported: [...statuses.values()].some(s => s.source === 'REPORTED') };
}

/** Alerts, most important first: one per asset, never duplicated. */
export function activeAlerts(network, statuses, { zoneOf = () => null } = {}) {
  const alerts = [];
  for (const s of statuses.values()) {
    if (!s.monitored) continue;
    const asset = network.assets.get(s.id);
    let severity = null, text = null;
    if (s.status === STATUS.NO_POWER) { severity = s.source === 'REPORTED' ? 'CRITICAL' : 'HIGH'; text = s.source === 'REPORTED' ? 'No power (reported in the model)' : 'No power (no supply path in the model)'; }
    else if (s.status === STATUS.DEGRADED) { severity = 'WARNING'; text = `Degraded: ${String(s.flag).toLowerCase()}`; }
    else if (s.status === STATUS.OFFLINE) { severity = 'INFO'; text = 'Offline'; }
    if (!severity) continue;
    alerts.push({ id: s.id, name: asset.name, assetType: asset.assetType, status: s.status, source: s.source, severity, text, date: s.date, zone: zoneOf(asset),
      consumer: CONSUMER_TYPES.has(asset.assetType) });
  }
  return alerts.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || Number(b.consumer) - Number(a.consumer) || a.id.localeCompare(b.id));
}

/**
 * An outage investigation for one asset, from the connectivity:
 *  - upstream: its normal supply path (source → asset), each with its status;
 *  - fed through it: what loses supply in the model if it passes nothing on;
 *  - confirmed affected: of those, what the model already shows without power;
 *  - potentially affected: of those, what the model still shows powered: a load reported without power
 *    does not pass its loss on in the model, so what hangs off it needs verification on site.
 * Alternative supplies are those the model has with switches in their normal state; a supply that
 * needs switching (a normally-open tie) is not assumed.
 */
export function investigateOutage(network, id, statuses = assetStatuses(network)) {
  const asset = network.assets.get(id);
  if (!asset) return null;
  const base = baselineScenario();
  const upstream = traceSupplyPath(network, id, { scenario: base }).path.filter(x => x !== id);
  // What is fed through it, its own terminals included: a light's loop-in / loop-out carries the circuit
  // past a failed lamp, but a fault in the terminals would take what follows with it.
  const fedThrough = compareScenario(network, withOutage(network, base, id), { blockFeedThrough: [id] }).lost.filter(x => x !== id);
  const confirmed = fedThrough.filter(x => statuses.get(x)?.status === STATUS.NO_POWER);
  const potential = fedThrough.filter(x => statuses.get(x)?.status !== STATUS.NO_POWER);
  const upstreamDead = upstream.filter(x => statuses.get(x)?.status === STATUS.NO_POWER);
  const notes = [];
  const s = statuses.get(id);
  if (s?.source === 'REPORTED' && !upstreamDead.length && upstream.length) {
    notes.push(`The supply path up to ${asset.id} is energized in the model: the loss is reported at ${asset.id} itself (its own intake, breaker or equipment), not upstream.`);
  }
  if (upstreamDead.length) notes.push(`Upstream equipment without power: ${upstreamDead.join(', ')}.`);
  if (potential.length) notes.push(`${potential.length} asset${potential.length === 1 ? ' is' : 's are'} fed through ${asset.id} but still shown powered in the model: potentially affected, requires verification.`);
  if (!fedThrough.length) notes.push(`Nothing else is fed through ${asset.id} in the model.`);
  notes.push('Alternative supplies count only as the model has them in their normal switch state; no live SCADA is connected.');
  return { id, upstream, fedThrough, confirmed, potential, upstreamDead, notes, status: s ?? null };
}
