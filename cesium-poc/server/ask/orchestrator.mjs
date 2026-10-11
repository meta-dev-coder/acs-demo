/**
 * The Ask the Twin orchestrator: one question in, a stream of progress events and a checked answer out.
 *
 * It knows nothing about HTTP or AWS — a host adapter feeds it an envelope and forwards its events —
 * and nothing about which model it talks to (see modelProvider.mjs). Its job is the part that must
 * not depend on the model behaving:
 *
 * - the tool loop is bounded (rounds, per-tool deadline, run deadline), and the last round is told
 *   it cannot call tools, so a turn always ends with an answer or a stated error;
 * - where the answer came from (`sources`) and how sure it is (`confidence`) are computed here from
 *   this turn's tool results, never taken from the model's own claim;
 * - a map action survives only if its coordinates or id came out of a tool this turn, so text
 *   injected through a feed cannot send the operator's camera somewhere no record points.
 */
import { randomUUID } from 'node:crypto';
import { parseModelReply } from '../liveDc/askTwin.mjs';
import { screenBlock } from './envelope.mjs';
import { ProviderError } from './modelProvider.mjs';
import { SYSTEM_PROMPT } from './prompt.mjs';

export const DEFAULT_LIMITS = Object.freeze({ maxRounds: 3, toolTimeoutMs: 8_000, runTimeoutMs: 45_000, maxTokens: 2_000 });
const COORD_TOLERANCE = 1e-4;
const ACTION_TYPES = new Set(['fly_to', 'open_camera', 'show_event']);

export class RunError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.retryable = retryable; }
}

const statusOf = output => (output?.gap ? 'gap' : output?.error ? 'error' : 'ok');

/**
 * Whether a tool result is something an answer can stand on. A successful lookup that found nothing
 * counts — "no closures on I-595 right now" is a fact — because a table that is not loaded comes back
 * as a gap, not as zero rows. Describing the store is metadata, not evidence.
 */
const isEvidence = (name, output) => name !== 'describe_store' && statusOf(output) === 'ok';

/**
 * Confidence from this turn's tool results only.
 * high   — at least one tool returned facts and none failed or reported a gap
 * medium — facts came back, but at least one call failed, timed out or hit a gap
 * low    — no tool returned facts: the answer rests on general knowledge
 */
export function computeConfidence(calls) {
  const evidence = calls.filter(call => call.evidence);
  const problems = calls.filter(call => call.status !== 'ok');
  const sources = [...new Set(evidence.map(call => call.source).filter(Boolean))];
  if (!evidence.length) {
    return { level: 'low', reason: problems.length ? `No twin data backed this answer (${problems.length} lookup${problems.length === 1 ? '' : 's'} failed or missing).` : 'No twin data was looked up for this answer.' };
  }
  const basis = `${evidence.length} result${evidence.length === 1 ? '' : 's'} from ${sources.length} source${sources.length === 1 ? '' : 's'}`;
  if (problems.length) return { level: 'medium', reason: `${basis}; ${problems.length} lookup${problems.length === 1 ? '' : 's'} failed or had a data gap.` };
  return { level: 'high', reason: `${basis}, no gaps.` };
}

/** Every number and short string in the turn's successful tool outputs. */
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

/** The model's action if a tool this turn returned its target; otherwise none, with the reason. */
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
  const confidence = computeConfidence(calls);
  const sources = [...new Set(calls.filter(call => call.evidence).map(call => call.source).filter(Boolean))];
  const followUps = Array.isArray(parsed.follow_ups)
    ? parsed.follow_ups.filter(q => typeof q === 'string' && q.trim()).slice(0, 3).map(q => q.trim().slice(0, 120)) : [];
  return {
    answer: String(parsed.answer ?? '').trim(),
    action,
    ...(dropped ? { action_note: dropped } : {}),
    confidence: confidence.level,
    confidence_reason: confidence.reason,
    sources: sources.length ? sources : ['Corridor knowledge'],
    follow_ups: followUps,
  };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Resolves with the tool's result, or a timeout error result after `ms` (the tool's own work is abandoned). */
function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise(resolve => { timer = setTimeout(() => resolve({ output: { error: `Timed out after ${ms / 1000} s.` }, source: null, text: JSON.stringify({ error: `Timed out after ${ms / 1000} s.` }), timedOut: true }), ms); }),
  ]);
}

const addUsage = (total, usage) => {
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    total[key] = (total[key] ?? 0) + (Number(usage?.[key]) || 0);
  }
  return total;
};

/**
 * @param {{provider: {name: string, complete: Function}, tools: {definitions: object[], run: Function},
 *   system?: string, limits?: Partial<typeof DEFAULT_LIMITS>, logger?: Console, now?: () => number,
 *   retryDelayMs?: () => number}} options
 */
export function createOrchestrator({ provider, tools, system = SYSTEM_PROMPT, limits = {}, logger = console, now = Date.now,
  retryDelayMs = () => 400 + Math.floor(Math.random() * 400) }) {
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
    const messages = [...envelope.history, { role: 'user', content: `${screenBlock(envelope.screen)}${envelope.question}` }];
    try {
      let text = '';
      for (let round = 1; round <= maxRounds; round++) {
        const remaining = deadline - now();
        if (remaining <= 1_000) throw new RunError('The assistant ran out of time before answering.', { retryable: true });
        const last = round === maxRounds;
        rounds = round;
        emit({ type: 'StepStarted', round });
        const response = await complete({
          system, messages, tools: tools.definitions, toolChoice: last ? { type: 'none' } : null, maxTokens,
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(remaining)]),
        });
        addUsage(usage, response.usage);
        if (response.stop_reason === 'refusal') throw new RunError('The assistant declined to answer this question.');
        const content = Array.isArray(response.content) ? response.content : [];
        const uses = content.filter(block => block?.type === 'tool_use');
        if (last || response.stop_reason !== 'tool_use' || !uses.length) {
          text = content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
          break;
        }
        messages.push({ role: 'assistant', content });
        const results = await Promise.all(uses.map(async use => {
          emit({ type: 'ToolCallStart', id: use.id, name: use.name, input: use.input ?? {} });
          const t0 = now();
          const result = await withDeadline(tools.run(use.name, use.input), toolTimeoutMs);
          const status = result.timedOut ? 'timeout' : statusOf(result.output);
          const call = { id: use.id, name: use.name, status, source: result.source, evidence: !result.timedOut && isEvidence(use.name, result.output), ms: now() - t0, output: result.output };
          calls.push(call);
          emit({ type: 'ToolCallEnd', id: use.id, name: use.name, status, source: call.source, ms: call.ms,
            ...(status === 'ok' ? {} : { detail: result.output?.gap?.detail ?? result.output?.error ?? null }) });
          return { type: 'tool_result', tool_use_id: use.id, content: result.text, ...(status === 'error' || status === 'timeout' ? { is_error: true } : {}) };
        }));
        // Every result of one round goes back in a single user turn.
        messages.push({ role: 'user', content: results });
      }
      const answer = finalizeAnswer(text, calls);
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
      tools: calls.map(({ name, status, ms: toolMs, source }) => ({ name, status, ms: toolMs, source })), ...(error ? { error } : {}),
    }));
  }

  return { run };
}
