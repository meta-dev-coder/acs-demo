import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
for (const [w, h] of [[1680, 980], [1280, 860], [900, 800]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
  await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
  await page.selectOption('.app-role select', 'maintenanceTeam');
  await page.waitForFunction(() => (window.__maintenance.recordsOf('acsDemoCases')?.length ?? 0) > 0, null, { timeout: 180000 });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: 'Case Management' }).click();
  await page.waitForTimeout(3500);
  console.log(w, JSON.stringify(await page.evaluate(() => {
    const wb = document.querySelector('.case-workbench');
    const q = wb.querySelector('.cw-queue').getBoundingClientRect();
    const m = wb.querySelector('.cw-main').getBoundingClientRect();
    return { columns: getComputedStyle(wb).gridTemplateColumns.split(' ').length,
      queue: `${Math.round(q.width)}x${Math.round(q.height)}`, main: `${Math.round(m.width)}x${Math.round(m.height)}`,
      stacked: m.top > q.top + 20,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      viewers: document.querySelectorAll('.cesium-widget > canvas').length };
  })), 'errors:', errors.length);
  await page.screenshot({ path: `scratchpad/cw-${w}.png` });
  await page.close();
}
await browser.close();
