/**
 * The one piece of scenario work that outlives a refresh: a SAVED garage placement.
 *
 * THE TENSION THIS RESOLVES. The planner deliberately starts clean on every load — no garage
 * selected, no carried-over spaces or floors — because reopening on a half-configured scenario
 * from a previous visit showed someone else's work-in-progress with no sign of where it came
 * from. A placement someone positioned, checked and pressed **Save placement** on is a different
 * thing from a half-edited form: it is a deliberate act, and losing it on a refresh would make
 * the editor useless. So this store is deliberately narrow:
 *
 *   - only a placement the user explicitly SAVED is written; dragging writes nothing,
 *   - only the placement is written — never the scenario's name, assumptions, runs or selection,
 *   - and it is written under its own key, so clearing the planner's session state cannot
 *     resurrect a scenario through it.
 *
 * KEYED BY SCENARIO KEY, NOT ID. Scenario ids are minted fresh when the three alternatives are
 * re-seeded on load, so an id cannot survive a refresh. The seed KEY ('A', 'B', 'C') is the
 * stable name for "the new-garage alternative", and that is what a saved placement belongs to. A
 * scenario the user added themselves has no key and so cannot persist a placement; that is
 * stated rather than hidden, and is the honest limit of keying this way.
 */

export const PLACEMENT_STORAGE_KEY = 'portmiami.scenario.placement.v1';
export const SCHEMA_VERSION = 1;

const empty = () => ({ version: SCHEMA_VERSION, placements: {} });

/** Everything saved, as `{ [scenarioKey]: placement }`. A broken or stale store reads as empty. */
export function loadPlacements(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PLACEMENT_STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SCHEMA_VERSION || typeof parsed.placements !== 'object') {
      return empty();
    }
    return { version: SCHEMA_VERSION, placements: { ...parsed.placements } };
  } catch {
    return empty();
  }
}

/** The placement saved for one scenario key, or null. */
export const placementFor = (scenarioKey, storage) =>
  (scenarioKey ? loadPlacements(storage).placements[scenarioKey] ?? null : null);

/**
 * Write one placement.
 *
 * Returns the state it wrote, so a caller can show what is now saved rather than assuming the
 * write worked — a browser with storage disabled returns `{ ok: false }` and the panel says the
 * placement will not survive a refresh, instead of claiming a save that did not happen.
 */
export function savePlacement(scenarioKey, placement, storage = globalThis.localStorage) {
  if (!scenarioKey) {
    return { ok: false, reason: 'This scenario was added in this session, so it has no stable '
      + 'name to save a placement under. It will be kept until the page is reloaded.' };
  }
  const state = loadPlacements(storage);
  state.placements[scenarioKey] = placement;
  try {
    storage?.setItem(PLACEMENT_STORAGE_KEY, JSON.stringify(state));
    return { ok: true, state };
  } catch {
    return { ok: false, reason: 'This browser refused to store the placement, so it will be kept '
      + 'until the page is reloaded and no longer.' };
  }
}

/** Forget one scenario's saved placement. */
export function clearPlacement(scenarioKey, storage = globalThis.localStorage) {
  const state = loadPlacements(storage);
  if (!(scenarioKey in state.placements)) return { ok: true, state };
  delete state.placements[scenarioKey];
  try {
    storage?.setItem(PLACEMENT_STORAGE_KEY, JSON.stringify(state));
    return { ok: true, state };
  } catch {
    return { ok: false, reason: 'This browser refused to update stored placements.' };
  }
}
