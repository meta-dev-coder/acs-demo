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

const snap = async l => page.evaluate(label => {
  const si = window.__safetyIntel; const v = window.__viewer;
  let kinds = {}, total = 0;
  for (let i = 0; i < v.dataSources.length; i++) {
    const s = v.dataSources.get(i);
    if (s.name === 'I-595 Safety Intelligence') {
      total = s.entities.values.length;
      for (const e of s.entities.values) { const k = String(e.id).split(':')[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
    }
  }
  const sectionEntity = [...(v.dataSources.getByName('I-595 Safety Intelligence')[0]?.entities.values ?? [])]
    .find(e => String(e.id).startsWith('section:'));
  return { label, total, kinds,
    sel: si.selection.selectionType, openedPlace: si.state.openedPlaceId,
    roads: ['mainline-eb', 'mainline-wb', 'express'].map(id => window.__layerStore.stateOf(id)),
    sectionName: sectionEntity?.name ?? null,
    sectionPoints: sectionEntity?.polyline?.positions?.getValue?.(v.clock.currentTime)?.length ?? null };
}, l);

console.log('1 arrival ', JSON.stringify(await snap('arrival')));
const id = await page.evaluate(() => window.__safetyIntel.analysis().places[0].id);
await page.evaluate(placeId => window.__safetyIntel.selectPlaceById(placeId), id);
await page.waitForTimeout(4500);
console.log('2 opened  ', JSON.stringify(await snap('opened')));
await page.screenshot({ path: 'scratchpad/fix-opened.png' });
// Click a member icon: the place must STAY open.
const memberId = await page.evaluate(() => {
  const v = window.__viewer;
  const s = v.dataSources.getByName('I-595 Safety Intelligence')[0];
  return String([...s.entities.values].find(e => String(e.id).startsWith('member:')).id);
});
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const place = si.analysis().places.find(p => p.id === si.state.openedPlaceId);
  si.selectIncidentById(place.facts[0].id, { keepOpenPlace: true });
});
await page.waitForTimeout(2500);
console.log('3 member  ', JSON.stringify(await snap('member-clicked')), 'memberId was', memberId);
await page.screenshot({ path: 'scratchpad/fix-member.png' });
await page.evaluate(() => window.__safetyIntel.clearSelection());
await page.waitForTimeout(2500);
console.log('4 cleared ', JSON.stringify(await snap('cleared')));
// Roads come back when leaving.
await page.selectOption('.app-role select', 'tmc');
await page.waitForTimeout(6000);
console.log('5 left    ', JSON.stringify(await page.evaluate(() => ({
  roads: ['mainline-eb', 'mainline-wb', 'express'].map(id => window.__layerStore.stateOf(id)) }))));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 6).join('\n') : 'no page errors');
await browser.close();
