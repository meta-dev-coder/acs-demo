#!/usr/bin/env bash
# Operates the live-dc service on the EC2 host (installed as /opt/live-dc/livedc.sh).
#   livedc.sh start|stop|restart|status|logs
#   livedc.sh update [<version>|latest]   fetch from s3://$LIVE_DC_RELEASE_BUCKET/$LIVE_DC_RELEASE_PREFIX via the instance role
#   livedc.sh rollback                    switch back to the previous installed release
#   livedc.sh uninstall [-y]              stop, disable, remove the unit, /opt/live-dc and /etc/live-dc
set -euo pipefail

ROOT_DIR="${LIVE_DC_ROOT:-/opt/live-dc}"
CONF_DIR="${LIVE_DC_CONF_DIR:-/etc/live-dc}"
UNIT_PATH="${LIVE_DC_UNIT_PATH:-/etc/systemd/system/live-dc.service}"
STATE_DIR="${LIVE_DC_STATE_DIR:-/var/lib/live-dc}"
SERVICE=live-dc
SERVICE_USER=livedc
KEEP=3
VERSION_RE='^live-dc-[0-9]{8}T[0-9]{6}Z$'

die() { echo "livedc: $*" >&2; exit 1; }
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

conf_get() {
  local key="$1" value="${!1:-}"
  if [[ -z "$value" && -r "$CONF_DIR/env" ]]; then
    value="$(grep -E "^${key}=" "$CONF_DIR/env" | tail -n 1 | cut -d= -f2- || true)"
  fi
  printf '%s' "$value"
}

