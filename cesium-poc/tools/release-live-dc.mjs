#!/usr/bin/env node
/**
 * Builds deploy/ec2/dist and packs it as deploy/ec2/releases/live-dc-<UTC stamp>.tar.gz plus .sha256 and a
 * "latest" pointer, then prints (never runs) the `aws s3 cp` upload commands. Secret-looking files
 * (.env*, token files, .dc-*, keys) are left out, and a secret-looking value anywhere refuses the release.
 *
 *   node tools/release-live-dc.mjs [--skip-build] [--no-env-files]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT_DIR, buildLiveDcBundle } from './build-live-dc-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_RELEASE_DIR = join(ROOT, 'deploy', 'ec2', 'releases');
export const RELEASE_BUCKET = 'i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj';
export const RELEASE_PREFIX = 'releases/live-dc';
export const REQUIRED_ENTRIES = Object.freeze(['live-dc-sync.mjs', 'data', 'web/index.html', 'livedc.sh', 'install.sh', 'live-dc.service', 'env.example']);

const EXCLUDED_NAME = /^\.env|token|^\.dc-|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)|^\.git$|^\.DS_Store$|^\._/i;
const SECRET_VALUE = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{43}/,
  /aws_secret_access_key\s*[=:]\s*\S{20,}/i,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
];
const TEXT = new Set(['.mjs', '.js', '.json', '.geojson', '.html', '.css', '.sh', '.service', '.example', '.txt', '.map', '.svg', '']);

export const isExcludedName = name => EXCLUDED_NAME.test(name);

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, base, out); else out.push(relative(base, path));
  }
  return out;
}

const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export async function releaseLiveDc({
  distDir = DEFAULT_OUT_DIR, outDir = DEFAULT_RELEASE_DIR, build = true, envFiles = true, now = Date.now, logger = console,
  bucket = RELEASE_BUCKET, prefix = RELEASE_PREFIX,
} = {}) {
  if (build) await buildLiveDcBundle({ outDir: distDir, envFiles, logger });
  for (const entry of REQUIRED_ENTRIES) {
    if (!existsSync(join(distDir, entry))) throw new Error(`${join(distDir, entry)} is missing: build first (npm run live-dc:bundle)`);
  }

  const staging = mkdtempSync(join(tmpdir(), 'live-dc-release-'));
  const excluded = [];
  try {
    cpSync(distDir, staging, {
      recursive: true,
      filter: source => {
        if (source === distDir || !isExcludedName(basename(source))) return true;
        excluded.push(relative(distDir, source));
        return false;
      },
    });
    for (const file of walk(staging)) {
      if (!TEXT.has(extname(file).toLowerCase())) continue;
      const text = readFileSync(join(staging, file), 'utf8');
      if (SECRET_VALUE.some(pattern => pattern.test(text))) throw new Error(`refusing to release: ${file} contains a secret-looking value`);
    }

    const version = `live-dc-${stamp(now())}`;
    mkdirSync(outDir, { recursive: true });
    const tarball = join(outDir, `${version}.tar.gz`);
    execFileSync('tar', ['--no-xattrs', '-czf', tarball, '-C', staging, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const entries = execFileSync('tar', ['-tzf', tarball]).toString().split('\n').filter(Boolean);
    const leaked = entries.filter(entry => entry.split('/').some(part => part && part !== '.' && isExcludedName(part)));
    if (leaked.length) { rmSync(tarball, { force: true }); throw new Error(`refusing to release: ${leaked.join(', ')}`); }

    const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    writeFileSync(`${tarball}.sha256`, `${sha256}  ${basename(tarball)}\n`);
    const latest = join(outDir, 'latest');
    writeFileSync(latest, `${version}\n`);

    const s3 = `s3://${bucket}/${prefix}`;
    const commands = [
      `aws s3 cp ${tarball} ${s3}/${basename(tarball)}`,
      `aws s3 cp ${tarball}.sha256 ${s3}/${basename(tarball)}.sha256`,
      `aws s3 cp ${latest} ${s3}/latest --content-type text/plain --cache-control no-store`,
    ];
    if (excluded.length) logger.warn?.(`live-dc release: excluded ${excluded.join(', ')}`);
    logger.log?.(`live-dc release ${version}: ${tarball} (${Math.round(statSync(tarball).size / 1024 / 1024)} MiB, sha256 ${sha256})`);
    logger.log?.(`Upload with the uploader credentials (latest last, so it never points at a missing tarball):\n${commands.join('\n')}`);
    logger.log?.('Then on the instance: sudo /opt/live-dc/livedc.sh update latest');
    return { version, tarball, sha256, latest, commands, excluded };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  releaseLiveDc({ build: !argv.includes('--skip-build'), envFiles: !argv.includes('--no-env-files') }).catch(error => {
    console.error(`release-live-dc: ${error.message}`);
    process.exitCode = 1;
  });
}
