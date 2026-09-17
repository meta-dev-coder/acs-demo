import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer, revealLayerGroup } from './i595Explorer.mjs';
const data = JSON.parse(readFileSync(new URL('../public/data/i595_bridges.geojson', import.meta.url)));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({viewport:{width:1400,height:900}});
  let requests = 0;
  page.on('request', r => { if (r.url().includes('/data/i595_bridges.geojson')) requests++; });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('viewer.animation.container','window.bridgeViewer=viewer; viewer.animation.container')
      .replace('import.meta.hot.dispose(() => {', 'window.bridgeLayer=bridgeControls; window.bridgeMainline=mainlineSegments; import.meta.hot.dispose(() => {');
    await route.fulfill({response,body});
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
  await page.locator('#bridges-all:not(:disabled)').waitFor({timeout:60000,state:'attached'});
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.bridgeCesium = await import(text.match(/from\s*"([^"]*cesium[^\"]*)"/)[1]);
    window.originalBridges = [...window.bridgeLayer.bridgeById.values()];
  });
  await page.waitForTimeout(1600);
  await revealLayerGroup(page, '.structures-group');
  // The group now opens by default, so ensure it is open rather than toggling it.
  await page.evaluate(() => { document.querySelector('.structures-group').open = true; });
  const before = await page.evaluate(()=>window.bridgeViewer.camera.positionCartographic.height);
  await page.locator('#bridges-all').check();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.bridgeViewer.camera.positionCartographic.height),before);
  await page.locator('.bridges-group > summary').click({position:{x:5,y:10}});
  const longest=data.features.reduce((a,b)=>a.properties.shape_length_m>b.properties.shape_length_m?a:b).properties.asset_id;
  for(const id of ['BRIDGE-860648',longest]) {
    await page.locator(`button[data-bridge-id="${id}"]`).click();
    await page.waitForTimeout(1600);
    // While the Asset Explorer browses bridges, picking one selects it; framing it is the explicit
    // inspection. The framing requirement is unchanged — the bridge must land in the map area the
    // panels leave clear — but the panels it has to clear now include the bottom asset explorer.
    await page.evaluate(id=>{
      const store=window.__assetExplorer.store;
      const asset=(store.getState().assetsByType.bridge??[]).find(candidate=>candidate.id===id);
      window.__assetExplorer.inspect(asset);
    },id);
    await page.waitForTimeout(2600);
    const result=await page.evaluate(id=>{
      const v=window.bridgeViewer,{SceneTransforms}=window.bridgeCesium;
      const pixels=window.bridgeLayer.bridgeById.get(id).polyline.positions.getValue().map(p=>SceneTransforms.worldToWindowCoordinates(v.scene,p));
      const rectOf=selector=>document.querySelector(selector)?.getBoundingClientRect()??null;
      const left=rectOf('.layers').right;
      const details=rectOf('[role="complementary"]');
      const right=details&&details.width>0?details.left:innerWidth;
      const explorer=rectOf('[role="region"][aria-label*="explorer"]');
      const bottom=explorer&&explorer.height>0?explorer.top:innerHeight-40;
      return {height:v.camera.positionCartographic.height,
        clear:pixels.every(p=>p&&p.x>left&&p.x<right&&p.y>0&&p.y<bottom)};
    },id);
    assert.ok(result.clear,JSON.stringify(result));
  }
  await page.screenshot({path:'/tmp/bridge-focus-desktop.png'});
  await page.getByRole('button',{name:'Close asset details'}).click();
  await page.setViewportSize({width:390,height:844});
  // Cesium resizes its canvas on its own tick, and the focus helper frames from the canvas size —
  // let the new viewport reach it before asking it to frame anything.
  await page.waitForTimeout(800);
  await page.evaluate(()=>window.bridgeViewer.forceResize());
  await page.locator('button[data-bridge-id="BRIDGE-860648"]').click();
  await page.waitForTimeout(1200);
  await page.evaluate(()=>{
    const store=window.__assetExplorer.store;
    const asset=(store.getState().assetsByType.bridge??[]).find(c=>c.id==='BRIDGE-860648');
    window.__assetExplorer.inspect(asset);
  });
  await page.waitForTimeout(2600);
  assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
  assert.ok(await page.evaluate(()=>{
    const v=window.bridgeViewer,{SceneTransforms}=window.bridgeCesium;
    const points=window.bridgeLayer.bridgeById.get('BRIDGE-860648').polyline.positions.getValue();
    const top=0;
    // Clear of whatever the collapsed explorer actually occupies, rather than a baked-in width:
    // the quick rail is narrower than the panel shell it replaced.
    const left=document.querySelector('.quick-rail').getBoundingClientRect().right;
    const panel=document.querySelector('[role="region"][aria-label*="explorer"]');
    const bottom=panel&&panel.getBoundingClientRect().height>0?panel.getBoundingClientRect().top:innerHeight-40;
    return points.every(p=>{const xy=SceneTransforms.worldToWindowCoordinates(v.scene,p);return xy && xy.x>left && xy.x<innerWidth && xy.y>top && xy.y<bottom;});
  }));
  await page.screenshot({path:'/tmp/bridge-focus-mobile.png'});
  console.log('PASS: short/long bridges fit clear map area, mobile framing, checkbox camera unchanged.');
} finally {await browser.close();}
