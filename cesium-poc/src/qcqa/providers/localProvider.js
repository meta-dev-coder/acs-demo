/**
 * The provider over the data the application already has.
 *
 * It reads the Maintenance workspace's own normalised records rather than re-reading DataConnect,
 * so the QC/QA screen and the Maintenance screen can never disagree about how many records exist.
 */
import { assertProvider } from './provider.js';

const attrs = record => record?.raw?.attributes ?? record?.raw ?? record ?? {};
const value = (record, key) => {
  const got = attrs(record)[key];
  const out = String(got ?? '').trim();
  return out && !/^(n\/?a|none|null)$/i.test(out) ? out : null;
};

/**
 * @param {{maintenance: object, acsCaseFor?: (record: object) => object|null}} deps
 *   `maintenance` is the installed workspace (`window.__maintenance` in the browser).
 */
export function createLocalProvider({ maintenance, acsCaseFor = null }) {
  const all = key => maintenance?.recordsOf?.(key) ?? [];
  const byId = (key, id) => all(key).find(record =>
    record.id === id || value(record, 'code') === id) ?? null;

  /**
   * Records that belong together because a record SAYS so.
   *
   * Never joined by proximity or by date: an inspection 300 m from a work order on the same day is
   * not evidence that they are about the same thing.
   */
  const relatedTo = (record) => {
    const id = record?.id ?? null;
    const eventId = value(record, 'source_event_id');
    const ticketId = value(record, 'Related Ticket ID') ?? value(record, 'related_ticket_id');
    const workOrderId = value(record, 'related_work_order_id') ?? value(record, 'Work Order ID');
    return { id, eventId, ticketId, workOrderId };
  };

  const provider = {
    async getCase(caseId) {
      return byId('incidents', caseId) ?? byId('workOrders', caseId) ?? byId('tickets', caseId)
        ?? byId('inspections', caseId) ?? byId('tasks', caseId);
    },

    async getInspection(caseId) {
      const record = await provider.getCase(caseId);
      if (!record) return null;
      if (value(record, 'inspection_form_family')) return record;
      const links = relatedTo(record);
      return all('inspections').find(inspection =>
        (links.id && value(inspection, 'related_work_order_id') === links.id)
        || (links.ticketId && value(inspection, 'related_ticket_id') === links.ticketId)
        || (links.eventId && value(inspection, 'source_event_id') === links.eventId)) ?? null;
    },

    async getWorkOrders(caseId) {
      const record = await provider.getCase(caseId);
      if (!record) return [];
      if (value(record, 'Work Order ID')) return [record];
      const links = relatedTo(record);
      return all('workOrders').filter(order =>
        (links.workOrderId && value(order, 'Work Order ID') === links.workOrderId)
        || (links.ticketId && value(order, 'Related Ticket ID') === links.ticketId)
        || (links.eventId && value(order, 'source_event_id') === links.eventId));
    },

    async getAssets(caseId) {
      const record = await provider.getCase(caseId);
      const assetId = value(record, 'Asset ID') ?? value(record, 'asset_id')
        ?? value(record, 'damaged_asset_id');
      if (!assetId) return [];
      const asset = maintenance?.assetIndex?.()?.get(assetId);
      return asset ? [{ id: assetId, ...asset }] : [];
    },

    /**
     * Per-question ACS QC/QA responses.
     *
     * Always null. No system in scope holds them — see the field mapping registry. Returning an
     * empty object instead would read as "answered, all blank", which is a different and false
     * claim.
     */
    async getQCResponses() { return null; },

    /** Approval records. None exist in any class. */
    async getApprovals() { return { qc: null, qa: null }; },

    /**
     * Evidence files. The ACS export carries photo COUNTS and no images, so there is nothing to
     * return; the count travels on the ACS task instead.
     */
    async getEvidence() { return []; },

    /** The ACS repair task associated with the record, where one is. */
    async getAcsCase(caseId) {
      const record = await provider.getCase(caseId);
      return record && acsCaseFor ? acsCaseFor(record) : null;
    },

    assetIndex: () => maintenance?.assetIndex?.() ?? new Map(),
    name: 'local:DataConnect',
  };
  return assertProvider(provider, 'localProvider');
}
