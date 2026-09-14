/**
 * "I-595 NOW" — a compact operational strip along the bottom of the map.
 *
 * Every figure is read from a layer that has actually loaded. Where the corridor has no feed behind
 * a metric, the metric is left out and the strip says so once, quietly, rather than showing a
 * plausible-looking number: speeds, travel times and congestion counts need traffic observations,
 * and this corridor has no traffic-condition feed connected. `segmentStatus` is the channel they
 * would arrive on, so the moment it is populated those figures appear here on their own.
 */
import { getTrafficState } from './corridorVisualConfig.js';

export const STATUS_REFRESH_MS = 5000;

/** Congestion states worth counting as "congested" on the strip. */
const CONGESTED_STATES = new Set(['HEAVY', 'CONGESTED', 'SEVERE', 'STOPPED']);

/**
 * Build the strip's metrics from whatever the corridor actually knows right now.
 * Pure, so the rules stay testable without a map.
 *
 * @param {{staticSegments?: Map<string, {beginPost: number, endPost: number, direction: string}>,
 *          segmentStatus?: Map<string, object>, events?: {type?: string}[]}} corridor
 * @returns {{metrics: {label: string, value: string, tone?: 'alert'}[], note: string|null}}
 */
export function corridorStatusMetrics({ staticSegments, segmentStatus, events } = {}) {
  const metrics = [];
  const segments = [...(staticSegments?.values() ?? [])];

  // Corridor length: real FDOT linear referencing, the mileposts already on each segment.
  const eastbound = segments.filter(segment => segment.direction === 'EB');
  const length = eastbound.length ? Math.max(...eastbound.map(s => s.endPost)) - Math.min(...eastbound.map(s => s.beginPost)) : null;
  if (Number.isFinite(length) && length > 0) metrics.push({ label: 'Corridor', value: `${length.toFixed(1)} mi` });

  // Observed conditions, if anything is observing.
  const observed = [...(segmentStatus?.values() ?? [])];
  for (const direction of ['EB', 'WB']) {
    const forDirection = observed.filter(status => status?.direction === direction).map(s => s.speedMph).filter(Number.isFinite);
    if (forDirection.length) {
      metrics.push({ label: direction, value: `${Math.round(forDirection.reduce((a, b) => a + b, 0) / forDirection.length)} mph` });
    }
  }
  const congested = observed.filter(status => CONGESTED_STATES.has(getTrafficState(status))).length;
  if (observed.length) metrics.push({ label: 'Congested', value: `${congested} segment${congested === 1 ? '' : 's'}`, tone: congested ? 'alert' : undefined });

  // Live operational events, from the feed that does exist.
  if (Array.isArray(events)) {
    const incidents = events.filter(event => event?.type === 'INCIDENT').length;
    const closures = events.filter(event => event?.type === 'CLOSURE').length;
    metrics.push({ label: 'Incidents', value: String(incidents), tone: incidents ? 'alert' : undefined });
    metrics.push({ label: 'Closures', value: String(closures), tone: closures ? 'alert' : undefined });
  }

  // Said once, plainly, instead of filling the gap with numbers nothing measured.
  const note = observed.length
    ? null : 'No traffic-condition feed connected';
  return { metrics, note };
}

/**
 * @param {HTMLElement} container
 * @param {{mainline?: object, liveEvents?: object}} sources
 */
export function installCorridorStatusBar(container, { mainline, liveEvents } = {}, { refreshMs = STATUS_REFRESH_MS } = {}) {
  const strip = document.createElement('section');
  strip.className = 'corridor-status';
  strip.setAttribute('aria-label', 'I-595 corridor status');
  strip.innerHTML = `<button class="corridor-status-toggle" type="button" aria-expanded="true" aria-controls="corridor-status-body" title="Hide corridor status">I-595 <span>NOW</span></button>
    <div class="corridor-status-body" id="corridor-status-body"><dl></dl><p class="corridor-status-note" role="status" hidden></p></div>`;
  container.append(strip);

  const list = strip.querySelector('dl'), note = strip.querySelector('.corridor-status-note');
  const toggle = strip.querySelector('.corridor-status-toggle');
  let disposed = false;

  toggle.onclick = () => {
    const collapsed = strip.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('title', collapsed ? 'Show corridor status' : 'Hide corridor status');
  };

  function refresh() {
    if (disposed) return;
    const { metrics, note: message } = corridorStatusMetrics({
      staticSegments: mainline?.staticSegments, segmentStatus: mainline?.segmentStatus, events: liveEvents?.events,
    });
    list.replaceChildren();
    for (const metric of metrics) {
      const group = document.createElement('div');
      if (metric.tone) group.dataset.tone = metric.tone;
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = metric.label; dd.textContent = metric.value;
      group.append(dt, dd); list.append(group);
    }
    note.hidden = !message;
    note.textContent = message ?? '';
  }

  refresh();
  const timer = setInterval(refresh, refreshMs);
  return {
    element: strip,
    refresh,
    get collapsed() { return strip.classList.contains('collapsed'); },
    destroy() { disposed = true; clearInterval(timer); strip.remove(); },
  };
}
