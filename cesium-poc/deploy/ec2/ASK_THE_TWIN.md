# Ask the Twin: run locally, then migrate to EC2

Status (2026-10-11): **nothing here is deployed.** It all runs on a laptop today. The EC2 steps below are a
plan for a person to carry out after local verification. Claude does not deploy, does not run AWS commands
and does not merge `askthetwin` into `demo` (pushing `demo` rebuilds the public GitHub Pages site).

Related files: `README.md` (this folder, the current host), `server/ask/README.md` (the orchestrator),
`docs/superpowers/specs/2026-10-11-ask-the-twin-architecture-design.md` (the design).

---

## 1. Why Claude Code cannot do the deployment itself

- Claude Code runs in a **cloud container**, not on your laptop. It cannot reach `localhost` on your
  machine, your browser or your AWS login. `aws login` opens Chrome, and the container has no browser
  session or AWS credentials of yours. In this container, the AWS credentials are denied
  `secretsmanager:GetSecretValue` on `i595/anthropic-key`.
- It has no SSH or SSM access to `i-02402cca42da52edd`, and the host is shared with `aws-import`.
  `README.md` requires asking before **any** AWS command.
- To let Claude work against your laptop, run Claude Code locally there (the CLI or the desktop app, in
  `cesium-poc/`), or start `claude remote-control` on the laptop and connect from claude.ai. Either way,
  AWS commands stay yours to approve.

So the split is: Claude writes and tests the code and these steps, and you run them, first on the laptop
(section 3), then on EC2 (section 6).

---

## 2. How it is deployed today (as found in this folder)

| Piece | Today |
|---|---|
| Host | EC2 `i-02402cca42da52edd` (34.237.187.140), us-east-1, account 589391957147, **shared** with `aws-import` (gunicorn 5959, nginx 80/443, Docker 8080: never touch them) |
| Our footprint | `/opt/live-dc` (releases, `current` symlink, own Node at `/opt/live-dc/bin/node`, `livedc.sh`), `/etc/live-dc/env` (root:livedc 640), state `/var/lib/live-dc` |
| Process | one systemd unit `live-dc` → `live-dc-sync.mjs`: FL511 → DataConnect writer every 300 s, **plus** the password-gated web host on :8095 (built frontend and read APIs) |
| Unit limits | `User=livedc`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/live-dc`, `MemoryMax=512M`, `CPUQuota=50%`, `--max-old-space-size=384` |
| Ask the Twin on EC2 | `POST /api/i595/ask` inside the same process (`demoServer.createDemoAsk`). On Node ≥ 22.13 it runs the new orchestrator; on older Node it falls back to the legacy handler. The host's private Node (`/opt/live-dc/bin/node`) is **v22.22.3**, copied from the ubuntu user's nvm on 2026-09-29, so the next `livedc.sh update` with this code switches EC2 to the orchestrator in-process (phase 1) with no other change. |
| Ask the Twin for GitHub Pages `/demo/` and local builds with `VITE_ASK_THE_TWIN_API` | Lambda `AskTheTwinFn` behind CloudFront `d3syo4sqvwi009.cloudfront.net` (CDK stack `I595StackV5`): one model call, no tools, no store |
| Releases | `npm run live-dc:release` → S3 `i595stackv5-…-oixfpv0dyrzj/releases/live-dc/` → `sudo /opt/live-dc/livedc.sh update latest` (keeps 3, `rollback` available) |
| Secrets | Secrets Manager `i595/dataconnect/service-client` (DataConnect writer and read clients) and `i595/anthropic-key` (JSON `{"api_key"}`), read through the instance role `devteam_ssm_access`, inline policy `live-dc` (`iam-policy.json`) |
| Network | plain HTTP :8095, security group `dev-access-us` limited to listed IPs |

---

## 3. Run and verify locally first (the services you run)

Everything runs from `cesium-poc/` and needs **Node ≥ 22.13**, where `node:sqlite` works without a flag. On
22.5–22.12 it needs `--experimental-sqlite`, and without that the service falls back to the legacy handler.
The repo's `.nvmrc` says `22`, so `nvm install` picks up the latest 22.x, which is fine.

### 3.1 One-time setup

```bash
cd cesium-poc
npm install
cp .env.example .env.local        # if you have not already; it is git-ignored
```

In `.env.local` (never commit it):

```bash
# model — pick one
ASK_TWIN_ANTHROPIC_SECRET_NAME=i595/anthropic-key   # same secret as EC2; needs `aws login` (or AWS_PROFILE) first
# ANTHROPIC_API_KEY=…                               # or a key directly
ASK_TWIN_MODEL=claude-sonnet-5
LIVE_DC_AWS_REGION=us-east-1
# DataConnect (read-only), as for `npm run dev` — see server/liveDc/README.md
LIVE_DC_READ_BASE_URL=…            # SDNA live classes
DC_BASE_URL=…  DC_CLIENT_ID=…      # historical classes (+ `npm run dc:login`)
# make sure this is NOT set, or the page asks the Lambda instead:
# VITE_ASK_THE_TWIN_API=
```

### 3.2 The services

| Command | What it is | Verify |
|---|---|---|
| `npm run twin:store:dc` | One-off read-only pull of **every SDNA live class and every historical class** into `.twin-store/twin.sqlite`, compacted (empty/NA values dropped, geometry → lon/lat, long text clipped, `VACUUM`). A class that cannot be read is filled from the committed snapshot. | The output lists every class with `[live]`/`[historical]`/`[snapshot]`, its row count, raw → compact size and the file size. `ERROR` lines name the class that failed. |
| `npm run twin:store` | The same store from the committed snapshot only (no credentials). | — |
| `npm run ask:serve` | **The Ask the Twin service as its own process** (`tools/ask-serve.mjs`) on `http://127.0.0.1:8787`. This is the process EC2 phase 2 runs. It builds the store if missing, then refreshes it from DataConnect: live classes every 5 min, historical daily. | `curl -s 127.0.0.1:8787/api/i595/ask/status` → `model`, every class with `origin` (live / historical / snapshot), `asOf`, `refresh.lastRefresh`, `refresh.lastError` |
| `ASK_TWIN_SERVICE_URL=http://127.0.0.1:8787 npm run dev` | The map on :5188, with `/api/i595/ask` proxied to the service above (the same path EC2 will use) | Open `http://localhost:5188/?demo=i595` → Ask the Twin. The dev terminal says `proxied to …`. |
| `npm run dev` (no `ASK_TWIN_SERVICE_URL`) | The map with the same service mounted in-process (the quickest loop) | the terminal prints `ask-the-twin (local): <model>, store …, refreshing from DataConnect (live + historical)` |

