import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { assetRegistry, crawlDocuments, createDocumentIndex, documentIdOf, matchDocuments, parseDocumentName, STATUS } from '../server/ifcSpatial/documents.mjs';
import { createDataClient, openVersionStream } from '../server/aps/dataManagement.mjs';
import { createIfcSpatialApi } from '../server/ifcSpatial/api.mjs';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';
import { ApsError } from '../server/aps/oauth.mjs';

// ---- a fake ACC: folders, items with tip versions, paginated pages ----

function fakeAcc(tree, { pageSize = 3 } = {}) {
  const calls = [];
  const item = (folderId, name, n = 1) => ({ type: 'items', id: `urn:item:${folderId}/${name}`, attributes: { displayName: name },
    relationships: { tip: { data: { id: `urn:item:${folderId}/${name}?version=${n}` } } }, links: { webView: { href: `https://acc.autodesk.com/docs/files/projects/p?entityId=${encodeURIComponent(name)}` } } });
  const version = (folderId, name, n = 1) => ({ type: 'versions', id: `urn:item:${folderId}/${name}?version=${n}`, attributes: { name, versionNumber: n, fileType: name.split('.').pop(), storageSize: 1000, lastModifiedTime: '2026-11-24T08:53:00Z' } });
  const client = {
    async getAll(path) {
      calls.push(path);
      const folderId = decodeURIComponent(/folders\/([^/]+)\/contents/.exec(path)[1]);
      const node = tree[folderId] ?? { folders: [], files: [] };
      const data = [...node.folders.map(f => ({ type: 'folders', id: f.id, attributes: { displayName: f.name } })), ...node.files.map(f => item(folderId, f.name ?? f, f.version))];
      const included = node.files.map(f => version(folderId, f.name ?? f, f.version));
      // Pagination is the client's job (createDataClient.getAll); here every page arrives at once.
      void pageSize;
      return { data, included };
    },
  };
  return { client, calls };
}

const TREE = {
  top: { folders: [{ id: 'pf', name: 'Project Files' }], files: [] },
  pf: { folders: [{ id: 'docs', name: 'Asset Documentation' }, { id: 'other', name: 'Drawings' }], files: [] },
  docs: { folders: [{ id: 'f1', name: '01_Substations' }, { id: 'f4', name: '04_Cranes_and_vaults' }, { id: 'f11', name: '11_Cables_480V' }], files: ['00_Asset_register.pdf', 'build_sheets.py'] },
  f1: { folders: [], files: ['USS-1_Substation.pdf', 'USS-1_RMU.pdf', 'MSS_Substation.pdf'] },
  f4: { folders: [{ id: 'f4b', name: 'Extra' }], files: ['STS-06_Crane-intake.pdf', 'STS-06_Crane.pdf'] },
  f4b: { folders: [], files: ['R1-RACK9_Rack.pdf'] },
  f11: { folders: [], files: ['L6_Cable.pdf', 'L6e_Cable.pdf', 'L6f_Cable.pdf', 'X-99_Cable.pdf'] },
};

test('discovery: finds the folder by name, walks every subfolder, keeps PDFs only, with ACC ids, versions and web links', async () => {
  const { client } = fakeAcc(TREE);
  const crawl = await crawlDocuments(client, 'b.p', [{ id: 'top', name: 'top' }]);
  assert.equal(crawl.folder.path, 'top/Project Files/Asset Documentation');
  assert.equal(crawl.items.length, 11, 'the .py file is ignored');
  const rack = crawl.items.find(i => i.fileName === 'R1-RACK9_Rack.pdf');
  assert.equal(rack.folderPath, '04_Cranes_and_vaults/Extra');
  assert.equal(rack.category, '04_Cranes_and_vaults');
  assert.match(rack.versionId, /\?version=1$/);
  assert.match(rack.webViewUrl, /^https:\/\/acc\.autodesk\.com\//);
  assert.equal(crawl.items.find(i => i.fileName === '00_Asset_register.pdf').atRoot, true);
  const none = await crawlDocuments(fakeAcc({ top: { folders: [], files: [] } }).client, 'b.p', [{ id: 'top', name: 'top' }]);
  assert.equal(none.folder, null);
});

test('pagination: the data client follows links.next through every page', async () => {
  const pages = { '/data/v1/projects/p/folders/f/contents': { data: [{ id: 1 }], links: { next: { href: 'https://developer.api.autodesk.com/data/v1/projects/p/folders/f/contents?page[number]=1' } } },
    '/data/v1/projects/p/folders/f/contents?page[number]=1': { data: [{ id: 2 }], links: { next: { href: 'https://developer.api.autodesk.com/data/v1/projects/p/folders/f/contents?page[number]=2' } } },
    '/data/v1/projects/p/folders/f/contents?page[number]=2': { data: [{ id: 3 }] } };
  const fetchImpl = async url => { const u = new URL(url); const body = pages[decodeURIComponent(u.pathname + u.search)]; return new Response(JSON.stringify(body), { status: 200 }); };
  const client = createDataClient({ getToken: async () => 't', refresh: async () => 't', fetchImpl });
  assert.deepEqual((await client.getAll('/data/v1/projects/p/folders/f/contents', 'x')).data.map(d => d.id), [1, 2, 3]);
});

test('rate limits: a 429 is waited out and retried', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const client = createDataClient({ getToken: async () => 't', refresh: async () => 't', fetchImpl });
  await client.get('/data/v1/projects/p', 'x');
  assert.equal(n, 2);
});

