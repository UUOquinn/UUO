"""封禁期审核动作（12→13/14）。"""

from __future__ import annotations

from .constants import BAN_CHECK_FAIL, BAN_CHECK_PASS, BAN_WAIT_CHECK
from .resolve import change_approve_status


def ban_pass(strategy_id, reason="封禁期审核通过", creator_id=None, approve_id=None):
    return change_approve_status(
        strategy_id,
        BAN_CHECK_PASS,
        reason=reason,
        creator_id=creator_id,
        approve_id=approve_id,
    )


def ban_reject(strategy_id, reason="封禁期审核驳回", creator_id=None, approve_id=None):
    return change_approve_status(
        strategy_id,
        BAN_CHECK_FAIL,
        reason=reason,
        creator_id=creator_id,
        approve_id=approve_id,
    )


def is_ban_wait_status(status_val):
    return int(status_val) == BAN_WAIT_CHECK
