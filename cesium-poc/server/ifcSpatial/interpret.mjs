/**
 * Seagirt Ask the Twin: reading a question the rules did not understand (POST /api/ifc-spatial/interpret).
 *
 * The browser's rules answer every question they recognise, with no model call. Only when they do not (the
 * network engine's "not understood", or an area question that matched nothing but the generic inventory) does the
 * page send the question here. Claude (a small, fast model: Claude Haiku 5.5 by default) rewrites it into one of the
 * question forms the rules support, naming only assets the page listed. The page checks the rewrite again and asks
 * the rewritten question of the same rules, so every fact in the answer still comes from the twin's own services.
 *
 * Sent to Anthropic: the question, the previous question, the asset ids, types and names of the open model, the ids
 * the conversation refers to and whether an area is selected (its label). Never the IFC model, documents, reports,
 * emails or tokens.
 *
 * Off unless SEAGIRT_ASK_LLM=on. The key is I-595's: ANTHROPIC_API_KEY, or ASK_TWIN_ANTHROPIC_SECRET_NAME (read from
 * AWS Secrets Manager on the first question, never logged). SEAGIRT_ASK_MODEL (default claude-haiku-5-5),
 * SEAGIRT_ASK_EFFORT (default low), SEAGIRT_ASK_DAILY_TOKENS (default 2,000,000 weighted tokens; 0 = no limit).
 * Off, unconfigured, over budget or failing: the page answers exactly as it did before.
 */
import { join } from 'node:path';
import { apiKeyFromSecret, createAskLimiter } from '../liveDc/askTwin.mjs';
import { readSecretString } from '../liveDc/awsSecret.mjs';
import { createAnthropicProvider } from '../ask/modelProvider.mjs';
import { createSpendGuard } from '../ask/spendGuard.mjs';

export const INTERPRET_PATH = '/api/ifc-spatial/interpret';
export const DEFAULT_INTERPRET_MODEL = 'claude-haiku-5-5';
export const DEFAULT_INTERPRET_DAILY_TOKENS = 2_000_000;
export const LIMITS = Object.freeze({ question: 512, rewritten: 300, assets: 800, id: 64, name: 80, refs: 12, body: 96_000 });

/** An asset id as Seagirt writes them (TX-M1, BUS-B, STS-05, AP-03): checked against the listed assets. */
const ID_LIKE = /\b[A-Z]{1,8}\d*(?:-[A-Z0-9]{1,8})+\b/g;

/**
 * The question forms the page's rules answer. Claude rewrites into one of these (filling in real ids and
 * categories); a form outside the list would not be understood by the rules, so it is not offered.
 */
export const QUESTION_FORMS = Object.freeze([
  ['Find and identify', ['Where is <ID>? Highlight it on the map.', 'Show me all <category>.', 'How many <category> are there?', 'What is <ID>?', 'Where are all the electrical substations and switching stations located?']],
  ['Supply and connectivity', ['Which transformer supplies power to <ID>?', 'What supplies <ID>?', 'What does <ID> supply?', 'What equipment is connected downstream of <ID>?',
    'Show the complete electrical connection path from the utility supply to <ID>.', 'Does <ID> supply <ID2>?', 'Is <ID> connected to <ID2>?']],
  ['Outages', ['What happens if <ID> goes offline?', 'Which <category> will lose power if <ID> fails?', 'Why does <ID> have no power?']],
  ['Redundancy', ['Does <ID> have an alternative electrical supply?', 'Which electrical assets have no redundant power supply?', 'Show all cranes that depend on a single transformer.']],
  ['Status', ['Which assets are degraded?', 'Which assets have no power?', 'Show the power status of all <category>.']],
  ['Maintenance (from the inspection documents)', ['For degraded assets, what needs to be fixed?', 'What needs to be fixed on <ID>?', 'Why is <ID> degraded?',
    'What corrective actions are still outstanding for <ID>?', 'Is the condition of <ID> getting worse?', 'Has this defect occurred before on <ID>?',
    'When was <ID> last inspected, and what was its condition?', 'Can <ID> remain in service, and are there operating restrictions?', 'What should we verify before replacing <ID>?',
    'What are the technical specifications of <ID>?', 'Show the documents for <ID>.']],
  ['Selected area (only when an area is selected)', ['What assets are in this area?', 'Which assets in this area are degraded?', 'Where does this area get its power from?',
    'Which assets outside this area depend on it?', 'Is there an alternate supply for this area?', 'What happens if this area loses power?',
    'Which cables cross this area? (construction screening)', 'Show inspection findings for assets in this area.']],
  ['Model versions', ['What changed between V1 and V2?', 'Which <category> were added in V2?']],
  ['Reports and email', ['Generate a maintenance report of these findings.', 'Prepare a report of all <category> and draft an email to the maintenance team.']],
]);

