/**
 * Answer blocks: the small KPI tiles, tables, bar lists and trend lines under an Ask the Twin answer.
 *
 * The server builds every block from a lookup the answer cited (the model never writes one), so a
 * number in a tile is the number the lookup returned, not one the model retyped into prose. Each
 * block is captioned with its ref and source so an operator can see which lookup it came from.
 *
 * The `*View` functions and the formatters are pure (block in, display model out) so they are
 * testable without a browser; `renderBlocks` only places what they return. No chart library: a bar
 * is a div, a trend is one SVG polyline — enough to read a shape at 320 px wide.
 *
 * Unknown block types, and blocks missing what they need, are dropped rather than half-drawn.
 */

export const TABLE_ROW_LIMIT = 8;
export const BARS_LIMIT = 12;
export const BLOCK_TYPES = Object.freeze(['kpi', 'table', 'bars', 'trend']);

const isBlank = value => value === null || value === undefined || value === '';

/** 1,234 · 12.5 · 0.38 — whole numbers grouped, fractions only as precise as they are readable. */
export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  const abs = Math.abs(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
}

/**
 * A value with its unit. A missing value reads NA, as everywhere else in the twin: a gap is stated,
 * never shown as 0.
 */
export function formatValue(value, unit) {
  if (isBlank(value)) return 'NA';
  const text = typeof value === 'number' ? formatNumber(value) : String(value);
  if (!unit) return text;
  return /^[%°]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * A trend point's label: "Oct 3" for a date, "Oct 3 14:00" for a timestamp, anything else (an hour
 * label like "07:00") as sent. A bare date is read as a calendar day, not as UTC midnight, so it does
 * not slip to the day before in Florida.
 */
