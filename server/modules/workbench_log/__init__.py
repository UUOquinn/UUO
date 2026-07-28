"""共享工作台日志：JSONL 持久化，最长保留 30 天，全员可见。"""

from .store import (
    LOG_TYPES,
    KEEP_DAYS,
    DEFAULT_LIMIT,
    append,
    list_logs,
    prune_all,
    clear_logs,
    delete_logs,
)

__all__ = [
    "LOG_TYPES",
    "KEEP_DAYS",
    "DEFAULT_LIMIT",
    "append",
    "list_logs",
    "prune_all",
    "clear_logs",
    "delete_logs",
]