Model settings: `ASK_TWIN_FALLBACK_MODEL` (a second model for overloads), `ASK_TWIN_DAILY_TOKENS` (daily budget, counted
beside the store in `ask-spend.json`; `/api/i595/ask/status` shows `usage`).
Refresh settings: `ASK_TWIN_REFRESH=off` (snapshot only), `ASK_TWIN_LIVE_REFRESH_MIN=5`,
`ASK_TWIN_HISTORICAL_REFRESH_H=24`, `ASK_TWIN_STORE=<path>`, `ASK_TWIN_PORT=8787`, `ASK_TWIN_EFFORT=low`.

### 3.3 Local verification checklist (do all before EC2)

1. `npm run test:unit`: everything passes except the one failing test that predates this work
   ("23 distinct structures…", unrelated).
2. `npm run twin:store:dc` shows the 6 `SDNA Florida I595 Live *` classes as `[live]` and the 8
   `Florida I595 *` classes (+ Roadway Segments) as `[historical]`, with no `ERROR`.
3. `npm run ask:serve`, then `/api/i595/ask/status` shows `live` ≥ 1 and `historical` ≥ 1, with `lastError: null`.
   Wait 5 min: `lastRefresh` advances and the live `asOf` changes.
4. Stream one question and watch the events:
   ```bash
   curl -N -X POST 127.0.0.1:8787/api/i595/ask -H 'accept: text/event-stream' \
     -H 'content-type: application/json' -d '{"question":"How many open live tickets are there and for which events?"}'
   ```
   Expect `ToolCallStart` on an `SDNA Florida I595 Live …` class, then `AnswerReady` with `sources` and `basis`.
