import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0,
  null, { timeout: 180000 });
await page.waitForTimeout(3000);

const shot = async name => page.screenshot({ path: `scratchpad/aom-${name}.png` });

console.log('nav label:', await page.evaluate(() =>
  [...document.querySelectorAll('.app-nav-item .app-nav-label')].map(n => n.textContent)));

console.log('tabs:', await page.evaluate(() =>
  [...document.querySelectorAll('.aom-tabs button')].map(b => `${b.textContent}:${b.getAttribute('aria-selected')}`)));

const report = () => page.evaluate(() => {
  const panel = document.querySelector('.aom-panel');
  const tabs = document.querySelector('.aom-tabs');
  const strip = document.querySelector('.maintenance-workspace .ws-kpis');
  return {
    active: [...tabs.querySelectorAll('button')].find(b => b.getAttribute('aria-selected') === 'true')?.textContent,
    cards: [...document.querySelectorAll('.maintenance-workspace [data-kpi]')].filter(b => !b.hidden).map(b => b.dataset.kpi),
    tabsTop: Math.round(tabs.getBoundingClientRect().top),
    stripTop: Math.round(strip.getBoundingClientRect().top),
    overlap: tabs.getBoundingClientRect().bottom > strip.getBoundingClientRect().top,
    blocks: [...panel.querySelectorAll('.aom-block-title')].map(n => n.textContent),
    kpis: [...panel.querySelectorAll('.aom-kpi')].map(n => ({
      label: n.querySelector('.aom-kpi-label')?.textContent.trim(),
      value: n.querySelector('.aom-kpi-value')?.textContent.trim(),
    })),
    panelScroll: panel.scrollHeight > panel.clientHeight,
    text: panel.textContent.replace(/\s+/g, ' ').slice(0, 220),
  };
});

console.log('OPERATIONS', JSON.stringify(await report(), null, 1));
await shot('operations');

// widen the period
const widen = await page.$('[data-action="period-all"]');
if (widen) { await widen.click(); await page.waitForTimeout(2500); }
console.log('OPERATIONS all-time', JSON.stringify(await report(), null, 1));
await shot('operations-all');

// click a distribution bar
await page.evaluate(() => document.querySelector('.aom-panel [data-dimension]')?.click());
await page.waitForTimeout(1500);
console.log('after bar click:', await page.evaluate(() => ({
  chips: [...document.querySelectorAll('.aom-chip')].map(c => c.textContent.trim()),
  count: document.querySelector('.aom-count')?.textContent.trim(),
  activeCard: window.__maintenance.activeKey,
})));
await shot('operations-filtered');

// select an incident -> context block
await page.evaluate(async () => {
  const rec = window.__maintenance.recordsOf('incidents').find(r => Number.isFinite(r.latitude));
  await window.__assetExplorer.revealRecord('incidentRecord', rec.id);
});
await page.waitForTimeout(5000);
console.log('context block:', await page.evaluate(() => {
  const titles = [...document.querySelectorAll('.aom-block-title')].map(n => n.textContent);
  const facts = [...document.querySelectorAll('.aom-fact')].map(f => f.textContent.replace(/\s+/g,' ').trim());
  return { titles, facts: facts.slice(0, 24) };
}));
await shot('operations-context');

// Case Management
await page.evaluate(() => [...document.querySelectorAll('.aom-tabs button')].find(b => /Case/.test(b.textContent)).click());
await page.waitForTimeout(2000);
console.log('CASES', JSON.stringify(await report(), null, 1));
await shot('cases');

// open a case
await page.evaluate(() => document.querySelector('.aom-panel [data-case]')?.click());
await page.waitForTimeout(2500);
console.log('case selected:', await page.evaluate(() => ({
  activeKey: window.__maintenance.activeKey,
  selected: window.__assetExplorer?.store?.getState?.().selectedAsset?.id ?? null,
  openBtn: !![...document.querySelectorAll('button')].find(b => /Open ACS Case/i.test(b.textContent)),
})));
await shot('cases-selected');

// Claims
await page.evaluate(() => [...document.querySelectorAll('.aom-tabs button')].find(b => /Claims/.test(b.textContent)).click());
await page.waitForTimeout(1500);
console.log('CLAIMS', JSON.stringify(await report(), null, 1));
await shot('claims');

// back to operations: context preserved?
await page.evaluate(() => [...document.querySelectorAll('.aom-tabs button')].find(b => /Operations/.test(b.textContent)).click());
await page.waitForTimeout(2000);
console.log('back to operations:', await page.evaluate(() => ({
  activeKey: window.__maintenance.activeKey,
  selected: window.__assetExplorer?.store?.getState?.().selectedAsset?.id ?? null,
})));
await shot('back-to-operations');

console.log('ERRORS', errors.slice(0, 8));
await browser.close();
