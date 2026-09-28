/** Timeouts shared by the live-dc pipeline (upstream fetches, snapshot uploads, the poller's cycle deadline). */

/** `promise`, or a rejection with an Error('timeout') (code 'timeout') after `ms`; no deadline unless `ms` > 0. */
export const withDeadline = (promise, ms) => (Number.isFinite(ms) && ms > 0
  ? new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  })
  : promise);

/** fetch with an abort after `timeoutMs` (a ref'd timer, cleared once the body is read by `read`). */
export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, read) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return await read(response);
  } finally {
    clearTimeout(timer);
  }
}
