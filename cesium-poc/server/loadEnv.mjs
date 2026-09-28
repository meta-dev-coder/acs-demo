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
 *
 * `process.loadEnvFile` only exists from Node 20.12, and where it is missing this parses the file
 * itself rather than skipping it. Skipping was the original behaviour and it was the wrong one: on
 * an older Node every DC_* and LIVE_DC_* variable was silently ignored and the app reported
 * "DataConnect not connected" with nothing but one line in the terminal to say why — which reads
 * as a broken checkout rather than a Node version.
 */
import { existsSync, readFileSync } from 'node:fs';
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
      if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path);
      else applyEnvFile(path);
    } catch (error) {
      // A malformed file should say so by name, never by dumping its contents.
      console.warn(`[env] could not read ${name}: ${error?.message ?? error}`);
    }
  }
}

/**
 * The same job as `process.loadEnvFile`, for a Node that does not have it.
 *
 * Deliberately small and deliberately identical in the ways that matter: a variable already set in
 * the environment is never overwritten, `#` starts a comment, and a quoted value keeps whatever is
 * inside the quotes — the DataConnect password contains `$`, `!` and `^`, none of which may be
 * touched. Anything it cannot parse is skipped rather than guessed at, and never printed.
 */
export function applyEnvFile(path) {
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      // Only a double-quoted value carries escapes, exactly as the shell and dotenv treat them.
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // Unquoted: a `#` after whitespace begins a trailing comment.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}
