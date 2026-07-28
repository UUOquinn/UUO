"""审核编排：普通两步+条件推全；封禁期通过+条件推全；卡在 6 的发布补跑。"""

from __future__ import annotations

import time

from .ban_confirm import is_ban_period_confirm
from .ban_period import ban_pass
from .constants import (
    CHECK_PASS,
    CHECK_TO_PUBLISH_DELAY,
    PUBLISH_BACKOFF_CAP,
    PUBLISH_PASS,
    PUBLISH_RETRY_INTERVAL,
    PUBLISH_RETRY_TIMES,
    PUSH_POLL_INTERVAL,
    PUSH_POLL_TIMES,
)
from .push_full import maybe_push_full
from .resolve import change_approve_status


def _push_status(push):
    if not push:
        return None
    if push.get("skipped"):
        return "skipped"
    if push.get("reason") == "ban_audit_submitted":
        return "ban_submitted"
    if push.get("ok"):
        return "pushed"
    return "failed"


def _publish_backoff_seconds(attempt, base_interval):
    """attempt 从 0 起；退避 1x, 2x, 3x… 上限 PUBLISH_BACKOFF_CAP。"""
    return min(float(PUBLISH_BACKOFF_CAP), float(base_interval) * (attempt + 1))


def _publish_blocked_but_grey_ready(message):
    """Orient 拒绝 6→2，但策略可能已进灰度且推全按钮已亮（#24059 类）。"""
    msg = str(message or "")
    return "无法应用于状态[审核成功]" in msg and "发布成功" in msg


