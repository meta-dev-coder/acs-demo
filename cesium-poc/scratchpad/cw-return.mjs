import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('acsDemoCases')?.length ?? 0) > 0, null, { timeout: 180000 });
await page.getByRole('tab', { name: 'Case Management' }).click();
await page.waitForSelector('.case-workbench:not([hidden]) .cw-row');

// Set up context worth preserving: a queue filter, a search, a case, an extra open stage, a scroll.
await page.click('.cw-bucket[data-bucket="action"]');
await page.fill('.cw-search', 'demo-00');
await page.waitForFunction(() => document.querySelectorAll('.cw-row').length > 0);
await page.click('.cw-row[data-case="ACS-DEMO-003"]');
await page.waitForFunction(() => document.querySelector('.cw-head h2')?.textContent === 'ACS-DEMO-003');
await page.waitForFunction(() => document.querySelectorAll('.cw-timeline details').length === 4);
await page.click('.cw-stages button[data-stage="INSPECTION"]');          // open an extra stage
await page.waitForFunction(() => document.querySelector('details[data-stage="INSPECTION"]').open);
await page.evaluate(() => { document.querySelector('.cw-main').scrollTop = 900; });
await page.waitForFunction(() => document.querySelector('.cw-main').scrollTop > 600);

const before = await page.evaluate(() => ({
  case: document.querySelector('.cw-head h2').textContent,
  bucket: document.querySelector('.cw-bucket[aria-pressed="true"]').dataset.bucket,
  search: document.querySelector('.cw-search').value,
  rows: document.querySelectorAll('.cw-row').length,
  open: [...document.querySelectorAll('.cw-timeline details')].filter(d => d.open).map(d => d.dataset.stage),
  mainScroll: Math.round(document.querySelector('.cw-main').scrollTop),
}));
console.log('before:', JSON.stringify(before));

await page.click('.cw-action[data-action="view-on-map"]');
await page.waitForSelector('.cw-focus:not([hidden])');
await page.click('[data-action="return-to-case"]');
await page.waitForFunction(() => !document.querySelector('.case-workbench').hidden);
await page.waitForFunction(() => document.querySelector('.cw-head h2')?.textContent === 'ACS-DEMO-003');

const after = await page.evaluate(() => ({
  case: document.querySelector('.cw-head h2').textContent,
  bucket: document.querySelector('.cw-bucket[aria-pressed="true"]').dataset.bucket,
  search: document.querySelector('.cw-search').value,
  rows: document.querySelectorAll('.cw-row').length,
  open: [...document.querySelectorAll('.cw-timeline details')].filter(d => d.open).map(d => d.dataset.stage),
  mainScroll: Math.round(document.querySelector('.cw-main').scrollTop),
}));
console.log('after: ', JSON.stringify(after));
console.log('preserved:', JSON.stringify(before) === JSON.stringify(after));

// Rapid switching: never settle, then check the card matches the last case asked for.
for (const id of ['ACS-DEMO-001','ACS-DEMO-004','ACS-DEMO-002','ACS-DEMO-003','ACS-DEMO-001']) {
  await page.click('.cw-bucket[data-bucket="all"]');
  await page.click(`.cw-row[data-case="${id}"]`);
}
await page.waitForFunction(() => document.querySelector('.cw-head h2')?.textContent === 'ACS-DEMO-001');
console.log('rapid switching lands on:', await page.evaluate(() => document.querySelector('.cw-head h2').textContent));

// Rapid View on map / Return, three times, no settling in between.
for (let i = 0; i < 3; i += 1) {
  await page.click('.cw-action[data-action="view-on-map"]');
  await page.waitForSelector('.cw-focus:not([hidden])');
  await page.click('[data-action="return-to-case"]');
  await page.waitForFunction(() => !document.querySelector('.case-workbench').hidden);
}
console.log('after 3 round trips:', JSON.stringify(await page.evaluate(() => ({
  case: document.querySelector('.cw-head h2').textContent,
  focusHidden: document.querySelector('.cw-focus').hidden,
  stripRestored: [...document.querySelectorAll('.maintenance-workspace [data-kpi]')].filter(b => !b.hidden).length,
}))));

// Leaving focus by another route must put the operational map back.
await page.click('.cw-action[data-action="view-on-map"]');
await page.waitForSelector('.cw-focus:not([hidden])');
await page.getByRole('tab', { name: 'Claims Intelligence' }).click();
await page.waitForFunction(() => document.querySelector('.cw-focus').hidden);
await page.getByRole('tab', { name: 'Operations Overview' }).click();
await page.waitForFunction(() => (document.querySelector('.aom-panel')?.innerHTML ?? '').length > 0);
console.log('focus left via another tab:', JSON.stringify(await page.evaluate(() => ({
  focusHidden: document.querySelector('.cw-focus').hidden,
  strip: [...document.querySelectorAll('.maintenance-workspace [data-kpi]')].filter(b => !b.hidden).length,
  panel: (document.querySelector('.aom-panel')?.innerHTML ?? '').length > 0,
}))));
console.log('ERRORS', errors.slice(0, 4));
await browser.close();
