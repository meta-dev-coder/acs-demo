/**
 * FL511 poller Lambda — polls FL511 for I-595 live events, diffs against the current DynamoDB
 * state, writes changes, and emits an EventBridge event when anything has changed. Also writes the
 * same events to Live DataConnect, signed in with the DataConnect service client (see poller.mjs).
 *
 * Environment variables:
 *   LIVE_EVENTS_TABLE  — DynamoDB table name for event state
 *   EVENTS_BUS_ARN     — EventBridge event bus ARN (or name)
 *   DATA_DIR           — directory containing the corridor GeoJSON files
 *                        (defaults to /var/task/data, where CDK bundles them)
 *   DC_SERVICE_CLIENT_SECRET_NAME — Secrets Manager secret {"client_id","client_secret"}
 *                        (default i595/dataconnect/service-client)
 *   LIVE_DC_STATUS_BUCKET — bucket for status/live-dc-status.json (unset = no status file)
 *   LIVE_DC_HOLD_OPEN  — comma list of Live Events keys kept active
 *   DC_WRITER_*, LIVE_DC_* — as for tools/live-dc-sync.mjs; LIVE_DC_DATA_DIR = DATA_DIR
 *   LIVE_DC_SNAPSHOT_BUCKET / LIVE_DC_SNAPSHOT_PUBLIC_BASE — event camera snapshots to snapshots/ in
 *                        that bucket, linked through CloudFront (unset = no snapshots)
 *   LIVE_DC_PUBLIC_API_BASE — makes camera_snapshot_url absolute (the CloudFront origin)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import { loadConfig } from '../../../server/config.mjs';
import { loadI595Network } from '../../../server/i595Network.mjs';
import { createFl511Service } from '../../../server/fl511Service.mjs';
import { createS3SnapshotStore } from '../../../server/liveDc/eventSnapshots.mjs';
import {
  DEFAULT_SERVICE_CLIENT_SECRET_NAME, LIVE_DC_STATUS_KEY, createPollerHandler, createSecretCredentials,
} from './poller.mjs';

// AWS clients (module scope — reused across warm invocations)
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const eb = new EventBridgeClient({});
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});

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

const credentials = createSecretCredentials({
  secretName: process.env.DC_SERVICE_CLIENT_SECRET_NAME || DEFAULT_SERVICE_CLIENT_SECRET_NAME,
  readSecret: async name => (await secrets.send(new GetSecretValueCommand({ SecretId: name }))).SecretString,
});

const statusBucket = process.env.LIVE_DC_STATUS_BUCKET;
const writeStatus = async status => {
  if (!statusBucket) return;
  await s3.send(new PutObjectCommand({
    Bucket: statusBucket,
    Key: LIVE_DC_STATUS_KEY,
    Body: JSON.stringify(status),
    ContentType: 'application/json',
    CacheControl: 'no-store',
  }));
};

const snapshotBucket = process.env.LIVE_DC_SNAPSHOT_BUCKET;
const snapshotPublicBase = process.env.LIVE_DC_SNAPSHOT_PUBLIC_BASE;
const snapshotStore = snapshotBucket && snapshotPublicBase
  ? createS3SnapshotStore({ send: command => s3.send(command), PutObjectCommand, bucket: snapshotBucket, publicBase: snapshotPublicBase })
  : null;

export const handler = createPollerHandler({ getService, ddb, emit, credentials, writeStatus, snapshotStore, env: process.env });
