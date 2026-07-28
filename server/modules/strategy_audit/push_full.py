"""立即推全 / 封禁期立即推全 — Operation quickPushAll 契约。"""

from __future__ import annotations

import time

from modules.strategy_probe import STRATEGY_API_PREFIXES, has_strategy_data

from .approve_proxy import check_orient_ok, proxy_get, proxy_post, proxy_post_query
from .ban_confirm import is_ban_period_confirm
from .constants import (
    APPROVE_QUERY_PATH,
    FLAG_BAN_QUICK_PUSH,
    FLAG_QUICK_PUSH,
    QUICK_PUSH_BAN,
    QUICK_PUSH_BAN_SUBMIT,
    QUICK_PUSH_NORMAL,
    QUICK_PUSH_PREFIXES,
)

# approve/query 内嵌策略体字段 → api_prefix
_EMBED_PREFIXES = (
    ("flowControl", "flowControl"),
    ("orientControl", "orientControl"),
    ("darkControl", "darkControl"),
    ("mediaControl", "mediaControl"),
)


def _lift_toolbar_flags(data):
    """把 toolBar 下的推全标志提升到顶层（原地修改）。"""
    if not isinstance(data, dict):
        return data
    toolbar = data.get("toolBar")
    if isinstance(toolbar, dict):
        for flag in (FLAG_QUICK_PUSH, FLAG_BAN_QUICK_PUSH, "displayPushBtn"):
            if data.get(flag) is None and flag in toolbar:
                data[flag] = toolbar.get(flag)
    return data


def _approve_embed_for_strategy(strategy_id, approve_id=None):
    """从 approve/query 取内嵌策略体。

    真源现象（2026-07-22 #24059）：flowControl/get 的 toolBar 可能为空，
    但审核单内嵌 flowControl.toolBar.displayQuickPushBtn=true。
    Returns (embed_dict_or_None, api_prefix_or_None, approve_record_or_None).
    """
    sid = int(strategy_id)
    payload = {"pager": {"pageNum": 1, "pageSize": 5}}
    if approve_id is not None:
        payload["id"] = int(approve_id)
    else:
        payload["ruleId"] = sid
    resp, err = proxy_post(APPROVE_QUERY_PATH, payload)
    if err or not resp:
        return None, None, None
    data = resp.get("data") if isinstance(resp, dict) else None
    records = []
    if isinstance(data, dict):
        records = data.get("data") or []
    if not isinstance(records, list) or not records:
        return None, None, None

    rec = None
    if approve_id is not None:
        rec = records[0]
    else:
        for r in records:
            if int(r.get("ruleId") or 0) == sid:
                rec = r
                break
        if rec is None:
            rec = records[0]

    for embed_key, api_prefix in _EMBED_PREFIXES:
        embed = rec.get(embed_key) if isinstance(rec, dict) else None
        if isinstance(embed, dict) and embed.get("id") is not None:
            return dict(embed), api_prefix, rec
    return None, None, rec


def merge_push_flags_from_approve(detail, strategy_id, approve_id=None):
    """若 get 详情缺少推全标志，用审核单内嵌 toolBar 补齐。"""
    if not isinstance(detail, dict):
        return detail, None
    need = detail.get(FLAG_QUICK_PUSH) is None and detail.get(FLAG_BAN_QUICK_PUSH) is None
    toolbar = detail.get("toolBar")
    if isinstance(toolbar, dict) and (
        toolbar.get(FLAG_QUICK_PUSH) is not None or toolbar.get(FLAG_BAN_QUICK_PUSH) is not None
    ):
        need = False
    if not need:
        return detail, None

    embed, embed_prefix, _rec = _approve_embed_for_strategy(strategy_id, approve_id=approve_id)
    if not embed:
        return detail, None
    etb = embed.get("toolBar")
    if isinstance(etb, dict):
        detail = dict(detail)
        if not isinstance(detail.get("toolBar"), dict):
            detail["toolBar"] = dict(etb)
        else:
            merged = dict(detail["toolBar"])
            for k, v in etb.items():
                if merged.get(k) is None and v is not None:
                    merged[k] = v
            detail["toolBar"] = merged
        _lift_toolbar_flags(detail)
        detail["_pushFlagsFrom"] = "approve_embed"
        if embed_prefix and not detail.get("_apiPrefix"):
            detail["_apiPrefix"] = embed_prefix
        return detail, embed_prefix
    return detail, None


