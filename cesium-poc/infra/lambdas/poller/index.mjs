/**
 * FL511 poller Lambda — polls FL511 for I-595 live events, diffs against the current DynamoDB
 * state, writes changes, and emits an EventBridge event when anything has changed. TEMPORARY: also
 * writes the same events to Live DataConnect with the hand-off token (see poller.mjs).
 *
 * Environment variables:
 *   LIVE_EVENTS_TABLE  — DynamoDB table name for event state
 *   EVENTS_BUS_ARN     — EventBridge event bus ARN (or name)
 *   DATA_DIR           — directory containing the corridor GeoJSON files
 *                        (defaults to /var/task/data, where CDK bundles them)
 *   DC_TOKEN_BUCKET    — bucket holding secrets/dc-token.txt and status/live-dc-status.json
 *                        (unset = no DataConnect step)
 *   DC_WRITER_*, LIVE_DC_* — as for tools/live-dc-sync.mjs; LIVE_DC_DATA_DIR = DATA_DIR
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { loadConfig } from '../../../server/config.mjs';
import { loadI595Network } from '../../../server/i595Network.mjs';
import { createFl511Service } from '../../../server/fl511Service.mjs';
import { DC_TOKEN_OBJECT_KEY, LIVE_DC_STATUS_KEY } from '../../../server/liveDc/tokenHandoff.mjs';
import { createPollerHandler } from './poller.mjs';

// AWS clients (module scope — reused across warm invocations)
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const eb = new EventBridgeClient({});
const s3 = new S3Client({});

// Lazy service initialisation — only pays the cold-start cost once
let service = null;
const getService = async () => {
  if (service) return service;
  const config = loadConfig();
  const dataDir = process.env.DATA_DIR ?? '/var/task/data';
  const network = await loadI595Network(dataDir);
  service = createFl511Service({ config, network, logger: console });
  return service;
};

const ddb = {
  async scanAll(tableName) {
    const items = [];
    let lastKey;
    do {
      const resp = await dynamo.send(new ScanCommand({
        TableName: tableName,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      items.push(...(resp.Items ?? []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    return items;
  },
  put: (tableName, item) => dynamo.send(new PutCommand({ TableName: tableName, Item: item })),
  remove: (tableName, key) => dynamo.send(new DeleteCommand({ TableName: tableName, Key: key })),
};

const emit = entry => eb.send(new PutEventsCommand({ Entries: [entry] }));

const bucket = process.env.DC_TOKEN_BUCKET;
const tokenStore = bucket ? {
  async read() {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: DC_TOKEN_OBJECT_KEY }));
      return await res.Body.transformToString('utf8');
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  },
  writeStatus: status => s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: LIVE_DC_STATUS_KEY,
    Body: JSON.stringify(status),
    ContentType: 'application/json',
    CacheControl: 'no-store',
  })),
} : null;

export const handler = createPollerHandler({ getService, ddb, emit, tokenStore, env: process.env });
