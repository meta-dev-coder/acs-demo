/**
 * The activity log of one Ask the Twin answer: what the orchestrator did, in the order it did it.
 *
 * Shown in the chat while the answer is being worked out and kept with the answer afterwards, so an
 * operator can see what the twin looked at, and so we can see where an answer went wrong — a slow
 * model round, a lookup with the wrong filter, a claim that cited nothing.
 *
 * `activityEntry` is pure (event in, line out) so the wording is testable without a browser; the DOM
 * part only places the lines.
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
  if (input.near) parts.push(`within ${input.near.radius_m ?? 1000} m of ${Number(input.near.lat).toFixed(4)}, ${Number(input.near.lon).toFixed(4)}`);
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

/** The one-line summary of a finished log. */
export function activitySummary({ rounds = 0, lookups = 0, ms = null, failed = false, running = false }) {
  if (running) return `Working… ${lookups} lookup${lookups === 1 ? '' : 's'} so far`;
  const parts = [`${lookups} lookup${lookups === 1 ? '' : 's'}`, `${rounds} model round${rounds === 1 ? '' : 's'}`];
  if (ms !== null) parts.push(fmtMs(ms));
  return `${failed ? 'Stopped' : 'Activity'} · ${parts.join(' · ')}`;
}

/**
 * The log element for one answer.
 * @param {{expanded: boolean}} options  whether it stays open after the answer arrives
 */
export function createActivityLog({ expanded = true } = {}) {
  const el = document.createElement('details');
  el.className = 'ask-twin-activity';
  el.open = true;
  const summary = document.createElement('summary');
  const list = document.createElement('ol');
  el.append(summary, list);
  const lines = new Map();
  const state = { rounds: 0, lookups: 0, ms: null, failed: false, running: true };
  const refresh = () => { summary.textContent = activitySummary(state); };
  refresh();

  return {
    el,
    /** Add or update the line for one orchestrator event. */
    add(event) {
      if (event.type === 'ModelRound') state.rounds = Math.max(state.rounds, event.round);
      if (event.type === 'ToolCallStart') state.lookups += 1;
      if (event.type === 'RunFinished') { state.ms = event.ms; state.running = false; state.rounds = event.rounds; }
      if (event.type === 'RunError') { state.failed = true; state.running = false; }
      const entry = activityEntry(event);
      if (entry) {
        let li = lines.get(entry.key);
        if (!li) { li = document.createElement('li'); lines.set(entry.key, li); list.appendChild(li); }
        li.className = `ask-twin-activity-${entry.kind}${entry.status ? ` is-${entry.status}` : ''}`;
        li.textContent = entry.text;
      }
      refresh();
      if (!state.running && !expanded) el.open = false;
    },
  };
}
