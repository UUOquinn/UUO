#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  联盟诊断工作台 — 守护脚本（生产唯一入口）
#
#  写死约定：在本仓库 Documents 目录运行，端口 3000。
#  标准启动：bash scripts/start-production.sh
#           （内部 = nohup bash guardian.sh run）
#  不要用 LaunchAgent / Application Support。
#
#  功能：
#    1. 自动检测服务是否存活（每 30 秒）
#    2. 服务挂掉 → 自动清理残留进程 → 重启服务
#    3. 日志输出到 guardian.log
#
#  使用方式：
#    生产保活：  bash guardian.sh run          # 或 scripts/start-production.sh
#    后台 fork： bash guardian.sh              # 兼容旧用法
#    停止守护：  bash guardian.sh stop
#    查看状态：  bash guardian.sh status
# ═══════════════════════════════════════════════════════════════

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
PID_FILE="$PROJECT_DIR/.guardian.pid"
LOG_FILE="$PROJECT_DIR/guardian.log"
CHECK_INTERVAL=30  # 秒

# ─── 环境变量传递给 Python ───
export ORIENT_SESSION_DIR="${ORIENT_SESSION_DIR:-$PROJECT_DIR/server/orient_session}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"

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

# ─── 清理残留 Playwright Chrome（仅本会话目录，禁止全局 pkill）───
cleanup_chrome() {
    local session_dir="${ORIENT_SESSION_DIR:-$PROJECT_DIR/server/orient_session}"
    local pid
    local matched=0
    local killed=0
    local round

    for round in 1 2 3 4 5; do
        matched=0
        killed=0
        for pid in $(pgrep -f "user-data-dir=${session_dir}" 2>/dev/null || true); do
            matched=$((matched + 1))
            if kill -9 "$pid" 2>/dev/null; then
                killed=$((killed + 1))
            fi
        done
        if [ "$matched" -eq 0 ]; then
            break
        fi
        if [ "$round" -eq 1 ]; then
            log_warn "发现本会话 Playwright Chrome，正在清理（$session_dir）…"
        fi
        sleep 1
    done

    if [ "$killed" -gt 0 ] || [ "$matched" -gt 0 ]; then
        log_ok "本会话 Chrome 已清理"
    fi

    # 清单例锁，避免下一次窗口抢 profile 秒退
    /usr/bin/python3 - "$session_dir" <<'PY' 2>/dev/null || true
import os, sys
session = sys.argv[1]
for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
    path = os.path.join(session, name)
    if os.path.lexists(path):
        try:
            os.unlink(path)
        except OSError:
            pass
PY
}

# ─── 启动服务 ───
start_server() {
    log "正在启动服务…"
    cd "$PROJECT_DIR"

    # 先清理本会话残留 Chrome（不碰其他项目的 Chrome for Testing）
    cleanup_chrome

    # 追加分隔线，保留历史日志便于排查闪退
    {
        echo ""
        echo "──────── $(date '+%Y-%m-%d %H:%M:%S') server start ────────"
    } >> "$LOG_FILE" 2>/dev/null || true

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

    # 杀掉现有服务进程（同时清理本会话 Chrome，避免用户数据目录冲突）
    local pid
    pid=$(get_server_pid)
    if [ -n "$pid" ]; then
        cleanup_chrome
        sleep 1
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

    # 再清一次本会话残留
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

    # Playwright 状态（按本会话 user-data-dir 探测，避免误报）
    local session_dir="${ORIENT_SESSION_DIR:-$PROJECT_DIR/server/orient_session}"
    local chrome_count
    chrome_count=$(pgrep -f "user-data-dir=${session_dir}" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${chrome_count:-0}" -gt 0 ]; then
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

    # 服务在、守护无时的补拉提示
    if is_server_alive; then
        local g_ok=0
        if [ -f "$PID_FILE" ]; then
            local gpid2
            gpid2=$(cat "$PID_FILE")
            if kill -0 "$gpid2" 2>/dev/null; then
                g_ok=1
            fi
        fi
        if [ "$g_ok" -eq 0 ]; then
            echo -e "  ${YELLOW}提示: 服务在跑但守护未启动，长期保活请执行:${NC}"
            echo "    bash $PROJECT_DIR/scripts/start-production.sh"
            echo "    （已健康时会跳过重启并补拉 guardian）"
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
    run|foreground)
        # 生产标准：前台保活（配合 nohup / 终端常驻），不 fork
        echo "$$" > "$PID_FILE"
        trap 'rm -f "$PID_FILE"; exit 0' INT TERM EXIT
        guard_loop
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