def run_publish_and_push(
    strategy_id,
    reason_prefix="",
    creator_id=None,
    approve_id=None,
    publish_retries=None,
    publish_retry_interval=None,
    push_poll_times=None,
    push_poll_interval=None,
):
    """同意发布（6→2，退避重试）→ 条件立即推全。

    供 normal 第二段与自动审 status=6 / 内存卡单补跑共用。
    若 6→2 被拒但审核单内嵌/详情已亮立即推全，仍尝试推全（灰度旁路）。
    """
    sid = int(strategy_id)
    steps = []
    retries = PUBLISH_RETRY_TIMES if publish_retries is None else max(1, int(publish_retries))
    base_interval = (
        PUBLISH_RETRY_INTERVAL
        if publish_retry_interval is None
        else max(0.0, float(publish_retry_interval))
    )
    poll_times = PUSH_POLL_TIMES if push_poll_times is None else max(1, int(push_poll_times))
    poll_interval = (
        PUSH_POLL_INTERVAL if push_poll_interval is None else max(0.0, float(push_poll_interval))
    )

    r2 = None
    ban_confirm_tried = False
    for attempt in range(retries):
        r2 = change_approve_status(
            sid,
            PUBLISH_PASS,
            reason=f"{reason_prefix}同意发布".strip() or "同意发布",
            creator_id=creator_id,
            approve_id=approve_id,
            confirm=ban_confirm_tried,
        )
        r2 = dict(r2)
        r2["attempt"] = attempt + 1
        r2["confirm"] = ban_confirm_tried
        if r2.get("ok"):
            break
        # 已是发布成功：视为可继续推全（人工已发布 / 重复补跑）
        msg = str(r2.get("message") or "")
        if "无法应用于状态[发布成功]" in msg:
            r2["ok"] = True
            r2["alreadyPublished"] = True
            print(
                f"[strategy_audit] publish_pass treat as done "
                f"(already 发布成功) strategy={sid} approve={approve_id}"
            )
            break
        # 封禁期二次确认：自动再提一次 confirm=true（白名单审视为已确认）
        if is_ban_period_confirm(msg) and not ban_confirm_tried:
            ban_confirm_tried = True
            print(
                f"[strategy_audit] ban-period confirm prompt; "
                f"retry publish with confirm strategy={sid} approve={approve_id}"
            )
            continue
        if is_ban_period_confirm(msg) and ban_confirm_tried:
            # 确认后仍返回同一提示：不重试、不入卡单
            break
        if attempt < retries - 1:
            wait = _publish_backoff_seconds(attempt, base_interval)
            print(
                f"[strategy_audit] publish_pass retry "
                f"strategy={sid} attempt={attempt + 1}/{retries}, wait {wait}s"
            )
            time.sleep(wait)

    steps.append({"step": "publish_pass", **(r2 or {})})
    publish_ok = bool(r2 and r2.get("ok"))
    aid = (r2 or {}).get("approve_id") or approve_id
    bypass_publish = False
    ban_confirm_pending = bool(
        r2 and not publish_ok and is_ban_period_confirm(r2.get("message"))
    )

    if not publish_ok:
        if ban_confirm_pending:
            # 审核已成功；同意发布卡在封禁期确认。策略侧常已生效中，勿当硬失败入卡单。
            return {
                "ok": True,
                "mode": "publish_replay",
                "steps": steps,
                "push": None,
                "auditOk": True,
                "publishOk": False,
                "publishBypassed": False,
                "pushStatus": None,
                "stuckAt": None,
                "skipStuckQueue": True,
                "banPublishConfirm": True,
                "approve_id": aid,
            }
        # 发布被拒：若推全按钮已亮（常见于已进灰度），仍尝试推全，避免卡死
        if r2 and _publish_blocked_but_grey_ready(r2.get("message")):
            print(
                f"[strategy_audit] publish blocked at 审核成功; "
                f"try quickPush anyway strategy={sid} approve={aid}"
            )
            bypass_publish = True
        else:
            return {
                "ok": False,
                "mode": "publish_replay",
                "steps": steps,
                "push": None,
                "auditOk": True,
                "publishOk": False,
                "publishBypassed": False,
                "pushStatus": None,
                "stuckAt": CHECK_PASS,
                "approve_id": aid,
            }

    time.sleep(0.1)
    push = maybe_push_full(
        sid,
        mode="normal",
        poll_times=poll_times,
        poll_interval=poll_interval,
        approve_id=aid,
    )
    steps.append({"step": "quick_push", **push})

    push_status = _push_status(push)
    ban_push_pending = bool(
        push
        and not push.get("ok")
        and not push.get("skipped")
        and (
            push.get("reason") == "ban_push_confirm_pending"
            or is_ban_period_confirm(push.get("message"))
        )
    )
    ban_submitted = push_status == "ban_submitted"

    # 旁路：发布未成功，但推全已执行成功 / 已提交封禁期审核 → 整体 ok
    if bypass_publish:
        pushed = push_status in ("pushed", "ban_submitted")
        if ban_push_pending:
            return {
                "ok": True,
                "mode": "publish_replay",
                "steps": steps,
                "push": push,
                "pushSkipped": bool(push.get("skipped")),
                "auditOk": True,
                "publishOk": False,
                "publishBypassed": True,
                "pushStatus": push_status,
                "stuckAt": None,
                "skipStuckQueue": True,
                "banPushConfirm": True,
                "approve_id": aid,
            }
        return {
            "ok": pushed,
            "mode": "publish_replay",
            "steps": steps,
            "push": push,
            "pushSkipped": bool(push.get("skipped")),
            "auditOk": True,
            "publishOk": False,
            "publishBypassed": True,
            "pushStatus": push_status,
            "stuckAt": None if pushed else CHECK_PASS,
            "approve_id": aid,
        }

    if ban_push_pending:
        return {
            "ok": True,
            "mode": "publish_replay",
            "steps": steps,
            "push": push,
            "pushSkipped": bool(push.get("skipped")),
            "auditOk": True,
            "publishOk": True,
            "publishBypassed": False,
            "pushStatus": push_status,
            "stuckAt": None,
            "skipStuckQueue": True,
            "banPushConfirm": True,
            "approve_id": aid,
        }

    return {
        "ok": True,
        "mode": "publish_replay",
        "steps": steps,
        "push": push,
        "pushSkipped": bool(push.get("skipped")),
        "auditOk": True,
        "publishOk": True,
        "publishBypassed": False,
        "pushStatus": push_status,
        "stuckAt": None,
        "banAuditSubmitted": ban_submitted,
        "approve_id": aid,
    }


