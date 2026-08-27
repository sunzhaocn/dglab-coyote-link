#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
ORIGINAL_ARGS=("$@")

APP_NAME="dglab-mutual-web"
APP_DIR="/opt/${APP_NAME}"
APP_USER="dglab-mutual"
WEB_PORT="8443"
DOMAIN=""
MODE="install"
USE_SSL=1
ASSUME_YES=0
PORT_SET=0
DOMAIN_SET=0
SSL_SET=0
CERT_FILE=""
KEY_FILE=""
CERT_SET=0
KEY_SET=0
LOG_FILE="/tmp/${APP_NAME}-deploy.log"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="/etc/dglab-mutual"
CONFIG_FILE="$CONFIG_DIR/config.env"
DOMAIN_DIR=""
SSL_DIR=""
TLS_DIR=""

exec > >(tee -a "$LOG_FILE") 2>&1

say(){ printf '\n\033[1;36m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn(){ printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; printf '部署日志: %s\n' "$LOG_FILE" >&2; exit 1; }

usage(){ cat <<'TXT'
CoyoteLink · 郊狼互控 一键部署 v1.0.0

交互部署：
  sudo bash deploy.sh

向导会先询问：
  1. 网页公网端口（输入多少就只监听多少）
  2. 域名
  3. 是否启用 SSL/HTTPS
  4. 输入域名后自动创建 domains/<域名>/ssl 目录
  5. SSL 文件放入该目录后自动通配符识别
  6. 最终确认

重要：脚本不会占用、停止、删除或重配 80/443 上已有项目。
只有当你自己把网页端口明确设置成 80 或 443 时，才会检查并尝试使用该端口；若已占用会直接退出。

无交互示例：
  # 先把证书放入 /opt/dglab-mutual-web/domains/example.com/ssl/
  sudo bash deploy.sh --port 8989 --domain example.com --ssl --yes

  sudo bash deploy.sh --port 8989 --no-ssl --yes

其他：
  sudo bash deploy.sh --repair
  sudo bash deploy.sh --update   # 从当前上传目录同步到 /opt 并自动重启
  sudo bash deploy.sh --uninstall

选项：
  --port PORT       公网网页端口，默认 8443
  --domain DOMAIN   域名或 IPv4
  --ssl             HTTPS/WSS；同一自定义端口上的 HTTP 自动 308 跳转 HTTPS
  --no-ssl          HTTP/WS
  --cert-file PATH  可选：导入一个证书文件到域名 SSL 目录
  --key-file PATH   可选：导入一个私钥文件到域名 SSL 目录
  --yes             跳过交互确认
  --repair          按上次配置修复
  --update          仅同步新版程序并重启，保留端口/域名/SSL
  --uninstall       仅卸载本项目
TXT
}

validate_port(){
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || die "网页端口必须是数字"
  (( value >= 1 && value <= 65535 )) || die "网页端口必须在 1-65535 之间"
}

validate_host(){
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "$value" =~ ^[A-Za-z0-9.-]+$ ]] || die "域名/IP 格式无效：只填写 example.com 或 1.2.3.4，不要带协议、端口或路径"
}

set_domain_paths(){
  if [[ -n "$DOMAIN" ]]; then
    DOMAIN_DIR="$APP_DIR/domains/$DOMAIN"
    SSL_DIR="$DOMAIN_DIR/ssl"
    TLS_DIR="$SSL_DIR/active"
  else
    DOMAIN_DIR=""; SSL_DIR=""; TLS_DIR=""
  fi
}

prepare_domain_ssl_dir(){
  [[ -n "$DOMAIN" ]] || return 0
  set_domain_paths
  mkdir -p "$SSL_DIR" "$TLS_DIR"
  chmod 0750 "$DOMAIN_DIR" "$SSL_DIR" 2>/dev/null || true
  chmod 0700 "$TLS_DIR" 2>/dev/null || true
}

list_ssl_candidates(){
  [[ -n "$SSL_DIR" && -d "$SSL_DIR" ]] || return 1
  find "$SSL_DIR" -maxdepth 2 -type f \
    \( -iname '*.pem' -o -iname '*.crt' -o -iname '*.cer' -o -iname '*.key' \) \
    ! -path "$TLS_DIR/*" -print 2>/dev/null | sort
}

