#!/bin/bash
# 将当前生产代码目录同步到测试侧，并仅重启 :3001。
# 硬约束：全程不停止、不重启、不清理生产 :3000 / orient_session。
set -euo pipefail
PROD_DIR="/Users/wqy/Documents/skills/alliance-advertiser-funnel-web"
TEST_MIRROR="/Users/wqy/Documents/MyFilcker/alliance-advertiser-funnel-web"
STAGING_PORT=3001

assert_prod() {
  local code
  code=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000/" 2>/dev/null || echo 000)
  if [ "$code" != "200" ]; then
    echo "ABORT: 生产 :3000 不可用 (http=$code)，已中止同步/重启测试" >&2
    exit 1
  fi
}

echo "== 1) 确认生产 =="
assert_prod
echo "生产 :3000 OK"

echo "== 2) 代码镜像到测试目录 MyFilcker（不影响运行中的 :3000）=="
mkdir -p "$TEST_MIRROR"
# 不用 --delete，避免误删测试侧独有数据；排除会话/日志/pid
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'server/orient_session/' \
  --exclude 'server/orient_session_*/' \
  --exclude 'server/orient_session_*' \
  --exclude '.guardian.pid' \
  --exclude '.staging.pid' \
  --exclude '.staging2.pid' \
  --exclude '*.log' \
  --exclude 'guardian-launchd.log' \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '.codeflicker/' \
  "$PROD_DIR/" "$TEST_MIRROR/"
assert_prod
echo "镜像完成，生产仍 OK"

echo "== 3) Restart test port ${STAGING_PORT} only =="
# 只杀 3001 监听进程
for p in $(lsof -nP -iTCP:"${STAGING_PORT}" -sTCP:LISTEN -t 2>/dev/null || true); do
  echo "stop staging pid=$p"
  kill "$p" 2>/dev/null || true
done
sleep 2
for p in $(lsof -nP -iTCP:"${STAGING_PORT}" -sTCP:LISTEN -t 2>/dev/null || true); do
  kill -9 "$p" 2>/dev/null || true
done
# 只清 staging session 锁 / 对应 Chrome（路径必须含 orient_session_staging，绝不碰生产 orient_session）
pkill -9 -f "user-data-dir=${PROD_DIR}/server/orient_session_staging" 2>/dev/null || true
rm -f "$PROD_DIR/server/orient_session_staging/SingletonLock" \
      "$PROD_DIR/server/orient_session_staging/SingletonSocket" \
      "$PROD_DIR/server/orient_session_staging/SingletonCookie" 2>/dev/null || true
assert_prod

# 双 fork 启动测试，脱离当前 shell
/usr/bin/python3 <<PY
import os, sys, time
project = r"$PROD_DIR"
port = "${STAGING_PORT}"
log = os.path.join(project, "staging.log")
if os.fork() > 0:
    time.sleep(0.2)
    sys.exit(0)
os.chdir(project)
os.setsid()
if os.fork() > 0:
    sys.exit(0)
os.environ["PORT"] = port
os.environ["ORIENT_SESSION_DIR"] = os.path.join(project, "server/orient_session_staging")
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.expanduser("~/Library/Caches/ms-playwright"))
devnull = open(os.devnull, "r")
logf = open(log, "a", buffering=1)
os.dup2(devnull.fileno(), 0)
os.dup2(logf.fileno(), 1)
os.dup2(logf.fileno(), 2)
os.execv("/usr/bin/python3", ["python3", "-u", os.path.join(project, "server/app.py")])
PY

# 父进程拿不到子 pid，用端口回写
for i in $(seq 1 40); do
  assert_prod
  if lsof -nP -iTCP:"${STAGING_PORT}" -sTCP:LISTEN 2>/dev/null | grep -q Python; then
    code=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STAGING_PORT}/" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
      pid=$(lsof -nP -iTCP:"${STAGING_PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1)
      echo "$pid" > "$PROD_DIR/.staging.pid"
      echo "test ready :${STAGING_PORT} (pid=$pid)"
      break
    fi
  fi
  echo "waiting staging i=$i"
  sleep 3
done

assert_prod
echo "== done =="
echo "prod: http://172.23.174.173:3000/  $(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)"
echo "test: http://172.23.174.173:3001/  $(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/ || echo fail)"
curl -sS -m 5 "http://127.0.0.1:3000/api/cookie/status" || true
echo
