import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
for (const width of [1680, 1440, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 980 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
  await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
  await page.selectOption('.app-role select', 'maintenanceTeam');
  await page.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0, null, { timeout: 180000 });
  await page.selectOption('.maintenance-window select', 'all');
  await page.waitForTimeout(3500);
  const geom = await page.evaluate(() => {
    const strip = document.querySelector('.maintenance-workspace .ws-kpis').getBoundingClientRect();
    const panel = document.querySelector('.aom-panel');
    const p = panel.getBoundingClientRect();
    const tabs = document.querySelector('.aom-tabs').getBoundingClientRect();
    return { stripRight: Math.round(strip.right), panelLeft: Math.round(p.left), panelShown: p.width > 0,
      overlapStripPanel: strip.right > p.left && p.width > 0,
      overlapTabsStrip: tabs.bottom > strip.top,
      stripRows: Math.round(strip.height / 56) };
  });
  console.log(width, JSON.stringify(geom), 'errors:', errors.length);
  await page.screenshot({ path: `scratchpad/aom-final-${width}.png` });
  await page.close();
}
await browser.close();
