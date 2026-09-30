# Live DataConnect on EC2 (one-day demo host)

> **For Claude Code / AI assistants deploying this:** the repo git-ignores `CLAUDE.md`, so this file is the
> shared source. To load it automatically, add the line `@cesium-poc/deploy/ec2/README.md` to your local
> `CLAUDE.md`. Rules:
> - **Ask the user before running any AWS command**, even read-only ones (`aws ec2 describe-*`, `aws s3 cp`, `cdk diff`).
> - The host `i-02402cca42da52edd` (34.237.187.140) is **shared** with another app (`aws-import`: gunicorn 5959,
>   nginx 80/443, Docker 8080). Never touch those. Ours lives only in `/opt/live-dc` and `/etc/live-dc`, port 8095.
> - **One DataConnect writer at a time:** stop any laptop `npm run live-dc:sync` before starting the EC2 service.
> - `/etc/live-dc/env` must have each key **once** (systemd uses the last value), including
>   `LIVE_DC_HOLD_OPEN=FL511-876573,FL511-876564` - if it is empty, the next cycle clears the 2 demo closures.
> - **Never commit or print secrets.** The DataConnect service client is in Secrets Manager
>   (`i595/dataconnect/service-client`) and in the git-ignored `cesium-poc/.env.local`.
> - The service uses its own Node at `/opt/live-dc/bin/node` (system Node is 12); `install.sh` sets it up.

One Node process (`live-dc-sync.mjs`, systemd unit `live-dc`) on an EC2 instance with an IAM instance role:

- the live sync loop (FL511 -> DataConnect Live classes) every `LIVE_DC_INTERVAL_SECONDS` (300),
- the built I-595 frontend (`web/`) on `http://<host>:8095/?demo=i595`, using same-origin API paths with live
  DataConnect on,
- the read-only APIs (`/api/live-dc`, `/api/i595/live-events[?source=dataconnect]`, `/api/dataconnect`, camera
  snapshots, message signs). No write routes, and the DataConnect interactive sign-in is not exposed,
- a password gate: `/login` and `POST /api/login` set an HttpOnly, SameSite=Strict session cookie (8 h,
  HMAC-signed with a per-process key, so a restart or a password change signs everyone out). 5 failed
  logins from one IP lock it out for 15 min. Everything except `/login` and `/healthz` needs the session.
  `/healthz` returns only `{ok, lastCycleAt}`.

The password is stored only as a salted scrypt hash in `LIVE_DEMO_PASSWORD_HASH`. The DataConnect service
client comes from Secrets Manager at startup (`i595/dataconnect/service-client`) and stays in the process.
It is used by the writer and by both read proxies.

Plain HTTP, no TLS: meant for a short demo with the port open to known IPs only. The Lambda poller in `infra/`
is unaffected, but **only one writer may run**, so stop the Lambda schedule and any laptop sync first.

## Quick release and deploy (Arpana or anyone with the uploader policy)

The IAM user `arpana_thakur` has the uploader policy (`iam-policy-uploader.json`, installed as `live-dc-releases`).
From `cesium-poc/`:

1. Put the Google Maps key in `cesium-poc/.env` or `.env.local` as `VITE_GOOGLE_MAPS_API_KEY=`. It ends up in
   the browser bundle. Its Google referrer restriction must allow `http://34.237.187.140:8095/*` and
   `http://ec2-34-237-187-140.compute-1.amazonaws.com:8095/*`.
2. Build the release with the 3D models:
   ```
   VITE_I595_MODEL_BASE_URL=https://d3syo4sqvwi009.cloudfront.net/data/models npm run live-dc:release
   ```
   Check that the output says `public keys passed: VITE_GOOGLE_MAPS_API_KEY, VITE_I595_MODEL_BASE_URL`.
