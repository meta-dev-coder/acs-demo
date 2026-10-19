/**
 * Talking to the Ask the Twin service: one request, either a stream of progress events or one JSON
 * answer, depending on what the service speaks.
 *
 * The orchestrator (local dev, and EC2 once it is moved over) streams Server-Sent Events: the tools it
 * runs as they run, then the answer. The older Lambda behind the GitHub Pages build answers with one
 * JSON body. Both end as the same answer object, so the panel has one rendering path.
 */

/** Feeds raw SSE text in, calls `onEvent` for each complete `data:` frame; comments (heartbeats) are skipped. */
export function createSseParser(onEvent) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { onEvent(JSON.parse(data)); } catch { /* a malformed frame is dropped, not fatal */ }
    }
  };
}

export class AskError extends Error {}

/**
 * Ask one question.
 *
 * @param {string} url
 * @param {object} body       the request envelope
 * @param {{onEvent?: (event: object) => void, fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<object>} the answer in the reply contract
 * @throws {AskError} with the service's own message when it could not answer
 */
export async function askRemote(url, body, { onEvent = () => {}, fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AskError(data.error ?? 'Something went wrong — please try again.');
    return data;
  }
  let answer = null, failure = null;
  const feed = createSseParser(event => {
    if (event.type === 'AnswerReady') answer = event.answer;
    if (event.type === 'RunError') failure = event;
    onEvent(event);
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
  feed(`${decoder.decode()}\n\n`);
  if (answer) return answer;
  throw new AskError(failure?.message ?? 'The answer stopped before it finished — please try again.');
}

/** What the activity line says while a tool runs. */
export const TOOL_LABELS = Object.freeze({
  describe_store: 'Checking which records the twin holds',
  query_records: 'Reading records',
  count_records: 'Counting records',
  list_live_events: 'Reading live FL511 events',
  find_corridor_features: 'Searching corridor layers',
  records_near: 'Finding records near a place',
  prioritize_sites: 'Ranking sites to fix first',
  get_weather: 'Checking the weather',
  explain_incident: 'Assessing the incident with the TMC risk model',
  rank_incidents: 'Ranking active incidents by risk',
  crash_hotspots: 'Ranking crash hotspots',
  weather_risk_forecast: 'Checking rain forecast against crash history',
});

/** One line of the activity trace for a finished tool call. */
export function traceLine(event) {
  const label = TOOL_LABELS[event.name] ?? event.name;
  const where = event.source ? ` · ${event.source}` : '';
  const status = event.status === 'ok' ? '' : ` — ${event.status}${event.detail ? `: ${event.detail}` : ''}`;
  return `${label}${where} (${event.ms} ms)${status}`;
}
