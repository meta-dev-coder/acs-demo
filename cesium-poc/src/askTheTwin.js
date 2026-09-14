import { Cartesian3, Math as CesiumMath, JulianDate } from 'cesium';
import { makeDraggable } from './draggablePanel.js';

const ASK_URL = (import.meta.env?.VITE_ASK_THE_TWIN_API ?? '').replace(/\/$/, '')
  || 'https://d3syo4sqvwi009.cloudfront.net/api/i595/ask';

const SUGGESTIONS = [
  'Any incidents on I-595 right now?',
  'Are express lanes open eastbound?',
  'Which cameras are near the Turnpike?',
  'How long is I-595?',
];

const STEPS = [
  { label: 'Reading live events from DynamoDB…', ms: 0 },
  { label: 'Asking Claude about I-595…', ms: 900 },
  { label: 'Processing response…', ms: 2400 },
];

// Find cameras within radiusM metres of lon/lat, sorted by distance
function nearbyCameras(cameraControls, lon, lat, radiusM = 800) {
  if (!cameraControls?.cameraById) return [];
  const target = Cartesian3.fromDegrees(lon, lat);
  const results = [];
  for (const [id, entity] of cameraControls.cameraById) {
    const pos = entity.position?.getValue?.(JulianDate.now());
    if (!pos) continue;
    const dist = Cartesian3.distance(target, pos);
    if (dist <= radiusM) results.push({ id, entity, dist });
  }
  return results.sort((a, b) => a.dist - b.dist);
}