3. Run the three `aws s3 cp` commands it prints, as `arpana_thakur`. Upload `latest` last.
4. On the instance: `sudo /opt/live-dc/livedc.sh update latest`, then `sudo /opt/live-dc/livedc.sh status`.
5. Open `http://34.237.187.140:8095/?demo=i595`. Security group `dev-access-us` only allows listed IPs on 8095.

## 1. Build and release (locally)

```bash
cd cesium-poc
npm run live-dc:release      # builds deploy/ec2/dist (bundle + data/ + web/ + ops files), then
                             # deploy/ec2/releases/live-dc-<UTC>.tar.gz + .sha256 + latest
```

The web build runs `vite build` in a child process with a 6 GB heap (the default ~2 GB heap crashes with a
native "heap out of memory" dump; set `LIVE_DC_WEB_BUILD_HEAP_MB` to change it). It needs about 3 GB of free
RAM and Node >= 20.12. The frontend gets fixed same-origin values (`VITE_DATA_SOURCE=dataconnect`,
`VITE_LIVE_DC=true`, `/api/i595/live-events`, `/api/i595/camera`, `/api/i595/message-signs`,
`/status/live-dc-status.json`, `/api/i595/ask`) plus only these public browser keys, from the shell or the
`.env` files: `VITE_GOOGLE_MAPS_API_KEY`, `VITE_CESIUM_ION_TOKEN`, `VITE_ENABLE_STREET_VIEW`,
`VITE_I595_MODEL_BASE_URL`, `VITE_DC_CLASS_*`. Pass `--no-env-files` (`node tools/release-live-dc.mjs --no-env-files`)
to take them from the shell only. A Google key with an HTTP-referrer restriction must allow
`http://<host>:8095/*`. Otherwise the photorealistic tiles are refused.

The release refuses to pack anything secret-looking. `.env*`, token files, `.dc-*` files and keys are left out,
and an AWS key id, private key or password hash anywhere stops the release. `npm run live-dc:bundle` builds
`dist/` only. Use `--skip-web` or `--web-from <dir>` to skip the vite step.

## 2. Upload (prints, never runs)

The release prints the three commands. Run them with the uploader IAM user (`iam-policy-uploader.json`: put/get
on `releases/live-dc/*`, list limited to that prefix). `latest` goes last, so it never points at a missing tarball:

```text
aws s3 cp deploy/ec2/releases/live-dc-<UTC>.tar.gz        s3://i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/live-dc-<UTC>.tar.gz
aws s3 cp deploy/ec2/releases/live-dc-<UTC>.tar.gz.sha256 s3://i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/live-dc-<UTC>.tar.gz.sha256
aws s3 cp deploy/ec2/releases/latest                      s3://i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/latest --content-type text/plain --cache-control no-store
```

**CloudFront note:** this bucket's public CloudFront distribution serves its objects through the default
behaviour, so `releases/live-dc/*` is probably downloadable by anyone who guesses the key unless a behaviour or the
bucket policy denies that path. A release contains no secrets: the frontend is public anyway, and the bundle has
code and corridor GeoJSON only. It does reveal the server code and API layout. To keep it private, add a deny
for `releases/*` in the distribution (a behaviour that returns 403) or in the bucket policy for the CloudFront
principal.

## 3. Instance role

Attach `iam-policy.json` (DataConnect service-client and Anthropic key reads, `snapshots/*` writes, `releases/live-dc/*`
reads) to the instance role. On `i-02402cca42da52edd` it is the inline policy `live-dc` on `devteam_ssm_access`:

```text
aws iam put-role-policy --role-name devteam_ssm_access --policy-name live-dc --policy-document file://iam-policy.json
```

`put-role-policy` replaces the whole inline policy: compare with `aws iam get-role-policy` first.

Host needs: Node >= 20.12 on systemd's PATH, AWS CLI v2, `curl`, outbound HTTPS, and inbound TCP 8095.

## 4. Security group

In the instance's security group, open **TCP 8095 only to known IPs** (the presenters' and viewers' public /32s), never `0.0.0.0/0`. Remove
the rule after the demo.

