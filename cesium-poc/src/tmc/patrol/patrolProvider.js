/**
 * The patrol data contract.
 *
 * The TMC workspace talks to THIS, never to a simulation. That is the whole point: when ACS can
 * give us real AVL, a second provider implements the same five methods and the workspace does not
 * change. Nothing below knows that the first implementation is simulated.
 *
 * The contract is deliberately read-only and time-addressed. Every method takes the moment being
 * looked at, because the TMC is a historical investigation tool: "where were the patrols" is a
 * question about a past instant, not about now. A provider that ignored the timestamp and returned
 * live positions would be answering a different question.
 *
 * Pure interface: no DOM, no Cesium, no fetching here.
 */
import { PATROL_SOURCE_TYPES, PATROL_STATUS } from './patrolConfig.js';

/**
 * @typedef {object} Patrol                     A provider-neutral patrol record.
 * @property {string} id                        Stable identifier, e.g. 'SIM-RR-02'.
 * @property {string} displayName               What an operator reads.
 * @property {string} serviceArea               The beat this patrol covers, in words.
 * @property {string} assignedRoute             The route it is assigned to.
 * @property {string} status                    One of PATROL_STATUS.
 * @property {number} latitude
 * @property {number} longitude
 * @property {number|null} heading              Degrees clockwise from north, or null if unknown.
 * @property {number|null} speed                km/h, or null if the source does not publish it.
 * @property {number} simulationTimestamp       The instant this position describes (epoch ms).
 * @property {string} sourceType                PATROL_SOURCE_TYPES — how to read everything above.
 * @property {string} scenarioId                Which scenario produced it.
 * @property {string} carriageway               Which side of the divided highway it is on.
 * @property {number|null} corridorAlongM       Metres ALONG the corridor centerline (not lateral offset).
 */

/**
 * @typedef {object} DispatchOption             One patrol considered for one incident.
 * @property {Patrol} patrol
 * @property {boolean} eligible
 * @property {string|null} ineligibleReason     Why not, in words an operator can act on.
 * @property {object|null} route                From the routing module, or null when unresolved.
 * @property {number|null} travelSeconds        null whenever the route is unresolved.
 */

/**
 * The five methods every provider implements.
 *
 * Listed as data so a test can assert a provider is complete without calling anything, and so the
 * future real provider has an unambiguous checklist.
 */
export const PATROL_PROVIDER_METHODS = Object.freeze([
  'getPatrolsAt',
  'getPatrolPositionsAt',
  'getPatrolAvailabilityAt',
  'getDispatchOptions',
  'getResponseScenario',
]);

/**
 * Whether an object satisfies the contract.
 *
 * @returns {{ok: boolean, missing: string[]}}
 */
export function describeProvider(provider) {
  const missing = PATROL_PROVIDER_METHODS.filter(name => typeof provider?.[name] !== 'function');
  return Object.freeze({ ok: missing.length === 0 && Boolean(provider), missing: Object.freeze(missing) });
}

/**
 * Wrap a provider so a contract breach fails here rather than three layers up in a render.
 *
 * @param {object} provider
 * @returns {object} the same provider, once it is known to be complete
 */
export function asPatrolProvider(provider) {
  const { ok, missing } = describeProvider(provider);
  if (!ok) throw new TypeError(`Patrol provider is missing: ${missing.join(', ') || 'everything'}`);
  return provider;
}

/**
 * Whether a record came from a simulation.
 *
 * Read from the record, never from configuration — a mixed list must be able to say which of its
 * own rows is real, and a UI must not have to be told separately.
 */
export const isSimulated = record => record?.sourceType === PATROL_SOURCE_TYPES.SIMULATED;

/** True when every record in a list is simulated. An empty list is not a claim either way. */
export const allSimulated = records =>
  Array.isArray(records) && records.length > 0 && records.every(isSimulated);

/**
 * The shape of availability, so the UI never counts statuses itself.
 *
 * `unavailable` is not `total − available`: a dispatched patrol is neither, and collapsing the
 * three into two would hide the fleet that is already working.
 */
export function summariseAvailability(patrols) {
  const list = Array.isArray(patrols) ? patrols : [];
  const by = status => list.filter(patrol => patrol.status === status).length;
  return Object.freeze({
    total: list.length,
    available: by(PATROL_STATUS.AVAILABLE),
    busy: by(PATROL_STATUS.BUSY),
    outOfService: by(PATROL_STATUS.OUT_OF_SERVICE),
    engaged: list.filter(patrol => [
      PATROL_STATUS.DISPATCHED, PATROL_STATUS.EN_ROUTE, PATROL_STATUS.ON_SCENE, PATROL_STATUS.SCENE_WORK,
    ].includes(patrol.status)).length,
  });
}
