/**
 * The IFC Model Explorer's view of the existing /api/aps/* routes (server/aps/). It adds no
 * authentication of its own: the server's session cookie carries the sign-in, and the only token
 * the page ever receives is the short-lived viewables:read token for the Autodesk Viewer.
 */
export const APS_BASE = '/api/aps';
export const VIEWER_VERSION = '7.*';
export const VIEWER_SDK = Object.freeze({
  script: `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VERSION}/viewer3D.min.js`,
  style: `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VERSION}/style.min.css`,
});

export class ApsRequestError extends Error {
  constructor(code, status, message, hint, body) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint ?? null;
    this.body = body ?? null;
  }
}

/** Errors that a new sign-in resolves. */
export const needsSignIn = error => ['NOT_AUTHENTICATED', 'TOKEN_EXPIRED', 'MISSING_SCOPE', 'STATE_INVALID'].includes(error?.code);

export function createApsClient({ fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  async function getJson(path) {
    let response;
    try {
      response = await fetchImpl(`${APS_BASE}${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    } catch (error) {
      throw new ApsRequestError('NETWORK', 0, `The app server could not be reached (${error?.message ?? error}).`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApsRequestError(body?.error?.code ?? `HTTP_${response.status}`, response.status,
        body?.error?.message ?? `The server answered ${response.status}.`, body?.error?.hint, body);
    }
    return body;
  }
  return {
    status: () => getJson('/status'),
    /** A FILES_MISSING answer still lists the files that were found, so it is returned, flagged. */
    files: async ({ refresh = false } = {}) => {
      try { return await getJson(`/files${refresh ? '?refresh=1' : ''}`); } catch (error) {
        if (error.code === 'FILES_MISSING' && Array.isArray(error.body?.files)) return { ...error.body, warning: error.message };
        throw error;
      }
    },
    viewerToken: () => getJson('/viewer-token'),
  };
}

/** The sign-in address, coming back to where the user was. */
export const loginUrl = (returnTo = typeof location === 'undefined' ? '/' : `${location.pathname}${location.search}`) =>
  `${APS_BASE}/login?returnTo=${encodeURIComponent(returnTo)}`;

/**
 * What the viewer can show for one file from /api/aps/files, decided from its manifest only. An
 * existing successful derivative is used as it is; nothing here ever asks for a new translation.
 */
export function viewableOf(file) {
  if (!file) return { ok: false, code: 'NO_FILE', message: 'No model is selected.' };
  const urn = file.derivative?.urn;
  if (!urn) return { ok: false, code: 'NO_DERIVATIVE', message: `${file.fileName} has no Model Derivative output.` };
  const manifest = file.derivative.manifest ?? {};
  if (manifest.status !== 'success') {
    return { ok: false, code: 'TRANSLATION_NOT_READY', urn,
      message: `The translation of ${file.fileName} is "${manifest.status ?? 'unknown'}"${manifest.progress ? ` (${manifest.progress})` : ''}${manifest.detail ? `: ${manifest.detail}` : ''}.` };
  }
  const outputs = manifest.outputs ?? [];
  const svf2 = outputs.find(output => output.outputType === 'svf2' && output.status === 'success');
  const svf = outputs.find(output => output.outputType === 'svf' && output.status === 'success');
  if (!svf2 && !svf) return { ok: false, code: 'NO_VIEWABLE', urn, message: `${file.fileName} has no successful SVF or SVF2 output.` };
  // SVF2 streams from the newer environment; classic SVF from the original one.
  return svf2
    ? { ok: true, urn, outputType: 'svf2', env: 'AutodeskProduction2', api: 'streamingV2' }
    : { ok: true, urn, outputType: 'svf', env: 'AutodeskProduction', api: 'derivativeV2' };
}

let sdkLoading = null;
/** The Autodesk Viewer SDK, loaded once, only when the explorer first opens. */
export function loadViewerSdk({ doc = document, timeoutMs = 45000 } = {}) {
  if (globalThis.Autodesk?.Viewing?.GuiViewer3D) return Promise.resolve(globalThis.Autodesk);
  sdkLoading ??= new Promise((resolve, reject) => {
    if (!doc.querySelector(`link[href="${VIEWER_SDK.style}"]`)) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = VIEWER_SDK.style;
      doc.head.append(link);
    }
    const script = doc.createElement('script');
    script.src = VIEWER_SDK.script;
    script.async = true;
    const timer = setTimeout(() => reject(new ApsRequestError('SDK_TIMEOUT', 0, 'The Autodesk Viewer did not load in time.')), timeoutMs);
    script.onload = () => {
      clearTimeout(timer);
      if (globalThis.Autodesk?.Viewing) resolve(globalThis.Autodesk);
      else reject(new ApsRequestError('SDK_FAILED', 0, 'The Autodesk Viewer script loaded without defining Autodesk.Viewing.'));
    };
    script.onerror = () => { clearTimeout(timer); reject(new ApsRequestError('SDK_FAILED', 0, 'The Autodesk Viewer could not be downloaded from developer.api.autodesk.com.')); };
    doc.head.append(script);
  }).catch(error => { sdkLoading = null; throw error; });
  return sdkLoading;
}
