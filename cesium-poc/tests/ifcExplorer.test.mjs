import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex, elementFromProperties, groupProperties, propertyCategories, searchElements, elementsIn, unitLabel } from '../src/ifcExplorer/modelIndex.js';
import { compareAssets, kilovolts } from '../src/ifcExplorer/assetMapping.js';
import { ApsRequestError, createApsClient, loginUrl, needsSignIn, viewableOf } from '../src/ifcExplorer/apsClient.js';
import { createViewerSession, resetViewerInitialization, ViewerError } from '../src/ifcExplorer/viewerSession.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ifc-explorer-properties.json', import.meta.url), 'utf8')).results;
const twinAssets = JSON.parse(readFileSync(new URL('../public/data/seagirt/electrical-assets.json', import.meta.url), 'utf8')).assets;
const index = buildIndex(fixture);
const byName = prefix => index.elements.find(element => element.name.startsWith(prefix));

// ---- hierarchy, properties and categories (the model's own data) ----

test('elements read IFC identity from IFC Attributes, not from the port or container GlobalIds', () => {
  const tx = byName('TX-1 ');
  assert.equal(tx.ifcClass, 'IfcTransformer');
  assert.equal(tx.tag, 'TX-1');
  assert.equal(tx.networkId, 'TX-1');
  assert.equal(tx.networkRole, 'Unit transformer');
  const raw = fixture.find(result => result.dbId === tx.dbId);
  const ownGlobalId = raw.properties.find(p => p.displayCategory === 'IFC Attributes' && p.displayName === 'GlobalId').displayValue;
  assert.equal(tx.globalId, ownGlobalId);
  const otherGlobalIds = raw.properties.filter(p => p.displayName === 'GlobalId' && p.displayCategory !== 'IFC Attributes').map(p => p.displayValue);
  assert.ok(otherGlobalIds.length > 0 && !otherGlobalIds.includes(tx.globalId), 'port / pset GlobalIds are different entities');
  assert.equal(tx.name, 'TX-1 USS-1 transformer TX-1 (Reefer West)');
});

test('categories follow IFC class and the model\'s NetworkRole; structure nodes are not equipment', () => {
  const category = prefix => byName(prefix)?.category;
  assert.equal(category('UTIL-A'), 'source');
  assert.equal(category('GEN-1'), 'source');
  assert.equal(category('QSS-W'), 'switchgear');
  assert.equal(category('USS-4 Unit substation'), 'substation');
  assert.equal(category('TX-M1'), 'transformer');
  assert.equal(category('BT-1'), 'breaker');
  assert.equal(category('AT-1'), 'breaker');
  assert.equal(category('F1 '), 'cable');
  assert.equal(category('FO-01'), 'scada');
  assert.equal(category('STS-01'), 'crane');
  assert.equal(category('V01'), 'crane');
  assert.equal(category('HM-1'), 'load');
  assert.equal(category('R2 reefer'), 'other', 'an element that fits no category is not forced into one');
  assert.equal(index.byDbId.get(25).category, 'port');
  assert.equal(index.byDbId.get(106).category, 'geometry');
  assert.equal(index.byDbId.get(5).category, 'group');
  assert.equal(index.byDbId.get(2).category, 'spatial');
  assert.equal(index.electricalCount, 15);
  assert.equal(index.counts.transformer, 2);
});

test('search covers name, GlobalId, IFC class, tag and role; every term must match', () => {
  const tx = byName('TX-1 ');
  assert.deepEqual(searchElements(index, tx.globalId).map(e => e.dbId), [tx.dbId]);
  assert.deepEqual(searchElements(index, 'ifctransformer').map(e => e.name).sort(), ['TX-1 USS-1 transformer TX-1 (Reefer West)', 'TX-M1 Main transformer TX-M1']);
  assert.deepEqual(searchElements(index, 'transformer main').map(e => e.networkId), ['TX-M1']);
  assert.equal(searchElements(index, 'IfcDistributionPort').length, 1, 'ports only when asked for');
  assert.equal(searchElements(index, 'cable').some(e => e.category === 'port'), false);
  assert.deepEqual(searchElements(index, '   '), []);
  assert.deepEqual(elementsIn(index, 'transformer').map(e => e.networkId), ['TX-1', 'TX-M1']);
});

