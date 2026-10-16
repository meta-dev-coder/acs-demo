import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 140)); });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__tolling, null, { timeout: 60000 });
await page.waitForTimeout(16000);
await page.selectOption('.app-role select', 'tolling');
await page.waitForTimeout(22000);
console.log('1. strip before:', await page.evaluate(() => document.querySelector('.tolling-workspace .ws-kpis').innerText.replace(/\n/g, ' | ')));
await page.click('.ws-kpis [data-kpi="equipment"]');
await page.waitForTimeout(14000);
const read = () => page.evaluate(() => {
  const s = window.__assetExplorer.store.getState();
  const layer = window.__tolling.equipmentLayer;
  return { type: s.activeExplorerType, listed: (s.assetsByType.gantryEquipment ?? []).length,
    selected: s.selectedAsset?.id ?? null, node: s.selectedAsset?.source?.nodeName ?? null,
    highlight: layer.selectedId, hover: layer.hoveredId };
});
console.log('2. equipment open:', JSON.stringify(await read()));

// Pick three parts the camera can actually see, away from the right-hand panel.
const targets = await page.evaluate(() => {
  const v = window.__viewer; const layer = window.__tolling.equipmentLayer;
  const found = [];
  for (const asset of window.__tolling.equipmentManifest().assets) {
    if (!['RFID_ANTENNA', 'VES_CAMERA', 'CCTV_CAMERA'].includes(asset.type)) continue;
    const position = layer.worldPositionOf(asset.assetId);
    const screen = position && v.scene.cartesianToCanvasCoordinates(position);
    if (!screen) continue;
    const x = Math.round(screen.x); const y = Math.round(screen.y);
    if (x < 120 || x > 1180 || y < 90 || y > 860) continue;
    if (layer.nodeNameFromPick(v.scene.pick({ x, y })) !== asset.nodeName) continue;
    found.push({ assetId: asset.assetId, node: asset.nodeName, x, y });
    if (found.length === 3) break;
  }
  return found;
});
let shot = false;
let shot2 = false;
for (const target of targets) {
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(700);
  const hovered = await page.evaluate(() => window.__tolling.equipmentLayer.hoveredId);
  if (!shot) {
    await page.screenshot({ path: 'scratchpad/hover.png',
      clip: { x: Math.max(0, target.x - 140), y: Math.max(0, target.y - 100), width: 280, height: 200 } });
    shot = true;
  }
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(2400);
  if (!shot2) {
    await page.screenshot({ path: 'scratchpad/selected-close.png',
      clip: { x: Math.max(0, target.x - 140), y: Math.max(0, target.y - 100), width: 280, height: 200 } });
    shot2 = true;
  }
  const after = await read();
  console.log(`3. ${target.node.padEnd(22)} hover=${String(hovered).padEnd(24)} ->`,
    JSON.stringify({ selected: after.selected, node: after.node, highlight: after.highlight,
      correct: after.selected === target.assetId }));
}
await page.screenshot({ path: 'scratchpad/equipment-selected.png' });

// Inventory -> scene, including the camera.
const before = await page.evaluate(() => window.__viewer.camera.positionWC.clone());
const chosen = await page.evaluate(() => {
  const s = window.__assetExplorer.store;
  const asset = (s.getState().assetsByType.gantryEquipment ?? []).find(a => a.source?.type === 'TOLL_CAMERA');
  s.selectAsset(asset);
  return asset.id;
});
await page.waitForTimeout(4000);
console.log('4. inventory ->', chosen, JSON.stringify(await read()),
  'camera moved:', await page.evaluate(b => {
    const p = window.__viewer.camera.positionWC;
    return Math.round(Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z));
  }, before), 'm');

// Clicking the gantry span clears, as clicking past it does.
const span = await page.evaluate(() => {
  const v = window.__viewer; const layer = window.__tolling.equipmentLayer;
  for (let x = 200; x < 1150; x += 7) for (let y = 120; y < 820; y += 7) {
    if (layer.nodeNameFromPick(v.scene.pick({ x, y })) === 'gantry main') return { x, y };
  }
  return null;
});
if (span) {
  await page.mouse.click(span.x, span.y);
  await page.waitForTimeout(2200);
  console.log('5. clicked the span ->', JSON.stringify(await read()));
}
console.log('6. strip after:', await page.evaluate(() => document.querySelector('.tolling-workspace .ws-kpis').innerText.replace(/\n/g, ' | ')));
console.log(errors.length ? 'ERRORS ' + [...new Set(errors)].slice(0, 5).join(' | ') : 'no page errors');
await browser.close();
