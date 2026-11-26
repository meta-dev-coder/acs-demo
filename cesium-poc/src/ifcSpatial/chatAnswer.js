/**
 * Ask the Twin answers as the conversation panel shows them (askPanel.js): the same view model as
 * answerView.js (from the engine, the IFC comparison, documents, power status), laid out for a
 * conversation on the panel's dark surface.
 *
 *   assistant message  a short sentence first ("I found 9 transformers across Seagirt."), then a lead
 *   asset summary      for one asset: id, type, status, a few key values, map / path / documents actions
 *   result cards       compact rows (id, where, status) — four shown, "View all N" for the rest —
 *                      and one provenance note for the whole list instead of one per row
 *   suggestions        follow-up questions, asked through the same flow
 *   sources            "Sources & assumptions", collapsed
 *
 * Every row and button carries the data attributes the screen already handles (data-asset, data-ask,
 * data-act …). Text is escaped; only the trusted fragments the caller builds (extraHtml, html) are
 * inserted as they are.
 */
import { md } from './answerView.js';
import { ASK_ICONS, sparkleSvg } from './askPanel.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const attrs = a => Object.entries(a ?? {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
const TONE = new Set(['ok', 'warn', 'bad', 'info', 'neutral']);
const tone = t => (TONE.has(t) ? t : 'neutral');
export const ROWS_SHOWN = 4;

/** One result row: icon, id over where it is, status, chevron. */
function rowHtml(it) {
  const tag = it.attrs ? 'button' : 'div';
  return `<${tag}${tag === 'button' ? ' type="button"' : ''} class="tw-row"${attrs(it.attrs)}>
    <span class="tw-row-ic is-${tone(it.iconTone ?? 'info')}">${ASK_ICONS[it.icon] ?? ASK_ICONS.bolt}</span>
    <span class="tw-row-main"><b>${esc(it.title ?? it.id ?? it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
    ${it.status ? `<span class="tw-status is-${tone(it.status.tone)}">${esc(it.status.label)}</span>` : it.dot ? `<i class="tw-dot is-${esc(it.dot)}" aria-hidden="true"></i>` : ''}
    ${tag === 'button' ? `<span class="tw-chev" aria-hidden="true">${ASK_ICONS.chevron}</span>` : ''}</${tag}>`;
}

function groupHtml(g, describe) {
  // What the answer says about a row wins; the network fills in the rest (where it is, its status).
  const items = g.items.map(it => { const d = describe(it); return d ? { ...d, ...Object.fromEntries(Object.entries(it).filter(([k, v]) => v !== undefined && k !== 'label')) } : it; });
  const n = g.total ?? items.length;
  const first = items.slice(0, ROWS_SHOWN), rest = items.slice(ROWS_SHOWN);
  const noun = g.noun ?? (g.label ?? '').toLowerCase();
  return `<section class="tw-card tw-result is-${tone(g.tone)}"><header class="tw-card-h"><h4>${esc(g.label)}</h4><span class="tw-count">${esc(n)} found</span></header>
    <div class="tw-rows">${first.map(rowHtml).join('')}</div>
    ${rest.length ? `<details class="tw-more"><summary><span class="tw-more-open">View all ${esc(items.length)}${noun && noun.length < 28 ? ` ${esc(noun)}` : ''}</span><span class="tw-more-close">Show fewer</span></summary><div class="tw-rows">${rest.map(rowHtml).join('')}</div></details>` : ''}
    ${g.note ? `<p class="tw-note">${ASK_ICONS.info}${esc(g.note)}</p>` : ''}</section>`;
}

/** The single-asset summary card. */
function assetCardHtml(c) {
  const focus = c.focus ?? {};
  const focusBtn = focus.state === 'ok'
    ? `<button type="button" class="tw-act is-done" data-act="focusRecenter">${ASK_ICONS.target}<span>Focused on map</span><span class="tw-check" aria-label="done">${ASK_ICONS.check}</span></button>`
    : focus.state === 'flying'
      ? `<div class="tw-act is-busy" aria-busy="true">${ASK_ICONS.target}<span>Focusing the map…</span><span class="tw-spin" aria-hidden="true"></span></div>`
      : focus.state === 'nogeo'
        ? `<div class="tw-act is-off">${ASK_ICONS.target}<span>No position in the model to focus on</span></div>`
        : `<button type="button" class="tw-act" data-act="focusRetry" data-asset-id="${esc(c.id)}">${ASK_ICONS.target}<span>Focus on map</span><span class="tw-chev">${ASK_ICONS.chevron}</span></button>`;
  return `<section class="tw-card tw-asset"><div class="tw-asset-h"><span class="tw-asset-ic">${ASK_ICONS[c.icon] ?? ASK_ICONS.bolt}</span>
      <div class="tw-asset-t"><b>${esc(c.id)}</b><small>${esc(c.type)}</small></div>${c.status ? `<span class="tw-pill is-${tone(c.status.tone)}">${esc(c.status.label)}</span>` : ''}</div>
    ${c.rows?.length ? `<dl class="tw-kv">${c.rows.map(r => `<div><dt>${ASK_ICONS[r.icon] ?? ''}<span>${esc(r.k)}</span></dt><dd>${esc(r.v)}</dd></div>`).join('')}</dl>` : ''}
    <div class="tw-acts">${focusBtn}
      <button type="button" class="tw-act" data-path="${esc(c.id)}">${ASK_ICONS.network}<span>View network path</span><span class="tw-chev">${ASK_ICONS.chevron}</span></button>
      <button type="button" class="tw-act" data-act="assetDocs" data-asset-id="${esc(c.id)}">${ASK_ICONS.doc}<span>View documents${Number.isFinite(c.docs) ? ` (${c.docs})` : ''}</span><span class="tw-chev">${ASK_ICONS.chevron}</span></button></div>
    ${c.note ? `<p class="tw-note">${ASK_ICONS.info}${esc(c.note)}</p>` : ''}</section>`;
}