scan_ssl_pair(){
  [[ -n "$SSL_DIR" && -d "$SSL_DIR" ]] || return 1
  command -v openssl >/dev/null 2>&1 || return 2
  local cert key cert_hash key_hash
  local -a certs=() keys=() files=()
  while IFS= read -r cert; do [[ -n "$cert" ]] && files+=("$cert"); done < <(list_ssl_candidates || true)
  [[ ${#files[@]} -gt 0 ]] || return 1

  # 先按内容判断证书/私钥，不依赖固定文件名。
  for cert in "${files[@]}"; do
    if openssl x509 -in "$cert" -noout >/dev/null 2>&1; then certs+=("$cert"); fi
    if openssl pkey -in "$cert" -noout >/dev/null 2>&1; then keys+=("$cert"); fi
  done
  [[ ${#certs[@]} -gt 0 && ${#keys[@]} -gt 0 ]] || return 1

  # fullchain/cert 优先，但最终必须通过公钥匹配。
  mapfile -t certs < <(printf '%s\n' "${certs[@]}" | awk '
    BEGIN{IGNORECASE=1}
    /fullchain|full_chain|bundle/{print "0|"$0;next}
    /cert|certificate|\.crt$|\.cer$/{print "1|"$0;next}
    {print "2|"$0}' | sort | cut -d'|' -f2-)
  mapfile -t keys < <(printf '%s\n' "${keys[@]}" | awk '
    BEGIN{IGNORECASE=1}
    /privkey|private/{print "0|"$0;next}
    /\.key$|key/{print "1|"$0;next}
    {print "2|"$0}' | sort | cut -d'|' -f2-)

  for cert in "${certs[@]}"; do
    cert_hash="$(openssl x509 -in "$cert" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 2>/dev/null | awk '{print $2}')"
    [[ -n "$cert_hash" ]] || continue
    for key in "${keys[@]}"; do
      key_hash="$(openssl pkey -in "$key" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 2>/dev/null | awk '{print $2}')"
      if [[ -n "$key_hash" && "$cert_hash" == "$key_hash" ]]; then
        CERT_FILE="$cert"; KEY_FILE="$key"; return 0
      fi
    done
  done
  return 1
}

scan_ssl_pair_node(){
  [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]] || return 1
  [[ -f "$APP_DIR/tls-scan.js" ]] || return 1
  local raw cert key
  raw="$($NODE_BIN "$APP_DIR/tls-scan.js" --dir "$SSL_DIR" --domain "$DOMAIN" 2>/dev/null || true)"
  [[ "$raw" == *'"ok":true'* ]] || return 1
  cert="$(printf '%s' "$raw" | $NODE_BIN -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).cert||"")}catch{}})')"
  key="$(printf '%s' "$raw" | $NODE_BIN -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).key||"")}catch{}})')"
  [[ -f "$cert" && -f "$key" ]] || return 1
  CERT_FILE="$cert"; KEY_FILE="$key"; return 0
}

import_cli_tls_files(){
  [[ $USE_SSL -eq 1 ]] || return 0
  prepare_domain_ssl_dir
  if [[ $CERT_SET -eq 1 && -n "$CERT_FILE" ]]; then
    [[ -f "$CERT_FILE" ]] || die "证书文件不存在: $CERT_FILE"
    cp -f "$CERT_FILE" "$SSL_DIR/$(basename "$CERT_FILE")"
  fi
  if [[ $KEY_SET -eq 1 && -n "$KEY_FILE" ]]; then
    [[ -f "$KEY_FILE" ]] || die "私钥文件不存在: $KEY_FILE"
    cp -f "$KEY_FILE" "$SSL_DIR/$(basename "$KEY_FILE")"
  fi
}

precheck_ssl_files(){
  [[ -n "$SSL_DIR" && -d "$SSL_DIR" ]] || return 1
  local f have_cert=0 have_key=0
  while IFS= read -r f; do
    grep -aq -- '-----BEGIN CERTIFICATE-----' "$f" 2>/dev/null && have_cert=1
    grep -Eaq -- '-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----' "$f" 2>/dev/null && have_key=1
  done < <(list_ssl_candidates || true)
  [[ $have_cert -eq 1 && $have_key -eq 1 ]]
}

wait_for_ssl_files(){
  [[ $USE_SSL -eq 1 ]] || return 0
  prepare_domain_ssl_dir
  if command -v openssl >/dev/null 2>&1 && scan_ssl_pair; then return 0; fi
  if ! command -v openssl >/dev/null 2>&1 && precheck_ssl_files; then return 0; fi
  [[ $ASSUME_YES -eq 0 && -t 0 ]] || die "未在 $SSL_DIR 找到证书和私钥。请把 *.pem/*.crt/*.cer/*.key 放入该目录后重试。"
  while true; do
    printf '\n域名目录已创建：%s\n' "$DOMAIN_DIR"
    printf '请把 SSL 文件放入：%s\n' "$SSL_DIR"
    printf '文件名可以任意；脚本会通配符扫描 *.pem/*.crt/*.cer/*.key。\n'
    local input
    read -r -p "放好后按 Enter 自动扫描；输入 q 退出: " input
    [[ "${input,,}" == "q" ]] && exit 0
    if command -v openssl >/dev/null 2>&1; then
      if scan_ssl_pair; then
        printf '已自动匹配：\n  证书: %s\n  私钥: %s\n' "$CERT_FILE" "$KEY_FILE"
        return 0
      fi
    elif precheck_ssl_files; then
      printf '已检测到证书和私钥文件；部署开始后将用 OpenSSL 校验是否匹配。\n'
      return 0
    fi
    warn "仍未找到证书 + 私钥文件组合。当前扫描到："
    list_ssl_candidates || true
  done
}
load_saved_config(){
  [[ -r "$CONFIG_FILE" ]] || return 1
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  WEB_PORT="${SAVED_WEB_PORT:-$WEB_PORT}"
  DOMAIN="${SAVED_DOMAIN:-$DOMAIN}"
  USE_SSL="${SAVED_USE_SSL:-$USE_SSL}"
  CERT_FILE="${SAVED_CERT_FILE:-$CERT_FILE}"
  KEY_FILE="${SAVED_KEY_FILE:-$KEY_FILE}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) WEB_PORT="${2:-}"; PORT_SET=1; shift 2;;
    --domain) DOMAIN="${2:-}"; DOMAIN_SET=1; shift 2;;
    --ssl) USE_SSL=1; SSL_SET=1; shift;;
    --no-ssl|--http-only) USE_SSL=0; SSL_SET=1; shift;;
    --cert-file) CERT_FILE="${2:-}"; CERT_SET=1; shift 2;;
    --key-file) KEY_FILE="${2:-}"; KEY_SET=1; shift 2;;
    --yes|-y) ASSUME_YES=1; shift;;
    --repair) MODE="repair"; shift;;
    --update) MODE="update"; shift;;
    --uninstall) MODE="uninstall"; shift;;
    -h|--help) usage; exit 0;;
    *) die "未知参数: $1";;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    say "需要管理员权限以创建域名目录；正在重新以 root 运行配置向导。"
    exec sudo -E bash "$0" "${ORIGINAL_ARGS[@]}"
  fi
  die "请使用 root 运行：sudo bash deploy.sh"
