"""策略 ID → 审核记录 ID。"""

from __future__ import annotations

from .approve_proxy import proxy_post
from .constants import (
    APPROVE_QUERY_PATH,
    RESOLVE_STATUS_ORDER,
    TARGET_TO_QUERY_STATUS,
)

# 单页条数；翻页上限防止死循环
_PAGE_SIZE = 100
_MAX_PAGES = 30


def _extract_records(resp_data):
    if not resp_data:
        return []
    data = resp_data.get("data") or {}
    if isinstance(data, dict):
        return data.get("data") or []
    return []


def _extract_total(resp_data, page_len):
    if not resp_data:
        return page_len
    data = resp_data.get("data") or {}
    if not isinstance(data, dict):
        return page_len
    for key in ("totalCount", "total", "count"):
        val = data.get(key)
        if val is not None:
            try:
                return int(val)
            except (TypeError, ValueError):
                pass
    return page_len


def _find_in_records(records, strategy_id):
    sid = int(strategy_id)
    for r in records or []:
        try:
            if int(r.get("ruleId")) == sid:
                return r.get("id")
        except (TypeError, ValueError):
            if r.get("ruleId") == sid:
                return r.get("id")
    return None


def _query_approve_page(status_val, page_num, page_size, creator_id=None, rule_id=None):
    payload = {
        "pager": {"pageNum": int(page_num), "pageSize": int(page_size)},
        "status": int(status_val),
    }
    if creator_id is not None:
        payload["creatorId"] = int(creator_id)
    if rule_id is not None:
        payload["ruleId"] = int(rule_id)
    return proxy_post(APPROVE_QUERY_PATH, payload)


def resolve_approve_id(strategy_id, approve_status=None, creator_id=None):
    """返回 (approve_id, error_msg)。

    - 优先带 creatorId（缩小范围，避免全站首页 100 条漏单）
    - 尝试 ruleId 直查；失败则按 status 翻页直到匹配
    """
    sid = int(strategy_id)

    def _search_status(status_val):
        # 1) 若平台支持 ruleId 过滤，优先直查
        resp, err = _query_approve_page(
            status_val, 1, _PAGE_SIZE, creator_id=creator_id, rule_id=sid
        )
        if not err:
            hit = _find_in_records(_extract_records(resp), sid)
            if hit is not None:
                return hit, None
            # 直查无命中且无分页必要：若返回空且带了 ruleId，继续走无 ruleId 翻页兜底

        # 2) 翻页扫描（可带 creatorId）
        page = 1
        while page <= _MAX_PAGES:
            resp, err = _query_approve_page(
                status_val, page, _PAGE_SIZE, creator_id=creator_id, rule_id=None
            )
            if err:
                if page == 1:
                    return None, f"查询审核记录失败: {err}"
                break
            records = _extract_records(resp)
            hit = _find_in_records(records, sid)
            if hit is not None:
                return hit, None
            total = _extract_total(resp, len(records))
            if not records or page * _PAGE_SIZE >= total:
                break
            page += 1
        return None, None

    if approve_status is not None:
        approve_id, err = _search_status(approve_status)
        if approve_id is not None:
            return approve_id, None
        if err:
            return None, err
        return None, f"策略 #{sid} 在审核状态 {approve_status} 下未找到审核记录"

    last_err = None
    for status_val in RESOLVE_STATUS_ORDER:
        approve_id, err = _search_status(status_val)
        if approve_id is not None:
            return approve_id, None
        if err:
            last_err = err
            continue

    return None, last_err or f"策略 #{sid} 未找到审核记录（可能未提交审核）"


def query_status_for_target(target_status):
    return TARGET_TO_QUERY_STATUS.get(int(target_status))


def change_approve_status(
    strategy_id, target_status, reason="", creator_id=None, approve_id=None, confirm=False
):
    """策略 ID → resolve → approve/changeStatus。

    approve_id 若已由列表查询得到可直接传入，避免二次全站反查。
    creator_id 用于缩小 approve/query 范围。
    confirm=True：二次确认（封禁期「是否确认提交审核」场景）。

    Returns dict: {ok, error, message, data, approve_id}
    """
    from .constants import APPROVE_CHANGE_PATH
    from .approve_proxy import check_orient_ok

    target = int(target_status)
    resolve_err = None
    if approve_id is None:
        q_status = query_status_for_target(target)
        approve_id, resolve_err = resolve_approve_id(
            strategy_id, q_status, creator_id=creator_id
        )
        if approve_id is None:
            approve_id, resolve_err = resolve_approve_id(
                strategy_id, creator_id=creator_id
            )
    if approve_id is None:
        return {
            "ok": False,
            "error": "APPROVE_NOT_FOUND",
            "message": resolve_err or f"策略 #{strategy_id} 未找到审核记录（可能未提交审核）",
            "data": None,
            "approve_id": None,
        }

    payload = {"id": int(approve_id), "status": target, "reason": reason or ""}
    # 封禁期二次确认：body + query 双带，兼容 Orient 不同入口读法
    path = APPROVE_CHANGE_PATH
    if confirm:
        payload["confirm"] = True
        path = f"{APPROVE_CHANGE_PATH}?confirm=true"
    print(
        f"[strategy_audit] changeStatus strategy={strategy_id} → "
        f"approve={approve_id} status={target} creatorId={creator_id}"
        f"{' confirm=1' if confirm else ''}"
    )
    resp, err = proxy_post(path, payload)
    if err == "COOKIE_EXPIRED":
        return {
            "ok": False,
            "error": "COOKIE_EXPIRED",
            "message": "Orient 未登录",
            "data": None,
            "approve_id": approve_id,
        }
    if err and resp is None:
        return {
            "ok": False,
            "error": err,
            "message": err,
            "data": None,
            "approve_id": approve_id,
        }

    ok, msg = check_orient_ok(resp)
    if ok:
        return {
            "ok": True,
            "error": None,
            "message": None,
            "data": resp,
            "approve_id": approve_id,
        }
    return {
        "ok": False,
        "error": "ORIENT_FAILED",
        "message": msg,
        "data": resp,
        "approve_id": approve_id,
    }


def query_by_creator(creator_id, status_val, page_size=100, max_pages=_MAX_PAGES):
    """按提交人拉取某审核状态下的全部记录（自动翻页）。"""
    all_records = []
    page = 1
    last_resp = None
    last_err = None
    while page <= max_pages:
        payload = {
            "pager": {"pageNum": page, "pageSize": int(page_size)},
            "status": int(status_val),
            "creatorId": int(creator_id),
        }
        resp, err = proxy_post(APPROVE_QUERY_PATH, payload)
        last_resp, last_err = resp, err
        if err:
            if page == 1:
                return None, err
            break
        records = _extract_records(resp)
        all_records.extend(records)
        total = _extract_total(resp, len(records))
        if not records or page * page_size >= total:
            break
        page += 1

    if last_err and not all_records:
        return None, last_err

    # 合成与单页相同的壳，供调用方取 data.data
    if isinstance(last_resp, dict):
        wrapped = dict(last_resp)
        data = dict(wrapped.get("data") or {})
        data["data"] = all_records
        data["totalCount"] = len(all_records)
        wrapped["data"] = data
        return wrapped, None
    return {"status": 200, "data": {"data": all_records, "totalCount": len(all_records)}}, None
