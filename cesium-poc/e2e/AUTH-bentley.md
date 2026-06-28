# Bentley / iTwin SSO — headed persistent-context approach

> This document is for the **separate iTwin Viewer app** (`src/` in this repo), NOT for
> `cesium-poc/` — the Cesium PoC has no auth requirement and runs fully headless.

## Why a persistent browser context

Bentley IMS (Identity Management Service) uses an OIDC/PKCE flow that:
- Redirects to `ims.bentley.com` for login,
- Sets first-party cookies (`IMS_SESS`, `AMCV_*`, etc.) that must survive across navigations,
- Issues short-lived access tokens (~1 h) backed by a long-lived refresh token stored in
  `localStorage` / `IndexedDB`.

Playwright's default `browser.newContext()` creates an ephemeral, sandboxed profile — every run
starts with empty storage and is immediately redirected to the IMS login page.
`chromium.launchPersistentContext()` points Playwright at a real on-disk profile directory that you
populate **once** in a headed session; subsequent headless runs reuse the saved cookies and tokens.

---

## One-time headed sign-in (do this once per machine / token rotation)

```ts
// scripts/bentley-auth-setup.ts
// Run once: npx ts-node scripts/bentley-auth-setup.ts
import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The profile directory is git-ignored; it persists between runs.
// Keep it outside the repo if you share the machine.
const PROFILE_DIR = path.resolve(__dirname, '../../.playwright-bentley-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,          // must be headed for IMS SSO
    viewport: { width: 1400, height: 900 },
    // No SwiftShader needed — this run is headed and uses real GPU.
  });

  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/');   // your iTwin Viewer dev server

  // Pause here — complete the IMS sign-in manually in the browser window.
  // Playwright will wait indefinitely.
  console.log('Sign in to Bentley IMS in the browser, then press Enter here…');
  await new Promise<void>((r) => process.stdin.once('data', () => r()));

  // Optionally save storageState for inspection (tokens + cookies).
  await ctx.storageState({ path: path.join(PROFILE_DIR, 'storageState.json') });

  await ctx.close();
  console.log('Profile saved to', PROFILE_DIR);
})();
```

Run this **once** (or whenever the refresh token expires, typically 30–90 days):

```bash
npx tsx scripts/bentley-auth-setup.ts
```

---

## Reusing the profile in Playwright tests

### Option A — `launchPersistentContext` (simplest)

```ts
// e2e/itwin-fixture.ts
import { test as base, chromium, BrowserContext } from '@playwright/test';
import path from 'path';

const PROFILE_DIR = path.resolve(__dirname, '../../.playwright-bentley-profile');

export const test = base.extend<{ bentleyCtx: BrowserContext }>({
  bentleyCtx: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: [
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
      ],
    });
    await use(ctx);
    await ctx.close();
  },
});

export { expect } from '@playwright/test';
```

Use in a spec:

```ts
import { test, expect } from './itwin-fixture.js';

test('iTwin viewer loads the I-595 model', async ({ bentleyCtx }) => {
  const page = await bentleyCtx.newPage();
  await page.goto('http://localhost:3000/');
  // The app picks up the saved IMS session — no redirect to login page.
  await page.waitForSelector('[data-testid="imodel-viewport"]', { timeout: 60_000 });
  expect(await page.title()).toContain('I-595');
});
```

### Option B — `storageState` (parallel-safe, requires a recent token dump)

If you need parallel workers (each gets its own context), export the saved state:

```ts
// playwright.itwin.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    storageState: '.playwright-bentley-profile/storageState.json',
    headless: true,
    launchOptions: { args: ['--use-angle=swiftshader', ...] },
  },
});
```

Re-run the headed setup script whenever `storageState.json` becomes stale (IMS 401 in tests).

---

## Token lifetime and CI

| Token type | Lifetime | Stored in |
|---|---|---|
| Access token | ~1 hour | `localStorage` (`imsAccessToken`) |
| Refresh token | 30–90 days (depends on IMS policy) | `IndexedDB` or `cookies` |

For CI pipelines:
- **Option 1 (recommended):** Run the headed setup on a dev machine, commit `storageState.json`
  to a **private** secrets store (e.g. GitHub Actions secret, AWS SSM), and restore it as a file
  before `npm run e2e`.  Do **NOT** commit it to the repo — it contains bearer tokens.
- **Option 2:** Keep a long-lived service account with an IMS API key and exchange it for a
  token at CI startup via the Bentley OAuth2 client-credentials flow
  (`https://ims.bentley.com/connect/token`, scope `imodeljs-backend`).

---

## .gitignore additions needed

Add these to `../.gitignore` (the repo root, not `cesium-poc/`):

```gitignore
# Bentley Playwright persistent browser profile
.playwright-bentley-profile/
**/storageState.json
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Redirected to IMS login in headless run | Profile missing or refresh token expired | Re-run the headed setup script |
| `Error: browserContext.newPage: Target page, context or browser has been closed` | `launchPersistentContext` closed before the test finished | Move `ctx.close()` to the `afterAll` / `use()` teardown |
| 3D viewport blank / WebGL lost | SwiftShader args missing in the persistent context launch | Add `--use-angle=swiftshader` args (same as `cesium-poc` config) |
| IMS 429 Too Many Requests | Too many parallel workers each hitting IMS | Use `storageState` option B, set `workers: 1` for auth-sensitive tests |