/**
 * Many assets found: compact rows (five, then "+ N more"), each with its reported status. The count and
 * the map highlight are in the sentence above; clearing is on the highlight bar above the input.
 */
function collectionHtml(c) {
  // A row selects its asset (data-asset) unless it says otherwise (attrs; null: not clickable).
  const row = r => {
    const a = r.attrs === undefined ? { 'data-asset': r.id } : r.attrs;
    const tag = a ? 'button' : 'div';
    return `<${tag}${a ? ' type="button"' : ''} class="tw-crow${r.id === c.selectedId ? ' is-selected' : ''}"${attrs(a)} title="${esc(r.name ?? r.id)}"${a ? ` aria-current="${r.id === c.selectedId}"` : ''}>
      <span class="tw-crow-ic">${ASK_ICONS[r.icon] ?? ASK_ICONS.bolt}</span><i class="tw-crow-sel" aria-hidden="true"></i><b>${esc(r.id)}</b>
      <span class="tw-cstat is-${tone(r.status?.tone)}"><i aria-hidden="true"></i>${esc(r.status?.label ?? 'Unknown')}</span><span class="tw-chev" aria-hidden="true">${a ? ASK_ICONS.chevron : ''}</span></${tag}>`;
  };
  const first = c.rows.slice(0, 5), rest = c.rows.slice(5);
  const open = rest.some(r => r.id === c.selectedId);
  // The sentence above already says how many and that they are on the map: the card is the rows alone.
  return `<section class="tw-coll" aria-label="${esc(c.title)}">
      <div class="tw-coll-rows">${first.map(row).join('')}</div>
      ${rest.length ? `<details class="tw-coll-more"${open ? ' open' : ''}><summary><span>+ ${rest.length} more (${esc(rest.slice(0, 4).map(r => r.id).join(', '))}${rest.length > 4 ? ', …' : ''})</span>${ASK_ICONS.chevron}</summary><div class="tw-coll-rows">${rest.map(row).join('')}</div></details>` : ''}</section>`;
}

/**
 * The relationship between two assets: classification, the path (as the model has it), the facts
 * (physical, direction, normal service, operational), evidence and what is missing, and actions.
 */
