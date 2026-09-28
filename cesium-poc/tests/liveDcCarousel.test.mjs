import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCarouselCameras, parseTooltipHtml } from '../server/fl511Tooltip.mjs';
import { attachDetails } from '../server/liveEvents.mjs';

const HTML = readFileSync(new URL('./fixtures/fl511-tooltip-incident-carousel.html', import.meta.url), 'utf8');

test('carousel: every FL511 camera with its id, title, description and DIVAS channel, in FL511 order', () => {
  assert.deepEqual(parseCarouselCameras(HTML), [
    { cameraId: '2871', title: 'Tpke MM 76.2 at Glades Rd', description: '091-076_2-SB-IPV', divasChanId: '5560' },
    { cameraId: '4283', title: 'Tpke MM 76.3', description: '091-076_3-NB-IPV', divasChanId: '11065' },
    { cameraId: '5233', title: 'Tpke MM 75.5', description: '091-075_5-SB-IPV', divasChanId: '11949' },
  ]);
});

test('carousel: absent, empty or malformed markup gives no cameras', () => {
  assert.deepEqual(parseCarouselCameras(''), []);
  assert.deepEqual(parseCarouselCameras(null), []);
  assert.deepEqual(parseCarouselCameras('<div class="cctvCameraCarousel"><button data-camera-id="3934">Show Video</button></div>'), []);
  const noVideo = '<div id="carouselDiv-77"><img data-lazy="/map/Cctv/77" data-fs-title="A &amp; B" /></div>';
  assert.deepEqual(parseCarouselCameras(noVideo), [{ cameraId: '77', title: 'A & B', description: null, divasChanId: null }]);
});

test('parseTooltipHtml keeps its existing output and adds cameras only when FL511 listed some', () => {
  const detail = parseTooltipHtml(HTML);
  assert.equal(detail.title, 'Incident');
  assert.match(detail.description, /^Crash in Palm Beach County on Floridas Turnpike North/);
  assert.deepEqual(detail.fields.map(f => f.label), ['Severity', 'Region', 'Start Time', 'Last Updated']);
  assert.deepEqual(detail.cameras.map(c => c.cameraId), ['2871', '4283', '5233']);
  const plain = parseTooltipHtml('<h4>Incident</h4><table><tr><td colspan="2">Crash</td></tr></table>');
  assert.deepEqual(plain, { title: 'Incident', description: 'Crash', fields: [] });
});

test('attachDetails carries the carousel as fl511Cameras, and nothing when there is none', () => {
  const base = { id: 'FL511-INCIDENT-1', type: 'INCIDENT', rawSourceId: '1' };
  const withCameras = attachDetails(base, parseTooltipHtml(HTML));
  assert.deepEqual(withCameras.fl511Cameras.map(c => c.divasChanId), ['5560', '11065', '11949']);
  const without = attachDetails(base, { title: 'Incident', fields: [] });
  assert.equal('fl511Cameras' in without, false);
});
