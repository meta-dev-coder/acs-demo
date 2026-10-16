import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectPlaceById(si.analysis().places[0].id);
});
await page.waitForTimeout(3500);
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const place = si.analysis().places.find(p => p.id === si.state.openedPlaceId);
  si.selectIncidentById(place.facts[0].id, { keepOpenPlace: true });
});
await page.waitForTimeout(2500);
console.log(JSON.stringify(await page.evaluate(() => {
  const v = window.__viewer;
  const source = v.dataSources.getByName('I-595 Safety Intelligence')[0];
  const t = v.clock.currentTime;
  const shown = source.entities.values.filter(e => e.label
    && (e.label.show === undefined || e.label.show?.getValue?.(t) !== false));
  return shown.map(e => ({ id: String(e.id), text: e.label.text?.getValue?.(t) }));
}), null, 1));
await browser.close();
