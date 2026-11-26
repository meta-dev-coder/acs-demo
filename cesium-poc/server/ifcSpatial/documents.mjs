/**
 * Asset documentation from ACC Docs: the PDFs in the project's "Asset Documentation" folder, indexed
 * on the server and linked to the IFC model's assets.
 *
 *  - Discovery (crawlDocuments): the folder is found under the project's top folders by name, then
 *    walked recursively (every page of every folder); each PDF keeps its ACC item id (stable across
 *    versions), its tip version id, its category folder and ACC's own web link.
 *  - Index (createDocumentIndex): one JSON per project on disk. A sync merges: new items are added,
 *    a new tip version updates the record (the document id, from the item id, does not change, so
 *    its mapping stays), a renamed file is re-read, and an item no longer seen is marked missing,
 *    never deleted. Manual mappings live in their own file and are never overwritten by a sync.
 *  - Matching (matchDocuments): a document's asset code is its file name before the first "_"
 *    ("USS-7_Substation.pdf" → USS-7; "TX-M2_Transformer_Inspection-2024-001_2024-03-14.pdf" → TX-M2,
 *    so every document named after an asset is linked to it). Asset ids never contain "_". Matched, in order: a manual mapping; a unique exact
 *    NetworkID or IFC Tag; the same, case-insensitive; with the document type choosing between
 *    two candidates (a crane's intake vs its steel). Never by substring (L6 is not L6e) or by place.
 *    A code with no candidate but a parent asset (R1-RACK9 → R1) is a suggestion to confirm.
 *    The register at the folder's root is a reference document and is linked to nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderContents } from '../aps/dataManagement.mjs';

export const DOCS_FOLDER_NAME = 'Asset Documentation';
export const STATUS = Object.freeze({ MATCHED: 'matched', SUGGESTED: 'suggested', AMBIGUOUS: 'ambiguous', UNMATCHED: 'unmatched', REFERENCE: 'reference' });
export const documentIdOf = itemId => createHash('sha256').update(String(itemId)).digest('hex').slice(0, 24);
const DOC_ID = /^[a-f0-9]{24}$/;
export const isDocumentId = id => DOC_ID.test(String(id ?? ''));

const SPATIAL = /^Ifc(Project|Site|Building|BuildingStorey|Space|SpatialZone|DistributionPort|Port|Annotation|Grid)$/;

/**
 * "USS-7_Substation.pdf" → {assetCode: 'USS-7', docType: 'Substation'}; further "_" segments are the
 * document's title and date: "TX-M2_Transformer_Inspection-2024-001_2024-03-14.pdf" → {assetCode: 'TX-M2',
 * docType: 'Transformer', title: 'Inspection 2024-001', docDate: '2024-03-14'}. A file at the folder's root is a reference.
 */
export function parseDocumentName(fileName, { atRoot = false } = {}) {
  const base = String(fileName ?? '').replace(/\.pdf$/i, '').trim();
  if (atRoot) return { assetCode: null, docType: 'Reference', reference: true };
  const [code, type, ...rest] = base.split('_').map(part => part.trim());
  if (!code || type === undefined) return { assetCode: code || null, docType: null, reference: false };
  const parsed = { assetCode: code, docType: type.replace(/-/g, ' ').trim() || null, reference: false };
  const date = rest.findLast(part => /^\d{4}-\d{2}-\d{2}$/.test(part));
  const title = rest.filter(part => part && part !== date).map(part => part.replace(/-(?!\d)/g, ' ').replace(/(?<=[A-Za-z])-(?=\d)/g, ' ')).join(' ');
  if (title) parsed.title = title;
  if (date) parsed.docDate = date;
  return parsed;
}

/** A category folder name for people: "04_Cranes_and_vaults" → "Cranes and vaults". */
export const categoryLabel = folder => String(folder ?? '').replace(/^\d+_/, '').replace(/_/g, ' ');

/**
 * Find the documentation folder (by name, within the top folders, three levels down at most) and
 * list every PDF under it, recursively.
 */
