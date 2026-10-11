/**
 * The Ask the Twin orchestrator: one question in, a stream of progress events and a checked answer out.
 *
 * It knows nothing about HTTP or AWS — a host adapter feeds it an envelope and forwards its events —
 * and nothing about which model it talks to (see modelProvider.mjs). Its job is the part that must
 * not depend on the model behaving:
 *
 * - the tool loop is bounded (rounds, per-tool deadline, run deadline), and the last round is told
 *   it cannot call tools, so a turn always ends with an answer or a stated error;
 * - every lookup result is labelled (R1, R2 …) and the answer must cite the labels each claim rests
 *   on. Confidence and sources are computed here from what was actually cited and whether those
 *   lookups succeeded — a lookup that ran but does not support the answer earns nothing;
 * - a map action survives only if its coordinates or id came out of a lookup this turn, so text
 *   injected through a feed cannot send the operator's camera somewhere no record points;
 * - everything it does is emitted as an event, so the panel can show the operator (and us) what
 *   happened in the background: the context it used, each model round, each lookup, the checks.
 */
import { randomUUID } from 'node:crypto';
import { parseModelReply } from '../liveDc/askTwin.mjs';
import { screenBlock } from './envelope.mjs';
import { ProviderError } from './modelProvider.mjs';
import { systemPrompt } from './prompt.mjs';

export const DEFAULT_LIMITS = Object.freeze({ maxRounds: 3, toolTimeoutMs: 8_000, runTimeoutMs: 45_000, maxTokens: 2_000 });
const COORD_TOLERANCE = 1e-4;
const ACTION_TYPES = new Set(['fly_to', 'open_camera', 'show_event']);
const MAX_NOTE = 400;

export class RunError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.retryable = retryable; }
}

const statusOf = output => (output?.gap ? 'gap' : output?.error ? 'error' : 'ok');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Whether a lookup result is something an answer can stand on. A successful lookup that found nothing
 * counts — "no closures on I-595 right now" is a fact — because a table that is not loaded comes back
 * as a gap, not as zero rows. Describing the store is metadata, not evidence.
 */
const isEvidence = (name, output) => name !== 'describe_store' && statusOf(output) === 'ok';

/** The model's `basis` as clean claims: `[{claim, refs}]`, refs upper-cased and de-duplicated. */
function claimsOf(basis) {
  if (!Array.isArray(basis)) return [];
  return basis
    .filter(item => typeof item?.claim === 'string' && item.claim.trim())
    .map(item => ({ claim: item.claim.trim().slice(0, 300),
      refs: [...new Set((Array.isArray(item.refs) ? item.refs : []).map(ref => String(ref).trim().toUpperCase()).filter(Boolean))] }));
}

/**
 * Claims read from "(R1)" / "[R1, R2]" in the answer text, one per sentence that cites. Only used when
 * the model wrote prose instead of the JSON basis: the operator saw the refs in the answer, and
 * reporting "no claim rests on a lookup" next to them was wrong (and read as a broken answer).
 */
export function claimsFromText(answer) {
  const sentences = String(answer ?? '').match(/[^.!?]+[.!?]*/g) ?? [];
  const claims = [];
  for (const sentence of sentences) {
    const refs = [...sentence.matchAll(/[([]\s*(R\d+(?:\s*,\s*R\d+)*)\s*[)\]]/gi)].flatMap(m => m[1].split(',').map(r => r.trim().toUpperCase()));
    if (refs.length) claims.push({ claim: sentence.trim().slice(0, 300), refs: [...new Set(refs)] });
  }
  return claims;
}

/**
 * Confidence from the claims the answer makes and the lookups they cite.
 * high   — every claim cites at least one successful lookup, and no data gap was stated
 * medium — some claims are backed by lookups, but others are not, or a gap was stated
 * low    — no claim cites a successful lookup: the answer rests on general knowledge
 *
 * @param {{claim: string, refs: string[]}[]} claims
 * @param {object[]} calls  this turn's lookups, each with `ref`, `status`, `evidence`, `source`
 * @param {string[]} gaps   data the answer says is missing
 */