test('file names: asset code before the last "_"; the register at the root is a reference', () => {
  assert.deepEqual(parseDocumentName('USS-7_Substation.pdf'), { assetCode: 'USS-7', docType: 'Substation', reference: false });
  assert.deepEqual(parseDocumentName('STS-06_Crane-intake.pdf'), { assetCode: 'STS-06', docType: 'Crane intake', reference: false });
  assert.deepEqual(parseDocumentName('HM-10_Light-mast.PDF'), { assetCode: 'HM-10', docType: 'Light mast', reference: false });
  assert.equal(parseDocumentName('00_Asset_register.pdf', { atRoot: true }).reference, true);
  // More "_" segments: the asset is still the first one; the rest are a title and a date.
  assert.deepEqual(parseDocumentName('TX-M2_Transformer_Inspection-2024-001_2024-03-14.pdf'),
    { assetCode: 'TX-M2', docType: 'Transformer', reference: false, title: 'Inspection 2024-001', docDate: '2024-03-14' });
  assert.deepEqual(parseDocumentName('STS-05_Crane_Inspection-2023-007.pdf'), { assetCode: 'STS-05', docType: 'Crane', reference: false, title: 'Inspection 2023-007' });
});

test('matching: every document named after an asset links to it, inspection reports included', () => {
  const docs = ['USS-1_Substation.pdf', 'USS-1_RMU_Inspection-2024-002_2024-05-02.pdf', 'STS-06_Crane_Inspection-2024-003_2024-06-10.pdf',
    'STS-06_Crane-intake_Inspection-2024-004_2024-06-11.pdf', 'L6e_Cable_Test-report_2024-01-09.pdf'].map(f => doc(f));
  const m = matchDocuments(docs, REGISTRY);
  const of = f => m[documentIdOf(f)];
  assert.equal(of('USS-1_RMU_Inspection-2024-002_2024-05-02.pdf').assetId, 'USS-1');
  assert.equal(of('STS-06_Crane_Inspection-2024-003_2024-06-10.pdf').assetId, 'STS-06-STRUCT');
  assert.equal(of('STS-06_Crane-intake_Inspection-2024-004_2024-06-11.pdf').assetId, 'STS-06');
  assert.equal(of('L6e_Cable_Test-report_2024-01-09.pdf').assetId, 'L6e');
});

const el = (networkId, ifcClass, { tag = networkId, globalId = `g-${networkId ?? tag}-${ifcClass}` } = {}) => ({ networkId, tag, ifcClass, globalId, name: `${networkId ?? tag} element` });
const REGISTRY = assetRegistry([
  el('USS-1', 'IfcElectricDistributionBoard'), el(null, 'IfcElementAssembly', { tag: 'USS-1' }), el(null, 'IfcElementAssembly', { tag: 'MSS' }),
  el('STS-06', 'IfcElectricDistributionBoard'), el('STS-06-STRUCT', 'IfcTransportElement'),
  el('L6', 'IfcCableSegment'), el('L6e', 'IfcCableSegment'), el('R1', 'IfcElectricDistributionBoard'),
  el(null, 'IfcDistributionPort', { tag: 'P1' }),
]);
const doc = (fileName, extra = {}) => ({ documentId: documentIdOf(fileName), fileName, ...parseDocumentName(fileName), ...extra });

