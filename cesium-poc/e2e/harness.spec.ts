/**
 * harness.spec.ts — exercises every helper in helpers.ts once.
 * All assertions are sanity-level: they check types and direction, not exact counts.
 */
import { test, expect } from '@playwright/test';
import {
  waitForReady,
  markGates,
  counts,
  clockAnimating,
  vehicleWorldPositions,
  shoot,
  SITE_I595,
} from './helpers.js';

test.describe('helpers harness', () => {
  test('waitForReady: viewer exists and vehicles appear', async ({ page }) => {
    await waitForReady(page);

    // Confirm __viewer is set.
    const hasViewer = await page.evaluate(() => !!(window as any).__viewer);
    expect(hasViewer).toBe(true);
  });

  test('counts: vehicles > 0, clockAnimating is boolean', async ({ page }) => {
    await waitForReady(page);

    const c = await counts(page);
    expect(typeof c.vehicles).toBe('number');
    expect(typeof c.gates).toBe('number');
    expect(typeof c.cashVeh).toBe('number');
    expect(typeof c.etcVeh).toBe('number');
    expect(typeof c.truckVeh).toBe('number');

    // At least one vehicle must have appeared (waitForReady guarantees it).
    expect(c.vehicles).toBeGreaterThan(0);

    // Vehicle type counts must sum to <= total vehicles (some may be "unknown" color).
    expect(c.cashVeh + c.etcVeh + c.truckVeh).toBeLessThanOrEqual(c.vehicles);

    const animating = await clockAnimating(page);
    expect(typeof animating).toBe('boolean');
  });

  test('markGates: programmatic gate marking places ellipse entities', async ({ page }) => {
    await waitForReady(page);

    const before = await counts(page);

    await markGates(page, SITE_I595.dir, SITE_I595.gates);

    const after = await counts(page);

    // After marking, gate (ellipse) count should be >= number of gates marked
    // (main.js also adds a "TOLL PLAZA" label entity, not an ellipse, so we only check >= gates).
    expect(after.gates).toBeGreaterThanOrEqual(SITE_I595.gates.length);

    // Vehicle count should not have dropped.
    expect(after.vehicles).toBeGreaterThan(0);
  });

  test('vehicleWorldPositions: returns lon/lat for each vehicle', async ({ page }) => {
    await waitForReady(page);

    const positions = await vehicleWorldPositions(page);

    expect(Array.isArray(positions)).toBe(true);
    expect(positions.length).toBeGreaterThan(0);

    for (const p of positions) {
      expect(typeof p.lon).toBe('number');
      expect(typeof p.lat).toBe('number');
      // Sanity: must be plausible globe coordinates.
      expect(p.lon).toBeGreaterThan(-180);
      expect(p.lon).toBeLessThan(180);
      expect(p.lat).toBeGreaterThan(-90);
      expect(p.lat).toBeLessThan(90);
    }
  });

  test('clockAnimating: clock is running after ready', async ({ page }) => {
    await waitForReady(page);
    const animating = await clockAnimating(page);
    // The app starts traffic immediately (trafficStarted=true at boot), so clock should animate.
    expect(animating).toBe(true);
  });

  test('shoot: saves a screenshot without throwing', async ({ page }) => {
    await waitForReady(page);
    const filePath = await shoot(page, 'harness-smoke');
    expect(filePath).toMatch(/harness-smoke\.png$/);
  });

  test('SITE_I595: constant has correct shape', () => {
    expect(SITE_I595.dir).toHaveLength(2);
    expect(SITE_I595.gates.length).toBeGreaterThanOrEqual(2);
    for (const pt of [...SITE_I595.dir, ...SITE_I595.gates]) {
      expect(typeof pt.lon).toBe('number');
      expect(typeof pt.lat).toBe('number');
    }
  });
});
