"""
Operation 平台实时策略查询

主路径：POST /operation-tool/rest/orientControl/query
  - 与定向策略管理页「查询」同源
  - 分页壳对齐同平台 approve/query：pager.pageNum / pager.pageSize
  - 需 industryVersion（缺省 6.6）
明细补全：必要时 GET /orientControl/get?id=

鉴权：优先 cookie.json + urllib（快速）；失败再降级 orient_proxy。
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

_PW_BASE = "https://operation-tool.corp.kuaishou.com/operation-tool/rest"
_INDUSTRY_VERSION = "6.6"
_COOKIE_FILE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "cookie.json")
)

# 最近一次成功查询时间（供 UI 提示；非后台定时刷新）
_LAST_QUERY_META: Dict[str, Any] = {
    "dataAsOfText": "",
    "dataAsOf": "",
    "source": "operation-tool orientControl/query",
    "total": 0,
    "mode": "live",
}


def get_live_meta() -> Dict[str, Any]:
    return dict(_LAST_QUERY_META)


def _set_meta(total: int) -> Dict[str, Any]:
    now = datetime.now().astimezone()
    _LAST_QUERY_META.update(
        {
            "dataAsOfText": now.strftime("%Y-%m-%d %H:%M:%S"),
            "dataAsOf": now.isoformat(),
            "source": "operation-tool orientControl/query",
            "total": total,
            "mode": "live",
            "loadedAt": now.isoformat(),
        }
    )
    return get_live_meta()


def _load_cookie() -> str:
    if not os.path.exists(_COOKIE_FILE):
        return ""
    try:
        with open(_COOKIE_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        cookie = (cfg.get("kwabi") or "").strip()
        if not cookie or "请填写" in cookie:
            return ""
        # urllib Cookie 头必须 latin-1；含中文则跳过，走 Playwright/Chrome
        try:
            cookie.encode("latin-1")
        except UnicodeEncodeError:
            return ""
        return cookie
    except Exception:
        return ""


def _status_ok(resp: Optional[dict]) -> bool:
    if not isinstance(resp, dict):
        return False
    st = resp.get("status")
    return st == 200 or st == "200"


def _as_id(value: str) -> Any:
    """平台字段多为 Long；能转则转数字。"""
    s = str(value).strip()
    if s.isdigit():
        try:
            return int(s)
        except Exception:
            return s
    return s


def _extract_list(resp: dict) -> Tuple[List[dict], int]:
    """兼容多种分页壳（含 approve/query 的 data.data）。"""
    data = resp.get("data")
    if data is None:
        return [], 0
    if isinstance(data, list):
        return data, len(data)
    if not isinstance(data, dict):
        return [], 0
    for key in ("data", "list", "records", "rows", "items", "result"):
        val = data.get(key)
        if isinstance(val, list):
            total = (
                data.get("total")
                or data.get("totalCount")
                or data.get("totalElements")
                or len(val)
            )
            return val, int(total or 0)
    page = data.get("page") or data.get("pageInfo") or data.get("pager") or {}
    if isinstance(page, dict):
        for key in ("list", "records", "rows", "data"):
            val = page.get(key)
            if isinstance(val, list):
                total = page.get("total") or page.get("totalCount") or len(val)
                return val, int(total or 0)
    return [], 0


def _build_query_bodies(
    developer_ids: List[str],
    pos_ids: List[str],
    app_ids: List[str],
    page_no: int = 1,
    page_size: int = 50,
    status: Optional[int] = 4,
) -> List[dict]:
    """
    生成少量候选请求体（优先同平台 approve/query 的 pager 形状）。
    status: Orient 生效状态码；传 None 表示不按状态过滤。
    """
    pager = {"pageNum": page_no, "pageSize": page_size}
    filters: Dict[str, Any] = {}
    if len(developer_ids) == 1:
        filters["uid"] = _as_id(developer_ids[0])
    elif developer_ids:
        filters["uid"] = ";".join(developer_ids)
    if len(pos_ids) == 1:
        filters["posId"] = _as_id(pos_ids[0])
    elif pos_ids:
        filters["posId"] = ";".join(pos_ids)
    if len(app_ids) == 1:
        filters["appId"] = _as_id(app_ids[0])
    elif app_ids:
        filters["appId"] = ";".join(app_ids)

    def stamp(body: dict) -> dict:
        if status is not None:
            body = {**body, "status": status}
        return body

    candidates: List[dict] = []

    # A: 对齐 approve/query + industryVersion（最可能）
    candidates.append(
        stamp(
            {
                "pager": pager,
                "industryVersion": _INDUSTRY_VERSION,
                **filters,
            }
        )
    )

    # B: industryVersion 放在 adCluster（与 mergeEditV2 一致）
    candidates.append(
        stamp(
            {
                "pager": pager,
                "adCluster": {"industryVersion": _INDUSTRY_VERSION},
                **filters,
            }
        )
    )

    # C: 媒体维度嵌套
    media = {}
    if "uid" in filters:
        media["uid"] = filters["uid"]
    if "posId" in filters:
        media["posId"] = filters["posId"]
    if "appId" in filters:
        media["appId"] = filters["appId"]
    if media:
        candidates.append(
            stamp(
                {
                    "pager": pager,
                    "industryVersion": _INDUSTRY_VERSION,
                    "mediaCluster": media,
                }
            )
        )

    # D: mediaUid 别名（部分页面用此字段）
    if "uid" in filters:
        alias = dict(filters)
        alias["mediaUid"] = alias.pop("uid")
        candidates.append(
            stamp(
                {
                    "pager": pager,
                    "industryVersion": _INDUSTRY_VERSION,
                    **alias,
                }
            )
        )

    # E: currentPage 风格兜底
    candidates.append(
        stamp(
            {
                "industryVersion": _INDUSTRY_VERSION,
                "currentPage": page_no,
                "pageSize": page_size,
                **filters,
            }
        )
    )

    return candidates


def _urllib_post(url: str, body: dict, timeout: int = 25) -> Tuple[Optional[dict], Optional[str]]:
    cookie = _load_cookie()
    if not cookie:
        return None, "COOKIE_EXPIRED"
    try:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=raw,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Cookie": cookie,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
        if "<html" in text.lower()[:200] or "login" in text.lower()[:200]:
            return None, "COOKIE_EXPIRED"
        return json.loads(text), None
    except urllib.error.HTTPError as e:
        try:
            text = e.read().decode("utf-8", errors="replace")
            if text.strip().startswith("{"):
                return json.loads(text), None
        except Exception:
            pass
        if e.code in (401, 403):
            return None, "COOKIE_EXPIRED"
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)


def _urllib_get(url: str, timeout: int = 20) -> Tuple[Optional[dict], Optional[str]]:
    cookie = _load_cookie()
    if not cookie:
        return None, "COOKIE_EXPIRED"
    try:
        req = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "Cookie": cookie},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
        if "<html" in text.lower()[:200] or "login" in text.lower()[:200]:
            return None, "COOKIE_EXPIRED"
        return json.loads(text), None
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return None, "COOKIE_EXPIRED"
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)


def _orient_query_once(body: dict) -> Tuple[Optional[dict], Optional[str]]:
    url = f"{_PW_BASE}/orientControl/query"
    resp, err = _urllib_post(url, body)
    if resp is not None and (err is None or _status_ok(resp) or isinstance(resp.get("status"), (int, str))):
        # cookie.json 拿到业务 JSON（含失败业务码）直接返回，交给上层判断
        if err is None or resp.get("status") is not None:
            return resp, None

    # cookie 失效或 urllib 失败 → Playwright/Chrome（其他功能同会话，不动代理实现）
    try:
        from modules.strategy_postpone.automation_postpone.orient_proxy import (
            proxy_post,
        )

        return proxy_post(url, body)
    except Exception as e:
        if err == "COOKIE_EXPIRED":
            return None, "COOKIE_EXPIRED"
        return None, err or str(e)


def _orient_get_detail(strategy_id: int) -> Tuple[Optional[dict], Optional[str]]:
    url = f"{_PW_BASE}/orientControl/get?id={strategy_id}"
    resp, err = _urllib_get(url)
    if resp is not None and err is None:
        return resp, None
    try:
        from modules.strategy_postpone.automation_postpone.orient_proxy import (
            proxy_get,
        )

        return proxy_get(url)
    except Exception as e:
        if err == "COOKIE_EXPIRED":
            return None, "COOKIE_EXPIRED"
        return None, err or str(e)


def _to_row(item: dict, detail: Optional[dict] = None) -> dict:
    """Orient 对象 → 前端策略查询行（中文字段）。"""
    from .orient_fields import strategy_to_row

    return strategy_to_row(item, detail)


def _needs_hydrate(row: dict, item: Optional[dict] = None) -> bool:
    """列表缺规则/投放维度时需 get 补全（仅有 appId 不够）。"""
    from .orient_fields import needs_detail_hydrate

    return needs_detail_hydrate(row, item)


def _filter_row_matches(
    row: dict,
    developer_ids: List[str],
    pos_ids: List[str],
    app_ids: List[str],
) -> bool:
    def has_token(field: str, wanted: List[str]) -> bool:
        if not wanted:
            return True
        raw = str(row.get(field) or "")
        tokens = {
            t.strip()
            for t in raw.replace("；", ";").replace(",", ";").split(";")
            if t.strip()
        }
        return any(w in tokens or w in raw for w in wanted)

    return (
        has_token("开发者ID", developer_ids)
        and has_token("广告位ID", pos_ids)
        and has_token("应用ID", app_ids)
    )


def query_live(
    developer_ids: Optional[List[str]] = None,
    pos_ids: Optional[List[str]] = None,
    app_ids: Optional[List[str]] = None,
    hydrate: bool = True,
    page_size: int = 50,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    用户主动查询：实时打 Operation。
    返回 (result, meta)，result 形如 {total, rows, matchedBy}

    默认返回「生效中」(4) + 「审核中」(3)。
    """
    from .orient_fields import VISIBLE_STATUS_CODES, is_visible_status

    developer_ids = [str(x) for x in (developer_ids or []) if str(x).strip()]
    pos_ids = [str(x) for x in (pos_ids or []) if str(x).strip()]
    app_ids = [str(x) for x in (app_ids or []) if str(x).strip()]

    matched_by: Dict[str, List[str]] = {}
    if developer_ids:
        matched_by["开发者ID"] = developer_ids
    if pos_ids:
        matched_by["广告位ID"] = pos_ids
    if app_ids:
        matched_by["应用ID"] = app_ids

    last_err = None
    items_by_id: Dict[Any, dict] = {}
    upstream_total = 0
    used_body = None

    # 分别拉生效中 / 审核中，再按 id 去重合并（query 单 status 更稳）
    for status_code in sorted(VISIBLE_STATUS_CODES, reverse=True):
        got_page = False
        for body in _build_query_bodies(
            developer_ids,
            pos_ids,
            app_ids,
            page_size=page_size,
            status=status_code,
        ):
            resp, err = _orient_query_once(body)
            if err:
                last_err = err
                if err == "COOKIE_EXPIRED":
                    raise RuntimeError("COOKIE_EXPIRED")
                continue
            if not _status_ok(resp):
                last_err = (resp or {}).get("message") or f"status={(resp or {}).get('status')}"
                continue
            items, total = _extract_list(resp or {})
            for it in items:
                sid = it.get("id")
                if sid is None:
                    continue
                items_by_id[sid] = it
            upstream_total += int(total or 0)
            used_body = body
            got_page = True
            print(
                f"[strategy-live] orientControl/query ok status={status_code} "
                f"keys={sorted(body.keys())} total={total} n={len(items)}"
            )
            break
        if not got_page and last_err == "COOKIE_EXPIRED":
            raise RuntimeError("COOKIE_EXPIRED")

    if used_body is None and not items_by_id:
        raise RuntimeError(last_err or "Orient query 失败")

    items = list(items_by_id.values())
    rows: List[dict] = []
    for it in items:
        detail = None
        row = _to_row(it, None)
        if hydrate and _needs_hydrate(row, it):
            sid = it.get("id")
            if sid is not None:
                detail_resp, derr = _orient_get_detail(int(sid))
                if not derr and _status_ok(detail_resp):
                    detail = detail_resp
                time.sleep(0.03)
            row = _to_row(it, detail)

        if not is_visible_status(row, it.get("status")):
            continue
        if not _filter_row_matches(row, developer_ids, pos_ids, app_ids):
            continue
        # 不把 _raw 返回给前端
        row.pop("_raw", None)
        rows.append(row)

    meta = _set_meta(len(rows))
    meta["queryBodyKeys"] = sorted((used_body or {}).keys())
    meta["upstreamTotal"] = upstream_total
    return {
        "total": len(rows),
        "rows": rows,
        "matchedBy": matched_by,
        "upstreamTotal": upstream_total,
    }, meta