test('matching: exact ids, Tag, the document type between a crane intake and its steel, never a substring', () => {
  const docs = ['USS-1_Substation.pdf', 'USS-1_RMU.pdf', 'MSS_Substation.pdf', 'STS-06_Crane-intake.pdf', 'STS-06_Crane.pdf', 'L6_Cable.pdf', 'L6e_Cable.pdf', 'L6f_Cable.pdf', 'R1-RACK9_Rack.pdf', 'X-99_Cable.pdf', 'l6E_Cable.pdf'].map(f => doc(f));
  docs.push(doc('00_Asset_register.pdf', { reference: true, assetCode: null }));
  const m = Object.fromEntries(docs.map(d => [d.fileName, matchDocuments(docs, REGISTRY)[d.documentId]]));
  assert.deepEqual([m['USS-1_Substation.pdf'].assetId, m['USS-1_Substation.pdf'].ifcGlobalId], ['USS-1', 'g-USS-1-IfcElementAssembly']);
  assert.deepEqual([m['USS-1_RMU.pdf'].assetId, m['USS-1_RMU.pdf'].ifcGlobalId], ['USS-1', 'g-USS-1-IfcElectricDistributionBoard']);
  assert.equal(m['MSS_Substation.pdf'].assetId, 'MSS');
  assert.equal(m['STS-06_Crane-intake.pdf'].assetId, 'STS-06');
  assert.equal(m['STS-06_Crane.pdf'].assetId, 'STS-06-STRUCT');
  assert.equal(m['L6_Cable.pdf'].assetId, 'L6');
  assert.equal(m['L6e_Cable.pdf'].assetId, 'L6e');
  assert.equal(m['L6f_Cable.pdf'].status, STATUS.UNMATCHED, 'L6f is not L6 (nor L6e): no substring match, no suggestion');
  assert.equal(m['L6f_Cable.pdf'].assetId, null);
  assert.equal(m['l6E_Cable.pdf'].assetId, 'L6e', 'case differences are normalised');
  assert.equal(m['l6E_Cable.pdf'].rule, 'case-insensitive');
  assert.deepEqual([m['R1-RACK9_Rack.pdf'].status, m['R1-RACK9_Rack.pdf'].suggestion], [STATUS.SUGGESTED, 'R1']);
  assert.equal(m['X-99_Cable.pdf'].status, STATUS.UNMATCHED);
  assert.equal(m['00_Asset_register.pdf'].status, STATUS.REFERENCE);
  assert.ok(!REGISTRY.some(r => r.ifcClass === 'IfcDistributionPort'), 'ports are not assets');
});

test('ambiguous ids are never assigned automatically', () => {
  const registry = assetRegistry([el('Q-1', 'IfcElectricDistributionBoard'), el(null, 'IfcBuildingElementProxy', { tag: 'Q-1', globalId: 'other' })]);
  const d = doc('Q-1_Datasheet.pdf');
  const m = matchDocuments([d], registry)[d.documentId];
  assert.deepEqual([m.status, m.ifcGlobalId], [STATUS.MATCHED, 'g-Q-1-IfcElectricDistributionBoard'], 'NetworkID (the stable asset id) wins over a Tag when the type gives no hint');
  const two = assetRegistry([el('Q-2', 'IfcElectricDistributionBoard', { globalId: 'a' }), el('Q-2', 'IfcCableSegment', { globalId: 'b' })]);
  const d2 = doc('Q-2_Datasheet.pdf');
  assert.equal(matchDocuments([d2], two)[d2.documentId].status, STATUS.AMBIGUOUS);
});