fi

if [[ "$MODE" == "update" ]]; then
  [[ -f "$SRC_DIR/update.sh" ]] || die "当前目录缺少 update.sh"
  exec bash "$SRC_DIR/update.sh"
fi

if [[ "$MODE" == "repair" ]]; then
  load_saved_config || die "没有找到上次部署配置：$CONFIG_FILE"
  set_domain_paths
fi

config_wizard(){
  [[ "$MODE" == "install" ]] || return 0
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ -t 0 ]] || die "当前环境不能交互输入，请传 --port / --domain / --ssl|--no-ssl / --yes；SSL 文件请预先放入域名 ssl 目录。"

  local input ssl_input confirm preview proto display_host
  printf '\n\033[1;35m========== DG-LAB 部署配置 ==========%s\033[0m\n' ''

  if [[ $PORT_SET -eq 0 ]]; then
    read -r -p "网页公网访问端口 [8443]: " input
    [[ -n "$input" ]] && WEB_PORT="$input"
  else
    printf '网页公网访问端口: %s\n' "$WEB_PORT"
  fi
  validate_port "$WEB_PORT"

  if [[ $DOMAIN_SET -eq 0 ]]; then
    while true; do
      read -r -p "域名/IP [HTTP 可留空]: " DOMAIN
      DOMAIN="${DOMAIN//[[:space:]]/}"
      if [[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then break; fi
      warn "只填写 example.com 或 1.2.3.4，不要带 http://、https://、端口或路径。"
    done
  else
    printf '域名/IP: %s\n' "${DOMAIN:-<留空>}"
  fi
  validate_host "$DOMAIN"
  if [[ -n "$DOMAIN" ]]; then
    prepare_domain_ssl_dir
    printf '域名目录 : %s\n' "$DOMAIN_DIR"
    printf 'SSL目录  : %s\n' "$SSL_DIR"
  fi

  if [[ $SSL_SET -eq 0 ]]; then
    read -r -p "启用 SSL/HTTPS？[Y/n]: " ssl_input
    case "${ssl_input,,}" in n|no|0) USE_SSL=0;; *) USE_SSL=1;; esac
  else
    printf 'SSL/HTTPS: %s\n' "$([[ $USE_SSL -eq 1 ]] && echo 启用 || echo 禁用)"
  fi

  if [[ $USE_SSL -eq 1 ]]; then
    while [[ -z "$DOMAIN" ]]; do
      warn "HTTPS 需要域名/IP。"
      read -r -p "请输入证书对应的域名/IP: " DOMAIN
      DOMAIN="${DOMAIN//[[:space:]]/}"
      validate_host "$DOMAIN"
      [[ -n "$DOMAIN" ]] && prepare_domain_ssl_dir
    done
    prepare_domain_ssl_dir
    import_cli_tls_files
    wait_for_ssl_files
  fi

  proto="$([[ $USE_SSL -eq 1 ]] && echo https || echo http)"
  display_host="${DOMAIN:-服务器IP}"
  preview="${proto}://${display_host}:${WEB_PORT}"
  [[ "$WEB_PORT" == "443" && "$proto" == "https" ]] && preview="${proto}://${display_host}"
  [[ "$WEB_PORT" == "80" && "$proto" == "http" ]] && preview="${proto}://${display_host}"

  printf '\n---------- 请确认部署参数 ----------\n'
  printf '网页端口 : %s（只使用此端口）\n' "$WEB_PORT"
  printf '域名/IP  : %s\n' "${DOMAIN:-<服务器IP>}"
  printf 'SSL      : %s\n' "$([[ $USE_SSL -eq 1 ]] && echo '开启（HTTPS/WSS；同端口 HTTP→HTTPS）' || echo '关闭（HTTP/WS）')"
  [[ $USE_SSL -eq 1 ]] && printf 'SSL目录  : %s\n证书识别 : 自动通配符扫描并校验匹配\n' "$SSL_DIR"
  printf '预计地址 : %s\n' "$preview"
  printf '端口策略 : 不占用、不停止、不删除、不重配其他端口上的现有项目。\n'
  if [[ "$WEB_PORT" != "80" && "$WEB_PORT" != "443" ]]; then
    printf '80/443   : 完全不使用；现有项目保持原样。\n'
  else
    printf '%s      : 你主动选择了该端口；若已被现有项目占用，部署会直接退出。\n' "$WEB_PORT"
  fi
  printf '%s\n' '------------------------------------'
  read -r -p "确认以上配置并开始部署？[Y/n]: " confirm
  case "${confirm,,}" in n|no|0) printf '已取消，未开始安装。\n'; exit 0;; esac
}

