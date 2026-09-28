/**
 * Confirms the service client can mint a token and read DataConnect. No secret is printed.
 * Run from cesium-poc:  node <this file>
 */
import { loadServerEnv } from './server/loadEnv.mjs';
loadServerEnv();

const id = process.env.LIVE_DC_READ_CLIENT_ID, secret = process.env.LIVE_DC_READ_CLIENT_SECRET;
if (!id || !secret || id.startsWith('REPLACE_ME') || secret.startsWith('REPLACE_ME')) {
  console.error('LIVE_DC_READ_CLIENT_ID / _SECRET are still placeholders in .env.local.');
  process.exit(2);
}

const res = await fetch(process.env.LIVE_DC_READ_TOKEN_URL || 'https://ims.bentley.com/connect/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret,
    scope: process.env.LIVE_DC_READ_SCOPE || 'itwin-platform' }),
});
if (!res.ok) {
  const code = await res.json().then(p => p?.error, () => null);
  console.error(`1. token: FAILED (HTTP ${res.status}${code ? ': ' + code : ''})`);
  if (code === 'invalid_client') console.error('   -> wrong client id/secret, or the app is not a service app.');
  if (code === 'invalid_scope') console.error('   -> the service app is not entitled to this scope.');
  process.exit(1);
}
const { access_token, expires_in } = await res.json();
console.log(`1. token: OK (expires in ${Math.round((expires_in || 3600) / 60)} min, auto-renewed by the server)`);

const base = (process.env.LIVE_DC_READ_BASE_URL || '').replace(/\/+$/, '');
const prefix = process.env.LIVE_DC_READ_DATA_MGMT_PREFIX || '/api/data-mgmt/v1';
const classes = await fetch(`${base}${prefix}/class`, {
  headers: { authorization: `Bearer ${access_token}`, accept: 'application/json' },
});
if (!classes.ok) {
  console.error(`2. read: FAILED (HTTP ${classes.status})`);
  if (classes.status === 401 || classes.status === 403) {
    console.error('   -> token is valid but this service user has no DataConnect access yet.');
    console.error('      That is the client-side step: the service client email must be added as a DataConnect service user.');
  }
  process.exit(1);
}
const payload = await classes.json();
const all = Array.isArray(payload) ? payload : payload?.data ?? payload?.classes ?? [];
const live = all.filter(c => /^SDNA Florida I595 Live /.test(c?.className || ''));
console.log(`2. read: OK (${all.length} classes visible, ${live.length}/6 SDNA Live classes)`);
if (live.length < 6) { console.error('   -> fewer than 6 Live classes; the service user may have partial access.'); process.exit(1); }
console.log('\nBoth legs pass. Restart the dev server and the twin will stay connected without dc:login.');
