#!/usr/bin/env node
/**
 * Discover DataConnect's classes, so class ids come from the API rather than a guess.
 *
 * Usage:  npm run dc:classes    (reads the DC_* credentials from cesium-poc/.env.local)
 *
 * Prints id, name and record count only — never a token, a password or a header.
 */
import { createDataConnectApi, loadDataConnectConfig, missingConfig, tokenExpiry } from '../server/dataConnect.mjs';
import { loadServerEnv } from '../server/loadEnv.mjs';

loadServerEnv();
const config = loadDataConnectConfig();
const missing = missingConfig(config);
if (missing.length) {
  console.error(`DataConnect is not configured. Set: ${missing.join(', ')} (in cesium-poc/.env.local, NOT VITE_-prefixed).`);
  process.exit(1);
}
// A pasted token carries its own expiry; say so before spending a request to rediscover it.
const expiry = config.staticToken ? tokenExpiry(config.staticToken) : null;
if (expiry?.expired) {
  console.error(`\nDC_ACCESS_TOKEN expired at ${expiry.expiresAt.toISOString()} (${-expiry.minutesLeft} minutes ago).`);
  console.error('Copy a fresh token from Swagger into cesium-poc/.env.local and run this again.');
  process.exit(1);
}
if (expiry) console.log(`Using DC_ACCESS_TOKEN — expires in ${expiry.minutesLeft} minutes.\n`);

const api = createDataConnectApi({ config });

let classes;
try {
  classes = await api.classes();
} catch (error) {
  // Status and message only, and a hint at the likely cause — never the request or its headers.
  const status = Number(error?.status) || 0;
  console.error(`\n${error?.message ?? 'DataConnect request failed'}\n`);
  if (error?.oauthError === 'unauthorized_client') {
    console.error(`This client may not use the "${config.grant}" grant. The credentials are not the problem.`);
    console.error('  · A SPA/native client (id starting "spa-") is registered for authorization-code');
    console.error('    + PKCE, and Bentley IMS refuses the password grant on it whatever you send.');
    console.error('  · Ask for a SERVICE client instead, then set DC_CLIENT_ID + DC_CLIENT_SECRET and');
    console.error('    drop DC_USERNAME/DC_PASSWORD — this tool switches to client_credentials.');
  } else if (status === 401 && config.staticToken) {
    // No sign-in happened here — the pasted token itself was refused.
    console.error('DataConnect refused DC_ACCESS_TOKEN. Either it has expired since you copied it,');
    console.error(`or it is not valid for ${config.baseUrl} (a token issued for a different audience`);
    console.error('will authenticate fine elsewhere and still be rejected here).');
  } else if (status === 401) {
    console.error('The token endpoint rejected the sign-in. Usual causes:');
    console.error('  · DC_USERNAME / DC_PASSWORD are wrong;');
    console.error(`  · DC_SCOPE (currently "${config.scope}") is not one this client may request.`);
  } else if (status === 403) {
    console.error('Signed in, but this account may not list classes on that instance.');
  } else if (status === 404) {
    console.error(`No class list at ${config.baseUrl}${config.classesPath} — set DC_CLASSES_PATH if it moved.`);
  } else {
    console.error(`Could not reach ${config.baseUrl || 'DataConnect'}. Check DC_BASE_URL and the network.`);
  }
  process.exit(1);
}

console.log(`${classes.length} classes on ${config.baseUrl}\n`);
for (const entry of classes) {
  const id = entry.id ?? entry.classId ?? entry.key ?? '—';
  const name = entry.name ?? entry.className ?? entry.displayName ?? '—';
  const count = entry.recordCount ?? entry.totalCount ?? '';
  console.log(`${String(id).padEnd(38)} ${String(name).padEnd(34)} ${count}`);
}
