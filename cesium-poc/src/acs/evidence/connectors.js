/**
 * Connectors to the systems that might hold a case's missing evidence.
 *
 * Same shape as `qcqa/providers/provider.js`, and for the same reason: everything above this line
 * asks for records and knows nothing about where they come from, so connecting the real Office
 * Track is writing one adapter and changing nothing else.
 *
 * WHAT IS REAL HERE. The DataConnect connector genuinely searches the records this application has
 * already loaded — work orders, tickets, tasks, inspections — by identifier, asset, place and
 * time. It is the only one that can be real today.
 *
 * Office Track, MIMS and SunGuide have no endpoint and no credentials in this deployment. There is
 * therefore no adapter pretending to be one: `apiConnector` REFUSES every call until it is given a
 * client, exactly as `apiProviderTemplate` does. What the demonstration uses instead is
 * `syntheticConnector`, which answers from the demo case file, reports `origin: 'SYNTHETIC'` on
 * every response and stamps `synthetic: true` on every record it returns. Nothing downstream may
 * draw one of those records without saying where it came from.
 */

/** Systems a case's evidence could live in. */
export const SYSTEMS = Object.freeze({
  OFFICE_TRACK: 'OFFICE_TRACK',
  MIMS: 'MIMS',
  DATACONNECT: 'DATACONNECT',
  SUNGUIDE: 'SUNGUIDE',
});

export const SYSTEM_LABELS = Object.freeze({
  OFFICE_TRACK: 'Office Track',
  MIMS: 'MIMS',
  DATACONNECT: 'DataConnect',
  SUNGUIDE: 'SunGuide',
});

/** Where a connector's answer came from. Carried on every response and never inferred. */
export const ORIGIN = Object.freeze({
  /** A real query against data this application holds. */
  LIVE: 'LIVE',
  /** A deterministic stand-in, because the system has no endpoint here. */
  SYNTHETIC: 'SYNTHETIC',
});

/** How a search ended. */
export const SEARCH_STATUS = Object.freeze({
  OK: 'OK',
  /** The system was reachable and holds nothing matching. */
  NO_MATCH: 'NO_MATCH',
  /** No endpoint, no credentials, or the call failed. Not the same as "nothing found". */
  UNAVAILABLE: 'UNAVAILABLE',
});

export const CONNECTOR_METHODS = Object.freeze(['search']);

/** A connector implements the whole interface or it is not one. */
export function assertConnector(connector, name = 'connector') {
  const missing = CONNECTOR_METHODS.filter(method => typeof connector?.[method] !== 'function');
  if (missing.length) throw new TypeError(`${name} is missing connector methods: ${missing.join(', ')}`);
  if (!connector.system) throw new TypeError(`${name} must declare the system it talks to`);
  return connector;
}

const response = fields => Object.freeze({
  records: Object.freeze([]), error: null, queriedAt: null, ...fields,
});

/**
 * The shape a real adapter takes. Deliberately inert.
 *
 * Returning an empty result without a client would read as "that system holds nothing", which is a
 * different and false claim from "we never asked it".
 */
export function apiConnector({ system, client = null, now = () => Date.now() } = {}) {
  return assertConnector({
    system,
    label: SYSTEM_LABELS[system] ?? system,
    origin: ORIGIN.LIVE,
    available: Boolean(client),
    async search() {
      if (!client) {
        return response({
          system,
          status: SEARCH_STATUS.UNAVAILABLE,
          origin: ORIGIN.LIVE,
          queriedAt: now(),
          error: `${SYSTEM_LABELS[system] ?? system}: no endpoint or credentials are configured in `
            + 'this deployment, so it was not queried. This is not a report that the system holds nothing.',
        });
      }
      throw new Error(`${system}: a client was supplied but no adapter has been written for it yet.`);
    },
  }, `apiConnector(${system})`);
}

/**
 * The real one: the records this application has already read from DataConnect.
 *
 * It searches the Maintenance workspace's own normalised records rather than re-reading the
 * service, so this and the Maintenance screen can never disagree about what exists. Only an
 * identifier the records themselves carry is used to match — never proximity alone.
 *
 * @param {{maintenance: object, now?: () => number}} deps  `maintenance` is the installed
 *        workspace (`window.__maintenance` in the browser).
 */