5. In the map (with the proxy): ask a live question ("current closures?"), a historical one ("crash hotspots in
   wet weather"), a mixed one ("explain the top incident"), and a navigation one ("fly to the gantries").
   Check the activity log, the confidence reason, that fly-to works and that Restore view works.
6. Kill DataConnect access (comment out `LIVE_DC_READ_BASE_URL`, restart `ask:serve`). Answers still come
   from the last store, and the status shows the classes' old `asOf`. That is the "last good store" behaviour.
7. `npm run ask:eval`: the 12 verified questions (`config/askTwin/evals.json`) against the real model, graded on the
   lookups used, confidence, gaps, the answer text and the round budget (report in `.twin-store/eval-report.json`).
   Add `--record .twin-store/eval-rec.json` once; afterwards `--replay` re-grades offline after every code change.
8. Optional, offline: record answers with `ASK_TWIN_RECORD=.twin-store/rec.json`, then replay them with
   `ASK_TWIN_REPLAY=…` and no key.

Only when 1–6 pass do we move to section 6.

---

## 3.4 Data sources, site prioritisation and toll data

**Data-source toggles.** The panel shows `Sources: Maintenance · Safety · Traffic · Tolling` under the conversation, toggled like
map layers (`config/askTwin/sources.json`). The selection travels with each question; the server describes only the classes in
scope, refuses lookups outside it (`out_of_scope` gap) and every answer ends with "Answered from … · Toggled off: …". Picking a
persona applies its preset (maintenance manager → Maintenance only; executive → all). This is focus, not access control.

**Site prioritisation.** `prioritize_sites` ranks sites with open work orders (default: cameras) by weighted criteria from
`config/askTwin/prioritization.json`: FIFO age, distance from the depot, inspection risk, work-order priority, and toll revenue at
risk (only when Tolling is on). Presets: maintenance, nearest, executive. On the committed snapshot:
- Maintenance view: CCTV 5078 (open since 2024-08-21) → CCTV 5075 → CCTV 5079.
- Executive view (Tolling on): CCTV 5079 first (▲2), because of its revenue at risk, then 5078, 5075.

Assumptions you must state when demoing: the depot location is assumed; the three sites are traffic CCTV, not toll plate cameras,
so their camera-to-gantry links are demo authoring; the toll transactions are SYNTHETIC (`config/askTwin/syntheticTolls.json`,
`npm run tolls:synthetic`); FDOT operates I-595 Express tolling and keeps the revenue, while ACS is paid availability payments,
so "revenue impact" is FDOT's view unless availability deductions are modelled.

**Real toll data (phase 4).** When FDOT / Florida's Turnpike provide an extract:
```bash
npm run tolls:import -- path/to/extract.csv --dry-run     # validates and reports: days, gantries, unknown ids, rows without image split
npm run tolls:import -- path/to/extract.csv               # replaces the synthetic class in ASK_TWIN_STORE as origin 'imported'
```
Format: `config/askTwin/toll-import-template.csv` (hourly or daily rows; aliases such as `plaza_id`, `video_transactions`, `revenue`
are accepted). Revenue at risk needs the image-dependent split (plate/video transactions); without it the criterion is NA. The
import survives DataConnect refreshes; restart the ask service to use it at once. What to request from FDOT: per gantry, per hour or
day, total transactions, transponder vs image-based (toll-by-plate / violation) transactions, revenue, and unbillable image counts;
plus which roadside cameras each gantry's image capture depends on (to replace the demo links).

## 4. Packages and services to install on the EC2 host

| Item | Needed for | Notes |
|---|---|---|
| **Node ≥ 22.13** (22 LTS latest recommended) copied to `/opt/live-dc/bin/node` | `node:sqlite` (twin store), the orchestrator | `install.sh` copies a Node from `$LIVE_DC_NODE`/PATH/nvm. Install e.g. the official tarball to `/usr/local/lib/nodejs`, then `sudo LIVE_DC_NODE=/usr/local/lib/nodejs/bin/node ./install.sh`. System Node there is 12, which is not enough. |
| **AWS CLI v2** | reading `i595/anthropic-key` and the DataConnect service client through the instance role; `livedc.sh update` | already required by README |
| `curl`, `tar`, `sha256sum` | release download/verify, `livedc.sh status` | already present |
| systemd units | `live-dc.service` (exists); phase 2 adds `live-dc-ask.service` | see section 5 |
| npm packages | `@anthropic-ai/sdk` | bundled into the release by `npm run live-dc:bundle`; no `npm install` on the host |
| Outbound HTTPS | `api.anthropic.com`, DataConnect hosts, `api.open-meteo.com` (weather), FL511 | the instance already reaches DataConnect/FL511. Check egress to Anthropic and Open-Meteo. |
| Disk | store at `/var/lib/live-dc/twin.sqlite` | a few MB (snapshot ≈ 10k records); the build writes a temp file beside it, then renames |

Nothing else: no database server, no Docker, no nginx change (nginx on 80/443 belongs to `aws-import`).

---

## 5. Target shape on EC2

**Phase 1: same process (the code already supports this).** `live-dc.service` keeps doing everything; with
Node ≥ 22.13, `createDemoAsk` runs the orchestrator and the store refresher in-process, behind the password
gate, with the store at `/var/lib/live-dc/twin.sqlite`. The only changes are the Node upgrade and env
settings. Risk: the writer and Ask share 512 MB / 50 % CPU, and a slow model turn does not block the sync
(both are async), but memory is tighter.

**Phase 2: separate unit (recommended for real use; code partly built).**

```
browser ──HTTP(S)──▶ live-dc (:8095, password gate, web + read APIs) ──proxy /api/i595/ask──▶ live-dc-ask (127.0.0.1:8787)
                                                                                         └─ twin.sqlite ◀─ refresh (DataConnect, read-only)
```

- `live-dc-ask.service` runs `tools/ask-serve.mjs`: the same `User=livedc` and hardening as `live-dc`,
  `MemoryMax=768M`, `CPUQuota=50%`, `ReadWritePaths=/var/lib/live-dc`, listening on 127.0.0.1 only.
  A model or refresh problem can then never take down the DataConnect writer, and it restarts on its own.
- `live-dc` forwards `/api/i595/ask` to it, after its session check, when `ASK_TWIN_SERVICE_URL=http://127.0.0.1:8787`
  is set (`server/ask/askProxy.mjs`). **Built, not deployed:** the release carries `live-dc-ask.mjs` and
  `live-dc-ask.service`; `install.sh` installs the unit without enabling it; `livedc.sh` restarts, updates,
  rolls back and reports both units once `live-dc-ask` is enabled (`livedc.sh ask-logs` for its journal).
  To switch: `sudo systemctl enable --now live-dc-ask`, set `ASK_TWIN_SERVICE_URL` in the env, `livedc.sh restart`.
  To switch back: remove `ASK_TWIN_SERVICE_URL`, `systemctl disable --now live-dc-ask`, `livedc.sh restart`.
- **HTTPS (optional, for `/demo/` on GitHub Pages).** The page is HTTPS and cannot call `http://…:8095`.
  Add a CloudFront custom origin `ec2-34-237-187-140.compute-1.amazonaws.com:8095` with path
  `/api/i595/ask*`, caching disabled, all methods, origin read timeout 60 s, and response streaming on.
  Point the Pages build's `VITE_ASK_THE_TWIN_API` at it. That needs a CDK change and an auth decision (the
  Pages site has no password), so it is a separate approval. Until then Pages keeps the Lambda.
  The CDK side is now written behind context flags (off by default, not deployed); see section 5.1.