export function computeConfidence(claims, calls, gaps = []) {
  const byRef = new Map(calls.map(call => [call.ref, call]));
  const backed = claim => claim.refs.length > 0 && claim.refs.every(ref => byRef.get(ref)?.evidence);
  const supported = claims.filter(backed);
  if (!claims.length || !supported.length) {
    const ran = calls.filter(call => call.evidence).length;
    return { level: 'low', reason: ran ? `${plural(ran, 'lookup')} ran, but no claim in the answer rests on them.` : 'No claim in the answer cites twin data.' };
  }
  const unsupported = claims.length - supported.length;
  if (unsupported || gaps.length) {
    const parts = [`${supported.length} of ${plural(claims.length, 'claim')} ${supported.length === 1 ? 'cites' : 'cite'} twin data`];
    if (gaps.length) parts.push(`${plural(gaps.length, 'data gap')} stated`);
    return { level: 'medium', reason: `${parts.join('; ')}.` };
  }
  return { level: 'high', reason: `All ${plural(claims.length, 'claim')} cite twin data.` };
}

/** Every number and short string in the turn's successful lookup outputs. */
function provenance(calls) {
  const numbers = [], strings = new Set();
  const walk = value => {
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
    else if (typeof value === 'string' && value.length <= 120) { strings.add(value); const n = Number(value); if (value.trim() && Number.isFinite(n)) numbers.push(n); }
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const call of calls) if (call.status === 'ok') walk(call.output);
  return { numbers, strings };
}

/** The model's action if a lookup this turn returned its target; otherwise none, with the reason. */
export function checkAction(action, calls) {
  const none = { type: 'none', entity_id: null, coordinates: null };
  if (!action || !ACTION_TYPES.has(action.type)) return { action: none, dropped: null };
  const { numbers, strings } = provenance(calls);
  const near = target => numbers.some(n => Math.abs(n - target) <= COORD_TOLERANCE);
  const coords = action.coordinates;
  const lon = Number(coords?.lon), lat = Number(coords?.lat);
  const hasCoords = Number.isFinite(lon) && Number.isFinite(lat);
  const id = typeof action.entity_id === 'string' && action.entity_id.trim() ? action.entity_id.trim() : null;
  if (!hasCoords) return { action: none, dropped: 'The map action had no coordinates.' };
  if (!near(lon) || !near(lat)) return { action: none, dropped: 'The map action pointed at a location no record returned, so the map was not moved.' };
  if (id && !strings.has(id)) return { action: { type: action.type, entity_id: null, coordinates: { lon, lat } }, dropped: null };
  return { action: { type: action.type, entity_id: id, coordinates: { lon, lat } }, dropped: null };
}

/** The reply contract the client renders, with sources, confidence and action decided here. */
export function finalizeAnswer(rawText, calls) {
  const parsed = parseModelReply(rawText);
  const { action, dropped } = checkAction(parsed.action, calls);
  const structured = claimsOf(parsed.basis);
  const inferred = !structured.length ? claimsFromText(parsed.answer) : [];
  const claims = structured.length ? structured : inferred;
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.filter(g => typeof g === 'string' && g.trim()).slice(0, 5).map(g => g.trim().slice(0, 200)) : [];
  let confidence = computeConfidence(claims, calls, gaps);
  // Citations read from prose are weaker than a basis: never more than medium, and the reason says so.
  if (inferred.length) {
    confidence = { level: confidence.level === 'high' ? 'medium' : confidence.level, reason: `${confidence.reason} Citations were read from the answer text.` };
  }
  const byRef = new Map(calls.map(call => [call.ref, call]));
  const cited = [...new Set(claims.flatMap(claim => claim.refs))].filter(ref => byRef.get(ref)?.evidence);
  const sources = [...new Set(cited.map(ref => byRef.get(ref).source).filter(Boolean))];
  // Playbook recommendations are attached from the cited insight results, word for word: the model
  // may explain a recommendation but never writes one.
  const recommendations = cited.map(ref => byRef.get(ref).output?.recommendation).filter(Boolean);
  const followUps = Array.isArray(parsed.follow_ups)
    ? parsed.follow_ups.filter(q => typeof q === 'string' && q.trim()).slice(0, 3).map(q => q.trim().slice(0, 120)) : [];
  return {
    answer: String(parsed.answer ?? '').trim(),
    action,
    ...(dropped ? { action_note: dropped } : {}),
    confidence: confidence.level,
    confidence_reason: confidence.reason,
    sources: sources.length ? sources : ['Corridor knowledge'],
    basis: claims.map(claim => ({ ...claim, sources: [...new Set(claim.refs.map(ref => byRef.get(ref)?.source).filter(Boolean))] })),
    gaps,
    recommendations,
    follow_ups: followUps,
    ...(inferred.length ? { basis_inferred: true } : {}),
    cited,
    uncited: calls.filter(call => call.evidence && !cited.includes(call.ref)).map(call => call.ref),
  };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Resolves with the tool's result, or a timeout error result after `ms` (the tool's own work is abandoned). */