test('properties are grouped by the model\'s categories, electrical sets first, values unchanged', () => {
  const tx = fixture.find(result => result.dbId === byName('TX-M1').dbId);
  const groups = groupProperties(tx);
  assert.deepEqual(groups.slice(0, 2).map(g => g.category).sort(), ['Pset_TransformerTypeCommon', 'SuperDNA_PowerNetwork']);
  assert.equal(groups[2].category, 'IFC Attributes');
  const pset = groups.find(g => g.category === 'Pset_TransformerTypeCommon');
  const original = tx.properties.filter(p => p.displayCategory === 'Pset_TransformerTypeCommon' && p.displayName !== 'GlobalId');
  for (const prop of original) assert.equal(pset.props.find(p => p.name === prop.displayName).value, String(prop.displayValue));
  assert.equal(groupProperties({ properties: [{ displayCategory: 'X', displayName: 'secret', displayValue: '1', hidden: true }] }).length, 0, 'hidden properties are dropped');
  const categories = propertyCategories(fixture).map(entry => entry.category);
  assert.ok(categories.includes('IFC Attributes') && categories.includes('SuperDNA_PowerNetwork'));
});

test('unit labels are shortened from the viewer\'s type ids; unknown units keep their name', () => {
  assert.equal(unitLabel('autodesk.unit.unit:volts-2.0.0'), 'V');
  assert.equal(unitLabel('autodesk.unit.unit:watts-2.0.0'), 'W');
  assert.equal(unitLabel('autodesk.unit.unit:furlongs-1.0.0'), 'furlongs');
  assert.equal(unitLabel('kV'), 'kV');
});

test('an element with no properties beyond its name keeps nulls, not invented values', () => {
  const bare = elementFromProperties({ dbId: 9, name: 'IfcTransformer::X', properties: [] });
  assert.equal(bare.ifcClass, 'IfcTransformer');
  assert.equal(bare.globalId, null);
  assert.equal(bare.voltageLevel, null);
  assert.equal(bare.networkId, null);
});

// ---- read-only asset mapping ----

test('mapping: exact identifiers only; voltage contradictions are ambiguous; similar names never match', () => {
  const frozen = structuredClone(twinAssets);
  const report = compareAssets(index.elements, frozen);
  assert.deepEqual(frozen, twinAssets, 'the twin assets are not modified');
  assert.deepEqual(report.candidates.map(c => c.assetId), ['L1']);
  assert.equal(report.candidates[0].verdict, 'CANDIDATE_UNCONFIRMED');
  assert.match(report.candidates[0].reasons[0], /Not confirmed/);
  const f1 = report.ambiguous.find(entry => entry.assetId === 'F1');
  assert.equal(f1.verdict, 'AMBIGUOUS');
  assert.match(f1.reasons.join(' '), /Voltage differs: IFC 13.8 kV, twin 4.16 kV/);
  // dbId, IFC GlobalId and the twin's asset id stay separate fields.
  assert.equal(typeof f1.ifc[0].dbId, 'number');
  assert.match(f1.ifc[0].globalId, /^[0-9A-Za-z_$]{22}$/);
  assert.equal(f1.assetId, 'F1');
  // TX-1 is not T1, STS-01 is not C1, QSS-W is not S1.
  for (const id of ['T1', 'C1', 'S1', 'SS1', 'MS1', 'TB1']) assert.ok(report.assetsOnly.some(asset => asset.assetId === id), `${id} has no IFC element`);
  assert.ok(report.ifcOnly.some(ref => ref.networkId === 'TX-1'));
  assert.ok(report.rules.some(rule => /proximity/.test(rule)));
});

test('mapping: a class contradiction is ambiguous, and missing metadata is listed by field', () => {
  const elements = [
    { dbId: 1, name: 'T1 lighting mast', ifcClass: 'IfcLightFixture', networkId: 'T1', tag: 'T1', globalId: 'g', networkRole: 'Load', voltageLevel: '480 V', electrical: true },
    { dbId: 2, name: 'unnamed cable', ifcClass: 'IfcCableSegment', networkId: null, tag: null, globalId: 'h', networkRole: null, voltageLevel: null, electrical: true },
  ];
  const report = compareAssets(elements, twinAssets);
  const t1 = report.ambiguous.find(entry => entry.assetId === 'T1');
  assert.match(t1.reasons.join(' '), /IfcLightFixture is not a plausible transformer/);
  assert.deepEqual(report.missingMetadata.find(entry => entry.dbId === 2).missing, ['IFC Tag', 'NetworkID', 'NetworkRole', 'VoltageLevel']);
  assert.equal(kilovolts('480 V'), 0.48);
  assert.equal(kilovolts('13.8 kV'), 13.8);
  assert.equal(kilovolts('SCADA'), null);
});

// ---- the existing APS routes, as the explorer uses them ----

