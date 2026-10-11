/**
 * Model providers for the Ask the Twin orchestrator. Each one takes a request (system, messages,
 * tools) and returns `{content, stop_reason, usage}` in the Messages API shape, so the orchestrator
 * never knows which one it is talking to.
 *
 * - `createAnthropicProvider`: the real model through the official SDK.
 * - `createReplayProvider`: answers from a recordings file, so the tool loop, answer handling and
 *   confidence are testable offline, deterministically and for free.
 * - `createRecordingProvider`: wraps a real provider and saves each response for later replay.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

export class ProviderError extends Error {
  /** @param {string} message @param {{retryable?: boolean, status?: number}} [info] */
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * @param {{apiKey?: string, getApiKey?: () => Promise<string>, model: string, client?: object}} options
 *   `getApiKey` reads the key on the first question (e.g. from Secrets Manager) and again after the
 *   key is rejected; `client` injects a fake in tests.
 */
export function createAnthropicProvider({ apiKey, getApiKey = null, model, client = null }) {
  let sdk = client ?? (apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null);
  let pending = null;
  const sdkFor = async () => {
    if (sdk) return sdk;
    if (!getApiKey) throw new ProviderError('No Anthropic API key is configured.');
    pending ??= Promise.resolve().then(getApiKey).finally(() => { pending = null; });
    let key;
    try { key = await pending; } catch (error) { throw new ProviderError(`The Anthropic key could not be read: ${String(error?.message ?? error).slice(0, 200)}`); }
    sdk = new Anthropic({ apiKey: key, maxRetries: 0 });
    return sdk;
  };
  return {
    name: `anthropic:${model}`,
    model,
    async complete({ system, messages, tools, toolChoice, maxTokens, signal }) {
      const api = await sdkFor();
      try {
        const response = await api.messages.create({
          model,
          max_tokens: maxTokens,
          // The system prompt and the tool list are identical on every question, so they are cached.
          cache_control: { type: 'ephemeral' },
          system,
          messages,
          ...(tools?.length ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
        }, { signal });
        return { content: response.content, stop_reason: response.stop_reason, usage: response.usage ?? null };
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        // Typed SDK errors, most specific first; the message never carries the key or the prompt.
        if (error instanceof Anthropic.RateLimitError) throw new ProviderError('The model is rate limited.', { retryable: true, status: 429 });
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
          // A rotated secret: read it again on the next question.
          if (getApiKey && !client) sdk = null;
          throw new ProviderError('The model rejected the API key.', { status: error.status });
        }
        if (error instanceof Anthropic.BadRequestError) throw new ProviderError(`The model rejected the request: ${String(error.message).slice(0, 200)}`, { status: 400 });
        if (error instanceof Anthropic.APIError && (error.status === 529 || error.status >= 500)) {
          throw new ProviderError('The model is overloaded.', { retryable: true, status: error.status });
        }
        if (error instanceof Anthropic.APIConnectionError) throw new ProviderError('Could not reach the model.', { retryable: true });
        throw new ProviderError(`Model request failed: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    },
  };
}

const SCREEN_BLOCK = /^SCREEN CONTEXT [^\n]*\n[^\n]*\n\n/;

/**
 * The recording key: what the model was asked, not when or with which prompt-cache markers. The
 * screen block is left out too — it carries the camera's view box, which changes with every pan, and
 * a recording should replay whatever the map happens to show.
 */
export function requestKey({ messages, tools }) {
  const asked = (messages ?? []).map(m => (typeof m.content === 'string' ? { ...m, content: m.content.replace(SCREEN_BLOCK, '') } : m));
  const body = JSON.stringify({ messages: asked, tools: (tools ?? []).map(tool => tool.name) });
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

const readRecordings = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, entries: {} });

/** Replays recorded responses; an unrecorded request fails loudly rather than falling through to a live call. */
export function createReplayProvider({ path = null, recordings = null }) {
  const store = recordings ?? readRecordings(path);
  return {
    name: 'replay',
    model: 'replay',
    async complete(request) {
      const key = requestKey(request);
      const hit = store.entries?.[key];
      if (!hit) throw new ProviderError(`No recorded model response for request ${key}. Record it with ASK_TWIN_RECORD=<file> and ANTHROPIC_API_KEY.`);
      return structuredClone(hit);
    },
  };
}

/** Passes every request to `inner` and appends its response to the recordings file. */
export function createRecordingProvider(inner, { path }) {
  return {
    name: `recording(${inner.name})`,
    model: inner.model,
    async complete(request) {
      const response = await inner.complete(request);
      const store = readRecordings(path);
      store.entries[requestKey(request)] = { content: response.content, stop_reason: response.stop_reason, usage: response.usage };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(store, null, 1)}\n`);
      return response;
    },
  };
}
