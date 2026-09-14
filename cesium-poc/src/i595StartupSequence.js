/**
 * Staged startup choreography for the I-595 demo.
 *
 * The map assembles itself in a fixed order rather than appearing all at once:
 *
 *   1. BASE_3D          load the Google Photorealistic 3D world
 *   2. FLY_TO_CORRIDOR  fly to the oblique hero view over the I-75 / Sawgrass interchange
 *   3. MAINLINE         fade in I-595 eastbound and westbound
 *   4. EXPRESS          fade in the 595 Express managed lanes
 *   5. MARKERS          fade in the I-595 route shields and the context labels
 *
 * The corridor and its labelling are all the opening scene shows. CCTV, traffic signals, live
 * events, ramps, frontage roads and bridges stay switched off and remain one click away in Map
 * Explorer — the hero view is about the corridor and the 3D environment, not the asset inventory.
 *
 * Every stage is best-effort: one that fails is reported and skipped, and the remaining stages
 * still run, so a missing Google key degrades the intro instead of the map. Layers are switched on
 * through their own checkboxes — the same path a click takes — so the layer tree, its counts and
 * its load/retry handling stay authoritative.
 */

/** @typedef {'BASE_3D'|'FLY_TO_CORRIDOR'|'MAINLINE'|'EXPRESS'|'MARKERS'} StartupStage */
export const STARTUP_STAGES = Object.freeze(
  ['BASE_3D', 'FLY_TO_CORRIDOR', 'MAINLINE', 'EXPRESS', 'MARKERS']);

/** Smooth both ends of a fade, so a layer neither snaps in nor crawls to full strength. */
export const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

/**
 * A promise-returning tween. The clock and scheduler are injected so the timing can be driven
 * deterministically in tests instead of by a real animation frame.
 */
export function createTween({ now = () => performance.now(), schedule = requestAnimationFrame } = {}) {
  return function tween(durationMs, onStep) {
    if (!(durationMs > 0)) { onStep(1); return Promise.resolve(); }
    const start = now();
    return new Promise(resolve => {
      const step = () => {
        const progress = Math.min(1, (now() - start) / durationMs);
        onStep(easeInOutCubic(progress));
        if (progress < 1) schedule(step); else resolve();
      };
      schedule(step);
    });
  };
}

/**
 * Switch a layer on the way a user does: wait until its control is enabled, tick it, and let the
 * layer's own change handler load and show the data.
 * @param {{id?: string, disabled: boolean, checked: boolean, onchange?: () => unknown}} input
 */
export async function enableLayerCheckbox(input, { timeoutMs = 30000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  if (!input) throw new Error('No layer control to enable.');
  for (const deadline = now() + timeoutMs; input.disabled;) {
    if (now() >= deadline) throw new Error(`Layer control "${input.id ?? 'unknown'}" never became available.`);
    await wait(100);
  }
  if (input.checked) return;
  input.checked = true;
  await input.onchange?.();
}

/**
 * @param {object} capabilities
 * @param {{load: () => Promise<unknown>}} capabilities.base3d
 * @param {{flyToCorridor: () => Promise<unknown>}} capabilities.camera
 * @param {{enable: () => Promise<unknown>, setOpacity: (alpha: number) => void}} capabilities.mainline
 * @param {{enable: () => Promise<unknown>, setOpacity: (alpha: number) => void}} capabilities.express
 * @param {{setOpacity: (alpha: number) => void}} capabilities.markers
 */
export function createI595StartupSequence({
  base3d, camera, mainline, express, markers,
  fadeMs = 700, tween = createTween(), onStage, logger = console,
}) {
  /** Fade a layer up from nothing: hidden while it loads, then eased to full strength. */
  const fadeIn = async layer => {
    layer.setOpacity(0);
    await layer.enable?.();
    await tween(fadeMs, layer.setOpacity);
    layer.setOpacity(1);
  };

  const stages = {
    BASE_3D: () => base3d.load(),
    FLY_TO_CORRIDOR: () => camera.flyToCorridor(),
    MAINLINE: () => fadeIn(mainline),
    EXPRESS: () => fadeIn(express),
    MARKERS: () => fadeIn(markers),
  };

  let running = null;
  /** @type {StartupStage[]} */
  const completed = [];
  /** @type {{stage: StartupStage, error: unknown}[]} */
  const failures = [];

  async function run() {
    for (const [index, stage] of STARTUP_STAGES.entries()) {
      onStage?.(stage, index, STARTUP_STAGES.length);
      try {
        await stages[stage]();
        completed.push(stage);
      } catch (error) {
        failures.push({ stage, error });
        logger.error?.(`I-595 startup: the "${stage}" stage did not complete.`, error);
      }
    }
    onStage?.('READY', STARTUP_STAGES.length, STARTUP_STAGES.length);
    return { completed: [...completed], failures: [...failures] };
  }

  return {
    STARTUP_STAGES,
    get completed() { return [...completed]; },
    get failures() { return [...failures]; },
    /** Idempotent: the sequence runs at most once per page. */
    run() { running ??= run(); return running; },
  };
}