const file = (manifest, urn = 'dXJu') => ({ fileName: 'seagirt_power_network.ifc', derivative: urn ? { urn, manifest } : null });

test('viewable: an existing successful SVF derivative is used as is; failures are explicit', () => {
  assert.deepEqual(viewableOf(file({ status: 'success', outputs: [{ outputType: 'svf', status: 'success' }] })),
    { ok: true, urn: 'dXJu', outputType: 'svf', env: 'AutodeskProduction', api: 'derivativeV2' });
  assert.equal(viewableOf(file({ status: 'success', outputs: [{ outputType: 'svf2', status: 'success' }] })).env, 'AutodeskProduction2');
  assert.equal(viewableOf(file(null, null)).code, 'NO_DERIVATIVE');
  assert.equal(viewableOf(file({ status: 'failed', progress: 'complete' })).code, 'TRANSLATION_NOT_READY');
  assert.equal(viewableOf(file({ status: 'inprogress', progress: '40% complete' })).code, 'TRANSLATION_NOT_READY');
  assert.equal(viewableOf(file({ status: 'success', outputs: [{ outputType: 'thumbnail', status: 'success' }] })).code, 'NO_VIEWABLE');
  assert.equal(viewableOf(file({ status: 'unavailable', code: 'FORBIDDEN', detail: 'no access' })).code, 'TRANSLATION_NOT_READY');
});

