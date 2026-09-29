/**
 * DataConnect service client from Secrets Manager via the AWS CLI (EC2 instance role; no SDK, no keys).
 * Sets DC_WRITER_CLIENT_ID/SECRET, and the read clients LIVE_DC_READ_CLIENT_* and DC_CLIENT_* when unset,
 * in this process only; values are never logged or returned.
 */
import { spawn } from 'node:child_process';

const DEFAULT_REGION = 'us-east-1';
const READ_CLIENTS = Object.freeze([['LIVE_DC_READ_CLIENT_ID', 'LIVE_DC_READ_CLIENT_SECRET'], ['DC_CLIENT_ID', 'DC_CLIENT_SECRET']]);
const POLICY_HINT = 'attach deploy/ec2/iam-policy.json to the instance role';

function runAws(spawnImpl, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill?.('SIGKILL'); finish(new Error('aws secretsmanager timed out')); }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, { code, stdout, stderr }));
  });
}

export async function applyServiceClientSecret({ env = process.env, spawnImpl = spawn, logger = console, timeoutMs = 20_000 } = {}) {
  const name = String(env.LIVE_DC_SERVICE_CLIENT_SECRET_NAME ?? '').trim();
  if (!name) return { applied: false, reason: 'unset' };
  if (env.DC_WRITER_CLIENT_ID && env.DC_WRITER_CLIENT_SECRET) return { applied: false, reason: 'client already set' };
  const region = String(env.LIVE_DC_AWS_REGION ?? '').trim() || DEFAULT_REGION;
  const args = ['secretsmanager', 'get-secret-value', '--secret-id', name, '--region', region, '--query', 'SecretString', '--output', 'text'];

  let result;
  try {
    result = await runAws(spawnImpl, args, timeoutMs);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('aws CLI not found on PATH: install AWS CLI v2 to read the DataConnect service-client secret');
    throw new Error(`reading secret ${name} failed: ${error?.message ?? error}`);
  }
  if (result.code !== 0) {
    if (/AccessDenied|not authorized|UnrecognizedClient|NoCredentials|Unable to locate credentials/i.test(result.stderr)) {
      throw new Error(`access denied reading secret ${name} in ${region}: ${POLICY_HINT}`);
    }
    if (/ResourceNotFound/i.test(result.stderr)) throw new Error(`secret ${name} not found in ${region}`);
    throw new Error(`aws secretsmanager exit ${result.code} reading ${name}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }

  let parsed = null;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { /* reported below without the content */ }
  const clientId = typeof parsed?.client_id === 'string' ? parsed.client_id.trim() : '';
  const clientSecret = typeof parsed?.client_secret === 'string' ? parsed.client_secret.trim() : '';
  if (!clientId || !clientSecret) throw new Error(`secret ${name} must be JSON {"client_id","client_secret"}`);

  env.DC_WRITER_CLIENT_ID = clientId;
  env.DC_WRITER_CLIENT_SECRET = clientSecret;
  for (const [id, secret] of READ_CLIENTS) {
    if (env[id] || env[secret]) continue;
    env[id] = clientId;
    env[secret] = clientSecret;
  }
  logger.log?.(`live-dc service client: Secrets Manager ${name} (${region})`);
  return { applied: true, secretName: name, region };
}
