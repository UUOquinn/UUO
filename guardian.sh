#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  联盟诊断工作台 — 守护脚本
#
#  功能：
#    1. 自动检测服务是否存活（每 30 秒）
#    2. 服务挂掉 → 自动清理残留进程 → 重启服务
#    3. 日志输出到 guardian.log
#
#  使用方式：
#    启动守护：  bash guardian.sh
#    后台运行：  nohup bash guardian.sh > /dev/null 2>&1 &
#    停止守护：  bash guardian.sh stop
#    查看状态：  bash guardian.sh status
# ═══════════════════════════════════════════════════════════════

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=${1:-3000}
PID_FILE="$PROJECT_DIR/.guardian.pid"
LOG_FILE="$PROJECT_DIR/guardian.log"
CHECK_INTERVAL=30  # 秒

# ─── 环境变量传递给 Python ───
export ORIENT_SESSION_DIR="$PROJECT_DIR/server/orient_session"

# ─── 颜色 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() {
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts] $1" >> "$LOG_FILE"
    echo -e "${CYAN}[$ts]${NC} $1"
}

log_ok()   { log "${GREEN}✓ $1${NC}"; }
log_warn() { log "${YELLOW}⚠ $1${NC}"; }
log_err()  { log "${RED}✗ $1${NC}"; }

# ─── 检查服务是否存活 ───
is_server_alive() {
    lsof -i :$PORT -sTCP:LISTEN 2>/dev/null | grep -q "Python"
}

# ─── 获取服务进程 PID ───
get_server_pid() {
    lsof -i :$PORT -sTCP:LISTEN 2>/dev/null | grep "Python" | awk '{print $2}' | head -1
}

# ─── 清理残留 Playwright Chrome 进程 ───
cleanup_chrome() {
    local count
    count=$(ps aux | grep "chrome-mac-arm64/Google Chrome for Testing" | grep -v grep | wc -l | tr -d ' ')
    if [ "$count" -gt 0 ]; then
        log_warn "发现 $count 个残留 Playwright Chrome 进程，正在清理…"
        pkill -9 -f "chrome-mac-arm64/Google Chrome for Testing" 2>/dev/null
        sleep 2
        local count2
        count2=$(ps aux | grep "chrome-mac-arm64/Google Chrome for Testing" | grep -v grep | wc -l | tr -d ' ')
        if [ "$count2" -gt 0 ]; then
            log_err "仍有 $count2 个 Chrome 进程未清理"
        else
            log_ok "残留 Chrome 进程已清理"
        fi
    fi
}

# ─── 启动服务 ───
start_server() {
    log "正在启动服务…"
    cd "$PROJECT_DIR"

    # 先清理残留
    cleanup_chrome

    # 清理旧日志
    > "$LOG_FILE" 2>/dev/null

    # 启动服务（unbuffered 输出）
    /usr/bin/python3 -u "$PROJECT_DIR/server/app.py" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    log "服务进程已启动 (PID=$pid)"

    # 等待服务就绪
    local waited=0
    while [ $waited -lt 30 ]; do
        if is_server_alive; then
            log_ok "服务已就绪 (端口 $PORT)"
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done

    log_err "服务启动超时（30秒）"
    return 1
}

# ─── 重启服务 ───
restart_server() {
    log "正在重启服务…"

    # 杀掉现有服务进程（同时杀掉其子 Chrome 进程）
    local pid
    pid=$(get_server_pid)
    if [ -n "$pid" ]; then
        # 先杀 Chrome 子进程（避免"正在现有的浏览器会话中打开"冲突）
        pkill -9 -f "chrome-mac-arm64/Google Chrome for Testing" 2>/dev/null
        sleep 2
        # 再杀服务进程
        kill "$pid" 2>/dev/null
        log "已发送终止信号到进程 $pid"
        sleep 3
    fi

    # 确认已停止
    if is_server_alive; then
        local pid2
        pid2=$(get_server_pid)
        kill -9 "$pid2" 2>/dev/null
        log "强制终止进程 $pid2"
        sleep 2
    fi

    # 清理残留
    cleanup_chrome

    # 启动
    start_server
}

