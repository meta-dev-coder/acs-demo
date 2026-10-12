/**
 * What Ask the Twin knows about where the operator is standing.
 *
 * The free-form path used to post `{ question }` and nothing else. The model had no idea which
 * screen was open, which incident was selected or what moment was being investigated, so
 * "which cameras are nearby?" had no "here", and "show it on the map" had no "it". Every question
 * had to restate the incident id and the date, which is not how anyone asks a colleague.
 *
 * Two rules this module exists to enforce:
 *
 *  1. CONTEXT IS READ FROM THE APPLICATION, never from the model. Every id in here came out of
 *     real state — a selected incident, a resolved resource, a drawn rectangle. An id the model
 *     invents can therefore be rejected, because it will not match anything the context offered.
 *
 *  2. A HISTORICAL MOMENT IS NOT NOW. The investigated timestamp travels separately from the
 *     current clock and is labelled, so an answer about a 2025 incident cannot quietly fold in
 *     today's live feed.
 *
 * Pure: state in, a serialisable snapshot out. No DOM writes, no Cesium, no fetching.
 */

/** Entities a follow-up can refer to as "it". Anything else is not resolvable and is refused. */
export const REFERENT_KINDS = Object.freeze({
  INCIDENT: 'INCIDENT',
  CAMERA: 'CAMERA',
  SIGN: 'SIGN',
  PATROL: 'PATROL',
  SEGMENT: 'SEGMENT',
  ASSET: 'ASSET',
  AREA: 'AREA',
});

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string === '' ? null : string;
};

/** The map's current footprint, rounded — the model needs an extent, not survey precision. */
export function mapExtentOf(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.();
  if (!rectangle) return null;
  const deg = radians => Math.round((radians * 180 / Math.PI) * 10000) / 10000;
  return Object.freeze({
    west: deg(rectangle.west), south: deg(rectangle.south),
    east: deg(rectangle.east), north: deg(rectangle.north),
    heightM: Math.round(viewer.camera.positionCartographic?.height ?? 0),
  });
}

/** The layers actually switched on, by the store's own ids. */
export function activeLayersOf(layerStore) {
  if (!layerStore?.layers) return [];
  return layerStore.layers
    .filter(layer => ['on', 'partial'].includes(layerStore.stateOf?.(layer.id)))
    .map(layer => layer.id);
}

/**
 * The TMC's own state, when that is the screen in front of the operator.
 *
 * Read through the workspace's public getters rather than reaching into it, so this cannot drift
 * from what the screen is actually showing.
 */
function tmcContextOf(tmc) {
  if (!tmc) return null;
  const temporal = tmc.temporal ?? null;
  const assessment = tmc.assessment ?? null;
  const selectedId = tmc.selectedIncidentId ?? null;
  const entry = selectedId
    ? (assessment?.assessments ?? []).find(item => item.incident.id === selectedId) ?? null
    : null;
  const patrol = tmc.patrolScenario ?? null;
  const upstream = tmc.upstreamProtection ?? null;

  return {
    mode: temporal?.mode ?? null,
    /**
     * The date being investigated, and the incident's own instant.
     *
     * Kept apart from the wall clock on purpose: an answer about a historical incident must not
     * reach for live conditions, and the only way to prevent that is to say which is which.
     */
    historicalDate: temporal?.date ?? null,
    activeTab: tmc.activeTab ?? null,
    selectedIncidentId: selectedId,
    incidentTimestamp: upstream?.incidentTimestamp ?? patrol?.anchorMs ?? null,
    incidentSection: entry?.incident?.sectionLabel ?? null,
    incidentCarriageway: entry?.incident?.carriageway ?? null,
    riskScore: entry?.risk?.score ?? null,
    riskLevel: entry?.risk?.level ?? null,
    responseFocus: tmc.responseFocus ?? null,
    // Resolved resources, so a follow-up about "the camera" has something real to bind to.
    nearestCameraId: entry?.resources?.camera?.id ?? upstream?.nearestCamera?.id ?? null,
    nearestSignId: entry?.resources?.sign?.id ?? upstream?.nearestDms?.id ?? null,
    upstreamResolved: upstream?.upstreamResolution?.resolved ?? null,
    selectedPatrolId: tmc.selectedPatrolId ?? null,
    eligiblePatrolIds: (patrol?.eligible ?? []).map(option => option.patrol.id),
  };
}

/**
 * Everything the assistant may treat as "here" and "this".
 *
 * @param {{screen, role, viewer, layerStore, tmc, assetExplorer, spatialContext, referent}} state
 * @returns {object} a serialisable snapshot
 */
