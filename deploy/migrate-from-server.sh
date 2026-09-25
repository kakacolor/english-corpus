#!/bin/bash
# ============================================================================
# migrate-from-server.sh — 从【旧服务器】把 english-corpus 所需内容全部下载到本地
#
# 所有连接信息都来自项目根目录 .env 的 OLD_SERVER_* / DB_NAME，
# 不需要修改本脚本。
#
# 前置条件：
#   1) 本机装有 plink/pscp（PuTTY 系），或 OpenSSH ssh/scp
#   2) .env 里填好 OLD_SERVER_HOST / USER / PASS 等
#   3) 本地已有本项目源码
#
# 下载到 ./downloaded/ ：
#   - <DB_NAME>.<时间戳>.sql  数据库完整逻辑备份（mysqldump，含数据）
#   - server.env              旧服务器上的 .env（密钥/连接串，迁移必需）
#   - web/                    旧服务器正在服务的 Web 静态站
#   - src/                    旧服务器后端源码
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "找不到 $ENV_FILE，请先从 .env.example 复制并填写：cp .env.example .env" >&2
  exit 1
fi

env_get() {
  local key="$1" def="${2:-}" val
  val="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//")"
  val="${val%$'\r'}"
  val="$(printf '%s' "$val" | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/")"
  val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+$//')"
  printf '%s' "${val:-$def}"
}

HOST="$(env_get OLD_SERVER_HOST)"
USER="$(env_get OLD_SERVER_USER root)"
PORT="$(env_get OLD_SERVER_SSH_PORT 22)"
PASS="$(env_get OLD_SERVER_PASS)"
HOSTKEY="$(env_get OLD_SERVER_HOSTKEY)"
MYSQL_CONTAINER="$(env_get OLD_SERVER_DB_CONTAINER)"
MYSQL_ROOT_PASS="$(env_get OLD_SERVER_DB_ROOT_PASSWORD)"
REMOTE_DIR="$(env_get OLD_SERVER_APP_DIR /opt/english-corpus)"
DB_NAME="$(env_get DB_NAME english_corpus)"
OUT="${OUT:-downloaded}"

if [ -z "$HOST" ] || [ -z "$PASS" ]; then
  echo ".env 里未设置 OLD_SERVER_HOST / OLD_SERVER_PASS，无法连接旧服务器。" >&2
  echo "请在 .env 的「旧服务器」段填写后重试。" >&2
  exit 1
fi
if [ -z "$MYSQL_CONTAINER" ] || [ -z "$MYSQL_ROOT_PASS" ]; then
  echo "提示：未配置 OLD_SERVER_DB_CONTAINER / OLD_SERVER_DB_ROOT_PASSWORD，将跳过数据库备份。" >&2
fi

# plink/pscp 支持 -pw 传密码；未配置 hostkey 时不传 -hostkey（改用 known_hosts / 交互确认）
SCP=(pscp -pw "$PASS")
SSH=(plink -pw "$PASS" -ssh)
if [ -n "$HOSTKEY" ]; then
  SCP=(pscp -hostkey "$HOSTKEY" -pw "$PASS")
  SSH=(plink -hostkey "$HOSTKEY" -pw "$PASS" -ssh)
fi

mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "=== 1/4 数据库完整逻辑备份 -> $OUT/$DB_NAME.$STAMP.sql ==="
if [ -n "$MYSQL_CONTAINER" ] && [ -n "$MYSQL_ROOT_PASS" ]; then
  "${SSH[@]}" "$USER@$HOST" \
    "docker exec -e MYSQL_PWD='$MYSQL_ROOT_PASS' $MYSQL_CONTAINER mysqldump -uroot --routines --triggers --single-transaction $DB_NAME" \
    > "$OUT/$DB_NAME.$STAMP.sql"
  wc -l "$OUT/$DB_NAME.$STAMP.sql"
else
  echo "已跳过（未配置旧服务器的数据库容器/root 密码）"
fi

echo "=== 2/4 下载旧服务器 .env -> $OUT/server.env ==="
"${SCP[@]}" "$USER@$HOST:$REMOTE_DIR/.env" "$OUT/server.env"
echo "已下载 $(wc -c < "$OUT/server.env") 字节 .env（含 DB 密码/JWT/AI 加密密钥）"

echo "=== 3/4 下载旧服务器 Web 构建产物 -> $OUT/web/ ==="
"${SSH[@]}" "$USER@$HOST" "cd $REMOTE_DIR/web && tar -cf - ." | tar -xf - -C "$OUT"
ls "$OUT/web/_expo/static/js/web/" 2>/dev/null || true

echo "=== 4/4 拉取后端源码 -> $OUT/src/ ==="
"${SSH[@]}" "$USER@$HOST" "cd $REMOTE_DIR/src && tar -cf - ." | tar -xf - -C "$OUT"
ls "$OUT/src" | head

echo ""
echo "==================== 迁移包就绪 ===================="
echo "产物在 ./$OUT/ 下："
echo "  - $OUT/$DB_NAME.$STAMP.sql   数据库逻辑备份（含全部数据）"
echo "  - $OUT/server.env           旧服务器环境变量（含全部密钥）"
echo "  - $OUT/web/                 旧服务器正在服务的 Web 静态站"
echo "  - $OUT/src/                 旧服务器后端源码"
echo ""
echo "下一步（在新服务器上）："
echo "  1) 拷贝本项目到 .env 里 APP_DIR 指定的目录"
echo "  2) 填写 .env（SERVER_HOST 等）"
echo "  3) bash db/setup-db.sh            # 建库建账号"
echo "  4) mysql ... < 备份.sql           # 还原数据"
echo "  5) npm install && npm run migrate # 安装依赖并建表"
echo "  6) cd app && npm run build:web    # 构建前端，产物放后端 web/"
echo "  7) sudo bash deploy/install-service.sh   # 安装并启动 systemd 服务"
echo "===================================================="
