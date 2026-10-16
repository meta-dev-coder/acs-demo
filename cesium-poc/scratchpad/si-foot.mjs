import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(38000);
const snap = async l => page.evaluate(label => {
  const pill = document.querySelector('.si-reopen-flat');
  return { label, footCollapsed: window.__safetyIntel.state.collapsed.foot,
    replayVisible: document.querySelector('.si-foot-replay').offsetHeight > 0,
    coverageVisible: document.querySelector('.si-foot-coverage').offsetHeight > 0,
    pill: pill.offsetHeight > 0 ? { text: pill.textContent.trim(), width: pill.offsetWidth } : null };
}, l);
console.log(JSON.stringify(await snap('arrival')));
await page.screenshot({ path: 'scratchpad/foot-collapsed.png' });
await page.click('.si-reopen-flat');
await page.waitForTimeout(600);
console.log(JSON.stringify(await snap('opened')));
await page.screenshot({ path: 'scratchpad/foot-open.png' });
await page.click('.si-collapse-foot');
await page.waitForTimeout(600);
console.log(JSON.stringify(await snap('closed-again')));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 5).join('\n') : 'no page errors');
await browser.close();
