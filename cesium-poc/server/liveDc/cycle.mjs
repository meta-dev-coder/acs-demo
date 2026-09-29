/**
 * One Live DataConnect sync cycle: FL511 corridor payload -> SDNA Florida I595 Live Events, then the
 * incident workflow (Tickets -> Tasks -> Work Orders -> Inspections -> Asset Status), each class
 * diffed against what DataConnect already holds so an unchanged poll writes nothing. Incremental
 * loads only, through the guarded writer. No timers and no CLI concerns, so the AWS poller lambda
 * can call runLiveDcCycle directly.
 */
import {
  LIVE_CLASS, LIVE_CLASS_NAMES, REF, diffRecords, fromCurated, isLiveClassName, liveClassDefinition, relationshipAttributes,
} from './classes.mjs';
import { reloadActiveRecord, syncLiveEvents } from './eventSync.mjs';
import { STICKY_FIELDS, typedValue } from './eventEnrichment.mjs';
import { loadWorkflowConfig, runWorkflow } from './workflow.mjs';
import { assetsFromCurated } from './assetCatalog.mjs';

const WORKFLOW_CLASSES = Object.freeze([
  LIVE_CLASS.TICKETS, LIVE_CLASS.TASKS, LIVE_CLASS.WORK_ORDERS, LIVE_CLASS.INSPECTIONS, LIVE_CLASS.ASSET_STATUS,
]);
const DEFAULT_TTL_SECONDS = 86400;

const iso = ms => new Date(ms).toISOString();
const byKey = (a, b) => (a.keyInSource < b.keyInSource ? -1 : a.keyInSource > b.keyInSource ? 1 : 0);