- **Retire later:** `AskTheTwinFn` (and the old poller schedule, which must stay off while EC2 writes), once
  nothing points at it.

### 5.1 HTTPS for GitHub Pages

Status: **code only, not deployed.** `infra/lib/i595-stack.ts` (section 12b) can send `/api/i595/ask*` on
CloudFront `d3syo4sqvwi009.cloudfront.net` (stack `I595StackV5`) to the EC2 host. With no context flags the
synthesized template is byte-identical to today's (checked by diffing it before and after the change, and by
`infra/test/askEc2Origin.test.ts`, run with `cd infra && npm test`). The host side below is **not built**:
it is the contract for whoever adds it to `demoServer.mjs` / `server/ask`.

**Flags** (`cdk deploy -c key=value`; a person runs `cdk diff` and `cdk deploy`, never Claude):

| Context key | Default | Meaning |
|---|---|---|
| `askOrigin` | unset (feature off) | DNS name of the host, e.g. `ec2-34-237-187-140.compute-1.amazonaws.com`. CloudFront does not accept a bare IP, scheme or path. |
| `askOriginPort` | `8095` | 80, 443 or 1024–65535 |
| `askOriginProtocol` | `http-only` | `http-only` (the host has no TLS) or `https-only` (only with a valid certificate on the host) |
| `askEdgeKeyParam` | none, **required** with `askOrigin` | name of an SSM **String** parameter holding the edge key, e.g. `/i595/ask/edge-key`. The stack refuses to synth without it, because otherwise it would be an open proxy to a paid model. |
| `askOriginKeepaliveSeconds` | `4` | must stay below the host's idle timeout (Node's default is 5 s), or CloudFront reuses closed sockets and returns 502. Raise to 60 once the host sets `server.keepAliveTimeout = 65_000` and `server.headersTimeout = 66_000`. |
| `askCorsOrigins` | `https://meta-dev-coder.github.io` | comma list of origins allowed by CORS |
| `retireAskLambda` | `false` | `true` removes `AskTheTwinFn`, its function URL, its IAM grants and its output. It is refused without `askOrigin`. |

