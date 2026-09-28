/**
 * What else the maintenance classes say about the same thing.
 *
 * A crash on I-595 is not one record. It is an incident, the ticket somebody raised about the
 * guardrail it destroyed, the task that sent a crew out, the work order that paid for the repair and
 * the inspection that signed it off — five classes, five sheets, one event. Reading any one of them
 * alone is how an operator ends up dispatching a second crew to a job already done.
 *
 * Three joins, and only three, because these are the only ones the data actually supports:
 *
 *   NAMED      one record prints another's identifier in a column of its own — a work order's
 *              `Related Ticket ID`, a task's `Related Ticket ID`, a damaged asset's `Inspection`.
 *              Exact, directional, and reported in both directions ("names this ticket" /
 *              "named by this work order").
 *   SAME EVENT both records name the same road event in `source_event_id`. This is what makes a
 *              LIVE chain whole: the ticket, its three tasks, the work order, the inspection and
 *              the damaged asset all carry the event key, but only some of them name each other.
 *              As exact as a named reference — it is the same identifier column — so it is ranked
 *              with them rather than with the weaker match below.
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
 * TODO(Arpana): one link of the live chain is still missing, and it needs a normaliser change.
 *
 * Done since this note was written — the live chain now appears in the Related tab:
 * - TICKET / TASK / WORK_ORDER / INSPECTION / ASSET_STATUS -> live event via related.eventId
 *   (`source_event_id`), as RAISED_BY_EVENT below;
 * - every member of one chain to every other, via the SAME EVENT join, which is what makes the
 *   inspection and the damaged asset visible from the ticket.
 *
 * Still missing, because the columns are not normalised yet rather than because the join is hard:
 * - INSPECTION -> ticket (`related_ticket_id`) and -> work order (`related_work_order_id`).
 *   normalizeInspection's `related` has no ticketId / workOrderId; add them there (or in
 *   liveDcSource.js viaHistorical for inspections) and then add the entries here. Today those two
 *   are reached through SAME EVENT, which is correct for live records but gives a historical
 *   inspection no way to name its ticket.
 */


/** The reference columns each class carries, as the normalizer already parsed them onto `related`. */
/**
 * Every live DataConnect record names the road event it was raised for, in `source_event_id`. That
 * is the strongest link in this data — stronger than a shared asset — because it says one thing
 * caused the other rather than that both stand in the same place.
 */
const RAISED_BY_EVENT = Object.freeze({
  field: item => item.related?.eventId, type: 'incidentRecord',
  forward: 'Raised for this incident', back: 'Raised for this incident',
});

const NAMED_REFERENCES = Object.freeze({
  WORK_ORDER: [
    { field: item => item.related?.ticketId, type: 'ticket', forward: 'Named by this work order', back: 'Names this ticket' },
    { field: item => item.related?.taskId, type: 'task', forward: 'Named by this work order', back: 'Names this task' },
    RAISED_BY_EVENT,
  ],
  TASK: [
    { field: item => item.related?.ticketId, type: 'ticket', forward: 'Named by this task', back: 'Names this ticket' },
    RAISED_BY_EVENT,
  ],
  ASSET_STATUS: [
    { field: item => item.related?.inspectionId, type: 'inspection', forward: 'Named by this damaged asset', back: 'Names this damaged asset' },
    RAISED_BY_EVENT,
  ],
  INSPECTION: [RAISED_BY_EVENT],
  TICKET: [RAISED_BY_EVENT],
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

  // 3. Everything raised for the same road event.
  //
  // The live classes hang a whole chain off one event key: the ticket, its tasks, the work order,
  // the inspection and the damaged asset all carry it in `source_event_id`, but only some of them
  // name each other. Without this, opening the ticket showed its tasks and work order and hid the
  // inspection and the damaged asset that belong to the same crash. An incident record IS the event,
  // so its own id is the key on that side.
  const eventKey = key(record.related?.eventId) ?? (record.type === 'INCIDENT' ? key(record.id) : null);
  if (eventKey) {
    for (const assetType of RELATED_ORDER) {
      for (const candidate of lookup(assetType)) {
        const candidateKey = key(candidate.related?.eventId)
          ?? (candidate.type === 'INCIDENT' ? key(candidate.id) : null);
        if (candidateKey === eventKey) add(assetType, candidate, `Same road event · ${eventKey}`, true);
      }
    }
  }

  // 4. Everything else standing on the same asset.
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

/**
 * Everything the maintenance classes hold for one FL511 live event.
 *
 * A live event on the map and a record in the register are the same happening seen from two sides.
 * The register's own row for it is found by FL511's item id — the event is `FL511-CLOSURE-876564`
 * and the record is `FL511-876564`, so the number is the only part that is common — and everything
 * that was then raised for it hangs off that row by `source_event_id`.
 *
 * Nothing is matched by position or by time. An event with no record yet gets no groups, which is
 * the truthful answer while a crew is still on the way.
 *
 * @param {object} event an FL511 live event (liveEventsData.js)
 * @param {(assetType: string) => object[]} lookup every loaded record of one asset type
 * @returns {{assetType: string, label: string, items: object[]}[]}
 */
export function liveEventRelatedGroups(event, lookup) {
  if (!event || typeof lookup !== 'function') return [];
  const fl511Id = key(event.rawSourceId);
  if (!fl511Id) return [];
  const incident = lookup('incidentRecord').find(item =>
    key(item.related?.fl511ItemId) === fl511Id || item.id === `FL511-${fl511Id}`);
  if (!incident) return [];
  // Everything hanging off the register's row for this event, plus that row itself — it is the
  // event's own record, not something related to it, so it leads its group.
  const groups = relatedRecordGroups(incident, lookup);
  const own = { record: incident, reason: 'This event in the register', named: true };
  const byType = new Map(groups.map(group => [group.assetType, group]));
  const incidents = byType.get('incidentRecord');
  byType.set('incidentRecord', {
    assetType: 'incidentRecord', label: LABELS.incidentRecord,
    items: [own, ...(incidents?.items ?? [])],
  });
  return RELATED_ORDER.filter(assetType => byType.get(assetType)?.items.length).map(assetType => byType.get(assetType));
}

/** How many related records there are in total — what the tab's badge counts. */
export const relatedRecordCount = groups => groups.reduce((total, group) => total + group.items.length, 0);
