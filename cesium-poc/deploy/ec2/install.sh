#!/usr/bin/env bash
# First install of the live-dc service (sync loop + password-gated demo host) from an unpacked release
# (live-dc-<stamp>/ with live-dc-sync.mjs, data/, web/) or from deploy/ec2 with dist/ next to it.
# Idempotent; run with sudo. Enables but does not start the service. Later updates: livedc.sh update.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/live-dc
CONF_DIR=/etc/live-dc
SERVICE_USER=livedc
UNIT=/etc/systemd/system/live-dc.service
VERSION_RE='^live-dc-[0-9]{8}T[0-9]{6}Z$'

if [[ $EUID -ne 0 ]]; then echo "install.sh: run with sudo" >&2; exit 1; fi
if [[ -f "$HERE/live-dc-sync.mjs" ]]; then SRC="$HERE"; else SRC="$HERE/dist"; fi
if [[ ! -f "$SRC/live-dc-sync.mjs" || ! -d "$SRC/data" ]]; then
  echo "install.sh: no live-dc-sync.mjs + data/ in $HERE or $HERE/dist; unpack a release or run 'npm run live-dc:bundle' locally" >&2
  exit 1
fi
if [[ ! -f "$SRC/web/index.html" ]]; then echo "WARNING: $SRC/web is missing; the host will answer 503 for pages." >&2; fi

# The service runs its own Node copy at $APP_DIR/bin/node: sudo and systemd often see an older system node
# (e.g. /usr/bin/node 12) while the invoking user has Node 22 via nvm, which the locked-down service user
# cannot read from /home. Candidates, first new-enough wins: $LIVE_DC_NODE, the existing private copy,
# root's PATH, then the sudo user's login-shell node.
NODE_OK='const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)'
node_ok() { [[ -x "$1" ]] && "$1" -e "$NODE_OK" 2>/dev/null; }
CANDIDATES=("${LIVE_DC_NODE:-}" "$APP_DIR/bin/node" "$(command -v node || true)")
if [[ -n "${SUDO_USER:-}" ]]; then
  CANDIDATES+=("$(sudo -u "$SUDO_USER" -H bash -lic 'command -v node' 2>/dev/null | tail -1 || true)")
fi
NODE_SRC=""
for c in "${CANDIDATES[@]}"; do
  [[ -n "$c" ]] || continue
  c="$(readlink -f "$c" 2>/dev/null || echo "$c")"
  if node_ok "$c"; then NODE_SRC="$c"; break; fi
done
if [[ -z "$NODE_SRC" ]]; then
  echo "install.sh: no Node >= 20.12 found (checked \$LIVE_DC_NODE, $APP_DIR/bin/node, PATH, ${SUDO_USER:-sudo user}'s shell)." >&2
  echo "  Install Node 22, or rerun with: sudo LIVE_DC_NODE=/path/to/node ./install.sh" >&2
  exit 1
fi
install -d -m 755 -o root -g root "$APP_DIR" "$APP_DIR/bin"
if [[ "$NODE_SRC" != "$(readlink -f "$APP_DIR/bin/node" 2>/dev/null || true)" ]]; then
  install -m 755 -o root -g root "$NODE_SRC" "$APP_DIR/bin/node"
fi
NODE_VERSION="$("$APP_DIR/bin/node" -p 'process.versions.node')"
if ! command -v aws >/dev/null 2>&1; then
  echo "WARNING: aws CLI not found; the service needs it for its secret, snapshots and livedc.sh update." >&2
fi

VERSION="$(basename "$SRC")"
if ! [[ "$VERSION" =~ $VERSION_RE ]]; then VERSION="live-dc-$(date -u +%Y%m%dT%H%M%SZ)"; fi

NOLOGIN="$(command -v nologin || echo /sbin/nologin)"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/live-dc --no-create-home --shell "$NOLOGIN" "$SERVICE_USER"
fi

install -d -m 755 -o root -g root "$APP_DIR" "$APP_DIR/releases"
rm -rf "$APP_DIR/releases/$VERSION.tmp"
cp -R "$SRC" "$APP_DIR/releases/$VERSION.tmp"
chown -R root:root "$APP_DIR/releases/$VERSION.tmp"
chmod -R u=rwX,go=rX "$APP_DIR/releases/$VERSION.tmp"
rm -rf "$APP_DIR/releases/$VERSION"
mv "$APP_DIR/releases/$VERSION.tmp" "$APP_DIR/releases/$VERSION"
ln -sfn "releases/$VERSION" "$APP_DIR/current.tmp"
mv -Tf "$APP_DIR/current.tmp" "$APP_DIR/current"
OPS="$SRC"; [[ -f "$OPS/livedc.sh" ]] || OPS="$HERE"
install -m 755 -o root -g root "$OPS/livedc.sh" "$APP_DIR/livedc.sh"
# Layout before releases/ (single bundle in /opt/live-dc): remove the stale copy.
rm -rf "$APP_DIR/live-dc-sync.mjs" "$APP_DIR/data"

install -d -m 750 -o root -g "$SERVICE_USER" "$CONF_DIR"
if [[ ! -f "$CONF_DIR/env" ]]; then
  install -m 640 -o root -g "$SERVICE_USER" "$OPS/env.example" "$CONF_DIR/env"
  echo "Created $CONF_DIR/env from env.example"
else
  echo "Kept existing $CONF_DIR/env"
fi
chown root:"$SERVICE_USER" "$CONF_DIR/env"
chmod 640 "$CONF_DIR/env"

install -m 644 -o root -g root "$OPS/live-dc.service" "$UNIT"
systemctl daemon-reload
systemctl enable live-dc.service

cat <<NEXT

Installed $VERSION (node $NODE_VERSION) -> $APP_DIR/current. Next steps:
  1. Password hash:   $APP_DIR/bin/node $APP_DIR/current/live-dc-sync.mjs --hash-password
     then set LIVE_DEMO_PASSWORD_HASH=<hash> in $CONF_DIR/env (sudo nano $CONF_DIR/env)
  2. Attach iam-policy.json to this instance's role (see README.md).
  3. Stop any other live-dc sync (single writer), then:
                      sudo $APP_DIR/livedc.sh start
  4. Check it:        $APP_DIR/livedc.sh status; $APP_DIR/livedc.sh logs
  Updates:            sudo $APP_DIR/livedc.sh update latest
NEXT
