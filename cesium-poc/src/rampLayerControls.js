import { RAMP_CATEGORIES, interchangeLabel } from './i595RampData.js';
import { createI595RampLayerService } from './i595RampLayerService.js';
import { createRampDetailsPanel } from './rampDetailsPanel.js';

export function installRampLayerControls(container, viewer) {
  container.innerHTML = `<details class="ramp-group"><summary><input type="checkbox" id="ramps-all" aria-label="Ramps & Connectors" disabled> Ramps &amp; Connectors</summary>
    <div class="ramp-categories">${RAMP_CATEGORIES.map(category => `<label style="--road:${category.color}"><input type="checkbox" value="${category.type}" disabled><span class="swatch"></span><span>${category.label}</span></label>`).join('')}</div>
    <label class="interchange-filter" for="ramp-interchange">Interchange</label><select id="ramp-interchange" disabled><option value="">All</option></select>
  </details><p class="ramp-status" role="status">Loading ramp categories…</p><button class="ramp-retry" hidden>Retry ramp loading</button>`;
  const group = container.querySelector('details');
  const parent = container.querySelector('#ramps-all');
  const children = [...container.querySelectorAll('.ramp-categories input')];
  const filter = container.querySelector('select');
  const status = container.querySelector('.ramp-status');
  const retry = container.querySelector('.ramp-retry');
  const panel = createRampDetailsPanel(() => service.clearSelection());
  const service = createI595RampLayerService(viewer, {
    onSelect: panel.select, onHover: panel.hover,
    onChange({ total, visible, near }) {
      if (!total) return;
      status.textContent = `${visible} of ${total} ramps visible.${visible && !near ? ' Zoom in to inspect individual ramps.' : visible ? ' Hover or click a ramp to inspect.' : ''}`;
    },
  });
  const apply = () => {
    const enabled = children.filter(input => input.checked).map(input => input.value);
    parent.checked = enabled.length === children.length;
    parent.indeterminate = enabled.length > 0 && enabled.length < children.length;
    service.setFilters(enabled, filter.value);
  };
  // A checkbox click toggles visibility without also toggling the disclosure.
  parent.addEventListener('click', event => event.stopPropagation());
  parent.onchange = () => {
    children.forEach(input => { input.checked = parent.checked; });
    if (parent.checked) group.open = true;
    apply();
  };
  children.forEach(input => { input.onchange = apply; });
  filter.onchange = apply;
  async function load() {
    retry.hidden = true;
    status.textContent = 'Loading ramp categories…';
    try {
      await service.load();
      for (const key of [...service.byInterchange.keys()].sort((a, b) => interchangeLabel(a).localeCompare(interchangeLabel(b)))) {
        filter.add(new Option(interchangeLabel(key), key));
      }
      [parent, ...children, filter].forEach(input => { input.disabled = false; });
      apply();
    } catch (error) {
      status.textContent = 'Ramps could not load. Your mainline layers are still available.';
      retry.hidden = false;
      console.error(error);
    }
  }
  retry.onclick = load;
  load();
  return { destroy() { service.destroy(); panel.destroy(); container.replaceChildren(); } };
}