export function formatTick(t) {
  const text = String(t ?? '');
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) return `${MONTHS[Number(day[2]) - 1]} ${Number(day[3])}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `${MONTHS[d.getMonth()]} ${d.getDate()}${time === '00:00' ? '' : ` ${time}`}`;
    }
  }
  return text;
}

/**
 * Where a ref's data came from, for the block caption.
 *
 * The evidence entry names it outright. Otherwise a claim that cites only this ref names its
 * sources; and an answer with one source overall can only mean that one. Anything less certain is
 * left out rather than guessed — a wrong source on a number is worse than none.
 */
export function sourceForRef(ref, answer = {}) {
  const fromEvidence = answer.evidence?.[ref]?.source;
  if (fromEvidence) return String(fromEvidence);
  for (const item of answer.basis ?? []) {
    const refs = item?.refs ?? [];
    const sources = item?.sources ?? [];
    if (refs.length === 1 && refs[0] === ref && sources.length) return [...new Set(sources)].join(', ');
  }
  for (const item of answer.basis ?? []) {
    // Lists of equal length are read as pairs: the server writes one source per cited ref.
    const i = (item?.refs ?? []).indexOf(ref);
    if (i !== -1 && item.sources?.length === item.refs.length && item.sources[i]) return String(item.sources[i]);
  }
  const all = [...new Set(answer.sources ?? [])];
  return all.length === 1 ? String(all[0]) : null;
}

/** A block as the panel can draw it, or null when it is not one it can. */
export function normaliseBlock(block) {
  if (!block || typeof block !== 'object' || !BLOCK_TYPES.includes(block.type)) return null;
  const ref = block.ref ? String(block.ref) : null;
  switch (block.type) {
    case 'kpi':
      if (isBlank(block.label)) return null;
      return { type: 'kpi', ref, label: String(block.label), value: block.value ?? null, unit: block.unit ?? null, note: block.note ?? null };
    case 'table': {
      const columns = Array.isArray(block.columns) ? block.columns.map(String) : [];
      if (!columns.length || !Array.isArray(block.rows)) return null;
      const rows = block.rows.filter(Array.isArray);
      const locations = Array.isArray(block.rowLocations) ? block.rowLocations : [];
      return { type: 'table', ref, title: block.title ?? null, columns, rows,
        // Kept aligned with the rows; a location that is not a real coordinate is no location.
        rowLocations: block.rows.map((row, i) => (Array.isArray(row) ? validLocation(locations[i]) : undefined)).filter(loc => loc !== undefined) };
    }
    case 'bars': {
      const items = (Array.isArray(block.items) ? block.items : [])
        .filter(item => item && !isBlank(item.label) && Number.isFinite(Number(item.value)))
        .slice(0, BARS_LIMIT)
        .map(item => ({ label: String(item.label), value: Number(item.value) }));
      return items.length ? { type: 'bars', ref, title: block.title ?? null, unit: block.unit ?? null, items } : null;
    }
    case 'trend': {
      const points = (Array.isArray(block.points) ? block.points : [])
        .filter(p => p && Number.isFinite(Number(p.value)))
        .map(p => ({ t: p.t, value: Number(p.value) }));
      // One point is not a trend; it would draw as nothing.
      return points.length >= 2 ? { type: 'trend', ref, title: block.title ?? null, unit: block.unit ?? null, points } : null;
    }
    default: return null;
  }
}

export function validLocation(loc) {
  const lon = Number(loc?.lon), lat = Number(loc?.lat);
  if (isBlank(loc?.lon) || isBlank(loc?.lat) || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}

/** The drawable blocks of an answer, in the server's order. */
export function answerBlocks(answer) {
  return (Array.isArray(answer?.blocks) ? answer.blocks : []).map(normaliseBlock).filter(Boolean);
}

/**
 * A table's visible rows: the first eight unless expanded, each with its location (if any) for the
 * row's fly button.
 */
export function tableView(block, { expanded = false, limit = TABLE_ROW_LIMIT } = {}) {
  const all = block.rows.map((cells, index) => ({
    index,
    cells: block.columns.map((_, c) => (isBlank(cells[c]) ? 'NA' : typeof cells[c] === 'number' ? formatNumber(cells[c]) : String(cells[c]))),
    location: block.rowLocations?.[index] ?? null,
  }));
  const rows = expanded ? all : all.slice(0, limit);
  return { columns: block.columns, rows, hidden: all.length - rows.length, total: all.length,
    numeric: block.columns.map((_, c) => block.rows.length > 0 && block.rows.every(row => isBlank(row[c]) || typeof row[c] === 'number')),
    locatable: all.some(row => row.location) };
}

/** Bars scaled to the largest value; negative values draw as empty bars but keep their number. */
export function barsView(block) {
  const max = Math.max(0, ...block.items.map(item => item.value));
  return block.items.map(item => ({
    label: item.label,
    value: item.value,
    text: formatValue(item.value, block.unit),
    pct: max > 0 ? Math.max(0, Math.round((item.value / max) * 1000) / 10) : 0,
  }));
}

/**
 * A trend's polyline in a width × height box (y grows down), with its min and max for the labels.
 * A flat series draws through the middle rather than along an edge.
 */
export function trendView(block, { width = 240, height = 48, pad = 3 } = {}) {
  const values = block.points.map(p => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min;
  const step = (width - pad * 2) / (block.points.length - 1);
  const coords = block.points.map((p, i) => {
    const x = pad + i * step;
    const y = span === 0 ? height / 2 : pad + (1 - (p.value - min) / span) * (height - pad * 2);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  const last = block.points[block.points.length - 1];
  return {
    width, height,
    points: coords.map(([x, y]) => `${x},${y}`).join(' '),
    end: coords[coords.length - 1],
    min, max,
    minText: formatValue(min, block.unit),
    maxText: formatValue(max, block.unit),
    lastText: formatValue(last.value, block.unit),
    firstLabel: formatTick(block.points[0].t),
    lastLabel: formatTick(last.t),
  };
}

/** "R2 · DataConnect · Live Work Orders" — or just the ref when the source is not known. */
export function captionText(ref, answer) {
  const source = ref ? sourceForRef(ref, answer) : null;
  return [ref, source].filter(Boolean).join(' · ');
}

// ── DOM ──────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The answer's blocks as one element, or null when there are none.
 *
 * @param {object} answer
 * @param {object} [options]
 * @param {(location: {lon: number, lat: number}, ctx: {label: string, button: HTMLButtonElement}) => void} [options.onLocate]
 * @param {(ref: string) => HTMLElement} [options.refChip]  the ref in a caption, as an evidence chip
 * @param {Document} [options.doc]
 */
export function renderBlocks(answer, { onLocate = null, refChip = null, doc = globalThis.document } = {}) {
  const blocks = answerBlocks(answer);
  if (!blocks.length) return null;
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = el('div', 'ask-twin-blocks');
  // Consecutive KPIs share one row of tiles; everything else is a block of its own.
  let kpiRow = null;
  for (const block of blocks) {
    if (block.type !== 'kpi') kpiRow = null;
    const caption = () => {
      const cap = el('div', 'ask-twin-block-caption');
      if (block.ref && refChip) cap.appendChild(refChip(block.ref));
      else if (block.ref) cap.appendChild(el('span', 'ask-twin-block-ref', block.ref));
      const source = block.ref ? sourceForRef(block.ref, answer) : null;
      if (source) cap.appendChild(el('span', 'ask-twin-block-source', source));
      return cap;
    };
    if (block.type === 'kpi') {
      if (!kpiRow) { kpiRow = el('div', 'ask-twin-kpis'); root.appendChild(kpiRow); }
      const tile = el('figure', 'ask-twin-block ask-twin-kpi');
      tile.dataset.evidenceHost = '';
      tile.append(el('div', 'ask-twin-kpi-value', formatValue(block.value, block.unit)), el('div', 'ask-twin-kpi-label', block.label));
      if (block.note) tile.appendChild(el('div', 'ask-twin-kpi-note', block.note));
      tile.appendChild(caption());
      kpiRow.appendChild(tile);
      continue;
    }
    const fig = el('figure', `ask-twin-block ask-twin-block--${block.type}`);
    fig.dataset.evidenceHost = '';
    if (block.title) fig.appendChild(el('div', 'ask-twin-block-title', block.title));
    if (block.type === 'bars') {
      const list = el('ul', 'ask-twin-bars');
      for (const bar of barsView(block)) {
        const li = el('li', 'ask-twin-bar');
        const label = el('span', 'ask-twin-bar-label', bar.label);
        label.title = bar.label;
        const track = el('span', 'ask-twin-bar-track');
        const fill = el('span', 'ask-twin-bar-fill');
        fill.style.width = `${bar.pct}%`;
        track.appendChild(fill);
        li.append(label, track, el('span', 'ask-twin-bar-value', bar.text));
        list.appendChild(li);
      }
      fig.appendChild(list);
    } else if (block.type === 'trend') {
      const view = trendView(block);
      const wrap = el('div', 'ask-twin-trend');
      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('class', 'ask-twin-trend-svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${block.title ?? 'Trend'}: ${view.firstLabel} to ${view.lastLabel}, from ${view.minText} to ${view.maxText}, last ${view.lastText}`);
      const line = doc.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('points', view.points);
      line.setAttribute('class', 'ask-twin-trend-line');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(line);
      const scale = el('div', 'ask-twin-trend-scale');
      scale.append(el('span', 'ask-twin-trend-max', view.maxText), el('span', 'ask-twin-trend-min', view.minText));
      const plot = el('div', 'ask-twin-trend-plot');
      plot.appendChild(svg);
      // The latest value is the one an operator reads first, so it sits by the end of the line.
      const dot = el('span', 'ask-twin-trend-dot');
      dot.style.left = `${(view.end[0] / view.width) * 100}%`;
      dot.style.top = `${(view.end[1] / view.height) * 100}%`;
      plot.appendChild(dot);
      wrap.append(plot, scale);
      const axis = el('div', 'ask-twin-trend-axis');
      axis.append(el('span', '', view.firstLabel), el('span', 'ask-twin-trend-last', `${view.lastLabel} · ${view.lastText}`));
      fig.append(wrap, axis);
    } else if (block.type === 'table') {
      fig.appendChild(renderTable(block, { el, onLocate }));
    }
    fig.appendChild(caption());
    root.appendChild(fig);
  }
  return root;
}

