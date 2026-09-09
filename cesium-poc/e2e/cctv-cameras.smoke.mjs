import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';
const data = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_cameras.geojson', import.meta.url)));
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 const page = await browser.newPage({viewport:{width:1400,height:900}});
 let requests=0;
 page.on('request',r=>{if(r.url().includes('/data/i595_corridor_cameras.geojson'))requests++;});
 await page.route('**/src/i595Demo.js*',async route=>{
  const response=await route.fetch();
  const body=(await response.text()).replace('viewer.animation.container','window.v=viewer; viewer.animation.container').replace('if (import.meta.hot)','window.cameras=cameraControls; if (import.meta.hot)');
  await route.fulfill({response,body});
 });
 await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
 await page.locator('#cameras-all:not(:disabled)').waitFor({state:'attached',timeout:60000});
 await page.evaluate(async()=>{const s=await(await fetch('/src/i595Demo.js')).text();window.C=await import(s.match(/from\s*"([^"]*cesium[^\"]*)"/)[1]);});
 assert.equal(await page.evaluate(()=>[...cameras.cameraById.values()].filter(e=>e.show).length),0);
 assert.equal(await page.locator('.cameras-group .badge').textContent(),'74');
 await page.locator('.its-group > summary').click();
 await page.locator('#cameras-all').check();
 await page.locator('.cameras-group > summary').click({position:{x:5,y:10}});
 const actual=await page.evaluate(()=>[...cameras.cameraById].map(([id,e])=>{const c=C.Cartographic.fromCartesian(e.position.getValue());return {id,lon:C.Math.toDegrees(c.longitude),lat:C.Math.toDegrees(c.latitude),show:e.show};}));
 assert.equal(actual.length,data.features.length);
 for(const f of data.features){const a=actual.find(a=>a.id===f.properties.camera_id);assert.ok(a.show);assert.ok(Math.abs(a.lon-f.geometry.coordinates[0])<1e-8);assert.ok(Math.abs(a.lat-f.geometry.coordinates[1])<1e-8);}
 const id=data.features[0].properties.camera_id;
 await page.locator(`button[data-camera-id="${id}"]`).click();
 await page.waitForTimeout(1700);
 assert.ok((await page.locator('.camera-details dt').allTextContents()).includes('Video Stream'));
 assert.equal(await page.locator('.bridge-details:not([hidden]), .segment-details:not([hidden])').count(),0);
 // The camera marker is compact now, and clamped markers are only placed once the 3D tiles beneath
 // them have streamed in — so find a pixel it actually occupies, and poll rather than guess a wait.
 const findPoint=()=>page.evaluate(id=>{
  const e=cameras.cameraById.get(id);
  const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,e.position.getValue());
  const raw=Object.getPrototypeOf(v.scene).pick;
  for(let dy=0;dy>=-30;dy-=2)for(const dx of [0,-4,4,-8,8]){
   const pt=new C.Cartesian2(Math.round(p.x+dx),Math.round(p.y+dy));
   if(raw.call(v.scene,pt)?.id?.id===id)return{x:pt.x,y:pt.y};
  }
  return null;
 },id);
 let point=null;
 for(const deadline=Date.now()+40000;!point&&Date.now()<deadline;)point=await findPoint();
 assert.ok(point,'the CCTV camera must be pickable at its own rendered coordinates');
 await page.mouse.move(point.x,point.y);
 await page.getByRole('tooltip').filter({hasText:/Camera ID:/}).waitFor();
 await page.mouse.click(point.x,point.y);
 assert.equal(await page.locator('.camera-details:not([hidden])').count(),1);
 assert.ok((await page.locator('.camera-details dd').allTextContents()).includes('Not Available'));
 const enabled=data.features.find(f=>f.properties.video_enabled===true);
 if(enabled){
   await page.locator(`button[data-camera-id="${enabled.properties.camera_id}"]`).click();
   assert.ok(await page.locator('.camera-stream-action').isDisabled());
   assert.ok((await page.locator('.camera-details dd').allTextContents()).includes('Available'));
 }
 await page.screenshot({path:'/tmp/cctv-cameras-desktop.png'});
 await page.locator(`input[data-camera-id="${id}"]`).uncheck();
 assert.ok(await page.locator('#cameras-all').evaluate(e=>e.indeterminate));
 await page.locator('.camera-zoom').click();
 await page.waitForTimeout(1600);
 assert.equal(await page.evaluate(()=>[...cameras.cameraById.values()].filter(e=>e.show).length),74);
 await page.setViewportSize({width:390,height:844});
 await page.locator(`button[data-camera-id="${id}"]`).click();
 await page.waitForTimeout(1600);
 assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
 const framed=await page.evaluate(id=>{const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,cameras.cameraById.get(id).position.getValue());return p.y>46 && p.y<document.querySelector('.camera-details').getBoundingClientRect().top;},id);
 assert.ok(framed);
 await page.screenshot({path:'/tmp/cctv-cameras-mobile.png'});
 assert.equal(requests,1);
 console.log('PASS: all 74 cameras, original coordinates, default off, toggles, one fetch, actual picking, details, layer zoom and mobile focus');
}finally{await browser.close();}
