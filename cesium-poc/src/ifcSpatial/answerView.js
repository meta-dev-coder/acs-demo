/**
 * Ask the Twin answers on the IFC Spatial Twin screen, laid out for reading: one view model, one
 * renderer, whatever produced the answer (the network engine, the IFC comparison, documentation).
 *
 *   direct answer   title + a short lead (1–3 sentences)
 *   key findings    metrics, or groups of assets (8 shown, "Show all N" for the rest), or bullets
 *   details         collapsed sections (supporting lines, assumptions, inputs needed, raw values)
 *   sources         where each fact comes from (model version, comparison, ACC documents)
 *   actions         buttons that call the screen's own handlers (data attributes it already knows)
 *
 * Text is escaped first and then given a small, safe subset of Markdown (bold, italic, code, links to
 * http(s) only, bullet lists, tables); no HTML from any answer is ever inserted as is.
 */
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** Inline Markdown on already-escaped text. */
function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** A safe Markdown subset: paragraphs, "- " / "1. " lists, "|" tables, ``` code blocks; escaped first. */
export function md(source) {
  const lines = String(source ?? '').replace(/\\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      i += 1;
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i += 1) rows.push(lines[i]);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(esc(c.trim())));
      const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [head, ...rest] = body;
      out.push(`<div class="isp-ans-tablewrap"><table class="isp-ans-table"><thead><tr>${cells(head).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i += 1) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'} class="isp-ans-list">${items.map(x => `<li>${inline(esc(x))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^#{1,4}\s/.test(line)) {
      out.push(`<h4 class="isp-ans-h">${inline(esc(line.replace(/^#+\s/, '')))}</h4>`);
      i += 1;
    } else if (line.trim()) {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|\s*\||\s*([-*]|\d+\.)\s|#{1,4}\s)/.test(lines[i]); i += 1) para.push(lines[i]);
      out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
    } else i += 1;
  }
  return out.join('');
}

/**
 * Split an engine summary into a short lead and the rest: sentences that are mostly asset lists
 * (8 or more known ids) go to the details instead of the direct answer.
 */
