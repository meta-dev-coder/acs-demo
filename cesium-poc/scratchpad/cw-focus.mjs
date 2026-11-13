import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('acsDemoCases')?.length ?? 0) > 0, null, { timeout: 180000 });

// Reproduce the reported path: a stale incident selected on Operations Overview first.
await page.waitForFunction(() => window.__maintenance.recordsOf('incidents').some(r => Number.isFinite(r.latitude)),
  null, { timeout: 60000 });
await page.evaluate(async () => {
  const rec = window.__maintenance.recordsOf('incidents').find(r => Number.isFinite(r.latitude));
  await window.__assetExplorer.revealRecord('incidentRecord', rec.id);
});
await page.waitForFunction(() => window.__assetExplorer.store.getState().selectedAsset != null, null, { timeout: 30000 });
const stale = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset.id);
console.log('stale selection before any case:', stale);

const toCases = async () => {
  await page.getByRole('tab', { name: 'Case Management' }).click();
  await page.waitForSelector('.case-workbench:not([hidden]) .cw-row', { state: 'visible' });
};
await toCases();

const expected = await page.evaluate(() => Object.fromEntries(
  window.__maintenance.recordsOf('acsDemoCases').map(r => [r.id, {
    asset: r.demoCase.asset.assetType,
    incidentId: r.evaluation.location.sourceIncidentId,
    incidentType: r.evaluation.location.sourceIncidentType,
    lon: r.evaluation.location.longitude, lat: r.evaluation.location.latitude,
    status: r.evaluation.presentation.label,
  }])));

const ids = Object.keys(expected);
let bad = 0;
for (const id of ids) {
  await page.click(`.cw-row[data-case="${id}"]`);
  await page.waitForFunction(c => document.querySelector('.cw-head h2')?.textContent === c, id, { timeout: 20000 });
  await page.evaluate(() => {
    window.__camProbe = null;
    const p = window.__viewer.camera.positionWC;
    window.__camStart = { x: p.x, y: p.y, z: p.z };
  });
  await page.click('.cw-action[data-action="view-on-map"]');
  await page.waitForSelector('.cw-focus:not([hidden])', { state: 'visible', timeout: 20000 });
  // Wait for the camera to stop moving. `camera.flying` is not a Cesium property; the honest
  // signal is the position no longer changing between frames.
  await page.waitForFunction(() => {
    const p = window.__viewer.camera.positionWC;
    const last = window.__camProbe;
    window.__camProbe = { x: p.x, y: p.y, z: p.z };
    const start = window.__camStart;
    // It has to have STARTED before "stopped" means anything: two samples taken before the flight
    // begins are identical, which is how the first case reported a camera 14 km from its target.
    const moved = !start || Math.hypot(start.x - p.x, start.y - p.y, start.z - p.z) > 1;
    return moved && last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5 && Math.abs(last.z - p.z) < 0.5;
  }, null, { timeout: 30000, polling: 250 });

  const actual = await page.evaluate(() => {
    const card = document.querySelector('.cw-focus');
    const v = window.__viewer;
    const carto = v.camera.positionCartographic;
    const deg = r => r * 180 / Math.PI;
    const st = window.__assetExplorer.store.getState();
    const drawn = window.__maintenance.drawnRecords?.() ?? null;
    return {
      cardCase: card.querySelector('h2').textContent,
      cardStatus: card.querySelector('.cw-focus-status').textContent,
      cardAsset: card.querySelector('.cw-focus-asset').textContent,
      cardSource: card.querySelector('.cw-focus-source p strong').textContent,
      distinguishes: /different event from this case|reuses only its location/i.test(card.textContent),
      action: !!card.querySelector('[data-action="return-to-case"]'),
      camLon: deg(carto.longitude), camLat: deg(carto.latitude),
      explorerSelection: st.selectedAsset?.id ?? null,
      explorerType: st.activeExplorerType ?? null,
      incidentCard: !!document.querySelector('.asset-explorer-host .MuiPaper-root'),
      stripCards: [...document.querySelectorAll('.maintenance-workspace [data-kpi]')].filter(b => !b.hidden).length,
      aomPanel: (document.querySelector('.aom-panel')?.innerHTML ?? '').length,
      drawn,
    };
  });
  const want = expected[id];
  const metres = (aLon, aLat, bLon, bLat) => {
    const toRad = d => d * Math.PI / 180;
    const x = toRad(bLon - aLon) * Math.cos(toRad((aLat + bLat) / 2));
    return Math.hypot(x, toRad(bLat - aLat)) * 6371008.8;
  };
  const offsetM = Math.round(metres(actual.camLon, actual.camLat, want.lon, want.lat));
  const ok = actual.cardCase === id && actual.cardSource === want.incidentId
    && offsetM < 250 && !actual.explorerSelection && !actual.incidentCard
    && actual.stripCards === 0 && actual.aomPanel === 0 && actual.distinguishes && actual.action;
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK ' : 'BAD'} ${id} src=${actual.cardSource}/${want.incidentId} ` +
    `camOffset=${offsetM}m sel=${actual.explorerSelection} ` +
    `incidentCard=${actual.incidentCard} strip=${actual.stripCards} panel=${actual.aomPanel} ` +
    `distinct=${actual.distinguishes} drawn=${JSON.stringify(actual.drawn)}`);

  await page.click('[data-action="return-to-case"]');
  await page.waitForFunction(c => !document.querySelector('.case-workbench').hidden
    && document.querySelector('.cw-head h2')?.textContent === c, id, { timeout: 20000 });
}
console.log(bad ? `${bad} CASES FAILED` : 'all seven correct');
console.log('ERRORS', errors.slice(0, 4));
await browser.close();