function withDeadline(promise, ms) {
  let timer;
  const timeout = { error: `Timed out after ${ms / 1000} s.` };
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise(resolve => { timer = setTimeout(() => resolve({ output: timeout, source: null, text: JSON.stringify(timeout), timedOut: true }), ms); }),
  ]);
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const usageOf = usage => Object.fromEntries(USAGE_KEYS.map(key => [key, Number(usage?.[key]) || 0]));
const addUsage = (total, usage) => { for (const key of USAGE_KEYS) total[key] = (total[key] ?? 0) + (Number(usage?.[key]) || 0); return total; };

/** What the turn knew about the operator's screen, for the activity log (ids only, no geometry). */
function contextSummary(envelope) {
  const { screen = {} } = envelope;
  return {
    workspace: screen.workspace ?? null,
    persona: screen.persona ?? null,
    selection: screen.selection ?? null,
    temporal: screen.temporal ?? null,
    hasView: Boolean(screen.view),
    hasArea: Boolean(screen.area),
    historyTurns: envelope.history?.length ?? 0,
  };
}

/**
 * @param {{provider: {name: string, complete: Function}, tools: {definitions: object[], run: Function},
 *   system?: string|((envelope: object) => string), limits?: Partial<typeof DEFAULT_LIMITS>, logger?: Console, now?: () => number,
 *   retryDelayMs?: () => number, prefetch?: (envelope: object) => {name: string, input: object, why: string}[]}} options
 *   `prefetch` names lookups to run before the model is asked — the insight that answers the
 *   question's obvious part — so its results stream at once and save the model a round.
 */
