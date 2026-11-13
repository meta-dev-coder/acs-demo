/**
 * One background worker per process, reference-counted.
 *
 * Shared by the OpenProject schedule worker and the Speckle BIM worker. It is generic on purpose:
 * both need the identical guarantee, and the two restart bugs this logic exists to prevent are
 * subtle enough that a second copy would reintroduce one of them.
 *
 * The bugs, both found by restarting the real dev server rather than by reading code:
 *
 *   1. A reloaded Vite module graph creating a SECOND timer against the same rate-limited cloud
 *      service. Fixed by keying the registry on `globalThis` under a `Symbol.for`, which is
 *      per PROCESS, rather than on a module-level variable, which is per module INSTANCE.
 *   2. Two APIs briefly coexisting during a restart, the new one adopting the live worker, and
 *      the old one then stopping "the worker it created" - leaving the new server holding a
 *      stopped worker with NOTHING POLLING EVER AGAIN. Fixed by counting holders: the last one
 *      to let go is the one that stops it.
 */

/**
 * `Symbol.for`, not a module-level `let`.
 *
 * Vite's dev server re-evaluates the module graph when the config changes, and `server/index.mjs`
 * and `vite.config.js` can both reach this file. A module-level variable is per module INSTANCE,
 * so a reloaded graph would get a fresh one and arm a second timer against the same cloud
 * instance. A registry on `globalThis` under a well-known symbol is per PROCESS, which is the
 * scope the uniqueness claim is actually about.
 */
const REGISTRY = Symbol.for('i595.construction.openProjectSyncWorkers');

const registry = () => (globalThis[REGISTRY] ??= new Map());

/**
 * The worker for this key, created once.
 *
 * @param {string} [key] one per database. The default is right for the single-database demo.
 */
/**
 * The worker for this key, created once, REFERENCE-COUNTED.
 *
 * The counting is not bookkeeping for its own sake — it is the fix for a bug this had. When Vite
 * restarts the dev server (it does, whenever a module in the config's own import graph changes),
 * two `createConstructionApi()` instances briefly coexist in ONE process, and the order of the new
 * one's `configureServer` against the old one's `close` is not ours to choose. Without counting:
 *
 *   new API acquires the live worker  →  old API closes  →  old API stops the worker it thought it
 *   owned  →  the new API now holds a stopped worker and NOTHING POLLS EVER AGAIN.
 *
 * That is what happened: the log showed `automatic synchronisation stopped` after a restart and no
 * second `automatic synchronisation on`. Found by watching the real dev server across a real
 * restart, not by reading the code.
 *
 * With counting, both orders are correct: the last holder to let go is the one that stops it.
 * A worker that has already stopped is never handed out — it can never poll again.
 */
export function acquireSyncWorker(key = 'default', factory) {
  const workers = registry();
  const entry = workers.get(key);
  if (entry && !entry.worker.stopped) {
    entry.refs += 1;
    return { worker: entry.worker, created: false, refs: entry.refs };
  }
  const worker = factory();
  workers.set(key, { worker, refs: 1 });
  return { worker, created: true, refs: 1 };
}

/**
 * Let go of it.
 *
 * @returns {boolean} true when this was the LAST holder, which means the caller should now stop
 *   the worker. False means somebody else is still using it and stopping it would silently kill
 *   their polling.
 */
export function releaseSyncWorker(key = 'default', worker = null) {
  const workers = registry();
  const entry = workers.get(key);
  if (!entry) return false;
  if (worker && entry.worker !== worker) return false;
  entry.refs -= 1;
  if (entry.refs > 0) return false;
  workers.delete(key);
  return true;
}

/** How many holders a key has. For tests and for a status line. */
export const syncWorkerRefs = (key = 'default') => registry().get(key)?.refs ?? 0;

/** For tests: start from an empty registry without reaching into `globalThis` by hand. */
export function resetSyncWorkerRegistry() {
  globalThis[REGISTRY] = new Map();
}