test('manual mappings win, persist, and survive a sync; a new version keeps the mapping; a vanished file is kept as missing', () => {
  let clock = Date.parse('2026-11-24T10:00:00Z');
  const index = createDocumentIndex({ dir: mkdtempSync(join(tmpdir(), 'docs-')), now: () => clock });
  const crawl = files => ({ folder: { id: 'docs', path: 'Project Files/Asset Documentation' }, items: files.map(([name, v = 1]) => ({ itemId: `urn:item:${name.split('_')[0]}`, versionId: `urn:v:${name}?version=${v}`, versionNumber: v, fileName: name, folderPath: '11_Cables_480V', category: '11_Cables_480V', atRoot: false })) });
  let { changes } = index.merge(crawl([['L6f_Cable.pdf'], ['L6e_Cable.pdf']]));
  assert.equal(changes.added.length, 2);
  const id = documentIdOf('urn:item:L6f');
  index.setMapping(id, 'L6');
  let m = matchDocuments(Object.values(index.load().documents), REGISTRY, index.mappings());
  assert.deepEqual([m[id].status, m[id].assetId, m[id].rule], [STATUS.MATCHED, 'L6', 'manual']);
  // A new version and a rename: same document id, mapping kept, version history recorded.
  clock += 60_000;
  ({ changes } = index.merge(crawl([['L6f_Cable-rev2.pdf', 2], ['L6e_Cable.pdf']])));
  assert.deepEqual([changes.updated, changes.renamed], [[id], [id]]);
  const rec = index.load().documents[id];
  assert.equal(rec.versionNumber, 2);
  assert.equal(rec.previousVersionIds.length, 1);
  m = matchDocuments(Object.values(index.load().documents), REGISTRY, index.mappings());
  assert.equal(m[id].assetId, 'L6', 'the manual mapping is not overwritten by a sync');
  // The file disappears: kept, marked missing, mapping intact; it comes back: restored.
  ({ changes } = index.merge(crawl([['L6e_Cable.pdf']])));
  assert.deepEqual(changes.missing, [id]);
  assert.equal(index.load().documents[id].availability, 'missing');
  assert.equal(index.mappings()[id].assetId, 'L6');
  ({ changes } = index.merge(crawl([['L6f_Cable-rev2.pdf', 2], ['L6e_Cable.pdf']])));
  assert.deepEqual(changes.restored, [id]);
  // Undo the manual mapping: back to automatic.
  index.setMapping(id, undefined);
  assert.equal(index.mappings()[id], undefined);
});

test('IFC V2 → V3: the moved UTIL-A keeps its document; the added lights get theirs; logical ids stay, GlobalIds per version', async () => {
  const [v2, v3] = await Promise.all(['seagirt-compare-v1.ifc', 'seagirt-compare-v2.ifc'].map(async f => assetRegistry((await convertIfc(readFileSync(new URL(`./fixtures/ifc/${f}`, import.meta.url)), {})).elements)));
  const docs = ['UTIL-A_Switchgear.pdf', 'HM-12_Light-mast.pdf', 'TX-M2_Transformer.pdf'].map(f => doc(f));
  const [m2, m3] = [matchDocuments(docs, v2), matchDocuments(docs, v3)];
  const util = docs[0].documentId, hm12 = docs[1].documentId;
  assert.equal(m2[util].assetId, 'UTIL-A');
  assert.equal(m3[util].assetId, 'UTIL-A');
  assert.equal(m2[util].ifcGlobalId, m3[util].ifcGlobalId, 'same GlobalId in both versions here');
  assert.equal(m2[hm12].status, STATUS.UNMATCHED, 'HM-12 is not in V2');
  assert.equal(m3[hm12].assetId, 'HM-12');
});

// ---- the endpoints ----

function harness({ openStream, files: tree = TREE } = {}) {
  const { client } = fakeAcc(tree);
  const v = 'urn:model?version=2';
  const files = { hub: { id: 'h' }, project: { id: 'b.p', name: 'Seagirt' }, topFolders: [{ id: 'top', name: 'top' }],
    files: [{ fileName: 'net.ifc', itemId: 'urn:i', tipVersionId: v, versions: [{ id: v, versionNumber: 2 }] }] };
  const model = readFileSync(new URL('./fixtures/ifc/seagirt-compare-v2.ifc', import.meta.url));
  const streams = [];
  const api = createIfcSpatialApi({ aps: { dataClient: () => client, projectFiles: async () => files }, cacheDir: mkdtempSync(join(tmpdir(), 'docs-api-')), logger: { info() {}, warn() {}, error() {} },
    download: async () => ({ bytes: model }),
    openStream: openStream ?? (async (c, p, versionId) => { streams.push(versionId); return { body: Readable.from([Buffer.from('%PDF-1.7 test')]), contentLength: 13, fileName: decodeURIComponent(versionId.split('/').pop().split('?')[0]) }; }) });
  async function call(method, path, body) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url: path, headers: {} });
    let status, headers; const parts = [];
    await api.handle(req, { writeHead(s, h) { status = s; headers = h; }, write(c) { parts.push(Buffer.from(c)); }, end(b) { if (b) parts.push(Buffer.from(b)); } });
    const raw = Buffer.concat(parts);
    return { status, headers, raw, json: String(headers?.['content-type']).startsWith('application/json') ? JSON.parse(raw.toString()) : null };
  }
  return { call, streams };
}

