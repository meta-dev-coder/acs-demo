/**
 * The activity log of one Ask the Twin answer: what the orchestrator did, in the order it did it.
 *
 * Shown in the chat while the answer is being worked out and kept with the answer afterwards, so an
 * operator can see what the twin looked at, and so we can see where an answer went wrong — a slow
 * model round, a lookup with the wrong filter, a claim that cited nothing.
 *
 * It reads like the "thinking" line of a chat assistant: one quiet line saying what the twin is doing
 * right now, with a ticking timer, that opens into a timeline. Operators found the earlier numbered
 * list of every event (token counts first, model notes as numbered steps, "R2 · none · 0 ms — error")
 * too noisy to read while waiting, so plain words come first and the numbers sit under them, muted.
 *
 * `activityEntry`, `activityStep`, `currentActivity` and `activitySummary` are pure (event in, words
 * out) so the wording is testable without a browser; the DOM part only places the words.
 */
import { TOOL_LABELS } from './askTwinStream.js';

const WORKSPACE_LABELS = Object.freeze({ traffic: 'Traffic', safety: 'Safety', maintenance: 'Maintenance', liveOps: 'Live Ops', tmc: 'TMC' });
export const PERSONA_LABELS = Object.freeze({ tmc_operator: 'TMC operator', maintenance_manager: 'Maintenance manager', safety_engineer: 'Safety engineer' });
const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtInt = n => Number(n || 0).toLocaleString('en-US');

/** A lookup's input in a few words: the class, filters, layer or place it asked about. */
export function describeInput(name, input = {}) {
  const parts = [];
  if (input.class_name) parts.push(input.class_name);
  if (input.layer) parts.push(input.layer.replace(/\.geojson$/, '').replace(/^i595_/, ''));
  for (const f of Array.isArray(input.filters) ? input.filters : []) parts.push(`${f.field} ${f.operator === 'equals' ? '=' : '∋'} "${f.value}"`);
  if (input.group_by) parts.push(`by ${input.group_by}`);
  if (input.text) parts.push(`"${input.text}"`);
  if (input.type) parts.push(input.type);
  // records_near: a place is named by the text it matched, with the radius on the input itself.
  if (input.place?.text) parts.push(`within ${input.radius_m ?? 500} m of "${input.place.text}"`);
  else if (name === 'records_near' && input.near) parts.push(`within ${input.radius_m ?? 500} m of ${Number(input.near.lat).toFixed(4)}, ${Number(input.near.lon).toFixed(4)}`);
  else if (input.near) parts.push(`within ${input.near.radius_m ?? 1000} m of ${Number(input.near.lat).toFixed(4)}, ${Number(input.near.lon).toFixed(4)}`);
  if (input.incident_id) parts.push(input.incident_id);
  if (input.weather && input.weather !== 'any') parts.push(`${input.weather} weather`);
  if (input.hours) parts.push(`next ${input.hours} h`);
  if (name === 'get_weather' && Number.isFinite(input.lat)) parts.push(`${Number(input.lat).toFixed(3)}, ${Number(input.lon).toFixed(3)}`);
  return parts.join(' · ');
}

/**
 * One event as a log line.
 * @returns {{key: string, kind: string, text: string, status?: string} | null}
 *   `key` lets a later event replace an earlier line (a lookup's start, then its result)
 */