**What the flags produce**

- Origin `askOrigin:askOriginPort`, read timeout 60 s (CloudFront's maximum without a quota increase; it
  counts time to the first byte and then between bytes, not the whole turn), 5 s connect timeout × 2
  attempts, and the custom origin header `x-ask-edge-key`. Its value is
  `ssm.StringParameter.valueForStringParameter(askEdgeKeyParam)`, a CloudFormation parameter resolved at
  each deploy. It is never in git or in `cdk.out`.
- Behaviour `/api/i595/ask*`, the same pattern the Lambda uses, so `POST /api/i595/ask` and
  `GET /api/i595/ask/status` both match: `CachingDisabled`, all methods, **`compress: false`** (gzip would
  buffer `text/event-stream`), HTTPS only for viewers.
- Origin request policy: forwards `Accept` (SSE vs JSON), `Content-Type`, `Origin` and
  `CloudFront-Viewer-Address`. It forwards **no cookies** (the host session cannot be used through this path)
  and no query strings. `Host` is not forwarded, so the host sees `Host: <askOrigin>`.
- Response headers policy (CORS, `originOverride`): allows the Pages origin(s), `GET, HEAD, POST, OPTIONS`,
  the headers `content-type` and `accept`, no credentials, and a 10 min max-age. The host does not need to
  send CORS headers itself.
- With `retireAskLambda=false` the Lambda moves to `/api/i595/ask-lambda*`, ordered **before**
  `/api/i595/ask*` because CloudFront takes the first match. The Lambda ignores the path. This is the
  rollback route.
- With chunked origin responses and caching disabled, CloudFront forwards each chunk as it arrives, so SSE
  streams end to end.

**Edge key (set up by a person before the deploy)**

```bash
# String, not SecureString: CloudFormation's AWS::SSM::Parameter::Value<String> cannot resolve SecureString
aws ssm put-parameter --region us-east-1 --name /i595/ask/edge-key --type String \
  --value "$(openssl rand -base64 48 | tr -d '=+/\n')"
```

The value ends up in the distribution config, which anyone with `cloudfront:GetDistributionConfig` can read.
That is acceptable for a demo-grade shared secret, but it is not a vault. To rotate: put both keys on the
host (`new,old`), change the parameter, `cdk deploy` (the parameter is read again on every deploy), then
remove `old` from the host.

**Host contract (implemented in `server/liveDc/edgeGate.mjs` and `demoHost.mjs`; `/api/i595/ask/status` is not exposed at the edge)**

1. **Header:** `x-ask-edge-key`. Accepted keys come from the host env, e.g.
   `ASK_TWIN_EDGE_KEYS=<key>[,<previous key>]` in `/etc/live-dc/env`. (Reading SSM from the host instead
   would need `ssm:GetParameter` added to `iam-policy.json`.) Compare in constant time, e.g.
   `crypto.timingSafeEqual` over SHA-256 digests. With no keys configured, the feature is off.
2. **Scope:** a valid key replaces the session cookie **only** for `POST /api/i595/ask`,
   `GET /api/i595/ask/status` and `OPTIONS /api/i595/ask*` (answer `204`, no body, so the CORS preflight
   succeeds). Every other path keeps requiring the session, even with a valid key. A missing or wrong key
   falls through to today's cookie check, so a signed-in browser on `:8095` is unaffected. Reject without a
   session: `401 {"error": "…"}`. Do not log the header.
3. **Client IP:** for edge requests only, take the viewer IP from `CloudFront-Viewer-Address` (`ip:port`;
   strip the part after the last `:`; IPv6 has no brackets). Without the edge key, never trust that header or
   `X-Forwarded-For`.