function renderTable(block, { el, onLocate }) {
  const box = el('div', 'ask-twin-table-box');
  let expanded = false;
  const draw = () => {
    const view = tableView(block, { expanded });
    const scroller = el('div', 'ask-twin-table-scroll');
    const table = el('table', 'ask-twin-table');
    const head = el('tr');
    view.columns.forEach((name, c) => {
      const th = el('th', view.numeric[c] ? 'is-num' : '', name);
      th.scope = 'col';
      head.appendChild(th);
    });
    if (view.locatable && onLocate) head.appendChild(el('th', 'ask-twin-table-go-col', ''));
    const thead = el('thead');
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const row of view.rows) {
      const tr = el('tr');
      row.cells.forEach((text, c) => tr.appendChild(el('td', view.numeric[c] ? 'is-num' : '', text)));
      if (view.locatable && onLocate) {
        const td = el('td', 'ask-twin-table-go-col');
        if (row.location) {
          const go = el('button', 'ask-twin-table-go', '⌖');
          go.type = 'button';
          go.title = `Show ${row.cells[0]} on the map`;
          go.setAttribute('aria-label', go.title);
          go.onclick = event => { event.stopPropagation(); onLocate(row.location, { label: row.cells[0], button: go }); };
          td.appendChild(go);
          // The whole row is a target for the mouse; the button is the keyboard's way in.
          tr.classList.add('is-locatable');
          tr.onclick = () => go.click();
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    scroller.appendChild(table);
    const parts = [scroller];
    if (view.total > TABLE_ROW_LIMIT) {
      const more = el('button', 'ask-twin-table-more', expanded ? 'Show fewer' : `Show all ${view.total} rows`);
      more.type = 'button';
      more.setAttribute('aria-expanded', String(expanded));
      more.onclick = () => { expanded = !expanded; draw(); box.querySelector('.ask-twin-table-more')?.focus(); };
      parts.push(more);
    }
    box.replaceChildren(...parts);
  };
  draw();
  return box;
}
