/**
 * Read the server-side `.env` files into process.env.
 *
 * Vite loads `.env*` for the CLIENT bundle and exposes only `VITE_`-prefixed variables there. The
 * server-side credentials in this app are deliberately NOT `VITE_`-prefixed — a `VITE_` variable is
 * compiled into the public bundle, so a password in one would ship to every visitor — which means
 * Vite never puts them anywhere we can read. Node does not read `.env` files on its own either, so
 * without this the DataConnect proxy and `npm run dc:classes` would report "not configured" even
 * with a correctly filled `.env.local`.
 *
 * Precedence, highest first: the real environment, then `.env.local`, then `.env` — a variable
 * already set in the shell or in CI always wins, which is how Node's own `--env-file` behaves.
 *
 * `process.loadEnvFile` never overwrites a variable that is already set, so the files are read
 * most-specific FIRST: whichever gets there first keeps the value.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let loaded = false;

/** Idempotent: several entry points import this, the files are read once. */
export function loadServerEnv(root = projectRoot) {
  if (loaded) return;
  loaded = true;
  for (const name of ['.env.local', '.env']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch (error) {
      // A malformed file should say so by name, never by dumping its contents.
      console.warn(`[env] could not read ${name}: ${error?.message ?? error}`);
    }
  }
}