4. **Rate limits** (suggested; edge requests get their own buckets, separate from the 120-per-session limit):
   - per viewer IP: 6 questions/min and 40/hour, and at most 2 open streams;
   - global across all edge requests: 300 questions/hour, which bounds model spend from an anonymous page;
   - `/status`: 30/min per IP.

   Over a limit, answer `429` with `Retry-After` and `{"error": "Too many questions — try again in N s."}`.
   `askRemote` shows `error` as-is. Keep the existing body caps (question ≤ 512 chars, body ≤ 8 KB).
5. **Streaming:** when `Accept` includes `text/event-stream`, send `content-type: text/event-stream`,
   `cache-control: no-cache`, no `Content-Length` and no `Content-Encoding`, and flush per event. Send a
   comment line (`: ping`) at least every 15 s so the 60 s read timeout never trips during long tool rounds.
   A non-streamed JSON answer must finish within 60 s, or CloudFront returns 504.
6. **Logging:** mark edge turns in the `ask_turn` line (e.g. `"via": "edge"`, the viewer IP hashed) so cost
   per path can be read.

**Network (a person, AWS console)**

The security group `dev-access-us` allows 8095 only from listed IPs. For CloudFront, add inbound TCP 8095 from
the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing`. It counts as about 55 rules
against the group's rule quota (60 by default), so a separate security group attached to the instance may be
needed. This opens 8095 to every CloudFront distribution, not just ours. That is why the key is mandatory and
the password gate stays on for everything else. The CloudFront → host leg is plain HTTP over the internet
(questions, answers and the edge key in clear) until the host has TLS and `askOriginProtocol=https-only`.
Port 443 there belongs to `aws-import`'s nginx.

**GitHub Pages build**

`.github/workflows/deploy.yml` ("Build demo branch (I-595)") already sets
`VITE_ASK_THE_TWIN_API: https://d3syo4sqvwi009.cloudfront.net/api/i595/ask`, so **no workflow change is
needed**. As soon as the CDK deploy with `askOrigin` finishes, the live Pages site asks EC2. If that line were
ever missing, the one-line change is to add it back under that step's `env:`. Rollback without a CDK deploy
(only while `retireAskLambda=false`): change the URL to `…/api/i595/ask-lambda` and rebuild Pages. Rollback
with a deploy: deploy without `-c askOrigin`.

**Order:** (1) the host release that accepts the key, with `ASK_TWIN_EDGE_KEYS` set and verified on the host;
(2) the SSM parameter; (3) the security group rule; (4) `cdk diff`, then
`cdk deploy -c askOrigin=ec2-34-237-187-140.compute-1.amazonaws.com -c askEdgeKeyParam=/i595/ask/edge-key`.
The context must be passed on **every** later deploy, or the route reverts to the Lambda. Alternatively, put
it in `cdk.json` `context`. (5) Verify:

```bash
curl -sS https://d3syo4sqvwi009.cloudfront.net/api/i595/ask/status
curl -N -X POST https://d3syo4sqvwi009.cloudfront.net/api/i595/ask -H 'accept: text/event-stream' \
  -H 'content-type: application/json' -d '{"question":"current closures?"}'          # events arrive one by one
curl -si -X OPTIONS https://d3syo4sqvwi009.cloudfront.net/api/i595/ask \
  -H 'Origin: https://meta-dev-coder.github.io' -H 'Access-Control-Request-Method: POST' | head -20
curl -si -X POST http://ec2-34-237-187-140.compute-1.amazonaws.com:8095/api/i595/ask -d '{}' | head -1   # 401: no key, no session
```

(6) Only after a week without problems: `-c retireAskLambda=true`.

**Cost:** CloudFront requests and transfer for chat traffic are negligible. The real cost is model tokens
from an anonymous page, which the global cap bounds. Retiring the Lambda saves almost nothing, since it is pay
per use, but it removes a second backend with a different answer quality.

---

## 6. Migration steps (run by a person, after section 3 passes)

Each AWS or host command below is yours to run. Read-only checks come first.

1. **Check the host Node** (SSM session): `/opt/live-dc/bin/node -v`. If < 22.13, install Node 22 LTS as in
   section 4. Check egress: `curl -sI https://api.anthropic.com | head -1`.
