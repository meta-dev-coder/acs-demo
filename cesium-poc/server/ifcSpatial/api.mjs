/**
 * /api/ifc-spatial/*: the IFC Spatial Twin's server side. IFC files come from Autodesk Forma
 * through the existing APS session (server/aps/), are converted once per Autodesk version
 * (convert.mjs) and served from a local cache to the Cesium page.
 *
 *   GET    /api/ifc-spatial/models[?refresh=1]     the project's IFC files and their conversion status (refresh: re-read ACC)
 *   GET    /api/ifc-spatial/versions?file=NAME     every version of one file in ACC (number, dates, uploader, converted or not)
 *   POST   /api/ifc-spatial/prepare?file=NAME[&version=N|ID]   download + convert unless that version (default: the latest) is cached (&force=1 redoes it)
 *   POST   /api/ifc-spatial/compare?file=NAME&base=N&target=N[&tol=M]   element-level differences between two versions (compare.mjs), cached
 *   GET    /api/ifc-spatial/cache/KEY/model.glb    the converted geometry
 *   GET    /api/ifc-spatial/cache/KEY/elements.json   every IfcProduct: GlobalId, class, attributes, property sets, feature id
 *   GET    /api/ifc-spatial/cache/KEY/diagnostics.json
 *   GET    /api/ifc-spatial/documents?file=NAME[&auto=1]   the asset documentation index (ACC Docs PDFs) linked to that model's assets
 *   POST   /api/ifc-spatial/documents/sync?file=NAME       re-read the "Asset Documentation" folder in ACC
 *   GET    /api/ifc-spatial/documents/ID/content[?download=1]  the PDF, streamed from ACC (preview inline or download)
 *   GET    /api/ifc-spatial/documents/analysis?file=NAME&asset=ID[&type=T][&version=N]   what the asset's linked documents say,
 *          read from their contents (docExtract.mjs, docIntel.mjs), with a citation for every finding
 *   GET    /api/ifc-spatial/documents/analysis/fleet?file=NAME   recurring and worsening inspection findings across assets
 *   PUT    /api/ifc-spatial/documents/ID/mapping?file=NAME  link a document to an asset by hand ({assetId}, null to unlink, {automatic:true} to undo)
 *   POST   /api/ifc-spatial/reports?file=NAME      a report job ({request, assets, context}): inspection eligibility over the assets'
 *          ACC documents, then a PDF, an Excel register and an email draft from one snapshot (reports/service.mjs)
 *   GET    /api/ifc-spatial/reports/ID             its progress, summary, files and draft (owner only)
 *   POST   /api/ifc-spatial/reports/ID/cancel      stop it   ·   POST .../retry?type=PDF|XLSX  generate one file again
 *   PUT    /api/ifc-spatial/reports/ID/email       edit or regenerate the draft (the files are not regenerated)
 *   GET    /api/ifc-spatial/reports/ID/artifacts/AID[?download=1]   a generated file   ·   GET .../email.eml   the draft with its attachments
 *   GET    /api/ifc-spatial/reports/ID/snapshot    the structured snapshot the files were generated from
 *   POST   /api/ifc-spatial/area?file=NAME          Select Area: {key, geometry (GeoJSON Polygon, EPSG:4326), placement[, nearM, zones]}
 *          → which of that version's elements lie within, intersect, cross or are outside the area (areaQuery.js),
 *          resolved here from the cached elements through the placement the area was drawn on (never from ids sent by the page)
 *   GET    /api/ifc-spatial/placement?key=KEY      the file's georeferenced placement and any saved calibration
 *   PUT    /api/ifc-spatial/placement?key=KEY      save a calibration for this model version
 *   DELETE /api/ifc-spatial/placement?key=KEY      forget it (back to the file's own georeferencing)
 *
 * Cache: .data/ifc-spatial/<KEY>/ (git-ignored), KEY derived from the Autodesk version id, so a new
 * version converts again and an unchanged one never does. A failed conversion is recorded with its
 * reason and reported as failed; nothing is substituted for it. Every route needs the APS sign-in,
 * because the geometry is the project's data.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApsError } from '../aps/oauth.mjs';
import { Readable } from 'node:stream';
import { downloadVersion, openVersionStream } from '../aps/dataManagement.mjs';
import { assetRegistry, categoryLabel, crawlDocuments, createDocumentIndex, DOCS_FOLDER_NAME, isDocumentId, matchDocuments, parseDocumentName, STATUS as DOC_STATUS } from './documents.mjs';
import { CONVERTER_VERSION, ConversionError, convertIfc } from './convert.mjs';
import { EXTRACTION_PIPELINE, extractPdfText } from './docExtract.mjs';
import { ANALYSIS, ANALYSIS_PIPELINE, analyzeAssetDocuments, normalizeDocument, TREND } from './docIntel.mjs';
import { COMPARE_VERSION, compareVersions, DEFAULT_OPTIONS } from './compare.mjs';
import { modelToGeographic } from './georef.mjs';
import { createReportService } from './reports/service.mjs';
import { AreaError, resolveAreaFor } from './area.mjs';

export const IFC_SPATIAL_BASE = '/api/ifc-spatial';
const KEY = /^[a-f0-9]{24}$/;
const PLACEMENT_MODES = ['IFC_GEOREFERENCED', 'USER_CALIBRATED'];
export const cacheKey = versionId => createHash('sha256').update(String(versionId)).digest('hex').slice(0, 24);

/** A saved placement, checked field by field; anything out of range is refused, not clamped. */
export function validatePlacement(input) {
  const p = input ?? {};
  const problems = [];
  const num = (name, min, max) => {
    const v = Number(p[name]);
    if (!Number.isFinite(v) || v < min || v > max) problems.push(`${name} must be a number between ${min} and ${max}.`);
    return v;
  };
  const placement = {
    mode: PLACEMENT_MODES.includes(p.mode) ? p.mode : (problems.push(`mode must be one of ${PLACEMENT_MODES.join(', ')}.`), null),
    lon: num('lon', -180, 180), lat: num('lat', -90, 90), heightOffset: num('heightOffset', -500, 500),
    headingDeg: num('headingDeg', -360, 360), scale: num('scale', 0.001, 1000),
  };
  if (problems.length) throw new ApsError('INVALID_PLACEMENT', 400, problems.join(' '));
  return placement;
}

