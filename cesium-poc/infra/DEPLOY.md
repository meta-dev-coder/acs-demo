# I-595 AWS Infrastructure — Deployment Guide

## Overview

This stack deploys:

- **S3** — GeoJSON corridor data files + built Vite app assets
- **CloudFront** — CDN in front of S3; routes `/api/i595/*` paths to Lambda Function URLs
- **DynamoDB** — two tables: `I595LiveEvents` (FL511 event state + TTL) and `I595WsConnections` (active WebSocket connections + TTL)
- **Lambda functions** — 8 functions (see [Lambda functions](#lambda-functions) below)
- **EventBridge Scheduler** — triggers the FL511 poller every minute (`i595-poller`)
- **EventBridge custom bus** — `i595-events`; routes poller output to the broadcaster
- **API Gateway WebSocket API** — `i595-websocket-api`; real-time push to connected browsers

---

## Live deployment (I595StackV5)

> Account: `589391957147` · Region: `us-east-1`

| Output | Value |
|--------|-------|
| CloudFront domain | `https://d3syo4sqvwi009.cloudfront.net` |
| WebSocket endpoint | `wss://b0wqexsnpk.execute-api.us-east-1.amazonaws.com/prod` |
| Snapshot proxy URL | `https://ru2wczlfzsxspos7k344smuqi40gnhrt.lambda-url.us-east-1.on.aws/` |
| Live events REST URL | `https://oxvrrzdzakomt7xk4ylyddgj6u0kekfr.lambda-url.us-east-1.on.aws/` |
| Ask the Twin URL | `https://ujcgxd7lgq34r4eutstfaou3nq0rdvsp.lambda-url.us-east-1.on.aws/` |
| S3 data bucket | `i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj` |
| Stack ARN | `arn:aws:cloudformation:us-east-1:589391957147:stack/I595StackV5/cebbbbb0-b02e-11f1-8f59-0affc49033f9` |

Full outputs are also in `cdk-outputs.json` after a deploy.

---

## Lambda functions

| CDK logical ID | Runtime | Purpose |
|----------------|---------|---------|
| `PollerFn` | Node.js 22 | Polls FL511 every minute; diffs against DynamoDB; emits `EventsChanged` to EventBridge |
| `SnapshotProxyFn` | Node.js 22 | Proxies DIVAS JPEG snapshots; validates channel IDs against `KNOWN_CHAN_IDS` env var |
| `WsConnectFn` | Node.js 22 | Handles `$connect`; writes connection record to DynamoDB |
| `WsDisconnectFn` | Node.js 22 | Handles `$disconnect`; removes connection record from DynamoDB |
| `WsDefaultFn` | Node.js 22 | Handles `$default`; fans out events to connected clients |
| `BroadcasterFn` | Node.js 22 | Triggered by EventBridge; pushes live event updates via WebSocket |
| `LiveEventsRestFn` | Node.js 22 | REST GET `/api/i595/live-events` → scans DynamoDB live events table |
| `AskTheTwinFn` | Node.js 22 | AI assistant; reads live events from DynamoDB, calls Anthropic API via Secrets Manager |

All functions use `PackageType: Zip` with ESM bundling (`esbuild`, `OutputFormat.ESM`), `@aws-sdk/*` externalized (provided by Lambda runtime).

---

## CloudFront routing

CloudFront sits in front of both S3 and Lambda Function URLs:

| Path pattern | Origin | Notes |
|-------------|--------|-------|
| `/data/*` | S3 bucket | Static GeoJSON; 24h cache |
| `/api/i595/camera/*` | SnapshotProxyFn URL | Camera JPEG proxy; 90s cache |
| `/api/i595/live-events*` | LiveEventsRestFn URL | Live FL511 events; no cache |
| `/api/i595/ask*` | AskTheTwinFn URL | AI chat; no cache |
| `/*` (default) | S3 bucket | Vite app assets |

---

## Camera snapshot proxy

### How it works

1. `cctvCameras.js` builds a URL: `${VITE_SNAPSHOT_BASE}/${divas_chan_id}/snapshot`
2. CloudFront routes `/api/i595/camera/*` → `SnapshotProxyFn`
3. Lambda validates the `divas_chan_id` against `KNOWN_CHAN_IDS` env var (rejects unknown IDs → 400)
4. Lambda fetches `https://images-dis.divas.cloud/DGI/chan-{id}_h.jpg` with a 5s timeout
5. Returns base64-encoded JPEG with `image/jpeg` content type and `max-age=90` cache header

### KNOWN_CHAN_IDS env var

Sourced from `public/data/i595_corridor_cameras.geojson` — features where `divas_chan_id` is non-null.

Current value: 38 channels. Re-run the post-deploy step if the GeoJSON is updated:

```bash
# Extract channel IDs from GeoJSON
CHAN_IDS=$(node -e "
  const fs = require('fs');
  const g = JSON.parse(fs.readFileSync('public/data/i595_corridor_cameras.geojson','utf8'));
  const ids = g.features.filter(f => f.properties.divas_chan_id).map(f => String(f.properties.divas_chan_id));
  process.stdout.write(ids.join(','));
")

# Find the function name
SNAPSHOT_FN=$(aws lambda list-functions --region us-east-1 \
  --query "Functions[?starts_with(FunctionName, \`I595StackV5-SnapshotProxyFn\`)].FunctionName" \
  --output text)

# Update the env var
aws lambda update-function-configuration \
  --function-name "$SNAPSHOT_FN" \
  --environment "{\"Variables\":{\"KNOWN_CHAN_IDS\":\"$CHAN_IDS\"}}" \
  --region us-east-1
```

---

## Assets bucket

Lambda zip assets are uploaded to a custom AES-256 S3 bucket (not the CDK bootstrap KMS bucket):

```
i595-deploy-assets-589391957147-us-east-1
```

The CDK stack uses `CliCredentialsStackSynthesizer` with `fileAssetsBucketName` pointing to this bucket. This avoids the CDK bootstrap KMS key which blocked Lambda from reading encrypted zip files.

---

## Prerequisites

- AWS CLI configured (`aws configure` or SSO) — account `589391957147`
- Node.js 22, Docker (for image-based deploys if ever needed)
- CDK CLI: `npm install -g aws-cdk@2`

Verify identity:
```bash
aws sts get-caller-identity
```

CDK bootstrap is **already done** for this account/region. Do not re-bootstrap unless told to — the bootstrap resources (`cdk-hnb659fds-*`) already exist.

---

## Quick deploy (use the script)

```bash
cd cesium-poc/infra

# Full flow: deploy + S3 sync + set KNOWN_CHAN_IDS + start dev server
bash scripts/deploy-and-launch.sh all

# Or step by step:
bash scripts/deploy-and-launch.sh deploy       # CDK deploy
bash scripts/deploy-and-launch.sh post-deploy  # S3 sync + Lambda env
bash scripts/deploy-and-launch.sh dev          # start Vite → port 5188
```

---

## Manual deploy steps

### 1. Deploy CDK stack

```bash
cd cesium-poc/infra
npm run build
export CDK_DEFAULT_ACCOUNT=589391957147 CDK_DEFAULT_REGION=us-east-1
npx cdk deploy I595StackV5 --require-approval never --outputs-file cdk-outputs.json
```

### 2. Upload GeoJSON data to S3

```bash
BUCKET=$(node -e "console.log(require('./cdk-outputs.json').I595StackV5.DataBucketName)")

aws s3 sync cesium-poc/public/data/ s3://$BUCKET/data/ \
  --cache-control "max-age=86400" --region us-east-1

# Camera GeoJSON gets a shorter TTL
aws s3 cp cesium-poc/public/data/i595_corridor_cameras.geojson \
  s3://$BUCKET/data/i595_corridor_cameras.geojson \
  --cache-control "max-age=21600" --region us-east-1
```

### 3. Set snapshot proxy camera allowlist

See [KNOWN_CHAN_IDS env var](#known_chan_ids-env-var) above.

### 4. Configure Vite env vars

`cesium-poc/.env` (gitignored):

```bash
VITE_LIVE_EVENTS_API=https://d3syo4sqvwi009.cloudfront.net/api/i595/live-events
VITE_SNAPSHOT_BASE=https://d3syo4sqvwi009.cloudfront.net/api/i595/camera
VITE_WS_ENDPOINT=wss://b0wqexsnpk.execute-api.us-east-1.amazonaws.com/prod
VITE_GOOGLE_MAPS_API_KEY=<your key>   # optional — enables Google Photorealistic 3D Tiles
```

### 5. Start dev server

```bash
cd cesium-poc
npm run dev -- --port 5188
# Open: http://localhost:5188/?demo=i595
```

---

## Stack naming history

Previous stacks are in `ROLLBACK_FAILED` or `ROLLBACK_COMPLETE` state — do not attempt to update them. Always use a new name if redeploying from scratch.

| Stack | Status | Notes |
|-------|--------|-------|
| `I595Stack` | ROLLBACK_FAILED | Original; blocked by KMS-encrypted CDK bootstrap bucket |
| `I595StackNew` | ROLLBACK_FAILED | Same KMS issue |
| `I595StackV2` | ROLLBACK_COMPLETE | Same KMS issue |
| `I595StackV3` | ROLLBACK_FAILED | Account-wide Lambda zip block (security incident) |
| `I595StackV4` | ROLLBACK_COMPLETE | CORS misconfiguration on LiveEventsRestFn Function URL |
| **`I595StackV5`** | **CREATE_COMPLETE** | ✅ Live — all fixes applied |

**Root causes resolved:**
- **KMS bucket** — switched to `CliCredentialsStackSynthesizer` + custom AES-256 bucket (`i595-deploy-assets-*`)
- **Lambda zip block** — account-wide security incident; resolved by AWS; confirmed working by `aws lambda create-function` test
- **CORS error** — `AllowMethods` cannot mix `HttpMethod.ALL` (wildcard `*`) with specific methods; fixed by using `[GET, HEAD]` only on `LiveEventsRestFn`

---

## Post-deploy fixes applied to I595StackV5

These were discovered after initial deploy and are already in the current stack code. Documented here so future sessions understand the decisions.

### 1. CloudFront snapshot caching disabled

**Problem:** Camera snapshots weren't updating — CloudFront cached the JPEG for 60–90 s and ignored `?t=` cache-bust params (query strings not in the cache key by default).

**Fix:**
- `lambdas/snapshot-proxy/index.mjs`: changed `Cache-Control: max-age=90` → `no-cache, no-store`
- `lib/i595-stack.ts`: changed `snapshotCachePolicy` (60–90s TTL) → `cloudfront.CachePolicy.CACHING_DISABLED` for `/api/i595/camera/*`

**Note on DIVAS update frequency:** The upstream DIVAS camera system publishes new JPEG frames every ~30–60 seconds (not every 6 seconds). The UI refreshes every 6 seconds, so most ticks show the same frame — that is expected, not a bug.

### 2. Double `Access-Control-Allow-Origin` header (CORS)

**Problem:** Browsers rejected requests to `/api/i595/ask` and `/api/i595/live-events` with: _"Access-Control-Allow-Origin contains multiple values `*, http://localhost:5188`"_. The Function URL's built-in CORS config was adding its own `ACAO` header on top of the Lambda handler's `ACAO: *` header.

**Fix:** Removed the `cors: { ... }` block from all three `addFunctionUrl()` calls (`SnapshotProxyFn`, `LiveEventsRestFn`, `AskTheTwinFn`). The Lambda handlers already return correct CORS headers — no second layer needed.

**Rule:** Never set `cors` on `addFunctionUrl()` when the Lambda handler itself sets `access-control-allow-origin`. Pick one owner for CORS headers.

### 3. Anthropic API key — moved secret to us-east-1

**Problem:** `AskTheTwinFn` was reading the Anthropic API key from Secrets Manager in `ap-south-1`, adding ~150 ms cross-region latency on every cold start.

**Fix:** Secret recreated in `us-east-1`:
- ARN: `arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/anthropic-key-YFA1UV`
- Stack updated: `ANTHROPIC_SECRET_ARN` + `ANTHROPIC_SECRET_REGION` + IAM policy resource

To update the Anthropic API key in future:
```bash
aws secretsmanager put-secret-value \
  --secret-id "arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/anthropic-key-YFA1UV" \
  --secret-string '{"api_key":"sk-ant-YOUR-NEW-KEY"}' \
  --region us-east-1
```

### 4. Ask the Twin CORS preflight missing `access-control-allow-headers`

**Problem:** Browser POST was blocked because the Lambda OPTIONS handler didn't return `access-control-allow-headers: content-type`.

**Fix:** `lambdas/ask-the-twin/index.mjs` OPTIONS response now includes:
```json
{ "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" }
```

### 5. Ask the Twin UI

Built `src/askTheTwin.js` — floating "Ask the Twin" button at the bottom-center of the map, opens a chat panel. Wired into `i595Demo.js`. Endpoint configured via `VITE_ASK_THE_TWIN_API` env var (falls back to hardcoded CloudFront URL if unset).

### 6. Developer IAM access

`infra/scripts/grant-i595-developer.sh <iam-username>` — attaches `I595StackV5DeveloperPolicy` (managed policy) via group `I595Developers` to any existing IAM user. Existing credentials work unchanged. `arpana_thakur` was granted access on 2026-09-14.

---

## Poller internals

`lambdas/poller/index.mjs` depends on shared server modules:

```
lambdas/poller/index.mjs
  └── ../../../server/config.mjs
  └── ../../../server/i595Network.mjs  → server/geo.mjs
  └── ../../../server/fl511Service.mjs → server/fl511Client.mjs
                                       → server/liveEvents.mjs → server/geo.mjs
                                                               → server/fl511Tooltip.mjs
                                                               → server/i595Network.mjs
```

CDK's `NodejsFunction` bundler (`esbuild`) resolves these relative imports at build time and inlines them into the zip. The bundled output also includes the `public/data/` GeoJSON files (copied via `commandHooks.afterBundling`) into `/var/task/data/`, referenced by `DATA_DIR=/var/task/data`.

---

## Estimated costs

- **Demo scale** (1–10 sessions, a few times/week): ~$3–5/month
- CloudFront + Lambda + DynamoDB + EventBridge — all on-demand, no reserved capacity

---

## Teardown

```bash
cd cesium-poc/infra
npx cdk destroy I595StackV5
```

Note: S3 bucket (`i595CorridorData`) has `removalPolicy: RETAIN` — empty and delete it manually if desired. The assets bucket `i595-deploy-assets-589391957147-us-east-1` must also be emptied and deleted manually.
