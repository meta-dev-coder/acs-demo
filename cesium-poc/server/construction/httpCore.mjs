/**
 * The parts of talking to a real external system that have nothing to do with which system it is.
 *
 * Extracted in Phase 8A. Phase 7A proved one live call, Phase 7C added a second service behind the
 * same credential, and Phase 8A adds a second SYSTEM with a different credential and a different
 * content type. Three copies of "read the body, but not an unbounded one" is how the third copy
 * ends up missing the cap the first one has, so the system-agnostic guarantees live here, once:
 *
 *  - a response body is read through a cap and the excess DISCARDED, not truncated-and-parsed.
 *  - a payload is scanned for the credential before it is handed back, as a last line of defence.
 *  - an upstream error body is reduced to a short, safe string, because an upstream body is
 *    untrusted input and an HTML error page pasted into our JSON would be useless and large.
 *  - a host is checked against an explicit allowlist, so a changed environment variable cannot
 *    send a credential somewhere it was not issued for.
 *
 * It knows nothing about SAP, OData, OpenProject or HAL. `sapHttp.mjs` and `openProjectHttp.mjs`
 * supply the auth header, the content type and the response shape; everything above is theirs to
 * use and not theirs to re-derive.
 */

/** A body cap that applies to any upstream. 2 MB is a runaway response, and we stop reading it. */
export const MAX_BYTES = 2_000_000;

/**
 * Whether a payload is free of the credential. Cheap, and the only check that catches an upstream
 * that echoes what we sent it.
 */
export function redacted(payload, secret) {
  if (!secret) return true;
  return !JSON.stringify(payload ?? null).includes(secret);
}

/**
 * Read a response body, refusing to buffer a runaway one.
 *
 * `response.text()` has no limit: a misrouted request answered by something that streams would
 * grow until the process died. The excess is dropped rather than truncated-and-parsed — half a
 * JSON document is not data. A body without a readable stream (a test fixture) falls back to
 * `text()`, which is correct for both.
 */
export async function readCapped(response, { maxBytes = MAX_BYTES, label = 'upstream' } = {}) {
  if (typeof response.body?.getReader !== 'function') return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`The ${label} response exceeded ${maxBytes} bytes and was discarded.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
}

/**
 * An upstream error body, reduced to something safe to show.
 *
 * Reads the shapes the two systems we talk to actually produce — SAP's gateway
 * (`{fault: {faultstring, detail: {errorcode}}}`), the ABAP stack (`{error: {code, message}}`) and
 * OpenProject's API v3 error document (`{errorIdentifier, message}`) — and falls back to stripping
 * tags out of whatever else arrived. Capped, always.
 */
export function upstreamReason(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const body = JSON.parse(raw);
    // OpenProject answers `{_type: 'Error', errorIdentifier, message}` at the top level.
    if (body?.message && (body?.errorIdentifier || body?._type === 'Error')) {
      return [String(body.message), body.errorIdentifier && `(${body.errorIdentifier})`]
        .filter(Boolean).join(' ').slice(0, 200);
    }
    const fault = body?.fault ?? body?.error ?? null;
    const message = fault?.faultstring ?? fault?.message?.value ?? fault?.message ?? null;
    const code = fault?.detail?.errorcode ?? fault?.code ?? null;
    if (message || code) {
      return [message, code && `(${code})`].filter(Boolean).join(' ').slice(0, 200);
    }
  } catch { /* not JSON; fall through */ }
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * A string with the credential taken out of it.
 *
 * Needed because `upstreamReason()` keeps the upstream's own words, and an upstream is free to
 * echo what we sent it — a misconfigured gateway or a verbose error handler can put the credential
 * straight into its 401 body. Keeping the reason is right (a screen that cannot say why is
 * useless) and forwarding the credential inside it is not, so the two are separated here: the
 * words survive, the secret does not.
 *
 * Found by a test that made the upstream echo the token. It is not hypothetical.
 */
export function scrub(text, secret) {
  if (text == null || !secret || String(secret).length < 8) return text;
  return String(text).split(String(secret)).join('[redacted]');
}

/**
 * An origin, checked against an allowlist.
 *
 * An environment variable is not frontend input, but it is the one place a hostname could change,
 * and a typo that pointed a credential at another host would send it there. `https` only: these
 * are bearer-style credentials and there is no development case for sending one in clear.
 */
export function resolveOrigin(raw, { allowedHosts, name, fallback = null }) {
  const text = String(raw ?? '').trim() || fallback || '';
  if (!text) return { ok: false, error: `${name} is not set and has no default.` };
  let url;
  try { url = new URL(text); } catch {
    return { ok: false, error: `${name} is not a URL: ${text}` };
  }
  if (url.protocol !== 'https:') return { ok: false, error: `${name} must be https.` };
  if (!allowedHosts.includes(url.hostname)) {
    return { ok: false,
      error: `Host ${url.hostname} is not allowlisted. Allowed: ${allowedHosts.join(', ')}.` };
  }
  return { ok: true, baseUrl: `${url.protocol}//${url.host}`, host: url.hostname };
}