config_wizard
if [[ "$MODE" != "uninstall" ]]; then
  validate_port "$WEB_PORT"
  validate_host "$DOMAIN"
  [[ $USE_SSL -eq 0 || -n "$DOMAIN" ]] || die "启用 SSL 时必须提供域名/IP"
  set_domain_paths
fi

install_base_tools(){
  local missing=()
  for c in curl tar xz openssl; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  say "安装基础工具（不会安装/修改 Web 服务器）…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y && apt-get install -y curl ca-certificates xz-utils tar gzip openssl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates xz tar gzip openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates xz tar gzip openssl
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install curl ca-certificates xz tar gzip openssl
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl ca-certificates xz tar gzip openssl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates xz tar gzip openssl shadow
  else
    die "无法识别包管理器。请先安装 curl、tar、xz、openssl。"
  fi
}

ensure_user(){
  id "$APP_USER" >/dev/null 2>&1 && return 0
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "/var/lib/$APP_USER" --create-home --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null || useradd -r -m -d "/var/lib/$APP_USER" -s /bin/false "$APP_USER"
  elif command -v adduser >/dev/null 2>&1; then
    adduser -S -D -H -h "/var/lib/$APP_USER" -s /sbin/nologin "$APP_USER"
  else
    die "系统缺少 useradd/adduser"
  fi
}

node_version_ok(){
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 20 ))
}

