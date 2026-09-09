import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bridgesForDisplay } from '../src/bridgeDisplayData.js';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';
const data = JSON.parse(readFileSync(new URL('../public/data/i595_bridges.geojson', import.meta.url)));
const originalFeatures = data.features;
data.features = bridgesForDisplay(data.features);
assert.equal(originalFeatures.length - data.features.length, 8);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({viewport:{width:1400,height:900}});
  let requests = 0;
  page.on('request', r => { if (r.url().includes('/data/i595_bridges.geojson')) requests++; });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('viewer.animation.container','window.bridgeViewer=viewer; viewer.animation.container')
      .replace('if (import.meta.hot)','window.bridgeLayer=bridgeControls; window.bridgeMainline=mainlineSegments; if (import.meta.hot)');
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
  // Bridge pins appear only beyond ~3 km of the camera. The app opens close in, on the western
  // I-75 / Sawgrass interchange, so pull back to the full-corridor view before the far-camera
  // assertions below; the zoom half of this test drives the camera itself.
  await page.locator('#reset-view').click();
  await page.waitForTimeout(2000);
  assert.equal(await page.locator('.structures-group').getAttribute('open'),null);
  assert.equal(await page.locator('.bridges-group').getAttribute('open'),null);
  const visible = () => page.evaluate(()=>[...window.bridgeLayer.bridgeById.values()].filter(e=>e.show).length);
  assert.equal(await visible(),0);
  await page.locator('.structures-group > summary').click();
  await page.locator('#bridges-all').check();
  assert.equal(await visible(),data.features.length);
  await page.waitForTimeout(1800);
  const locations = new Set(data.features.map(f => JSON.stringify(f.geometry))).size;
  assert.equal(await page.evaluate(()=>[...window.bridgeLayer.bridgeById.values()].filter(e=>e.billboard.show.getValue()).length), locations);
  assert.equal(await page.evaluate(()=>[...window.bridgeLayer.bridgeById.values()].filter(e=>e.billboard.show.getValue() && decodeURIComponent(e.billboard.image.getValue()).includes('>2</text>')).length), data.features.length - locations);
  await page.screenshot({path:'/tmp/i595-bridge-icons-far.png'});
  // A long FDOT extent must retain its icon far away, just like a short bridge.
  const longest = data.features.reduce((a,b)=>a.properties.shape_length_m>b.properties.shape_length_m?a:b);
  for (const [height, expected] of [[8000,true],[1500,false],[8000,true]]) {
    await page.evaluate(({id,height})=>{
      const {Cartographic,Cartesian3,Math:CMath}=window.bridgeCesium;
      const anchor=window.bridgeLayer.bridgeById.get(id).position.getValue();
      const c=Cartographic.fromCartesian(anchor);
      window.bridgeViewer.camera.cancelFlight();
      window.bridgeViewer.camera.setView({destination:Cartesian3.fromRadians(c.longitude,c.latitude,height),orientation:{heading:0,pitch:CMath.toRadians(-90),roll:0}});
    },{id:longest.properties.asset_id,height});
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(id=>window.bridgeLayer.bridgeById.get(id).billboard.show.getValue(),longest.properties.asset_id),expected);
  }


  await page.locator('#i595_mainline_eb').check();
  await page.locator('#i595_mainline_wb').check();
  assert.equal(await page.evaluate(()=>[...window.bridgeMainline.segmentById.values()].filter(e=>e.show).length),16);
  const actual = await page.evaluate(()=> {
    const {Cartographic,Math:CMath}=window.bridgeCesium;
    return [...window.bridgeLayer.bridgeById].map(([id,e])=>({id,side:e.properties.road_side.getValue(),points:e.polyline.positions.getValue().map(p=>{const c=Cartographic.fromCartesian(p);return [CMath.toDegrees(c.longitude),CMath.toDegrees(c.latitude)];})}));
  });
  assert.equal(actual.length,data.features.length);
  for(const f of data.features) {
    const a=actual.find(a=>a.id===f.properties.asset_id);
    assert.equal(a.side,f.properties.road_side); assert.equal(a.points.length,f.geometry.coordinates.length);
    a.points.forEach((p,i)=>p.forEach((v,k)=>assert.ok(Math.abs(v-f.geometry.coordinates[i][k])<1e-8)));
  }
  assert.equal(await page.evaluate(()=>window.bridgeLayer.segmentsByBridge.get('BRIDGE-860648').length),4);
  // Exercise every structure through the compact list, including coincident structures.
  await page.locator('.bridges-group > summary').click({position:{x:5,y:10}});
  for (const f of data.features) {
    await page.locator(`button[data-bridge-id="${f.properties.asset_id}"]`).click();
    const values=await page.locator('.bridge-details dd').allTextContents();
    assert.equal(values[0],f.properties.structure_id);
    assert.equal(values[4],f.properties.road_side);
  }
  await page.locator('input[data-bridge-id="BRIDGE-860648"]').uncheck();
  assert.equal(await visible(),data.features.length - 1);
  assert.ok(await page.locator('#bridges-all').evaluate(e=>e.indeterminate));
  await page.locator('#bridges-all').check();
  assert.equal(await page.locator('.bridge-list input').count(),14);
  assert.equal(await page.locator('.bridge-location-members').count(),0);
  for (const removed of originalFeatures.filter(f=>!data.features.includes(f))) {
    assert.equal(await page.locator(`input[data-bridge-id="${removed.properties.asset_id}"]`).count(),0);
    assert.equal(await page.evaluate(id=>window.bridgeLayer.bridgeById.has(id),removed.properties.asset_id),false);
  }
  await page.screenshot({path:'/tmp/i595-bridges-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/i595-bridges-mobile.png'});
  await page.getByRole('button',{name:'Close bridge details'}).click();
  await page.locator('#bridges-all').uncheck();
  assert.equal(await visible(),0);
  assert.equal(await page.evaluate(()=>[...window.bridgeMainline.segmentById.values()].filter(e=>e.show).length),16);
  assert.ok(await page.evaluate(()=>window.originalBridges.every(e=>e===window.bridgeLayer.bridgeById.get(e.id))));
  assert.equal(requests,1);
  console.log('PASS: 14 displayed bridges with unchanged geometries, one load, road-side codes, overlap relationships, individual list selection, eight duplicate L records suppressed, road overlay, mobile.');
} finally {await browser.close();}
