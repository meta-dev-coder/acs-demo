import { formatMilepost } from './i595RoadSegmentData.js';

/** A compact presentation of the existing stable segment indexes, not new data sources. */
export function installI595SegmentControls(layer, onVisibilityChange) {
  const groups = [];
  for (const [direction, id] of [['EB', 'i595_mainline_eb'], ['WB', 'i595_mainline_wb']]) {
    const parent = document.getElementById(id);
    const oldLabel = parent.closest('label');
    const group = document.createElement('details');
    group.className = 'mainline-parent';
    group.style.setProperty('--road', oldLabel.style.getPropertyValue('--road'));
    const summary = document.createElement('summary');
    // Keep the existing checkbox ID, label and color; native details supplies disclosure.
    while (oldLabel.firstChild) summary.append(oldLabel.firstChild);
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '8'; summary.append(badge);
    const roadName = direction === 'EB' ? 'I-595 Eastbound' : 'I-595 Westbound';
    parent.setAttribute('aria-label', roadName);
    const list = document.createElement('div'); list.className = 'segment-list';
    const count = document.createElement('p'); count.className = 'segment-count'; count.setAttribute('role', 'status');
    group.append(summary, list, count); oldLabel.replaceWith(group);
    parent.disabled = true;
    parent.addEventListener('click', event => event.stopPropagation());
    const rows = new Map();
    const sync = () => {
      let visible = 0;
      for (const [segmentId, input] of rows) {
        input.checked = layer.segmentById.get(segmentId).show;
        if (input.checked) visible++;
      }
      parent.checked = visible === rows.size && rows.size > 0;
      parent.indeterminate = visible > 0 && visible < rows.size;
      count.textContent = `${visible} of ${rows.size} segments visible`;
      onVisibilityChange();
    };
    parent.onchange = async () => { await layer.setDirectionVisible(direction, parent.checked); sync(); };
    groups.push({ direction, parent, list, count, rows, sync });
  }
  let disposed = false;
  async function load() {
    try {
      await layer.load();
      if (disposed) return;
      for (const { direction, parent, list, count, rows, sync } of groups) {
        // travelOrder preserves official FDOT numbering while reversing the WB display order.
        for (const entity of layer.segmentsByDirection.get(direction)) {
          const segment = layer.staticSegments.get(entity.id);
          const text = `Segment ${segment.fdotSegmentIndex} · MP ${formatMilepost(segment.beginPost)}–${formatMilepost(segment.endPost)}`;
          const row = document.createElement('div'); row.className = 'segment-row';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
          checkbox.setAttribute('aria-label', `${text} (${direction})`);
          checkbox.dataset.segmentId = entity.id;
          const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
          button.className = 'segment-select'; button.dataset.segmentId = entity.id;
          const futureStatus = document.createElement('span'); futureStatus.className = 'segment-traffic-status'; futureStatus.hidden = true;
          row.append(checkbox, button, futureStatus); list.append(row); rows.set(entity.id, checkbox);
          checkbox.onchange = () => {
            layer.setSegmentVisible(entity.id, checkbox.checked); sync();
            if (row.matches(':hover')) layer.hoverSegment(entity.id);
          };
          button.onclick = () => {
            // Selecting a hidden section reveals that section so its highlight is visible.
            layer.setSegmentVisible(entity.id, true); sync(); layer.selectSegment(entity.id);
          };
          row.onmouseenter = () => layer.hoverSegment(entity.id);
          button.onmouseenter = () => layer.hoverSegment(entity.id);
          row.onmouseleave = () => layer.hoverSegment(null);
          button.onfocus = () => layer.hoverSegment(entity.id);
          button.onblur = () => layer.hoverSegment(null);
        }
        if (parent.checked) await layer.setDirectionVisible(direction, true);
        parent.disabled = false; count.replaceChildren(); sync();
      }
    } catch (error) {
      if (disposed) return;
      for (const { count } of groups) {
        count.textContent = 'Segments could not load. ';
        const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.onclick = load; count.append(retry);
      }
      console.error(error);
    }
  }
  load();
  return { destroy() { disposed = true; } };
}