## 5. First install (on the instance)

```bash
V=$(aws s3 cp s3://i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/latest - | tr -d '[:space:]')
aws s3 cp s3://i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/$V.tar.gz .
aws s3 cp s3://i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/$V.tar.gz.sha256 .
sha256sum -c $V.tar.gz.sha256
mkdir $V && tar -xzf $V.tar.gz -C $V && cd $V
sudo ./install.sh             # user livedc, /opt/live-dc/releases/$V, /opt/live-dc/current, /opt/live-dc/livedc.sh,
                              # /etc/live-dc/env (kept if present), unit enabled (not started)
```

Set the password hash, then start:

```bash
/opt/live-dc/bin/node /opt/live-dc/current/live-dc-sync.mjs --hash-password   # type the password (not echoed), twice
sudo nano /etc/live-dc/env                                   # LIVE_DEMO_PASSWORD_HASH=scrypt$16384$8$1$...
sudo /opt/live-dc/livedc.sh start
/opt/live-dc/livedc.sh status
```

The hash can also be produced on a laptop with `node tools/live-dc-sync.mjs --hash-password`. Only the hash goes
into `/etc/live-dc/env` (root:livedc 640), and the password itself is never stored or logged. Changing the hash and
restarting signs everyone out. With `LIVE_DC_HTTP_PORT` set and no valid hash, the service refuses to start (exit 2).

## 6. Operate

```bash
sudo /opt/live-dc/livedc.sh update latest     # or: update live-dc-<UTC>
sudo /opt/live-dc/livedc.sh rollback          # previous release
/opt/live-dc/livedc.sh status                 # systemd state, port 8095 listening, last cycle from /healthz
/opt/live-dc/livedc.sh logs                   # journalctl -u live-dc -f
sudo /opt/live-dc/livedc.sh restart | stop | start
```

`update` downloads through the instance role, checks the `.sha256`, unpacks to `/opt/live-dc/releases/<version>`,
switches the `/opt/live-dc/current` symlink atomically, refreshes `livedc.sh` and the unit from the release, and restarts.
It keeps the last 3 releases. The unit caps the process at `MemoryMax=512M` and `CPUQuota=50%`. A failed start (for
example, secret access denied) is logged and retried every 30 s.

## Ask the Twin (free-form questions)

With `ASK_TWIN_ANTHROPIC_SECRET_NAME=i595/anthropic-key` in `/etc/live-dc/env`, `POST /api/i595/ask` (behind the
password) answers with Claude (`ASK_TWIN_MODEL`, default `claude-sonnet-5`). Unset, it answers 503 and only the
built-in answers work. The model can call read-only tools (`server/liveDc/askTools.mjs`): the data dictionary, live
events, a live event's chain, filtered reads of any live or historical DataConnect class, the corridor layers and the
current weather. The release ships `data/data-dictionary.json`, built from the code's own config plus
`config/askTwin/dataGuide.json` (a class or layer without an entry there fails the build). The key is read on the
first question through the instance role and never logged. The logs show `ask-the-twin: on` at start and the tools
used for each answer.

To turn it on for an existing install, add these lines once to `/etc/live-dc/env`, then `sudo /opt/live-dc/livedc.sh restart`:

```text
ASK_TWIN_ANTHROPIC_SECRET_NAME=i595/anthropic-key
ASK_TWIN_MODEL=claude-sonnet-5
```

## 7. Shutdown / uninstall

```bash
sudo /opt/live-dc/livedc.sh stop                # pause the demo
sudo /opt/live-dc/livedc.sh uninstall           # asks; -y to skip: stop, disable, remove unit, /opt/live-dc, /etc/live-dc
```

Afterwards, remove the security-group rule for 8095, detach the instance-role policy, delete old objects under
`releases/live-dc/`, and re-enable the Lambda poller if it should write again.
