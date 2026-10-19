/**
 * One registry for the UI actions the twin can take: fly the map, open cameras, restore a view,
 * record a playbook decision, switch a layer.
 *
 * Before this, every answer, button and panel called its own helper directly, so there was no single
 * place to ask "what can the twin do to the screen?", nothing that told a view change (harmless,
 * undoable) apart from a state change (an operator's decision), and no record of what ran. Here:
 *
 * - `view` actions run as soon as they are asked for. Whether an answer may ask for one on its own
 *   (auto-run) is still the panel's decision — its settings and confidence rules sit in front of this.
 * - `change` actions run only after `confirm` resolves true. The panel supplies an inline confirm, so
 *   accepting a recommendation is two deliberate clicks, never one stray one.
 * - every attempt is logged, ran or not, so the panel can say "Ran: Fly to camera 5036" and a wrong
 *   move can be traced afterwards.
 *
 * Plain module, no DOM: the panel owns how confirmation and the log look.
 */

export const ACTION_KINDS = Object.freeze(['view', 'change']);
const MAX_LOG = 200;

/**
 * @typedef {{kind: 'view'|'change', label: string,
 *   run: (params: object, ctx: object) => any, describe?: (params: object) => string|null}} TwinAction
 * @typedef {{name: string, kind: string, label: string, source: string|null,
 *   status: 'ran'|'refused'|'cancelled'|'error'|'unknown', at: number, detail?: string}} TwinLogEntry
 */

/**
 * @param {object} [options]
 * @param {(request: {name: string, kind: string, label: string, params: object, source: string|null}
 *   & object) => boolean|Promise<boolean>} [options.confirm]  asked before every `change` action; the
 *   run options (anchor element, container …) are passed through so the panel can place its prompt.
 *   Without one, change actions are refused: a missing confirm must never mean "confirmed".
 * @param {(entry: TwinLogEntry) => void} [options.onLog]
 * @param {boolean} [options.debug]  console.debug each entry (the panel passes import.meta.env.DEV)
 * @param {() => number} [options.now]
 */
export function createTwinUiApi({ confirm = null, onLog = null, debug = false, now = () => Date.now() } = {}) {
  /** @type {Map<string, TwinAction>} */
  const actions = new Map();
  /** @type {TwinLogEntry[]} */
  const entries = [];
  const listeners = new Set(onLog ? [onLog] : []);

  function describeOf(action, params) {
    try { return action.describe?.(params) || action.label; } catch { return action.label; }
  }

  function record(entry) {
    entries.push(entry);
    if (entries.length > MAX_LOG) entries.shift();
    if (debug) console.debug(`[twin-ui] ${logLine(entry)}`, entry);
    for (const listener of listeners) { try { listener(entry); } catch { /* a listener never stops an action */ } }
    return entry;
  }

  /** @param {string} name  @param {TwinAction} action */
  function register(name, action) {
    if (!name || typeof name !== 'string') throw new TypeError('A twin UI action needs a name.');
    if (!ACTION_KINDS.includes(action?.kind)) throw new TypeError(`Twin UI action '${name}' needs kind 'view' or 'change'.`);
    if (typeof action.run !== 'function') throw new TypeError(`Twin UI action '${name}' needs a run function.`);
    actions.set(name, { kind: action.kind, label: action.label ?? name, run: action.run, describe: action.describe });
    return () => { if (actions.get(name)?.run === action.run) actions.delete(name); };
  }

  /**
   * Run an action by name.
   *
   * A run function that returns `false` refused (the target was not there — a patrol id the
   * workspace does not hold); that is reported, not thrown, so the caller can mark its button.
   *
   * @param {string} name
   * @param {object} [params]
   * @param {{source?: string} & object} [options]  `source` says who asked (answer, auto, evidence,
   *   button …); everything else is handed to `run` and `confirm` as context
   * @returns {Promise<{status: TwinLogEntry['status'], result?: any, error?: unknown, entry: TwinLogEntry}>}
   */
  async function run(name, params = {}, options = {}) {
    const source = options.source ?? null;
    const action = actions.get(name);
    const base = { name, source, at: now() };
    if (!action) {
      console.warn(`[twin-ui] no action named '${name}'`);
      return { status: 'unknown', entry: record({ ...base, kind: 'unknown', label: name, status: 'unknown' }) };
    }
    const label = describeOf(action, params);
    const head = { ...base, kind: action.kind, label };
    if (action.kind === 'change') {
      let ok = false;
      try { ok = confirm ? Boolean(await confirm({ ...options, name, kind: action.kind, label, params, source })) : false; } catch { ok = false; }
      if (!ok) return { status: 'cancelled', entry: record({ ...head, status: 'cancelled', ...(confirm ? {} : { detail: 'no confirmation available' }) }) };
    }
    try {
      const result = await action.run(params, { ...options, source, name });
      const status = result === false ? 'refused' : 'ran';
      return { status, result, entry: record({ ...head, status }) };
    } catch (error) {
      console.warn(`[twin-ui] '${name}' failed`, error);
      return { status: 'error', error, entry: record({ ...head, status: 'error', detail: String(error?.message ?? error) }) };
    }
  }

  return {
    register,
    run,
    has: name => actions.has(name),
    /** What the twin can do, for diagnostics and for a panel that wants to offer actions. */
    list: () => [...actions].map(([name, action]) => ({ name, kind: action.kind, label: action.label })),
    /** Every attempt so far, oldest first. */
    log: () => entries.slice(),
    onLog(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const STATUS_WORDS = Object.freeze({ ran: 'Ran', refused: 'Not available', cancelled: 'Cancelled', error: 'Failed', unknown: 'Unknown action' });

/** "Ran: Fly to camera 5036" — the words the panel shows under the answer. */
export function logLine(entry) {
  return `${STATUS_WORDS[entry.status] ?? entry.status}: ${entry.label}${entry.detail ? ` (${entry.detail})` : ''}`;
}
