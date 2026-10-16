import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(6000);

const marks = () => page.evaluate(() => {
  const v = window.__viewer;
  for (let i = 0; i < v.dataSources.length; i++) {
    const s = v.dataSources.get(i);
    if (s.name === 'I-595 Safety Intelligence') {
      const kinds = {};
      for (const e of s.entities.values) {
        const k = String(e.id).split(':')[0];
        kinds[k] = (kinds[k] ?? 0) + 1;
      }
      return { total: s.entities.values.length, kinds };
    }
  }
  return null;
});
const state = () => page.evaluate(() => {
  const si = window.__safetyIntel; const a = si.analysis();
  return { places: a.places.length, biggest: a.places[0] && { count: a.places[0].count, records: a.places[0].records, defects: a.places[0].openDefects, hazards: a.places[0].hazardFindings, band: a.places[0].band.id, spread: a.places[0].spreadMeters },
    sel: si.selection.selectionType, placeId: si.selection.placeId, scopedRecords: a.scoped.facts.length,
    camHeight: Math.round(window.__viewer.camera.positionCartographic.height) };
});
console.log('collapsed', JSON.stringify(await marks()), JSON.stringify(await state()));
await page.screenshot({ path: 'scratchpad/map-collapsed.png' });

// Open the biggest place from the map
const id = await page.evaluate(() => window.__safetyIntel.analysis().places[0].id);
await page.evaluate(placeId => window.__safetyIntel.selectPlaceById(placeId), id);
await page.waitForTimeout(5000);
console.log('opened   ', JSON.stringify(await marks()), JSON.stringify(await state()));
await page.screenshot({ path: 'scratchpad/map-opened.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 6).join('\n') : 'no page errors');
await browser.close();
