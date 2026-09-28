/**
 * What else the maintenance classes say about the same thing.
 *
 * A crash on I-595 is not one record. It is an incident, the ticket somebody raised about the
 * guardrail it destroyed, the task that sent a crew out, the work order that paid for the repair and
 * the inspection that signed it off — five classes, five sheets, one event. Reading any one of them
 * alone is how an operator ends up dispatching a second crew to a job already done.
 *
 * Two joins, and only two, because these are the only ones the data actually supports:
 *
 *   NAMED      one record prints another's identifier in a column of its own — a work order's
 *              `Related Ticket ID`, a task's `Related Ticket ID`, a damaged asset's `Inspection`.
 *              Exact, directional, and reported in both directions ("names this ticket" /
 *              "named by this work order").
 *   SAME ASSET both records point at the same entry in the asset registry. Weaker than a named
 *              reference — two work orders on one drainage structure five years apart share an
 *              asset and nothing else — so it is labelled as what it is, never as causation.
 *
 * Nothing is joined on a date window, a distance or similar-looking text. A guessed link in a
 * maintenance tool is worse than no link: it is acted on.
 *
 * Pure — records in, grouped records out — so the rules are unit-tested against the real export.
 */

/*
 * TODO(Arpana): show the whole LIVE incident chain in the Related tab. Comment only; nothing here
 * changes at runtime.
 *
 * Live incidents already have a complete, exact chain in DataConnect's "SDNA Florida I595 Live *"
 * classes: Live Event -> Ticket -> Tasks -> Work Order -> Inspection -> Asset Status (damaged).
 * Live event records are INCIDENT-type items with `live: true`; their id is the event key
 * (code / keyInSource), which is the value every other live class stores in `source_event_id`.
 *
 * Live tickets/tasks/work orders are normalised by the historical normalisers (via
 * src/maintenance/liveDcSource.js viaHistorical), so the Bentley-named joins above already work
 * for them: task -> ticket and work order -> ticket/task via related.ticketId / related.taskId
 * ("Related Ticket ID" / "Related Task ID").
 *
 * Still to add to NAMED_REFERENCES (identifiers printed in the record's own columns, so named
 * links, not guesses):
 * - TICKET / TASK / WORK_ORDER / INSPECTION / ASSET_STATUS -> live event: `source_event_id`,
 *   already normalised as related.eventId (viaHistorical and normalizeLiveAssetStatus).
 *   Target type: 'incidentRecord'.
 * - ASSET_STATUS -> inspection: `source_inspection_id`, already related.inspectionId (existing entry).
 * - INSPECTION -> ticket (`related_ticket_id`) and -> work order (`related_work_order_id`): NOT
 *   normalised yet. normalizeInspection's `related` has no ticketId / workOrderId; add them there
 *   (or in liveDcSource.js viaHistorical for inspections) before referencing them here.
 */

/** The reference columns each class carries, as the normalizer already parsed them onto `related`. */
const NAMED_REFERENCES = Object.freeze({
  WORK_ORDER: [
    { field: item => item.related?.ticketId, type: 'ticket', forward: 'Named by this work order', back: 'Names this ticket' },
    { field: item => item.related?.taskId, type: 'task', forward: 'Named by this work order', back: 'Names this task' },
  ],
  TASK: [
    { field: item => item.related?.ticketId, type: 'ticket', forward: 'Named by this task', back: 'Names this ticket' },
  ],
  ASSET_STATUS: [
    { field: item => item.related?.inspectionId, type: 'inspection', forward: 'Named by this damaged asset', back: 'Names this damaged asset' },
  ],
  INSPECTION: [],
  TICKET: [],
  INCIDENT: [],
});

/** Record type → the explorer's asset type, which is what a panel needs to select one. */
export const TYPE_TO_ASSET_TYPE = Object.freeze({
  WORK_ORDER: 'workOrder', TICKET: 'ticket', TASK: 'task',
  INCIDENT: 'incidentRecord', INSPECTION: 'inspection', ASSET_STATUS: 'damagedAsset',
});

/** The order a related panel lists the classes in — the order work moves through them. */
export const RELATED_ORDER = Object.freeze(['incidentRecord', 'ticket', 'task', 'workOrder', 'inspection', 'damagedAsset']);

const LABELS = Object.freeze({
  incidentRecord: 'Incidents', ticket: 'Tickets', task: 'Tasks',
  workOrder: 'Work Orders', inspection: 'Inspections', damagedAsset: 'Damaged Assets',
});

const key = value => {
  const string = value == null ? '' : String(value).trim();
  return string || null;
};

/**
 * Everything the other classes say about one record.
 *
 * @param {object} record a normalized maintenance record (maintenanceRecords.js)
 * @param {(assetType: string) => object[]} lookup every loaded record of one asset type
 * @returns {{assetType: string, label: string, items: {record: object, reason: string, named: boolean}[]}[]}
 *   one group per class that has something to say; a class with nothing is left out entirely rather
 *   than shown empty.
 */
export function relatedRecordGroups(record, lookup) {
  if (!record || typeof lookup !== 'function') return [];
  const ownType = TYPE_TO_ASSET_TYPE[record.type] ?? null;
  const ownAsset = key(record.assetId);
  /** assetType -> id -> entry. One map per class, so a record found by both joins is listed once. */
  const found = new Map();
  const add = (assetType, item, reason, named) => {
    if (!item) return;
    // A record never relates to itself, however many joins reach it.
    if (assetType === ownType && item.id === record.id) return;
    const bucket = found.get(assetType) ?? new Map();
    const existing = bucket.get(item.id);
    // A named reference outranks a shared asset: it says more, so it is the reason that is shown.
    if (!existing || (named && !existing.named)) bucket.set(item.id, { record: item, reason, named });
    found.set(assetType, bucket);
  };

  // 1. References this record prints in its own columns.
  for (const reference of NAMED_REFERENCES[record.type] ?? []) {
    const id = key(reference.field(record));
    if (!id) continue;
    add(reference.type, lookup(reference.type).find(item => item.id === id || item.sourceId === id),
      reference.back, true);
  }

  // 2. References OTHER records print to this one. A ticket does not know its work orders; the work
  //    orders know the ticket, and an operator opening the ticket needs to see them.
  for (const [type, references] of Object.entries(NAMED_REFERENCES)) {
    const assetType = TYPE_TO_ASSET_TYPE[type];
    for (const reference of references) {
      if (reference.type !== ownType) continue;
      for (const candidate of lookup(assetType)) {
        const id = key(reference.field(candidate));
        if (id && (id === record.id || id === record.sourceId)) add(assetType, candidate, reference.forward, true);
      }
    }
  }

  // 3. Everything else standing on the same asset.
  if (ownAsset) {
    for (const assetType of RELATED_ORDER) {
      for (const candidate of lookup(assetType)) {
        if (key(candidate.assetId) === ownAsset) add(assetType, candidate, `Same asset · ${ownAsset}`, false);
      }
    }
  }

  return RELATED_ORDER
    .filter(assetType => found.get(assetType)?.size)
    .map(assetType => ({
      assetType,
      label: LABELS[assetType] ?? assetType,
      // Named references first — they are the stronger claim — then by date, newest first.
      items: [...found.get(assetType).values()].sort((a, b) =>
        Number(b.named) - Number(a.named)
        || String(b.record.createdDate ?? '').localeCompare(String(a.record.createdDate ?? ''))
        || String(a.record.id).localeCompare(String(b.record.id))),
    }));
}

/** How many related records there are in total — what the tab's badge counts. */
export const relatedRecordCount = groups => groups.reduce((total, group) => total + group.items.length, 0);