const writeAtomic = (path, data) => { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, data); renameSync(temp, path); };

/** How old the document index may be before a page load re-reads ACC (`?auto=1`). */
export const DOCS_STALE_MS = 30 * 60 * 1000;

export function createIfcSpatialApi({ aps, cacheDir = fileURLToPath(new URL('../../.data/ifc-spatial/', import.meta.url)),
  convert = convertIfc, download = downloadVersion, openStream = openVersionStream, docsFolderName = process.env.ACC_DOCS_FOLDER_NAME || DOCS_FOLDER_NAME,
  logger = console, now = Date.now } = {}) {
  const inflight = new Map();
  const placementsPath = join(cacheDir, 'placements.json');
  const dirOf = key => join(cacheDir, key);
  const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  const placements = () => readJson(placementsPath) ?? {};

  /** The cached conversion of a version, if it is complete and from this converter version. */
  function cached(key) {
    const meta = readJson(join(dirOf(key), 'meta.json'));
    if (!meta || meta.converterVersion !== CONVERTER_VERSION) return null;
    if (!['model.glb', 'elements.json', 'diagnostics.json'].every(name => existsSync(join(dirOf(key), name)))) return null;
    return meta;
  }
  const failure = key => readJson(join(dirOf(key), 'error.json'));

  const summary = diagnostics => diagnostics && {
    schema: diagnostics.schema, elements: diagnostics.elements, withGeometry: diagnostics.withGeometry, triangles: diagnostics.triangles,
    glbBytes: diagnostics.glbBytes, sourceBytes: diagnostics.sourceBytes, library: `${diagnostics.library} ${diagnostics.libraryVersion}`,
    placementMode: diagnostics.placement?.mode, crs: diagnostics.placement?.crs ?? null, warnings: diagnostics.warnings?.length ?? 0,
  };

  function manifest(key, meta, { cachedHit }) {
    const diagnostics = readJson(join(dirOf(key), 'diagnostics.json'));
    return {
      key, status: 'ready', cached: cachedHit, fileName: meta.fileName, versionId: meta.versionId, versionNumber: meta.versionNumber,
      sourceSha256: meta.sourceSha256, convertedAt: meta.convertedAt,
      glbUrl: `${IFC_SPATIAL_BASE}/cache/${key}/model.glb`, elementsUrl: `${IFC_SPATIAL_BASE}/cache/${key}/elements.json`,
      diagnosticsUrl: `${IFC_SPATIAL_BASE}/cache/${key}/diagnostics.json`,
      diagnostics: summary(diagnostics), placement: { georeferenced: diagnostics?.placement ?? null, saved: placements()[key]?.placement ?? null },
    };
  }

  async function fileOf(req, fileName) {
    const files = await aps.projectFiles(req);
    const file = files.files.find(entry => entry.fileName === fileName);
    if (!file) throw new ApsError('FILE_NOT_FOUND', 404, `"${fileName}" is not one of the project's IFC files.`);
    return { files, file };
  }

  /**
   * One of the file's own versions, by number or id. A version is accepted only from this file's
   * version list in ACC (one item), so two versions compared are versions of the same file.
   */
  function versionOf(file, wanted) {
    if (wanted === null || wanted === undefined || wanted === '') {
      const tip = file.versions?.find(version => version.id === file.tipVersionId);
      return { id: file.tipVersionId, versionNumber: tip?.versionNumber ?? null, version: tip ?? null };
    }
    const version = (file.versions ?? []).find(entry => entry.id === wanted || String(entry.versionNumber) === String(wanted));
    if (!version) throw new ApsError('VERSION_NOT_FOUND', 404, `Version ${wanted} is not a version of "${file.fileName}" in ACC.`);
    return { id: version.id, versionNumber: version.versionNumber ?? null, version };
  }

  async function versions(req, fileName) {
    const { file } = await fileOf(req, fileName);
    return {
      fileName: file.fileName, itemId: file.itemId, tipVersionId: file.tipVersionId,
      versions: (file.versions ?? []).map(version => {
        const key = cacheKey(version.id);
        return { versionId: version.id, versionNumber: version.versionNumber ?? null, createTime: version.createTime ?? null,
          lastModifiedTime: version.lastModifiedTime ?? null, createUserName: version.createUserName ?? null, storageSize: version.storageSize ?? null,
          latest: version.id === file.tipVersionId, key, status: cached(key) ? 'converted' : failure(key) ? 'failed' : 'not_converted' };
      }).sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0)),
    };
  }

  async function prepare(req, fileName, { force = false, version = null } = {}) {
    const { files, file } = await fileOf(req, fileName);
    const { id: versionId, versionNumber } = versionOf(file, version);
    const key = cacheKey(versionId);
    if (!force) {
      const meta = cached(key);
      if (meta) return manifest(key, meta, { cachedHit: true });
    }
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        const dir = dirOf(key);
        mkdirSync(dir, { recursive: true });
        rmSync(join(dir, 'error.json'), { force: true });
        const started = now();
        try {
          const source = await download(aps.dataClient(req), files.project.id, versionId);
          const sourceSha256 = createHash('sha256').update(source.bytes).digest('hex');
          writeAtomic(join(dir, 'source.ifc'), source.bytes);
          const result = await convert(source.bytes, { sourceFile: fileName, versionId, versionNumber });
          writeAtomic(join(dir, 'model.glb'), result.glb);
          writeAtomic(join(dir, 'elements.json'), JSON.stringify({ fileName, versionId, versionNumber, elements: result.elements, connections: result.connections ?? [] }));
          writeAtomic(join(dir, 'diagnostics.json'), JSON.stringify({ ...result.diagnostics, sourceSha256 }, null, 1));
          const meta = { fileName, versionId, versionNumber, projectId: files.project.id, sourceSha256, converterVersion: CONVERTER_VERSION, convertedAt: new Date(now()).toISOString() };
          writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
          logger.info?.(`ifc-spatial: converted ${fileName} v${versionNumber} (${result.diagnostics.withGeometry}/${result.diagnostics.elements} elements with geometry, ${result.glb.length} bytes) in ${now() - started} ms`);
          return meta;
        } catch (error) {
          const record = { code: error.code ?? 'CONVERSION_FAILED', message: error.message, fileName, versionId, at: new Date(now()).toISOString() };
          writeAtomic(join(dir, 'error.json'), JSON.stringify(record, null, 1));
          rmSync(join(dir, 'meta.json'), { force: true });
          logger.warn?.(`ifc-spatial: ${fileName} v${versionNumber} failed: ${record.code} ${record.message}`);
          throw error;
        }
      })().finally(() => inflight.delete(key)));
    }
    return manifest(key, await inflight.get(key), { cachedHit: false });
  }

  /**
   * Two versions of one file, converted (or taken from the cache) and compared element by element.
   * The result is cached by the two version ids, the tolerance and both algorithm versions.
   */
  async function compare(req, fileName, baseRef, targetRef, { tolerance = DEFAULT_OPTIONS.moveToleranceM } = {}) {
    const { file } = await fileOf(req, fileName);
    const [b, t] = [versionOf(file, baseRef), versionOf(file, targetRef)];
    if (b.id === t.id) throw new ApsError('SAME_VERSION', 400, 'Choose two different versions to compare.');
    if (!(tolerance > 0 && tolerance <= 100)) throw new ApsError('INVALID_TOLERANCE', 400, 'The movement tolerance must be between 0 and 100 m.');
    const id = createHash('sha256').update([file.itemId ?? fileName, b.id, t.id, tolerance, COMPARE_VERSION, CONVERTER_VERSION].join('|')).digest('hex').slice(0, 24);
    const path = join(cacheDir, 'compare', `${id}.json`);
    const [base, target] = [await prepare(req, fileName, { version: b.id }), await prepare(req, fileName, { version: t.id })];
    const hit = readJson(path);
    if (hit) return { ...hit, cached: true, baseManifest: base, targetManifest: target };
    const load = (manifest, ref) => {
      const index = readJson(join(dirOf(manifest.key), 'elements.json'));
      const diagnostics = readJson(join(dirOf(manifest.key), 'diagnostics.json'));
      return { versionNumber: ref.versionNumber, versionId: ref.id, elements: index?.elements ?? [], connections: index?.connections ?? [],
        georeference: diagnostics?.georeference ?? null, lengthUnitScale: diagnostics?.lengthUnitScale ?? 1, createTime: ref.version?.createTime ?? null };
    };
    const [A, B] = [load(base, b), load(target, t)];
    const geo = [A, B].map(v => v.georeference);
    const started = now();
    const result = compareVersions(A, B, {
      moveToleranceM: tolerance,
      toGeographic: (side, [x, y, z]) => {
        if (!geo[side]?.supported) return null;
        const g = modelToGeographic(geo[side], x, y, z);
        return g && { lon: Math.round(g.lon * 1e7) / 1e7, lat: Math.round(g.lat * 1e7) / 1e7, height: Math.round(g.height * 100) / 100 };
      },
    });
    const record = { id, fileName: file.fileName, itemId: file.itemId ?? null, computedAt: new Date(now()).toISOString(), durationMs: now() - started,
      baseVersion: { versionNumber: b.versionNumber, versionId: b.id, createTime: b.version?.createTime ?? null, createUserName: b.version?.createUserName ?? null, key: base.key },
      targetVersion: { versionNumber: t.versionNumber, versionId: t.id, createTime: t.version?.createTime ?? null, createUserName: t.version?.createUserName ?? null, key: target.key },
      ...result };
    mkdirSync(join(cacheDir, 'compare'), { recursive: true });
    writeAtomic(path, JSON.stringify(record));
    logger.info?.(`ifc-spatial: compared ${file.fileName} v${b.versionNumber} → v${t.versionNumber}: ${result.summary.total} changes in ${record.durationMs} ms`);
    return { ...record, cached: false, baseManifest: base, targetManifest: target };
  }

  // ---- asset documentation (documents.mjs) ----

  const docIndexes = new Map();
  const docSyncs = new Map();
  const docIndexOf = projectId => {
    const dir = join(cacheDir, 'documents', createHash('sha256').update(String(projectId)).digest('hex').slice(0, 24));
    if (!docIndexes.has(dir)) docIndexes.set(dir, createDocumentIndex({ dir, now }));
    return docIndexes.get(dir);
  };

  /** The assets documents can link to: from the newest converted version of the model file (or the one asked for). */
  async function registryFor(req, fileName, { versionNumber = null } = {}) {
    if (!fileName) return { registry: [], model: null };
    const { file } = await fileOf(req, fileName);
    const versions = [...(file.versions ?? [])].sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
    for (const version of versionNumber ? [...versions.filter(v => String(v.versionNumber) === String(versionNumber)), ...versions] : versions) {
      const key = cacheKey(version.id);
      if (!cached(key)) continue;
      const index = readJson(join(dirOf(key), 'elements.json'));
      return { registry: assetRegistry(index?.elements ?? []), model: { fileName, versionNumber: version.versionNumber ?? null } };
    }
    return { registry: [], model: { fileName, versionNumber: null, note: 'No converted version of this model yet: documents cannot be linked to its assets.' } };
  }

  /** Read the documentation folder in ACC and merge it into the index (one sync at a time per project). */
  async function syncDocuments(req) {
    const files = await aps.projectFiles(req);
    const projectId = files.project.id;
    const index = docIndexOf(projectId);
    if (!docSyncs.has(projectId)) {
      docSyncs.set(projectId, (async () => {
        const started = now();
        try {
          const crawl = await crawlDocuments(aps.dataClient(req), projectId, files.topFolders ?? [], { folderName: docsFolderName });
          if (!crawl.folder) {
            const error = Object.assign(new Error(`No "${docsFolderName}" folder was found in the ACC project "${files.project.name}".`), { code: 'DOCS_FOLDER_NOT_FOUND' });
            index.recordError(error);
            return { error };
          }
          const { changes } = index.merge(crawl);
          logger.info?.(`ifc-spatial: documents synced, ${crawl.items.length} PDFs in ${crawl.folders} folders (+${changes.added.length} new, ${changes.updated.length} updated, ${changes.missing.length} missing) in ${now() - started} ms`);
          return { changes };
        } catch (error) {
          index.recordError(error);
          logger.warn?.(`ifc-spatial: document sync failed: ${error.code ?? ''} ${error.message}`);
          return { error };
        }
      })().finally(() => docSyncs.delete(projectId)));
    }
    return docSyncs.get(projectId);
  }

  async function documents(req, fileName, { auto = false, sync = false, versionNumber = null } = {}) {
    const files = await aps.projectFiles(req);
    const index = docIndexOf(files.project.id);
    let current = index.load();
    const stale = !current.lastSyncedAt || now() - Date.parse(current.lastSyncedAt) > DOCS_STALE_MS;
    let syncResult = null;
    if (sync || (auto && stale)) { syncResult = await syncDocuments(req); current = index.load(); }
    const { registry, model } = await registryFor(req, fileName, { versionNumber });
    // Names are re-read on every request, so records stored by an earlier parser are linked by today's rules.
    const records = Object.values(current.documents).map(r => ({ ...r, ...parseDocumentName(r.fileName, { atRoot: r.folderPath === '' }) }));
    const mapping = matchDocuments(records, registry, index.mappings());
    const manual = index.mappings();
    const docs = records.map(r => ({ ...r, categoryLabel: categoryLabel(r.category), mapping: { ...mapping[r.documentId], manual: Boolean(manual[r.documentId]) } }))
      .sort((a, b) => String(a.folderPath).localeCompare(String(b.folderPath)) || String(a.fileName).localeCompare(String(b.fileName)));
    const count = status => docs.filter(d => d.mapping.status === status).length;
    const linked = new Set(docs.filter(d => d.mapping.status === DOC_STATUS.MATCHED && d.availability === 'available').map(d => d.mapping.assetId));
    const withoutDocs = registry.filter(r => r.networkId && !linked.has(r.assetId)).map(r => r.assetId);
    return {
      folder: current.folder, lastSyncedAt: current.lastSyncedAt, lastError: current.lastError, lastChanges: current.lastChanges ?? null,
      synced: Boolean(syncResult && !syncResult.error), model,
      summary: { total: docs.length, available: docs.filter(d => d.availability === 'available').length, missing: docs.filter(d => d.availability === 'missing').length,
        matched: count(DOC_STATUS.MATCHED), suggested: count(DOC_STATUS.SUGGESTED), ambiguous: count(DOC_STATUS.AMBIGUOUS), unmatched: count(DOC_STATUS.UNMATCHED),
        reference: count(DOC_STATUS.REFERENCE), assetsWithoutDocuments: withoutDocs.length },
      documents: docs, assetsWithoutDocuments: withoutDocs,
      assets: registry.map(r => ({ assetId: r.assetId, name: r.name, ifcClass: r.ifcClass, globalId: r.globalId })),
    };
  }

  /** A document from the index, by its id; anything else is refused (no object ids from the browser). */
  async function documentRecord(req, documentId) {
    if (!isDocumentId(documentId)) throw new ApsError('INVALID_DOCUMENT', 400, 'Unknown document.');
    const files = await aps.projectFiles(req);
    const record = docIndexOf(files.project.id).load().documents[documentId];
    if (!record) throw new ApsError('DOCUMENT_NOT_FOUND', 404, 'This document is not in the asset documentation index. Sync from ACC first.');
    if (record.availability === 'missing') throw new ApsError('DOCUMENT_MISSING', 404, `"${record.fileName}" was not found in ACC at the last sync (deleted, moved or no access).`);
    return { record, projectId: files.project.id };
  }

  async function sendDocument(req, res, documentId, { attachment }) {
    const { record, projectId } = await documentRecord(req, documentId);
    // Streamed through, with the user's own ACC session: ACC decides whether this user may read it.
    const file = await openStream(aps.dataClient(req), projectId, record.accVersionId);
    const name = String(file.fileName ?? record.fileName ?? 'document.pdf');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
      'content-type': 'application/pdf', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...(file.contentLength ? { 'content-length': String(file.contentLength) } : {}),
    });
    const stream = file.body && typeof file.body.getReader === 'function' ? Readable.fromWeb(file.body) : file.body;
    for await (const chunk of stream ?? []) res.write(chunk);
    res.end();
  }

  // ---- document intelligence: the contents of the PDFs, read on the server ----
  // Extractions are cached per ACC item, version and pipeline: a new version of a document is read again,
  // and the extraction of the version it replaced is deleted. The bytes are never kept, only the text layout.
  const extracting = new Map();
  const analyses = new Map();
  const docStats = { downloads: 0, extractions: 0, cacheHits: 0, accessChecks: 0 };
  const extractDir = projectId => join(docIndexOf(projectId).dir, 'extract');
  const extractKey = record => createHash('sha256').update(`${record.accItemId}|${record.accVersionId}|${EXTRACTION_PIPELINE}`).digest('hex').slice(0, 32);

  async function readAll(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    const body = stream && typeof stream.getReader === 'function' ? Readable.fromWeb(stream) : stream;
    for await (const chunk of body ?? []) {
      total += chunk.length;
      if (total > maxBytes) throw new ApsError('DOCUMENT_TOO_LARGE', 413, `The document is larger than ${Math.round(maxBytes / 1e6)} MB and was not read.`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** The extracted text of one document version: from the cache (after checking this user may read it), else read from ACC. */
  async function extractionOf(req, projectId, record) {
    const dir = extractDir(projectId);
    const key = extractKey(record);
    const path = join(dir, `${key}.json`);
    const client = aps.dataClient(req);
    const hit = readJson(path);
    if (hit?.pipeline === EXTRACTION_PIPELINE && hit.accVersionId === record.accVersionId) {
      // The cache is shared by the project's users: ACC still decides whether this user may read the document.
      docStats.accessChecks += 1;
      await client.get(`/data/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(record.accVersionId)}`, 'a document version');
      docStats.cacheHits += 1;
      return hit;
    }
    if (!extracting.has(path)) {
      extracting.set(path, (async () => {
        let file;
        for (let attempt = 0; ; attempt += 1) {
          try {
            file = await openStream(client, projectId, record.accVersionId);
            docStats.downloads += 1;
            const bytes = await readAll(file.body, 25_000_000);
            const extraction = await extractPdfText(bytes);
            docStats.extractions += 1;
            const entry = { pipeline: EXTRACTION_PIPELINE, documentId: record.documentId, accItemId: record.accItemId, accVersionId: record.accVersionId, versionNumber: record.versionNumber ?? null,
              contentSha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, extractedAt: new Date(now()).toISOString(), extraction };
            mkdirSync(dir, { recursive: true });
            writeAtomic(path, JSON.stringify(entry));
            // The extraction of an earlier version of this document is no longer used.
            const indexPath = join(dir, 'index.json');
            const index = readJson(indexPath) ?? {};
            if (index[record.documentId] && index[record.documentId] !== key) rmSync(join(dir, `${index[record.documentId]}.json`), { force: true });
            index[record.documentId] = key;
            writeAtomic(indexPath, JSON.stringify(index));
            return entry;
          } catch (error) {
            const transient = error?.status >= 500 || ['DOWNLOAD_FAILED', 'APS_UNREACHABLE'].includes(error?.code);
            if (!transient || attempt >= 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 600));
          }
        }
      })().finally(() => extracting.delete(path)));
    }
    return extracting.get(path);
  }

  /** The documents linked to an asset (and a crane's steel, or the crane of its steel), as the Documents tab shows them. */
  const linkedTo = (docs, assetId) => {
    const ids = new Set([assetId, `${assetId}-STRUCT`, String(assetId).replace(/-STRUCT$/, '')]);
    return docs.filter(d => d.mapping?.status === DOC_STATUS.MATCHED && ids.has(d.mapping.assetId));
  };

  async function analyzeAsset(req, fileName, assetId, { type = ANALYSIS.REPLACEMENT_READINESS, versionNumber = null, listing = null } = {}) {
    const files = await aps.projectFiles(req);
    const projectId = files.project.id;
    const index = listing ?? await documents(req, fileName, { versionNumber });
    const asset = index.assets.find(a => a.assetId === assetId) ?? index.assets.find(a => a.assetId.toLowerCase() === String(assetId).toLowerCase());
    if (!asset) throw new ApsError('UNKNOWN_ASSET', 404, `${assetId} is not an asset of ${fileName}${index.model?.versionNumber ? ` v${index.model.versionNumber}` : ''}.`);
    const linked = linkedTo(index.documents, asset.assetId);
    const cacheId = `${projectId}|${fileName}|${index.model?.versionNumber}|${asset.assetId}|${type}|${ANALYSIS_PIPELINE}|${linked.map(d => `${d.documentId}:${d.accVersionId}:${d.availability}`).sort().join(',')}`;
    const docs = [];
    const failures = [];
    // A few documents at a time.
    const queue = [...linked];
    const worker = async () => {
      for (let record = queue.shift(); record; record = queue.shift()) {
        if (record.availability === 'missing') { failures.push({ ...record, code: 'DOCUMENT_MISSING', message: 'Not found in ACC at the last sync (deleted, moved or no access).' }); continue; }
        try {
          const entry = await extractionOf(req, projectId, record);
          docs.push(normalizeDocument(record, entry.extraction, { assetId: asset.assetId }));
        } catch (error) {
          const denied = [401, 403].includes(error?.status) || /forbidden|denied|not authori[sz]ed/i.test(error?.message ?? '');
          failures.push({ ...record, code: denied ? 'ACCESS_DENIED' : error?.code ?? 'READ_FAILED', message: denied ? 'Your ACC account cannot read this document.' : error?.message ?? String(error) });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (!failures.length && analyses.has(cacheId)) return analyses.get(cacheId);
    const element = { id: asset.assetId, name: asset.name, ifcClass: asset.ifcClass, globalId: asset.globalId };
    const result = analyzeAssetDocuments({ asset: element, docs: docs.sort((a, b) => a.fileName.localeCompare(b.fileName)), failures, analysisType: type,
      modelVersion: index.model?.versionNumber ? `${fileName} v${index.model.versionNumber}` : fileName });
    result.generatedAt = new Date(now()).toISOString();
    if (!failures.length) { analyses.set(cacheId, result); if (analyses.size > 200) analyses.delete(analyses.keys().next().value); }
    return result;
  }

  /** Assets whose inspection reports record the same finding more than once, or a worsening one. */
  async function analyzeFleet(req, fileName) {
    const index = await documents(req, fileName);
    const counts = new Map();
    for (const d of index.documents) if (d.mapping?.status === DOC_STATUS.MATCHED && d.availability !== 'missing') counts.set(d.mapping.assetId.replace(/-STRUCT$/, ''), (counts.get(d.mapping.assetId.replace(/-STRUCT$/, '')) ?? 0) + 1);
    // Recurrence needs two reports: assets with fewer than two linked documents cannot show it.
    const candidates = [...counts].filter(([, n]) => n >= 2).map(([id]) => id).filter(id => index.assets.some(a => a.assetId === id));
    const assets = [];
    for (const id of candidates) {
      const a = await analyzeAsset(req, fileName, id, { type: ANALYSIS.CONDITION_TRENDS, listing: index });
      const cmp = a.inspections.comparison;
      const recurring = cmp.findings.filter(f => f.recurring);
      const worsening = [...cmp.findings.filter(f => f.trend === TREND.WORSENING_WITH_EVIDENCE), ...cmp.measurements.filter(m => m.trend === TREND.WORSENING_WITH_EVIDENCE)];
      assets.push({ assetId: id, inspections: a.inspections.count, recurring: recurring.map(f => ({ item: f.item, trend: f.trend, basis: f.basis, citations: f.history.map(h => h.citation) })),
        worsening: worsening.length, condition: cmp.condition, latest: a.inspections.timeline[0] ? { date: a.inspections.timeline[0].inspectionDate, condition: a.inspections.timeline[0].condition } : null,
        unreadable: a.documents.unreadable });
    }
    return { pipeline: ANALYSIS_PIPELINE, model: index.model, checkedAssets: candidates.length, withInspections: assets.filter(a => a.inspections).length,
      assets: assets.filter(a => a.inspections).sort((x, y) => y.recurring.length - x.recurring.length || y.worsening - x.worsening), generatedAt: new Date(now()).toISOString() };
  }

  // ---- reports: one snapshot, then a PDF, an Excel register and an email draft (reports/) ----
  const reports = createReportService({ dir: join(cacheDir, 'reports'), aps, logger, now, policyPath: join(cacheDir, 'inspection-policy.json'),
    listing: (req, fileName) => documents(req, fileName, { auto: true }), analyzeAsset: (req, fileName, assetId, o) => analyzeAsset(req, fileName, assetId, o) });

  /** With `refresh`, the list is read from ACC again (rate-limited per session), so a new version shows up. */
  async function models(req, { refresh = false } = {}) {
    const files = await aps.projectFiles(req, { refresh });
    return {
      project: { id: files.project.id, name: files.project.name }, hub: files.hub, generatedAt: files.generatedAt,
      models: files.files.map(file => {
        const key = cacheKey(file.tipVersionId);
        const meta = cached(key);
        const error = meta ? null : failure(key);
        const version = file.versions?.find(entry => entry.id === file.tipVersionId);
        return {
          fileName: file.fileName, versionId: file.tipVersionId, versionNumber: version?.versionNumber ?? null,
          lastModified: version?.lastModifiedTime ?? null, key,
          status: meta ? 'converted' : error ? 'failed' : 'not_converted', error,
          diagnostics: meta ? summary(readJson(join(dirOf(key), 'diagnostics.json'))) : null,
        };
      }),
    };
  }

  // ---- HTTP ----

  const send = (res, status, payload, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  };
  const sendError = (res, error) => {
    if (error instanceof ConversionError) return send(res, 422, { error: { code: error.code, message: error.message } });
    if (error instanceof ApsError) return send(res, error.status, { error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } });
    logger.error?.(`ifc-spatial: unexpected failure: ${error?.message ?? error}`);
    return send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected server error.' } });
  };
  const readBody = (req, max = 4096) => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', chunk => { size += chunk.length; if (size > max) { reject(new ApsError('BODY_TOO_LARGE', 413, 'The request body is too large.')); req.destroy?.(); } else parts.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new ApsError('INVALID_JSON', 400, 'The body is not JSON.')); } });
    req.on('error', reject);
  });

  // ---- Select Area: membership resolved from this server's elements (areaQuery.js) ----

  const areaCache = new Map(); // selectionId|placement|nearM → result (membership only: no status, which changes)
  function resolveArea(fileName, body) {
    const key = String(body?.key ?? '');
    if (!KEY.test(key)) throw new ApsError('INVALID_AREA', 400, 'Name the model version (key).');
    const meta = cached(key);
    if (!meta) throw new ApsError('NOT_CONVERTED', 404, 'This model version has not been converted.');
    if (meta.fileName !== fileName) throw new ApsError('INVALID_AREA', 400, 'That model version belongs to another file.');
    const placement = validatePlacement(body.placement);
    const cacheKey = JSON.stringify([key, body.geometry, placement, body.nearM ?? null, body.zones ?? null]);
    if (areaCache.has(cacheKey)) return { ...areaCache.get(cacheKey), cached: true };
    let result;
    try {
      result = resolveAreaFor({ elements: readJson(join(dirOf(key), 'elements.json'))?.elements ?? [], georef: readJson(join(dirOf(key), 'diagnostics.json'))?.placement ?? null,
        placement, body, key, fileName, versionNumber: meta.versionNumber ?? null });
    } catch (error) {
      if (error instanceof AreaError) throw new ApsError(error.code, 400, error.message);
      throw error;
    }
    if (areaCache.size > 200) areaCache.delete(areaCache.keys().next().value);
    areaCache.set(cacheKey, result);
    return result;
  }
  /** A report's area: resolved again here; the report covers only the listed assets the server places in it. */
  function scopeReportToArea(fileName, body) {
    const r = resolveArea(fileName, body.area);
    const inside = new Set([...r.within, ...r.intersects, ...r.crosses]);
    const listed = Array.isArray(body.assets) ? body.assets : [];
    body.assets = listed.filter(a => inside.has(a?.id));
    const label = String(body.area.label ?? '').slice(0, 80) || (r.zone ? r.zone : 'Custom selected area');
    return { selectionId: r.selectionId, label, zone: r.zone, versionNumber: r.versionNumber, key: r.key, geometry: r.geometry, areaM2: r.areaM2,
      placementMode: r.placementMode, resolvedAt: r.resolvedAt, listed: listed.length, kept: body.assets.length,
      dropped: listed.filter(a => !inside.has(a?.id)).map(a => String(a?.id ?? '')).slice(0, 200),
      counts: { within: r.within.length, intersects: r.intersects.length, crosses: r.crosses.length, unknown: r.unknown.length } };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== IFC_SPATIAL_BASE && !url.pathname.startsWith(`${IFC_SPATIAL_BASE}/`)) return false;
    try {
      aps.dataClient(req); // signed in, or NOT_AUTHENTICATED / APS_NOT_CONFIGURED
      const path = url.pathname.slice(IFC_SPATIAL_BASE.length);
      const method = req.method;
      if (path === '/models' && method === 'GET') return send(res, 200, await models(req, { refresh: url.searchParams.get('refresh') === '1' })), true;
      const fileName = url.searchParams.get('file');
      const needFile = () => { if (!fileName) throw new ApsError('FILE_REQUIRED', 400, 'Name the file with ?file=.'); return fileName; };
      if (path === '/versions' && method === 'GET') return send(res, 200, await versions(req, needFile())), true;
      if (path === '/prepare' && method === 'POST') {
        return send(res, 200, await prepare(req, needFile(), { force: url.searchParams.get('force') === '1', version: url.searchParams.get('version') })), true;
      }
      if (path === '/compare' && method === 'POST') {
        const [base, target] = [url.searchParams.get('base'), url.searchParams.get('target')];
        if (!base || !target) throw new ApsError('VERSIONS_REQUIRED', 400, 'Name both versions with ?base=&target=.');
        const tol = url.searchParams.get('tol');
        return send(res, 200, await compare(req, needFile(), base, target, { tolerance: tol === null ? DEFAULT_OPTIONS.moveToleranceM : Number(tol) })), true;
      }
      if (path === '/documents' && method === 'GET') return send(res, 200, await documents(req, fileName, { auto: url.searchParams.get('auto') === '1' })), true;
      if (path === '/documents/sync' && method === 'POST') return send(res, 200, await documents(req, fileName, { sync: true })), true;
      if (path === '/documents/analysis' && method === 'GET') {
        const assetId = url.searchParams.get('asset');
        if (!assetId) throw new ApsError('ASSET_REQUIRED', 400, 'Name the asset with ?asset=.');
        const type = url.searchParams.get('type') ?? ANALYSIS.REPLACEMENT_READINESS;
        if (!ANALYSIS[type]) throw new ApsError('UNKNOWN_ANALYSIS', 400, `Unknown analysis type "${type}".`);
        return send(res, 200, await analyzeAsset(req, needFile(), assetId, { type, versionNumber: url.searchParams.get('version') })), true;
      }
      if (path === '/documents/analysis/fleet' && method === 'GET') return send(res, 200, await analyzeFleet(req, needFile())), true;
      const doc = /^\/documents\/([^/]+)\/(content|mapping)$/.exec(path);
      if (doc && doc[2] === 'content' && method === 'GET') return await sendDocument(req, res, doc[1], { attachment: url.searchParams.get('download') === '1' }), true;
      if (doc && doc[2] === 'mapping' && method === 'PUT') {
        const { record, projectId } = await documentRecord(req, doc[1]);
        const body = await readBody(req);
        const index = docIndexOf(projectId);
        if (body.automatic) index.setMapping(record.documentId, undefined);
        else {
          const assetId = body.assetId === null ? null : String(body.assetId ?? '');
          if (assetId !== null) {
            const { registry } = await registryFor(req, needFile());
            if (!registry.some(r => r.assetId === assetId)) throw new ApsError('UNKNOWN_ASSET', 400, `"${assetId}" is not an asset of this model.`);
          }
          index.setMapping(record.documentId, assetId);
        }
        return send(res, 200, await documents(req, fileName)), true;
      }
      const asset = /^\/cache\/([a-f0-9]{24})\/(model\.glb|elements\.json|diagnostics\.json)$/.exec(path);
      if (asset && method === 'GET') {
        if (!cached(asset[1])) throw new ApsError('NOT_CONVERTED', 404, 'This model version has not been converted.');
        const body = readFileSync(join(dirOf(asset[1]), asset[2]));
        return send(res, 200, body, asset[2].endsWith('.glb') ? 'model/gltf-binary' : 'application/json; charset=utf-8'), true;
      }
      if (path === '/area' && method === 'POST') return send(res, 200, resolveArea(needFile(), await readBody(req, 200_000))), true;
      if (path === '/reports' && method === 'POST') {
        const body = await readBody(req, 1_000_000);
        // A report about a selected area: its assets are the ones the server places in the area, not the page's list.
        if (body?.area) body.area = scopeReportToArea(needFile(), body);
        return send(res, 202, await reports.create(req, needFile(), body)), true;
      }
      const rep = /^\/reports\/([^/]+)(?:\/(cancel|retry|email|email\.eml|snapshot|artifacts\/([^/]+)))?$/.exec(path);
      if (rep) {
        const [, id, action, artifactId] = rep;
        if (!action && method === 'GET') return send(res, 200, await reports.get(req, id)), true;
        if (action === 'cancel' && method === 'POST') return send(res, 200, await reports.cancel(req, id)), true;
        if (action === 'retry' && method === 'POST') return send(res, 200, await reports.retry(req, id, url.searchParams.get('type'))), true;
        if (action === 'email' && method === 'PUT') return send(res, 200, await reports.updateEmail(req, id, await readBody(req, 64_000))), true;
        if (action === 'email.eml' && method === 'GET') return await reports.sendEml(req, res, id), true;
        if (action === 'snapshot' && method === 'GET') return send(res, 200, await reports.snapshotOf(req, id)), true;
        if (artifactId && method === 'GET') return await reports.sendArtifact(req, res, id, artifactId, { download: url.searchParams.get('download') === '1' }), true;
      }
      if (path === '/placement') {
        const key = url.searchParams.get('key');
        if (!KEY.test(key ?? '')) throw new ApsError('INVALID_KEY', 400, 'Unknown model key.');
        const meta = cached(key);
        if (!meta) throw new ApsError('NOT_CONVERTED', 404, 'This model version has not been converted.');
        const all = placements();
        if (method === 'GET') {
          return send(res, 200, { key, georeferenced: readJson(join(dirOf(key), 'diagnostics.json'))?.placement ?? null, saved: all[key]?.placement ?? null, savedAt: all[key]?.savedAt ?? null }), true;
        }
        if (method === 'PUT') {
          const placement = validatePlacement(await readBody(req));
          all[key] = { fileName: meta.fileName, versionId: meta.versionId, versionNumber: meta.versionNumber, placement, savedAt: new Date(now()).toISOString() };
          mkdirSync(cacheDir, { recursive: true });
          writeAtomic(placementsPath, JSON.stringify(all, null, 1));
          return send(res, 200, { key, saved: placement, savedAt: all[key].savedAt }), true;
        }
        if (method === 'DELETE') {
          delete all[key];
          mkdirSync(cacheDir, { recursive: true });
          writeAtomic(placementsPath, JSON.stringify(all, null, 1));
          return send(res, 200, { key, saved: null }), true;
        }
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown IFC Spatial route.' } });
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  return { handle, middleware: (req, res, next) => { handle(req, res).then(handled => { if (!handled) next(); }, next); }, documentStats: () => ({ ...docStats }), reportStats: () => reports.stats(),
    /** For server/gmail/: this user's report draft and its files, and the send outcome. Nothing else. */
    reportAccess: { sendContext: reports.sendContext, recordSend: reports.recordSend } };
}
