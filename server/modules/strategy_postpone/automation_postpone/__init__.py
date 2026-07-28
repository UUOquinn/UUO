"""
automation_postpone — 表驱动自动延期

能力：
  - 托管表 postpone_registry.json（策略 ID 粒度）
  - 编辑权限 postpone_editors.json（admins / editors）
  - 默认每天 09:00 定点扫描；剩余 ≤7 个自然日（含当天/已过期）则定向 mergeEditV2
"""

from .registry import (
    load_registry,
    upsert_item,
    delete_item,
    load_editors,
    upsert_editor,
    delete_editor,
    get_operator_perms,
)
from .daemon import (
    get_status as get_postpone_status,
    run_once as run_postpone_once,
    start_daemon as start_postpone_daemon,
    POSTPONE_INTERVAL,
    POSTPONE_HOUR,
    POSTPONE_MINUTE,
)

__all__ = [
    "load_registry",
    "upsert_item",
    "delete_item",
    "load_editors",
    "upsert_editor",
    "delete_editor",
    "get_operator_perms",
    "get_postpone_status",
    "run_postpone_once",
    "start_postpone_daemon",
    "POSTPONE_INTERVAL",
    "POSTPONE_HOUR",
    "POSTPONE_MINUTE",
]
