/**
 * The published repair-time targets, read straight from DataConnect.
 *
 * `Florida I595 Asset Category Repair Times` is the one class in the instance that says how long a
 * repair on a given asset category is SUPPOSED to take. Without it, "overdue" would be a number
 * this app invented, so the screen reads the class rather than assuming a target — and when the
 * class is absent or the fetch fails, every work order is reported as "no target published" and the
 * two target-dependent KPIs go UNAVAILABLE.
 *
 * It is read here rather than through the Maintenance workspace because that workspace's class list
 * drives its cards and its missing-class warning; a class only this screen needs does not belong in
 * its backlog.
 */
import { getCuratedData, listClasses } from '../maintenance/dataConnectClient.js';
import { normalizeName } from '../maintenance/dataConnectClasses.js';

const NAMES = Object.freeze([
  'Florida I595 Asset Category Repair Times',
  'asset_category_repair_times',
  'Asset Category Repair Times',
]);

let pending = null;

/**
 * @returns {Promise<{records: object[], available: boolean, note: string}>}
 */
export function loadRepairTargets({ refresh = false } = {}) {
  if (refresh) pending = null;
  pending ??= (async () => {
    const classes = await listClasses();
    const wanted = new Set(NAMES.map(normalizeName));
    const found = classes.find(entry => wanted.has(normalizeName(
      entry?.name ?? entry?.className ?? entry?.displayName)));
    if (!found) {
      return Object.freeze({
        records: Object.freeze([]), available: false,
        note: 'No repair-time target class is published on this instance, so work-order age is '
          + 'reported without a target.',
      });
    }
    const { records } = await getCuratedData(String(found.id ?? found.classId), { pageSize: 500 });
    return Object.freeze({
      records: Object.freeze(records),
      available: records.length > 0,
      note: `Targets from “${found.name ?? 'Asset Category Repair Times'}” (${records.length} categories).`,
    });
  })().catch(error => {
    pending = null;
    return Object.freeze({
      records: Object.freeze([]), available: false,
      note: `Repair-time targets could not be read (${error?.message ?? 'request failed'}), so work-order `
        + 'age is reported without a target.',
    });
  });
  return pending;
}
