/**
 * Ask the Twin as a panel docked on the left of the map: header (collapse), a welcome state
 * (illustration, suggested questions) that gives way to the conversation, decorative waves and the
 * question input. Markup only: networkTwin.js owns the behaviour (its existing question flow).
 *
 * Every graphic is inline SVG, decorative ones hidden from assistive technology.
 */
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** The suggested questions: each asks a real question through the existing flow. */
export const ASK_SUGGESTIONS = Object.freeze([
  { icon: 'transformer', tone: 'cyan', label: 'Show all transformers', question: 'Show me all transformers installed across Seagirt.' },
  { icon: 'bolt', tone: 'red', label: 'Which assets have no power?', question: 'Which assets currently have no power?' },
  { icon: 'network', tone: 'cyan', label: 'What does TX-M1 supply?', question: 'What does TX-M1 supply?' },
  // Resolved to the two newest versions in ACC by the comparison integration (askCompare.js).
  { icon: 'layers', tone: 'cyan', label: 'Compare IFC versions', question: 'What changed between the latest two IFC versions?' },
]);

const svg = (body, { size = 24, view = '0 0 24 24', cls = '' } = {}) =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="${view}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ASK_ICONS = Object.freeze({
  transformer: svg('<path d="M4 8.5h16"/><rect x="5.5" y="8.5" width="13" height="11.5" rx="1.6"/><path d="M9 8.5V20M12 8.5V20M15 8.5V20"/><path d="M8 8.5V6M16 8.5V6"/><circle cx="8" cy="4.6" r="1.3"/><circle cx="16" cy="4.6" r="1.3"/>'),
  bolt: svg('<path d="M13.2 2.5 4.8 13.6h6.6l-1.1 7.9 8.9-11.6h-6.7l.7-7.4Z"/>'),
  network: svg('<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18.5" r="2.4"/><circle cx="19" cy="18.5" r="2.4"/><path d="M10.8 7.1 6.2 16.4M13.2 7.1l4.6 9.3"/>'),
  layers: svg('<path d="M12 3.5 3 8.2l9 4.7 9-4.7-9-4.7Z"/><path d="m3 12.3 9 4.7 9-4.7"/><path d="m3 16.4 9 4.7 9-4.7"/>'),
  chevron: svg('<path d="m9.5 6 6 6-6 6"/>', { size: 18 }),
  collapse: svg('<path d="m12.5 7-5 5 5 5"/><path d="m18 7-5 5 5 5"/>', { size: 20 }),
  chat: svg('<path d="M5.5 5h13A2.5 2.5 0 0 1 21 7.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.4V17h0A2.5 2.5 0 0 1 3 14.5v-7A2.5 2.5 0 0 1 5.5 5Z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01" stroke-width="2.4"/>', { size: 22 }),
  send: svg('<path d="M20.5 3.5 3.8 10.4c-.7.3-.6 1.3.1 1.5l6.3 1.9 1.9 6.3c.2.7 1.2.8 1.5.1L20.5 3.5Z"/><path d="m10.2 13.8 10.3-10.3"/>', { size: 21 }),
  target: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.6"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>', { size: 20 }),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', { size: 18 }),
  doc: svg('<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>', { size: 20 }),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.6h.01"/>', { size: 16 }),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', { size: 18 }),
  sound: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>', { size: 20 }),
  mute: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>', { size: 20 }),
  clear: svg('<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>', { size: 20 }),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', { size: 20 }),
  back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>', { size: 20 }),
  external: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', { size: 20 }),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>', { size: 20 }),
  user: svg('<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.8 3.8-5.6 7.5-5.6s6.7 1.8 7.5 5.6"/>', { size: 22 }),
  chart: svg('<path d="M5 20V11M10 20V5M15 20v-7M20 20v-4"/>', { size: 22 }),
  power: svg('<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>', { size: 26 }),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>', { size: 20 }),
  crane: svg('<path d="M5 21V5h2v16M3 21h8M7 6h14l-4 3M7 6l4-3"/><path d="M17 9v5"/><rect x="15.5" y="14" width="3" height="2.5" rx=".5"/>'),
  light: svg('<path d="M12 21V10"/><path d="M8 6h8l-1.5 4h-5z"/><path d="M5 4.5 6.5 5.5M19 4.5l-1.5 1M12 2.5V4"/>'),
  cable: svg('<path d="M3 17c4 0 4-10 9-10s5 10 9 10"/><circle cx="3" cy="17" r="1.2"/><circle cx="21" cy="17" r="1.2"/>'),
  source: svg('<path d="M4 12c2.5-5 5.5-5 8 0s5.5 5 8 0"/><circle cx="12" cy="12" r="9"/>'),
  switchgear: svg('<rect x="4.5" y="4" width="15" height="16" rx="1.5"/><path d="M9 8v8M15 8v8M4.5 12h15"/>'),
});