export function activityEntry(event) {
  switch (event.type) {
    case 'ContextUsed': {
      const parts = [];
      if (event.persona) parts.push(`demo persona ${PERSONA_LABELS[event.persona] ?? event.persona}`);
      if (event.workspace) parts.push(`${WORKSPACE_LABELS[event.workspace] ?? event.workspace} screen`);
      if (event.selection) parts.push(`${event.selection.type} ${event.selection.id}`);
      if (event.temporal?.mode) parts.push(event.temporal.mode.toLowerCase() + (event.temporal.date ? ` ${event.temporal.date}` : ''));
      if (event.hasArea) parts.push('drawn area');
      if (event.hasView) parts.push('visible map area');
      if (event.historyTurns) parts.push(`${event.historyTurns} earlier turn${event.historyTurns === 1 ? '' : 's'}`);
      return { key: 'context', kind: 'context', text: `Context sent: ${parts.length ? parts.join(' · ') : 'question only'}` };
    }
    case 'ModelNote':
      return { key: `note-${event.round}-${event.text.slice(0, 24)}`, kind: 'note', text: event.text };
    case 'StepStarted':
      return { key: `round-${event.round}`, kind: 'model', status: 'running', text: `Claude, round ${event.round}${event.last ? ' (answer only)' : ''}…` };
    case 'ModelRound': {
      const u = event.usage ?? {};
      const cached = u.cache_read_input_tokens ? `, ${fmtInt(u.cache_read_input_tokens)} cached` : '';
      const next = event.toolCalls ? `asked for ${event.toolCalls} lookup${event.toolCalls === 1 ? '' : 's'}` : 'wrote the answer';
      return { key: `round-${event.round}`, kind: 'model', status: 'ok',
        text: `Claude, round ${event.round} · ${fmtMs(event.ms)} · ${fmtInt(u.input_tokens)} in${cached} / ${fmtInt(u.output_tokens)} out → ${next}` };
    }
    case 'ToolCallStart': {
      const what = describeInput(event.name, event.input);
      return { key: `tool-${event.id}`, kind: 'tool', status: 'running',
        text: `${event.ref} · ${TOOL_LABELS[event.name] ?? event.name}${what ? ` (${what})` : ''}${event.origin === 'prefetch' ? ' · before asking Claude' : ''}…` };
    }
    case 'ToolCallEnd': {
      const label = TOOL_LABELS[event.name] ?? event.name;
      const where = event.source ? ` · ${event.source}` : '';
      const summary = event.summary ? ` — ${event.summary}` : '';
      const problem = event.status === 'ok' ? '' : ` — ${event.status}${event.detail ? `: ${event.detail}` : ''}`;
      return { key: `tool-${event.id}`, kind: 'tool', status: event.status, text: `${event.ref} · ${label}${where} · ${fmtMs(event.ms)}${summary}${problem}` };
    }
    case 'Checks': {
      const bits = [`confidence ${String(event.confidence).toUpperCase()}: ${event.reason}`];
      if (event.uncited?.length) bits.push(`not used in the answer: ${event.uncited.join(', ')}`);
      if (event.gaps?.length) bits.push(`stated gaps: ${event.gaps.join('; ')}`);
      if (event.actionNote) bits.push(event.actionNote);
      return { key: 'checks', kind: 'checks', status: event.confidence === 'high' ? 'ok' : event.confidence === 'medium' ? 'gap' : 'error', text: `Checked — ${bits.join(' · ')}` };
    }
    case 'RunFinished':
      return { key: 'finished', kind: 'done', status: 'ok', text: `Done in ${fmtMs(event.ms)} · ${event.rounds} model round${event.rounds === 1 ? '' : 's'}` };
    case 'RunError':
      return { key: 'finished', kind: 'done', status: 'error', text: `Stopped: ${event.message}` };
    default:
      return null;
  }
}

