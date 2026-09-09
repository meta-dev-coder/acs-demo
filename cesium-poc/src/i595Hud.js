/**
 * Digital-twin status card — a compact, translucent identity panel, separate from Map Explorer.
 *
 * Every number on it is read from a layer that has actually loaded: the CCTV and signal counts are
 * the sizes of those layers' own entity maps, and the live-event count is the current contents of
 * the FL511 feed. Nothing here is estimated, derived or filled in — a count with no data behind it
 * yet shows as "—".
 *
 * There is deliberately no "LIVE" badge. Only the FL511 events are a live feed; the CCTV inventory
 * and the signal inventory are static FDOT datasets, and a badge over the card would claim the
 * whole twin is live when it is not.
 */

/** How often the card re-reads the counts; the live-event feed is the only one that changes. */
export const HUD_REFRESH_MS = 5000;

const PLACEHOLDER = '—';
const formatCount = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : PLACEHOLDER);

/**
 * @param {HTMLElement} container
 * @param {object} sources
 * @param {{size: number}} [sources.cameras]        the CCTV layer's entity map
 * @param {{size: number}} [sources.signals]        the traffic-signal layer's entity map
 * @param {{events: unknown[], ready: Promise<unknown>}} [sources.liveEvents]
 */
export function installI595Hud(container, { cameras, signals, liveEvents } = {}, { refreshMs = HUD_REFRESH_MS } = {}) {
  const card = document.createElement('section');
  card.className = 'twin-hud';
  card.setAttribute('aria-label', 'I-595 digital twin status');
  card.innerHTML = `
    <h1>I-595 Digital Twin</h1>
    <p class="twin-hud-place">Broward County, Florida</p>
    `;
  container.append(card);

  const cells = new Map([...card.querySelectorAll('[data-metric]')].map(cell => [cell.dataset.metric, cell]));
  let disposed = false;

  function refresh() {
    if (disposed) return;
    cells.get('cameras').textContent = formatCount(cameras?.size);
    cells.get('signals').textContent = formatCount(signals?.size);
    const events = liveEvents?.events;
    const count = Array.isArray(events) ? events.length : undefined;
    const cell = cells.get('events');
    cell.textContent = formatCount(count);
    // Nothing happening on the corridor is not an alert: only a real count is emphasised.
    cell.dataset.quiet = String(!count);
  }

  // The count is only meaningful once the feed has answered; until then it stays a placeholder.
  void Promise.resolve(liveEvents?.ready).catch(() => {}).finally(refresh);

  refresh();
  const timer = setInterval(refresh, refreshMs);
  return {
    element: card,
    refresh,
    destroy() { disposed = true; clearInterval(timer); card.remove(); },
  };
}