install_node(){
  if node_version_ok; then NODE_BIN="$(command -v node)"; say "使用现有 Node.js: $($NODE_BIN -v)"; return; fi
  local arch node_arch sums tarname tmp expected actual
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) node_arch="x64";;
    aarch64|arm64) node_arch="arm64";;
    armv7l) node_arch="armv7l";;
    ppc64le) node_arch="ppc64le";;
    s390x) node_arch="s390x";;
    *) die "暂不支持自动下载 Node.js 的架构: $arch";;
  esac
  if [[ -f /etc/alpine-release ]]; then
    apk add --no-cache nodejs
    node_version_ok || die "系统 Node.js 版本低于 20"
    NODE_BIN="$(command -v node)"; return
  fi
  say "安装独立 Node.js 22 LTS（仅放在本项目目录）…"
  mkdir -p "$APP_DIR/.runtime/node"
  sums="$(curl -fL --retry 3 --connect-timeout 10 --max-time 60 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)" || die "无法下载 Node.js 校验清单"
  tarname="$(printf '%s\n' "$sums" | awk -v a="linux-${node_arch}.tar.xz" '$2 ~ a"$" {print $2; exit}')"
  [[ -n "$tarname" ]] || die "未找到 Node.js 安装包"
  tmp="/tmp/$tarname"
  curl -fL --retry 3 --connect-timeout 10 --max-time 180 -o "$tmp" "https://nodejs.org/dist/latest-v22.x/$tarname" || die "Node.js 下载失败"
  expected="$(printf '%s\n' "$sums" | awk -v f="$tarname" '$2==f {print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp" | awk '{print $1}')"; [[ "$actual" == "$expected" ]] || die "Node.js SHA256 校验失败"
  fi
  rm -rf "$APP_DIR/.runtime/node" && mkdir -p "$APP_DIR/.runtime/node"
  tar -xJf "$tmp" --strip-components=1 -C "$APP_DIR/.runtime/node" && rm -f "$tmp"
  NODE_BIN="$APP_DIR/.runtime/node/bin/node"
  "$NODE_BIN" -v >/dev/null || die "Node.js 无法运行"
}

port_owner(){
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltnp 2>/dev/null | awk -v p="$p" '$4 ~ (":" p "$") {print}' || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || true
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v p="$p" '$4 ~ (":" p "$") {print}' || true
  else
    python3 - "$p" <<'PYPORT' 2>/dev/null || true
import socket,sys
p=int(sys.argv[1]); s=socket.socket(); s.settimeout(.2)
try:
    s.bind(('0.0.0.0',p))
except OSError as e:
    print('端口已占用:', e)
finally:
    s.close()
PYPORT
  fi
}

stop_own_service(){
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then systemctl stop dglab-mutual.service 2>/dev/null || true; fi
  if command -v rc-service >/dev/null 2>&1; then rc-service dglab-mutual stop 2>/dev/null || true; fi
  if [[ -f "$APP_DIR/app.pid" ]]; then kill "$(cat "$APP_DIR/app.pid" 2>/dev/null)" 2>/dev/null || true; rm -f "$APP_DIR/app.pid"; fi
}

check_selected_port(){
  local owner
  owner="$(port_owner "$WEB_PORT")"
  if [[ -n "$owner" ]]; then
    printf '%s\n' "$owner"
    die "你指定的端口 $WEB_PORT 已被其他项目占用。脚本不会停止或删除它。请重新运行并输入另一个端口。"
  fi
}

