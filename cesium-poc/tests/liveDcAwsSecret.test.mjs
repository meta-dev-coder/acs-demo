import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { applyServiceClientSecret } from '../server/liveDc/awsSecret.mjs';

const SECRET_NAME = 'i595/dataconnect/service-client';
const CLIENT_ID = 'test-client-id-123';
const CLIENT_SECRET = 'test-client-secret-XYZ';

function fakeSpawn({ stdout = '', stderr = '', code = 0, error = null } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

function recordingLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, logger: { log, info: log, warn: log, error: log } };
}

test('awsSecret: unset secret name leaves the environment alone and spawns nothing', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const env = { DC_WRITER_ACCESS_TOKEN_FILE: '/x' };
  const result = await applyServiceClientSecret({ env, spawnImpl });
  assert.equal(result.applied, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(env, { DC_WRITER_ACCESS_TOKEN_FILE: '/x' });
});

test('awsSecret: explicit DC_WRITER_CLIENT_ID/SECRET win; the CLI is not called', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const env = { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME, DC_WRITER_CLIENT_ID: 'a', DC_WRITER_CLIENT_SECRET: 'b' };
  const result = await applyServiceClientSecret({ env, spawnImpl });
  assert.equal(result.applied, false);
  assert.equal(calls.length, 0);
  assert.equal(env.DC_WRITER_CLIENT_ID, 'a');
});

test('awsSecret: success sets the client in-process with the right aws command and never logs values', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: `${JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })}\n` });
  const { lines, logger } = recordingLogger();
  const env = { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME, LIVE_DC_AWS_REGION: 'us-west-2' };
  const result = await applyServiceClientSecret({ env, spawnImpl, logger });
  assert.equal(result.applied, true);
  assert.equal(env.DC_WRITER_CLIENT_ID, CLIENT_ID);
  assert.equal(env.DC_WRITER_CLIENT_SECRET, CLIENT_SECRET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'aws');
  assert.deepEqual(calls[0].args, ['secretsmanager', 'get-secret-value', '--secret-id', SECRET_NAME,
    '--region', 'us-west-2', '--query', 'SecretString', '--output', 'text']);
  const text = lines.join('\n') + JSON.stringify(result);
  assert.ok(!text.includes(CLIENT_SECRET) && !text.includes(CLIENT_ID), 'values never logged or returned');
});

test('awsSecret: region defaults to us-east-1', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }) });
  await applyServiceClientSecret({ env: { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME }, spawnImpl, logger: recordingLogger().logger });
  assert.equal(calls[0].args[calls[0].args.indexOf('--region') + 1], 'us-east-1');
});

test('awsSecret: a missing aws CLI is a clear error', async () => {
  const error = Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' });
  const { spawnImpl } = fakeSpawn({ error });
  const env = { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME };
  await assert.rejects(applyServiceClientSecret({ env, spawnImpl, logger: recordingLogger().logger }), /aws CLI not found/);
  assert.equal(env.DC_WRITER_CLIENT_ID, undefined);
});

test('awsSecret: access denied points at the instance role policy', async () => {
  const { spawnImpl } = fakeSpawn({ code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the GetSecretValue operation: User is not authorized' });
  const env = { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME };
  await assert.rejects(applyServiceClientSecret({ env, spawnImpl, logger: recordingLogger().logger }),
    error => /access denied/i.test(error.message) && /iam-policy\.json/.test(error.message) && error.message.includes(SECRET_NAME));
  assert.equal(env.DC_WRITER_CLIENT_SECRET, undefined);
});

test('awsSecret: malformed or incomplete JSON fails without echoing the content', async () => {
  for (const stdout of ['not-json-but-maybe-a-secret-XYZ', JSON.stringify({ client_id: CLIENT_ID }), JSON.stringify({ client_secret: CLIENT_SECRET })]) {
    const { spawnImpl } = fakeSpawn({ stdout });
    const { lines, logger } = recordingLogger();
    const env = { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME };
    await assert.rejects(applyServiceClientSecret({ env, spawnImpl, logger }), error => {
      assert.match(error.message, /client_id.*client_secret/);
      for (const leaked of ['XYZ', CLIENT_ID, CLIENT_SECRET]) assert.ok(!error.message.includes(leaked));
      return true;
    });
    assert.ok(!lines.join('\n').includes('XYZ'));
    assert.equal(env.DC_WRITER_CLIENT_ID, undefined);
  }
});

test('awsSecret: any other CLI failure reports the exit code', async () => {
  const { spawnImpl } = fakeSpawn({ code: 255, stderr: 'Could not connect to the endpoint URL' });
  await assert.rejects(applyServiceClientSecret({ env: { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME }, spawnImpl, logger: recordingLogger().logger }),
    /exit 255/);
});

test('awsSecret: also configures the read clients (live-dc read proxy, DataConnect proxy) when they are unset', async () => {
  const { spawnImpl } = fakeSpawn({ stdout: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }) });
  const env = { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME };
  const result = await applyServiceClientSecret({ env, spawnImpl, logger: recordingLogger().logger });
  for (const [id, secret] of [['DC_WRITER_CLIENT_ID', 'DC_WRITER_CLIENT_SECRET'], ['LIVE_DC_READ_CLIENT_ID', 'LIVE_DC_READ_CLIENT_SECRET'], ['DC_CLIENT_ID', 'DC_CLIENT_SECRET']]) {
    assert.equal(env[id], CLIENT_ID, id);
    assert.equal(env[secret], CLIENT_SECRET, secret);
  }
  assert.ok(!JSON.stringify(result).includes(CLIENT_SECRET));
});

test('awsSecret: explicitly configured read clients are left alone', async () => {
  const { spawnImpl } = fakeSpawn({ stdout: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }) });
  const env = { LIVE_DC_SERVICE_CLIENT_SECRET_NAME: SECRET_NAME, LIVE_DC_READ_CLIENT_ID: 'r-id', LIVE_DC_READ_CLIENT_SECRET: 'r-secret', DC_CLIENT_ID: 'spa-id', DC_USERNAME: 'u' };
  await applyServiceClientSecret({ env, spawnImpl, logger: recordingLogger().logger });
  assert.equal(env.LIVE_DC_READ_CLIENT_ID, 'r-id');
  assert.equal(env.LIVE_DC_READ_CLIENT_SECRET, 'r-secret');
  assert.equal(env.DC_CLIENT_ID, 'spa-id', 'a configured DataConnect client keeps its own grant');
  assert.equal(env.DC_CLIENT_SECRET, undefined);
  assert.equal(env.DC_WRITER_CLIENT_ID, CLIENT_ID);
});
