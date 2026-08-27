#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="/opt/dglab-mutual-web"
APP_USER="dglab-mutual"
CONFIG_FILE="/etc/dglab-mutual/config.env"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ROOT="$APP_DIR/.update-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_ROOT/$STAMP.tar.gz"
FILES=(index.html app.js server.js tls-scan.js package.json README.md VERSION.txt deploy.sh deploy.ps1 update.sh OFFICIAL_SOCKET.md LICENSE LICENSE-GPL-3.0 NOTICE.md CHANGELOG.md SECURITY.md CONTRIBUTING.md)

say(){ printf '\n\033[1;36m[UPDATE]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "请使用 root 运行"
  exec sudo -E bash "$0" "$@"
fi

[[ -d "$APP_DIR" && -f "$APP_DIR/run.sh" ]] || die "未发现已部署目录 $APP_DIR，请先执行 deploy.sh 完成首次部署"
[[ -r "$CONFIG_FILE" ]] || die "未发现部署配置 $CONFIG_FILE"
# shellcheck disable=SC1090
. "$CONFIG_FILE"
WEB_PORT="${SAVED_WEB_PORT:-}"
DOMAIN="${SAVED_DOMAIN:-}"
USE_SSL="${SAVED_USE_SSL:-0}"
NODE_BIN="${SAVED_NODE_BIN:-$(command -v node || true)}"
[[ -n "$WEB_PORT" ]] || die "配置中缺少网页端口"
[[ -x "$NODE_BIN" ]] || die "找不到已部署 Node.js：${NODE_BIN:-<空>}"

[[ -f "$SRC_DIR/server.js" && -f "$SRC_DIR/app.js" && -f "$SRC_DIR/index.html" ]] || die "当前目录不是完整更新包：$SRC_DIR"
"$NODE_BIN" --check "$SRC_DIR/server.js" >/dev/null || die "新版 server.js 语法检查失败，未更新"
"$NODE_BIN" --check "$SRC_DIR/app.js" >/dev/null || die "新版 app.js 语法检查失败，未更新"

mkdir -p "$BACKUP_ROOT"
# 仅备份程序文件，不碰 domains、SSL、run.sh、配置和运行时。
existing=()
for f in "${FILES[@]}" vendor; do [[ -e "$APP_DIR/$f" ]] && existing+=("$f"); done
if [[ ${#existing[@]} -gt 0 ]]; then
  tar -C "$APP_DIR" -czf "$BACKUP_FILE" "${existing[@]}"
  say "已备份当前程序：$BACKUP_FILE"
fi

rollback(){
  warn "更新失败，正在回滚旧程序…"
  for f in "${FILES[@]}"; do rm -f "$APP_DIR/$f"; done
  rm -rf "$APP_DIR/vendor"
  [[ -f "$BACKUP_FILE" ]] && tar -C "$APP_DIR" -xzf "$BACKUP_FILE"
  for f in "${FILES[@]}" vendor; do [[ -e "$APP_DIR/$f" ]] && chown -R "$APP_USER:$APP_USER" "$APP_DIR/$f" 2>/dev/null || true; done
  restart_service || true
}
trap 'rollback' ERR

say "同步当前目录 → $APP_DIR"
for f in "${FILES[@]}"; do
  [[ -f "$SRC_DIR/$f" ]] && install -m 0644 "$SRC_DIR/$f" "$APP_DIR/$f"
done
if [[ -d "$SRC_DIR/vendor" ]]; then
  rm -rf "$APP_DIR/vendor.new"
  cp -a "$SRC_DIR/vendor" "$APP_DIR/vendor.new"
  rm -rf "$APP_DIR/vendor"
  mv "$APP_DIR/vendor.new" "$APP_DIR/vendor"
fi
chmod 0755 "$APP_DIR/deploy.sh" "$APP_DIR/update.sh" 2>/dev/null || true
"$NODE_BIN" --check "$APP_DIR/server.js" >/dev/null
"$NODE_BIN" --check "$APP_DIR/app.js" >/dev/null
for f in "${FILES[@]}" vendor; do [[ -e "$APP_DIR/$f" ]] && chown -R "$APP_USER:$APP_USER" "$APP_DIR/$f"; done

restart_service(){
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] && systemctl cat dglab-mutual.service >/dev/null 2>&1; then
    systemctl restart dglab-mutual.service
    return
  fi
  if command -v rc-service >/dev/null 2>&1 && [[ -e /etc/init.d/dglab-mutual ]]; then
    rc-service dglab-mutual restart
    return
  fi
  if [[ -f "$APP_DIR/app.pid" ]]; then
    kill "$(cat "$APP_DIR/app.pid" 2>/dev/null)" 2>/dev/null || true
    rm -f "$APP_DIR/app.pid"
  fi
  if (( WEB_PORT < 1024 )); then
    nohup "$APP_DIR/run.sh" >>"$APP_DIR/app.log" 2>&1 & echo $! > "$APP_DIR/app.pid"
  else
    su -s /bin/sh "$APP_USER" -c "nohup '$APP_DIR/run.sh' >>'$APP_DIR/app.log' 2>&1 & echo \$! > '$APP_DIR/app.pid'"
  fi
}

health_check(){
  local ok=0 proto url
  proto="$([[ "$USE_SSL" == "1" ]] && echo https || echo http)"
  if [[ "$USE_SSL" == "1" && -n "$DOMAIN" ]]; then
    url="https://${DOMAIN}:${WEB_PORT}/healthz"
    for _ in $(seq 1 15); do
      if curl -kfsS --max-time 3 --resolve "${DOMAIN}:${WEB_PORT}:127.0.0.1" "$url" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
      sleep 1
    done
  else
    for _ in $(seq 1 15); do
      if curl -fsS --max-time 3 "http://127.0.0.1:${WEB_PORT}/healthz" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
      sleep 1
    done
  fi
  [[ $ok -eq 1 ]]
}

say "重启服务…"
restart_service
say "检查服务…"
health_check || { false; }
trap - ERR

version="$(cat "$APP_DIR/VERSION.txt" 2>/dev/null || echo unknown)"
printf '\n\033[1;32m更新完成\033[0m 版本: %s\n' "$version"
printf '运行目录: %s\n' "$APP_DIR"
printf '保留配置: 端口 %s / 域名 %s / SSL %s\n' "$WEB_PORT" "${DOMAIN:-<无>}" "$USE_SSL"
printf '以后仍可在上传目录执行: sudo bash update.sh\n'
