import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForTimeout(6000);
console.log(JSON.stringify(await p.evaluate(() =>
  [...document.querySelectorAll('.app-role select option')].map(o => `${o.value} = ${o.textContent}`)), null, 1));
await b.close();
