"""托管表与编辑权限的读写（JSON 热更新）。"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

_DATA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "data")
)
REGISTRY_FILE = os.path.join(_DATA_DIR, "postpone_registry.json")
EDITORS_FILE = os.path.join(_DATA_DIR, "postpone_editors.json")

_file_lock = threading.Lock()


def _ensure_data_dir() -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)


def _read_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[postpone-registry] 读取失败 {path}: {e}")
        return default


def _write_json(path: str, data: Any) -> None:
    _ensure_data_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def load_registry() -> Dict[str, Any]:
    data = _read_json(REGISTRY_FILE, {"items": []})
    if not isinstance(data, dict):
        data = {"items": []}
    items = data.get("items")
    if not isinstance(items, list):
        items = []
    # 规范化
    cleaned: List[Dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        sid = it.get("strategy_id")
        if sid is None:
            continue
        try:
            sid_int = int(sid)
        except (TypeError, ValueError):
            continue
        cleaned.append({
            "strategy_id": sid_int,
            "enabled": bool(it.get("enabled", True)),
            "owner": str(it.get("owner") or ""),
            "renew_months": int(it.get("renew_months") or 1),
            "note": str(it.get("note") or ""),
            "updated_at": str(it.get("updated_at") or ""),
            "updated_by": str(it.get("updated_by") or ""),
        })
    data["items"] = cleaned
    return data


def save_registry(data: Dict[str, Any]) -> None:
    with _file_lock:
        _write_json(REGISTRY_FILE, data)


def upsert_item(
    strategy_id: int,
    *,
    enabled: bool = True,
    owner: str = "",
    renew_months: int = 1,
    note: str = "",
    operator: str = "",
) -> Dict[str, Any]:
    with _file_lock:
        data = load_registry()
        items = data["items"]
        found = None
        for it in items:
            if int(it["strategy_id"]) == int(strategy_id):
                found = it
                break
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if found is None:
            found = {
                "strategy_id": int(strategy_id),
                "enabled": bool(enabled),
                "owner": owner or "",
                "renew_months": max(1, int(renew_months or 1)),
                "note": note or "",
                "updated_at": now,
                "updated_by": operator or "",
            }
            items.append(found)
        else:
            found["enabled"] = bool(enabled)
            if owner is not None:
                found["owner"] = str(owner)
            found["renew_months"] = max(1, int(renew_months or found.get("renew_months") or 1))
            if note is not None:
                found["note"] = str(note)
            found["updated_at"] = now
            found["updated_by"] = operator or found.get("updated_by") or ""
        data["items"] = items
        _write_json(REGISTRY_FILE, data)
        return found


def delete_item(strategy_id: int) -> bool:
    with _file_lock:
        data = load_registry()
        before = len(data["items"])
        data["items"] = [
            it for it in data["items"] if int(it["strategy_id"]) != int(strategy_id)
        ]
        if len(data["items"]) == before:
            return False
        _write_json(REGISTRY_FILE, data)
        return True


def load_editors() -> Dict[str, Any]:
    data = _read_json(EDITORS_FILE, {"admins": [], "editors": []})
    if not isinstance(data, dict):
        data = {}
    admins = data.get("admins") or []
    editors = data.get("editors") or []
    if not isinstance(admins, list):
        admins = []
    if not isinstance(editors, list):
        editors = []
    data["admins"] = [str(x).strip() for x in admins if str(x).strip()]
    data["editors"] = [str(x).strip() for x in editors if str(x).strip()]
    return data


def save_editors(data: Dict[str, Any]) -> None:
    with _file_lock:
        _write_json(EDITORS_FILE, data)


def get_operator_perms(operator: Optional[str]) -> Dict[str, Any]:
    """返回当前操作人权限。

    admins 为空时：open_mode=True，任何人可直接编辑托管表与权限名单（无需先填操作人）。
    有 admin 后：仅白名单可写；须带操作人账号且命中 admins/editors。
    """
    op = (operator or "").strip()
    cfg = load_editors()
    admins = cfg["admins"]
    editors = cfg["editors"]
    open_mode = len(admins) == 0
    if open_mode:
        return {
            "operator": op,
            "openMode": True,
            "canEdit": True,
            "canManageEditors": True,
            "isAdmin": True,
            "admins": admins,
            "editors": editors,
        }
    in_admin = bool(op and op in admins)
    in_editor = bool(op and (op in editors or in_admin))
    return {
        "operator": op,
        "openMode": False,
        "canEdit": in_editor,
        "canManageEditors": in_admin,
        "isAdmin": in_admin,
        "admins": admins,
        "editors": editors,
    }


def upsert_editor(name: str, *, as_admin: bool = False, operator: str = "") -> Dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("name is required")
    with _file_lock:
        data = load_editors()
        editors = data["editors"]
        admins = data["admins"]
        if name not in editors:
            editors.append(name)
        if as_admin and name not in admins:
            admins.append(name)
        data["editors"] = editors
        data["admins"] = admins
        data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        data["updated_by"] = operator or ""
        _write_json(EDITORS_FILE, data)
        return data


def delete_editor(name: str, *, operator: str = "") -> Dict[str, Any]:
    name = (name or "").strip()
    with _file_lock:
        data = load_editors()
        data["editors"] = [x for x in data["editors"] if x != name]
        data["admins"] = [x for x in data["admins"] if x != name]
        data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        data["updated_by"] = operator or ""
        _write_json(EDITORS_FILE, data)
        return data


def list_enabled_items() -> List[Dict[str, Any]]:
    return [it for it in load_registry()["items"] if it.get("enabled")]
