/**
 * Autodesk Data Management reads: hubs, projects, folders, items and versions, plus the Model
 * Derivative manifest of a version when one exists.
 *
 * Every function returns a sanitized shape built field by field from the JSON:API response, so
 * nothing the upstream adds (links carrying tokens, storage locations, user details) passes
 * through by accident. A request only ever goes to developer.api.autodesk.com: a `links.next`
 * pointing anywhere else is refused rather than followed with the user's token.
 */
import { APS_HOST, ApsError, scrub } from './oauth.mjs';

const BASE = `https://${APS_HOST}`;
const MAX_PAGES = 50;

/** An upstream data-API error, as one of the API's codes. `context` names what was being read. */
export function classifyDataError(status, body, context) {
  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  const detail = scrub(first?.detail ?? first?.title ?? body?.developerMessage ?? body?.reason ?? body?.message ?? '');
  if (status === 401) {
    return new ApsError('TOKEN_EXPIRED', 401, 'The Autodesk access token was rejected.', 'Sign in again at /api/aps/login.');
  }
  if (status === 403 && /scope|privilege|permission to the scope/i.test(detail)) {
    return new ApsError('MISSING_SCOPE', 403, `The token does not carry the scope ${context} needs${detail ? `: ${detail}` : '.'}`,
      'Sign in again so the token is issued with data:read.');
  }
  if (status === 403) {
    return new ApsError(context === 'hubs' || context.startsWith('hub ') ? 'HUB_INACCESSIBLE' : 'FORBIDDEN', 403,
      `Autodesk refused access to ${context}${detail ? `: ${detail}` : '.'}`,
      'In the hub\'s Account Admin, add the client id as a Custom Integration, and sign in as a member of the project.');
  }
  if (status === 404) return new ApsError('NOT_FOUND', 404, `Autodesk could not find ${context}${detail ? `: ${detail}` : '.'}`);
  if (status === 429) return new ApsError('RATE_LIMITED', 429, 'Autodesk rate-limited the request. Try again shortly.');
  return new ApsError('APS_ERROR', 502, `Autodesk answered ${status} for ${context}${detail ? `: ${detail}` : '.'}`);
}

function safeUrl(pathOrUrl) {
  const url = new URL(pathOrUrl, BASE);
  if (url.protocol !== 'https:' || url.host !== APS_HOST) {
    throw new ApsError('APS_ERROR', 502, 'Refused to follow a link outside developer.api.autodesk.com.');
  }
  return url;
}

/**
 * `getToken()` returns a valid access token (refreshing when due); `refresh(rejected)` replaces the
 * token that was just refused. A 401 is retried once with it, which covers a token revoked or
 * expired early.
 */
export function createDataClient({ getToken, refresh, fetchImpl = fetch, timeoutMs = 20000 }) {
  async function once(url, token) {
    try {
      return await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.api+json, application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ApsError('APS_UNREACHABLE', 502, `Could not reach Autodesk: ${scrub(error?.message)}`);
    }
  }
  async function get(pathOrUrl, context) {
    const url = safeUrl(pathOrUrl);
    const token = await getToken();
    let response = await once(url, token);
    if (response.status === 401) response = await once(url, await refresh(token));
    // Rate limited or briefly unavailable: wait as told (Retry-After, at most 10 s) and try again, twice.
    for (let attempt = 0; attempt < 2 && (response.status === 429 || response.status === 503); attempt += 1) {
      const wait = Math.min(Number(response.headers?.get?.('retry-after')) * 1000 || 1500 * (attempt + 1), 10000);
      await new Promise(resolve => setTimeout(resolve, wait));
      response = await once(url, await getToken());
    }
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { reason: text }; }
    if (!response.ok) throw classifyDataError(response.status, body, context);
    return body;
  }
  /** Every page of a JSON:API collection, following `links.next` on the same host. */
  async function getAll(path, context) {
    const data = [], included = [];
    let next = path;
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const body = await get(next, context);
      data.push(...(body.data ?? []));
      included.push(...(body.included ?? []));
      next = body.links?.next?.href ?? (typeof body.links?.next === 'string' ? body.links.next : null);
    }
    return { data, included };
  }
  return { get, getAll };
}

const enc = encodeURIComponent;
const nameOf = entry => entry?.attributes?.displayName ?? entry?.attributes?.name ?? null;

export async function listHubs(client) {
  const { data } = await client.getAll('/project/v1/hubs', 'hubs');
  return data.filter(hub => hub.type === 'hubs').map(hub => ({
    id: hub.id, name: hub.attributes?.name ?? null,
    region: hub.attributes?.region ?? null, type: hub.attributes?.extension?.type ?? null,
  }));
}

