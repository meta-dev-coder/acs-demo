/**
 * The data provider interface.
 *
 * Everything above this line — templates, selection, mapping, the engine, the UI — reads a
 * canonical case and knows nothing about where it came from. Swapping DataConnect for Office
 * Track, MIMS or SunGuide means writing one of these, and changing nothing else.
 *
 * No provider here calls a real external API. The spec is explicit that endpoints and credentials
 * do not exist yet, so there is no mock pretending to be one: `apiProviderTemplate` throws until
 * it is given a real client.
 */

/**
 * @typedef {object} QcQaProvider
 * @property {(caseId: string) => Promise<object|null>} getCase
 * @property {(caseId: string) => Promise<object|null>} getInspection
 * @property {(caseId: string) => Promise<object[]>} getWorkOrders
 * @property {(caseId: string) => Promise<object[]>} getAssets
 * @property {(caseId: string) => Promise<object|null>} getQCResponses
 * @property {(caseId: string) => Promise<object[]>} getEvidence
 * @property {(caseId: string) => Promise<{qc: object|null, qa: object|null}>} getApprovals
 */

export const PROVIDER_METHODS = Object.freeze([
  'getCase', 'getInspection', 'getWorkOrders', 'getAssets', 'getQCResponses', 'getEvidence',
  'getApprovals',
]);

/** A provider implements the whole interface or it is not one. */
export function assertProvider(provider, name = 'provider') {
  const missing = PROVIDER_METHODS.filter(method => typeof provider?.[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`${name} is missing provider methods: ${missing.join(', ')}`);
  }
  return provider;
}

/**
 * The shape a real API provider takes.
 *
 * Deliberately inert. Wiring Office Track or MIMS means supplying `client` and the per-source
 * field paths; until then every call throws rather than returning an empty case that would read
 * as "nothing found".
 */
export function apiProviderTemplate({ name, client = null } = {}) {
  const refuse = method => async () => {
    throw new Error(`${name}: no client is configured, so ${method}() cannot be called. `
      + 'Supply real endpoints and credentials before enabling this provider.');
  };
  if (!client) {
    return Object.freeze(Object.fromEntries(PROVIDER_METHODS.map(method => [method, refuse(method)])));
  }
  throw new Error(`${name}: a client was supplied but no adapter has been written for it yet.`);
}
