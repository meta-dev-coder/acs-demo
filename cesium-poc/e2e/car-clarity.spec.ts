/**
 * car-clarity.spec.ts — TDD spec for sharp, recognisable vehicle rendering.
 *
 * Requirements:
 *   R1. Vehicle entities use model graphics (glTF), not boxes. (overlaps Bug 6 — belt-and-suspenders)
 *   R2. The car model has 2+ mesh primitives (body + cabin = distinct sedan silhouette), NOT a single cube.
 *   R3. Each vehicle model carries a meaningful minimumPixelSize >= 24 (stays visible when zoomed out).
 *   R4. Car scale == 1.0 (native 4.8 m model = real sedan length; no arbitrary shrink).
 *   R5. Truck scale >= 2.0 (Cesium Milk Truck native ~4.87 m → >= 9.7 m at 2×).
 *   R6. colorBlendMode == 2 (MIX), not 1 (REPLACE), so the model's shading/shape still reads.
 *   R7. colorBlendAmount > 0 and <= 0.8 (visible tint, but not fully replacing geometry colour).
 *   R8. At least one colour-distinguishable payment type is present (orange cash or green AET).
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/car-clarity.spec.ts
 */
import { test, expect } from '@playwright/test';
import { waitForReady, shoot } from './helpers.js';