def get_strategy_detail(strategy_id, approve_id=None):
    """探测策略类型并返回 (detail_dict, api_prefix, error)。

    detail_dict 为内层 data（含按钮标志位）；api_prefix 如 orientControl。
    若 get 无 toolBar，会尝试用 approve 内嵌标志补齐。
    """
    sid = int(strategy_id)
    for api_prefix, type_label in STRATEGY_API_PREFIXES:
        path = f"/{api_prefix}/get?id={sid}"
        resp, err = proxy_get(path)
        if err == "COOKIE_EXPIRED":
            return None, None, "COOKIE_EXPIRED"
        if err or not resp:
            continue
        ok, _ = check_orient_ok(resp)
        if not ok or not has_strategy_data(resp):
            continue
        data = resp.get("data") if isinstance(resp.get("data"), dict) else resp
        if isinstance(data, dict):
            data = dict(data)
            data["_strategyType"] = type_label
            data["_apiPrefix"] = api_prefix
            _lift_toolbar_flags(data)
            data, embed_prefix = merge_push_flags_from_approve(
                data, sid, approve_id=approve_id
            )
            if embed_prefix and not data.get("_apiPrefix"):
                data["_apiPrefix"] = embed_prefix
        return data, api_prefix, None
    return None, None, f"策略 #{sid} 未找到"


def can_quick_push(detail, mode="normal"):
    """mode: normal | ban。依据详情按钮标志位。"""
    if not detail or not isinstance(detail, dict):
        return False
    if mode == "ban":
        if bool(detail.get(FLAG_BAN_QUICK_PUSH)):
            return True
        toolbar = detail.get("toolBar")
        return bool(isinstance(toolbar, dict) and toolbar.get(FLAG_BAN_QUICK_PUSH))
    if bool(detail.get(FLAG_QUICK_PUSH)):
        return True
    toolbar = detail.get("toolBar")
    return bool(isinstance(toolbar, dict) and toolbar.get(FLAG_QUICK_PUSH))


def call_quick_push_all(strategy_id, api_prefix, push_type, confirm=False):
    """POST /{api_prefix}/quickPushAll?id=&type=[&confirm=true]

    Returns {ok, error, message, data, skipped}
    """
    if api_prefix not in QUICK_PUSH_PREFIXES:
        return {
            "ok": True,
            "skipped": True,
            "error": None,
            "message": f"{api_prefix} 不支持 quickPushAll，已跳过",
            "data": None,
        }

    path = f"/{api_prefix}/quickPushAll"
    params = {"id": int(strategy_id), "type": int(push_type)}
    if confirm:
        # 与同意发布二次确认同文案；quickPushAll 参数走 query
        params["confirm"] = "true"
    print(f"[strategy_audit] quickPushAll {path} params={params}")
    resp, err = proxy_post_query(path, params)
    if err == "COOKIE_EXPIRED":
        return {"ok": False, "skipped": False, "error": "COOKIE_EXPIRED", "message": "Orient 未登录", "data": None}
    if err and resp is None:
        return {"ok": False, "skipped": False, "error": err, "message": err, "data": None}

    ok, msg = check_orient_ok(resp)
    if ok:
        return {
            "ok": True,
            "skipped": False,
            "error": None,
            "message": None,
            "data": resp,
            "confirm": bool(confirm),
            "pushType": int(push_type),
        }
    return {
        "ok": False,
        "skipped": False,
        "error": "ORIENT_FAILED",
        "message": msg,
        "data": resp,
        "confirm": bool(confirm),
        "pushType": int(push_type),
    }


