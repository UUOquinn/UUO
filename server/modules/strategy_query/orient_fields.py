"""
Orient 策略对象 → 前端中文字段（可复用）

供 live_query / 其他模块共用，不依赖 Excel。
规则名称：API 无 ruleName，按 type / shieldType / tagType 枚举反查。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

# ─── 规则名称（type 为主；与 Excel 全量表口径对齐）───
# 样本：type×shield×tag → 规则名称（生效中全量抽样）
_RULE_BY_TYPE: Dict[int, str] = {
    1: "联盟明投",
    2: "屏蔽",
    3: "场景定投",
    5: "标签屏蔽",
    6: "媒体定向",
    7: "新屏蔽（屏蔽的广告信息并集生效）",
    8: "联盟明投-人群包定向",
    9: "新联盟明暗投",
    10: "新屏蔽（屏蔽的广告信息交集生效）",
}

# ─── 投放范围 placements ───
_PLACEMENT_LABEL: Dict[int, str] = {
    1: "全生效",
    2: "暗投",
    4: "明投优选",
    5: "明投",
}

# ─── 设备类型 osType（0 常表示未限定，展示为空）───
_OS_TYPE_LABEL: Dict[int, str] = {
    1: "Android",
    2: "iOS",
}

# ─── 策略生效状态（与 strategy-audit.js STRATEGY_STATUS 对齐）───
_STATUS_LABEL: Dict[int, str] = {
    1: "待审核",
    2: "待发布",
    3: "审核中",
    4: "生效中",
    5: "已撤回",
    6: "已结束",
    7: "草稿",
}

# 策略查询默认展示：审核中 视同需渲染（与生效中一并返回）
VISIBLE_STATUS_LABELS = frozenset({"生效中", "审核中"})
VISIBLE_STATUS_CODES = frozenset({3, 4})


def resolve_status(src: dict, base: Optional[dict] = None) -> str:
    """statusDesc 优先；否则按 status 码表反查。"""
    base = base or {}
    desc = src.get("statusDesc") or base.get("statusDesc")
    if desc is not None and str(desc).strip() != "":
        return str(desc).strip()
    code = _as_int(src.get("status") if src.get("status") is not None else base.get("status"))
    if code is not None:
        return _STATUS_LABEL.get(code, f"状态{code}")
    return ""


def is_visible_status(row_or_label: Any, status_code: Any = None) -> bool:
    """是否应出现在策略查询结果中（生效中 / 审核中）。"""
    if isinstance(row_or_label, dict):
        label = str(row_or_label.get("状态") or "").strip()
        if not label and status_code is None:
            raw = row_or_label.get("_raw") or {}
            status_code = raw.get("status") if isinstance(raw, dict) else None
    else:
        label = str(row_or_label or "").strip()

    if label in VISIBLE_STATUS_LABELS:
        return True
    code = _as_int(status_code)
    if code is not None and code in VISIBLE_STATUS_CODES:
        return True
    return False



def unwrap_strategy(payload: Optional[dict]) -> dict:
    """兼容多层响应壳：{success,data} / {status,data:{...}} / 已解包对象。"""
    if not isinstance(payload, dict):
        return {}
    cur: dict = payload
    for _ in range(4):
        if "adCluster" in cur or "mediaCluster" in cur:
            return cur
        if "id" in cur and ("name" in cur or "status" in cur or "statusDesc" in cur):
            return cur
        data = cur.get("data")
        if isinstance(data, dict) and data:
            cur = data
            continue
        break
    return cur if isinstance(cur, dict) else {}


def fmt_time(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 10_000_000_000:
            ts /= 1000.0
        try:
            return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return str(value)
    return str(value)


def _as_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _yes_no(value: Any) -> str:
    if value is True or value == 1 or value == "1":
        return "是"
    if value is False or value == 0 or value == "0":
        return "否"
    if value is None or value == "":
        return ""
    return str(value)


def _join_listish(value: Any) -> str:
    """list / 逗号串 / 分号串 → 统一分号串（前端 tokenize 兼容）。"""
    if value is None or value == "":
        return ""
    if isinstance(value, (list, tuple)):
        parts = [str(x).strip() for x in value if x is not None and str(x).strip()]
        return ";".join(parts)
    text = str(value).strip()
    if not text:
        return ""
    # 统一分隔符，保留原 token
    return (
        text.replace("；", ";")
        .replace(",", ";")
        .replace("，", ";")
        .replace(" ", ";")
        .replace(";;", ";")
    )


def resolve_rule_name(src: dict, ad: Optional[dict] = None) -> str:
    """优先显式 ruleName；否则按 type 枚举。"""
    ad = ad or {}
    explicit = (
        src.get("ruleName")
        or ad.get("ruleName")
        or src.get("ruleNameDesc")
        or ad.get("ruleNameDesc")
    )
    if explicit:
        return str(explicit).strip()

    t = _as_int(src.get("type"))
    if t is not None and t in _RULE_BY_TYPE:
        return _RULE_BY_TYPE[t]
    return ""


def resolve_placement(ad: dict) -> str:
    """placements / placementsArr → 投放范围文案。"""
    if not ad:
        return ""
    codes: List[int] = []
    arr = ad.get("placementsArr")
    if isinstance(arr, list) and arr:
        for x in arr:
            n = _as_int(x)
            if n is not None:
                codes.append(n)
    else:
        n = _as_int(ad.get("placements"))
        if n is not None:
            codes.append(n)

    labels = []
    seen = set()
    for c in codes:
        label = _PLACEMENT_LABEL.get(c, f"投放{c}" if c else "")
        if label and label not in seen:
            seen.add(label)
            labels.append(label)
    return ";".join(labels)


def resolve_os_type(media: dict) -> str:
    n = _as_int((media or {}).get("osType"))
    if n is None or n == 0:
        return ""
    return _OS_TYPE_LABEL.get(n, str(n))


def strategy_to_row(item: dict, detail: Optional[dict] = None) -> dict:
    """
    Orient list item + 可选 get 详情 → 前端策略查询行。

    detail 可为 get 完整响应或已解包 data。
    """
    base = unwrap_strategy(item) if item else {}
    src = unwrap_strategy(detail) if detail else base
    # list 与 detail 合并：detail 优先，list 补缺顶层字段
    if detail and base is not src:
        merged = dict(base)
        merged.update({k: v for k, v in src.items() if v is not None and v != ""})
        # cluster 以 detail 为准
        if src.get("adCluster"):
            merged["adCluster"] = src["adCluster"]
        if src.get("mediaCluster"):
            merged["mediaCluster"] = src["mediaCluster"]
        src = merged

    media = src.get("mediaCluster") or {}
    ad = src.get("adCluster") or {}
    sid = src.get("id") or base.get("id") or ""

    product = ad.get("product") or ad.get("productName") or base.get("productName") or ""
    account = ad.get("accountId") or base.get("accountId") or ""
    second_ind = (
        ad.get("secondIndustryV6")
        or ad.get("secondIndustry")
        or ad.get("firstIndustry")
        or ""
    )

    row = {
        "策略id": str(sid) if sid != "" else "",
        "策略名": src.get("name") or base.get("name") or "",
        "规则名称": resolve_rule_name(src, ad),
        "状态": resolve_status(src, base),
        "产品名称": _join_listish(product),
        "账户ID": _join_listish(account),
        "快手ID": _join_listish(ad.get("photoId") or ad.get("userId") or ""),
        "UnitID": _join_listish(ad.get("unitId") or ""),
        "小店通物料类型": _join_listish(ad.get("shopMaterialType") or ""),
        "一级行业": _join_listish(ad.get("firstIndustry") or ""),
        "二级行业": _join_listish(second_ind),
        "浅度优化目标": _join_listish(ad.get("ocpxActionType") or ""),
        "深度优化目标": _join_listish(ad.get("deepOcpxActionType") or ""),
        "计划类型": _join_listish(ad.get("campaignType") or ""),
        "出价类型": _join_listish(ad.get("bidType") if ad.get("bidType") not in (0, "0", None) else ""),
        "设备类型": resolve_os_type(media),
        "投放范围": resolve_placement(ad),
        "计划ID": _join_listish(ad.get("campaignId") or ad.get("planId") or ""),
        "创意ID": _join_listish(ad.get("creativeId") or ""),
        "视频ID": _join_listish(ad.get("videoId") or ""),
        "营销目标": _join_listish(ad.get("marketingTarget") or ""),
        "是否应用直投": _yes_no(ad.get("isAppDirect")),
        "是否屏蔽权益卡": _yes_no(ad.get("shieldEquityCard")),
        "是否屏蔽涉黄": _yes_no(ad.get("shieldSex")),
        "开发者ID": _join_listish(
            media.get("uid")
            or media.get("mediaUid")
            or media.get("developerId")
            or src.get("uid")
            or base.get("uid")
            or base.get("mediaUid")
            or ""
        ),
        "广告位ID": _join_listish(
            media.get("posId") or media.get("positionId") or src.get("posId") or base.get("posId") or ""
        ),
        "应用ID": _join_listish(
            media.get("appId") or media.get("appIds") or src.get("appId") or base.get("appId") or ""
        ),
        "广告样式": _join_listish(ad.get("adStyle") or media.get("adStyle") or ""),
        "生效时间": fmt_time(src.get("beginTime") or base.get("beginTime") or ""),
        "失效时间": fmt_time(src.get("endTime") or base.get("endTime") or ""),
        "创建人": src.get("creatorName") or base.get("creatorName") or "",
        "创建时间": fmt_time(src.get("createTime") or base.get("createTime") or ""),
        "策略标签": "",
        "_raw": src,
    }
    return row


def needs_detail_hydrate(row: dict, item: Optional[dict] = None) -> bool:
    """
    列表行是否缺广告主/规则维度，需要 get 补全。

    仅有应用ID 不足以跳过：query 列表常带 appId，但缺 adCluster。
    映射后已有「规则名称 + 投放范围」则认为列表已够用。
    """
    del item  # 保留参数便于调用方透传，当前仅看映射结果
    has_rule = bool(str(row.get("规则名称") or "").strip())
    has_placement = bool(str(row.get("投放范围") or "").strip())
    return not (has_rule and has_placement)
