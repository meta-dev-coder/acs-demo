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
| Ask the Twin on EC2 | `POST /api/i595/ask` inside the same process (`demoServer.createDemoAsk`). On Node ≥ 22.13 it runs the new orchestrator; on older Node it falls back to the legacy handler. The host's current Node version is unknown. The README says only "≥ 20.12", so it may well be running legacy. |
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
7. Optional, offline: record answers with `ASK_TWIN_RECORD=.twin-store/rec.json`, then replay them with
   `ASK_TWIN_REPLAY=…` and no key.

Only when 1–6 pass do we move to section 6.

---

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
- `live-dc` forwards `/api/i595/ask` to it, after its session check.
  **Not built yet:** the proxy in `demoServer.mjs`, the unit file, and `install.sh`/`livedc.sh` handling two
  units. Each is small, but they are untested on the host, so they wait until phase 1 is verified.
- **HTTPS (optional, for `/demo/` on GitHub Pages).** The page is HTTPS and cannot call `http://…:8095`.
  Add a CloudFront custom origin `ec2-34-237-187-140.compute-1.amazonaws.com:8095` with path
  `/api/i595/ask*`, caching disabled, all methods, origin read timeout 60 s, and response streaming on.
  Point the Pages build's `VITE_ASK_THE_TWIN_API` at it. That needs a CDK change and an auth decision (the
  Pages site has no password), so it is a separate approval. Until then Pages keeps the Lambda.
- **Retire later:** `AskTheTwinFn` (and the old poller schedule, which must stay off while EC2 writes), once
  nothing points at it.

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
- Answer completeness: a forced structured final answer, an inline-citation fallback, handling of a
  model calling the `none` "tool", and a `records_near` spatial lookup for "near the Turnpike" questions.
- From the spec: answer blocks (KPI/trend), the Twin UI API registry, a verified-question eval set,
  spend limits, a fallback model, and historical replay in `explain_incident`.
