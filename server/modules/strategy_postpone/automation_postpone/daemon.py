"""自动延期守护线程：每天固定时刻扫描（默认 09:00）。"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from .runner import run_scan

# 兼容旧环境变量；定点模式下以 POSTPONE_HOUR 为准
POSTPONE_INTERVAL = int(os.environ.get("POSTPONE_INTERVAL", "86400"))
POSTPONE_HOUR = int(os.environ.get("POSTPONE_HOUR", "9"))  # 每天几点（0-23）
POSTPONE_MINUTE = int(os.environ.get("POSTPONE_MINUTE", "0"))

_log: List[str] = []
_running = False
_last_result: Optional[Dict[str, Any]] = None
_lock = threading.Lock()
_started = False


def _log_add(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    _log.append(f"[{ts}] {msg}")
    if len(_log) > 100:
        _log.pop(0)
    print(f"[postpone-auto] {msg}")
    try:
        from modules.workbench_log import append as _wb_append

        _wb_append("postpone", f"[{ts}] {msg}", operator="system:postpone-auto")
    except Exception as e:
        print(f"[postpone-auto] persist log failed: {e}")


def _next_run_at(now: Optional[datetime] = None) -> datetime:
    """计算下一次扫描时刻（本机本地时区）。若已过今天的定点，则排到明天。"""
    now = now or datetime.now()
    hour = max(0, min(23, POSTPONE_HOUR))
    minute = max(0, min(59, POSTPONE_MINUTE))
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if now >= target:
        target = target + timedelta(days=1)
    return target


def seconds_until_next_run(now: Optional[datetime] = None) -> float:
    target = _next_run_at(now)
    now = now or datetime.now()
    return max(1.0, (target - now).total_seconds())


def get_status() -> Dict[str, Any]:
    from .runner import DUE_WITHIN_DAYS

    now = datetime.now()
    nxt = _next_run_at(now)
    return {
        "running": _running,
        "interval": POSTPONE_INTERVAL,
        "intervalDays": 1.0,
        "schedule": f"每天 {POSTPONE_HOUR:02d}:{POSTPONE_MINUTE:02d}",
        "scheduleHour": POSTPONE_HOUR,
        "scheduleMinute": POSTPONE_MINUTE,
        "nextRunAt": nxt.strftime("%Y-%m-%d %H:%M:%S"),
        "secondsUntilNext": int(seconds_until_next_run(now)),
        "dueWithinDays": DUE_WITHIN_DAYS,
        "lastResult": _last_result,
        "log": list(_log[-40:]),
        "started": _started,
    }


def run_once() -> Dict[str, Any]:
    global _running, _last_result
    with _lock:
        if _running:
            _log_add("上一次自动延期仍在执行，跳过")
            return {"skipped": True, "reason": "already_running"}
        _running = True
    try:
        result = run_scan(log_fn=_log_add)
        _last_result = result
        return result
    except Exception as e:
        _log_add(f"自动延期异常: {e}")
        _last_result = {"error": str(e)}
        return _last_result
    finally:
        _running = False


def _daemon_loop() -> None:
    _log_add(
        f"自动延期守护线程已启动（每天 {POSTPONE_HOUR:02d}:{POSTPONE_MINUTE:02d} 定点扫描，"
        f"剩余≤窗口自然日则延期）"
    )
    # 启动后稍等，避免与自动审核抢登录
    time.sleep(15)
    while True:
        wait_s = seconds_until_next_run()
        nxt = _next_run_at()
        _log_add(
            f"下一次扫描：{nxt.strftime('%Y-%m-%d %H:%M:%S')} "
            f"（约 {int(wait_s // 3600)} 小时 {int((wait_s % 3600) // 60)} 分后）"
        )
        # 分段 sleep，便于进程重启时尽快退出；最长每 10 分钟醒一次重算
        deadline = time.time() + wait_s
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                break
            time.sleep(min(remain, 600))
        try:
            run_once()
        except Exception as e:
            _log_add(f"守护线程异常: {e}")


def start_daemon() -> None:
    global _started
    if _started:
        return
    t = threading.Thread(target=_daemon_loop, daemon=True, name="postpone-auto-daemon")
    t.start()
    _started = True
