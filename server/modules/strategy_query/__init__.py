"""
strategy_query — Operation 平台实时策略查询

- 用户每次主动查询 → POST orientControl/query（+ 必要时 get 补全）
- orient_fields：Orient → 中文字段映射（可复用）
- parse_message：自然语言 ID 解析
"""

from .live_query import get_live_meta, query_live
from .orient_fields import (
    is_visible_status,
    needs_detail_hydrate,
    resolve_rule_name,
    resolve_status,
    strategy_to_row,
)
from .parse_message import SEARCH_FIELDS, parse_query_message

__all__ = [
    "SEARCH_FIELDS",
    "get_live_meta",
    "is_visible_status",
    "needs_detail_hydrate",
    "parse_query_message",
    "query_live",
    "resolve_rule_name",
    "resolve_status",
    "strategy_to_row",
]