validate_and_copy_tls(){
  [[ $USE_SSL -eq 1 ]] || return 0
  prepare_domain_ssl_dir

  # 兼容旧版配置/命令行路径：存在外部文件时先导入域名 SSL 目录。
  if [[ -n "$CERT_FILE" && -f "$CERT_FILE" && "$CERT_FILE" != "$SSL_DIR/"* ]]; then
    cp -f "$CERT_FILE" "$SSL_DIR/$(basename "$CERT_FILE")"
  fi
  if [[ -n "$KEY_FILE" && -f "$KEY_FILE" && "$KEY_FILE" != "$SSL_DIR/"* ]]; then
    cp -f "$KEY_FILE" "$SSL_DIR/$(basename "$KEY_FILE")"
  fi

  if ! scan_ssl_pair_node && ! scan_ssl_pair; then
    if [[ $ASSUME_YES -eq 0 && -t 0 ]]; then
      warn "SSL 文件存在但没有找到公钥匹配的一对证书/私钥。"
      wait_for_ssl_files
      scan_ssl_pair_node || scan_ssl_pair || die "证书与私钥仍无法匹配。SSL 目录：$SSL_DIR"
    else
      die "未在 $SSL_DIR 找到有效且公钥匹配的证书/私钥。"
    fi
  fi

  openssl x509 -in "$CERT_FILE" -noout >/dev/null 2>&1 || die "无法解析证书: $CERT_FILE"
  openssl pkey -in "$KEY_FILE" -noout >/dev/null 2>&1 || die "无法解析私钥: $KEY_FILE"
  if openssl x509 -help 2>&1 | grep -q -- '-checkhost'; then
    openssl x509 -in "$CERT_FILE" -noout -checkhost "$DOMAIN" >/dev/null 2>&1 || warn "证书名称可能与 $DOMAIN 不匹配；通配符证书如 *.example.com 可用于对应子域名。"
  fi

  mkdir -p "$TLS_DIR"
  install -m 0644 "$CERT_FILE" "$TLS_DIR/server.crt"
  install -m 0600 "$KEY_FILE" "$TLS_DIR/server.key"
  chown -R "$APP_USER:$APP_USER" "$TLS_DIR"
  printf 'SSL 自动识别成功：\n  证书: %s\n  私钥: %s\n  运行副本: %s\n' "$CERT_FILE" "$KEY_FILE" "$TLS_DIR"
}
copy_app(){
  say "复制网页和后端文件…"
  mkdir -p "$APP_DIR" "$CONFIG_DIR"
  if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
    for f in index.html app.js server.js tls-scan.js package.json README.md VERSION.txt deploy.sh deploy.ps1 update.sh OFFICIAL_SOCKET.md LICENSE-GPL-3.0; do
      [[ -f "$SRC_DIR/$f" ]] && install -m 0644 "$SRC_DIR/$f" "$APP_DIR/$f"
    done
  else
    say "repair 从已部署目录运行，保留现有程序文件。"
  fi
  if [[ -d "$SRC_DIR/vendor" && "$SRC_DIR" != "$APP_DIR" ]]; then rm -rf "$APP_DIR/vendor"; cp -a "$SRC_DIR/vendor" "$APP_DIR/vendor"; fi
  chmod 0755 "$APP_DIR/deploy.sh" 2>/dev/null || true
  "$NODE_BIN" --check "$APP_DIR/server.js" || die "server.js 语法检查失败"
  "$NODE_BIN" --check "$APP_DIR/app.js" || die "app.js 语法检查失败"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
}

save_config(){
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<EOF
SAVED_WEB_PORT='$WEB_PORT'
SAVED_DOMAIN='$DOMAIN'
SAVED_USE_SSL='$USE_SSL'
SAVED_SSL_DIR='$SSL_DIR'
SAVED_CERT_FILE='$CERT_FILE'
SAVED_KEY_FILE='$KEY_FILE'
SAVED_NODE_BIN='$NODE_BIN'
EOF
  chmod 0600 "$CONFIG_FILE"
}

install_cert_sync(){
  [[ $USE_SSL -eq 1 ]] || return 0
  cat > "$APP_DIR/sync-cert.sh" <<'SYNC'
#!/usr/bin/env bash
set -Eeuo pipefail
. /etc/dglab-mutual/config.env
APP_DIR=/opt/dglab-mutual-web
DOMAIN="$SAVED_DOMAIN"
SSL_DIR="${SAVED_SSL_DIR:-$APP_DIR/domains/$DOMAIN/ssl}"
TLS_DIR="$SSL_DIR/active"
NODE_BIN="${SAVED_NODE_BIN:-$(command -v node || true)}"
SCANNER="$APP_DIR/tls-scan.js"
[[ -x "$NODE_BIN" && -f "$SCANNER" && -d "$SSL_DIR" ]] || exit 0
mkdir -p "$TLS_DIR"
raw="$($NODE_BIN "$SCANNER" --dir "$SSL_DIR" --domain "$DOMAIN" 2>/dev/null || true)"
[[ "$raw" == *'"ok":true'* ]] || exit 0
cert="$(printf '%s' "$raw" | $NODE_BIN -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).cert||"")}catch{}})')"
key="$(printf '%s' "$raw" | $NODE_BIN -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).key||"")}catch{}})')"
[[ -f "$cert" && -f "$key" ]] || exit 0
changed=0
if ! cmp -s "$cert" "$TLS_DIR/server.crt"; then install -m 0644 "$cert" "$TLS_DIR/server.crt"; changed=1; fi
if ! cmp -s "$key" "$TLS_DIR/server.key"; then install -m 0600 "$key" "$TLS_DIR/server.key"; changed=1; fi
chown -R dglab-mutual:dglab-mutual "$TLS_DIR"
if [[ $changed -eq 1 ]]; then
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then systemctl restart dglab-mutual.service || true
  elif command -v rc-service >/dev/null 2>&1; then rc-service dglab-mutual restart || true
  fi
fi
SYNC
  chmod 0700 "$APP_DIR/sync-cert.sh"; chown root:root "$APP_DIR/sync-cert.sh"
}
write_run_script(){
  cat > "$APP_DIR/run.sh" <<EOF
#!/usr/bin/env bash
set -e
export PORT='$WEB_PORT'
export HOST='0.0.0.0'
EOF
  if [[ $USE_SSL -eq 1 ]]; then
    cat >> "$APP_DIR/run.sh" <<EOF
export TLS_CERT_FILE='$TLS_DIR/server.crt'
export TLS_KEY_FILE='$TLS_DIR/server.key'
EOF
  fi
  cat >> "$APP_DIR/run.sh" <<EOF
exec '$NODE_BIN' '$APP_DIR/server.js'
EOF
  chmod 0755 "$APP_DIR/run.sh"; chown "$APP_USER:$APP_USER" "$APP_DIR/run.sh"
}

