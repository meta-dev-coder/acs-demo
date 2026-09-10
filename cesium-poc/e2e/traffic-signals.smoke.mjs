import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';
const data = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_traffic_signals.geojson', import.meta.url)));
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 const page = await browser.newPage({viewport:{width:1400,height:900}});
 let requests=0;
 page.on('request',r=>{if(r.url().includes('/data/i595_corridor_traffic_signals.geojson'))requests++;});
 await page.route('**/src/i595Demo.js*',async route=>{
  const response=await route.fetch();
  const body=(await response.text()).replace('viewer.animation.container','window.v=viewer; viewer.animation.container').replace('if (import.meta.hot)','window.signals=signalControls; if (import.meta.hot)');
  await route.fulfill({response,body});
 });
 await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
 await page.locator('#signals-all:not(:disabled)').waitFor({state:'attached',timeout:60000});
 await page.evaluate(async()=>{const s=await(await fetch('/src/i595Demo.js')).text();window.C=await import(s.match(/from\s*"([^"]*cesium[^\"]*)"/)[1]);});
 assert.equal(await page.evaluate(()=>[...signals.trafficSignalById.values()].filter(e=>e.show).length),0);
 assert.equal(await page.locator('.signals-group .badge').textContent(),'22');
 await page.locator('.its-group > summary').click();
 await page.locator('#signals-all').check();
 await page.locator('.signals-group > summary').click({position:{x:5,y:10}});
 const actual=await page.evaluate(()=>[...signals.trafficSignalById].map(([id,e])=>{const c=C.Cartographic.fromCartesian(e.position.getValue());return {id,lon:C.Math.toDegrees(c.longitude),lat:C.Math.toDegrees(c.latitude),show:e.show};}));
 assert.equal(actual.length,data.features.length);
 for(const f of data.features){const a=actual.find(a=>a.id===f.properties.asset_id);assert.ok(a.show);assert.ok(Math.abs(a.lon-f.geometry.coordinates[0])<1e-8);assert.ok(Math.abs(a.lat-f.geometry.coordinates[1])<1e-8);}
 const id=data.features[0].properties.asset_id;
 await page.locator(`button[data-signal-id="${id}"]`).click();
 await page.waitForTimeout(1700);
 assert.ok((await page.locator('.signal-details dt').allTextContents()).includes('FDOT Reference Post'));
 assert.equal(await page.locator('.bridge-details:not([hidden]), .segment-details:not([hidden])').count(),0);
 // The signal head is a compact marker now, so find a pixel it actually occupies rather than
 // assuming a fixed offset sized for the old clip-art icon. Clamped markers are only placed once
 // the 3D tiles beneath them have streamed in, so poll rather than guess a fixed wait.
 const findPoint=()=>page.evaluate(id=>{
  const e=signals.trafficSignalById.get(id);
  const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,e.position.getValue());
  const raw=Object.getPrototypeOf(v.scene).pick;
  for(let dy=0;dy>=-30;dy-=2)for(const dx of [0,-3,3,-6,6]){
   const pt=new C.Cartesian2(Math.round(p.x+dx),Math.round(p.y+dy));
   if(raw.call(v.scene,pt)?.id?.id===id)return{x:pt.x,y:pt.y};
  }
  return null;
 },id);
 let point=null;
 for(const deadline=Date.now()+40000;!point&&Date.now()<deadline;)point=await findPoint();
 assert.ok(point,'the traffic signal must be pickable at its own rendered coordinates');
 await page.mouse.move(point.x,point.y);
 await page.getByRole('tooltip').filter({hasText:/FDOT Signal ID/}).waitFor();
 await page.mouse.click(point.x,point.y);
 assert.equal(await page.locator('.signal-details:not([hidden])').count(),1);
 await page.screenshot({path:'/tmp/traffic-signals-desktop.png'});
 await page.locator(`input[data-signal-id="${id}"]`).uncheck();
 assert.ok(await page.locator('#signals-all').evaluate(e=>e.indeterminate));
 assert.equal(await page.locator('.signal-zoom').count(),0);
 await page.locator('#signals-all').check();
 await page.waitForTimeout(1600);
 assert.equal(await page.evaluate(()=>[...signals.trafficSignalById.values()].filter(e=>e.show).length),22);
 await page.setViewportSize({width:390,height:844});
 await page.locator(`button[data-signal-id="${id}"]`).click();
 await page.waitForTimeout(1600);
 assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
 const framed=await page.evaluate(id=>{const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,signals.trafficSignalById.get(id).position.getValue());return p.y>46 && p.y<document.querySelector('.signal-details').getBoundingClientRect().top;},id);
 assert.ok(framed);
 await page.screenshot({path:'/tmp/traffic-signals-mobile.png'});
 assert.equal(requests,1);
 console.log('PASS: all 22 signals, original coordinates, default off, toggles, one fetch, actual picking, details, removed layer zoom and mobile focus');
}finally{await browser.close();}