export function createOrchestrator({ provider, tools, system = systemPrompt(), limits = {}, logger = console, now = Date.now,
  retryDelayMs = () => 400 + Math.floor(Math.random() * 400), prefetch = () => [] }) {
  const { maxRounds, toolTimeoutMs, runTimeoutMs, maxTokens } = { ...DEFAULT_LIMITS, ...limits };

  async function complete(request) {
    try {
      return await provider.complete(request);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || request.signal?.aborted) throw error;
      // One retry with jitter for a rate limit or an overloaded model; a second failure is reported.
      await sleep(retryDelayMs(), request.signal);
      return provider.complete(request);
    }
  }

  /**
   * Answer one question.
   *
   * @param {{question: string, history: object[], screen: object}} envelope  already sanitized
   * @param {(event: object) => void} emit  progress events, in order
   * @param {{signal?: AbortSignal}} [options]  aborting (the client went away) stops the model and tools
   * @returns {Promise<object|null>} the answer, or null after a RunError event
   */
  async function run(envelope, emit, { signal } = {}) {
    const runId = randomUUID();
    const started = now();
    const deadline = started + runTimeoutMs;
    const calls = [];
    const usage = {};
    let rounds = 0;
    emit({ type: 'RunStarted', runId });
    emit({ type: 'ContextUsed', ...contextSummary(envelope) });

    /** Run one lookup with a deadline; record it, emit start and end, return its labelled result text. */
    async function lookup(id, name, input, origin) {
      const ref = `R${calls.length + 1}`;
      const call = { id, ref, name, input: input ?? {}, origin, status: 'running', source: null, evidence: false, ms: 0, output: null };
      calls.push(call);
      emit({ type: 'ToolCallStart', id, ref, name, input: call.input, origin });
      const t0 = now();
      const result = await withDeadline(tools.run(name, input), toolTimeoutMs);
      call.status = result.timedOut ? 'timeout' : statusOf(result.output);
      call.source = result.source;
      call.evidence = !result.timedOut && isEvidence(name, result.output);
      call.ms = now() - t0;
      call.output = result.output;
      emit({ type: 'ToolCallEnd', id, ref, name, status: call.status, source: call.source, ms: call.ms, origin,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(call.status === 'ok' ? {} : { detail: result.output?.gap?.detail ?? result.output?.error ?? null }) });
      return { call, text: `ref ${ref}\n${result.text}` };
    }

    try {
      // Lookups the question obviously needs run first, in parallel, and go to the model as data.
      const planned = (signal?.aborted ? [] : prefetch(envelope)) ?? [];
      let prefetched = '';
      if (planned.length) {
        const done = await Promise.all(planned.map((item, i) => {
          emit({ type: 'ModelNote', round: 0, text: item.why ?? `Looking up ${item.name} first.` });
          return lookup(`pre-${i + 1}`, item.name, item.input, 'prefetch');
        }));
        prefetched = `TWIN DATA ALREADY LOOKED UP FOR THIS QUESTION (cite by ref):\n${done.map(d => d.text).join('\n\n')}\n\n`;
      }
      const messages = [...envelope.history, { role: 'user', content: `${screenBlock(envelope.screen)}${prefetched}${envelope.question}` }];
      const turnSystem = typeof system === 'function' ? system(envelope) : system;

      const known = new Set((tools.definitions ?? []).map(d => d.name));
      let text = '';
      for (let round = 1; round <= maxRounds; round++) {
        const remaining = deadline - now();
        if (remaining <= 1_000) throw new RunError('The assistant ran out of time before answering.', { retryable: true });
        const last = round === maxRounds;
        rounds = round;
        emit({ type: 'StepStarted', round, last });
        const t0 = now();
        const response = await complete({
          system: turnSystem, messages, tools: tools.definitions, toolChoice: last ? { type: 'none' } : null, maxTokens,
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(remaining)]),
        });
        addUsage(usage, response.usage);
        const content = Array.isArray(response.content) ? response.content : [];
        const uses = content.filter(block => block?.type === 'tool_use');
        emit({ type: 'ModelRound', round, ms: now() - t0, stop: response.stop_reason ?? null, toolCalls: uses.length, usage: usageOf(response.usage) });
        if (response.stop_reason === 'refusal') throw new RunError('The assistant declined to answer this question.');
        const roundText = content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
        // A model that "calls" a tool the twin does not have (seen: 'none', from action.type) after
        // writing its answer is finishing, not looking something up. Spending a round on the error cost
        // ~4 s, so the text it wrote is taken as the answer.
        const unknownOnly = uses.length > 0 && uses.every(use => !known.has(use.name)) && roundText.trim();
        if (last || response.stop_reason !== 'tool_use' || !uses.length || unknownOnly) {
          text = roundText;
          break;
        }
        // What the model says between lookups is its own account of its plan; it is shown, not trusted.
        const note = content.filter(block => block?.type === 'text').map(block => block.text).join(' ').replace(/\s+/g, ' ').trim();
        if (note) emit({ type: 'ModelNote', round, text: note.slice(0, MAX_NOTE) });
        messages.push({ role: 'assistant', content });
        const results = await Promise.all(uses.map(async use => {
          const { call, text: labelled } = await lookup(use.id, use.name, use.input, 'model');
          return { type: 'tool_result', tool_use_id: use.id, content: labelled, ...(call.status === 'error' || call.status === 'timeout' ? { is_error: true } : {}) };
        }));
        // Every result of one round goes back in a single user turn. Before the last round the model is
        // told it cannot look anything else up, so it writes the JSON instead of prose or another call.
        const finalNudge = round + 1 === maxRounds ? [{ type: 'text', text: 'No more lookups are possible. Reply now with the JSON object only.' }] : [];
        messages.push({ role: 'user', content: [...results, ...finalNudge] });
      }
      const answer = finalizeAnswer(text, calls);
      emit({ type: 'Checks', confidence: answer.confidence, reason: answer.confidence_reason, cited: answer.cited,
        uncited: answer.uncited, gaps: answer.gaps, actionNote: answer.action_note ?? null });
      emit({ type: 'AnswerReady', answer });
      emit({ type: 'RunFinished', runId, ms: now() - started, rounds, usage });
      log({ runId, ok: true, rounds, ms: now() - started, usage, calls });
      return answer;
    } catch (error) {
      const aborted = signal?.aborted;
      const message = aborted ? 'The request was cancelled.'
        : error instanceof RunError || error instanceof ProviderError ? error.message
          : error?.name === 'TimeoutError' ? 'The assistant ran out of time before answering.'
            : 'The assistant could not answer just now.';
      if (!(error instanceof RunError || error instanceof ProviderError) && !aborted) logger.error?.('ask: run failed', error);
      emit({ type: 'RunError', runId, message, retryable: Boolean(error?.retryable || error?.name === 'TimeoutError') });
      log({ runId, ok: false, rounds, ms: now() - started, usage, calls, error: message });
      return null;
    }
  }

  /** One JSON line per turn: what the latency budget and the cost guardrails are measured from. */
  function log({ runId, ok, rounds, ms, usage, calls, error = null }) {
    logger.log?.(JSON.stringify({
      event: 'ask_turn', runId, ok, provider: provider.name, rounds, ms, usage,
      tools: calls.map(({ ref, name, status, ms: toolMs, source, origin }) => ({ ref, name, status, ms: toolMs, source, origin })), ...(error ? { error } : {}),
    }));
  }

  return { run };
}