setup_service(){
  local init="none"
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] && init="systemd"
  command -v rc-service >/dev/null 2>&1 && init="openrc"
  if [[ "$init" == "systemd" ]]; then
    say "配置 systemd 服务…"
    local caps=""
    (( WEB_PORT < 1024 )) && caps=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
    cat > /etc/systemd/system/dglab-mutual.service <<EOF
[Unit]
Description=DG-LAB Mutual Web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/run.sh
Restart=always
RestartSec=2
NoNewPrivileges=true
$caps

[Install]
WantedBy=multi-user.target
EOF
    if [[ $USE_SSL -eq 1 ]]; then
      cat > /etc/systemd/system/dglab-mutual-cert-sync.service <<EOF
[Unit]
Description=Sync DG-LAB existing TLS certificate

[Service]
Type=oneshot
ExecStart=$APP_DIR/sync-cert.sh
EOF
      cat > /etc/systemd/system/dglab-mutual-cert-sync.timer <<'EOF'
[Unit]
Description=Periodic DG-LAB TLS certificate sync

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF
    else
      rm -f /etc/systemd/system/dglab-mutual-cert-sync.service /etc/systemd/system/dglab-mutual-cert-sync.timer
    fi
    systemctl daemon-reload
    systemctl enable --now dglab-mutual.service
    if [[ $USE_SSL -eq 1 ]]; then systemctl enable --now dglab-mutual-cert-sync.timer >/dev/null 2>&1 || true; fi
  elif [[ "$init" == "openrc" ]]; then
    say "配置 OpenRC 服务…"
    local cmd_user="$APP_USER:$APP_USER"
    if (( WEB_PORT < 1024 )); then cmd_user="root:root"; warn "OpenRC + 低端口环境将以 root 启动 Node；建议使用 >=1024 的自定义端口。"; fi
    cat > /etc/init.d/dglab-mutual <<EOF
#!/sbin/openrc-run
name="DG-LAB Mutual Web"
command="$APP_DIR/run.sh"
command_user="$cmd_user"
command_background=true
pidfile="/run/dglab-mutual.pid"
output_log="$APP_DIR/app.log"
error_log="$APP_DIR/app.log"
depend() { need net; }
EOF
    chmod +x /etc/init.d/dglab-mutual
    rc-update add dglab-mutual default >/dev/null 2>&1 || true
    rc-service dglab-mutual restart || rc-service dglab-mutual start
  else
    say "未检测到 systemd/OpenRC，使用兼容后台模式…"
    stop_own_service
    if (( WEB_PORT < 1024 )); then
      nohup "$APP_DIR/run.sh" >>"$APP_DIR/app.log" 2>&1 & echo $! > "$APP_DIR/app.pid"
      warn "低端口兼容模式以 root 运行；建议改用 >=1024 端口。"
    else
      su -s /bin/sh "$APP_USER" -c "nohup '$APP_DIR/run.sh' >>'$APP_DIR/app.log' 2>&1 & echo \$! > '$APP_DIR/app.pid'"
    fi
  fi
}