export async function listProjects(client, hubId) {
  const { data } = await client.getAll(`/project/v1/hubs/${enc(hubId)}/projects`, `hub ${hubId} projects`);
  return data.filter(project => project.type === 'projects').map(project => ({
    id: project.id, name: project.attributes?.name ?? null, hubId,
    type: project.attributes?.extension?.type ?? null,
    rootFolderId: project.relationships?.rootFolder?.data?.id ?? null,
  }));
}

export async function topFolders(client, hubId, projectId) {
  const { data } = await client.getAll(`/project/v1/hubs/${enc(hubId)}/projects/${enc(projectId)}/topFolders`, 'the project\'s top folders');
  return data.filter(folder => folder.type === 'folders').map(folder => ({ id: folder.id, name: nameOf(folder) }));
}

function versionOf(entry) {
  if (!entry) return null;
  const derivativeUrn = entry.relationships?.derivatives?.data?.id ?? null;
  return {
    id: entry.id,
    versionNumber: entry.attributes?.versionNumber ?? null,
    name: nameOf(entry),
    fileType: entry.attributes?.fileType ?? null,
    storageSize: entry.attributes?.storageSize ?? null,
    createTime: entry.attributes?.createTime ?? null,
    // The uploader's display name only (no user id or e-mail), for the version picker.
    createUserName: entry.attributes?.createUserName ?? null,
    lastModifiedTime: entry.attributes?.lastModifiedTime ?? null,
    derivativeUrn,
  };
}

export async function folderContents(client, projectId, folderId) {
  const { data, included } = await client.getAll(`/data/v1/projects/${enc(projectId)}/folders/${enc(folderId)}/contents`, 'a project folder');
  const versions = new Map(included.filter(entry => entry.type === 'versions').map(entry => [entry.id, entry]));
  return {
    folders: data.filter(entry => entry.type === 'folders').map(entry => ({ id: entry.id, name: nameOf(entry) })),
    items: data.filter(entry => entry.type === 'items').map(entry => {
      const tipId = entry.relationships?.tip?.data?.id ?? null;
      return { id: entry.id, name: nameOf(entry), tipVersionId: tipId, tip: versionOf(versions.get(tipId)), webViewUrl: webViewOf(entry) };
    }),
  };
}

/** ACC's own "open in the browser" link for an item (links.webView), only when it is an Autodesk web address. */
function webViewOf(entry) {
  const href = entry?.links?.webView?.href;
  return typeof href === 'string' && /^https:\/\/([a-z0-9-]+\.)*(autodesk\.com|b360\.autodesk\.com)\//i.test(href) ? href : null;
}

export async function itemVersions(client, projectId, itemId) {
  const { data } = await client.getAll(`/data/v1/projects/${enc(projectId)}/items/${enc(itemId)}/versions`, 'an item\'s versions');
  return data.filter(entry => entry.type === 'versions').map(versionOf);
}

/** The translation status of a derivative. Never fatal: a file is still found without one. */
export async function derivativeManifest(client, urn) {
  try {
    const body = await client.get(`/modelderivative/v2/designdata/${enc(urn)}/manifest`, 'the model derivative manifest');
    return {
      status: body.status ?? null, progress: body.progress ?? null,
      outputs: (body.derivatives ?? []).map(derivative => ({ outputType: derivative.outputType ?? null, status: derivative.status ?? null })),
    };
  } catch (error) {
    if (error.code === 'TOKEN_EXPIRED') throw error;
    return { status: 'unavailable', code: error.code, detail: error.message };
  }
}

/**
 * The named files, searched breadth-first from the top folders. It stops once every name is found,
 * and the folder budget keeps a project with thousands of folders from running for minutes.
 * Matching ignores case. A name found twice is reported twice; the caller can tell them apart by
 * folder path.
 */
export async function findFiles(client, { projectId, folders, fileNames, maxFolders = 300 }) {
  const wanted = new Set(fileNames.map(name => name.toLowerCase()));
  const found = [];
  // ACC lists a dozen system folders (issues, photos, submittals) beside "Project Files", where
  // uploads go; searching it first finds the files in a few requests instead of after the rest.
  const ordered = [...folders].sort((a, b) => Number(b.name === 'Project Files') - Number(a.name === 'Project Files'));
  const queue = ordered.map(folder => ({ ...folder, path: [{ id: folder.id, name: folder.name }] }));
  let searched = 0;
  while (queue.length && searched < maxFolders) {
    const folder = queue.shift();
    searched += 1;
    const contents = await folderContents(client, projectId, folder.id);
    for (const item of contents.items) {
      if (wanted.has(String(item.name ?? '').toLowerCase())) found.push({ ...item, folderId: folder.id, folderPath: folder.path });
    }
    const seen = new Set(found.map(item => String(item.name).toLowerCase()));
    if ([...wanted].every(name => seen.has(name))) return { found, searchedFolders: searched, truncated: false };
    for (const child of contents.folders) queue.push({ ...child, path: [...folder.path, { id: child.id, name: child.name }] });
  }
  return { found, searchedFolders: searched, truncated: queue.length > 0 };
}

