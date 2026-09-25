#!/usr/bin/env bash
# ============================================================================
# install-service.sh — 从项目根目录 .env 生成并安装 systemd 服务
#
# 迁移到新服务器后，只要改好 .env（APP_DIR / SERVICE_NAME / RUN_USER / NODE_BIN），
# 在本脚本所在项目的根目录执行一次即可，无需手工改 systemd 单元里的路径。
#
# 用法（在服务器上以 root 执行）：
#   sudo bash deploy/install-service.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
TEMPLATE="$SCRIPT_DIR/english-corpus.service.template"

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 执行：sudo bash deploy/install-service.sh" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "找不到 $ENV_FILE，请先从 .env.example 复制并填写：cp .env.example .env" >&2
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "找不到模板 $TEMPLATE" >&2
  exit 1
fi

# 读取 .env 中某个键的值（忽略注释行与空行，去掉首尾空白和可选引号）
env_get() {
  local key="$1" def="${2:-}" val
  val="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//")"
  val="${val%$'\r'}"                                                     # 去掉 Windows 换行残留
  val="$(printf '%s' "$val" | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/")" # 去掉引号
  val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+$//')"               # 去掉尾部空白
  printf '%s' "${val:-$def}"
}

APP_DIR="$(env_get APP_DIR)"
SERVICE_NAME="$(env_get SERVICE_NAME english-corpus)"
RUN_USER="$(env_get RUN_USER root)"
NODE_BIN="$(env_get NODE_BIN)"

if [ -z "$APP_DIR" ]; then
  echo ".env 里的 APP_DIR 为空，请填写项目在服务器上的绝对路径" >&2
  exit 1
fi
if [ ! -d "$APP_DIR" ]; then
  echo "警告：APP_DIR=$APP_DIR 不存在（若项目不在该路径，请修改 .env 的 APP_DIR）" >&2
fi

# node 路径：.env 未指定时自动探测
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到可用的 node（当前值：'$NODE_BIN'）。请安装 Node 或在 .env 里设置 NODE_BIN" >&2
  exit 1
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

echo "APP_DIR      = $APP_DIR"
echo "SERVICE_NAME = $SERVICE_NAME"
echo "RUN_USER     = $RUN_USER"
echo "NODE_BIN     = $NODE_BIN"
echo "单元文件     = $UNIT_PATH"
echo

# 用 .env 的值渲染模板
sed -e "s|@APP_DIR@|$APP_DIR|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@RUN_USER@|$RUN_USER|g" \
    -e "s|@SERVICE_NAME@|$SERVICE_NAME|g" \
    "$TEMPLATE" > "$UNIT_PATH"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2

echo
echo "=== 服务状态 ==="
systemctl status "$SERVICE_NAME" --no-pager -l | head -20 || true
echo
echo "=== 健康检查 ==="
PORT="$(env_get SERVER_PORT 3000)"
curl -s -m 10 "http://127.0.0.1:${PORT}/api/health" || echo "(健康检查失败，请查看：journalctl -u ${SERVICE_NAME} -n 50)"
echo
echo "安装完成。查看日志：journalctl -u ${SERVICE_NAME} -f"