export function createDataConnectConnector({ maintenance = null, now = () => Date.now() } = {}) {
  const CLASSES = ['workOrders', 'tickets', 'tasks', 'inspections', 'incidents'];
  const attrs = record => record?.raw?.attributes ?? record?.raw ?? {};
  const text = (record, ...keys) => {
    for (const key of keys) {
      const value = String(attrs(record)[key] ?? '').trim();
      if (value && !/^(n\/?a|none|null)$/i.test(value)) return value;
    }
    return null;
  };

  return assertConnector({
    system: SYSTEMS.DATACONNECT,
    label: SYSTEM_LABELS.DATACONNECT,
    origin: ORIGIN.LIVE,
    get available() { return typeof maintenance?.recordsOf === 'function'; },

    async search({ context }) {
      if (typeof maintenance?.recordsOf !== 'function') {
        return response({
          system: SYSTEMS.DATACONNECT, status: SEARCH_STATUS.UNAVAILABLE, origin: ORIGIN.LIVE,
          queriedAt: now(),
          error: 'The Maintenance workspace has not loaded its DataConnect classes, so there is '
            + 'nothing to search yet.',
        });
      }
      const found = [];
      for (const key of CLASSES) {
        for (const record of maintenance.recordsOf(key) ?? []) {
          const keys = {
            incidentId: text(record, 'source_event_id', 'incident_id'),
            workOrderId: text(record, 'Work Order ID', 'related_work_order_id'),
            assetId: record.assetId ?? text(record, 'Asset ID', 'asset_id', 'damaged_asset_id'),
            locationDistanceM: null,
            minutesFromIncident: null,
            direction: null,
          };
          // Only an identifier the record itself carries. A DataConnect row is not proposed as a
          // case's evidence because it happens to sit nearby.
          const hit = (context.incidentId && keys.incidentId === context.incidentId)
            || (context.workOrderId && keys.workOrderId === context.workOrderId)
            || (context.assetId && keys.assetId === context.assetId);
          if (!hit) continue;
          found.push({
            recordId: record.id,
            system: SYSTEMS.DATACONNECT,
            recordType: key,
            summary: [record.title, record.status].filter(Boolean).join(' · ') || record.id,
            value: record.description ?? record.title ?? null,
            capturedAt: record.createdDate ?? null,
            keys,
            /** Context for an open case rather than a record that fills a gap. */
            resolves: null,
            enriches: true,
            synthetic: false,
            origin: ORIGIN.LIVE,
          });
        }
      }
      return response({
        system: SYSTEMS.DATACONNECT,
        status: found.length ? SEARCH_STATUS.OK : SEARCH_STATUS.NO_MATCH,
        origin: ORIGIN.LIVE,
        queriedAt: now(),
        records: Object.freeze(found),
      });
    },
  }, 'dataConnectConnector');
}

/**
 * A stand-in for a system this deployment cannot reach.
 *
 * It answers from the demo case file, which is what makes it deterministic: the same case always
 * produces the same candidates in the same order, so a demonstration can be rehearsed. Every
 * record it returns is stamped `synthetic: true` and every response reports `origin: 'SYNTHETIC'`,
 * so no surface can show one as an API result.
 *
 * `unavailableFor` lets a case declare that a system did not answer at all, which is a different
 * outcome from finding nothing and is drawn differently.
 */
export function createSyntheticConnector({ system, now = () => Date.now() } = {}) {
  return assertConnector({
    system,
    label: SYSTEM_LABELS[system] ?? system,
    origin: ORIGIN.SYNTHETIC,
    available: true,
    synthetic: true,

    async search({ demoCase }) {
      const recovery = demoCase?.evidenceRecovery ?? {};
      if ((recovery.unavailableSystems ?? []).includes(system)) {
        return response({
          system, status: SEARCH_STATUS.UNAVAILABLE, origin: ORIGIN.SYNTHETIC, queriedAt: now(),
          error: `${SYSTEM_LABELS[system] ?? system} did not respond to the search. `
            + 'Synthetic outcome, included so an unanswered source is visible rather than silent.',
        });
      }
      const records = (recovery.candidates ?? [])
        .filter(candidate => candidate.system === system)
        .map(candidate => Object.freeze({ ...candidate, synthetic: true, origin: ORIGIN.SYNTHETIC }));
      return response({
        system,
        status: records.length ? SEARCH_STATUS.OK : SEARCH_STATUS.NO_MATCH,
        origin: ORIGIN.SYNTHETIC,
        queriedAt: now(),
        records: Object.freeze(records),
      });
    },
  }, `syntheticConnector(${system})`);
}

/**
 * The connector set the demonstration runs on.
 *
 * DataConnect is real. The other three are synthetic and say so. Passing `clients` swaps any of
 * them for a real adapter the day endpoints exist, and nothing above this changes.
 */
export function createDemoConnectors({ maintenance = null, clients = {}, now = () => Date.now() } = {}) {
  return Object.freeze([
    createDataConnectConnector({ maintenance, now }),
    ...[SYSTEMS.OFFICE_TRACK, SYSTEMS.MIMS, SYSTEMS.SUNGUIDE].map(system =>
      (clients[system] ? apiConnector({ system, client: clients[system], now })
        : createSyntheticConnector({ system, now }))),
  ]);
}
