import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const acs = JSON.parse(readFileSync('scratchpad/acs-rows.json', 'utf8'));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => document.querySelector('.si-loader')?.hidden === true,
  null, { timeout: 180000 });
console.log(JSON.stringify(await page.evaluate(acs => {
  const data = acs.slice(1).filter(r => Object.keys(r).length);
  const recs = window.__maintenance.recordsOf('incidents').filter(r => !r.live);
  const at = r => r.raw?.attributes ?? r.raw ?? r;
  const iso = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s ?? ''));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  // Register days inside the ACS window only — the fair baseline.
  const days2025 = new Set(recs.map(r => iso(at(r).incident_date))
    .filter(d => d && d >= '2025-02-01' && d <= '2025-12-31'));
  const windowDays = (new Date('2025-12-31') - new Date('2025-02-01')) / 86400000 + 1;
  const assets = window.__maintenance.assetIndex();
  // Distinct ACS tasks, and how many carry each identifier.
  const tasks = new Map();
  for (const r of data) if (r.A) tasks.set(r.A, [...(tasks.get(r.A) ?? []), r]);
  const has = (rows, c) => rows.some(r => r[c] && !/^n\/?a$/i.test(r[c]));
  const COORD = /([+-]?2[5-7]\.\d{3,})\s*,\s*([+-]?-?8[01]\.\d{3,})/;
  return {
    registerDaysInAcsWindow: days2025.size,
    acsWindowDays: windowDays,
    chancePerRow: +(days2025.size / windowDays).toFixed(3),
    expectedSameDayHitsFor42Rows: +(42 * days2025.size / windowDays).toFixed(1),
    distinctTasks: tasks.size,
    tasksWithCoordinates: [...tasks.values()].filter(rs => rs.some(r => COORD.test(r.J ?? ''))).length,
    tasksWithEventNumber: [...tasks.values()].filter(rs => has(rs, 'AM')).length,
    tasksWithPoliceCase: [...tasks.values()].filter(rs => has(rs, 'AK')).length,
    tasksWithHsmv: [...tasks.values()].filter(rs => has(rs, 'AL')).length,
    tasksWithAnyCost: [...tasks.values()].filter(rs => has(rs, 'AX') || has(rs, 'Q')).length,
    assetIndexSize: assets.size,
  };
}, acs), null, 1));
await browser.close();