const FORMS_TEXT = QUESTION_FORMS.map(([group, forms]) => `${group}:\n${forms.map(f => `- ${f}`).join('\n')}`).join('\n\n');

/** The system prompt: identical on every question, so it is cached. */
export const SYSTEM_PROMPT = `You read questions for the Seagirt Marine Terminal electrical digital twin (an IFC model of transformers, switchgear, cables, cranes, reefers, lighting and buildings, with inspection documents). You do not answer questions. You rewrite a question the twin's rules did not understand into ONE question in a form the rules do understand, or say it cannot be rewritten.

The forms the rules understand (replace <ID> with an asset id from the asset list, <category> with an asset type in plain words):

${FORMS_TEXT}

Rules:
- People ask about this electrical network in everyday words. Read them as electrical questions: "keeps it going", "runs it", "its juice", "where it gets power" mean its supply; "in trouble", "playing up", "struggling", "not right" mean its status or condition; "if it dies", "if we pull it" mean an outage.
- Keep the person's meaning. Never add a request they did not make; never drop the main one.
- Use only asset ids that appear in the asset list, written exactly as listed. Map names and descriptions ("the main transformer", "crane five") to their ids only when the list makes it unambiguous; otherwise keep the category in words.
- "it", "this", "that one", "these" refer to the conversation context (selected asset, assets from the last answer, previous question).
- Area forms only when an area is selected; "here" or "in this area" then means the selected area.
- If the question asks for something the forms cannot express (prices, weather, people, anything outside the twin), or you are unsure what is meant, set understood to false and leave rewritten empty.
- Reply only through the JSON schema: understood, rewritten (one question, plain English, at most 200 characters), assetIds (the ids your rewrite names), reason (a few words).`;

export const REPLY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    understood: { type: 'boolean' },
    rewritten: { type: 'string' },
    assetIds: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['understood', 'rewritten', 'assetIds', 'reason'],
  additionalProperties: false,
});

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export class InterpretError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}

/** The request body, cleaned: known fields only, every string clipped, the asset list capped. */
export function cleanRequest(body) {
  const question = clip(body?.question, LIMITS.question);
  if (!question) throw new InterpretError('NO_QUESTION', 400, 'Send the question.');
  const assets = (Array.isArray(body?.assets) ? body.assets : []).slice(0, LIMITS.assets)
    .map(a => ({ id: clip(a?.id, LIMITS.id), type: clip(a?.type, 40), name: clip(a?.name, LIMITS.name) }))
    .filter(a => a.id);
  const c = body?.context ?? {};
  const ids = list => (Array.isArray(list) ? list : []).map(x => clip(x, LIMITS.id)).filter(Boolean).slice(0, LIMITS.refs);
  return {
    question, assets,
    context: {
      previousQuestion: clip(c.previousQuestion, LIMITS.question) || null,
      lastAssets: ids(c.lastAssets),
      selectedAssetId: clip(c.selectedAssetId, LIMITS.id) || null,
      area: c.area?.selected ? { selected: true, label: clip(c.area.label, 80) || 'Selected area' } : { selected: false },
    },
  };
}

