import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 180)));
await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('acsDemoCases')?.length ?? 0) > 0, null, { timeout: 180000 });

/** Every surface that can present a primary record. At most one may be up. */
const look = () => page.evaluate(() => {
  const vis = el => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
  const papers = [...document.querySelectorAll('.asset-explorer-host .MuiPaper-root')]
    .map(el => el.getBoundingClientRect()).filter(r => r.width > 250 && r.height > 140);
  const st = window.__assetExplorer.store.getState();
  const surfaces = [
    vis(document.querySelector('.case-workbench:not(.case-workbench--claims)')) && 'caseWorkbench',
    vis(document.querySelector('.case-workbench--claims')) && 'claimsWorkbench',
    vis(document.querySelector('.cw-focus')) && 'caseOnMap',
    papers.length > 0 && 'explorer',
    !!document.querySelector('.MuiDialog-root') && 'modal',
  ].filter(Boolean);
  return {
    surfaces,
    tab: document.querySelector('.aom-tabs [aria-selected="true"]')?.textContent,
    case: document.querySelector('.case-workbench:not(.case-workbench--claims) .cw-head h2')?.textContent ?? null,
    claim: document.querySelector('.case-workbench--claims .cw-head h2')?.textContent ?? null,
    explorerSel: st.selectedAsset?.id ?? null,
  };
});

let failures = 0;
const step = async (name, fn, expect) => {
  await fn();
  const seen = await look();
  const many = seen.surfaces.filter(s => s !== 'caseWorkbench' || true).length;
  const ok = many <= 1 && (!expect || expect(seen));
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK ' : 'BAD'} ${name.padEnd(34)} surfaces=[${seen.surfaces}] tab=${seen.tab} case=${seen.case} claim=${seen.claim} sel=${seen.explorerSel}`);
};

const tab = async name => {
  await page.getByRole('tab', { name }).click();
  await page.waitForFunction(n => document.querySelector('.aom-tabs [aria-selected="true"]')?.textContent === n, name);
};

await step('1 case management', async () => {
  await tab('Case Management');
  await page.waitForSelector('.case-workbench:not([hidden]) .cw-row');
  await page.click('.cw-row[data-case="ACS-DEMO-003"]');
  await page.waitForFunction(() => document.querySelector('.cw-head h2')?.textContent === 'ACS-DEMO-003');
}, s => s.case === 'ACS-DEMO-003' && s.surfaces[0] === 'caseWorkbench');

await step('2 view on map', async () => {
  await page.click('.cw-action[data-action="view-on-map"]');
  await page.waitForSelector('.cw-focus:not([hidden])');
}, s => s.surfaces[0] === 'caseOnMap' && !s.explorerSel);

await step('3 return to case', async () => {
  await page.click('[data-action="return-to-case"]');
  await page.waitForFunction(() => !document.querySelector('.case-workbench').hidden);
}, s => s.case === 'ACS-DEMO-003');

await step('4 claims intelligence', async () => {
  await tab('Claims Intelligence');
  await page.waitForSelector('.case-workbench--claims:not([hidden]) .cw-row');
}, s => s.surfaces[0] === 'claimsWorkbench');

await step('5 select a claim', async () => {
  await page.click('.case-workbench--claims .cw-row[data-claim="ACS-DEMO-004"]');
  await page.waitForFunction(() => document.querySelector('.case-workbench--claims .cw-head h2') != null);
}, s => s.surfaces.length === 1 && s.claim?.includes('DEMO-CLM-0004'));

const linkedIncident = await page.evaluate(() =>
  document.querySelector('[data-action="open-linked-incident"]').textContent.trim().split(' ').pop());
await step('6 view linked incident', async () => {
  await page.click('[data-action="open-linked-incident"]');
  await page.waitForFunction(() => window.__assetExplorer.store.getState().selectedAsset != null, null, { timeout: 20000 });
}, s => s.tab === 'Operations Overview' && s.explorerSel === linkedIncident && s.surfaces.join() === 'explorer');

await step('7 back to claims, open linked case', async () => {
  await tab('Claims Intelligence');
  await page.waitForSelector('.case-workbench--claims:not([hidden])');
  await page.click('[data-action="open-linked-case"]');
  await page.waitForFunction(() => !document.querySelector('.case-workbench:not(.case-workbench--claims)').hidden);
}, s => s.tab === 'Case Management' && s.case === 'ACS-DEMO-004');

await step('8 return to claims', async () => {
  await tab('Claims Intelligence');
  await page.waitForSelector('.case-workbench--claims:not([hidden]) .cw-head h2');
}, s => s.claim?.includes('DEMO-CLM-0004'));

await step('9 a different claim', async () => {
  await page.click('.case-workbench--claims .cw-row[data-claim="ACS-DEMO-005"]');
  await page.waitForFunction(() => document.querySelector('.case-workbench--claims .cw-head h2')?.textContent.includes('0005'));
}, s => s.surfaces.length === 1);

await step('10 rapid tab switching', async () => {
  for (let i = 0; i < 3; i += 1) {
    for (const name of ['Operations Overview', 'Case Management', 'Claims Intelligence']) {
      await page.getByRole('tab', { name }).click();
    }
  }
  await page.waitForFunction(() => document.querySelector('.aom-tabs [aria-selected="true"]')?.textContent === 'Claims Intelligence');
});

await step('11 incident from the explorer', async () => {
  await tab('Operations Overview');
  await page.waitForFunction(() => window.__maintenance.recordsOf('incidents').some(r => Number.isFinite(r.latitude)));
  await page.evaluate(async () => {
    const rec = window.__maintenance.recordsOf('incidents').find(r => Number.isFinite(r.latitude));
    await window.__assetExplorer.revealRecord('incidentRecord', rec.id);
  });
  await page.waitForFunction(() => window.__assetExplorer.store.getState().selectedAsset != null);
}, s => s.surfaces.join() === 'explorer');

await step('12 straight to case management', async () => {
  await tab('Case Management');
  await page.waitForSelector('.case-workbench:not(.case-workbench--claims):not([hidden])');
}, s => s.surfaces.join() === 'caseWorkbench');

await step('13 the whole loop again', async () => {
  await page.click('.cw-row[data-case="ACS-DEMO-002"]');
  await page.waitForFunction(() => document.querySelector('.cw-head h2')?.textContent === 'ACS-DEMO-002');
  await page.click('.cw-action[data-action="view-on-map"]');
  await page.waitForSelector('.cw-focus:not([hidden])');
  await page.click('[data-action="return-to-case"]');
  await page.waitForFunction(() => !document.querySelector('.case-workbench').hidden);
}, s => s.case === 'ACS-DEMO-002' && s.surfaces.join() === 'caseWorkbench');

console.log(failures ? `${failures} STEPS FAILED` : 'every step: exactly one detail surface');
console.log('ERRORS', errors.slice(0, 4));
await browser.close();