/** The AI mark: a four-point sparkle with two small ones, purple, softly glowing. */
export function sparkleSvg(size = 34) {
  return `<svg class="isp-askp-spark" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <defs><linearGradient id="ispSparkG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d4a8ff"/><stop offset="1" stop-color="#8f4dff"/></linearGradient>
      <filter id="ispSparkF" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <g filter="url(#ispSparkF)" fill="url(#ispSparkG)">
      <path d="M17 6c.9 7.4 3.6 10.2 11 11-7.4.9-10.1 3.6-11 11-.9-7.4-3.6-10.1-11-11 7.4-.8 10.1-3.6 11-11Z"/>
      <path d="M30.5 4c.4 2.9 1.4 3.9 4.3 4.3-2.9.4-3.9 1.4-4.3 4.3-.4-2.9-1.4-3.9-4.3-4.3 2.9-.4 3.9-1.4 4.3-4.3Z"/>
      <path d="M30 26c.35 2.3 1.2 3.2 3.5 3.5-2.3.35-3.15 1.2-3.5 3.5-.35-2.3-1.2-3.15-3.5-3.5 2.3-.3 3.15-1.2 3.5-3.5Z"/>
    </g></svg>`;
}

/** The welcome illustration: three translucent stacked layers over a purple elliptical halo. */
export function illustrationSvg() {
  const slab = (y, i) => {
    const top = `M110 ${y - 25} L156 ${y} L110 ${y + 25} L64 ${y} Z`;
    const left = `M64 ${y} L110 ${y + 25} L110 ${y + 35} L64 ${y + 10} Z`;
    const right = `M156 ${y} L110 ${y + 25} L110 ${y + 35} L156 ${y + 10} Z`;
    const a = [1, 0.82, 0.66][i];
    // An opaque base first: each layer covers the one below instead of showing its edges through.
    const base = `M110 ${y - 25} L156 ${y} L156 ${y + 10} L110 ${y + 35} L64 ${y + 10} L64 ${y} Z`;
    return `<g opacity="${a}"><path d="${base}" fill="#0a1f3f"/><path d="${left}" fill="url(#ispIlSideL)" stroke="#5fd4ff" stroke-width="1" stroke-opacity=".55"/>
      <path d="${right}" fill="url(#ispIlSideR)" stroke="#5fd4ff" stroke-width="1" stroke-opacity=".55"/>
      <path d="${top}" fill="url(#ispIlTop)" stroke="#8ae6ff" stroke-width="1.4"/>
</g>`;
  };
  return `<svg class="isp-askp-illus" viewBox="0 0 220 160" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="ispIlTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ee0ff" stop-opacity=".55"/><stop offset="1" stop-color="#1677ff" stop-opacity=".28"/></linearGradient>
      <linearGradient id="ispIlSideL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1fa8ff" stop-opacity=".5"/><stop offset="1" stop-color="#0b4fb3" stop-opacity=".25"/></linearGradient>
      <linearGradient id="ispIlSideR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1677ff" stop-opacity=".45"/><stop offset="1" stop-color="#0a3a8c" stop-opacity=".22"/></linearGradient>
      <radialGradient id="ispIlHalo" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#7a3cff" stop-opacity=".55"/><stop offset=".6" stop-color="#4d2bd6" stop-opacity=".22"/><stop offset="1" stop-color="#2a1a80" stop-opacity="0"/></radialGradient>
      <linearGradient id="ispIlRing" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6b4dff" stop-opacity=".15"/><stop offset=".5" stop-color="#b07bff"/><stop offset="1" stop-color="#6b4dff" stop-opacity=".15"/></linearGradient>
      <filter id="ispIlGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>
    <ellipse cx="110" cy="128" rx="104" ry="26" fill="url(#ispIlHalo)"/>
    <ellipse cx="110" cy="128" rx="96" ry="21" fill="none" stroke="url(#ispIlRing)" stroke-width="2.2"/>
    <ellipse cx="110" cy="128" rx="70" ry="14" fill="none" stroke="#8f6bff" stroke-opacity=".35" stroke-width="1"/>
    <g class="isp-askp-illus-glow" filter="url(#ispIlGlow)" opacity=".55"><path d="M110 20 L156 45 L156 115 L110 140 L64 115 L64 45 Z" fill="#1fa8ff"/></g>
    ${[98, 70, 42].map((y, i) => slab(y, 2 - i)).join('')}
  </svg>`;
}