/** The user message: the context, the asset list and the question (the volatile part, after the cached system prompt). */
export function userMessage({ question, assets, context }) {
  const lines = [
    `Area selected: ${context.area.selected ? `yes (${context.area.label})` : 'no'}`,
    `Selected asset: ${context.selectedAssetId ?? 'none'}`,
    `Assets from the last answer: ${context.lastAssets.length ? context.lastAssets.join(', ') : 'none'}`,
    `Previous question: ${context.previousQuestion ?? 'none'}`,
    '',
    'Asset list (id | type | name):',
    ...assets.map(a => `${a.id} | ${a.type || '-'} | ${a.name && a.name !== a.id ? a.name : '-'}`),
    '',
    `Question: ${question}`,
  ];
  return lines.join('\n');
}

/**
 * The model's reply checked against the request: a rewrite that names an asset the page did not list, repeats the
 * question, or is empty is not used.
 */
export function checkReply(reply, { question, assets }) {
  const no = reason => ({ understood: false, rewritten: '', assetIds: [], reason });
  if (!reply || typeof reply !== 'object') return no('no reply');
  const rewritten = clip(reply.rewritten, LIMITS.rewritten);
  if (!reply.understood || !rewritten) return no(clip(reply.reason, 120) || 'not understood');
  if (rewritten.toLowerCase() === question.toLowerCase()) return no('same as the question');
  const known = new Set(assets.map(a => a.id));
  const named = Array.isArray(reply.assetIds) ? reply.assetIds.map(x => clip(x, LIMITS.id)).filter(Boolean) : [];
  const mentioned = rewritten.match(ID_LIKE) ?? [];
  const unknown = [...named, ...mentioned].filter(id => !known.has(id));
  if (unknown.length) return no(`unknown asset ${unknown[0]}`);
  return { understood: true, rewritten, assetIds: [...new Set([...named, ...mentioned])], reason: clip(reply.reason, 120) };
}

function textOf(content) {
  return (Array.isArray(content) ? content : []).filter(b => b?.type === 'text').map(b => b.text).join('').trim();
}

/** The provider the environment configures (I-595's key), or null with the reason. */
export function interpretProviderFromEnv(env, { readSecret = readSecretString, make = createAnthropicProvider } = {}) {
  if (!/^(on|true|1|yes)$/i.test(String(env.SEAGIRT_ASK_LLM ?? '').trim())) return { provider: null, reason: 'off (SEAGIRT_ASK_LLM is not on)' };
  const apiKey = String(env.ANTHROPIC_API_KEY ?? '').trim();
  const secretName = String(env.ASK_TWIN_ANTHROPIC_SECRET_NAME ?? '').trim();
  if (!apiKey && !secretName) return { provider: null, reason: 'off (no key: set ANTHROPIC_API_KEY or ASK_TWIN_ANTHROPIC_SECRET_NAME)' };
  const model = String(env.SEAGIRT_ASK_MODEL ?? '').trim() || DEFAULT_INTERPRET_MODEL;
  const effort = String(env.SEAGIRT_ASK_EFFORT ?? 'low').trim() || null;
  const region = String(env.LIVE_DC_AWS_REGION ?? '').trim() || undefined;
  const getApiKey = async () => apiKeyFromSecret(await readSecret(secretName, { region, policyHint: 'allow secretsmanager:GetSecretValue on it' }), secretName);
  const provider = apiKey ? make({ apiKey, model, effort }) : make({ model, effort, getApiKey });
  return { provider, reason: `${model}${effort ? `, effort ${effort}` : ''}${apiKey ? '' : ` (key from secret ${secretName})`}` };
}

/**
 * @param {{env?: object, logger?: Console, provider?: object|null, stateDir?: string|null, spend?: object|null,
 *   limiter?: object, clientKey?: (req) => string, now?: () => number, timeoutMs?: number}} [options]
 *   `provider` and `spend` are injected in tests; otherwise both come from the environment.
 */
