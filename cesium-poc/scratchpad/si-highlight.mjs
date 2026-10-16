import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(4000);

const marks = () => page.evaluate(() => {
  const v = window.__viewer;
  const source = v.dataSources.getByName('I-595 Safety Intelligence')[0];
  const ids = source.entities.values.map(e => String(e.id));
  const ring = source.entities.values.find(e => /^record:[^:]+$/.test(String(e.id)));
  return {
    record: ids.filter(id => id.startsWith('record:')),
    ringWidth: ring?.billboard?.width?.getValue?.(v.clock.currentTime) ?? null,
    hasLabel: Boolean(ring?.label),
    sel: window.__safetyIntel.selection.selectionType,
  };
});
console.log('before   ', JSON.stringify(await marks()));
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectIncidentById(si.analysis().hotspots.clusters[0].facts[0].id);
});
await page.waitForTimeout(3500);
console.log('selected ', JSON.stringify(await marks()));
await page.screenshot({ path: 'scratchpad/highlight-incident.png' });
// From inside an open place, too.
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectPlaceById(si.analysis().places[0].id);
});
await page.waitForTimeout(3500);
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const place = si.analysis().places.find(p => p.id === si.state.openedPlaceId);
  si.selectIncidentById(place.facts[1].id, { keepOpenPlace: true });
});
await page.waitForTimeout(3000);
console.log('in place ', JSON.stringify(await marks()));
await page.screenshot({ path: 'scratchpad/highlight-in-place.png' });
await page.evaluate(() => window.__safetyIntel.clearSelection());
await page.waitForTimeout(2000);
console.log('cleared  ', JSON.stringify(await marks()));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 5).join('\n') : 'no page errors');
await browser.close();
