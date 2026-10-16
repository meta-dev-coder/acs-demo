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

const snap = async l => page.evaluate(label => {
  const si = window.__safetyIntel;
  const source = window.__viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  const ids = source.entities.values.map(e => String(e.id));
  return { label,
    places: ids.filter(id => id.startsWith('place:')).length,
    members: ids.filter(id => id.startsWith('member:')).length,
    openedBadgeDrawn: si.state.openedPlaceId
      ? ids.includes(`place:${si.state.openedPlaceId}`) : null,
    opened: si.state.openedPlaceId,
    tab: si.state.tab,
    sel: si.selection.selectionType,
    totalPlaces: si.analysis().places.length,
    labVisible: /Incident being simulated/i.test(document.querySelector('.si-analysis-body').innerText),
  };
}, l);

console.log('1 arrival ', JSON.stringify(await snap('arrival')));
const id = await page.evaluate(() => window.__safetyIntel.analysis().places[0].id);
await page.evaluate(placeId => window.__safetyIntel.selectPlaceById(placeId), id);
await page.waitForTimeout(4000);
console.log('2 opened  ', JSON.stringify(await snap('opened')));
await page.screenshot({ path: 'scratchpad/badge-opened.png' });
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const place = si.analysis().places.find(p => p.id === si.state.openedPlaceId);
  si.selectIncidentById(place.facts[0].id, { keepOpenPlace: true });
});
await page.waitForTimeout(3500);
console.log('3 incident', JSON.stringify(await snap('incident')));
await page.screenshot({ path: 'scratchpad/badge-incident.png' });
await page.evaluate(() => window.__safetyIntel.clearSelection());
await page.waitForTimeout(2500);
console.log('4 cleared ', JSON.stringify(await snap('cleared')));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 5).join('\n') : 'no page errors');
await browser.close();
