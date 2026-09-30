/**
 * "Ask the Twin" free-form questions on the EC2 demo host: POST /api/i595/ask, behind the password gate.
 * The same reply contract as infra/lambdas/ask-the-twin, but the live events come from the DataConnect
 * Live Events class (what the demo shows), and the model can call read-only tools (askTools.mjs) over
 * DataConnect, the corridor layers and the data dictionary before it answers. The Anthropic key is read
 * once from Secrets Manager through the instance role and never logged or returned.
 */

export const ASK_PATH = '/api/i595/ask';
export const DEFAULT_ASK_MODEL = 'claude-sonnet-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_QUESTION = 512;
const MAX_BODY = 16 * 1024;
const MAX_EVENTS = 10;
const MAX_TOOL_ROUNDS = 6;
const MAX_TOKENS = 1500;

const ZONE_A = `You are a knowledgeable assistant for the I-595 Digital Twin, a visualization of the I-595 Corridor in Broward County, Florida.

CORRIDOR OVERVIEW:
- I-595 runs east-west through Broward County, connecting I-75 (west) to US-1/Port Everglades (east)
- Total length: ~11 miles (17.7 km)
- The corridor includes: I-595 Express (reversible managed lanes, center), mainline EB/WB lanes, and 9 diverging diamond interchanges
- Express lanes are reversible: inbound (westbound) in the AM peak, outbound (eastbound) in the PM peak
- Major interchanges: I-75/SR-826, University Dr, Nob Hill Rd, Hiatus Rd, Pine Island Rd, SR-7/US-441, Flamingo Rd, 136th Ave, Florida Turnpike, I-95, US-1
- The digital twin shows: FDOT traffic segments (EB/WB), express lanes, CCTV cameras, traffic signals, ramps/connectors, bridge structures, and real-time FL511 incidents

OPERATIONAL CONTEXT:
- Data comes from FDOT (Florida Department of Transportation) and FL511
- CCTV cameras provide live JPEG snapshots from DIVAS (Digital Video Alerting System)
- Live events include: incidents, road closures, congestion alerts, work zones, disabled vehicles
- Live FL511 events are stored in Bentley DataConnect, where each one starts an incident, ticket, work order and inspection chain`;

const TOOL_RULES = `TOOLS: you can read DataConnect, the corridor layers and the weather with the tools. Use them whenever
the question needs records (tickets, work orders, inspections, assets, history, a live event's chain) instead of guessing.
Call describe_data first when you are unsure of a class's attribute names. Filters match exactly (equals) or by substring
(contains). Prefer a few precise calls; never invent ids, counts or dates that no tool returned. If data is missing, say so.`;

const ZONE_C = `OUTPUT RULES: raw JSON only — no markdown, no code fences, no backticks, no preamble, no explanation. Your entire response must be parseable by JSON.parse(). Schema:
{
  "answer": "string — plain English answer, max 4 sentences, with the concrete ids, counts and dates you found",
  "action": {
    "type": "fly_to | open_camera | show_event | none",
    "entity_id": "string or null",
    "coordinates": { "lon": number, "lat": number } or null
  },
  "confidence": "high | medium | low",
  "sources": ["static_knowledge", "live_events", "dataconnect", "corridor_layers", "weather"]  (only the ones you used)
}

ACTION RULES:
- Camera questions → type: "open_camera", coordinates: nearest known camera location on I-595
- Incident/event questions → type: "show_event", entity_id: the event id, coordinates: that event's lon/lat from the live events list
- Location/area questions → type: "fly_to", coordinates of that location
- General questions → type: "none", coordinates: null
- I-595 approximate camera zone coordinates: western end lon=-80.38 lat=26.07, Turnpike lon=-80.254 lat=26.071, I-95 lon=-80.127 lat=26.073, eastern end lon=-80.10 lat=26.073`;

const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** The live-events part of the system prompt, from a /api/i595/live-events?source=dataconnect payload. */
export function liveEventsPrompt(payload) {
  if (!payload) return 'CURRENT LIVE EVENTS (as of query time):\nLive events are unavailable right now (DataConnect could not be read).';
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (!events.length) return 'CURRENT LIVE EVENTS (as of query time):\nNo active events on I-595.';
  const lines = events.slice(0, MAX_EVENTS).map(e => {
    const near = oneLine(e.nearestFacilityLabel || e.nearestSegmentLabel) || 'I-595';
    const at = Number.isFinite(e.longitude) && Number.isFinite(e.latitude) ? ` at lon=${e.longitude} lat=${e.latitude}` : '';
    return `- id=${oneLine(e.id)} [${oneLine(e.type) || 'EVENT'}] near ${near}${at}: ${oneLine(e.description || e.title).slice(0, 300)} (since ${oneLine(e.startTime) || 'unknown'})`;
  });
  const more = events.length > MAX_EVENTS ? `\n(${events.length - MAX_EVENTS} more not listed)` : '';
  return `CURRENT LIVE EVENTS (as of query time):\n${lines.join('\n')}${more}`;
}

export const systemPrompt = (payload, { dataSummary = '', tools = false } = {}) =>
  [ZONE_A, dataSummary, liveEventsPrompt(payload), tools ? TOOL_RULES : '', ZONE_C].filter(Boolean).join('\n\n');

