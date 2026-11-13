/**
 * The SAP Business Accelerator Hub sandbox adapter — the one real HTTP call in this project.
 *
 * WHAT THIS IS, PRECISELY. The endpoint is SAP SuccessFactors Public Sector Management
 * (`SFPublicSectorManagement_Odata`), OData v2, entity set `ProjectControllingObject`. Its records
 * are SuccessFactors MDF cost objects used to attribute HR cost to a project. They are NOT
 * S/4HANA Project System WBS elements, they carry no budget, planned or actual cost, and nothing
 * here may be read as the cost ledger that INT-04 models. The sandbox tenant is shared, public and
 * filled with placeholder values ("string"), so the records prove CONNECTIVITY and nothing else.
 *
 * It therefore deliberately does NOT implement the inbound adapter contract in `adapters.mjs`.
 * `assertAdapter` would be satisfied by a `fetch()` returning batches, and a batch is the shape the
 * sync engine upserts into the normalized tables — which is exactly what must not happen. INT-04
 * keeps its mock adapter and its own records; this object has no `entity`, no `key` and no route
 * into `runInboundSync`.
 *
 * SECURITY, by construction rather than by care:
 *  - the key is read from `process.env` here and never leaves this module. Nothing it returns
 *    contains it, and `redacted()` is asserted over every response before it is handed back.
 *  - the host is ALLOWLISTED and the path is a module constant. The caller chooses `top` and
 *    nothing else, so no frontend value can ever reach a URL.
 *  - the request headers are never logged, formatted or returned. Failures are logged by status
 *    and reason only.
 */
import { ENTITY_PATH, SERVICE } from './sapSandboxConfig.mjs';
import {
  CONNECTION, FAILURE, LIMITS as HTTP_LIMITS, createSapClient, odataDate, redacted, resolveBaseUrl,
} from './sapHttp.mjs';

/*
 * Phase 7C moved the credential handling, the allowlist, the timeout, the body cap and the
 * redaction check into `sapHttp.mjs`, so the cost adapter added in that phase cannot drift from
 * them. Nothing about this adapter's behaviour changed; the names are re-exported because
 * Phase 7A's route and tests import them from here.
 */
export { CONNECTION, FAILURE, odataDate, redacted, resolveBaseUrl };

export const LIMITS = Object.freeze({
  timeoutMs: HTTP_LIMITS.timeoutMs,
  maxBytes: HTTP_LIMITS.maxBytes,
  /** A connectivity probe, not an import. 25 is already more than a panel can show. */
  maxTop: 25,
  defaultTop: 5,
});

/**
 * Validate `top` strictly.
 *
 * Returns `null` for anything that is not a plain integer in range — the caller answers 400
 * rather than clamping, because a request for `top=1e9` is a mistake worth reporting, and silently
 * serving 5 records instead hides it.
 */
export function parseTop(value, { defaultTop = LIMITS.defaultTop } = {}) {
  if (value == null || value === '') return defaultTop;
  const text = String(value).trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const top = Number(text);
  return top >= 1 && top <= LIMITS.maxTop ? top : null;
}

/**
 * The fields we keep, and only these.
 *
 * An allowlist rather than a deletion list. The sandbox record carries ~60 localisation columns,
 * two deferred navigation URIs and a `__metadata.uri` that embeds the service host; passing the
 * record through and stripping a few keys would leak whatever SAP adds next. `createdBy` and
 * `lastModifiedBy` are dropped deliberately: they are account names on a tenant that is not ours,
 * and a connectivity panel has no use for them.
 */
export function sanitizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const text = key => (typeof record[key] === 'string' && record[key] ? record[key] : null);
  return {
    externalCode: text('externalCode'),
    name: text('name_defaultValue') ?? text('name_en_US'),
    description: text('description_defaultValue') ?? text('description_en_US'),
    objectType: text('projectControllingObjectType'),
    company: text('company'),
    /** SuccessFactors effective-dating: 'A' active, 'I' inactive. Reported, not translated. */
    effectiveStatus: text('effectiveStatus'),
    effectiveStartDate: odataDate(record.effectiveStartDate),
    effectiveEndDate: odataDate(record.effectiveEndDate),
    isStatistical: typeof record.isStatistical === 'boolean' ? record.isStatistical : null,
    lastModifiedDateTime: odataDate(record.lastModifiedDateTime),
  };
}

export function createSapSandboxAdapter({
  env = process.env, fetchImpl = globalThis.fetch, logger = console,
  timeoutMs = LIMITS.timeoutMs, now = () => new Date().toISOString(),
} = {}) {
  const client = createSapClient({ env, fetchImpl, logger, timeoutMs, label: 'sap-sandbox' });

  /** What the panel prints about the connection itself. Never includes the key. */
  const describe = () => {
    const base = client.baseUrl();
    return Object.freeze({
      provider: SERVICE.provider,
      environment: SERVICE.environment,
      service: SERVICE.service,
      entitySet: SERVICE.entitySet,
      protocol: SERVICE.protocol,
      /** The host and path, so the operator can see what is called. The key is a header. */
      endpoint: base.ok ? `${base.baseUrl}${ENTITY_PATH}` : null,
      authScheme: 'APIKey request header, held server-side',
      configured: client.configured(),
      /** Said on every response. This is the whole point of the separation. */
      scope: SERVICE.scope,
      notS4hana: SERVICE.notS4hana,
      readOnly: true,
    });
  };

  /**
   * One GET against the fixed entity path.
   *
   * Every exit returns the same shape — `{ state, failure, httpStatus, records, … }` — so the
   * route and the panel never have to tell a thrown error from a reported one. The credential,
   * the allowlist, the timeout, the body cap and the redaction check all live in `sapHttp.mjs`.
   */
  async function get({ top = LIMITS.defaultTop } = {}) {
    const at = now();
    const connection = describe();
    const blank = { connection, requestedAt: at, state: CONNECTION.FAILED, failure: null,
      httpStatus: null, reason: null, records: [], recordCount: 0, elapsedMs: null, top };

    const outcome = await client.collection(ENTITY_PATH, { $top: top });
    if (outcome.state !== CONNECTION.CONNECTED) {
      return { ...blank, state: outcome.state, failure: outcome.failure,
        httpStatus: outcome.httpStatus, elapsedMs: outcome.elapsedMs, reason: outcome.reason };
    }

    const records = outcome.rows.map(sanitizeRecord).filter(Boolean);
    return { ...blank, state: CONNECTION.CONNECTED, httpStatus: outcome.httpStatus,
      elapsedMs: outcome.elapsedMs, reason: null, records, recordCount: records.length,
      /** What came back versus what we kept, so a dropped record is visible. */
      receivedCount: outcome.rows.length,
      lastSuccessAt: at };
  }

  return {
    system: 'SAP',
    origin: 'SANDBOX',
    /** No `interfaceId`: this adapter belongs to no pilot interface. INT-04 is untouched. */
    interfaceId: null,
    describe,
    /** A probe. `top: 1` because a connection test should cost the least it can. */
    testConnection: () => get({ top: 1 }),
    fetchProjectControllingObjects: options => get(options),
  };
}
