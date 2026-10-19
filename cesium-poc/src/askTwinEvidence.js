/**
 * Evidence chips: every ref an answer shows (R1, R2 …) as a small button that opens the records the
 * lookup actually returned.
 *
 * The basis list already said "R2 · DataConnect", but an operator who doubted a claim had no way to
 * see what R2 held short of opening the activity log and reading tool inputs. The server now sends
 * `evidence` — a few records per cited ref — and a chip opens them inline, with a fly button for each
 * record that has a position.
 *
 * A ref with no evidence entry (an older server, or a lookup that returned nothing to show) still
 * reads as a chip, but a quiet, non-interactive one: there is nothing behind it to open.
 *
 * `splitRefs`, `knownRefs` and `evidenceView` are pure; `createEvidenceChips` places them.
 */
import { formatNumber, validLocation } from './askTwinBlocks.js';

export const EVIDENCE_FIELD_LIMIT = 4;

/** Every ref the answer itself vouches for: the claims' refs, the cited list, evidence and blocks. */
export function knownRefs(answer = {}) {
  const refs = new Set();
  for (const item of answer.basis ?? []) for (const ref of item?.refs ?? []) refs.add(String(ref));
  for (const ref of answer.cited ?? []) refs.add(String(ref));
  for (const ref of Object.keys(answer.evidence ?? {})) refs.add(ref);
  for (const block of answer.blocks ?? []) if (block?.ref) refs.add(String(block.ref));
  return refs;
}

// "(R1)", "[R2]", "(R1, R3)", "[R1; R2]" — a ref only counts inside brackets, so a road named
// "R1" or a sentence about "R2 ramps" is never turned into a chip.
const REF_GROUP = /[([]\s*(R\d+(?:\s*[,;]\s*R\d+)*)\s*[)\]]/g;

/**
 * Answer text split into plain text and groups of refs.
 *
 * A group becomes chips only when every ref in it is one the answer knows; anything else is left as
 * the model wrote it, so a stray "(R9)" the server never ran does not become a button to nothing.
 *
 * @param {string} text
 * @param {Set<string>} [known]  omit to accept any ref
 * @returns {({type: 'text', text: string} | {type: 'refs', refs: string[], raw: string})[]}
 */
export function splitRefs(text, known) {
  const source = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(REF_GROUP)) {
    const refs = match[1].split(/\s*[,;]\s*/);
    if (known && !refs.every(ref => known.has(ref))) continue;
    // "the queue (R1)." → "the queue" + chip: the space before the bracket goes with the bracket.
    let start = match.index;
    while (start > last && source[start - 1] === ' ') start -= 1;
    if (start > last) parts.push({ type: 'text', text: source.slice(last, start) });
    parts.push({ type: 'refs', refs, raw: match[0] });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ type: 'text', text: source.slice(last) });
  return parts.length ? parts : [{ type: 'text', text: source }];
}