need_root() {
  if [[ $EUID -ne 0 && -z "${LIVE_DC_TEST_MODE:-}" ]]; then die "run with sudo"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

current_version() {
  if [[ -L "$ROOT_DIR/current" ]]; then basename "$(readlink "$ROOT_DIR/current")"; fi
}

switch_to() {
  local version="$1"
  ln -sfn "releases/$version" "$ROOT_DIR/current.tmp"
  # GNU mv -T renames the link over the old one atomically; the fallback is for non-GNU test hosts.
  if ! mv -Tf "$ROOT_DIR/current.tmp" "$ROOT_DIR/current" 2>/dev/null; then
    rm -f "$ROOT_DIR/current"
    mv -f "$ROOT_DIR/current.tmp" "$ROOT_DIR/current"
  fi
}

refresh_ops_files() {
  local dir="$ROOT_DIR/releases/$1"
  if [[ -f "$dir/livedc.sh" ]]; then install -m 755 "$dir/livedc.sh" "$ROOT_DIR/livedc.sh.new" && mv -f "$ROOT_DIR/livedc.sh.new" "$ROOT_DIR/livedc.sh"; fi
  if [[ -f "$dir/live-dc.service" ]] && ! cmp -s "$dir/live-dc.service" "$UNIT_PATH"; then
    install -m 644 "$dir/live-dc.service" "$UNIT_PATH"
    systemctl daemon-reload
  fi
}

prune() {
  local current keep name
  current="$(current_version)"
  keep="$(ls -1 "$ROOT_DIR/releases" | grep -E "$VERSION_RE" | sort -r | head -n "$KEEP")"
  for dir in "$ROOT_DIR"/releases/*; do
    name="$(basename "$dir")"
    [[ "$name" == "$current" ]] && continue
    printf '%s\n' "$keep" | grep -qx "$name" && continue
    rm -rf "$dir"
  done
}

cmd_update() {
  need_root
  local version="${1:-latest}" bucket prefix base tmp expected actual
  bucket="$(conf_get LIVE_DC_RELEASE_BUCKET)"
  prefix="$(conf_get LIVE_DC_RELEASE_PREFIX)"
  prefix="${prefix:-releases/live-dc}"
  [[ -n "$bucket" ]] || die "LIVE_DC_RELEASE_BUCKET is not set in $CONF_DIR/env"
  base="s3://$bucket/${prefix%/}"
  if [[ "$version" == "latest" ]]; then
    version="$(aws s3 cp "$base/latest" - | tr -d '[:space:]')" || die "could not read $base/latest"
  fi
  if ! [[ "$version" =~ $VERSION_RE ]]; then echo "livedc: invalid version '$version'" >&2; exit 2; fi
  if [[ -d "$ROOT_DIR/releases/$version" && "$(current_version)" == "$version" ]]; then
    echo "$version is already current"; return 0
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  aws s3 cp "$base/$version.tar.gz" "$tmp/$version.tar.gz" >/dev/null || die "download of $version.tar.gz failed"
  aws s3 cp "$base/$version.tar.gz.sha256" "$tmp/$version.tar.gz.sha256" >/dev/null || die "download of $version.tar.gz.sha256 failed"
  expected="$(cut -d' ' -f1 < "$tmp/$version.tar.gz.sha256" | tr -d '[:space:]')"
  actual="$(sha256_of "$tmp/$version.tar.gz")"
  [[ -n "$expected" && "$expected" == "$actual" ]] || die "sha256 mismatch for $version.tar.gz (expected $expected, got $actual)"

  mkdir -p "$ROOT_DIR/releases" "$tmp/unpack"
  tar -xzf "$tmp/$version.tar.gz" -C "$tmp/unpack" --no-same-owner
  [[ -f "$tmp/unpack/live-dc-sync.mjs" ]] || die "$version.tar.gz has no live-dc-sync.mjs"
  chmod -R u=rwX,go=rX "$tmp/unpack"
  rm -rf "$ROOT_DIR/releases/$version"
  mv "$tmp/unpack" "$ROOT_DIR/releases/$version"
  switch_to "$version"
  refresh_ops_files "$version"
  systemctl restart "$SERVICE"
  prune
  echo "live-dc now at $version"
}

cmd_rollback() {
  need_root
  local current previous
  current="$(current_version)"
  previous="$(ls -1 "$ROOT_DIR/releases" 2>/dev/null | grep -E "$VERSION_RE" | sort | awk -v c="$current" '$0 < c' | tail -n 1)"
  [[ -n "$previous" ]] || die "no release older than ${current:-<none>} to roll back to"
  switch_to "$previous"
  refresh_ops_files "$previous"
  systemctl restart "$SERVICE"
  echo "live-dc rolled back to $previous (was $current)"
}

cmd_status() {
  local port health
  port="$(conf_get LIVE_DC_HTTP_PORT)"
  port="${port:-8095}"
  echo "service:  $(systemctl is-active "$SERVICE" 2>/dev/null || true) ($(systemctl is-enabled "$SERVICE" 2>/dev/null || true))"
  echo "release:  $(current_version || true)"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ":$port "; then echo "port:     $port listening"; else echo "port:     $port not listening"; fi
  fi
  health="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz" 2>/dev/null || true)"
  if [[ -n "$health" ]]; then
    echo "healthz:  $health"
    echo "last cycle: $(printf '%s' "$health" | sed -n 's/.*"lastCycleAt":"\{0,1\}\([^",}]*\).*/\1/p')"
  else
    echo "healthz:  unreachable on 127.0.0.1:$port"
  fi
}

cmd_uninstall() {
  need_root
  if [[ "${1:-}" != "-y" ]]; then
    local answer=""
    read -r -p "Remove the live-dc service, $ROOT_DIR and $CONF_DIR? [y/N] " answer || true
    [[ "$answer" =~ ^[Yy]$ ]] || die "aborted"
  fi
  systemctl disable --now "$SERVICE" || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload || true
  rm -rf "$ROOT_DIR" "$CONF_DIR" "$STATE_DIR"
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then userdel "$SERVICE_USER" || true; fi
  echo "live-dc removed"
}

[[ $# -ge 1 ]] || usage
command="$1"
shift
case "$command" in
  start) need_root; systemctl start "$SERVICE" ;;
  stop) need_root; systemctl stop "$SERVICE" ;;
  restart) need_root; systemctl restart "$SERVICE" ;;
  status) cmd_status ;;
  logs) journalctl -u "$SERVICE" -f ;;
  update) cmd_update "$@" ;;
  rollback) cmd_rollback ;;
  uninstall) cmd_uninstall "$@" ;;
  *) usage ;;
esac