def _push_with_ban_confirm(strategy_id, api_prefix, mode):
    """普通/封禁推全；遇封禁期确认则自动 confirm，必要时改走 type=1 提交封禁期审批。"""
    primary = QUICK_PUSH_BAN if mode == "ban" else QUICK_PUSH_NORMAL
    result = call_quick_push_all(strategy_id, api_prefix, primary)
    if result.get("ok") or result.get("skipped"):
        return result
    if not is_ban_period_confirm(result.get("message")):
        return result

    print(
        f"[strategy_audit] ban-period confirm on push; "
        f"retry type={primary} confirm strategy={strategy_id}"
    )
    confirmed = call_quick_push_all(strategy_id, api_prefix, primary, confirm=True)
    confirmed["banConfirm"] = True
    if confirmed.get("ok") or confirmed.get("skipped"):
        return confirmed
    if not is_ban_period_confirm(confirmed.get("message")):
        return confirmed

    # 普通推全确认后仍要「提交审核」→ 显式走封禁期提交审批
    if mode == "normal" and primary != QUICK_PUSH_BAN_SUBMIT:
        print(
            f"[strategy_audit] ban-period push still pending; "
            f"try type={QUICK_PUSH_BAN_SUBMIT} confirm strategy={strategy_id}"
        )
        submitted = call_quick_push_all(
            strategy_id, api_prefix, QUICK_PUSH_BAN_SUBMIT, confirm=True
        )
        submitted["banConfirm"] = True
        if submitted.get("ok") and not submitted.get("skipped"):
            submitted["reason"] = "ban_audit_submitted"
            submitted["message"] = "已确认提交封禁期审核（待 status=12 队列）"
            return submitted
        if is_ban_period_confirm(submitted.get("message")):
            submitted["reason"] = "ban_push_confirm_pending"
        return submitted

    confirmed["reason"] = "ban_push_confirm_pending"
    return confirmed


def maybe_push_full(
    strategy_id, mode="normal", poll_times=3, poll_interval=2.0, approve_id=None
):
    """查询详情，若可推全则执行；否则短轮询标志位后再决定跳过。

    mode=normal → type=0；mode=ban → type=2
    poll_times: 含首次在内的尝试次数；仍 false 则记跳过（不算审核失败）
    approve_id: 可选；用于 get 无 toolBar 时从审核单内嵌补标志。
    """
    attempts = max(1, int(poll_times))
    interval = max(0.0, float(poll_interval))
    last_detail = None
    last_prefix = None
    last_err = None

    for i in range(attempts):
        detail, api_prefix, err = get_strategy_detail(
            strategy_id, approve_id=approve_id
        )
        last_detail, last_prefix, last_err = detail, api_prefix, err
        if err == "COOKIE_EXPIRED":
            return {
                "ok": False,
                "skipped": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录",
                "reason": "cookie",
            }
        if err or not detail:
            if i < attempts - 1:
                time.sleep(interval)
                continue
            return {
                "ok": True,
                "skipped": True,
                "error": None,
                "message": err or "无详情",
                "reason": "no_detail",
            }

        if can_quick_push(detail, mode=mode):
            result = _push_with_ban_confirm(strategy_id, api_prefix, mode)
            if result.get("ok") and not result.get("skipped"):
                if not result.get("reason"):
                    result["reason"] = "pushed"
            elif not result.get("reason"):
                result["reason"] = "push_failed"
            result["apiPrefix"] = api_prefix
            result["pollAttempt"] = i + 1
            if detail.get("_pushFlagsFrom"):
                result["pushFlagsFrom"] = detail.get("_pushFlagsFrom")
            return result

        if i < attempts - 1:
            print(
                f"[strategy_audit] quickPush flag not ready "
                f"strategy={strategy_id} attempt={i + 1}/{attempts}, wait {interval}s"
            )
            time.sleep(interval)

    flag = FLAG_BAN_QUICK_PUSH if mode == "ban" else FLAG_QUICK_PUSH
    return {
        "ok": True,
        "skipped": True,
        "error": None,
        "message": f"不能推全（{flag}=false，已当场轮询 {attempts} 次）",
        "reason": "flag_false",
        "apiPrefix": last_prefix,
        "status": (last_detail or {}).get("status") if isinstance(last_detail, dict) else None,
        "statusDesc": (last_detail or {}).get("statusDesc") if isinstance(last_detail, dict) else None,
        "pollAttempt": attempts,
    }


def push_full_forced(strategy_id, mode="normal"):
    """手动强制推全（不看标志位，仍需能探测到类型）。"""
    detail, api_prefix, err = get_strategy_detail(strategy_id)
    if err == "COOKIE_EXPIRED":
        return {"ok": False, "skipped": False, "error": "COOKIE_EXPIRED", "message": "Orient 未登录"}
    if err or not api_prefix:
        return {"ok": False, "skipped": False, "error": "NOT_FOUND", "message": err or "策略未找到"}
    return _push_with_ban_confirm(strategy_id, api_prefix, mode)
