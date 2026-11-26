import assert from 'node:assert/strict';
import test from 'node:test';
import { renderChatAnswer, ROWS_SHOWN } from '../src/ifcSpatial/chatAnswer.js';
import { focusLabelImage } from '../src/ifcSpatial/focusEffects.js';

const items = n => Array.from({ length: n }, (_, i) => ({ id: `TX-${i + 1}`, label: `Transformer TX-${i + 1}`, attrs: { 'data-asset': `TX-${i + 1}` } }));
const describe = it => ({ title: it.id, sub: 'Transformer · Main Substation', status: { label: 'Energized', tone: 'ok' }, icon: 'transformer' });

test('an answer starts with a sentence, then compact rows: four shown, the rest behind "View all", one provenance note', () => {
  const html = renderChatAnswer({ kind: 'Inventory', status: 'answered', say: 'I found 9 transformers across Seagirt.', say2: 'All nine are included in the map highlights.',
    groups: [{ label: 'Transformers', noun: 'transformers', tone: 'info', items: items(9), note: 'Locations are illustrative, not surveyed.' }] }, { describe });
  assert.ok(html.indexOf('I found 9 transformers across Seagirt.') < html.indexOf('tw-result'), 'the sentence comes first');
  assert.equal((html.match(/class="tw-row"/g) ?? []).length, 9);
  const [shown] = html.split('<details class="tw-more">');
  assert.equal((shown.match(/class="tw-row"/g) ?? []).length, ROWS_SHOWN);
  assert.match(html, /View all 9 transformers/);
  assert.equal((html.match(/Locations are illustrative, not surveyed\./g) ?? []).length, 1);
  assert.match(html, /9 found/);
  assert.match(html, /data-asset="TX-1"/, 'a row selects the asset through the existing handler');
  assert.doesNotMatch(html, /tw-sources/, 'no sources section without sources');
});

test('sources and assumptions are collapsed; text is escaped; the asset card reflects the focus state', () => {
  const html = renderChatAnswer({ say: '<b>x</b>', sources: ['IFC model a.ifc v4'], details: [{ title: 'Limitations and assumptions', items: ['Positions are illustrative.'] }] });
  assert.match(html, /<details class="tw-sources"><summary>/);
  assert.doesNotMatch(html, /<details class="tw-sources" open/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  const card = state => renderChatAnswer({ say: 'Here is TX-M1.', asset: { id: 'TX-M1', type: 'Transformer', icon: 'transformer', status: { label: 'Energized', tone: 'ok' }, rows: [{ k: 'Rating', v: '34.5/13.8 kV, 12 MVA' }], focus: { state }, docs: 1 } });
  assert.match(card('ok'), /Focused on map/);
  assert.match(card('ok'), /data-act="focusRecenter"/);
  assert.match(card('flying'), /Focusing the map/);
  assert.match(card('nogeo'), /No position in the model/);
  assert.match(card('idle'), /data-act="focusRetry"/);
  assert.match(card('ok'), /data-path="TX-M1"/);
  assert.match(card('ok'), /View documents \(1\)/);
  assert.match(renderChatAnswer({ status: 'loading', title: 'Comparing V3 and V4…' }), /aria-busy="true"/);
});

test('the floating focus label: id and type, on a connector, mirrored when flipped', () => {
  const right = focusLabelImage({ id: 'TX-M1', type: 'Transformer' });
  const left = focusLabelImage({ id: 'TX-M1', type: 'Transformer', flip: true });
  const svg = decodeURIComponent(right.url.split(',')[1]);
  assert.match(svg, />TX-M1</);
  assert.match(svg, />Transformer</);
  assert.match(svg, /#00e5ff/);
  assert.equal(right.width, left.width);
  assert.notEqual(right.url, left.url);
});

test('a collection: count and version, five rows then "+ N more", the selected row marked; nothing else', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `TX-${i}`, icon: 'transformer', status: i === 1 ? { label: 'Degraded', tone: 'warn' } : { label: 'Energized', tone: 'ok' } }));
  const html = renderChatAnswer({ say: 'I found 9 transformers across Seagirt and highlighted them on the map.',
    collection: { icon: 'transformer', title: '9 Transformers', sub: 'Across the terminal (IFC V4)', highlighted: true, rows, selectedId: 'TX-7', keyDetails: ['9 transformers in total.', '8 energized, 1 degraded (TX-1).'], note: 'Locations are modeled and may not represent surveyed positions.' } });
  assert.match(html, /aria-label="9 Transformers"/);
  assert.doesNotMatch(html, /tw-coll-h|tw-hl-badge/, 'no header: the sentence says it');
  const [shown] = html.split('<details class="tw-coll-more"');
  assert.equal((shown.match(/class="tw-crow[" ]/g) ?? []).length, 5);
  assert.match(html, /\+ 4 more \(TX-5, TX-6, TX-7, TX-8\)/);
  assert.match(html, /<details class="tw-coll-more" open>/, 'opened when the selection is in the folded part');
  assert.match(html, /class="tw-crow is-selected" data-asset="TX-7"/);
  assert.doesNotMatch(html, /Key details|data-act="askBack"|data-act="askClear"|tw-sources/, 'no key details, back / clear buttons or sources in the answer');
});
