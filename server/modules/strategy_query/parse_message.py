"""策略查询自然语言 → ID 解析（可复用，不依赖 Excel）"""

from __future__ import annotations

import re

SEARCH_FIELDS = {
    "developerId": "开发者ID",
    "posId": "广告位ID",
    "appId": "应用ID",
}


def parse_query_message(message: str):
    text = (message or "").strip()
    if not text:
        return {"developerIds": [], "posIds": [], "appIds": [], "parsed": {}}

    developer_ids = []
    pos_ids = []
    app_ids = []
    parsed = {}

    patterns = [
        ("developerIds", r"开发者\s*ID[：:\s]*([0-9;；,\s]+)", "开发者ID"),
        ("posIds", r"广告位\s*ID[：:\s]*([0-9;；,\s]+)", "广告位ID"),
        ("appIds", r"应用\s*ID[：:\s]*([0-9;；,\s]+)", "应用ID"),
        ("developerIds", r"\buid[：:\s]*([0-9;；,\s]+)", "uid"),
        ("posIds", r"\bpos[_\s-]*id[：:\s]*([0-9;；,\s]+)", "pos_id"),
        ("appIds", r"\bapp[_\s-]*id[：:\s]*([0-9;；,\s]+)", "app_id"),
    ]

    for key, pattern, label in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            values = [v for v in re.split(r"[;；,\s]+", match.group(1).strip()) if v.isdigit()]
            if not values:
                continue
            parsed[label] = values
            if key == "developerIds":
                developer_ids.extend(values)
            elif key == "posIds":
                pos_ids.extend(values)
            else:
                app_ids.extend(values)

    if not developer_ids and not pos_ids and not app_ids:
        numbers = [n for n in re.split(r"[;；,\s]+", text) if n.isdigit()]
        if numbers:
            app_ids = numbers
            parsed["自动识别为应用ID"] = numbers

    def uniq(items):
        seen = set()
        out = []
        for item in items:
            if item not in seen:
                seen.add(item)
                out.append(item)
        return out

    return {
        "developerIds": uniq(developer_ids),
        "posIds": uniq(pos_ids),
        "appIds": uniq(app_ids),
        "parsed": parsed,
    }