/** Elapsed time as the timer shows it: tenths under a minute, then minutes and seconds. */
export function fmtElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const total = Math.floor(value / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The collapsed line once the run is over (while it runs, the line is `currentActivity`).
 * Lookups are left out when there were none: the older single-call service reports no lookups
 * although it does read live events, so "no lookups" would be wrong for it.
 */
export function activitySummary({ lookups = 0, ms = null, failed = false, running = false, current = null }) {
  if (running) return current ?? 'Working…';
  const took = ms === null ? '' : fmtElapsed(ms);
  if (failed) return took ? `Stopped after ${took}` : 'Stopped';
  const parts = [took ? `Worked for ${took}` : 'Done'];
  if (lookups) parts.push(plural(lookups, 'lookup'));
  return parts.join(' · ');
}

// A model asked for a tool the twin does not have (it once asked for one called "none" when it meant
// "no lookup"). That is the model's slip, not a data failure, so it reads as skipped, not as an error.
const isUnknownTool = event => event.status !== 'ok' && /unknown tool/i.test(String(event.detail ?? ''));
const toolTitle = name => TOOL_LABELS[name] ?? `Looking up ${String(name).replace(/_/g, ' ')}`;
const PROBLEM_WORDS = Object.freeze({ gap: 'No data', timeout: 'Timed out', error: 'Failed' });

/**
 * What the collapsed line says while this event is the latest thing that happened, or null when the
 * event does not change it (a note, a lookup finishing — the log works out what is still running).
 */
export function currentActivity(event) {
  switch (event.type) {
    case 'RunStarted': return 'Getting started…';
    case 'ContextUsed': return 'Reading the question and your screen…';
    case 'StepStarted':
      if (event.last) return 'Writing the answer…';
      return event.round > 1 ? 'Thinking about what it found…' : 'Thinking…';
    case 'ModelRound': return event.toolCalls ? null : 'Checking the answer against its sources…';
    case 'ToolCallStart': return `${TOOL_LABELS[event.name] ?? 'Looking something up'}…`;
    case 'Checks': return 'Checking citations…';
    case 'AnswerReady': return 'Answer ready';
    default: return null;
  }
}

/**
 * One event as a timeline step: a plain title first, the technical detail (refs, ms, tokens) under
 * it, and a muted warning when something came back short.
 * @returns {{key: string, kind: string, title: string, detail?: string, warning?: string, status?: string, round?: number} | null}
 *   `key` lets a later event replace an earlier step (a lookup's start, then its result)
 */
export function activityStep(event) {
  switch (event.type) {
    case 'ContextUsed': {
      const detail = activityEntry(event).text.replace(/^Context sent: /, '');
      return { key: 'context', kind: 'context', status: 'ok', title: 'Read the question with your screen', detail };
    }
    case 'ModelNote':
      return { key: `note-${event.round}-${event.text.slice(0, 24)}`, kind: 'note', round: event.round, title: event.text };
    case 'StepStarted':
      return { key: `round-${event.round}`, kind: 'model', round: event.round, status: 'running',
        title: event.last ? 'Writing the answer' : event.round > 1 ? 'Thinking about what it found' : 'Thinking',
        detail: `Claude · round ${event.round}${event.last ? ' (answer only)' : ''}` };
    case 'ModelRound': {
      const u = event.usage ?? {};
      const cached = u.cache_read_input_tokens ? `, ${fmtInt(u.cache_read_input_tokens)} cached` : '';
      return { key: `round-${event.round}`, kind: 'model', round: event.round, status: 'ok',
        title: event.toolCalls ? `Decided on ${plural(event.toolCalls, 'lookup')}` : 'Wrote the answer',
        detail: `Claude · round ${event.round} · ${fmtMs(event.ms)} · ${fmtInt(u.input_tokens)} in${cached} / ${fmtInt(u.output_tokens)} out tokens` };
    }
    case 'ToolCallStart': {
      const what = describeInput(event.name, event.input);
      return { key: `tool-${event.id}`, kind: 'tool', status: 'running', title: toolTitle(event.name),
        detail: [event.ref, what].filter(Boolean).join(' · ') };
    }
    case 'ToolCallEnd': {
      if (isUnknownTool(event)) {
        return { key: `tool-${event.id}`, kind: 'tool', status: 'skipped', title: 'Skipped an invalid lookup',
          detail: `${event.ref} · Claude asked for '${event.name}', which is not a lookup the twin has` };
      }
      // What was asked stays visible after the result: "Unknown class" means nothing without the class.
      const detail = [event.ref, describeInput(event.name, event.input) || null, event.source, fmtMs(event.ms), event.summary].filter(Boolean).join(' · ');
      const step = { key: `tool-${event.id}`, kind: 'tool', status: event.status, title: toolTitle(event.name), detail };
      if (event.status !== 'ok') step.warning = `${PROBLEM_WORDS[event.status] ?? event.status}${event.detail ? `: ${event.detail}` : ''}`;
      return step;
    }
    case 'Checks': {
      const bits = [event.reason];
      if (event.uncited?.length) bits.push(`not used in the answer: ${event.uncited.join(', ')}`);
      if (event.actionNote) bits.push(event.actionNote);
      const step = { key: 'checks', kind: 'checks', status: event.confidence === 'high' ? 'ok' : 'gap',
        title: `Checked the answer · ${String(event.confidence).toLowerCase()} confidence`, detail: bits.filter(Boolean).join(' · ') };
      if (event.gaps?.length) step.warning = `Stated gaps: ${event.gaps.join('; ')}`;
      return step;
    }
    case 'RunFinished':
      return { key: 'finished', kind: 'done', status: 'ok', title: 'Done',
        detail: [Number.isFinite(event.ms) && event.ms > 0 ? fmtMs(event.ms) : null, event.rounds ? plural(event.rounds, 'model round') : null].filter(Boolean).join(' · ') };
    case 'RunError':
      return { key: 'finished', kind: 'done', status: 'error', title: 'Stopped', warning: event.message };
    default:
      return null;
  }
}

let logSeq = 0;
const svg = path => `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">${path}</svg>`;
const ICON_CHECK = svg('<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>');
const ICON_WARN = svg('<path d="M8 2.2l6.2 11H1.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.6v3.2M8 11.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
const ICON_CHEVRON = svg('<path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * The log element for one answer.
 * @param {{expanded?: boolean, now?: () => number}} options
 *   `expanded`: open the timeline from the start (the "keep activity open" setting); otherwise it
 *   stays one line until the operator opens it
 */
export function createActivityLog({ expanded = false, now = () => performance.now() } = {}) {
  const id = `ask-twin-activity-${++logSeq}`;
  const root = el('div', 'ask-twin-activity');
  root.dataset.state = 'running';

  const head = el('button', 'ask-twin-activity-head');
  head.type = 'button';
  head.setAttribute('aria-controls', `${id}-body`);
  const indicator = el('span', 'ask-twin-activity-indicator');
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<span></span><span></span><span></span>';
  // Only the label is a live region: the ticking timer next to it would otherwise be read out ten
  // times a second.
  const label = el('span', 'ask-twin-activity-label');
  label.setAttribute('aria-live', 'polite');
  label.setAttribute('aria-atomic', 'true');
  const labelText = el('span', 'ask-twin-activity-label-text', 'Getting started…');
  label.appendChild(labelText);
  const timer = el('span', 'ask-twin-activity-time', fmtElapsed(0));
  timer.setAttribute('aria-hidden', 'true');
  const chevron = el('span', 'ask-twin-activity-chevron');
  chevron.innerHTML = ICON_CHEVRON;
  head.append(indicator, label, timer, chevron);

  // The body animates open through a 0fr → 1fr grid row, which needs no measured height.
  const body = el('div', 'ask-twin-activity-body');
  body.id = `${id}-body`;
  const timeline = el('ol', 'ask-twin-activity-timeline');
  const inner = el('div', 'ask-twin-activity-inner');
  inner.appendChild(timeline);
  body.appendChild(inner);
  root.append(head, body);

  const setOpen = open => {
    head.setAttribute('aria-expanded', String(open));
    root.classList.toggle('is-open', open);
    body.inert = !open;
  };
  setOpen(expanded);
  head.addEventListener('click', () => setOpen(head.getAttribute('aria-expanded') !== 'true'));

  const steps = new Map();      // key → {li, title, detail, warning}
  const groups = new Map();     // model round → {li, notes, sub}; round 0 holds the prefetched lookups
  const running = new Map();    // lookup id → its label, to fall back to when the latest one finishes
  const state = { lookups: 0, ms: null, failed: false, running: true, round: 0, current: 'Getting started…', events: 0 };
  const started = now();

  // The new label slides in over the old one rather than snapping, so a fast run of lookups reads as
  // progress instead of flicker. The old text stays out of the accessibility tree while it leaves.
  let enterTimer = null;
  const showLabel = text => {
    if (text === labelText.textContent) return;
    for (const old of label.querySelectorAll('.is-leaving')) old.remove();
    const leaving = labelText.cloneNode(true);
    leaving.classList.add('is-leaving');
    leaving.setAttribute('aria-hidden', 'true');
    leaving.addEventListener('animationend', () => leaving.remove(), { once: true });
    setTimeout(() => leaving.remove(), 400);
    label.appendChild(leaving);
    labelText.textContent = text;
    labelText.classList.remove('is-entering');
    void labelText.offsetWidth;
    labelText.classList.add('is-entering');
    // On a machine busy rendering the 3D map, frames can take half a second and a CSS animation sits
    // on its first (transparent) keyframe; dropping the class on a timer means the words always show.
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => labelText.classList.remove('is-entering'), 320);
  };

  const tick = () => { if (state.running) timer.textContent = fmtElapsed(now() - started); };
  // The interval stops itself if the turn is removed (Clear chat) before the run ends.
  let attached = false;
  const interval = setInterval(() => {
    attached ||= root.isConnected;
    if (attached && !root.isConnected) { clearInterval(interval); return; }
    tick();
  }, 100);

  const groupFor = round => {
    let group = groups.get(round);
    if (group) return group;
    const li = el('li', 'ask-twin-step ask-twin-step--model');
    const dot = el('span', 'ask-twin-step-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = el('div', 'ask-twin-step-text');
    const title = el('div', 'ask-twin-step-title', round === 0 ? 'Looked up first' : 'Thinking');
    const detail = el('div', 'ask-twin-step-detail', round === 0 ? 'before asking Claude' : '');
    const notes = el('div', 'ask-twin-step-notes');
    const sub = el('ol', 'ask-twin-step-sub');
    text.append(title, detail, notes, sub);
    li.append(dot, text);
    if (round === 0) li.classList.add('is-ok');
    // Checks and the closing step always stay at the end, whatever arrives late.
    timeline.insertBefore(li, steps.get('checks')?.li ?? steps.get('finished')?.li ?? null);
    group = { li, title, detail, notes, sub };
    groups.set(round, group);
    steps.set(`round-${round}`, { li, title, detail, warning: null });
    return group;
  };

  const place = (step, event) => {
    if (step.kind === 'note') {
      const group = groupFor(step.round ?? state.round);
      if (!steps.has(step.key)) {
        const p = el('p', 'ask-twin-step-thought', step.title);
        group.notes.appendChild(p);
        steps.set(step.key, { li: p });
      }
      return;
    }
    if (step.kind === 'model') groupFor(step.round);
    let entry = steps.get(step.key);
    if (!entry) {
      const li = el('li', `ask-twin-step ask-twin-step--${step.kind}`);
      const dot = el('span', 'ask-twin-step-dot');
      dot.setAttribute('aria-hidden', 'true');
      const text = el('div', 'ask-twin-step-text');
      const title = el('div', 'ask-twin-step-title');
      const detail = el('div', 'ask-twin-step-detail');
      text.append(title, detail);
      li.append(dot, text);
      entry = { li, title, detail, warning: null };
      steps.set(step.key, entry);
      if (step.kind === 'tool') {
        const round = event.origin === 'prefetch' ? 0 : state.round;
        groupFor(round).sub.appendChild(li);
      } else if (step.kind === 'checks') {
        timeline.insertBefore(li, steps.get('finished')?.li ?? null);
      } else {
        timeline.appendChild(li);
      }
    }
    entry.li.className = `ask-twin-step ask-twin-step--${step.kind}${step.status ? ` is-${step.status}` : ''}`;
    entry.title.textContent = step.title;
    entry.detail.textContent = step.detail ?? '';
    entry.detail.hidden = !step.detail;
    if (step.warning) {
      if (!entry.warning) {
        entry.warning = el('div', 'ask-twin-step-warning');
        entry.title.parentElement.insertBefore(entry.warning, entry.detail.nextSibling);
      }
      entry.warning.innerHTML = ICON_WARN;
      entry.warning.append(document.createTextNode(step.warning));
    } else if (entry.warning) {
      entry.warning.remove();
      entry.warning = null;
    }
  };

  const finish = () => {
    clearInterval(interval);
    timer.textContent = '';
    root.dataset.state = state.failed ? 'error' : 'done';
    indicator.innerHTML = state.failed ? ICON_WARN : ICON_CHECK;
    showLabel(activitySummary(state));
  };

  return {
    el: root,
    /** Whether any orchestrator event has arrived (the older JSON service sends none). */
    get empty() { return state.events === 0; },
    /** Add or update the step for one orchestrator event. */
    add(event) {
      if (!state.running) {
        // The stream's own RunError, then the panel's when askRemote throws: only the first counts.
        return;
      }
      state.events += 1;
      if (event.type === 'StepStarted') state.round = event.round;
      if (event.type === 'ToolCallStart') { state.lookups += 1; running.set(event.id, currentActivity(event)); }
      if (event.type === 'ToolCallEnd') running.delete(event.id);
      const step = activityStep(event);
      if (step) place(step, event);

      let current = currentActivity(event);
      if (event.type === 'ToolCallEnd') current = [...running.values()].pop() ?? 'Reading what came back…';
      if (current) { state.current = current; showLabel(current); }

      if (event.type === 'RunFinished' || event.type === 'RunError') {
        state.running = false;
        state.failed = event.type === 'RunError';
        // The service's own clock when it sent one, else ours (the older service reports none).
        state.ms = Number.isFinite(event.ms) && event.ms > 0 ? event.ms : now() - started;
        finish();
      }
    },
  };
}
