/**
 * The CloudFront edge path into Ask the Twin (deploy/ec2/ASK_THE_TWIN.md, section 5.1). GitHub Pages
 * visitors have no demo-host session, so CloudFront adds `x-ask-edge-key` to every origin request on
 * /api/i595/ask*; a request carrying a valid key may ask without the session cookie, and nothing else.
 *
 * The page is anonymous, so the limits here are what bound model spend: per viewer IP (taken from
 * CloudFront-Viewer-Address, trusted only once the key matched) and one global cap.
 */
import { timingSafeEqual, createHash } from 'node:crypto';

export const EDGE_HEADER = 'x-ask-edge-key';
export const EDGE_LIMITS = Object.freeze({ perMinute: 6, perHour: 40, openStreams: 2, globalPerHour: 300 });
const MINUTE = 60_000, HOUR = 3_600_000;

const digest = value => createHash('sha256').update(String(value)).digest();

/**
 * @param {{keys?: string[], limits?: object, now?: () => number}} options  keys: accepted edge keys
 *   (current and previous, for rotation); none = the edge path is off and every request needs a session
 */
export function createEdgeGate({ keys = [], limits = EDGE_LIMITS, now = Date.now } = {}) {
  const accepted = keys.map(k => String(k).trim()).filter(k => k.length >= 16).map(digest);
  const asked = new Map();       // ip -> timestamps of questions in the last hour
  const streams = new Map();     // ip -> open answers
  let global = [];

  const prune = list => list.filter(t => now() - t < HOUR);

  return {
    enabled: accepted.length > 0,

    /** Whether the request carries an accepted edge key (constant-time compare). */
    matches(req) {
      const sent = req.headers?.[EDGE_HEADER];
      if (!accepted.length || typeof sent !== 'string' || !sent) return false;
      const d = digest(sent);
      return accepted.some(k => timingSafeEqual(k, d));
    },

    /** The viewer's IP from CloudFront-Viewer-Address (`ip:port`, IPv6 in brackets or bare). */
    viewerIp(req) {
      const raw = String(req.headers?.['cloudfront-viewer-address'] ?? '').trim();
      if (!raw) return req.socket?.remoteAddress ?? 'unknown';
      const lastColon = raw.lastIndexOf(':');
      return (lastColon > 0 ? raw.slice(0, lastColon) : raw).replace(/^\[|\]$/g, '');
    },

    /**
     * Admit one question from `ip`, or say how long to wait.
     * @returns {{ok: true, release: () => void} | {ok: false, retryAfter: number, reason: string}}
     */
    admit(ip) {
      global = prune(global);
      const mine = prune(asked.get(ip) ?? []);
      const open = streams.get(ip) ?? 0;
      const lastMinute = mine.filter(t => now() - t < MINUTE);
      const wait = (list, span) => Math.max(1, Math.ceil((list[0] + span - now()) / 1000));
      if (global.length >= limits.globalPerHour) return { ok: false, retryAfter: wait(global, HOUR), reason: 'global' };
      if (lastMinute.length >= limits.perMinute) return { ok: false, retryAfter: wait(lastMinute, MINUTE), reason: 'minute' };
      if (mine.length >= limits.perHour) return { ok: false, retryAfter: wait(mine, HOUR), reason: 'hour' };
      if (open >= limits.openStreams) return { ok: false, retryAfter: 5, reason: 'streams' };
      mine.push(now());
      global.push(now());
      asked.set(ip, mine);
      streams.set(ip, open + 1);
      let released = false;
      return { ok: true, release: () => {
        if (released) return;
        released = true;
        const n = (streams.get(ip) ?? 1) - 1;
        if (n > 0) streams.set(ip, n); else streams.delete(ip);
      } };
    },
  };
}

/** Accepted keys from the env: ASK_TWIN_EDGE_KEYS=<key>[,<previous key>]. */
export const edgeKeysFromEnv = env => String(env.ASK_TWIN_EDGE_KEYS ?? '').split(',').map(k => k.trim()).filter(Boolean);
