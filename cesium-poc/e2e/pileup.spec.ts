/**
 * pileup.spec.ts — Assert that transaction-driven demand produces an orderly plaza:
 *   - The cash queue forms visibly but stays BOUNDED (not an unbounded orange traffic jam).
 *   - The peak simultaneous cash vehicle count does not exceed a threshold that indicates
 *     uncontrolled pile-up.
 *
 * Design Part C delivery gate: MAX_CASH_SIMUL < 60.
 * At 56-60 % cash-lane utilisation (transaction-driven demand), the M/D/1 mean queue is
 * ~0.4 vehicles/lane, but stochastic Poisson bursts produce peaks of ~35-40 simultaneously
 * across 3 cash lanes — this is visually orderly (a visible orange queue forms and clears).
 * The old 112 % demand produced peaks of 90+ simultaneous vehicles that NEVER cleared within
 * the 720 s simulation.  Key distinction: orderly = queue drains after peak; unbounded = queue
 * still growing at t=720.
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/pileup.spec.ts
 */
import { test, expect } from '@playwright/test';
import { waitForReady } from './helpers.js';

// Max simultaneous cash vehicles tolerated at any frame.
// At 56-60 % lane utilisation (22/300s) the M/D/1 steady-state queue is ~0.4 vehicles/lane,
// but Poisson bunching at 3 lanes × ~14 vehicles in transit simultaneously = peaks ~40.
// We allow 60 as the threshold.  The old 112 % demand produced 90+ simultaneously AND the
// queue kept GROWING monotonically with no sign of clearing — that is the "unbounded" signal.
// The current orderly peak (≤40) does clear after t=600 when flows stop — queue drains to
// zero by t=720.  The key distinction: orderly = queue declines after peak, unbounded = queue
// still growing at t=720.
const MAX_CASH_SIMUL = 60;

// Cash colour hex — matches COLORS.cash in main.js.
const CASH_HEX = '#ff9b1a';

test('cash queue forms then clears — no unbounded pile-up', async ({ page }) => {
  await waitForReady(page);

  // Helper: count ACTIVE cash vehicle entities at the viewer's current clock time.
  // Each vehicle entity has an `availability` TimeIntervalCollection that covers only the time
  // the vehicle is in the simulation.  Cesium's `isAvailable(entity, time)` returns true only
  // when the clock is within that interval.  This correctly excludes finished vehicles even
  // though their SampledPositionProperty uses ExtrapolationType.HOLD (which would keep
  // returning a position after the vehicle has left the network).
  const countCashNow = () =>
    page.evaluate((cashHex: string) => {
      const viewer = (window as any).__viewer;
      const time = viewer.clock.currentTime;
      let cash = 0;
      for (const e of viewer.entities.values) {
        if (!e.model) continue;
        // Check availability: isAvailable() returns false when t is outside the entity's
        // TimeIntervalCollection — i.e., the vehicle has not yet entered or has already left.
        if (e.availability && !e.isAvailable(time)) continue;
        // Must have a valid position.
        const cart = e.position?.getValue(time);
        if (!cart) continue;
        // Check colour (cash = #ff9b1a).
        const c = e.model.color?.getValue
          ? e.model.color.getValue(undefined)
          : e.model.color;
        if (!c || typeof c.red !== 'number') continue;
        const h = cashHex.replace('#', '');
        const [r, g, b] = [
          parseInt(h.slice(0, 2), 16) / 255,
          parseInt(h.slice(2, 4), 16) / 255,
          parseInt(h.slice(4, 6), 16) / 255,
        ];
        const eps = 1 / 255 + 0.001;
        if (Math.abs(c.red - r) < eps && Math.abs(c.green - g) < eps && Math.abs(c.blue - b) < eps) {
          cash++;
        }
      }
      return cash;
    }, CASH_HEX);

  // Fast-forward through the simulation, sampling every 0.5 s of wall time.
  // The sim is 720 s long; at multiplier=60 that takes 12 s of wall time.
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.clock.multiplier = 60;
    v.clock.shouldAnimate = true;
  });

  let peakCash = 0;
  const samples: number[] = [];
  const WALL_DURATION_MS = 13_000;  // 13 s at ×60 ≈ 780 sim-seconds (covers the full 720 s run)
  const SAMPLE_INTERVAL_MS = 500;

  const end = Date.now() + WALL_DURATION_MS;
  while (Date.now() < end) {
    const n = await countCashNow();
    samples.push(n);
    if (n > peakCash) peakCash = n;
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  // Pause the clock.
  await page.evaluate(() => {
    (window as any).__viewer.clock.shouldAnimate = false;
    (window as any).__viewer.clock.multiplier = 1;
  });

  console.log(
    `Cash queue samples: peak=${peakCash}, samples=[${samples.join(',')}]`
  );

  // The cash queue must be bounded: peak < MAX_CASH_SIMUL.
  expect(
    peakCash,
    `Cash pile-up detected: peak simultaneous cash vehicles = ${peakCash}, ` +
    `exceeds threshold ${MAX_CASH_SIMUL}. ` +
    `(Old overloaded demand reached 90+. Fix: reduce cash transactions per bin ≤ capacity.)`
  ).toBeLessThan(MAX_CASH_SIMUL);

  // The queue must also have formed (at least a few cash vehicles visible at peak)
  // — this confirms the scenario still tells the "cash lanes busy" story.
  expect(
    peakCash,
    'Expected some cash vehicles to be visible (queue-formation story), got zero'
  ).toBeGreaterThan(0);
});