def run_normal_flow(strategy_id, reason_prefix="", creator_id=None, approve_id=None):
    """审核通过 → 同意发布 → 可推全则立即推全。"""
    sid = int(strategy_id)
    steps = []

    r1 = change_approve_status(
        sid,
        CHECK_PASS,
        reason=f"{reason_prefix}审核通过".strip() or "审核通过",
        creator_id=creator_id,
        approve_id=approve_id,
    )
    steps.append({"step": "check_pass", **r1})
    if not r1.get("ok"):
        return {
            "ok": False,
            "mode": "normal",
            "steps": steps,
            "push": None,
            "auditOk": False,
            "publishOk": False,
            "pushStatus": None,
            "stuckAt": None,
            "approve_id": r1.get("approve_id") or approve_id,
        }

    time.sleep(CHECK_TO_PUBLISH_DELAY)

    next_approve_id = r1.get("approve_id") or approve_id
    pub = run_publish_and_push(
        sid,
        reason_prefix=reason_prefix,
        creator_id=creator_id,
        approve_id=next_approve_id,
    )
    steps.extend(pub.get("steps") or [])
    return {
        "ok": bool(pub.get("ok")),
        "mode": "normal",
        "steps": steps,
        "push": pub.get("push"),
        "pushSkipped": pub.get("pushSkipped"),
        "auditOk": True,
        "publishOk": bool(pub.get("publishOk")),
        "publishBypassed": bool(pub.get("publishBypassed")),
        "pushStatus": pub.get("pushStatus"),
        "stuckAt": pub.get("stuckAt"),
        "skipStuckQueue": bool(pub.get("skipStuckQueue")),
        "banPublishConfirm": bool(pub.get("banPublishConfirm")),
        "banPushConfirm": bool(pub.get("banPushConfirm")),
        "banAuditSubmitted": bool(pub.get("banAuditSubmitted")),
        "approve_id": pub.get("approve_id") or next_approve_id,
    }


def run_ban_flow(strategy_id, reason_prefix="", creator_id=None, approve_id=None):
    """封禁期审核通过 → 可推全则封禁期立即推全。不自动驳回。"""
    sid = int(strategy_id)
    steps = []

    r1 = ban_pass(
        sid,
        reason=f"{reason_prefix}封禁期审核通过".strip() or "封禁期审核通过",
        creator_id=creator_id,
        approve_id=approve_id,
    )
    steps.append({"step": "ban_pass", **r1})
    if not r1.get("ok"):
        return {
            "ok": False,
            "mode": "ban",
            "steps": steps,
            "push": None,
            "auditOk": False,
            "publishOk": False,
            "pushStatus": None,
            "stuckAt": None,
            "approve_id": r1.get("approve_id") or approve_id,
        }

    time.sleep(0.1)
    push = maybe_push_full(
        sid, mode="ban", poll_times=PUSH_POLL_TIMES, poll_interval=PUSH_POLL_INTERVAL
    )
    steps.append({"step": "ban_quick_push", **push})
    return {
        "ok": True,
        "mode": "ban",
        "steps": steps,
        "push": push,
        "pushSkipped": bool(push.get("skipped")),
        "auditOk": True,
        "publishOk": True,
        "pushStatus": _push_status(push),
        "stuckAt": None,
        "approve_id": r1.get("approve_id") or approve_id,
    }


def run_flow(strategy_id, mode="normal", reason_prefix="", creator_id=None, approve_id=None):
    if mode == "ban":
        return run_ban_flow(
            strategy_id,
            reason_prefix=reason_prefix,
            creator_id=creator_id,
            approve_id=approve_id,
        )
    if mode == "publish_replay":
        return run_publish_and_push(
            strategy_id,
            reason_prefix=reason_prefix,
            creator_id=creator_id,
            approve_id=approve_id,
        )
    return run_normal_flow(
        strategy_id,
        reason_prefix=reason_prefix,
        creator_id=creator_id,
        approve_id=approve_id,
    )
