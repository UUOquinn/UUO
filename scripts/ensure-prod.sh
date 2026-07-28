#!/bin/bash
# 只检查生产 :3000 是否可用，不启动服务（启动请在 macOS「终端.app」执行 start-production.sh）
set -euo pipefail
PORT=3000
ROOT="/Users/wqy/Documents/skills/alliance-advertiser-funnel-web"

is_prod_up() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q Python
}

http_ok() {
  curl -sS -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '^200$'
}

if is_prod_up && http_ok; then
  echo "生产 :$PORT 正常（Documents + guardian.sh）"
  exit 0
fi

echo "生产 :$PORT 不可用。" >&2
echo "" >&2
echo "请在 macOS「终端.app」执行：" >&2
echo "  bash \"$ROOT/scripts/start-production.sh\"" >&2
echo "" >&2
echo "或：" >&2
echo "  cd \"$ROOT\" && bash guardian.sh status" >&2
exit 1
