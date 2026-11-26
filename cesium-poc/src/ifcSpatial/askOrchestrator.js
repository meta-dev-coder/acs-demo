/**
 * Ask the Twin's investigation orchestrator (seagirt_implementation.md §7–§8): runs a validated plan
 * (askIntent.js) as dependent steps over the twin's existing services, passed in as tools, and returns the
 * evidence for the answer. Steps run in order; the per-asset document analysis runs in parallel with a
 * concurrency limit. A failed document read is a partial result, never the end of the investigation, and a
 * preliminary status result never ends it either. Pure: no Cesium, no fetch; cancellation through `isCurrent`.
 *
 * Tools (all supplied by the screen, reusing its engines):
 *   scopeAssets(scope)        ids in the scope (the selected area's membership from the server, or the whole model)
 *   statusOf(id)              the operational status engine's record {status, monitored, source, date, flag} or null
 *   categoryOf(id)            the asset's category (the model's own vocabulary)
 *   isAsset(id)               whether the id is a network asset of the loaded model
 *   documentsOf(id)           linked ACC documents from the documentation index, or null when the index is not loaded
 *   analyze(id)               the existing document intelligence (server/ifcSpatial/docIntel.mjs) for one asset
 */

export const STEP_LABEL = Object.freeze({
  RESOLVE_SCOPE: 'Resolving the scope', RESOLVE_TARGETS: 'Identifying the assets', FILTER_ASSETS_BY_STATUS: 'Identifying the assets',
  RETRIEVE_OPERATIONAL_STATUS: 'Reading operational status', RETRIEVE_LINKED_DOCUMENTS: 'Retrieving linked inspection records',
  ANALYSE_INSPECTIONS: 'Analysing inspection findings', EXTRACT_CORRECTIVE_ACTIONS: 'Analysing inspection findings',
  BUILD_MAINTENANCE_ASSESSMENT: 'Preparing the maintenance assessment', HIGHLIGHT_MATCHING_ASSETS: 'Preparing the maintenance assessment',
});
export const STATUS_NAME = Object.freeze({ DEGRADED: 'degraded', NO_POWER: 'without power', OFFLINE: 'offline', POWERED: 'powered', UNKNOWN: 'with an unknown status' });

/** Run `fn` over items with at most `limit` running at once; results keep the items' order. */
export async function mapLimit(items, limit, fn, { isCurrent = () => true } = {}) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (!isCurrent()) return;
      const i = next++;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (error) { out[i] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Resolve the plan's target assets in its scope, then filter them (status, categories). Synchronous: the
 * scope's membership is already resolved (by the server for an area), statuses come from the status engine.
 * @returns {{ids: string[], pool: number, how: string, statusFilters: string[], categories: string[]|null, notAssets: string[]}}
 */
export function resolveTargets(plan, tools) {
  const t = plan.target;
  const explicit = ['NAMED', 'PREVIOUS', 'SELECTED'].includes(t.kind) ? t.ids : null;
  // A named or referenced asset is investigated wherever it is; a filter applies over the scope.
  const pool = explicit ?? tools.scopeAssets(plan.scope);
  const statusFilters = explicit ? [] : plan.assetFilters.operationalStatus;
  const categories = plan.assetFilters.assetTypes?.length ? plan.assetFilters.assetTypes : null;
  const notAssets = pool.filter(id => !tools.isAsset(id));
  let ids = pool.filter(id => tools.isAsset(id));
  if (statusFilters.length) ids = ids.filter(id => statusFilters.includes(tools.statusOf(id)?.status));
  if (categories) ids = ids.filter(id => categories.includes(tools.categoryOf(id)));
  return { ids: [...new Set(ids)], pool: pool.length, how: t.kind, statusFilters, categories, notAssets };
}

/**
 * Execute a maintenance investigation plan: targets → operational status → linked documents → inspection analysis.
 * @returns {Promise<{plan, targets, assets: object[], failures: object[], partial: boolean, limited: number|null, cancelled: boolean}>}
 *   each asset: {id, status (the status record), category, documents: {linked, index}, analysis | null, error | null}
 */
export async function runInvestigation(plan, tools, { concurrency = 3, maxAssets = 40, isCurrent = () => true, onProgress = () => {} } = {}) {
  const done = [];
  const progress = (step, extra = {}) => { done.push(step); onProgress({ step, label: STEP_LABEL[step] ?? step, ...extra }); };
  progress('RESOLVE_SCOPE');
  const targets = resolveTargets(plan, tools);
  progress('FILTER_ASSETS_BY_STATUS', { count: targets.ids.length });
  if (!isCurrent()) return { plan, targets, assets: [], failures: [], partial: false, limited: null, cancelled: true };
  const ids = targets.ids.slice(0, maxAssets);
  progress('RETRIEVE_OPERATIONAL_STATUS');
  const assets = ids.map(id => ({ id, status: tools.statusOf(id) ?? null, category: tools.categoryOf(id) ?? null, documents: { linked: null, index: null }, analysis: null, error: null }));
  progress('RETRIEVE_LINKED_DOCUMENTS');
  for (const a of assets) {
    const docs = tools.documentsOf(a.id);
    a.documents = { linked: Array.isArray(docs) ? docs.length : null, index: Array.isArray(docs) };
  }
  // Only assets with linked documents (or when the index is not loaded, every asset) are read.
  const toRead = assets.filter(a => a.documents.linked === null || a.documents.linked > 0);
  progress('ANALYSE_INSPECTIONS', { total: toRead.length, done: 0 });
  let finished = 0;
  const results = await mapLimit(toRead, concurrency, async a => {
    const r = await tools.analyze(a.id);
    finished += 1;
    onProgress({ step: 'ANALYSE_INSPECTIONS', label: STEP_LABEL.ANALYSE_INSPECTIONS, total: toRead.length, done: finished });
    return r;
  }, { isCurrent });
  if (!isCurrent()) return { plan, targets, assets, failures: [], partial: false, limited: null, cancelled: true };
  const failures = [];
  toRead.forEach((a, i) => {
    const r = results[i];
    if (r?.ok) a.analysis = r.value;
    else if (r) { a.error = r.error?.message ?? String(r.error); failures.push({ id: a.id, error: a.error, code: r.error?.code ?? null }); }
  });
  progress('BUILD_MAINTENANCE_ASSESSMENT');
  return { plan, targets, assets, failures, partial: failures.length > 0 || targets.ids.length > ids.length, limited: targets.ids.length > ids.length ? ids.length : null, cancelled: false };
}
