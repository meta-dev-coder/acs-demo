/**
 * What the SAP sandbox connection is allowed to talk to, and what it is.
 *
 * Its own module so the allowlist is one short file to audit. Nothing here is configurable from a
 * request: the caller picks `$top` and the adapter builds everything else from these constants.
 */

/** The only hosts a credential may be sent to. */
export const ALLOWED_HOSTS = Object.freeze(['sandbox.api.sap.com']);

export const DEFAULT_BASE_URL = 'https://sandbox.api.sap.com';

/** Fixed. A path assembled from request data is how an allowlisted host still leaks a key. */
export const ENTITY_PATH = '/SFPublicSectorManagement_Odata/ProjectControllingObject';

/**
 * What this endpoint actually serves.
 *
 * Written out in full because the honest description is the whole value of the integration: a
 * panel reading "SAP — Connected" beside a cost table would be read as the SAP cost ledger being
 * live, and it is not.
 */
export const SERVICE = Object.freeze({
  provider: 'SAP SE',
  environment: 'SAP Business Accelerator Hub — Sandbox',
  service: 'SAP SuccessFactors Public Sector Management (SFPublicSectorManagement_Odata)',
  entitySet: 'ProjectControllingObject',
  protocol: 'OData v2 (JSON)',
  scope: 'Connectivity only. These are SuccessFactors MDF cost objects used to attribute HR cost '
    + 'to a project. The shared sandbox tenant holds placeholder values, so the records prove that '
    + 'the call, the API key and the response parsing work — nothing more.',
  notS4hana: 'Not S/4HANA Project System data. No WBS element, budget, planned cost, actual cost, '
    + 'BOQ quantity or unit rate in this project comes from here, and none is offered by this '
    + 'endpoint.',
});

/**
 * The statement that sits beside "SAP Sandbox — Connected".
 *
 * A value rather than words in a template, so the backend and the panel cannot drift apart on the
 * one claim in this feature that matters most. INT-04 reads the `src_sap_*` tables and will keep
 * reading them until a real S/4HANA connection is built and approved; this says so in the same
 * response that reports a successful call.
 */
export const S4HANA_PROJECT_DATA = Object.freeze({
  connected: false,
  label: 'SAP S/4HANA Project Data — Not Connected',
  detail: 'INT-04 continues to read the mock src_sap_* tables: WBS elements, budget, planned and '
    + 'actual cost, BOQ quantities and unit rates are all synthetic. The sandbox connection above '
    + 'does not feed INT-04 and has not changed a single record in it.',
});