test('client: server errors keep their code; FILES_MISSING still returns the files found; sign-in errors are recognised', async () => {
  const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  const expired = createApsClient({ fetchImpl: respond(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired', hint: 'Sign in again' } }) });
  await assert.rejects(expired.viewerToken(), error => error instanceof ApsRequestError && error.code === 'TOKEN_EXPIRED' && error.hint === 'Sign in again' && needsSignIn(error));
  const partial = createApsClient({ fetchImpl: respond(404, { error: { code: 'FILES_MISSING', message: 'Not found: b.ifc' }, files: [{ fileName: 'a.ifc' }], missing: ['b.ifc'] }) });
  const files = await partial.files();
  assert.equal(files.files.length, 1);
  assert.match(files.warning, /Not found/);
  const down = createApsClient({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(down.status(), error => error.code === 'NETWORK');
  assert.equal(loginUrl('/?demo=seagirt&screen=ifc'), '/api/aps/login?returnTo=%2F%3Fdemo%3Dseagirt%26screen%3Difc');
  assert.equal(needsSignIn({ code: 'NO_DERIVATIVE' }), false);
});

// ---- the viewer lifecycle, against a stand-in for the Autodesk Viewer SDK ----

function fakeAutodesk({ loadError = null, geometry = true } = {}) {
  const log = [];
  const tree = { getRootId: () => 1, getNodeParentId: id => ({ 106: 58, 58: 5, 5: 1 })[id] ?? 0, enumNodeChildren() {} };
  let models = [];
  class GuiViewer3D {
    constructor(container) { this.container = container; this.listeners = new Map(); log.push('create'); }
    start() { log.push('start'); return 0; }
    setTheme(name) { log.push(`theme:${name}`); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type) { this.listeners.delete(type); log.push(`off:${type}`); }
    getAllModels() { return models; }
    unloadModel(model) { models = models.filter(m => m !== model); log.push(`unload:${model.urn}`); }
    async loadDocumentNode(doc) {
      await new Promise(resolve => setTimeout(resolve, doc.delay ?? 0));
      const model = { urn: doc.urn, getObjectTree: ok => ok(tree), getBulkProperties: (ids, opts, ok) => ok(ids.map(dbId => ({ dbId }))), getProperties: (id, ok) => ok({ dbId: id }) };
      models.push(model);
      log.push(`load:${doc.urn}`);
      return model;
    }
    select(ids) { this.selected = ids; log.push(`select:${ids.join(',')}`); this.listeners.get('selection')?.({ dbIdArray: ids }); }
    fitToView() {} isolate() {} showAll() {} clearSelection() {} resize() {}
    finish() { log.push('finish'); models = []; }
  }
  const Autodesk = { Viewing: {
    GuiViewer3D, SELECTION_CHANGED_EVENT: 'selection',
    Initializer(options, done) { log.push(`init:${options.env}`); Autodesk.options = options; done(); },
    shutdown() { log.push('shutdown'); },
    Document: { load(urn, ok, fail) {
      if (loadError) { fail(loadError, 'denied'); return; }
      const name = urn.replace('urn:', '');
      ok({ urn: name, delay: name === 'slow' ? 20 : 0, getRoot: () => ({ getDefaultGeometry: () => (geometry ? { guid: 'g' } : null) }) });
    } },
  } };
  return { Autodesk, log, models: () => models };
}
const viewable = urn => ({ ok: true, urn, env: 'AutodeskProduction', api: 'derivativeV2' });

test('viewer: initialized once, one model at a time, previous model unloaded on switch', async () => {
  resetViewerInitialization();
  const fake = fakeAutodesk();
  const session = createViewerSession({ Autodesk: fake.Autodesk, container: {}, getAccessToken: () => {} });
  await session.open(viewable('a'));
  await session.open(viewable('b'));
  assert.deepEqual(fake.log.filter(entry => entry.startsWith('init')), ['init:AutodeskProduction']);
  assert.deepEqual(fake.log.filter(entry => /^(load|unload)/.test(entry)), ['load:a', 'unload:a', 'load:b']);
  assert.equal(session.modelCount(), 1);
  assert.ok(session.tree());
  assert.equal((await session.bulkProperties([1, 2])).length, 2);
});

test('viewer: a switch during a slow load never leaves two models (the stale one is dropped)', async () => {
  resetViewerInitialization();
  const fake = fakeAutodesk();
  const session = createViewerSession({ Autodesk: fake.Autodesk, container: {}, getAccessToken: () => {} });
  const slow = session.open(viewable('slow'));
  const fast = session.open(viewable('fast'));
  assert.equal(await slow, null, 'superseded');
  assert.ok(await fast);
  assert.deepEqual(fake.models().map(m => m.urn), ['fast']);
});

test('viewer: dispose unloads, removes the selection listener and finishes the viewer', async () => {
  resetViewerInitialization();
  const fake = fakeAutodesk();
  const session = createViewerSession({ Autodesk: fake.Autodesk, container: {}, getAccessToken: () => {} });
  await session.open(viewable('a'));
  session.dispose();
  assert.ok(fake.log.includes('off:selection'));
  assert.ok(fake.log.includes('finish'));
  assert.equal(session.viewer, null);
  await assert.rejects(session.open(viewable('a')), error => error.code === 'DISPOSED');
  // A new session on the same container works, without re-initializing the SDK.
  const again = createViewerSession({ Autodesk: fake.Autodesk, container: {}, getAccessToken: () => {} });
  await again.open(viewable('a'));
  assert.equal(fake.log.filter(entry => entry.startsWith('init')).length, 1);
});

test('viewer: a click on body geometry selects the owning IFC element', async () => {
  resetViewerInitialization();
  const fake = fakeAutodesk();
  const picked = [];
  const session = createViewerSession({ Autodesk: fake.Autodesk, container: {}, getAccessToken: () => {}, onSelect: id => picked.push(id) });
  await session.open(viewable('a'), { elementTest: id => id === 58 });
  session.viewer.listeners.get('selection')({ dbIdArray: [106] });
  assert.equal(picked.at(-1), 58);
  assert.deepEqual(session.viewer.selected, [58]);
  session.viewer.listeners.get('selection')({ dbIdArray: [] });
  assert.equal(picked.at(-1), null);
});

test('viewer: token expiry, missing derivative and missing geometry are reported by code', async () => {
  for (const [code, expected] of [[4, 'AUTH'], [5, 'NO_DERIVATIVE'], [9, 'NO_GEOMETRY'], [42, 'LOAD_FAILED']]) {
    resetViewerInitialization();
    const session = createViewerSession({ Autodesk: fakeAutodesk({ loadError: code }).Autodesk, container: {}, getAccessToken: () => {} });
    await assert.rejects(session.open(viewable('a')), error => error instanceof ViewerError && error.code === expected);
  }
  resetViewerInitialization();
  const empty = createViewerSession({ Autodesk: fakeAutodesk({ geometry: false }).Autodesk, container: {}, getAccessToken: () => {} });
  await assert.rejects(empty.open(viewable('a')), error => error.code === 'NO_GEOMETRY');
});

test('viewer: the token callback is what the SDK is initialized with', async () => {
  resetViewerInitialization();
  const fake = fakeAutodesk();
  const getAccessToken = callback => callback('view-only', 3599);
  const session = createViewerSession({ Autodesk: fake.Autodesk, container: {}, getAccessToken });
  await session.open(viewable('a'));
  assert.equal(fake.Autodesk.options.getAccessToken, getAccessToken);
  let token;
  fake.Autodesk.options.getAccessToken((value, expires) => { token = [value, expires]; });
  assert.deepEqual(token, ['view-only', 3599]);
});