export function installAskTheTwin(viewer, { cameraControls } = {}) {
  // ── Toggle button ──────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.className = 'ask-twin-btn';
  btn.setAttribute('aria-label', 'Ask the Digital Twin');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Ask the Twin`;
  document.body.appendChild(btn);

  // ── Panel ─────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.className = 'ask-twin-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ask-twin-header" title="Drag to move">
      <span class="ask-twin-title">
        <span class="ask-twin-indicator"></span>
        Ask the Twin
        <span class="ask-twin-subtitle">I-595 Digital Twin · FL511 live data</span>
      </span>
      <div class="ask-twin-controls">
        <button class="ask-twin-icon-btn ask-twin-minimize" title="Minimise" aria-label="Minimise">▾</button>
        <button class="ask-twin-icon-btn ask-twin-close" title="Close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="ask-twin-body">
      <div class="ask-twin-messages"></div>
      <div class="ask-twin-suggestions"></div>
      <form class="ask-twin-form">
        <input class="ask-twin-input" type="text" placeholder="Ask about I-595…" maxlength="512" autocomplete="off"/>
        <button type="submit" class="ask-twin-send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>`;
  document.body.appendChild(panel);

  const header   = panel.querySelector('.ask-twin-header');
  const body     = panel.querySelector('.ask-twin-body');
  const messages = panel.querySelector('.ask-twin-messages');
  const suggestEl = panel.querySelector('.ask-twin-suggestions');
  const form     = panel.querySelector('.ask-twin-form');
  const input    = panel.querySelector('.ask-twin-input');
  const sendBtn  = panel.querySelector('.ask-twin-send');
  const minBtn   = panel.querySelector('.ask-twin-minimize');

  // ── Suggestion chips ──────────────────────────────────────────────────
  SUGGESTIONS.forEach(s => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ask-twin-chip';
    chip.textContent = s;
    chip.onclick = () => { input.value = s; submit(); };
    suggestEl.appendChild(chip);
  });

  // ── Drag ──────────────────────────────────────────────────────────────
  // Shared with every details panel, so the whole map drags the same way — and so a panel cannot
  // be dropped somewhere it can no longer be grabbed.
  const drag = makeDraggable(panel, header);

  // ── Minimise ──────────────────────────────────────────────────────────
  let minimised = false;
  minBtn.onclick = () => {
    minimised = !minimised;
    body.hidden = minimised;
    minBtn.textContent = minimised ? '▴' : '▾';
    panel.classList.toggle('ask-twin-panel--minimised', minimised);
  };

  // ── Open / close ──────────────────────────────────────────────────────
  let open = false;
  function toggle(force) {
    open = force !== undefined ? force : !open;
    panel.hidden = !open;
    btn.classList.toggle('active', open);
    if (open && !minimised) { input.focus(); scrollBottom(); }
  }
  btn.onclick = () => toggle();
  panel.querySelector('.ask-twin-close').onclick = () => toggle(false);

  // ── Messages ──────────────────────────────────────────────────────────
  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

  function addMsg(role, text, meta) {
    suggestEl.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = `ask-twin-msg ask-twin-msg--${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'ask-twin-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);

    if (meta) {
      const row = document.createElement('div');
      row.className = 'ask-twin-meta';

      // Sources
      if (meta.sources?.length) {
        const src = document.createElement('span');
        src.className = 'ask-twin-sources';
        src.textContent = '📡 ' + meta.sources.map(s =>
          s === 'live_events' ? 'FL511 live data' : 'Corridor knowledge'
        ).join(' + ');
        row.appendChild(src);
      }

      // Confidence
      const conf = document.createElement('span');
      conf.className = `ask-twin-confidence ask-twin-confidence--${meta.confidence}`;
      conf.textContent = meta.confidence;
      row.appendChild(conf);

      wrap.appendChild(row);

      // Action button
      const actionType = meta.action?.type;
      if (actionType && actionType !== 'none' && meta.action?.coordinates) {
        const isCamera = actionType === 'open_camera';
        const flyBtn = document.createElement('button');
        flyBtn.className = 'ask-twin-fly-btn';
        flyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> ${isCamera ? 'Show cameras on map' : 'Show on map'}`;
        flyBtn.onclick = () => {
          if (isCamera) openNearestCameras(meta.action.coordinates, flyBtn);
          else flyTo(meta.action.coordinates, flyBtn);
        };
        wrap.appendChild(flyBtn);
      }
    }

    messages.appendChild(wrap);
    scrollBottom();
  }

  // ── Fly to ────────────────────────────────────────────────────────────
  function flyTo({ lon, lat }, flyBtn, alt = 1800) {
    if (flyBtn) { flyBtn.textContent = 'Flying…'; flyBtn.disabled = true; }
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, alt),
      orientation: { heading: CesiumMath.toRadians(0), pitch: CesiumMath.toRadians(-40), roll: 0 },
      duration: 2,
      complete: () => { if (flyBtn) { flyBtn.innerHTML = '✓ On map'; } },
    });
  }

  // ── Open nearest cameras to coordinates ───────────────────────────────
  function openNearestCameras({ lon, lat }, flyBtn) {
    let nearby = nearbyCameras(cameraControls, lon, lat, 1200);
    if (!nearby.length) nearby = nearbyCameras(cameraControls, lon, lat, 3000);
    if (!nearby.length) { flyTo({ lon, lat }, flyBtn); return; }
    nearby.slice(0, 5).forEach(({ entity }) => { entity.show = true; });
    cameraControls.selectCamera(nearby[0].id);
    flyTo({ lon, lat }, flyBtn, 1000);
  }

  // ── Thinking with step labels ─────────────────────────────────────────
  function addThinking() {
    const wrap = document.createElement('div');
    wrap.className = 'ask-twin-msg ask-twin-msg--assistant';
    wrap.innerHTML = `<div class="ask-twin-bubble ask-twin-thinking">
      <span class="ask-twin-dots"><span></span><span></span><span></span></span>
      <span class="ask-twin-step-label"></span>
    </div>`;
    messages.appendChild(wrap);
    scrollBottom();

    const stepLabel = wrap.querySelector('.ask-twin-step-label');
    const timers = STEPS.map(({ label, ms }) =>
      setTimeout(() => { stepLabel.textContent = label; }, ms)
    );

    return { el: wrap, clear: () => timers.forEach(clearTimeout) };
  }

  // ── Submit ────────────────────────────────────────────────────────────
  let busy = false;
  async function submit() {
    const question = input.value.trim();
    if (!question || busy) return;
    busy = true;
    input.value = '';
    sendBtn.disabled = true;
    input.disabled = true;
    addMsg('user', question);
    const thinking = addThinking();
    try {
      const res = await fetch(ASK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      thinking.clear();
      thinking.el.remove();
      if (!res.ok) {
        addMsg('assistant', data.error ?? 'Something went wrong — please try again.');
      } else {
        addMsg('assistant', data.answer, data);
        // auto-act on high confidence responses with coordinates
        if (data.confidence === 'high' && data.action?.coordinates) {
          if (data.action.type === 'open_camera') openNearestCameras(data.action.coordinates);
          else flyTo(data.action.coordinates);
        }
      }
    } catch {
      thinking.clear();
      thinking.el.remove();
      addMsg('assistant', 'Could not reach the twin. Check your connection.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  form.onsubmit = e => { e.preventDefault(); submit(); };

  return {
    destroy() { btn.remove(); panel.remove(); },
  };
}