/**
 * The hubs, each listing its projects, with the hub holding `projectName` marked. A hub whose
 * projects cannot be read is reported with its error rather than failing the whole call.
 */
export async function discoverHubs(client, projectName) {
  const hubs = await listHubs(client);
  const target = projectName.trim().toLowerCase();
  const result = [];
  for (const hub of hubs) {
    try {
      const projects = await listProjects(client, hub.id);
      const match = projects.find(project => String(project.name ?? '').trim().toLowerCase() === target) ?? null;
      result.push({ ...hub, accessible: true, projectCount: projects.length,
        containsTargetProject: Boolean(match), targetProject: match && { id: match.id, name: match.name } });
    } catch (error) {
      if (error.code === 'TOKEN_EXPIRED' || error.code === 'MISSING_SCOPE') throw error;
      result.push({ ...hub, accessible: false, error: { code: error.code, message: error.message }, containsTargetProject: false, targetProject: null });
    }
  }
  return result;
}

/**
 * A version's file content, downloaded the supported way: the version's storage object
 * (relationships.storage) → OSS `signeds3download` → a short-lived pre-signed URL. The signed URL
 * is fetched WITHOUT the Autodesk token (it is not an Autodesk host and needs none). Server-side
 * only: neither the storage location nor the signed URL is ever returned to the browser.
 */
/**
 * A version's file content as a stream, for passing through to the browser without buffering:
 * the same storage → signeds3download route as downloadVersion. A pre-signed URL lives a few
 * minutes; if S3 refuses it (expired), a fresh one is asked for once.
 */
export async function openVersionStream(client, projectId, versionId, { fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  const version = await client.get(`/data/v1/projects/${enc(projectId)}/versions/${enc(versionId)}`, 'a file version');
  const storage = version.data?.relationships?.storage?.data?.id;
  const match = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storage ?? '');
  if (!match) throw new ApsError('NO_STORAGE', 404, 'The version has no downloadable storage object.');
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const signed = await client.get(`/oss/v2/buckets/${enc(match[1])}/objects/${enc(match[2])}/signeds3download`, 'the file download link');
    if (!signed.url) throw new ApsError('NO_STORAGE', 502, 'Autodesk returned no download link for the file.');
    try { response = await fetchImpl(signed.url, { signal: AbortSignal.timeout(timeoutMs) }); } catch (error) {
      throw new ApsError('DOWNLOAD_FAILED', 502, `The file could not be downloaded: ${scrub(error?.message)}`);
    }
    if (response.ok || ![400, 403].includes(response.status)) break;
  }
  if (!response.ok) throw new ApsError('DOWNLOAD_FAILED', 502, `The file download answered ${response.status}.`);
  return { body: response.body, contentLength: Number(response.headers?.get?.('content-length')) || version.data?.attributes?.storageSize || null,
    fileName: version.data?.attributes?.name ?? null, versionNumber: version.data?.attributes?.versionNumber ?? null };
}

export async function downloadVersion(client, projectId, versionId, { fetchImpl = fetch, maxBytes = 200_000_000, timeoutMs = 120000 } = {}) {
  const version = await client.get(`/data/v1/projects/${enc(projectId)}/versions/${enc(versionId)}`, 'a file version');
  const storage = version.data?.relationships?.storage?.data?.id;
  const match = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storage ?? '');
  if (!match) throw new ApsError('NO_STORAGE', 404, 'The version has no downloadable storage object.');
  const signed = await client.get(`/oss/v2/buckets/${enc(match[1])}/objects/${enc(match[2])}/signeds3download`, 'the file download link');
  if (!signed.url) throw new ApsError('NO_STORAGE', 502, 'Autodesk returned no download link for the file.');
  let response;
  try { response = await fetchImpl(signed.url, { signal: AbortSignal.timeout(timeoutMs) }); } catch (error) {
    throw new ApsError('DOWNLOAD_FAILED', 502, `The file could not be downloaded: ${scrub(error?.message)}`);
  }
  if (!response.ok) throw new ApsError('DOWNLOAD_FAILED', 502, `The file download answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new ApsError('DOWNLOAD_FAILED', 413, `The file is larger than ${maxBytes} bytes.`);
  return { bytes, fileName: version.data?.attributes?.name ?? null, versionNumber: version.data?.attributes?.versionNumber ?? null,
    storageSize: version.data?.attributes?.storageSize ?? null };
}
