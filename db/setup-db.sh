#!/usr/bin/env bash
# ============================================================================
# setup-db.sh — 按项目根目录 .env 的配置创建数据库与专用账号（幂等）
#
# 迁移到新服务器后不需要改任何 SQL 文件：库名/账号/密码全部取自 .env。
#
# 用法（在服务器上执行）：
#   sudo bash db/setup-db.sh
#
# 说明：
#   - 需要 .env 里设置 DB_ROOT_PASSWORD（MySQL 的 root 密码）
#   - 若 .env 设置了 DB_CONTAINER_NAME 且宿主机有 docker，则用 docker exec 进入容器执行；
#     否则使用宿主机的 mysql 客户端连接 DB_HOST:DB_PORT
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "找不到 $ENV_FILE，请先从 .env.example 复制并填写：cp .env.example .env" >&2
  exit 1
fi

# 读取 .env 中某个键的值（忽略注释行与空行，去掉首尾空白和可选引号）
env_get() {
  local key="$1" def="${2:-}" val
  val="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//")"
  val="${val%$'\r'}"
  val="$(printf '%s' "$val" | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/")"
  val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+$//')"
  printf '%s' "${val:-$def}"
}

DB_HOST="$(env_get DB_HOST 127.0.0.1)"
DB_PORT="$(env_get DB_PORT 3306)"
DB_NAME="$(env_get DB_NAME english_corpus)"
DB_USER="$(env_get DB_USER english_user)"
DB_PASSWORD="$(env_get DB_PASSWORD)"
DB_ROOT_PASSWORD="$(env_get DB_ROOT_PASSWORD)"
DB_CONTAINER_NAME="$(env_get DB_CONTAINER_NAME)"

if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ]; then
  echo ".env 里的 DB_NAME / DB_USER / DB_PASSWORD 不能为空" >&2
  exit 1
fi
if [ -z "$DB_ROOT_PASSWORD" ]; then
  echo ".env 里未设置 DB_ROOT_PASSWORD（MySQL root 密码），无法建库建账号。" >&2
  echo "如需以 root 身份免密登录，可临时改用：mysql -uroot < 下面的 SQL" >&2
  exit 1
fi

# 密码里的单引号需要转义（SQL 中用两个单引号表示一个）
pw_sql="$(printf '%s' "$DB_PASSWORD" | sed "s/'/''/g")"

SQL="$(cat <<SQL_END
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${pw_sql}';
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY '${pw_sql}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${pw_sql}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${pw_sql}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL_END
)"

echo "数据库   = $DB_NAME"
echo "专用账号 = $DB_USER"
echo "连接地址 = $DB_HOST:$DB_PORT"
if [ -n "$DB_CONTAINER_NAME" ]; then
  echo "执行方式 = docker exec $DB_CONTAINER_NAME"
else
  echo "执行方式 = 本机 mysql 客户端"
fi
echo

if [ -n "$DB_CONTAINER_NAME" ] && command -v docker >/dev/null 2>&1; then
  # 用 MYSQL_PWD 传密码，避免出现在命令行/进程列表里
  printf '%s\n' "$SQL" | docker exec -i -e MYSQL_PWD="$DB_ROOT_PASSWORD" "$DB_CONTAINER_NAME" mysql -uroot
else
  if ! command -v mysql >/dev/null 2>&1; then
    echo "本机没有 mysql 客户端。请安装 mysql-client，或在 .env 里设置 DB_CONTAINER_NAME 使用 docker。" >&2
    exit 1
  fi
  printf '%s\n' "$SQL" | MYSQL_PWD="$DB_ROOT_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -uroot
fi

echo
echo "=== 校验 ==="
VERIFY="SELECT COUNT(*) AS tables_in_db FROM information_schema.tables WHERE table_schema='${DB_NAME}';"
if [ -n "$DB_CONTAINER_NAME" ] && command -v docker >/dev/null 2>&1; then
  docker exec -i -e MYSQL_PWD="$DB_ROOT_PASSWORD" "$DB_CONTAINER_NAME" mysql -uroot -e "$VERIFY"
else
  MYSQL_PWD="$DB_ROOT_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -uroot -e "$VERIFY"
fi

echo
echo "库与账号已就绪。表结构请在后端目录执行： npm run migrate"
