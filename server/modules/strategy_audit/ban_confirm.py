"""封禁期二次确认文案识别（同意发布 / 立即推全共用）。"""

from __future__ import annotations


def is_ban_period_confirm(message) -> bool:
    """Orient 弹窗：配置时段处于封禁期，需确认提交审核（非硬失败）。"""
    msg = str(message or "")
    if "封禁期" not in msg:
        return False
    return "是否确认" in msg or "需要进行人工审核" in msg