export async function crawlDocuments(client, projectId, topFolders, { folderName = DOCS_FOLDER_NAME, maxFolders = 400 } = {}) {
  const wanted = folderName.toLowerCase();
  let root = null;
  const queue = topFolders.map(f => ({ ...f, path: f.name, depth: 0 }));
  let visited = 0;
  while (queue.length && !root && visited < maxFolders) {
    const folder = queue.shift();
    visited += 1;
    if (String(folder.name).toLowerCase() === wanted) { root = folder; break; }
    if (folder.depth >= 3) continue;
    const contents = await folderContents(client, projectId, folder.id);
    for (const sub of contents.folders) {
      if (String(sub.name).toLowerCase() === wanted) { root = { ...sub, path: `${folder.path}/${sub.name}` }; break; }
      queue.push({ ...sub, path: `${folder.path}/${sub.name}`, depth: folder.depth + 1 });
    }
  }
  if (!root) return { folder: null, items: [], folders: 0 };
  const items = [];
  let folders = 0;
  const walk = async (folder, rel, depth) => {
    folders += 1;
    if (folders > maxFolders || depth > 6) return;
    const contents = await folderContents(client, projectId, folder.id);
    for (const item of contents.items) {
      const tip = item.tip ?? {};
      const isPdf = /\.pdf$/i.test(item.name ?? '') || String(tip.fileType ?? '').toLowerCase() === 'pdf';
      if (!isPdf) continue;
      items.push({ itemId: item.id, versionId: item.tipVersionId ?? tip.id ?? null, versionNumber: tip.versionNumber ?? null, fileName: item.name,
        folderId: folder.id, folderPath: rel, category: rel.split('/')[0] || null, atRoot: rel === '',
        size: tip.storageSize ?? null, lastModifiedTime: tip.lastModifiedTime ?? null, createTime: tip.createTime ?? null,
        createUserName: tip.createUserName ?? null, webViewUrl: item.webViewUrl ?? null });
    }
    for (const sub of contents.folders) await walk(sub, rel ? `${rel}/${sub.name}` : sub.name, depth + 1);
  };
  await walk(root, '', 0);
  return { folder: { id: root.id, path: root.path, name: root.name }, items, folders };
}

/** The model's assets that documents can link to: elements with a NetworkID or a Tag. */
export function assetRegistry(elements) {
  const out = [];
  for (const e of elements ?? []) {
    if (SPATIAL.test(e.ifcClass ?? '') || e.hostGlobalId) continue;
    const assetId = e.networkId ?? e.tag ?? null;
    if (!assetId) continue;
    out.push({ assetId, networkId: e.networkId ?? null, tag: e.tag ?? null, globalId: e.globalId, ifcClass: e.ifcClass, name: e.name ?? null });
  }
  return out;
}

/** Which IFC classes a document type points to, when a code has two candidates (a crane's intake and steel). */
const TYPE_CLASSES = [
  [/^crane intake$|intake/i, /DistributionBoard|SwitchingDevice/],
  [/^crane$/i, /TransportElement/],
  [/reefer block|assembly|^substation$/i, /ElementAssembly/],
  [/^rmu$|ring main/i, /DistributionBoard/],
  [/rack/i, /BuildingElementProxy|ElementAssembly/],
];

/**
 * Link each document to an asset. `manual`: documentId → {assetId} or {assetId: null} (unlinked on
 * purpose). Returns documentId → {status, assetId, ifcGlobalId, rule, candidates}.
 */
export function matchDocuments(records, registry, manual = {}) {
  const byExact = new Map(), byLower = new Map();
  const add = (map, key, entry) => { if (!key) return; if (!map.has(key)) map.set(key, []); if (!map.get(key).includes(entry)) map.get(key).push(entry); };
  for (const r of registry) {
    for (const key of [r.networkId, r.tag]) { add(byExact, key, r); add(byLower, key?.toLowerCase(), r); }
  }
  const byId = new Map(registry.map(r => [r.assetId, r]));
  const out = {};
  for (const d of records) {
    const m = manual[d.documentId];
    if (m) {
      const asset = m.assetId ? byId.get(m.assetId) : null;
      out[d.documentId] = m.assetId
        ? { status: STATUS.MATCHED, assetId: m.assetId, ifcGlobalId: asset?.globalId ?? null, rule: 'manual', inModel: Boolean(asset), candidates: [] }
        : { status: STATUS.UNMATCHED, assetId: null, ifcGlobalId: null, rule: 'manual-unlinked', candidates: [] };
      continue;
    }
    if (d.reference) { out[d.documentId] = { status: STATUS.REFERENCE, assetId: null, ifcGlobalId: null, rule: 'reference', candidates: [] }; continue; }
    const code = d.assetCode;
    // Candidates: the code itself and, for a structure ("STS-06" → "STS-06-STRUCT"), its steel.
    const exact = [...(byExact.get(code) ?? []), ...(byExact.get(`${code}-STRUCT`) ?? [])];
    const lower = exact.length ? [] : [...(byLower.get(code?.toLowerCase()) ?? []), ...(byLower.get(`${code}-struct`.toLowerCase()) ?? [])];
    let candidates = [...new Set(exact.length ? exact : lower)];
    const rule = exact.length ? 'exact' : 'case-insensitive';
    if (candidates.length > 1) {
      // The document type chooses: "Crane-intake" the e-house, "Crane" the steel; else prefer the code itself.
      const hint = TYPE_CLASSES.find(([type]) => type.test(d.docType ?? ''));
      const byType = hint ? candidates.filter(c => hint[1].test(c.ifcClass)) : [];
      // No type hint: the element whose NetworkID (the stable asset id) is the code, over one that only has it as a Tag.
      const self = candidates.filter(c => c.networkId === code);
      if (byType.length === 1) { out[d.documentId] = { status: STATUS.MATCHED, assetId: byType[0].assetId, ifcGlobalId: byType[0].globalId, rule: `${rule}+type`, candidates: candidates.map(c => c.assetId) }; continue; }
      if (!hint && self.length === 1) candidates = self;
    }
    if (candidates.length === 1) {
      out[d.documentId] = { status: STATUS.MATCHED, assetId: candidates[0].assetId, ifcGlobalId: candidates[0].globalId, rule, candidates: [] };
    } else if (candidates.length > 1) {
      out[d.documentId] = { status: STATUS.AMBIGUOUS, assetId: null, ifcGlobalId: null, rule, candidates: candidates.map(c => c.assetId) };
    } else {
      // A parent asset by whole hyphen segments ("R1-RACK9" → "R1"), offered for confirmation only.
      const parts = String(code ?? '').split('-');
      let parent = null;
      for (let n = parts.length - 1; n >= 1 && !parent; n -= 1) parent = (byExact.get(parts.slice(0, n).join('-')) ?? [])[0] ?? null;
      out[d.documentId] = parent
        ? { status: STATUS.SUGGESTED, assetId: null, ifcGlobalId: null, rule: 'parent', suggestion: parent.assetId, candidates: [parent.assetId] }
        : { status: STATUS.UNMATCHED, assetId: null, ifcGlobalId: null, rule: 'none', candidates: [] };
    }
  }
  return out;
}

