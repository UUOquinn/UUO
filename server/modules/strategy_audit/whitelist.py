"""白名单读取（realtime-check.js 热更新）。"""

from __future__ import annotations

import json
import os
import re

_WHITELIST_FILE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "realtime-check.js")
)


def load_whitelist():
    if not os.path.exists(_WHITELIST_FILE):
        return []
    try:
        with open(_WHITELIST_FILE, "r", encoding="utf-8") as f:
            content = f.read()
        m = re.search(r"module\.exports\s*=\s*(\[.*?\])\s*;?\s*$", content, re.DOTALL)
        if not m:
            return []
        js_arr = m.group(1)
        js_arr = re.sub(r"//[^\n]*", "", js_arr)
        json_str = re.sub(r"(\{|,)\s*(\w+)\s*:", r'\1"\2":', js_arr)
        json_str = re.sub(r",\s*([}\]])", r"\1", json_str)
        items = json.loads(json_str)
        if not isinstance(items, list):
            return []
        return [item for item in items if isinstance(item, dict) and "id" in item]
    except Exception as e:
        print(f"[strategy_audit.whitelist] 解析失败: {e}")
        return []