open_firewall(){
  say "仅放行你指定的 TCP $WEB_PORT；不会新增 80/443 规则。"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$WEB_PORT/tcp" >/dev/null || true; fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$WEB_PORT/tcp" >/dev/null || true; firewall-cmd --reload >/dev/null || true
  fi
}

health_check(){
  say "检查网页入口和 WebSocket 所在端口…"
  local proto host url ok=0
  proto="$([[ $USE_SSL -eq 1 ]] && echo https || echo http)"
  host="${DOMAIN:-127.0.0.1}"
  url="${proto}://${host}:${WEB_PORT}/healthz"
  for _ in $(seq 1 20); do
    if [[ $USE_SSL -eq 1 ]]; then
      if curl -kfsS --max-time 3 --resolve "${DOMAIN}:${WEB_PORT}:127.0.0.1" "$url" | grep -q '"ok":true'; then ok=1; break; fi
    else
      if curl -fsS --max-time 3 "http://127.0.0.1:${WEB_PORT}/healthz" | grep -q '"ok":true'; then ok=1; break; fi
    fi
    sleep 1
  done
  [[ $ok -eq 1 ]] || {
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then journalctl -u dglab-mutual.service -n 80 --no-pager || true; else tail -n 80 "$APP_DIR/app.log" 2>/dev/null || true; fi
    die "服务没有在你指定的端口 $WEB_PORT 正常启动"
  }
  say "健康检查通过"
}

uninstall_all(){
  say "仅卸载 DG-LAB Mutual Web；不会操作 Nginx/Apache/Caddy 或其他项目。"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl disable --now dglab-mutual.service 2>/dev/null || true
    systemctl disable --now dglab-mutual-cert-sync.timer 2>/dev/null || true
    rm -f /etc/systemd/system/dglab-mutual.service /etc/systemd/system/dglab-mutual-cert-sync.service /etc/systemd/system/dglab-mutual-cert-sync.timer
    systemctl daemon-reload || true
  fi
  if command -v rc-service >/dev/null 2>&1; then rc-service dglab-mutual stop 2>/dev/null || true; rc-update del dglab-mutual default 2>/dev/null || true; rm -f /etc/init.d/dglab-mutual; fi
  stop_own_service
  if command -v ufw >/dev/null 2>&1 && [[ -r "$CONFIG_FILE" ]]; then . "$CONFIG_FILE"; ufw delete allow "${SAVED_WEB_PORT}/tcp" >/dev/null 2>&1 || true; fi
  if command -v firewall-cmd >/dev/null 2>&1 && [[ -r "$CONFIG_FILE" ]]; then . "$CONFIG_FILE"; firewall-cmd --permanent --remove-port="${SAVED_WEB_PORT}/tcp" >/dev/null 2>&1 || true; firewall-cmd --reload >/dev/null 2>&1 || true; fi
  rm -rf "$APP_DIR" "$CONFIG_DIR"
  say "卸载完成。80/443 及其他项目未被修改。"
}

if [[ "$MODE" == "uninstall" ]]; then uninstall_all; exit 0; fi

install_or_repair(){
  stop_own_service
  check_selected_port
  install_base_tools
  mkdir -p "$APP_DIR"
  set_domain_paths
  [[ $USE_SSL -eq 1 ]] && prepare_domain_ssl_dir
  [[ $USE_SSL -eq 1 ]] && import_cli_tls_files
  ensure_user
  install_node
  copy_app
  validate_and_copy_tls
  save_config
  install_cert_sync
  write_run_script
  setup_service
  open_firewall
  health_check
}

install_or_repair

proto="$([[ $USE_SSL -eq 1 ]] && echo https || echo http)"
host="${DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
url="${proto}://${host}:${WEB_PORT}"
[[ "$WEB_PORT" == "443" && "$proto" == "https" ]] && url="https://${host}"
[[ "$WEB_PORT" == "80" && "$proto" == "http" ]] && url="http://${host}"
printf '\n\033[1;32m部署完成\033[0m\n访问地址: %s\n实际监听端口: %s\n' "$url" "$WEB_PORT"
if [[ "$WEB_PORT" != "80" && "$WEB_PORT" != "443" ]]; then printf '80/443: 未使用、未停止、未删除、未重配。\n'; fi
printf '更新命令: 在新版上传目录执行 sudo bash update.sh\n修复命令: sudo bash %s/deploy.sh --repair\n日志: %s\n' "$APP_DIR" "$LOG_FILE"
