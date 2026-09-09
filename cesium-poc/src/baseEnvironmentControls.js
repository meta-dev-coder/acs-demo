/**
 * Base Environment selector — a mutually exclusive radio group that lives *outside* DataLayer,
 * because it changes the world the corridor is drawn on, not which corridor data is drawn.
 *
 * All tileset lifecycle lives in basePhotorealistic3D.js; this module only reflects its state in
 * the DOM and reverts the selection when Google tiles cannot be shown.
 */
import { BASE_ENVIRONMENTS, DEFAULT_BASE_ENVIRONMENT } from './basePhotorealistic3D.js';

const LABELS = {
  [BASE_ENVIRONMENTS.SATELLITE]: 'Satellite / Existing Basemap',
  [BASE_ENVIRONMENTS.GOOGLE_PHOTOREALISTIC_3D]: 'Google Photorealistic 3D',
};

/**
 * @param {HTMLElement} container
 * @param {ReturnType<import('./basePhotorealistic3D.js').createGooglePhotorealistic3DService>} service
 * @param {{onFirstActivation?: () => void, onFlyRequest?: () => void}} [hooks]
 */
export function installBaseEnvironmentControls(container, service, { onFirstActivation, onFlyRequest } = {}) {
  const group = document.createElement('details');
  group.className = 'base-environment';
  group.open = true;
  group.innerHTML = `<summary>Map</summary>
    <fieldset class="base-environment-options">
      <legend>Base Environment</legend>
      <label><input type="radio" name="base-environment" value="${BASE_ENVIRONMENTS.SATELLITE}" checked><span>${LABELS.SATELLITE}</span></label>
      <label><input type="radio" name="base-environment" value="${BASE_ENVIRONMENTS.GOOGLE_PHOTOREALISTIC_3D}"><span>${LABELS.GOOGLE_PHOTOREALISTIC_3D}</span></label>
    </fieldset>
    <button class="base-environment-fly" hidden>View I-595 in 3D</button>
    <p class="base-environment-status" role="status"></p>`;
  container.append(group);

  const radios = new Map([...group.querySelectorAll('input[name="base-environment"]')].map(input => [input.value, input]));
  const status = group.querySelector('.base-environment-status');
  const fly = group.querySelector('.base-environment-fly');
  let current = DEFAULT_BASE_ENVIRONMENT, flown = false, busy = false;

  const select = value => { radios.get(value).checked = true; };

  async function apply(next) {
    if (busy || next === current) return current;
    if (next === BASE_ENVIRONMENTS.SATELLITE) {
      service.disable();
      current = next;
      status.textContent = '';
      fly.hidden = true;
      return current;
    }
    busy = true;
    // First activation downloads the tileset; say so rather than appearing to hang.
    status.textContent = service.isLoaded() ? '' : 'Loading Google Photorealistic 3D…';
    const result = await service.enable();
    busy = false;
    if (!result.ok) {
      // Keep the basemap that is actually on screen selected.
      status.textContent = result.message;
      select(BASE_ENVIRONMENTS.SATELLITE);
      current = BASE_ENVIRONMENTS.SATELLITE;
      fly.hidden = true;
      return current;
    }
    current = next;
    // No caption for the working state — Cesium's own credit display carries Google's attribution.
    // `status` stays reserved for the failure messages above.
    status.textContent = '';
    // Keep the radio in step when the environment is set programmatically, not by a click.
    select(next);
    fly.hidden = false;
    // Fly once, on first activation only — later toggles leave the camera where the user put it.
    if (!flown) { flown = true; onFirstActivation?.(); }
    return current;
  }

  for (const [value, input] of radios) input.onchange = () => { if (input.checked) void apply(value); };
  fly.onclick = () => onFlyRequest?.();

  return {
    get environment() { return current; },
    /** Programmatic switch, used by tests and by any future keyboard/preset entry point. */
    set: apply,
    destroy() { group.remove(); },
  };
}