/** The model's text as the reply contract; prose that is not JSON becomes a low-confidence answer. */
export function parseModelReply(rawText) {
  const text = String(rawText ?? '');
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const attempt = candidate => { try { return JSON.parse(candidate); } catch { return null; } };
  let parsed = attempt(stripped);
  if (!parsed) {
    const match = stripped.match(/\{[\s\S]*\}/);
    parsed = match ? attempt(match[0]) : null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.answer !== 'string') {
    return { answer: stripped || text, action: { type: 'none', entity_id: null, coordinates: null }, confidence: 'low', sources: ['static_knowledge'] };
  }
  return parsed;
}

/** At most `limit` questions per `windowMs` per client, so an open tab cannot run up the API bill. */
export function createAskLimiter({ limit = 5000, windowMs = 10 * 60_000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    take(client) {
      const t = now();
      const recent = (hits.get(client) ?? []).filter(at => t - at < windowMs);
      if (recent.length >= limit) { hits.set(client, recent); return false; }
      recent.push(t);
      hits.set(client, recent);
      if (hits.size > 1000) for (const [key, list] of hits) if (!list.some(at => t - at < windowMs)) hits.delete(key);
      return true;
    },
  };
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
    req.on('end', () => {
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{getApiKey:()=>Promise<string>, getLiveEvents:()=>Promise<object|null>, tools?:{definitions:object[],
 *   run:(name:string, input:object)=>Promise<string>}|null, dataSummary?:string, fetchImpl?:typeof fetch, model?:string,
 *   timeoutMs?:number, limiter?:ReturnType<typeof createAskLimiter>, logger?:Console}} options
 */
export function createAskHandler({
  getApiKey, getLiveEvents, tools = null, dataSummary = '', fetchImpl = globalThis.fetch, model = DEFAULT_ASK_MODEL,
  timeoutMs = 90_000, limiter = createAskLimiter(), logger = console,
}) {
  let keyRead = null;
  const apiKey = () => (keyRead ??= Promise.resolve().then(getApiKey).catch(error => { keyRead = null; throw error; }));

  const send = (req, res, status, body) => {
    if (!req.readableEnded) req.resume();
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    if (req.method !== 'POST') return send(req, res, 405, { error: 'Use POST.' });
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY);
    } catch (error) {
      return send(req, res, error.status === 413 ? 413 : 400, { error: error.status === 413 ? 'Request too large.' : 'Invalid JSON body' });
    }
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question) return send(req, res, 400, { error: 'Missing required field: question' });
    if (question.length > MAX_QUESTION) return send(req, res, 400, { error: `question exceeds ${MAX_QUESTION} characters` });
    if (!limiter.take(req.socket?.remoteAddress ?? 'unknown')) {
      return send(req, res, 429, { error: 'Too many questions in a short time. Please wait a few minutes.' });
    }

    let key;
    try {
      key = await apiKey();
    } catch (error) {
      logger.error?.(`ask-the-twin: Anthropic key unavailable: ${error?.message ?? error}`);
      return send(req, res, 503, { error: 'Ask the Twin is not configured on this host right now.' });
    }
    let events = null;
    try { events = await getLiveEvents(); } catch (error) { logger.warn?.(`ask-the-twin: live events unavailable: ${error?.message ?? error}`); }

    const system = systemPrompt(events, { dataSummary, tools: Boolean(tools) });
    const deadline = Date.now() + timeoutMs;
    const messages = [{ role: 'user', content: question }];
    const used = [];
    for (let round = 0; ; round++) {
      const last = !tools || round >= MAX_TOOL_ROUNDS;
      const remaining = deadline - Date.now();
      if (remaining <= 1000) {
        logger.error?.('ask-the-twin: out of time before the model answered');
        return send(req, res, 502, { error: 'The assistant did not answer in time. Please try again.' });
      }
      let response;
      try {
        response = await fetchImpl(ANTHROPIC_URL, {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model, max_tokens: MAX_TOKENS, system, messages,
            ...(tools ? { tools: tools.definitions, ...(last ? { tool_choice: { type: 'none' } } : {}) } : {}),
          }),
          signal: AbortSignal.timeout(remaining),
        });
      } catch (error) {
        logger.error?.(`ask-the-twin: Anthropic request failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message ?? error}`);
        return send(req, res, 502, { error: 'The assistant did not answer in time. Please try again.' });
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) keyRead = null;
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        logger.error?.(`ask-the-twin: Anthropic API ${response.status}${detail ? `: ${detail}` : ''}`);
        return send(req, res, 502, { error: 'The assistant is unavailable right now. Please try again.' });
      }
      const data = await response.json().catch(() => null);
      const content = Array.isArray(data?.content) ? data.content : [];
      const calls = content.filter(block => block?.type === 'tool_use');
      if (!tools || last || data?.stop_reason !== 'tool_use' || !calls.length) {
        const text = content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
        if (used.length) logger.log?.(`ask-the-twin: answered after ${used.length} tool call(s): ${used.join(', ')}`);
        return send(req, res, 200, parseModelReply(text));
      }
      const results = await Promise.all(calls.map(async call => {
        used.push(call.name);
        return { type: 'tool_result', tool_use_id: call.id, content: await tools.run(call.name, call.input) };
      }));
      messages.push({ role: 'assistant', content }, { role: 'user', content: results });
    }
  }

  return { handle };
}

/** The Anthropic key from the secret's JSON {"api_key"} (the format the Lambda reads). */
export function apiKeyFromSecret(secretString, name) {
  let parsed = null;
  try { parsed = JSON.parse(String(secretString ?? '').trim()); } catch { /* reported below without the content */ }
  const key = typeof parsed?.api_key === 'string' ? parsed.api_key.trim() : '';
  if (!key) throw new Error(`secret ${name} must be JSON {"api_key"}`);
  return key;
}
