import { loadConfig } from './config.mjs';
import { createLiveEventsApi, createSnapshotApi } from './api.mjs';
import { createMessageSignsApi } from './messageSigns.mjs';
import { createLiveDcReadApi, loadLiveDcReadConfig } from './liveDc/liveReadApi.mjs';
import { createDataConnectApi, loadDataConnectConfig } from './dataConnect.mjs';

/**
 * The read-only API handlers. `dataDir`, `service` and `network` let a host share the corridor data and
 * FL511 poller it already has (the EC2 live-dc process); `dataConnect` adds the /api/dataconnect proxy.
 */
export function createReadApiHandlers({ config = loadConfig(), env = process.env, logger = console, dataDir, service, network, dataConnect = false } = {}) {
  // One read proxy serves both /api/live-dc/* and ?source=dataconnect, as in vite.config.js.
  const liveDcReadApi = createLiveDcReadApi({ config: loadLiveDcReadConfig(env), logger });
  const shared = { ...(dataDir ? { dataDir } : {}) };
  const api = createLiveEventsApi({ config, liveDc: liveDcReadApi, logger, service, network, ...shared });
  const handlers = [api, createSnapshotApi({ logger, ...shared }), createMessageSignsApi({ config, network, ...shared }), liveDcReadApi];
  if (dataConnect) handlers.push(createDataConnectApi({ config: loadDataConnectConfig(env), logger }));
  return { handlers, stop: () => api.stop() };
}
