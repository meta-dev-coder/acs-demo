/**
 * helpers.ts — reusable test harness for the CesiumJS toll-plaza PoC.
 *
 * Import in any e2e spec:
 *   import { waitForReady, markGates, counts, clockAnimating, vehicleWorldPositions, shoot, SITE_I595 }
 *     from './helpers.js';
 */
import type { Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Known colors from main.js COLORS map (CSS hex strings, lowercase).
// ---------------------------------------------------------------------------
const CASH_HEX  = '#ff9b1a';
const ETC_HEX   = '#1ccb40';
const TRUCK_HEX = '#3a80e8';

// ---------------------------------------------------------------------------
// SITE_I595
// Derived from the I-595 default transform in main.js:
//   anchorLon=-80.306, anchorLat=26.1124, bearingDeg=104, scale=0.5
//   sumoRefX=530, sumoRefY=0; data bounds minY=-14.4 .. maxY=14.4
// dir[0] = up-road (100 m before anchor), dir[1] = down-road (100 m after).
// 8 gates evenly span the SUMO Y extent mapped through sumoToWorld.
// ---------------------------------------------------------------------------
export type LonLat = { lon: number; lat: number };

export const SITE_I595: { dir: [LonLat, LonLat]; gates: LonLat[] } = {
  dir: [
    { lon: -80.3069707, lat: 26.1126189 },  // up-road
    { lon: -80.3050293, lat: 26.1121811 },  // down-road
  ],
  // 10 gates — one per SUMO lane pl_0..pl_9, derived from sumoToWorld(530, -14.4+3.2*i)
  // with anchor=-80.306,26.1124, bearingDeg=104, scale=1.0 (true-to-scale, real 3.2 m lane
  // spacing in world).  i=0..2 → cash lanes (pl_0..pl_2); i=3..9 → AET lanes.
  // At scale=1.0, adjacent-lane world distance = 3.2 m > GATE_PROXIMITY_M=3 m, so no
  // cash vehicle can ever be within 3 m of an AET gate (or vice-versa) at booth stop.
  gates: [
    { lon: -80.3060349, lat: 26.1122736 },  // pl_0  cash  y=-14.4
    { lon: -80.3060271, lat: 26.1123017 },  // pl_1  cash  y=-11.2
    { lon: -80.3060194, lat: 26.1123298 },  // pl_2  cash  y= -8.0
    { lon: -80.3060116, lat: 26.1123579 },  // pl_3  AET   y= -4.8
    { lon: -80.3060039, lat: 26.1123860 },  // pl_4  AET   y= -1.6
    { lon: -80.3059961, lat: 26.1124140 },  // pl_5  AET   y= +1.6
    { lon: -80.3059884, lat: 26.1124421 },  // pl_6  AET   y= +4.8
    { lon: -80.3059806, lat: 26.1124702 },  // pl_7  AET   y= +8.0
    { lon: -80.3059729, lat: 26.1124983 },  // pl_8  AET   y=+11.2
    { lon: -80.3059651, lat: 26.1125264 },  // pl_9  AET   y=+14.4
  ],
};

// ---------------------------------------------------------------------------
// waitForReady
// Navigate to '/', wait until __viewer exists AND at least one vehicle entity
// with .box graphics has appeared.  Polls every 500 ms; gives up after 45 s.
// ---------------------------------------------------------------------------
export async function waitForReady(page: Page): Promise<void> {
  await page.goto('/');

  // 1. Viewer must be attached.
  await page.waitForFunction(
    () => !!(window as any).__viewer,
    { timeout: 30_000 },
  );

  // 2. At least one vehicle entity (has .model graphics) must exist.
  await page.waitForFunction(
    () => {
      const viewer = (window as any).__viewer;
      if (!viewer) return false;
      return viewer.entities.values.some((e: any) => e.model != null);
    },
    { timeout: 45_000, polling: 500 },
  );
}

// ---------------------------------------------------------------------------
// markGates
// Programmatically invoke window.__markGates(dir, gates) and wait one tick
// for Cesium to process the entity rebuild.
// ---------------------------------------------------------------------------
export async function markGates(
  page: Page,
  dir: [LonLat, LonLat],
  gates: LonLat[],
): Promise<void> {
  await page.evaluate(
    ([d, g]) => (window as any).__markGates(d, g),
    [dir, gates] as [LonLat[], LonLat[]],
  );
  // Wait one JS macro-task so Cesium's entity rebuild has run.
  await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 100)));
}