export function createInterpretApi({ env = process.env, logger = console, provider: injected, stateDir = null, spend = null, limiter = null,
  clientKey = req => req.askClient || req.headers?.cookie || req.socket?.remoteAddress || 'local', now = Date.now, timeoutMs = 15_000 } = {}) {
  const fromEnv = injected === undefined ? interpretProviderFromEnv(env) : { provider: injected, reason: injected ? (injected.name ?? 'injected') : 'off' };
  const provider = fromEnv.provider;
  const budget = Number.isFinite(Number(env.SEAGIRT_ASK_DAILY_TOKENS)) && String(env.SEAGIRT_ASK_DAILY_TOKENS ?? '').trim() !== ''
    ? Math.max(0, Number(env.SEAGIRT_ASK_DAILY_TOKENS)) : DEFAULT_INTERPRET_DAILY_TOKENS;
  const guard = spend ?? createSpendGuard({ dailyTokens: budget, statePath: stateDir ? join(stateDir, 'interpret-spend.json') : null, logger, now });
  const limit = limiter ?? createAskLimiter({ limit: 30, windowMs: 60_000, now });
  const stats = { asked: 0, understood: 0, failed: 0 };

  const send = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', chunk => { size += chunk.length; if (size <= LIMITS.body) parts.push(chunk); });
    req.on('end', () => {
      if (size > LIMITS.body) return reject(new InterpretError('BODY_TOO_LARGE', 413, 'The request body is too large.'));
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new InterpretError('INVALID_JSON', 400, 'The body is not JSON.')); }
    });
    req.on('error', reject);
  });

  async function interpret(request, { signal } = {}) {
    const started = now();
    stats.asked += 1;
    const response = await provider.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage(request) }],
      maxTokens: 4000, format: REPLY_SCHEMA, signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    guard.record?.(response.usage ?? {});
    let reply = null;
    if (response.stop_reason !== 'refusal' && response.stop_reason !== 'max_tokens') {
      try { reply = JSON.parse(textOf(response.content)); } catch { reply = null; }
    }
    const checked = checkReply(reply, request);
    if (checked.understood) stats.understood += 1;
    const u = response.usage ?? {};
    // One line per question: no question text, no key.
    logger.log?.(JSON.stringify({ event: 'seagirt_interpret', model: provider.model ?? null, ms: now() - started, understood: checked.understood,
      stop: response.stop_reason ?? null, in: u.input_tokens ?? null, cached: u.cache_read_input_tokens ?? null, out: u.output_tokens ?? null }));
    return checked;
  }

  async function handle(req, res) {
    const path = String(req.url ?? '').split('?')[0];
    if (path !== INTERPRET_PATH && path !== `${INTERPRET_PATH}/status`) return false;
    if (path.endsWith('/status')) {
      if (req.method !== 'GET') return send(res, 405, { error: { code: 'METHOD', message: 'GET only.' } }), true;
      return send(res, 200, { enabled: Boolean(provider), model: provider?.model ?? null, usage: guard.status?.() ?? null }), true;
    }
    if (req.method !== 'POST') { req.resume(); return send(res, 405, { error: { code: 'METHOD', message: 'POST only.' } }), true; }
    if (!provider) { req.resume(); return send(res, 503, { error: { code: 'OFF', message: `Question reading by Claude is ${fromEnv.reason}.` } }), true; }
    try {
      const request = cleanRequest(await readBody(req));
      const blocked = guard.blocked?.();
      if (blocked) return send(res, 429, { error: { code: 'BUDGET', message: blocked } }), true;
      if (!limit.take(clientKey(req))) return send(res, 429, { error: { code: 'RATE', message: 'Too many questions in a minute; try again shortly.' } }), true;
      const result = await interpret(request);
      return send(res, 200, { ...result, model: provider.model ?? null }), true;
    } catch (error) {
      if (error instanceof InterpretError) return send(res, error.status, { error: { code: error.code, message: error.message } }), true;
      stats.failed += 1;
      logger.warn?.(`seagirt interpret: ${String(error?.message ?? error).slice(0, 200)}`);
      // The page falls back to the rules' own answer.
      return send(res, 502, { error: { code: 'MODEL', message: 'The question could not be read by the model.' } }), true;
    }
  }

  return {
    handle,
    middleware: (req, res, next) => { handle(req, res).then(done => { if (!done) next(); }, next); },
    enabled: Boolean(provider), label: fromEnv.reason, stats: () => ({ ...stats, usage: guard.status?.() ?? null }),
  };
}
