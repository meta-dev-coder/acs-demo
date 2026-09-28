/**
 * "Cloud sync" indicator: what the AWS poller last did with Live DataConnect, read from the
 * non-secret status/live-dc-status.json it writes (served by CloudFront). TEMPORARY while the cloud
 * writer depends on a token handed off from a signed-in machine (`npm run dc:login`).
 */
export const CLOUD_SYNC_STATUS_PATH = '/status/live-dc-status.json';
const TOKEN_REASONS = new Set(['no_token', 'token_expired', 'token_unreadable', 'token_rejected']);
// The poller runs every minute; several missed runs mean it is not running at all.
const SILENT_AFTER_MS = 5 * 60_000;
const REFRESH_MS = 60_000;

/** VITE_LIVE_DC_STATUS_URL, else the status file on the CloudFront origin of VITE_LIVE_EVENTS_API, else none. */
export function liveDcStatusUrl(env = {}) {
  if (env?.VITE_LIVE_DC_STATUS_URL) return env.VITE_LIVE_DC_STATUS_URL;
  try {
    const { origin, protocol } = new URL(env?.VITE_LIVE_EVENTS_API ?? '');
    return protocol === 'https:' || protocol === 'http:' ? `${origin}${CLOUD_SYNC_STATUS_PATH}` : null;
  } catch { return null; }
}

/** @returns {{text: string, warning: boolean, title: string} | null} */
export function cloudSyncNote(status, { now = Date.now() } = {}) {
  const ranAt = Date.parse(status?.lastRunAt ?? '');
  if (!status || typeof status !== 'object' || !Number.isFinite(ranAt)) return null;
  if (now - ranAt > SILENT_AFTER_MS) {
    return { text: 'Cloud sync: not running', warning: true, title: `The cloud poller last ran ${status.lastRunAt}` };
  }
  if (TOKEN_REASONS.has(status.reason)) {
    return { text: 'Cloud sync: needs sign-in', warning: true,
      title: 'The cloud writer has no valid DataConnect token. Run npm run dc:login on the machine with DC_TOKEN_HANDOFF_URL set.' };
  }
  if (status.dcWrite === 'ok') return { text: 'Cloud sync: on', warning: false, title: `Last DataConnect write ${status.lastRunAt}` };
  if (status.dcWrite === 'error') return { text: 'Cloud sync: error', warning: true, title: status.reason || 'DataConnect write failed' };
  return { text: 'Cloud sync: off', warning: false, title: status.reason || 'Cloud sync is not configured' };
}

/** Polls the status file and reports a note (or null) after every read. Returns a stop function. */
export function watchCloudSync({
  url, onChange, fetchImpl = globalThis.fetch, now = Date.now, intervalMs = REFRESH_MS,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
}) {
  if (!url) return () => {};
  const read = async () => {
    let note = null;
    try {
      const response = await fetchImpl(url, { cache: 'no-store' });
      if (response.ok) note = cloudSyncNote(await response.json(), { now: now() });
    } catch { /* an unreachable status file is simply not shown */ }
    onChange(note);
  };
  void read();
  const timer = setIntervalImpl(() => { void read(); }, intervalMs);
  return () => clearIntervalImpl(timer);
}

const listeners = new Set();
let stopShared = null;
let lastNote = null;

/** One shared poll for every strip on the page; it runs only while something is subscribed. */
export function subscribeCloudSync(listener, { url = liveDcStatusUrl(import.meta.env) } = {}) {
  listeners.add(listener);
  listener(lastNote);
  stopShared ??= watchCloudSync({ url, onChange: note => { lastNote = note; for (const fn of listeners) fn(note); } });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stopShared?.(); stopShared = null; }
  };
}