const writeAtomic = (path, data) => { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, data); renameSync(temp, path); };
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** The persistent index for one project: index.json (documents) and mappings.json (manual links). */
export function createDocumentIndex({ dir, now = Date.now }) {
  const indexPath = join(dir, 'index.json'), mappingsPath = join(dir, 'mappings.json');
  const ensure = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); };
  const load = () => readJson(indexPath) ?? { folder: null, lastSyncedAt: null, lastError: null, documents: {} };
  const mappings = () => readJson(mappingsPath) ?? {};

  /** Merge one crawl into the index. Returns what changed. */
  function merge(crawl) {
    const index = load();
    const at = new Date(now()).toISOString();
    const seen = new Set();
    const changes = { added: [], updated: [], renamed: [], missing: [], restored: [] };
    for (const item of crawl.items) {
      const documentId = documentIdOf(item.itemId);
      seen.add(documentId);
      const parsed = parseDocumentName(item.fileName, { atRoot: item.atRoot });
      const prev = index.documents[documentId];
      const record = {
        documentId, accItemId: item.itemId, accVersionId: item.versionId, versionNumber: item.versionNumber, fileName: item.fileName,
        category: item.atRoot ? null : item.category, folderPath: item.folderPath, assetCode: parsed.assetCode, docType: parsed.docType, title: parsed.title ?? null, docDate: parsed.docDate ?? null, reference: parsed.reference,
        size: item.size, lastModifiedTime: item.lastModifiedTime, createTime: item.createTime ?? null, createUserName: item.createUserName, webViewUrl: item.webViewUrl,
        availability: 'available', firstSeenAt: prev?.firstSeenAt ?? at, lastSyncedAt: at,
        previousVersionIds: prev && prev.accVersionId !== item.versionId ? [...(prev.previousVersionIds ?? []), prev.accVersionId].slice(-10) : prev?.previousVersionIds ?? [],
      };
      if (!prev) changes.added.push(documentId);
      else {
        if (prev.accVersionId !== item.versionId) changes.updated.push(documentId);
        if (prev.fileName !== item.fileName) changes.renamed.push(documentId);
        if (prev.availability === 'missing') changes.restored.push(documentId);
      }
      index.documents[documentId] = record;
    }
    for (const [id, record] of Object.entries(index.documents)) {
      if (seen.has(id) || record.availability === 'missing') continue;
      // Not in ACC any more (deleted, moved out, or no access): kept, with its mapping, marked missing.
      index.documents[id] = { ...record, availability: 'missing', missingSince: at };
      changes.missing.push(id);
    }
    index.folder = crawl.folder;
    index.lastSyncedAt = at;
    index.lastError = null;
    index.lastChanges = { at, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.length])) };
    ensure();
    writeAtomic(indexPath, JSON.stringify(index, null, 1));
    return { index, changes };
  }

  function recordError(error) {
    const index = load();
    index.lastError = { code: error?.code ?? 'SYNC_FAILED', message: String(error?.message ?? error), at: new Date(now()).toISOString() };
    ensure();
    writeAtomic(indexPath, JSON.stringify(index, null, 1));
  }

  function setMapping(documentId, assetId) {
    const all = mappings();
    if (assetId === undefined) delete all[documentId];
    else all[documentId] = { assetId: assetId ?? null, at: new Date(now()).toISOString() };
    ensure();
    writeAtomic(mappingsPath, JSON.stringify(all, null, 1));
    return all[documentId] ?? null;
  }

  return { dir, load, mappings, merge, recordError, setMapping };
}