export function splitLead(summary, knownIds) {
  // Sentence ends are ".", "!" or "?" followed by a space and a new sentence: "42.21 kA" stays whole.
  const sentences = String(summary ?? '').split(/(?<=[.!?])\s+(?=[A-Z0-9(“"'])/).map(s => s.trim()).filter(Boolean);
  const lead = [], rest = [];
  for (const s of sentences) {
    const ids = s.split(/[\s,;()]+/).filter(t => knownIds.has(t.replace(/[.:]$/, ''))).length;
    (ids >= 8 || (lead.length >= 3) ? rest : lead).push(s);
  }
  return { lead: lead.join(' '), rest };
}

const TONE = new Set(['ok', 'warn', 'bad', 'info', 'neutral']);

/**
 * @param {object} v
 * @param {string}  v.question
 * @param {string}  v.kind        short label ("Connectivity", "Version comparison")
 * @param {string}  v.status      'answered' | 'limited' | 'unsupported' | 'error' | 'loading'
 * @param {string}  v.title       the direct answer
 * @param {string}  [v.lead]      1–3 sentences (Markdown subset)
 * @param {Array}   [v.metrics]   [{label, value, tone}]
 * @param {Array}   [v.groups]    [{label, tone, items: [{id, label, attrs, dot}], total}]
 * @param {Array}   [v.bullets]   key findings, short sentences
 * @param {string}  [v.extraHtml] trusted HTML built by the caller from escaped parts (document rows)
 * @param {Array}   [v.details]   [{title, items?: string[], markdown?: string, html?: string}]
 * @param {Array}   [v.sources]   [string]
 * @param {Array}   [v.actions]   [{label, attrs, primary}]
 * @param {Array}   [v.followUps] [{label, question}]
 * @param {boolean} [v.wide]      expanded reading width
 */
export function renderAnswer(v) {
  const head = `<div class="isp-head"><span class="isp-q" title="${esc(v.question)}">${esc(v.question ?? 'Ask the Twin')}</span>
    <button type="button" class="isp-icon isp-ans-wide" data-act="answerWide" aria-pressed="${Boolean(v.wide)}" title="${v.wide ? 'Narrow' : 'Expand'} the answer" aria-label="${v.wide ? 'Narrow' : 'Expand'} the answer">${v.wide ? '⇥' : '⇤'}</button>
    <button type="button" class="isp-x" data-act="netClear" aria-label="Close">×</button></div>`;
  if (v.status === 'loading') {
    return `${head}<div class="isp-ans is-loading" aria-busy="true"><span class="isp-spinner" aria-hidden="true"></span><p>${esc(v.title ?? 'Working…')}</p></div>`;
  }
  const kicker = `<div class="isp-ans-kicker is-${esc(v.status ?? 'answered')}">${esc(v.kind ?? 'Answer')}${v.status === 'limited' ? ' · partial' : v.status === 'unsupported' ? ' · not answerable from the data' : v.status === 'error' ? ' · error' : ''}</div>`;
  const metrics = v.metrics?.length ? `<div class="isp-ans-metrics">${v.metrics.map(m => `<div class="isp-ans-metric is-${TONE.has(m.tone) ? m.tone : 'neutral'}"><b>${esc(m.value)}</b><span>${esc(m.label)}</span></div>`).join('')}</div>` : '';
  const item = it => `<button type="button" class="isp-ans-item"${Object.entries(it.attrs ?? {}).map(([k, val]) => ` ${k}="${esc(val)}"`).join('')}>${it.dot ? `<i class="isp-dot is-${esc(it.dot)}"></i>` : ''}${esc(it.label ?? it.id)}</button>`;
  const groups = (v.groups ?? []).filter(g => g.items?.length).map(g => {
    const first = g.items.slice(0, 8), more = g.items.slice(8);
    return `<div class="isp-ans-group is-${TONE.has(g.tone) ? g.tone : 'neutral'}"><div class="isp-ans-ghead"><span>${esc(g.label)}</span><b>${esc(g.total ?? g.items.length)}</b></div>
      <div class="isp-ans-items">${first.map(item).join('')}</div>
      ${more.length ? `<details class="isp-ans-more"><summary>Show all ${g.items.length}</summary><div class="isp-ans-items">${more.map(item).join('')}</div></details>` : ''}</div>`;
  }).join('');
  const bullets = v.bullets?.length ? `<ul class="isp-ans-list">${v.bullets.slice(0, 5).map(b => `<li>${inline(esc(b))}</li>`).join('')}</ul>${v.bullets.length > 5 ? `<details class="isp-ans-more"><summary>${v.bullets.length - 5} more</summary><ul class="isp-ans-list">${v.bullets.slice(5).map(b => `<li>${inline(esc(b))}</li>`).join('')}</ul></details>` : ''}` : '';
  const details = (v.details ?? []).filter(d => d.items?.length || d.markdown || d.html).map(d => `<details class="isp-ans-detail"><summary>${esc(d.title)}${d.items?.length ? ` <span class="isp-badge">${d.items.length}</span>` : ''}</summary>
    ${d.html ?? (d.markdown ? md(d.markdown) : `<ul class="isp-ans-list">${d.items.map(x => `<li>${inline(esc(x))}</li>`).join('')}</ul>`)}</details>`).join('');
  const actions = [...(v.actions ?? []).map(a => `<button type="button" class="isp-btn${a.primary ? ' is-primary' : ''}"${Object.entries(a.attrs ?? {}).map(([k, val]) => ` ${k}="${esc(val)}"`).join('')}>${esc(a.label)}</button>`),
    ...(v.followUps ?? []).slice(0, 3).map(f => `<button type="button" class="isp-btn is-ghost" data-ask="${esc(f.question)}">${esc(f.label)}</button>`)].join('');
  return `${head}<div class="isp-ans">${kicker}
    <h2 class="isp-ans-title">${esc(v.title)}</h2>
    ${v.lead ? `<div class="isp-ans-lead">${md(v.lead)}</div>` : ''}
    ${metrics}${bullets}${groups}${v.extraHtml ?? ''}
    ${actions ? `<div class="isp-actions isp-ans-actions">${actions}</div>` : ''}
    ${details}
    ${v.sources?.length ? `<p class="isp-ans-sources"><span>Source</span> ${v.sources.map(esc).join(' · ')}</p>` : ''}</div>`;
}
