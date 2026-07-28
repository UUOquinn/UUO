#!/bin/bash
# 生产启动（唯一标准，写死）：Documents 仓库 + guardian.sh run，端口 3000
# 请在 macOS「终端.app」执行；不要用 LaunchAgent / Application Support。
set -euo pipefail

ROOT="/Users/wqy/Documents/skills/alliance-advertiser-funnel-web"
PORT="${PORT:-3000}"
export PORT
export ORIENT_SESSION_DIR="${ORIENT_SESSION_DIR:-$ROOT/server/orient_session}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:${PATH:-}"

cd "$ROOT" || exit 1
chmod +x "$ROOT/guardian.sh" 2>/dev/null || true

# 双重 fork 拉起 guardian.sh run（不杀现有 app.py）
daemonize_guardian() {
  /usr/bin/python3 - <<PY
import os
root = r"""$ROOT"""
log_path = os.path.join(root, "guardian.log")
guardian = os.path.join(root, "guardian.sh")

def _daemonize_and_exec():
    if os.fork() > 0:
        return
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir(root)
    os.environ["PORT"] = os.environ.get("PORT", "3000")
    os.environ["ORIENT_SESSION_DIR"] = os.environ.get(
        "ORIENT_SESSION_DIR", os.path.join(root, "server", "orient_session")
    )
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = os.environ.get(
        "PLAYWRIGHT_BROWSERS_PATH",
        os.path.expanduser("~/Library/Caches/ms-playwright"),
    )
    devnull = open("/dev/null", "r")
    logf = open(log_path, "a", buffering=1)
    os.dup2(devnull.fileno(), 0)
    os.dup2(logf.fileno(), 1)
    os.dup2(logf.fileno(), 2)
    os.execv("/bin/bash", ["bash", guardian, "run"])

_daemonize_and_exec()
PY
}

# 守护存活则复用；否则补拉（服务已在时只监控、不重启）
ensure_guardian_running() {
  local gpid=""
  if [ -f "$ROOT/.guardian.pid" ]; then
    gpid=$(cat "$ROOT/.guardian.pid" 2>/dev/null || true)
    if [ -n "$gpid" ] && kill -0 "$gpid" 2>/dev/null; then
      echo "守护进程已在运行 (PID=$gpid)"
      return 0
    fi
    rm -f "$ROOT/.guardian.pid"
  fi
  echo "guardian not running, starting guardian.sh run (keep :$PORT)"
  daemonize_guardian
  sleep 2
  if [ -f "$ROOT/.guardian.pid" ] && kill -0 "$(cat "$ROOT/.guardian.pid")" 2>/dev/null; then
    echo "guardian started (PID=$(cat "$ROOT/.guardian.pid"))"
    return 0
  fi
  echo "WARN: failed to start guardian, see $ROOT/guardian.log" >&2
  return 1
}

# 已健康则不重启 app，但仍确保 guardian 在跑
if curl -sS -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '^200$'; then
  if curl -sS -m 3 "http://127.0.0.1:$PORT/api/cookie/status" 2>/dev/null | grep -q '"playwrightReady": true'; then
    echo "生产 :$PORT 已在运行，跳过重启（避免 Playwright 闪退）"
    echo "  本机: http://127.0.0.1:$PORT/"
    echo "  内网: http://172.23.174.173:$PORT/"
    ensure_guardian_running || true
    bash "$ROOT/guardian.sh" status 2>/dev/null || true
    exit 0
  fi
fi

# 停掉旧守护（本目录）
if [ -x "$ROOT/guardian.sh" ]; then
  bash "$ROOT/guardian.sh" stop 2>/dev/null || true
fi
rm -f "$ROOT/.guardian.pid"

# 释放 3000（仅杀本仓库 app.py）
for pid in $(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *"$ROOT/server/app.py"*|*server/app.py*) kill "$pid" 2>/dev/null || true ;;
  esac
done

# 等本会话 Chrome 退干净 + 清锁，避免新窗口抢 profile 秒退
SESSION_DIR="$ORIENT_SESSION_DIR"
for _ in 1 2 3 4 5 6 7 8; do
  left=0
  left=$(pgrep -f "user-data-dir=${SESSION_DIR}" 2>/dev/null | wc -l | tr -d ' ' || true)
  if [ "${left:-0}" -eq 0 ]; then
    break
  fi
  for p in $(pgrep -f "user-data-dir=${SESSION_DIR}" 2>/dev/null || true); do
    kill -9 "$p" 2>/dev/null || true
  done
  sleep 1
done
/usr/bin/python3 - <<PY || true
import os
session = os.environ.get("ORIENT_SESSION_DIR", "")
for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
    path = os.path.join(session, name)
    if os.path.lexists(path):
        try:
            os.unlink(path)
        except OSError:
            pass
PY
sleep 1

daemonize_guardian
echo "guardian run 已后台脱离启动"
sleep 5

if curl -sS -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" | grep -q '^200$'; then
  echo "生产 :$PORT 已就绪 → http://127.0.0.1:$PORT/ （内网 http://172.23.174.173:$PORT/）"
else
  echo "启动中或异常，请查看: $ROOT/guardian.log" >&2
  bash "$ROOT/guardian.sh" status 2>/dev/null || true
fi

echo "状态: bash $ROOT/guardian.sh status"
echo "停止: bash $ROOT/guardian.sh stop"
