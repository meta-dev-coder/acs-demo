/**
 * The domain colours, in one place so the map marks and the queue rows cannot drift apart.
 *
 * Kept out of the map layer so the panels — which are pure string functions, and are tested as
 * such — do not have to import Cesium to know what colour a domain is.
 */
export const DOMAIN_TONES = Object.freeze({
  /** Incident records: the corridor's amber, as every other screen uses for an event. */
  ACCIDENT: '#F4A725',
  /** Asset condition: maintenance orange, matching the Maintenance workspace's work-order cards. */
  ASSET: '#F97316',
  /** Inspection findings: teal, as the Inspections card already is. */
  HAZARD: '#14B8A6',
  /** Secondary incidents: violet, so they never read as another incident record. */
  SECONDARY: '#A78BFA',
  /** Two domains agreeing: the alert red, because it is the only cross-domain claim made. */
  CROSS: '#E5484D',
});
