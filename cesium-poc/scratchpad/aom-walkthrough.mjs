import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(3000);
const tab = n => page.evaluate(x => [...document.querySelectorAll('.aom-tabs button')].find(b => b.textContent.includes(x)).click(), n);
const say = (step, data) => console.log(`STEP ${step}:`, JSON.stringify(data));

// 1 corridor operations
say(1, await page.evaluate(() => ({ tab: document.querySelector('.aom-tabs [aria-selected="true"]').textContent,
  figures: [...document.querySelectorAll('.aom-kpi-label')].map(n => n.textContent.replace(/(Recorded|Derived|Inferred|Demo)$/,'')) })));

// widen so there is something to investigate
const widen = await page.$('[data-action="period-all"]');
if (widen) { await widen.click(); await page.waitForTimeout(2500); }

// 2 identify a problem: repeated damage
await page.evaluate(() => document.querySelector('[data-kpi-action="repeatedDamage"]')?.click());
await page.waitForTimeout(2500);
say(2, await page.evaluate(() => ({ activeKey: window.__maintenance.activeKey,
  repeated: [...document.querySelectorAll('.aom-panel [data-asset]')].slice(0,3).map(b => b.textContent.trim().split('\n')[0]),
  onMap: window.__assetExplorer.store.getState().assetsByType.incidentRecord?.length ?? 0 })));

// 3 open a case
await tab('Case'); await page.waitForTimeout(2000);
await page.evaluate(() => document.querySelector('.aom-panel [data-case]')?.click());
await page.waitForTimeout(2500);
say(3, await page.evaluate(() => ({ activeKey: window.__maintenance.activeKey,
  selected: window.__assetExplorer.store.getState().selectedAsset?.id,
  openBtn: !![...document.querySelectorAll('button')].find(b => /Open ACS Case/i.test(b.textContent)) })));

await page.getByRole('button', { name: /Open ACS case/i }).first().click();
await page.waitForTimeout(1500);
say('4 dialog', await page.evaluate(() => {
  const d = document.querySelector('.MuiDialog-root [role="dialog"]');
  return { nav: [...d.querySelectorAll('nav button')].map(b => b.textContent.trim()),
    firstPanel: d.querySelector('.MuiTypography-root')?.textContent };
}));

// 5 evidence recovery tab
await page.evaluate(() => [...document.querySelectorAll('.MuiDialog-root nav button')].find(b => /Evidence Recovery/.test(b.textContent)).click());
await page.waitForTimeout(3500);
say('5 evidence', await page.evaluate(() => document.querySelector('.MuiDialog-root [role="dialog"]').textContent.replace(/\s+/g,' ').slice(0, 260)));

// 6 incident context
await page.evaluate(() => [...document.querySelectorAll('.MuiDialog-root nav button')].find(b => /Incident Context/.test(b.textContent)).click());
await page.waitForTimeout(6000);
say('6 context', await page.evaluate(() => document.querySelector('.MuiDialog-root [role="dialog"]').textContent.replace(/\s+/g,' ').slice(0, 260)));

// 7 claims tab in the dialog, then Claims Intelligence
await page.evaluate(() => [...document.querySelectorAll('.MuiDialog-root nav button')].find(b => /Claims/.test(b.textContent)).click());
await page.waitForTimeout(1500);
say('7 claim', await page.evaluate(() => document.querySelector('.MuiDialog-root [role="dialog"]').textContent.replace(/\s+/g,' ').slice(0, 200)));
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
await tab('Claims'); await page.waitForTimeout(2000);
say('7 intelligence', await page.evaluate(() => ({
  blocks: [...document.querySelectorAll('.aom-block-title')].map(n => n.textContent),
  claimed: [...document.querySelectorAll('.aom-kpi')].map(n => n.textContent.match(/Total claimed/) ? n.querySelector('.aom-kpi-value').textContent : null).filter(Boolean) })));

// 8 back to operations
await tab('Operations'); await page.waitForTimeout(2500);
say(8, await page.evaluate(() => ({ tab: document.querySelector('.aom-tabs [aria-selected="true"]').textContent,
  activeKey: window.__maintenance.activeKey,
  selected: window.__assetExplorer.store.getState().selectedAsset?.id ?? null })));
console.log('ERRORS', errors);
await browser.close();
