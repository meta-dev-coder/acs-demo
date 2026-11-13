import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
for (const width of [1280, 1440, 1600, 1920]) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
  await p.waitForTimeout(7000);
  await p.selectOption('.app-role select', 'maintenanceTeam');
  await p.waitForTimeout(18000);
  const m = await p.evaluate(() => {
    const root = [...document.querySelectorAll('.ws-kpis')].find(r => r.offsetParent);
    const cards = [...root.querySelectorAll('.ws-kpi')];
    const period = root.querySelector('.maintenance-window');
    const top = el => Math.round(el.getBoundingClientRect().top);
    const rows = [...new Set(cards.map(top))].sort((a, b) => a - b);
    const demo = root.querySelector('[data-kpi="acsDemoCases"]');
    const risk = root.querySelector('[data-kpi="atRiskAssets"]');
    const d = demo.getBoundingClientRect();
    return {
      rows: rows.length,
      row1: cards.filter(c => top(c) === rows[0]).map(c => c.dataset.kpi),
      row2: rows[1] ? cards.filter(c => top(c) === rows[1]).map(c => c.dataset.kpi) : [],
      riskW: Math.round(risk.getBoundingClientRect().width),
      riskNote: risk.querySelector('[data-note]').textContent,
      periodTop: top(period), cardsTop: rows[0], aligned: top(period) === rows[0],
      demoInView: d.right <= window.innerWidth && d.left >= 0,
    };
  });
  console.log(width, JSON.stringify(m));
  if (width === 1440) await p.screenshot({ path: 'scratchpad/kpi-aligned.png', clip: { x: 0, y: 0, width, height: 210 } });
  await p.close();
}
await b.close();
