/**
 * OPTIONAL natural-language interpretation for Ask the Twin.
 *
 * What this does, and — more importantly — what it is not allowed to do.
 *
 * The deterministic router in `src/ask/intents.js` answers every supported question on its own.
 * This route exists for the questions it does not recognise: it asks a model to map the sentence
 * onto ONE OF THE SAME INTENTS, with the same slots, and returns that. The model never sees the
 * twin's records, never produces a number, a name, a count or a coordinate, and never emits a map
 * action. The client then runs that intent through the same deterministic tools, and the same
 * action validator, as if the router had produced it.
 *
 * So the worst a wrong or hostile model reply can do is choose the wrong intent or an unmatched
 * name, and the deterministic layer answers "I couldn't find that" — it cannot inject a fact.
 * Anything outside the enum is rejected here, before it reaches the browser.
 *
 * With no API key configured the route answers 503 and says so. The assistant keeps working.
 */

/** The only intents a model may choose. Kept in step with src/ask/intents.js. */
export const ALLOWED_INTENTS = Object.freeze([
  'FIND_ASSET', 'ASSET_SUMMARY', 'NEARBY_ROADS', 'NEARBY_BUILDINGS', 'NEARBY_CAMERAS',
  'NEARBY_ASSETS', 'SCENARIO_RESULT', 'SCENARIO_COMPARE', 'SCENARIO_ASSUMPTIONS', 'CLOSURES', 'INCIDENTS', 'CONGESTION', 'CONSTRUCTION', 'SELECTION',
  'SHOW_LAST', 'UNSUPPORTED',
]);

export const ALLOWED_CATEGORIES = Object.freeze([
  'CRUISE_TERMINAL', 'PARKING', 'CARGO_TERMINAL', 'ADMINISTRATION', 'TUNNEL', 'BRIDGE',
]);

const MAX_QUESTION = 400;
const MAX_NAME = 60;
const MAX_RADIUS_M = 5000;
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT = [
  'You classify questions about a PortMiami digital twin into one of a fixed set of intents.',
  'Reply with JSON only: {"intent": <one of the listed intents>, "name": <asset name or null>,',
  '"category": <one of the listed categories or null>, "radiusM": <metres or null>}.',
  'Do not answer the question. Do not invent asset names, counts, coordinates or traffic data —',
  'another system holds the data and will do the lookup. If the question is not about this port’s',
  'infrastructure, roads, buildings, cameras or traffic, reply with intent "UNSUPPORTED".',
  `Intents: ${ALLOWED_INTENTS.join(', ')}.`,
  `Categories: ${ALLOWED_CATEGORIES.join(', ')}.`,
].join(' ');

/**
 * Keep only what the contract allows. Everything else is dropped, silently and by shape.
 * @returns {{ok: true, intent, name, category, radiusM}|{ok: false, reason: string}}
 */
export function sanitizeInterpretation(raw) {
  let value = raw;
  if (typeof value === 'string') {
    // A model that wrapped its JSON in prose or a fence: take the first object, or give up.
    const match = /\{[\s\S]*\}/.exec(value);
    if (!match) return { ok: false, reason: 'The model did not return JSON.' };
    try { value = JSON.parse(match[0]); } catch { return { ok: false, reason: 'The model returned malformed JSON.' }; }
  }
  if (!value || typeof value !== 'object') return { ok: false, reason: 'The model returned no object.' };

  const intent = String(value.intent ?? '').toUpperCase();
  if (!ALLOWED_INTENTS.includes(intent)) {
    return { ok: false, reason: `“${intent || 'nothing'}” is not one of this twin’s intents.` };
  }
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, MAX_NAME) : null;
  const category = ALLOWED_CATEGORIES.includes(String(value.category ?? '').toUpperCase())
    ? String(value.category).toUpperCase() : null;
  const radius = Number(value.radiusM);
  const radiusM = Number.isFinite(radius) && radius > 0 ? Math.min(Math.round(radius), MAX_RADIUS_M) : null;
  return { ok: true, intent, name, category, radiusM };
}

/** Read the key from the environment. Never logged, never sent to the browser. */
export const readApiKey = (env = process.env) =>
  (env.ASK_TWIN_ANTHROPIC_KEY ?? env.ANTHROPIC_API_KEY ?? '').trim() || null;

/** Call Anthropic and return its first text block. Separated so tests can replace it. */
async function callAnthropic({ apiKey, model, question, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: question }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`model request failed (${response.status})`);
    const payload = await response.json();
    return payload?.content?.find(block => block?.type === 'text')?.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Interpret one question.
 *
 * @returns {{status: number, body: object}} ready to send as JSON
 */
export async function interpretQuestion(question, {
  env = process.env, fetchImpl = fetch, call = callAnthropic,
} = {}) {
  const text = String(question ?? '').trim().slice(0, MAX_QUESTION);
  if (!text) return { status: 400, body: { ok: false, reason: 'No question was sent.' } };

  const apiKey = readApiKey(env);
  if (!apiKey) {
    return {
      status: 503,
      body: {
        ok: false,
        reason: 'No model is configured for this twin, so free-form questions are not interpreted. '
          + 'The supported questions are answered without one.',
      },
    };
  }

  const model = (env.ASK_TWIN_MODEL ?? '').trim() || DEFAULT_MODEL;
  try {
    const raw = await call({ apiKey, model, question: text, fetchImpl });
    const result = sanitizeInterpretation(raw);
    return result.ok
      ? { status: 200, body: { ...result, model } }
      : { status: 422, body: { ok: false, reason: result.reason } };
  } catch (error) {
    // Never fall through to a guessed intent: the caller keeps its own deterministic answer.
    return { status: 502, body: { ok: false, reason: `The model could not be reached: ${error.message}` } };
  }
}