function relationHtml(r) {
  const chain = (r.path ?? []).map(id => `<span class="tw-rel-step">${esc(id)}</span>`).join('<span class="tw-rel-arrow" aria-hidden="true">→</span>');
  return `<section class="tw-card tw-rel"><header class="tw-rel-h"><h4>${ASK_ICONS.network}${esc(r.title)}</h4><span class="tw-rel-ver">${esc(r.version)}</span></header>
    <div class="tw-rel-pair"><b>${esc(r.source)}</b><span aria-hidden="true">→</span><b>${esc(r.target)}</b><span class="tw-pill is-${tone(r.tone)}">${esc(r.label)}</span></div>
    ${chain ? `<div class="tw-rel-path">${chain}</div>` : ''}
    <dl class="tw-kv tw-rel-facts">${(r.facts ?? []).map(([k, v]) => `<div><dt><span>${esc(k)}</span></dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${r.evidence?.length ? `<details class="tw-sources"><summary>${ASK_ICONS.info}<span>Evidence (${r.evidence.length} connections)</span></summary><div class="tw-src-sec"><ul class="tw-list">${r.evidence.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></details>` : ''}
    ${r.missing?.length ? `<details class="tw-sources"><summary>${ASK_ICONS.info}<span>Missing evidence</span></summary><div class="tw-src-sec"><ul class="tw-list">${r.missing.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></details>` : ''}
    ${r.actions?.length ? `<div class="tw-btns">${r.actions.map(a => `<button type="button" class="tw-btn${a.primary ? ' is-primary' : ''}"${attrs(a.attrs)}>${esc(a.label)}</button>`).join('')}</div>` : ''}</section>`;
}

/**
 * @param {object} v the answer view model (answerView.js), plus:
 *   say: the first sentence; asset: the summary card; html: a trusted legacy fragment
 * @param {object} [opts]
 * @param {(item) => object|null} [opts.describe] adds {title, sub, status, icon} to a row by its id
 */
export function renderChatAnswer(v, { describe = () => null } = {}) {
  const say = v.say ?? v.title ?? '';
  const status = v.status ?? 'answered';
  if (status === 'loading') {
    return `<div class="tw-msg"><span class="tw-avatar">${sparkleSvg(20)}</span><div class="tw-msg-b"><p class="tw-say is-loading" aria-busy="true"><span class="tw-dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(v.title ?? 'Working…')}</p></div></div>`;
  }
  // With a scope chip the kind is left out (one label per answer); a partial or failed answer still says so.
  const meta = [v.scope ? null : v.kind, status === 'limited' ? 'partial' : status === 'unsupported' ? 'not answerable from the data' : status === 'error' ? 'error' : null].filter(Boolean).join(' · ');
  const lead = v.lead && v.lead.trim() !== say.trim() ? `<div class="tw-lead">${md(v.lead)}</div>` : '';
  const sub = v.title && v.say && v.title !== v.say && !v.asset ? `<p class="tw-sub">${esc(v.title)}</p>` : '';
  const metrics = v.metrics?.length ? `<div class="tw-metrics">${v.metrics.map(m => `<div class="tw-metric is-${tone(m.tone)}"><b>${esc(m.value)}</b><span>${esc(m.label)}</span></div>`).join('')}</div>` : '';
  const groups = (v.groups ?? []).filter(g => g.items?.length).map(g => groupHtml(g, describe)).join('');
  const bullets = v.bullets?.length ? `<ul class="tw-list">${v.bullets.slice(0, 5).map(b => `<li>${md(b).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>${v.bullets.length > 5 ? `<details class="tw-more"><summary>${v.bullets.length - 5} more</summary><ul class="tw-list">${v.bullets.slice(5).map(b => `<li>${md(b).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></details>` : ''}` : '';
  const actions = (v.actions ?? []).map(a => `<button type="button" class="tw-btn${a.primary ? ' is-primary' : ''}"${attrs(a.attrs)}>${esc(a.label)}</button>`).join('');
  const suggestions = (v.followUps ?? []).slice(0, v.suggestLimit ?? 3);
  const details = (v.details ?? []).filter(d => d.items?.length || d.markdown || d.html);
  const sources = v.sources ?? [];
  const sourcesHtml = details.length || sources.length ? `<details class="tw-sources"><summary>${ASK_ICONS.info}<span>Sources &amp; assumptions</span></summary>
      ${sources.length ? `<div class="tw-src-sec"><h5>Sources</h5><ul class="tw-list">${sources.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${details.map(d => `<div class="tw-src-sec"><h5>${esc(d.title)}</h5>${d.html ?? (d.markdown ? md(d.markdown) : `<ul class="tw-list">${d.items.map(x => `<li>${md(x).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>`)}</div>`).join('')}</details>` : '';
  // A plain answer (the document workspace) is its own header: a sentence only when it answers directly.
  const bubble = v.plain && !say ? '' : `<div class="tw-msg is-${esc(status)}"><span class="tw-avatar">${sparkleSvg(20)}</span><div class="tw-msg-b">
      ${v.scope ? `<span class="tw-scope${/^Selected area/.test(v.scope) ? ' is-area' : ''}">${ASK_ICONS.scan}<span>${esc(v.scope)}</span></span>` : ''}<p class="tw-say">${esc(say)}</p>${v.say2 ? `<p class="tw-say2">${esc(v.say2)}</p>` : ''}${sub}${lead}${meta && !v.plain ? `<span class="tw-meta">${esc(meta)}</span>` : ''}</div></div>`;
  return `${bubble}
    ${v.asset ? assetCardHtml(v.asset) : ''}${v.relation ? relationHtml(v.relation) : ''}${v.collection ? collectionHtml(v.collection) : ''}${metrics}${groups}${v.html ? `<div class="tw-card tw-legacy">${v.html}</div>` : ''}${bullets}${v.extraHtml ? `<div class="tw-extra">${v.extraHtml}</div>` : ''}
    ${actions ? `<div class="tw-btns">${actions}</div>` : ''}
    ${suggestions.length ? `<div class="tw-suggest"><h5>Suggested questions</h5>${suggestions.map(f => `<button type="button" class="tw-chip" data-ask="${esc(f.question)}">${ASK_ICONS[f.icon] ?? ASK_ICONS.bolt}<span>${esc(f.label)}</span></button>`).join('')}</div>` : ''}
    ${sourcesHtml}`;
}