export function buildTwinContext({
  screen = null, role = null, viewer = null, layerStore = null, tmc = null,
  selectedAssetId = null, spatialContext = null, referent = null, now = Date.now(),
} = {}) {
  const onTmc = screen === 'tmc';
  const tmcState = onTmc ? tmcContextOf(tmc) : null;
  return Object.freeze({
    screen: text(screen),
    role: text(role),
    // The present, always stated, so the model never has to assume what "now" is.
    nowIso: new Date(now).toISOString(),
    tmc: tmcState,
    selectedAssetId: text(selectedAssetId),
    mapExtent: mapExtentOf(viewer),
    activeLayers: activeLayersOf(layerStore),
    /** The drawn rectangle, when there is one — already resolved to sections, assets and records. */
    area: spatialContext
      ? {
        sections: spatialContext.roadway?.segments?.map(segment => segment.sectionLabel) ?? [],
        assets: spatialContext.totals?.assets ?? 0,
        liveIncidents: spatialContext.liveEvents?.incidents?.length ?? 0,
        historicalRecords: spatialContext.maintenance?.incidents?.length ?? 0,
        openWorkOrders: spatialContext.totals?.openWorkOrders ?? 0,
      }
      : null,
    /** What the last answer was about, so "it" resolves without the operator repeating an id. */
    lastReferenced: referent ?? null,
  });
}

/**
 * The context as the sentences a language model reads best.
 *
 * Deliberately prose rather than JSON: the model is being told where the operator is standing, and
 * a labelled sentence is harder to misread than a nested object. Anything absent is simply not
 * mentioned — an empty field invites a guess.
 */
export function describeTwinContext(context) {
  if (!context) return '';
  const lines = [];
  if (context.screen) lines.push(`Active screen: ${context.screen}${context.role ? ` (role: ${context.role})` : ''}.`);
  lines.push(`Current real-world time: ${context.nowIso}.`);

  const tmc = context.tmc;
  if (tmc) {
    if (tmc.mode) lines.push(`TMC mode: ${tmc.mode}${tmc.historicalDate ? ` · investigating ${tmc.historicalDate}` : ''}.`);
    if (tmc.activeTab) lines.push(`Open tab: ${tmc.activeTab}.`);
    if (tmc.selectedIncidentId) {
      const bits = [`Selected incident: ${tmc.selectedIncidentId}`];
      if (tmc.incidentSection) bits.push(`on ${tmc.incidentSection}`);
      if (Number.isFinite(tmc.incidentTimestamp)) {
        // Named explicitly so a historical incident is never answered with live conditions.
        bits.push(`recorded at ${new Date(tmc.incidentTimestamp).toISOString()} (a PAST moment, not now)`);
      }
      if (Number.isFinite(tmc.riskScore)) bits.push(`secondary-incident risk ${tmc.riskScore}/100 (${tmc.riskLevel})`);
      lines.push(`${bits.join(', ')}.`);
    } else {
      lines.push('No incident is selected.');
    }
    if (tmc.upstreamResolved === false) lines.push('The upstream approach for this incident is UNRESOLVED.');
    if (tmc.nearestCameraId) lines.push(`Nearest upstream camera resolved for it: ${tmc.nearestCameraId}.`);
    if (tmc.nearestSignId) lines.push(`Nearest upstream DMS resolved for it: ${tmc.nearestSignId}.`);
    if (tmc.eligiblePatrolIds?.length) {
      lines.push(`Eligible SIMULATED patrols: ${tmc.eligiblePatrolIds.join(', ')}.`);
    }
    if (tmc.selectedPatrolId) lines.push(`Selected SIMULATED patrol: ${tmc.selectedPatrolId}.`);
    if (tmc.responseFocus) lines.push(`Response map focus: ${tmc.responseFocus}.`);
  }

  if (context.selectedAssetId) lines.push(`Selected asset: ${context.selectedAssetId}.`);
  if (context.area) {
    lines.push(`A map area is selected: ${context.area.sections.length} section(s), `
      + `${context.area.assets} assets, ${context.area.liveIncidents} live incidents, `
      + `${context.area.historicalRecords} historical incident records, `
      + `${context.area.openWorkOrders} open work orders.`);
  }
  if (context.lastReferenced) {
    lines.push(`The previous answer was about ${context.lastReferenced.kind} `
      + `${context.lastReferenced.id}. If the question says "it", "that one" or "this", it means that.`);
  }
  return lines.join('\n');
}

/**
 * Every identifier the context legitimately offers.
 *
 * An action is only executed against something in here. The model proposes; this decides — so a
 * plausible-looking id that no tool or selection produced moves nothing on the map.
 */
export function authorisedIds(context) {
  const tmc = context?.tmc;
  const ids = new Set();
  const add = value => { if (text(value)) ids.add(String(value)); };
  add(tmc?.selectedIncidentId);
  add(tmc?.nearestCameraId);
  add(tmc?.nearestSignId);
  add(tmc?.selectedPatrolId);
  for (const id of tmc?.eligiblePatrolIds ?? []) add(id);
  add(context?.selectedAssetId);
  add(context?.lastReferenced?.id);
  return ids;
}

/** Whether an action may run: a known type, pointed at an id the context actually offered. */
export function isAuthorisedAction(action, context, allowedTypes) {
  if (!action || !allowedTypes?.has?.(action.type)) return false;
  const target = action.entityId ?? action.incidentId ?? action.patrolId ?? action.resourceId ?? null;
  // An action that names nothing (fly to an area, clear a filter) carries no id to verify.
  if (!target) return true;
  return authorisedIds(context).has(String(target));
}
