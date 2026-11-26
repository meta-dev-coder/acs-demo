/**
 * `npm run aps:check`: the APS connection test without a browser. Reads APS_* from the environment
 * and .env files, then asks Autodesk for a two-legged token to prove the client id and secret are
 * accepted. Prints only the verdict: the token is discarded and no credential is echoed.
 */
import { loadServerEnv } from '../server/loadEnv.mjs';
import { checkCredentials, loadApsConfig } from '../server/aps/oauth.mjs';

loadServerEnv();
const config = loadApsConfig();
console.log(`client id: …${config.clientId.slice(-4) || '(not set)'}   callback: ${config.callbackUrl || '(not set)'}   scope: ${config.scope}`);
for (const problem of config.problems) console.log(`problem: ${problem}`);
const result = await checkCredentials(config);
console.log(`credentials: ${result.credentials}. ${result.detail}`);
if (result.hint) console.log(`hint: ${result.hint}`);
process.exitCode = result.credentials === 'valid' ? 0 : 1;
