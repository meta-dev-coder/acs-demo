import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/live-dc-status/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(38000);

const snap = async l => page.evaluate(label => ({
  label,
  navHidden: getComputedStyle(document.querySelector('.app-nav')).display === 'none',
  subLine: document.querySelector('.si-sub') ? 'present' : 'gone',
  kpiGroups: [...document.querySelectorAll('.si-kpi-group h3')].map(h => h.textContent.trim().split('\n')[0]),
  kpiTiles: document.querySelectorAll('.si-kpi').length,
  tab: window.__safetyIntel.state.tab,
  collapsed: { ...window.__safetyIntel.state.collapsed },
  analysisVisible: document.querySelector('.si-analysis-body').offsetWidth > 0,
  queueVisible: document.querySelector('.si-side-queue').offsetWidth > 0,
  reopenLabels: [...document.querySelectorAll('.si-reopen')].map(b => b.offsetWidth > 0 ? b.textContent.trim() : null),
}), l);

console.log(JSON.stringify(await snap('arrival')));
await page.screenshot({ path: 'scratchpad/ui-arrival.png' });
for (const tab of ['secondary', 'assets', 'patrol', 'outcomes']) {
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(700);
  console.log(JSON.stringify(await snap(tab)));
}
await page.screenshot({ path: 'scratchpad/ui-outcomes.png' });
await page.click('[data-tab="accidents"]');
await page.waitForTimeout(500);
// Collapse both.
await page.click('.si-analysis .si-collapse');
await page.click('.si-side .si-collapse');
await page.waitForTimeout(700);
console.log(JSON.stringify(await snap('both-collapsed')));
await page.screenshot({ path: 'scratchpad/ui-collapsed.png' });
// Reopen from the strips.
await page.click('.si-analysis .si-reopen');
await page.click('.si-side .si-reopen');
await page.waitForTimeout(700);
console.log(JSON.stringify(await snap('reopened')));
await page.screenshot({ path: 'scratchpad/ui-reopened.png' });
// Leaving restores the rail.
await page.selectOption('.app-role select', 'tmc');
await page.waitForTimeout(6000);
console.log('after leaving:', JSON.stringify(await page.evaluate(() => ({
  navHidden: getComputedStyle(document.querySelector('.app-nav')).display === 'none',
  section: document.body.dataset.section,
}))));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 8).join('\n') : 'no page errors');
await browser.close();