/** Records this process sent, keyed per class, so a lagging curated read-back is not mistaken for absence. */
export function createCycleMemory({ ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  return { ttlSeconds, overlay: new Map(LIVE_CLASS_NAMES.map(name => [name, new Map()])) };
}

/**
 * Read-back overlaid by what was sent. Returns a new array sorted by keyInSource and never touches
 * `readBack`; the only side effect is evicting overlay entries that are no longer needed (the
 * read-back has caught up) or too old to trust.
 */
export function mergeReadBack(readBack, memoryForClass, { now, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  const merged = new Map(readBack.map(record => [record.keyInSource, record]));
  for (const [key, { record, sentAt }] of memoryForClass ?? []) {
    const current = merged.get(key);
    const expired = now - sentAt > ttlSeconds * 1000;
    if (expired || (current && diffRecords([record], [current]).upserts.length === 0)) {
      memoryForClass.delete(key);
      continue;
    }
    merged.set(key, record);
  }
  return [...merged.values()].sort(byKey);
}

export function createAssetCache({ writer, refreshSeconds = 3600, now = Date.now }) {
  let assets = null;
  let loadedAt = 0;
  let pending = null;
  async function load() {
    const dto = await writer.findClassByName(REF.ASSETS);
    // Not filtered on `valid`: real Assets rows without a segment ID are curated valid=false.
    assets = assetsFromCurated(await writer.readAll(dto));
    loadedAt = now();
    return assets;
  }
  return {
    async get() {
      if (assets && now() - loadedAt < refreshSeconds * 1000) return assets;
      pending ??= load().finally(() => { pending = null; });
      return pending;
    },
  };
}

/** LIVE_DC_HOLD_OPEN: comma list of Live Events keys kept active even when FL511 no longer lists them. */
export function parseHoldOpen(value) {
  return new Set(String(value ?? '').split(',').map(key => key.trim()).filter(Boolean));
}

export async function runLiveDcCycle({
  holdOpen = new Set(),
  writer, service, now = Date.now, workflowConfig = loadWorkflowConfig(), profileName = workflowConfig.defaultProfile,
  heartbeatSeconds = 900, assetCache, memory = createCycleMemory(), linkMode = 'live', logger = console,
  capture = null, publicApiBase = '', enrichment,
}) {
  const at = now();
  const report = { at: iso(at), sourceStatus: null, sync: null, workflow: null, loads: {}, errors: [], warnings: [] };
  const warn = message => {
    report.warnings.push(message);
    logger.warn?.(`live-dc: ${message}`);
  };
  const fail = (className, error) => {
    report.errors.push(`${className}: ${error.message}`);
    logger.error?.(`live-dc: ${className}: ${error.message}`);
  };
  const overlayFor = name => {
    if (!memory.overlay.has(name)) memory.overlay.set(name, new Map());
    return memory.overlay.get(name);
  };
  const ttlSeconds = memory.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const classes = await writer.resolveLiveClasses();

  // One poll per cycle: snapshot() never starts the service's own interval poller.
  await service.refresh();
  const payload = await service.snapshot();
  report.sourceStatus = payload?.sourceStatus ?? null;

  // Codes DataConnect is known to have curated: the read-back plus records whose load curation was
  // confirmed. Overlay-only records from an unconfirmed load are excluded until the read-back shows them,
  // so nothing that references them is sent (it would be curated valid=false / ValueNotFound).
  const curatedKeys = new Map();
  const readMerged = async name => {
    const readBack = (await writer.readAll(classes.get(name))).map(fromCurated);
    const merged = mergeReadBack(readBack, overlayFor(name), { now: at, ttlSeconds });
    const keys = new Set(readBack.map(record => record.keyInSource));
    for (const [key, entry] of overlayFor(name)) if (entry.confirmed) keys.add(key);
    curatedKeys.set(name, keys);
    return merged;
  };
  const existingEvents = await readMerged(LIVE_CLASS.EVENTS);
  const existing = {};
  for (const name of WORKFLOW_CLASSES) existing[name] = await readMerged(name);
  // A ticket remembers when its event was first seen, even if the event itself is missing from the read-back.
  const firstSeenHints = new Map();
  for (const ticket of existing[LIVE_CLASS.TICKETS]) {
    if (ticket.keyInSource?.startsWith('TIC-') && ticket.created_at) firstSeenHints.set(ticket.keyInSource.slice(4), ticket.created_at);
  }

  const sync = syncLiveEvents({
    payload, existing: existingEvents, now: at, heartbeatSeconds, firstSeenHints, publicApiBase, holdOpen, ...(enrichment ? { enrichment } : {}),
  });
  report.sync = { skipped: sync.skipped, reason: sync.reason, stats: sync.stats };
  if (sync.stats.clearingSuppressed) warn('clearing suppressed: the FL511 poll was not fully healthy');

  // Snapshots and weather are filled into the records about to be loaded, and retried for young records
  // still missing them; a retry that fills a value makes that record an upsert. A failure never blocks the load.
  if (capture && !sync.skipped) {
    const loading = new Set(sync.upserts.map(record => record.keyInSource));
    const retries = sync.state.filter(record => !loading.has(record.keyInSource) && capture.needsCapture?.(record, at))
      .map(previous => ({ previous, record: reloadActiveRecord(previous, {}, { publicApiBase, ...(enrichment ? { enrichment } : {}) }) }));
    if (sync.upserts.length > 0 || retries.length > 0) {
      try {
        report.capture = await capture({ records: [...sync.upserts, ...retries.map(r => r.record)], events: payload?.events ?? [], now: now() });
        const filled = retries.filter(({ previous, record }) => STICKY_FIELDS.some(name => typedValue(name, record[name]) !== null
          && typedValue(name, previous[name]) === null)).map(r => r.record);
        if (filled.length) {
          sync.upserts = [...sync.upserts, ...filled].sort(byKey);
          const byKeyInSource = new Map(sync.state.map(record => [record.keyInSource, record]));
          for (const record of filled) byKeyInSource.set(record.keyInSource, record);
          sync.state = [...byKeyInSource.values()].sort(byKey);
        }
      } catch (error) {
        warn(`capture failed: ${error.message}`);
      }
    }
  }

  async function load(name, records) {
    const res = await writer.loadRecords(classes.get(name), records, { loadType: 'Incremental' });
    report.loads[name] = { sent: res.count, skipped: res.skipped, stats: res.stats, curation: res.curation?.status ?? null };
    if (res.skipped) return res;
    const sentAt = now();
    const overlay = overlayFor(name);
    const isConfirmed = confirmed(res);
    for (const record of records) {
      overlay.set(record.keyInSource, { record, sentAt, confirmed: isConfirmed });
      if (isConfirmed) curatedKeys.get(name).add(record.keyInSource);
    }
    // Identical re-sends mean the diff and the server disagree; left alone this repeats every cycle.
    if (res.stats && res.count > 0 && res.stats.notChanged === res.count) {
      warn(`no-op load for ${name} (n=${res.count}): check Incremental merge semantics`);
    }
    return res;
  }
  const confirmed = res => res.curation?.status === 'Finished';

  let eventsLoad;
  try {
    eventsLoad = await load(LIVE_CLASS.EVENTS, sync.upserts);
  } catch (error) {
    fail(LIVE_CLASS.EVENTS, error);
    return report;
  }

  const curatedEvents = curatedKeys.get(LIVE_CLASS.EVENTS);
  const events = sync.state.filter(record => curatedEvents.has(record.keyInSource));
  if (!eventsLoad.skipped && !confirmed(eventsLoad)) {
    warn(`curation not confirmed for ${LIVE_CLASS.EVENTS}; workflow limited to curated events`);
  } else if (events.length < sync.state.length) {
    warn(`workflow deferred for ${sync.state.length - events.length} ${LIVE_CLASS.EVENTS} record(s) not curated yet`);
  }

  let assets;
  try {
    assets = await assetCache.get();
  } catch (error) {
    fail(REF.ASSETS, error);
    return report;
  }
  const workflow = runWorkflow({ events, existing, assets, now: at, config: workflowConfig, profileName, linkMode });
  report.workflow = workflow.stats;

  for (const name of WORKFLOW_CLASSES) {
    const { upserts } = diffRecords(workflow.byClass[name], existing[name]);
    const links = relationshipAttributes(liveClassDefinition(name, { linkMode }))
      .filter(attr => isLiveClassName(attr.relatedClassName));
    const ready = upserts.filter(record => links.every(attr => curatedKeys.get(attr.relatedClassName)?.has(String(record[attr.name]))));
    if (ready.length < upserts.length) {
      warn(`deferring ${upserts.length - ready.length} ${name} record(s) whose parents are not curated yet`);
    }
    let res;
    try {
      res = await load(name, ready);
    } catch (error) {
      fail(name, error);
      break;
    }
    if (!res.skipped && !confirmed(res)) {
      warn(`curation not confirmed for ${name}; deferring dependants`);
      break;
    }
  }
  return report;
}
