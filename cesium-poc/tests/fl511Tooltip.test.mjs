import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTooltipHtml, fieldValue } from '../server/fl511Tooltip.mjs';
import { parseMapIcons } from '../server/fl511Client.mjs';

// Captured verbatim from https://fl511.com/tooltip/Closures/845752?lang=en-US (2026-09-09), with
// the camera-carousel row kept so the parser is exercised against the markup FL511 really sends.
const CLOSURE_HTML = `
<div class="row event"><div class="col-md-12"><div class="map-tooltip">
  <h4><img src="/Content/Images/ic_closure.svg" alt="Closure" />&nbsp;Closure</h4>
  <table class="table-condensed table-striped"><tbody>
    <tr><td colspan="2">Planned construction in Broward County on 95 Express South, ramp from I-595 Mainline/Tpk/US-441. On-ramp closed. Last updated at 09:15 PM.</td></tr>
    <tr><th scope="row">Severity</th><td>Major</td></tr>
    <tr><th scope="row">Region</th><td>Southeast</td></tr>
    <tr><th scope="row">Start Time</th><td>Sep 8 2026, 9:15 PM</td></tr>
    <tr><th scope="row">Last Updated</th><td>Sep 8 2026, 9:15 PM</td></tr>
    <tr><td colspan="2"><div class="cctvCameraCarousel"><button class="showVideo" data-camera-id="3934">Show Video</button></div></td></tr>
  </tbody></table>
</div></div></div>`;

test('parses the fields FL511 actually printed', () => {
  const detail = parseTooltipHtml(CLOSURE_HTML);
  assert.equal(detail.title, 'Closure');
  assert.match(detail.description, /^Planned construction in Broward County on 95 Express South/);
  assert.deepEqual(detail.fields.map(field => field.label), ['Severity', 'Region', 'Start Time', 'Last Updated']);
  assert.equal(fieldValue(detail, 'severity'), 'Major');
  assert.equal(fieldValue(detail, 'Start Time'), 'Sep 8 2026, 9:15 PM');
});

test('does not invent rows FL511 omitted', () => {
  const detail = parseTooltipHtml(CLOSURE_HTML);
  assert.equal(fieldValue(detail, 'End Time'), undefined);
  assert.equal(fieldValue(detail, 'Lanes Blocked'), undefined);
  assert.equal(fieldValue(detail, 'Direction'), undefined);
});

test('skips the camera carousel when choosing the description', () => {
  const detail = parseTooltipHtml(CLOSURE_HTML);
  assert.ok(!detail.description.includes('Show Video'));
});

test('decodes entities and collapses markup inside a cell', () => {
  const detail = parseTooltipHtml('<h4>Incident</h4><table><tr><td colspan="2">Crash &amp; debris <b>blocking</b> the&nbsp;left lane</td></tr></table>');
  assert.equal(detail.description, 'Crash & debris blocking the left lane');
});

test('returns null rather than a guess when the fragment is unrecognisable', () => {
  assert.equal(parseTooltipHtml(''), null);
  assert.equal(parseTooltipHtml('<div class="wrapper"></div>'), null);
  assert.equal(parseTooltipHtml(null), null);
  assert.equal(fieldValue(null, 'Severity'), undefined);
});

test('accepts a valid mapIcons payload and keeps the secondary location', () => {
  const { items, skipped } = parseMapIcons({
    item1: { url: '/Generated/Content/Images/511/map_closure.svg' },
    item2: [
      { itemId: '461840', location: [26.3261769, -80.2030647], secondarylocation: [26.3326405, -80.2212114], icon: {}, title: '' },
      { itemId: '845745', location: [26.113127, -80.16884], icon: {}, title: '' },
    ],
  });
  assert.equal(skipped.length, 0);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    itemId: '461840', latitude: 26.3261769, longitude: -80.2030647,
    secondaryLatitude: 26.3326405, secondaryLongitude: -80.2212114,
  });
  assert.equal(items[1].secondaryLatitude, undefined);
});

test('one malformed item never fails the feed', () => {
  const { items, skipped } = parseMapIcons({
    item2: [
      { itemId: '1', location: [26.1, -80.1] },
      { itemId: '', location: [26.1, -80.1] },
      { itemId: '2', location: ['x', -80.1] },
      { itemId: '3', location: [999, -80.1] },
      { itemId: '4' },
      { itemId: '1', location: [26.2, -80.2] },
      null,
    ],
  });
  assert.deepEqual(items.map(item => item.itemId), ['1']);
  assert.deepEqual(skipped.map(entry => entry.reason), [
    'missing itemId', 'missing or invalid location', 'missing or invalid location',
    'missing or invalid location', 'duplicate itemId', 'entry is not an object',
  ]);
});

test('an invalid secondary location drops that point but keeps the event', () => {
  const { items } = parseMapIcons({ item2: [{ itemId: '9', location: [26.1, -80.1], secondarylocation: [0, 0] }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].secondaryLatitude, undefined);
});

test('a schema change is reported, not guessed around', () => {
  assert.throws(() => parseMapIcons({ items: [] }), /item2/);
  assert.throws(() => parseMapIcons('not json'), /JSON object/);
});
