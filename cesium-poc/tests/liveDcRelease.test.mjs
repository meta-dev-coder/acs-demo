/**
 * EC2 releases: the tarball (bundle + data/ + web/ + ops files, never secrets), its sha256 and the
 * "latest" pointer, then livedc.sh update/rollback/uninstall against a fake S3 (fake `aws` CLI),
 * fake systemctl and a temporary root. Offline; no real aws, systemctl or network.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveDcBundle } from '../tools/build-live-dc-bundle.mjs';
import { RELEASE_BUCKET, RELEASE_PREFIX, releaseLiveDc } from '../tools/release-live-dc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVEDC = join(ROOT, 'deploy', 'ec2', 'livedc.sh');
const silent = { info() {}, log() {}, warn() {}, error() {} };
const listTar = file => execFileSync('tar', ['-tzf', file]).toString().split('\n').filter(Boolean).map(p => p.replace(/^\.\//, '')).filter(Boolean);

describe('release-live-dc', () => {
  let dir, dist, out;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-dc-release-'));
    const web = join(dir, 'web-fixture');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html>');
    writeFileSync(join(web, 'assets', 'app.js'), 'export {}');
    dist = join(dir, 'dist');
    await buildLiveDcBundle({ outDir: dist, web: { from: web }, logger: silent });
    // Secrets that must never ship, wherever they appear.
    writeFileSync(join(dist, '.env'), 'DC_CLIENT_SECRET=x');
    writeFileSync(join(dist, '.env.local'), 'DC_CLIENT_SECRET=x');
    writeFileSync(join(dist, '.dc-access-token'), 'eyJ...');
    writeFileSync(join(dist, '.dc-refresh-token'), 'r');
    writeFileSync(join(dist, 'web', '.env.production'), 'VITE_X=1');
    writeFileSync(join(dist, 'web', 'assets', 'service-token.json'), '{}');
    writeFileSync(join(dist, 'data', 'deploy-key.pem'), '-----BEGIN PRIVATE KEY-----');
    out = join(dir, 'releases');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('packs bundle, data/, web/ and ops files; excludes secrets; writes sha256 and latest; prints upload commands', async () => {
    const lines = [];
    const result = await releaseLiveDc({
      distDir: dist, outDir: out, build: false, now: () => Date.parse('2026-09-29T19:12:03Z'), logger: { log: l => lines.push(l), warn: l => lines.push(l) },
    });
    assert.equal(result.version, 'live-dc-20260929T191203Z');
    assert.equal(basename(result.tarball), 'live-dc-20260929T191203Z.tar.gz');
    const entries = listTar(result.tarball);
    for (const needed of ['live-dc-sync.mjs', 'data/i595_mainline_eb.geojson', 'web/index.html', 'web/assets/app.js', 'livedc.sh', 'install.sh', 'live-dc.service', 'env.example']) {
      assert.ok(entries.includes(needed), needed);
    }
    for (const entry of entries) {
      assert.ok(!/(^|\/)\.env/.test(entry), entry);
      assert.ok(!/token/i.test(basename(entry)), entry);
      assert.ok(!/(^|\/)\.dc-/.test(entry), entry);
      assert.ok(!/\.pem$/.test(entry), entry);
      assert.ok(!/(^|\/)\._/.test(entry), `AppleDouble ${entry}`);
    }
    const digest = createHash('sha256').update(readFileSync(result.tarball)).digest('hex');
    assert.equal(readFileSync(`${result.tarball}.sha256`, 'utf8'), `${digest}  live-dc-20260929T191203Z.tar.gz\n`);
    assert.equal(readFileSync(join(out, 'latest'), 'utf8'), 'live-dc-20260929T191203Z\n');
    assert.equal(RELEASE_BUCKET, 'i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj');
    assert.equal(RELEASE_PREFIX, 'releases/live-dc');
    const s3 = `s3://${RELEASE_BUCKET}/${RELEASE_PREFIX}`;
    assert.deepEqual(result.commands.map(c => c.split(' ').slice(0, 5).join(' ')), [
      `aws s3 cp ${result.tarball} ${s3}/live-dc-20260929T191203Z.tar.gz`,
      `aws s3 cp ${result.tarball}.sha256 ${s3}/live-dc-20260929T191203Z.tar.gz.sha256`,
      `aws s3 cp ${join(out, 'latest')} ${s3}/latest`,
    ]);
    const printed = lines.join('\n');
    for (const command of result.commands) assert.ok(printed.includes(command));
    assert.match(printed, /excluded .*\.env/);
  });

  test('refuses a dist without web/ or the bundle', async () => {
    const bare = join(dir, 'bare');
    cpSync(dist, bare, { recursive: true });
    rmSync(join(bare, 'web'), { recursive: true });
    await assert.rejects(releaseLiveDc({ distDir: bare, outDir: join(dir, 'r2'), build: false, logger: silent }), /web\/index\.html/);
    rmSync(join(bare, 'live-dc-sync.mjs'));
    await assert.rejects(releaseLiveDc({ distDir: bare, outDir: join(dir, 'r3'), build: false, logger: silent }), /live-dc-sync\.mjs/);
  });

  test('refuses a bundle that contains a secret value', async () => {
    const leaky = join(dir, 'leaky');
    cpSync(dist, leaky, { recursive: true });
    writeFileSync(join(leaky, 'web', 'assets', 'app.js'), 'const k="AKIAABCDEFGHIJKLMNOP";');
    await assert.rejects(releaseLiveDc({ distDir: leaky, outDir: join(dir, 'r4'), build: false, logger: silent }), /secret-looking/);
  });

  test('npm script and the release directory are wired', () => {
    assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['live-dc:release'], 'node tools/release-live-dc.mjs');
  });
});

describe('livedc.sh against a fake S3 and systemd', () => {
  let dir, bin, s3, root, conf, unit, log, env;
  const versions = [];

  const run = (args, { input } = {}) => spawnSync('bash', [join(root, 'livedc.sh'), ...args], { env, input: input ?? '', encoding: 'utf8' });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-dc-ops-'));
    bin = join(dir, 'bin');
    s3 = join(dir, 's3');
    root = join(dir, 'opt');
    conf = join(dir, 'etc');
    unit = join(dir, 'systemd', 'live-dc.service');
    log = join(dir, 'calls.log');
    mkdirSync(bin);
    mkdirSync(join(s3, 'bucket-x', 'releases', 'live-dc'), { recursive: true });
    mkdirSync(root);
    mkdirSync(conf);
    mkdirSync(dirname(unit));
    writeFileSync(join(conf, 'env'), 'LIVE_DC_RELEASE_BUCKET=bucket-x\nLIVE_DC_RELEASE_PREFIX=releases/live-dc\nLIVE_DC_HTTP_PORT=8095\n');
    cpSync(LIVEDC, join(root, 'livedc.sh'));
    writeFileSync(join(bin, 'aws'), `#!/bin/sh
echo "aws $*" >> "${log}"
[ "$1 $2" = "s3 cp" ] || exit 9
src="\${3#s3://}"
[ -f "${s3}/$src" ] || { echo "fatal error: An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 1; }
if [ "$4" = "-" ]; then cat "${s3}/$src"; else cp "${s3}/$src" "$4"; fi
`);
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n[ "$1" = "is-active" ] && echo active\n[ "$1" = "is-enabled" ] && echo enabled\nexit 0\n`);
    writeFileSync(join(bin, 'journalctl'), `#!/bin/sh\necho "journalctl $*" >> "${log}"\n`);
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho "curl $*" >> "${log}"\necho '{"ok":true,"lastCycleAt":"2026-09-29T19:00:00.000Z"}'\n`);
    writeFileSync(join(bin, 'userdel'), `#!/bin/sh\necho "userdel $*" >> "${log}"\n`);
    for (const f of ['aws', 'systemctl', 'journalctl', 'curl', 'userdel']) chmodSync(join(bin, f), 0o755);
    env = {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, LIVE_DC_TEST_MODE: '1',
      LIVE_DC_ROOT: root, LIVE_DC_CONF_DIR: conf, LIVE_DC_UNIT_PATH: unit, LIVE_DC_STATE_DIR: join(dir, 'state'),
    };

    const web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html>');
    const dist = join(dir, 'dist');
    await buildLiveDcBundle({ outDir: dist, web: { from: web }, logger: silent });
    for (let i = 0; i < 5; i++) {
      const result = await releaseLiveDc({
        distDir: dist, outDir: join(dir, `rel${i}`), build: false, now: () => Date.parse('2026-09-29T10:00:00Z') + i * 60_000, logger: silent,
      });
      versions.push(result.version);
      for (const file of [result.tarball, `${result.tarball}.sha256`]) cpSync(file, join(s3, 'bucket-x', 'releases', 'live-dc', basename(file)));
    }
    writeFileSync(join(s3, 'bucket-x', 'releases', 'live-dc', 'latest'), `${versions[0]}\n`);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const current = () => basename(readlinkSync(join(root, 'current')));

  test('usage and version validation', () => {
    assert.notEqual(run([]).status, 0);
    assert.equal(run(['bogus']).status, 2);
    const bad = run(['update', '../../etc/passwd']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /invalid version/);
  });

  test('update latest: fetch via aws, verify sha256, unpack, switch current atomically, restart', () => {
    const result = run(['update', 'latest']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(current(), versions[0]);
    assert.ok(existsSync(join(root, 'releases', versions[0], 'live-dc-sync.mjs')));
    assert.ok(existsSync(join(root, 'releases', versions[0], 'web', 'index.html')));
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, new RegExp(`aws s3 cp s3://bucket-x/releases/live-dc/latest -`));
    assert.match(calls, new RegExp(`aws s3 cp s3://bucket-x/releases/live-dc/${versions[0]}\\.tar\\.gz `));
    assert.match(calls, /systemctl restart live-dc/);
  });

  test('a checksum mismatch is refused and current is untouched', () => {
    const target = join(s3, 'bucket-x', 'releases', 'live-dc', `${versions[1]}.tar.gz.sha256`);
    const good = readFileSync(target, 'utf8');
    writeFileSync(target, `${'0'.repeat(64)}  ${versions[1]}.tar.gz\n`);
    const result = run(['update', versions[1]]);
    writeFileSync(target, good);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sha256/i);
    assert.equal(current(), versions[0]);
    assert.ok(!existsSync(join(root, 'releases', versions[1])));
  });

  test('keeps the last 3 releases', () => {
    for (const version of versions.slice(1)) assert.equal(run(['update', version]).status, 0);
    assert.equal(current(), versions[4]);
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), versions.slice(2).sort());
  });

  test('rollback switches to the previous release and restarts', () => {
    writeFileSync(log, '');
    const result = run(['rollback']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(current(), versions[3]);
    assert.match(readFileSync(log, 'utf8'), /systemctl restart live-dc/);
  });

  test('status shows systemd state and the last cycle from /healthz', () => {
    const result = run(['status']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /active/);
    assert.match(result.stdout, /2026-09-29T19:00:00\.000Z/);
    assert.match(readFileSync(log, 'utf8'), /curl .*http:\/\/127\.0\.0\.1:8095\/healthz/);
  });

  test('start / stop / restart / logs call systemd', () => {
    writeFileSync(log, '');
    for (const command of ['start', 'stop', 'restart', 'logs']) assert.equal(run([command]).status, 0, command);
    const calls = readFileSync(log, 'utf8');
    for (const expected of ['systemctl start live-dc', 'systemctl stop live-dc', 'systemctl restart live-dc', 'journalctl -u live-dc -f']) {
      assert.ok(calls.includes(expected), expected);
    }
  });

  test('uninstall asks for confirmation; -y removes the unit, the app and the config', () => {
    const declined = run(['uninstall'], { input: 'n\n' });
    assert.notEqual(declined.status, 0);
    assert.ok(existsSync(join(root, 'current')));
    writeFileSync(unit, '[Unit]');
    const result = run(['uninstall', '-y']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(root));
    assert.ok(!existsSync(conf));
    assert.ok(!existsSync(unit));
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /systemctl disable --now live-dc/);
    assert.match(calls, /systemctl daemon-reload/);
  });
});
