#!/bin/bash
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3001
PID_FILE="$PROJECT_DIR/.staging.pid"
LOG_FILE="$PROJECT_DIR/staging.log"
CHECK_INTERVAL=30
export ORIENT_SESSION_DIR="$PROJECT_DIR/server/orient_session_staging"
export PORT

is_alive() { lsof -i :$PORT -sTCP:LISTEN 2>/dev/null | grep -q "Python"; }
get_pid() { lsof -i :$PORT -sTCP:LISTEN 2>/dev/null | grep "Python" | awk '{print $2}' | head -1; }

start_srv() {
    echo "🚀 启动测试环境 (端口 $PORT)…"
    cd "$PROJECT_DIR"
    > "$LOG_FILE" 2>/dev/null
    /usr/bin/python3 -u "$PROJECT_DIR/server/app.py" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "  测试服务 PID=$pid"
    local w=0
    while [ $w -lt 30 ]; do
        if is_alive; then echo "  ✓ 测试环境就绪 (http://localhost:$PORT)"; return 0; fi
        sleep 2; w=$((w+2))
    done
    echo "  ✗ 启动超时"; return 1
}

stop_srv() {
    [ -f "$PID_FILE" ] && { kill $(cat "$PID_FILE") 2>/dev/null; rm -f "$PID_FILE"; }
    local p=$(get_pid)
    [ -n "$p" ] && { kill "$p" 2>/dev/null; pkill -9 -f "orient_session_staging" 2>/dev/null; }
    echo "测试环境已停止"
}

case "${1:-}" in
    stop)    stop_srv ;;
    status)  is_alive && echo "测试: 运行中 (http://localhost:$PORT)" || echo "测试: 未运行"; echo "生产: http://localhost:3000" ;;
    restart) local p=$(get_pid); [ -n "$p" ] && { pkill -9 -f "orient_session_staging" 2>/dev/null; sleep 2; kill "$p" 2>/dev/null; sleep 3; }; start_srv ;;
    *)       start_srv ;;
esac