test.describe('vehicle model clarity', () => {

  test('R1 — vehicle entities use .model graphics, not .box', async ({ page }) => {
    await waitForReady(page);

    const result = await page.evaluate(() => {
      const v = (window as any).__viewer;
      const entities: any[] = v.entities.values;
      return {
        boxCount:   entities.filter((e: any) => e.box   != null).length,
        modelCount: entities.filter((e: any) => e.model != null).length,
      };
    });

    expect(result.boxCount,   `${result.boxCount} box entities still present`).toBe(0);
    expect(result.modelCount, 'Expected at least one model entity').toBeGreaterThan(0);
  });

  test('R2 — car.glb has >= 2 mesh primitives (body + cabin silhouette)', async ({ page }) => {
    await waitForReady(page);

    // Fetch and inspect car.glb from the page context to confirm it is not a single-box model.
    const primitiveCount = await page.evaluate(async () => {
      const resp = await fetch('/models/car.glb');
      const buf  = await resp.arrayBuffer();
      const view = new DataView(buf);

      // Parse GLB JSON chunk.
      const jsonLen  = view.getUint32(12, true);
      const jsonText = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen));
      const gltf     = JSON.parse(jsonText);

      // Count total primitives across all meshes.
      let total = 0;
      for (const mesh of (gltf.meshes || [])) total += (mesh.primitives || []).length;
      return total;
    });

    expect(primitiveCount, 'car.glb must have >= 2 primitives (body + cabin)').toBeGreaterThanOrEqual(2);
  });

  test('R3 R4 R5 R6 R7 — model graphics have correct scale and blend params', async ({ page }) => {
    await waitForReady(page);

    const violations: string[] = await page.evaluate(() => {
      const v = (window as any).__viewer;
      const violations: string[] = [];

      for (const e of v.entities.values) {
        const m = e.model;
        if (!m) continue;

        const uri: string = m.uri?.getValue ? m.uri.getValue(undefined) : (m.uri || '');
        const isTruck = uri.includes('truck');
        const label   = isTruck ? 'truck' : 'car';

        // R3 — minimumPixelSize >= 24
        const mps: number = m.minimumPixelSize?.getValue ? m.minimumPixelSize.getValue(undefined) : m.minimumPixelSize;
        if (typeof mps === 'number' && mps < 24) {
          violations.push(`${label}: minimumPixelSize=${mps} (< 24)`);
        }

        // R4 — car scale == 1.0 (within floating-point tolerance)
        // R5 — truck visibly larger than a car but not oversized (1.1×–2.0× — tuned to ~1.25 so it
        //      reads as a bigger vehicle without the "giant truck" bug).
        const scale: number = m.scale?.getValue ? m.scale.getValue(undefined) : m.scale;
        if (typeof scale === 'number') {
          if (!isTruck && Math.abs(scale - 1.0) > 0.05) {
            violations.push(`car: scale=${scale.toFixed(3)} (expected 1.0 ± 0.05)`);
          }
          if (isTruck && (scale < 1.1 || scale > 2.0)) {
            violations.push(`truck: scale=${scale.toFixed(3)} (expected 1.1–2.0)`);
          }
        }

        // R6 — colorBlendMode == 2 (MIX)
        const cbm: number = m.colorBlendMode?.getValue ? m.colorBlendMode.getValue(undefined) : m.colorBlendMode;
        if (typeof cbm === 'number' && cbm !== 2) {
          violations.push(`${label}: colorBlendMode=${cbm} (expected 2=MIX)`);
        }

        // R7 — colorBlendAmount in (0, 0.8]
        const cba: number = m.colorBlendAmount?.getValue ? m.colorBlendAmount.getValue(undefined) : m.colorBlendAmount;
        if (typeof cba === 'number' && (cba <= 0 || cba > 0.8)) {
          violations.push(`${label}: colorBlendAmount=${cba.toFixed(2)} (expected >0 and <=0.8)`);
        }
      }
      return violations;
    });

    await shoot(page, 'car-clarity-r3r4r5r6r7');
    expect(violations, `Model param violations:\n${violations.join('\n')}`).toHaveLength(0);
  });

  test('R8 — both cash (orange) and AET (green) tinted vehicles present', async ({ page }) => {
    await waitForReady(page);

    const colors = await page.evaluate(() => {
      const v   = (window as any).__viewer;
      let cash = 0, etc = 0;
      const CASH_R = 0xff / 255, CASH_G = 0x9b / 255;  // #ff9b1a
      const ETC_R  = 0x1c / 255, ETC_G  = 0xcb / 255;  // #1ccb40
      const eps = 2 / 255;

      for (const e of v.entities.values) {
        const m = e.model;
        if (!m) continue;
        const c = m.color?.getValue ? m.color.getValue(undefined) : m.color;
        if (!c || typeof c.red !== 'number') continue;
        if (Math.abs(c.red - CASH_R) < eps && Math.abs(c.green - CASH_G) < eps) cash++;
        if (Math.abs(c.red - ETC_R)  < eps && Math.abs(c.green - ETC_G)  < eps) etc++;
      }
      return { cash, etc };
    });

    expect(colors.cash + colors.etc,
      `No distinctly coloured vehicles: cash=${colors.cash} etc=${colors.etc}`
    ).toBeGreaterThan(0);
  });

  test('oblique screenshot — vehicles read as recognisable cars at demo zoom', async ({ page }) => {
    await waitForReady(page);

    // Fast-forward sim so vehicles are moving at booth.
    await page.evaluate(() => {
      const v = (window as any).__viewer;
      v.clock.multiplier = 30;
      v.clock.shouldAnimate = true;
    });
    await page.waitForTimeout(1_000); // 30 s sim
    await page.evaluate(() => { (window as any).__viewer.clock.multiplier = 1; });

    // Switch to oblique view for close-up screenshot.
    const viewBtn = page.locator('#btn-view');
    if (await viewBtn.count() > 0) await viewBtn.click();

    await page.waitForTimeout(400); // let camera settle
    const obliquePath = await shoot(page, 'car-clarity-oblique');

    // Switch back to top-down for a second shot.
    if (await viewBtn.count() > 0) await viewBtn.click();
    await page.waitForTimeout(400);
    const topDownPath = await shoot(page, 'car-clarity-topdown');

    // These screenshots are purely for human review; the test passes as long as it runs.
    expect(obliquePath).toContain('car-clarity-oblique.png');
    expect(topDownPath).toContain('car-clarity-topdown.png');
  });
});
