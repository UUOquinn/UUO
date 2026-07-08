"""策略信息全量表加载与查询"""

import json
import os
import re
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "strategies.json"

SEARCH_FIELDS = {
    "developerId": "开发者ID",
    "posId": "广告位ID",
    "appId": "应用ID",
}

FIELD_ALIASES = {
    "developerId": ["开发者id", "开发者ID", "uid", "媒体uid", "开发者"],
    "posId": ["广告位id", "广告位ID", "posid", "pos_id", "广告位"],
    "appId": ["应用id", "应用ID", "appid", "app_id", "应用"],
}


class StrategyStore:
    def __init__(self):
        self.loaded = False
        self.meta = {}
        self.rows = []
        self.index = {key: {} for key in SEARCH_FIELDS}

    def load(self):
        if not DATA_PATH.exists():
            raise FileNotFoundError(f"未找到策略数据文件: {DATA_PATH}")

        with open(DATA_PATH, "r", encoding="utf-8") as f:
            payload = json.load(f)

        self.rows = payload.get("rows", [])
        self.meta = {
            "source": payload.get("source", ""),
            "importedAt": payload.get("importedAt", ""),
            "fields": payload.get("fields", []),
            "total": len(self.rows),
        }
        self.index = {key: {} for key in SEARCH_FIELDS}
        self._build_indexes()
        self.loaded = True
        return self.meta

    def _tokenize(self, value):
        if value is None:
            return []
        text = str(value).strip()
        if not text:
            return []
        return [t.strip() for t in re.split(r"[;；,\s]+", text) if t.strip()]

    def _build_indexes(self):
        for i, row in enumerate(self.rows):
            for key, field_name in SEARCH_FIELDS.items():
                for token in self._tokenize(row.get(field_name, "")):
                    self.index[key].setdefault(token, set()).add(i)

    def get_meta(self):
        if not self.loaded:
            self.load()
        return self.meta

    def query(self, developer_ids=None, pos_ids=None, app_ids=None):
        if not self.loaded:
            self.load()

        developer_ids = developer_ids or []
        pos_ids = pos_ids or []
        app_ids = app_ids or []

        if not developer_ids and not pos_ids and not app_ids:
            return {"total": 0, "rows": [], "matchedBy": {}}

        candidate_sets = []
        matched_by = {}

        if developer_ids:
            idx_set = set()
            for val in developer_ids:
                idx_set |= self.index["developerId"].get(val, set())
            candidate_sets.append(idx_set)
            matched_by["开发者ID"] = developer_ids

        if pos_ids:
            idx_set = set()
            for val in pos_ids:
                idx_set |= self.index["posId"].get(val, set())
            candidate_sets.append(idx_set)
            matched_by["广告位ID"] = pos_ids

        if app_ids:
            idx_set = set()
            for val in app_ids:
                idx_set |= self.index["appId"].get(val, set())
            candidate_sets.append(idx_set)
            matched_by["应用ID"] = app_ids

        if len(candidate_sets) == 1:
            result_idx = candidate_sets[0]
        else:
            result_idx = set.intersection(*candidate_sets)

        rows = [self.rows[i] for i in sorted(result_idx)]
        return {
            "total": len(rows),
            "rows": rows,
            "matchedBy": matched_by,
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


store = StrategyStore()