const fieldText = value => {
  if (value === null || value === undefined || value === '') return 'NA';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * One ref's evidence as the drawer shows it: up to four fields per record, the position if it has a
 * real one, and how many records the lookup found beyond those the server sent.
 */
export function evidenceView(entry, { maxFields = EVIDENCE_FIELD_LIMIT } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const records = (Array.isArray(entry.records) ? entry.records : []).filter(r => r && typeof r === 'object').map(record => ({
    id: record.id === undefined || record.id === null ? 'NA' : String(record.id),
    label: record.label ? String(record.label) : null,
    fields: Object.entries(record.fields ?? {}).slice(0, maxFields).map(([key, value]) => [key, fieldText(value)]),
    location: validLocation(record),
  }));
  const total = Number.isFinite(Number(entry.total)) && entry.total !== null ? Number(entry.total) : records.length;
  return {
    source: entry.source ? String(entry.source) : null,
    summary: entry.summary ? String(entry.summary) : null,
    records,
    total,
    more: Math.max(0, total - records.length),
  };
}

// ── DOM ──────────────────────────────────────────────────────────────────

let drawerSeq = 0;

/**
 * Chips for one answer. One drawer is open at a time per answer: opening another ref swaps it.
 *
 * @param {object} answer
 * @param {object} [options]
 * @param {(location: {lon: number, lat: number}, ctx: {label: string, button: HTMLButtonElement, ref: string}) => void} [options.onLocate]
 * @param {Document} [options.doc]
 * @returns {{chip: (ref: string) => HTMLElement, chipsFor: (refs: string[]) => HTMLElement,
 *   textWithChips: (text: string) => DocumentFragment, close: () => void}}
 */
export function createEvidenceChips(answer, { onLocate = null, doc = globalThis.document } = {}) {
  const known = knownRefs(answer);
  const evidence = answer?.evidence ?? {};
  let open = null; // { chip, drawer }

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function close({ focus = false } = {}) {
    if (!open) return;
    const { chip, drawer } = open;
    open = null;
    drawer.remove();
    chip.setAttribute('aria-expanded', 'false');
    chip.classList.remove('is-open');
    if (focus) chip.focus();
  }

  function drawerFor(ref, chip) {
    const view = evidenceView(evidence[ref]);
    const drawer = el('div', 'ask-twin-evidence');
    drawer.id = `ask-twin-evidence-${++drawerSeq}`;
    drawer.setAttribute('role', 'region');
    drawer.setAttribute('aria-label', `Evidence ${ref}`);
    drawer.tabIndex = -1;
    const head = el('div', 'ask-twin-evidence-head');
    head.appendChild(el('span', 'ask-twin-evidence-ref', ref));
    if (view.source) head.appendChild(el('span', 'ask-twin-evidence-source', view.source));
    const shut = el('button', 'ask-twin-evidence-close', '✕');
    shut.type = 'button';
    shut.setAttribute('aria-label', `Close evidence ${ref}`);
    shut.onclick = () => close({ focus: true });
    head.appendChild(shut);
    drawer.appendChild(head);
    if (view.summary) drawer.appendChild(el('p', 'ask-twin-evidence-summary', view.summary));
    if (!view.records.length) drawer.appendChild(el('p', 'ask-twin-evidence-empty', 'No records were attached to this lookup.'));
    const list = el('ul', 'ask-twin-evidence-list');
    for (const record of view.records) {
      const li = el('li', 'ask-twin-evidence-record');
      const top = el('div', 'ask-twin-evidence-record-head');
      top.appendChild(el('span', 'ask-twin-evidence-id', record.id));
      if (record.label) top.appendChild(el('span', 'ask-twin-evidence-label', record.label));
      if (record.location && onLocate) {
        const go = el('button', 'ask-twin-evidence-go', 'Fly to');
        go.type = 'button';
        go.setAttribute('aria-label', `Fly to ${record.label ?? record.id}`);
        go.onclick = () => onLocate(record.location, { label: record.label ?? record.id, button: go, ref });
        top.appendChild(go);
      }
      li.appendChild(top);
      if (record.fields.length) {
        const dl = el('dl', 'ask-twin-evidence-fields');
        for (const [key, value] of record.fields) dl.append(el('dt', '', key), el('dd', '', value));
        li.appendChild(dl);
      }
      list.appendChild(li);
    }
    if (view.records.length) drawer.appendChild(list);
    if (view.more) drawer.appendChild(el('p', 'ask-twin-evidence-more', `${formatNumber(view.more)} more not shown`));
    drawer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); close({ focus: true }); }
    });
    chip.setAttribute('aria-controls', drawer.id);
    return drawer;
  }

  function toggle(ref, chip) {
    const wasThis = open?.chip === chip;
    close();
    if (wasThis) return;
    const drawer = drawerFor(ref, chip);
    // Inline, under whatever the chip sits in (the answer text, the claims list, a block), so the
    // records read next to the claim they back — a floating popover would cover the map or the text.
    const host = chip.closest('[data-evidence-host]') ?? chip.parentElement;
    host.insertAdjacentElement('afterend', drawer);
    chip.setAttribute('aria-expanded', 'true');
    chip.classList.add('is-open');
    open = { chip, drawer };
  }

  function chip(ref) {
    const source = evidence[ref]?.source;
    if (!evidence[ref]) {
      const quiet = el('span', 'ask-twin-ref-chip is-static', ref);
      quiet.title = 'No records attached for this lookup';
      return quiet;
    }
    const button = el('button', 'ask-twin-ref-chip', ref);
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', `Evidence ${ref}${source ? ` from ${source}` : ''}`);
    if (source) button.title = source;
    button.onclick = () => toggle(ref, button);
    button.addEventListener('keydown', event => {
      if (event.key === 'Escape' && open?.chip === button) { event.stopPropagation(); close({ focus: true }); }
    });
    return button;
  }

  function chipsFor(refs) {
    const span = el('span', 'ask-twin-ref-chips');
    for (const ref of refs) span.appendChild(chip(String(ref)));
    return span;
  }

  function textWithChips(text) {
    const frag = doc.createDocumentFragment();
    for (const part of splitRefs(text, known)) {
      if (part.type === 'text') frag.appendChild(doc.createTextNode(part.text));
      else { frag.appendChild(doc.createTextNode(' ')); frag.appendChild(chipsFor(part.refs)); }
    }
    return frag;
  }

  return { chip, chipsFor, textWithChips, close, known };
}
