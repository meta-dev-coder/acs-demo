// Coordinate selection from both the map and explorer labels using existing close callbacks.
const activePanels = new Set();
// Mirrors the repository's DOM-only context panels; dataset strings never become HTML.
export function createMapDetailsPanel({ title, className, details, tooltipText, onClose }) {
  const panel = document.createElement('section');
  panel.className = className;
  panel.hidden = true;
  panel.setAttribute('aria-label', title);
  panel.innerHTML = '<div class="ramp-details-heading"><h2>Ramp details</h2><button aria-label="Close ramp details">×</button></div><dl></dl>';
  panel.querySelector('h2').textContent = title;
  panel.querySelector('button').setAttribute('aria-label', `Close ${title.toLowerCase()}`);
  panel.querySelector('button').onclick = onClose;
  document.body.append(panel);
  const tooltip = document.createElement('div');
  tooltip.className = 'ramp-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);
  const closeOther = () => { if (!panel.hidden) onClose(); };
  activePanels.add(closeOther);
  return {
    select(ramp) {
      if (ramp) for (const close of activePanels) if (close !== closeOther) close();
      panel.hidden = !ramp;
      if (!ramp) return;
      const dl = panel.querySelector('dl');
      dl.replaceChildren();
      for (const [name, value] of details(ramp)) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = name; dd.textContent = value; dl.append(dt, dd);
      }
    },
    hover(ramp, position) {
      tooltip.hidden = !ramp;
      if (!ramp) return;
      tooltip.textContent = tooltipText(ramp);
      tooltip.style.left = `${Math.max(8, Math.min(position.x + 16, innerWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(position.y + 16, innerHeight - tooltip.offsetHeight - 8))}px`;
    },
    destroy() { activePanels.delete(closeOther); panel.remove(); tooltip.remove(); },
  };
}
