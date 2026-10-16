import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const f = si.analysis().hotspots.clusters[0].facts.find(x => x.laneClosureHours)
    ?? si.analysis().hotspots.clusters[0].facts[0];
  si.selectIncidentById(f.id);
});
await page.waitForTimeout(3000);
await page.click('[data-lab-tab="response"]');
await page.waitForTimeout(600);
const body = await page.$eval('.lab-panel', el => el.innerText);
// innerText applies CSS text-transform, so the h4 headings arrive uppercased.
const lower = body.toLowerCase();
const order = ['Response timeline', 'Critical path', 'Queue over time', 'Secondary-incident exposure',
  'Explain these numbers', 'Sensitivity', 'Finding a better response', 'Scenario comparison']
  .map(s => [s, lower.indexOf(s.toLowerCase())]);
console.log('Response Analysis order:'); for (const [s, i] of order) console.log(`  ${i >= 0 ? 'ok ' : 'MISSING'} ${s}`);
console.log('in order:', order.every((e, i) => i === 0 || e[1] > order[i - 1][1]));
console.log('sensitivity collapsed by default:',
  await page.$eval('.sim-sensitivity-block', el => !el.open));
// open it and measure the header wrapping
await page.click('.sim-sensitivity-block > summary');
await page.waitForTimeout(400);
console.log('sensitivity headers:', JSON.stringify(await page.$$eval('.sim-sensitivity thead th', ns =>
  ns.map(n => {
    // Two lines is the design (an explicit <br>); three means it wrapped.
    // Does it wrap? Compare the rendered height with two lines' worth (the explicit <br>).
    const lh = parseFloat(getComputedStyle(n).lineHeight);
    const h = n.getBoundingClientRect().height - parseFloat(getComputedStyle(n).paddingTop)
      - parseFloat(getComputedStyle(n).paddingBottom);
    return { text: n.innerText.replace(/\n/g, ' | '), w: Math.round(n.getBoundingClientRect().width),
      lines: Math.round(h / lh), wraps: Math.round(h / lh) > (n.innerHTML.includes('<br>') ? 2 : 1) };
  }))));
await page.screenshot({ path: 'scratchpad/final-response.png' });
await page.click('[data-lab-tab="traffic"]');
await page.waitForTimeout(500);
const traffic = await page.$eval('.lab-panel', el => el.innerText);
console.log('traffic has queue CHART element:', (await page.$$('.lab-panel .sim-queue')).length,
  '| says inputs do not change:', /do not change/.test(traffic));
await page.screenshot({ path: 'scratchpad/final-traffic.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
