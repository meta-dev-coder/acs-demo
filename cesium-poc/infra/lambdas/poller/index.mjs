/**
 * FL511 poller Lambda — polls FL511 for I-595 live events, diffs against the current DynamoDB
 * state, writes changes, and emits an EventBridge event when anything has changed.
 *
 * Environment variables:
 *   LIVE_EVENTS_TABLE  — DynamoDB table name for event state
 *   EVENTS_BUS_ARN     — EventBridge event bus ARN (or name)
 *   DATA_DIR           — directory containing the corridor GeoJSON files
 *                        (defaults to /var/task/data, where CDK bundles them)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

import { loadConfig } from '../../../server/config.mjs';
import { loadI595Network } from '../../../server/i595Network.mjs';
import { createFl511Service } from '../../../server/fl511Service.mjs';

// ---------------------------------------------------------------------------
// AWS clients (module scope — reused across warm invocations)
// ---------------------------------------------------------------------------

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const eb = new EventBridgeClient({});

// ---------------------------------------------------------------------------
// Lazy service initialisation — only pays the cold-start cost once
// ---------------------------------------------------------------------------

let service = null;

const getService = async () => {
  if (service) return service;
  const config = loadConfig();
  const dataDir = process.env.DATA_DIR ?? '/var/task/data';
  const network = await loadI595Network(dataDir);
  service = createFl511Service({ config, network, logger: console });
  return service;
};

// ---------------------------------------------------------------------------
// Helper: scan the entire LIVE_EVENTS_TABLE and return a Map keyed by eventId
// ---------------------------------------------------------------------------

async function scanCurrentState(tableName) {
  const items = new Map();
  let lastKey;
  do {
    const resp = await dynamo.send(new ScanCommand({
      TableName: tableName,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const item of resp.Items ?? []) {
      if (item.eventId) items.set(item.eventId, item);
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (_event) => {
  try {
    const tableName = process.env.LIVE_EVENTS_TABLE;
    const busProp  = process.env.EVENTS_BUS_ARN;

    if (!tableName) throw new Error('LIVE_EVENTS_TABLE environment variable is not set');
    if (!busProp)   throw new Error('EVENTS_BUS_ARN environment variable is not set');

    // 1. Fetch live events from FL511 via the service layer
    const svc = await getService();
    const payload = await svc.getI595LiveEvents();

    // 2. Build new-state Map from payload — keyed by event.id (the stable sorted key)
    const newState = new Map();
    for (const event of payload.events ?? []) {
      newState.set(event.id, event);
    }

    // 3. Read current state from DynamoDB
    const oldState = await scanCurrentState(tableName);

    // 4. Compute diff
    const added   = [];
    const updated = [];
    const removed = [];

    for (const [id, event] of newState) {
      if (!oldState.has(id)) {
        added.push(event);
      } else {
        // Compare only the event payload, not the DynamoDB housekeeping fields
        const { eventId: _eid, lastUpdated: _lu, ttl: _ttl, ...oldCore } = oldState.get(id);
        if (JSON.stringify(event) !== JSON.stringify(oldCore)) {
          updated.push(event);
        }
      }
    }

    for (const id of oldState.keys()) {
      if (!newState.has(id)) removed.push(id);
    }

    if (added.length + removed.length + updated.length === 0) {
      console.log('no change');
      return;
    }

    // 5. Write changes to DynamoDB
    const nowIso = new Date().toISOString();
    const ttl    = Math.floor(Date.now() / 1000) + 86400; // 24 h from now

    const writes = [];

    for (const event of [...added, ...updated]) {
      writes.push(
        dynamo.send(new PutCommand({
          TableName: tableName,
          Item: { eventId: event.id, ...event, lastUpdated: nowIso, ttl },
        }))
      );
    }

    for (const id of removed) {
      writes.push(
        dynamo.send(new DeleteCommand({
          TableName: tableName,
          Key: { eventId: id },
        }))
      );
    }

    await Promise.all(writes);

    // 6. Emit EventBridge event
    await eb.send(new PutEventsCommand({
      Entries: [{
        Source: 'i595.poller',
        DetailType: 'EventsChanged',
        EventBusName: busProp,
        Detail: JSON.stringify({
          added,
          removed,
          updated,
          timestamp: nowIso,
        }),
      }],
    }));

    // 7. Summary log
    console.log(
      `FL511 poller: +${added.length} added, ~${updated.length} updated, -${removed.length} removed` +
      ` (sourceStatus=${payload.sourceStatus}, total=${newState.size})`
    );
  } catch (err) {
    // Log but do not rethrow — EventBridge scheduler retries are not useful here because a
    // transient FL511 outage is already handled inside fl511Service (it serves cached data).
    console.error('FL511 poller error:', err);
  }
};
