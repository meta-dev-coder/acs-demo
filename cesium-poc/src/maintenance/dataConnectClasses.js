/**
 * The DataConnect classes the Maintenance workspace reads, in one place.
 *
 * No class id is written here. Ids are DISCOVERED from the instance — GET /api/v1/class through
 * this app's own proxy — and matched to the logical keys below by the class's own name. An id can
 * still be pinned per deployment with `VITE_DC_CLASS_*` when a name is ambiguous, but nothing is
 * guessed and nothing falls back to a made-up value: a class that cannot be found is reported as
 * missing, by name.
 *
 * `snapshot` names the committed export, used only when the data source is explicitly `mock`.
 *
 * The live instance prefixes its classes "Florida I595 …" (the corridor is one dataset among
 * several on the same host), so those names come first; the bare names that follow are the export's
 * own, kept so the mock source and any differently-named instance still resolve.
 */
import { listClasses } from './dataConnectClient.js';

const env = key => {
  const value = import.meta.env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * @typedef {object} DataConnectClass
 * @property {string} key         how the app refers to it
 * @property {string} label       how a person refers to it
 * @property {string[]} names     the class names to look for, in order of preference
 * @property {string[]} snapshot  export files, for the explicit mock source
 * @property {string|null} pinnedId  a deployment override, if any
 */
export const DATA_CONNECT_CLASSES = Object.freeze({
  assets: Object.freeze({
    key: 'assets', label: 'Assets', names: ['Florida I595 Assets', 'asset_registry', 'assets', 'Asset Registry'],
    snapshot: ['asset_registry'], pinnedId: env('VITE_DC_CLASS_ASSETS'),
  }),
  workOrders: Object.freeze({
    key: 'workOrders', label: 'Work Orders', names: ['Florida I595 Work Orders', 'work_orders', 'workorders', 'Work Orders'],
    snapshot: ['work_orders'], pinnedId: env('VITE_DC_CLASS_WORK_ORDERS'),
  }),
  tickets: Object.freeze({
    key: 'tickets', label: 'Tickets', names: ['Florida I595 Tickets', 'tickets', 'Tickets'],
    snapshot: ['tickets'], pinnedId: env('VITE_DC_CLASS_TICKETS'),
  }),
  tasks: Object.freeze({
    key: 'tasks', label: 'Tasks', names: ['Florida I595 Tasks', 'tasks', 'Tasks'],
    snapshot: ['tasks'], pinnedId: env('VITE_DC_CLASS_TASKS'),
  }),
  incidents: Object.freeze({
    key: 'incidents', label: 'Incidents', names: ['Florida I595 Incidents', 'incidents_v3', 'incidents', 'Incidents'],
    snapshot: ['incidents_v3'], pinnedId: env('VITE_DC_CLASS_INCIDENTS'),
  }),
  // Inspections are three form families in this dataset and read as one operational list.
  inspections: Object.freeze({
    key: 'inspections', label: 'Inspections',
    names: ['Florida I595 Roadway Inspections', 'Florida I595 Safety Inspections',
      'Florida I595 ITS Inspections',
      'roadway_inspections_v3', 'safety_inspections_v3', 'its_inspections_v3'],
    snapshot: ['roadway_inspections_v3', 'safety_inspections_v3', 'its_inspections_v3'],
    pinnedId: env('VITE_DC_CLASS_INSPECTIONS'),
  }),
});

export const dataConnectClass = key => DATA_CONNECT_CLASSES[key] ?? null;

/** Class names compare loosely: "Work Orders", "work_orders" and "workOrders" are one name. */
export const normalizeName = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Match the instance's classes to the logical keys.
 *
 * @param {object[]} classes  what GET /class returned
 * @returns {{ids: Record<string, string[]>, missing: string[], seen: {id: string, name: string}[]}}
 */
export function resolveClassIds(classes) {
  const seen = (classes ?? []).map(entry => ({
    id: String(entry?.id ?? entry?.classId ?? entry?.key ?? ''),
    name: String(entry?.name ?? entry?.className ?? entry?.displayName ?? ''),
  })).filter(entry => entry.id);
  const byName = new Map(seen.map(entry => [normalizeName(entry.name), entry.id]));
  const ids = {}, missing = [];
  for (const config of Object.values(DATA_CONNECT_CLASSES)) {
    if (config.pinnedId) { ids[config.key] = [config.pinnedId]; continue; }
    const found = config.names.map(name => byName.get(normalizeName(name))).filter(Boolean);
    if (found.length) ids[config.key] = [...new Set(found)];
    else missing.push(config.label);
  }
  return { ids, missing, seen };
}

/** Discover the ids once per session. */
let discovery = null;
export function discoverClasses({ refresh = false } = {}) {
  if (refresh) discovery = null;
  discovery ??= listClasses().then(resolveClassIds).catch(error => { discovery = null; throw error; });
  return discovery;
}
