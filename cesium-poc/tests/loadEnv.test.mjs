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

test('the fallback parser matches process.loadEnvFile, value for value', async () => {
  // Node only gained `process.loadEnvFile` in 20.12. Below that the whole file used to be skipped,
  // which silently voided every DC_* and LIVE_DC_* setting; the fallback must agree with the real
  // thing or an older Node would be configured differently from a newer one.
  const dir = mkdtempSync(join(tmpdir(), 'i595-env-parity-'));
  const file = join(dir, '.env');
  writeFileSync(file, [
    'PARITY_PLAIN=hello',
    'PARITY_SPACED = spaced out ',
    '# a comment line',
    '',
    'PARITY_QUOTED="85^Gy$hfRX@!jVU"',
    "PARITY_SINGLE='keeps $literal'",
    'PARITY_TRAILING=value # not part of it',
    'PARITY_EMPTY=',
    'PARITY_URL=https://example.com/a/b?x=1&y=2',
    'export PARITY_EXPORTED=exported',
    'not a variable line',
  ].join('\n'));

  const keys = ['PARITY_PLAIN', 'PARITY_SPACED', 'PARITY_QUOTED', 'PARITY_SINGLE',
    'PARITY_TRAILING', 'PARITY_EMPTY', 'PARITY_URL', 'PARITY_EXPORTED'];
  const clear = () => { for (const key of keys) delete process.env[key]; };

  clear();
  const { applyEnvFile } = await import(`../server/loadEnv.mjs?case=parity`);
  applyEnvFile(file);
  const fallback = Object.fromEntries(keys.map(key => [key, process.env[key]]));

  clear();
  process.loadEnvFile(file);
  const native = Object.fromEntries(keys.map(key => [key, process.env[key]]));

  assert.deepEqual(fallback, native);
  // The one that actually matters: a password full of shell metacharacters survives intact.
  assert.equal(fallback.PARITY_QUOTED, '85^Gy$hfRX@!jVU');
  clear();
  rmSync(dir, { recursive: true, force: true });
});

test('the fallback never overwrites the real environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'i595-env-keep-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'PARITY_KEEP=from_file\n');
  process.env.PARITY_KEEP = 'from_shell';
  const { applyEnvFile } = await import(`../server/loadEnv.mjs?case=keep`);
  applyEnvFile(file);
  assert.equal(process.env.PARITY_KEEP, 'from_shell');
  delete process.env.PARITY_KEEP;
  rmSync(dir, { recursive: true, force: true });
});
