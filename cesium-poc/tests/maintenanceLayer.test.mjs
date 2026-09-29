import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian2, Cartesian3, Event, JulianDate } from 'cesium';
import { installMaintenanceLayer } from '../src/maintenance/maintenanceLayer.js';
import { assetSquareMarker } from '../src/assetIdMarker.js';

test('maintenance category markers use the Live Ops square badge shape', () => {
  const marker = assetSquareMarker({ color: '#8b5cf6', key: 'task', glyphSvg: '<path d="M4 4h12v12H4z"/>' });
  const svg = decodeURIComponent(marker.image);
  assert.equal(marker.width, 44);
  assert.equal(marker.height, 52);
  assert.match(svg, /<rect x="2" y="2" width="40" height="40"/);
  assert.match(svg, /M17 40 22 49 27 40/);
});

test('coincident maintenance pins remain visible and selection keeps the same anchored offset', () => {
  const sources = [];
  const viewer = {
    dataSources: { add(source) { sources.push(source); return Promise.resolve(source); }, remove() {} },
    camera: { positionWC: Cartesian3.fromDegrees(-80.3, 26.1, 20000), moveEnd: new Event(), changed: new Event() },
    scene: { requestRender() {} },
    screenSpaceEventHandler: { getInputAction() {}, setInputAction() {}, removeInputAction() {} },
  };
  const layer = installMaintenanceLayer(viewer);
  const record = id => ({ id, longitude: -80.3, latitude: 26.1 });
  const tone = { color: '#3388ff', glyphSvg: '<path d="M4 4h16v16H4z"/>' };
  const time = JulianDate.now();
  const expected = Cartesian3.fromDegrees(-80.3, 26.1);
  function positionIsAnchored(entity) {
    assert.deepEqual(entity.position.getValue(time), expected);
  }
  layer.setTypeTone('tickets', tone);
  layer.setTypeTone('tasks', tone);
  layer.setShowAllTypes(true);
  layer.setRecords('tickets', [record('ticket-a'), record('ticket-b')]);
  layer.setRecords('tasks', [record('task-a')]);
  for (const entity of sources[0].entities.values) positionIsAnchored(entity);
  const ticketA = sources[0].entities.getById('maintenance-tickets-ticket-a');
  const ticketB = sources[0].entities.getById('maintenance-tickets-ticket-b');
  assert.notDeepEqual(ticketA.billboard.pixelOffset.getValue(time), ticketB.billboard.pixelOffset.getValue(time));
  layer.setShowAllTypes(false);
  layer.show('tickets');
  layer.highlightById('ticket-a');
  positionIsAnchored(sources[1].entities.values[0]);
  assert.deepEqual(sources[1].entities.values[0].billboard.pixelOffset.getValue(time),
    ticketA.billboard.pixelOffset.getValue(time));
  layer.highlightById('ticket-b');
  positionIsAnchored(sources[1].entities.values[0]);
  assert.deepEqual(sources[1].entities.values[0].billboard.pixelOffset.getValue(time),
    ticketB.billboard.pixelOffset.getValue(time));
  layer.setVisibleIds('tickets', ['ticket-b']);
  assert.deepEqual(sources[1].entities.values[0].billboard.pixelOffset.getValue(time), Cartesian2.ZERO,
    'hidden coincident records do not separate the visible icon from its pulse anchor');
  layer.setRecords('tasks', [record('task-a'), record('task-b'), record('task-c')]);
  for (const entity of sources[0].entities.values) positionIsAnchored(entity);
  const offsets = sources[0].entities.values
    .map(entity => entity.billboard.pixelOffset.getValue(time))
    .sort((a, b) => a.x - b.x);
  assert.ok(offsets.every(offset => offset.y === 0), 'coincident markers stay in one row');
  assert.ok(offsets.slice(1).every((offset, index) => offset.x - offsets[index].x <= 16),
    'the row uses compact spacing');
  positionIsAnchored(sources[1].entities.values[0]);
  layer.highlightById(null);
  layer.show(null);
  for (const entity of sources[0].entities.values) positionIsAnchored(entity);
  layer.destroy();
});
