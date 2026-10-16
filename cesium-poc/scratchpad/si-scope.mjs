import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2000);

const state = () => page.evaluate(() => {
  const si = window.__safetyIntel; const a = si.analysis();
  const kpi = document.querySelector('.si-kpi-value');
  return { scope: si.selection.scope, scoped: a.scoped.facts.length, label: a.scoped.label,
    openedPlace: si.state.openedPlaceId, tab: si.state.tab,
    kpi: kpi ? kpi.textContent.trim() : null };
});

// Open a place that holds more than one record, note its count.
const placeId = await page.evaluate(() => {
  const p = window.__safetyIntel.analysis().places.find(x => x.records > 2 && x.records < 12);
  return p?.id ?? window.__safetyIntel.analysis().places[0].id;
});
await page.evaluate(id => window.__safetyIntel.selectPlaceById(id), placeId);
await page.waitForTimeout(3500);
const opened = await state();
console.log('1 place opened        ', JSON.stringify(opened));

// Select one of its records (as clicking a pin does) — the Lab opens.
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const place = si.analysis().places.find(p => p.id === si.state.openedPlaceId);
  si.selectIncidentById(place.facts[0].id, { keepOpenPlace: true });
});
await page.waitForTimeout(3000);
console.log('2 record in the place ', JSON.stringify(await state()));

// Back to Accidents — the count must still be the place's.
await page.click('[data-tab="accidents"]');
await page.waitForTimeout(2500);
const back = await state();
console.log('3 back on Accidents   ', JSON.stringify(back));
console.log(back.scoped === opened.scoped
  ? `PASS — still ${back.scoped} records, not widened`
  : `FAIL — was ${opened.scoped}, now ${back.scoped}`);
await page.screenshot({ path: 'scratchpad/scope.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