test('endpoints: sync, the index linked to the model, a document streamed as a PDF, unknown ids refused', async () => {
  const h = harness();
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  const { json } = await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  assert.equal(json.summary.total, 11);
  assert.equal(json.summary.reference, 1);
  const byName = Object.fromEntries(json.documents.map(d => [d.fileName, d]));
  assert.equal(byName['USS-1_Substation.pdf'].mapping.assetId, 'USS-1');
  assert.equal(byName['USS-1_Substation.pdf'].mapping.status, 'matched');
  assert.ok(byName['STS-06_Crane.pdf'].mapping.ifcGlobalId, 'linked to the crane steel GlobalId');
  assert.equal(byName['USS-1_Substation.pdf'].categoryLabel, 'Substations');
  assert.ok(json.assets.length > 100);
  const id = byName['USS-1_Substation.pdf'].documentId;
  const pdf = await h.call('GET', `/api/ifc-spatial/documents/${id}/content`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.headers['content-disposition'], /^inline; filename="USS-1_Substation\.pdf"/);
  assert.equal(pdf.raw.toString().slice(0, 5), '%PDF-');
  const dl = await h.call('GET', `/api/ifc-spatial/documents/${id}/content?download=1`);
  assert.match(dl.headers['content-disposition'], /^attachment;/);
  assert.match(h.streams[0], /USS-1_Substation\.pdf\?version=1$/, 'the indexed version is what is fetched');
  // Only ids from the index: no object ids or paths from the browser.
  assert.equal((await h.call('GET', '/api/ifc-spatial/documents/urn:adsk.objects:os.object:x/content')).status, 400);
  assert.equal((await h.call('GET', `/api/ifc-spatial/documents/${'0'.repeat(24)}/content`)).status, 404);
});

test('endpoints: a manual mapping is validated against the model and kept; ACC permission errors reach the user', async () => {
  const h = harness({ openStream: async () => { throw new ApsError('FORBIDDEN', 403, 'You do not have permission to view this file in ACC.'); } });
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  const { json } = await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  const l6f = json.documents.find(d => d.fileName === 'L6f_Cable.pdf');
  assert.equal((await h.call('PUT', `/api/ifc-spatial/documents/${l6f.documentId}/mapping?file=net.ifc`, { assetId: 'NOPE' })).json.error.code, 'UNKNOWN_ASSET');
  const after = (await h.call('PUT', `/api/ifc-spatial/documents/${l6f.documentId}/mapping?file=net.ifc`, { assetId: 'L6f' })).json;
  assert.deepEqual(after.documents.find(d => d.documentId === l6f.documentId).mapping, { status: 'matched', assetId: 'L6f', ifcGlobalId: after.assets.find(a => a.assetId === 'L6f').globalId, rule: 'manual', inModel: true, candidates: [], manual: true });
  const resynced = (await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc')).json;
  assert.equal(resynced.documents.find(d => d.documentId === l6f.documentId).mapping.rule, 'manual');
  const denied = await h.call('GET', `/api/ifc-spatial/documents/${l6f.documentId}/content`);
  assert.deepEqual([denied.status, denied.json.error.code], [403, 'FORBIDDEN']);
});

test('a missing folder is reported, not an empty success', async () => {
  const h = harness({ files: { top: { folders: [], files: [] } } });
  const { json } = await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  assert.equal(json.lastError.code, 'DOCS_FOLDER_NOT_FOUND');
  assert.equal(json.summary.total, 0);
});

test('download: an expired pre-signed URL is replaced once', async () => {
  const signed = [];
  const client = { get: async path => (path.includes('/versions/') ? { data: { attributes: { name: 'A.pdf', versionNumber: 3, storageSize: 5 }, relationships: { storage: { data: { id: 'urn:adsk.objects:os.object:wip/abc.pdf' } } } } }
    : (signed.push(path), { url: `https://s3.example/${signed.length}` })) };
  const fetchImpl = async url => (url.endsWith('/1') ? new Response('expired', { status: 403 }) : new Response('%PDF-', { status: 200, headers: { 'content-length': '5' } }));
  const file = await openVersionStream(client, 'p', 'urn:v?version=3', { fetchImpl });
  assert.equal(signed.length, 2);
  assert.equal(file.fileName, 'A.pdf');
  assert.equal(file.contentLength, 5);
});
