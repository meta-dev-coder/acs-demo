import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(4000);
const widths = () => page.evaluate(() => ({
  analysis: Math.round(document.querySelector('.si-analysis').getBoundingClientRect().width),
  map: Math.round(window.innerWidth
    - document.querySelector('.si-analysis').getBoundingClientRect().right
    - (window.innerWidth - document.querySelector('.si-side').getBoundingClientRect().left)),
  side: Math.round(document.querySelector('.si-side').getBoundingClientRect().width),
}));
console.log('accidents', JSON.stringify(await widths()));
await page.screenshot({ path: 'scratchpad/width-accidents.png' });
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectIncidentById(si.analysis().hotspots.clusters[0].facts.find(f => f.laneClosure).id);
});
await page.waitForTimeout(2500);
await page.click('[data-tab="lab"]');
await page.waitForTimeout(2500);
console.log('lab      ', JSON.stringify(await widths()));
await page.screenshot({ path: 'scratchpad/width-lab.png' });
await browser.close();
