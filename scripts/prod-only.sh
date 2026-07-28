#!/bin/bash
# 只保留生产 :3000（Documents）；关闭测试端口等占用。不碰 LaunchAgent。
set -euo pipefail
PROD=/Users/wqy/Documents/skills/alliance-advertiser-funnel-web

for port in 3001 3002 3003 8080; do
  for p in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true); do
    echo "stop port $port pid=$p"
    kill -9 "$p" 2>/dev/null || true
  done
done

# 非 3000 的本项目 app.py
pgrep -f "$PROD/server/app.py" 2>/dev/null | while read -r p; do
  if lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | grep -qx "$p"; then
    continue
  fi
  echo "kill extra app.py $p"
  kill -9 "$p" 2>/dev/null || true
done

pkill -9 -f "user-data-dir=${PROD}/server/orient_session_staging" 2>/dev/null || true
pkill -9 -f "user-data-dir=${PROD}/server/orient_session_staging2" 2>/dev/null || true

echo "done prod-only cleanup（生产守护请用 Documents guardian.sh run）"