2. **IAM:** `iam-policy.json` already grants `secretsmanager:GetSecretValue` on `i595/anthropic-key-*`. Compare
   it with the live inline policy (`aws iam get-role-policy --role-name devteam_ssm_access --policy-name live-dc`)
   before any `put-role-policy`, because put replaces the whole policy. The DataConnect read uses the existing
   service-client secret. No new permission is needed.
3. **Build a release** on the laptop from the `askthetwin` branch: `npm run live-dc:release`, then upload it with
   the uploader user, `latest` last (README section 2). The bundle includes the snapshot
   (`dist/data/dataconnect-data`) for the first start.
4. **Env** (`sudo nano /etc/live-dc/env`, each key once):
   ```bash
   ASK_TWIN_ANTHROPIC_SECRET_NAME=i595/anthropic-key
   ASK_TWIN_MODEL=claude-sonnet-5
   ASK_TWIN_EFFORT=low
   # ASK_TWIN_STORE=/var/lib/live-dc/twin.sqlite      (default: $HOME/twin.sqlite = the state dir)
   # ASK_TWIN_LIVE_REFRESH_MIN=5   ASK_TWIN_HISTORICAL_REFRESH_H=24   ASK_TWIN_REFRESH=on
   # ASK_TWIN_FALLBACK_MODEL=<model>                   (answers when the primary is overloaded or 5xx)
   # ASK_TWIN_DAILY_TOKENS=2000000                     (daily budget; usage in /var/lib/live-dc/ask-spend.json)
   # ASK_TWIN_EDGE_KEYS=<key>                          (only with the CloudFront edge path, section 5.1)
   # ASK_TWIN_ENGINE=legacy                            (emergency switch back to the old handler)
   ```
   `LIVE_DC_READ_BASE_URL` and `DC_BASE_URL` are already set there; the read clients take the service client
   from Secrets Manager.
5. **Deploy:** `sudo /opt/live-dc/livedc.sh update latest`, then `livedc.sh logs`. Expect
   `live-dc ask-the-twin: orchestrator (claude-sonnet-5, effort low)`, `built the twin store from the snapshot`,
   then `store refreshed with historical classes in … ms: …`.
6. **Verify:** sign in at `http://34.237.187.140:8095/?demo=i595`, then repeat checks 4–5 of section 3.3 in the
   browser. The log should show one `ask_turn` JSON line per question.

**Rollback**, quickest first:
- `ASK_TWIN_ENGINE=legacy` in the env, then `livedc.sh restart` (the old handler, no store);
- `ASK_TWIN_REFRESH=off` (keeps the snapshot store if DataConnect reads misbehave);
- `sudo /opt/live-dc/livedc.sh rollback` (the previous release).

The DataConnect writer is unaffected by all of these.

---

## 7. Capacity and cost notes

- **Memory:** the store reads are SQLite on disk. A refresh holds one class's compacted rows in memory while
  it writes (thousands of rows, a few MB). Within 512 MB for phase 1, but watch `systemctl status live-dc`
  (Memory) during a historical refresh. Phase 2 gives Ask its own budget.
- **DataConnect load:** live classes are paged every 5 min (500 per page), and all historical classes once a
  day. All of it is read-only, through the same read clients as the map.
- **Model:** a typical turn is 2–3 rounds, with about 6k cached system-prompt tokens per round, a few
  hundred output tokens, `effort low`, and `max_tokens` 2000. The orchestrator logs `usage` per turn in the
  `ask_turn` line: use that for real cost numbers before scaling. A per-session limit is in place
  (120 questions per window).

---

## 8. Still open

- Phase 2 wiring: the demo-server proxy, `live-dc-ask.service`, and two-unit `install.sh`/`livedc.sh` (section 5).
- The HTTPS path for GitHub Pages and retiring the Lambda (needs CDK and an auth decision).
- Answer completeness: done so far are the inline-citation fallback (capped at medium), ending the turn on a
  call to the non-existent `none` tool, a "reply with the JSON" nudge before the last round, `records_near`, and
  a prefetch for named interchanges (`config/askTwin/places.json`). Still to do: a forced structured
  `final_answer` tool (or structured outputs), one bounded retry round when the model gives up, and
  flagging uncited numbers or ids in "general knowledge" claims.
- From the spec: answer blocks (KPI/trend), the Twin UI API registry, a verified-question eval set,
  spend limits, a fallback model, and historical replay in `explain_incident`.
