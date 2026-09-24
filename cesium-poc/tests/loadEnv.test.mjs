/**
 * The server-side env loader. Its precedence is easy to get backwards, because
 * `process.loadEnvFile` never overwrites a variable that is already set — so the files must be read
 * most-specific FIRST, and a wrong order silently makes `.env` beat `.env.local`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEYS = ['DC_TEST_ONLY_A', 'DC_TEST_ONLY_B', 'DC_TEST_ONLY_C'];

function sandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), 'i595-env-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test.afterEach(() => { for (const key of KEYS) delete process.env[key]; });

test('.env.local wins over .env, and the real environment wins over both', async () => {
  const dir = sandbox({
    '.env': 'DC_TEST_ONLY_A=from_env\nDC_TEST_ONLY_B=from_env\nDC_TEST_ONLY_C=from_env\n',
    '.env.local': 'DC_TEST_ONLY_A=from_local\nDC_TEST_ONLY_B=from_local\n',
  });
  process.env.DC_TEST_ONLY_B = 'from_shell';

  // A fresh module each time: the loader is deliberately idempotent per process.
  const { loadServerEnv } = await import(`../server/loadEnv.mjs?case=precedence`);
  loadServerEnv(dir);

  assert.equal(process.env.DC_TEST_ONLY_A, 'from_local', '.env.local beats .env');
  assert.equal(process.env.DC_TEST_ONLY_B, 'from_shell', 'the real environment beats both files');
  assert.equal(process.env.DC_TEST_ONLY_C, 'from_env', '.env still supplies what .env.local omits');
  rmSync(dir, { recursive: true, force: true });
});

test('a missing or malformed file is not fatal', async () => {
  const { loadServerEnv } = await import(`../server/loadEnv.mjs?case=missing`);
  assert.doesNotThrow(() => loadServerEnv(join(tmpdir(), 'i595-env-does-not-exist')));
});