# ─── 守护循环 ───
guard_loop() {
    log "═══════════════════════════════════════"
    log "联盟诊断工作台守护进程已启动"
    log "服务目录: $PROJECT_DIR"
    log "监听端口: $PORT"
    log "检查间隔: ${CHECK_INTERVAL}秒"
    log "日志文件: $LOG_FILE"
    log "═══════════════════════════════════════"

    # 首次启动
    if ! is_server_alive; then
        log "服务未运行，首次启动…"
        start_server
        if [ $? -ne 0 ]; then
            log_err "首次启动失败，5分钟后重试"
            sleep 300
        fi
    else
        log_ok "服务已在运行中 (端口 $PORT)"
    fi

    # 守护循环
    while true; do
        sleep $CHECK_INTERVAL

        if is_server_alive; then
            # 服务正常，不做任何事
            :
        else
            log_warn "检测到服务已停止，正在自动重启…"
            restart_server

            if is_server_alive; then
                log_ok "服务自动重启成功"
            else
                log_err "服务自动重启失败，60秒后重试"
                sleep 60
            fi
        fi
    done
}

# ─── 停止守护 ───
stop_guardian() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            log_ok "守护进程已停止 (PID=$pid)"
        else
            log "守护进程已不在运行"
        fi
        rm -f "$PID_FILE"
    else
        log "未找到守护进程 PID 文件"
    fi
}

# ─── 查看状态 ───
show_status() {
    echo "═══════════════════════════════════════"
    echo " 联盟诊断工作台 — 状态"
    echo "═══════════════════════════════════════"

    # 服务状态
    if is_server_alive; then
        local pid
        pid=$(get_server_pid)
        echo -e "  服务进程: ${GREEN}运行中${NC} (PID=$pid, 端口 $PORT)"
    else
        echo -e "  服务进程: ${RED}未运行${NC}"
    fi

    # 守护进程状态
    if [ -f "$PID_FILE" ]; then
        local gpid
        gpid=$(cat "$PID_FILE")
        if kill -0 "$gpid" 2>/dev/null; then
            echo -e "  守护进程: ${GREEN}运行中${NC} (PID=$gpid)"
        else
            echo -e "  守护进程: ${RED}已停止${NC} (PID文件残留)"
        fi
    else
        echo -e "  守护进程: ${YELLOW}未启动${NC}"
    fi

    # Playwright 状态
    local chrome_count
    chrome_count=$(ps aux | grep "chrome-mac-arm64/Google Chrome for Testing" | grep -v grep | wc -l | tr -d ' ')
    if [ "$chrome_count" -gt 0 ]; then
        echo -e "  Playwright 浏览器: ${GREEN}运行中${NC} ($chrome_count 进程)"
    else
        echo -e "  Playwright 浏览器: ${YELLOW}未启动${NC}"
    fi

    # Cookie 状态（如果服务在运行）
    if is_server_alive; then
        local source
        source=$(curl -s http://localhost:$PORT/api/cookie/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('source','unknown'))" 2>/dev/null)
        if [ "$source" = "playwright" ]; then
            echo -e "  请求模式: ${GREEN}Playwright API 代理（Cookie 自动续期）${NC}"
        elif [ "$source" = "playwright-needs-login" ]; then
            echo -e "  请求模式: ${YELLOW}Playwright 需要登录 SSO${NC}"
        elif [ -n "$source" ]; then
            echo -e "  请求模式: $source"
        fi
    fi

    echo "═══════════════════════════════════════"
}

# ─── 主入口 ───
case "${1:-}" in
    stop)
        stop_guardian
        ;;
    status)
        show_status
        ;;
    restart)
        if is_server_alive; then
            restart_server
        else
            start_server
        fi
        ;;
    *)
        # 防止重复启动
        if [ -f "$PID_FILE" ]; then
            old_pid=$(cat "$PID_FILE")
            if kill -0 "$old_pid" 2>/dev/null; then
                echo "守护进程已在运行 (PID=$old_pid)"
                echo "如需重启，请先执行: bash guardian.sh stop"
                exit 1
            fi
        fi

        # 启动守护（后台）
        (
            guard_loop
        ) &

        guardian_pid=$!
        echo "$guardian_pid" > "$PID_FILE"
        echo "守护进程已启动 (PID=$guardian_pid)"
        echo "  查看状态: bash guardian.sh status"
        echo "  停止守护: bash guardian.sh stop"
        echo "  日志文件: $LOG_FILE"

        # 等几秒看是否成功
        sleep 5
        if is_server_alive; then
            echo -e "  服务状态: ${GREEN}运行中${NC} ✓"
        else
            echo -e "  服务状态: ${YELLOW}启动中…请稍后查看${NC}"
        fi
        ;;
esac