// ---------------------------------------------------------------------------
// EntityCounts
// ---------------------------------------------------------------------------
export interface EntityCounts {
  vehicles: number;
  gates: number;
  cashVeh: number;
  etcVeh: number;
  truckVeh: number;
}

// Compare a Cesium Color to a CSS hex string.  Cesium stores components as
// 0-1 floats; we convert hex to 0-1 and test with ε tolerance.
function hexToFloats(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export async function counts(page: Page): Promise<EntityCounts> {
  return page.evaluate(
    ({ cashHex, etcHex, truckHex }) => {
      const viewer = (window as any).__viewer;
      const entities: any[] = viewer.entities.values;

      const vehicles = entities.filter((e: any) => e.model != null);
      const gates    = entities.filter((e: any) => e.ellipse != null);

      function hexToF(h: string): [number, number, number] {
        const s = h.replace('#', '');
        return [
          parseInt(s.slice(0, 2), 16) / 255,
          parseInt(s.slice(2, 4), 16) / 255,
          parseInt(s.slice(4, 6), 16) / 255,
        ];
      }

      function colorMatches(colorProp: any, hex: string): boolean {
        if (!colorProp) return false;
        // model.color is a ConstantProperty wrapping a Color; get the raw Color.
        const c = colorProp.getValue ? colorProp.getValue(undefined) : colorProp;
        if (!c || typeof c.red !== 'number') return false;
        const [r, g, b] = hexToF(hex);
        const eps = 1 / 255 + 0.001;
        return Math.abs(c.red - r) < eps && Math.abs(c.green - g) < eps && Math.abs(c.blue - b) < eps;
      }

      const cashVeh  = vehicles.filter((e: any) => colorMatches(e.model.color, cashHex)).length;
      const etcVeh   = vehicles.filter((e: any) => colorMatches(e.model.color, etcHex)).length;
      const truckVeh = vehicles.filter((e: any) => colorMatches(e.model.color, truckHex)).length;

      return {
        vehicles: vehicles.length,
        gates: gates.length,
        cashVeh,
        etcVeh,
        truckVeh,
      };
    },
    { cashHex: CASH_HEX, etcHex: ETC_HEX, truckHex: TRUCK_HEX },
  );
}

// ---------------------------------------------------------------------------
// clockAnimating
// ---------------------------------------------------------------------------
export async function clockAnimating(page: Page): Promise<boolean> {
  return page.evaluate(() => !!(window as any).__viewer?.clock?.shouldAnimate);
}

// ---------------------------------------------------------------------------
// vehicleWorldPositions
// Returns {lon, lat} (degrees) for every vehicle entity at the viewer's
// current clock time.  Uses viewer.scene.globe.ellipsoid.cartesianToCartographic
// so no window.__Cesium exposure is needed.
// ---------------------------------------------------------------------------
export async function vehicleWorldPositions(
  page: Page,
  // t is unused in current impl (uses viewer.clock.currentTime internally)
  _t?: number,
): Promise<LonLat[]> {
  return page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const time = viewer.clock.currentTime;
    const ell = viewer.scene.globe.ellipsoid;
    const results: { lon: number; lat: number }[] = [];

    for (const e of viewer.entities.values) {
      if (!e.model) continue;
      const positionProperty = e.position;
      if (!positionProperty) continue;
      const cartesian = positionProperty.getValue(time);
      if (!cartesian) continue;
      const carto = ell.cartesianToCartographic(cartesian);
      if (!carto) continue;
      // Cesium Cartographic stores radians
      results.push({
        lon: (carto.longitude * 180) / Math.PI,
        lat: (carto.latitude  * 180) / Math.PI,
      });
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// shoot
// Save a screenshot to test-results/<name>.png (directory is git-ignored).
// ---------------------------------------------------------------------------
export async function shoot(page: Page, name: string): Promise<string> {
  const dir = path.join(__dirname, '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  return filePath;
}
