import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';

// Cameras are drawn in two groups — express-lane and mainline — and only those within 150 m of the
// I-595 network are shown, so the counts come from the data rather than from a number written here.
const cameraFeatures = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_cameras.geojson', import.meta.url))).features
  .filter(f => { const d = Number(f.properties.distance_to_i595_network_m); return Number.isFinite(d) ? d <= 150 : true; });
const expressCameras = cameraFeatures.filter(f => f.properties.is_express_camera === true).length;
const mainlineCameras = cameraFeatures.length - expressCameras;

const data = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_cameras.geojson', import.meta.url)));
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 const page = await browser.newPage({viewport:{width:1400,height:900}});
 let requests=0;
 page.on('request',r=>{if(r.url().includes('/data/i595_corridor_cameras.geojson'))requests++;});
 await page.route('**/src/i595Demo.js*',async route=>{
  const response=await route.fetch();
  const body=(await response.text()).replace('viewer.animation.container','window.v=viewer; viewer.animation.container').replace('import.meta.hot.dispose(() => {', 'window.cameras=cameraControls; import.meta.hot.dispose(() => {');
  await route.fulfill({response,body});
 });
 await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
 await page.locator('#cameras-mainline:not(:disabled)').waitFor({state:'attached',timeout:60000});
 await page.evaluate(async()=>{const s=await(await fetch('/src/i595Demo.js')).text();window.C=await import(s.match(/from\s*"([^"]*cesium[^\"]*)"/)[1]);});
 assert.equal(await page.evaluate(()=>[...cameras.cameraById.values()].filter(e=>e.show).length),0);
 assert.equal(await page.locator('.cameras-express-group .badge').textContent(), String(expressCameras));
 assert.equal(await page.locator('.cameras-mainline-group .badge').textContent(), String(mainlineCameras));
 await page.locator('.its-group > summary').click();
 for (const group of ['#cameras-express', '#cameras-mainline']) await page.locator(group).check();
 await page.locator('.cameras-mainline-group > summary').click({position:{x:5,y:10}});
 const actual=await page.evaluate(()=>[...cameras.cameraById].map(([id,e])=>{const c=C.Cartographic.fromCartesian(e.position.getValue());return {id,lon:C.Math.toDegrees(c.longitude),lat:C.Math.toDegrees(c.latitude),show:e.show};}));
 assert.equal(actual.length, cameraFeatures.length);
 for(const f of cameraFeatures){const a=actual.find(a=>a.id===f.properties.camera_id);assert.ok(a.show);assert.ok(Math.abs(a.lon-f.geometry.coordinates[0])<1e-8);assert.ok(Math.abs(a.lat-f.geometry.coordinates[1])<1e-8);}
 const id=cameraFeatures.find(f=>f.properties.is_express_camera!==true).properties.camera_id;
 await page.locator(`button[data-camera-id="${id}"]`).click();
 await page.waitForTimeout(1700);
 // The panel now reports the snapshot feed rather than a generic "Video Stream" flag.
 assert.ok((await page.locator('.camera-details dt').allTextContents()).includes('Snapshot Feed'));
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
 // The panel states the snapshot feed a camera actually has: a live DIVAS snapshot, a camera that
 // reports video but has no public mapping, or none at all. It never offers a feed it cannot show.
 const snapshotLabels = ['Live snapshot', 'No public feed', 'Not available'];
 const shown = await page.locator('.camera-details dd').allTextContents();
 assert.ok(snapshotLabels.some(label => shown.includes(label)), `expected a snapshot state, got ${shown.join(' | ')}`);
 const noFeed = cameraFeatures.find(f => f.properties.video_enabled === true && !f.properties.divas_chan_id);
 if (noFeed) {
   await page.locator(`button[data-camera-id="${noFeed.properties.camera_id}"]`).click();
   // No public mapping: the panel says so rather than presenting a dead player.
   assert.equal(await page.locator('.camera-no-feed-note').count(), 1);
   assert.ok((await page.locator('.camera-details dd').allTextContents()).includes('No public feed'));
 }
 await page.screenshot({path:'/tmp/cctv-cameras-desktop.png'});
 // Rows carry a feed-status dot rather than a per-camera checkbox: visibility is owned by the
 // group control, and the row says what feed the camera has.
 assert.equal(await page.locator(`.camera-row[data-camera-id="${id}"] .camera-feed-dot`).count(), 1);
 await page.locator('#cameras-mainline').uncheck();
 await page.waitForTimeout(1200);
 assert.equal(await page.evaluate(()=>[...cameras.cameraById.values()].filter(e=>e.show).length), expressCameras,
   'clearing the mainline group leaves the express cameras alone');
 assert.equal(await page.locator('.camera-zoom').count(),0);
 for (const group of ['#cameras-express', '#cameras-mainline']) await page.locator(group).check();
 await page.waitForTimeout(1600);
 assert.equal(await page.evaluate(()=>[...cameras.cameraById.values()].filter(e=>e.show).length), cameraFeatures.length);
 await page.setViewportSize({width:390,height:844});
 await page.locator(`button[data-camera-id="${id}"]`).click();
 await page.waitForTimeout(1600);
 assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
 const framed=await page.evaluate(id=>{const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,cameras.cameraById.get(id).position.getValue());return p.y>46 && p.y<document.querySelector('.camera-details').getBoundingClientRect().top;},id);
 assert.ok(framed);
 await page.screenshot({path:'/tmp/cctv-cameras-mobile.png'});
 assert.equal(requests,1);
 console.log(`PASS: all ${cameraFeatures.length} cameras, original coordinates, default off, toggles, one fetch, actual picking, details, layer zoom and mobile focus`);
}finally{await browser.close();}