const wavesSvg = () => `<svg class="isp-askp-waves" viewBox="0 0 440 120" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <defs><linearGradient id="ispWaveG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1677ff" stop-opacity="0"/><stop offset=".35" stop-color="#1e8bff" stop-opacity=".7"/><stop offset=".75" stop-color="#00c8f8" stop-opacity=".55"/><stop offset="1" stop-color="#00c8f8" stop-opacity="0"/></linearGradient></defs>
  <g fill="none" stroke="url(#ispWaveG)">
    <path d="M0 78 C70 40 140 104 220 70 S360 30 440 62" stroke-width="1.6" opacity=".75"/>
    <path d="M0 86 C80 52 150 112 230 78 S370 42 440 72" stroke-width="1.1" opacity=".55"/>
    <path d="M0 94 C90 66 160 118 240 88 S380 56 440 84" stroke-width=".9" opacity=".4"/>
    <path d="M0 70 C60 34 150 92 210 62 S350 22 440 52" stroke-width=".8" opacity=".35"/>
  </g></svg>`;

/** The whole panel, and the launcher shown while it is collapsed. */
export function askPanelHtml({ bankHtml = '' } = {}) {
  const card = s => `<button type="button" class="isp-askp-card is-${s.tone}" data-ask="${esc(s.question)}" title="${esc(s.question)}">
      <span class="isp-askp-card-ic">${ASK_ICONS[s.icon]}</span><span class="isp-askp-card-l">${esc(s.label)}</span><span class="isp-askp-card-ch">${ASK_ICONS.chevron}</span></button>`;
  return `<div class="isp-askp" id="isp-askp" role="complementary" aria-label="Ask the Twin">
    <div class="isp-askp-head">${sparkleSvg()}<h2>Ask the Twin <span class="isp-askp-ai">AI</span></h2>
      <button type="button" class="isp-askp-collapse" data-act="askCollapse" aria-label="Collapse Ask the Twin" aria-controls="isp-askp" aria-expanded="true" title="Collapse">${ASK_ICONS.collapse}</button></div>
    <div class="isp-askp-body">
      <div class="isp-askp-welcome">
        <div class="isp-askp-art">${illustrationSvg()}</div>
        <h3>Welcome to Ask the Twin</h3>
        <p>Your intelligent copilot for the Seagirt IFC Spatial Twin. Ask about equipment, connectivity, operational status, and design changes.</p>
        <div class="isp-askp-try">Try asking:</div>
        <div class="isp-askp-cards">${ASK_SUGGESTIONS.map(card).join('')}</div>
      </div>
      <div class="isp-askp-chat" role="log" aria-live="polite" aria-label="Conversation" hidden></div>
    </div>
    <div class="isp-askp-foot">
      ${wavesSvg()}
      <div class="isp-ask-hl" role="status" hidden></div>
      <div class="isp-bank" hidden>${bankHtml}</div>
      <form class="isp-askbar"><button type="button" class="isp-icon" data-act="bank" aria-label="Question bank" aria-expanded="false" title="Question bank">${ASK_ICONS.chat}</button>
        <input name="q" autocomplete="off" placeholder="Ask about your twin..." aria-label="Ask the Twin">
        <button type="submit" class="isp-send" aria-label="Send question">${ASK_ICONS.send}<span class="isp-send-spin" aria-hidden="true"></span><span class="isp-send-stop" aria-hidden="true"></span></button></form>
    </div>
  </div>
  <button type="button" class="isp-askp-launcher" data-act="askExpand" aria-label="Open Ask the Twin" aria-controls="isp-askp" aria-expanded="false" hidden>${sparkleSvg(24)}<span>Ask the Twin</span></button>`;
}
