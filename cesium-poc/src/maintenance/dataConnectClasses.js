/**
 * The DataConnect classes the Maintenance workspace reads, in one place.
 *
 * No class id is hard-coded here. The repository has none, and the live instance
 * (dataconnect-demo-dqa3.cohesivecloud.app) answers 401 to every request, so none could be
 * discovered either — see `classId` below, which is read from the environment and stays null until
 * someone supplies it. Nothing in the UI names a class: components ask for `workOrders`.
 *
 * `className` is what the repository's existing DataConnect client sends
 * (POST /api/data-mgmt/v1/curated-data/search, by name); `classId` is for the id-based endpoint
 * (POST /api/v1/class/{classId}/curated-data). Whichever is available decides the request the
 * service makes — the class registry does not care which.
 *
 * `snapshot` names the committed export under public/dataconnect-data/, which is what the twin and
 * the iTwin demo both fall back to today (src/scenarioAPrime/dataSource.ts: live → snapshot → local).
 */

const env = key => {
  const value = import.meta.env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * @typedef {object} DataConnectClass
 * @property {string} key        how the app refers to it
 * @property {string} label      how a person refers to it
 * @property {string} className  the name the by-name endpoint expects
 * @property {string[]} snapshot files of the committed export that make up this class
 * @property {string|null} classId  for the by-id endpoint, from the environment, else null
 */
export const DATA_CONNECT_CLASSES = Object.freeze({
  assets: Object.freeze({
    key: 'assets', label: 'Assets', className: 'asset_registry',
    snapshot: ['asset_registry'], classId: env('VITE_DC_CLASS_ASSETS'),
  }),
  workOrders: Object.freeze({
    key: 'workOrders', label: 'Work Orders', className: 'work_orders',
    snapshot: ['work_orders'], classId: env('VITE_DC_CLASS_WORK_ORDERS'),
  }),
  tickets: Object.freeze({
    key: 'tickets', label: 'Tickets', className: 'tickets',
    snapshot: ['tickets'], classId: env('VITE_DC_CLASS_TICKETS'),
  }),
  tasks: Object.freeze({
    key: 'tasks', label: 'Tasks', className: 'tasks',
    snapshot: ['tasks'], classId: env('VITE_DC_CLASS_TASKS'),
  }),
  incidents: Object.freeze({
    key: 'incidents', label: 'Incidents', className: 'incidents_v3',
    snapshot: ['incidents_v3'], classId: env('VITE_DC_CLASS_INCIDENTS'),
  }),
  // Inspections are three sheets in the export — roadway, safety and ITS — and read as one
  // operational list. Each keeps its own form family in the normalized record.
  inspections: Object.freeze({
    key: 'inspections', label: 'Inspections', className: 'roadway_inspections_v3',
    snapshot: ['roadway_inspections_v3', 'safety_inspections_v3', 'its_inspections_v3'],
    classId: env('VITE_DC_CLASS_INSPECTIONS'),
  }),
});

/** @returns {DataConnectClass} */
export const dataConnectClass = key => DATA_CONNECT_CLASSES[key] ?? null;
