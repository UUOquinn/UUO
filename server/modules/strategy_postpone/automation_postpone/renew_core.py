"""延期提交体处理：与前端 strategy-renewal.js 对齐。"""

from __future__ import annotations

import copy
from datetime import datetime
from typing import Any, Dict, List, Optional

SUBMIT_FIELDS = [
    "id", "name", "type", "background",
    "shieldType", "shieldMediaType", "shieldUserType",
    "beginTime", "endTime",
    "adCluster", "mediaCluster",
]

INDUSTRY_VERSION = "6.6"


def add_months_ms(ms: Any, months: int = 1) -> int:
    n = int(ms)
    d = datetime.fromtimestamp(n / 1000.0)
    month = d.month - 1 + months
    year = d.year + month // 12
    month = month % 12 + 1
    day = min(d.day, _days_in_month(year, month))
    nd = d.replace(year=year, month=month, day=day)
    return int(nd.timestamp() * 1000)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        nxt = datetime(year + 1, 1, 1)
    else:
        nxt = datetime(year, month + 1, 1)
    cur = datetime(year, month, 1)
    return (nxt - cur).days


def extract_strategy_payload(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("GET 策略详情返回为空")
    if raw.get("adCluster") is not None or raw.get("mediaCluster") is not None:
        return raw
    inner = raw.get("data")
    if isinstance(inner, dict):
        if inner.get("adCluster") is not None or inner.get("mediaCluster") is not None:
            return inner
        deep = inner.get("data")
        if isinstance(deep, dict):
            if deep.get("adCluster") is not None or deep.get("mediaCluster") is not None:
                return deep
    for key in ("strategy", "detail"):
        obj = raw.get(key)
        if isinstance(obj, dict):
            return obj
    raise ValueError("无法从 GET 响应中识别策略对象")


def sanitize_for_submit(detail: Dict[str, Any]) -> Dict[str, Any]:
    body: Dict[str, Any] = {}
    for key in SUBMIT_FIELDS:
        if key in detail:
            body[key] = copy.deepcopy(detail[key])
    ad = body.get("adCluster")
    if isinstance(ad, dict):
        ad["industryVersion"] = INDUSTRY_VERSION
        if isinstance(ad.get("maxNum"), dict):
            del ad["maxNum"]
    media = body.get("mediaCluster")
    if isinstance(media, dict) and isinstance(media.get("maxNum"), dict):
        del media["maxNum"]
    if detail.get("id") is not None:
        body["id"] = detail["id"]
    # Orient mergeEditV2 现要求 background 非空；GET 详情常不返回该字段
    bg = body.get("background")
    if not (isinstance(bg, str) and bg.strip()):
        name = detail.get("name")
        sid = detail.get("id")
        if isinstance(name, str) and name.strip():
            body["background"] = name.strip()
        elif sid is not None:
            body["background"] = f"策略{sid}延期续期"
        else:
            body["background"] = "延期续期"
    return body


def days_until_end(end_ms: Any) -> Optional[int]:
    """按自然日计算距离到期的天数（不精确到分）。

    例：今天到期 → 0；已过期 → 负数；还剩整整 7 个日历日 → 7。
    endTime 缺失 / 0 / 非法 → None（勿当「已过期很久」去延期）。
    """
    try:
        end = int(end_ms)
    except (TypeError, ValueError):
        return None
    # Orient 部分老策略 endTime=0（epoch），不是有效结束时间
    if end <= 0:
        return None
    end_date = datetime.fromtimestamp(end / 1000.0).date()
    today = datetime.now().date()
    return (end_date - today).days
