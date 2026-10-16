import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 90000 });
console.log(JSON.stringify(await page.evaluate(() => {
  const si = window.__safetyIntel; const a = si.analysis();
  const f = si.state.facts[0];
  const geom = si.state.sectionGeometry;
  return {
    queueTotal: a.queue.total, hotspots: a.hotspots.clusters.length, defects: a.defects.length,
    hazardPlaces: a.hazards.places.length, secondaryObserved: a.secondary.observed.count,
    geomCount: geom?.length ?? null,
    firstSectionLines: geom?.[0]?.lines?.length ?? null,
    firstLineFirstCoord: geom?.[0]?.lines?.[0]?.[0] ?? null,
    factPos: f ? { id: f.id, lon: f.longitude, lat: f.latitude } : null,
    assignedRecords: a.sections.assignedRecords,
  };
}), null, 1));
await browser.close();
