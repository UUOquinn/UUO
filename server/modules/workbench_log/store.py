"""JSONL 日志存储：按 type 分文件，写时/读时 prune >30 天。"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

LOG_TYPES = ("query", "error", "audit", "postpone", "shield")
KEEP_DAYS = 30
KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000
DEFAULT_LIMIT = 500

_DATA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "logs")
)
_locks: Dict[str, threading.Lock] = {t: threading.Lock() for t in LOG_TYPES}
_dir_ready = False


def _ensure_dir() -> None:
    global _dir_ready
    if _dir_ready:
        return
    os.makedirs(_DATA_DIR, exist_ok=True)
    _dir_ready = True


def _path(log_type: str) -> str:
    return os.path.join(_DATA_DIR, f"{log_type}.jsonl")


def _cutoff_ms(now_ms: Optional[int] = None) -> int:
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    return now - KEEP_MS


def _normalize_type(log_type: str) -> str:
    t = (log_type or "").strip().lower()
    if t not in LOG_TYPES:
        raise ValueError(f"invalid log type: {log_type!r}; expected one of {LOG_TYPES}")
    return t


def _read_entries(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    out: List[Dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    out.append(obj)
    except OSError:
        return []
    return out


def _write_entries(path: str, entries: List[Dict[str, Any]]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def _prune_list(entries: List[Dict[str, Any]], cutoff: int) -> List[Dict[str, Any]]:
    kept: List[Dict[str, Any]] = []
    for e in entries:
        try:
            ts = int(e.get("ts") or 0)
        except (TypeError, ValueError):
            ts = 0
        if ts and ts < cutoff:
            continue
        kept.append(e)
    return kept


def append(
    log_type: str,
    text: str,
    operator: str = "",
    meta: Optional[Dict[str, Any]] = None,
    ts: Optional[int] = None,
) -> Dict[str, Any]:
    """追加一条日志；顺带 prune 过期行。返回写入条目。"""
    t = _normalize_type(log_type)
    body = (text or "").strip()
    if not body:
        raise ValueError("text is required")

    now = int(time.time() * 1000)
    entry: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "type": t,
        "ts": int(ts) if ts is not None else now,
        "operator": (operator or "").strip(),
        "text": body,
        "meta": meta if isinstance(meta, dict) else {},
    }

    _ensure_dir()
    path = _path(t)
    lock = _locks[t]
    with lock:
        entries = _read_entries(path)
        entries = _prune_list(entries, _cutoff_ms(now))
        entries.append(entry)
        _write_entries(path, entries)
    return entry


def list_logs(
    log_type: str,
    since_ts: Optional[int] = None,
    limit: int = DEFAULT_LIMIT,
) -> List[Dict[str, Any]]:
    """按时间倒序返回日志（最新在前）。读时也会 prune。"""
    t = _normalize_type(log_type)
    lim = DEFAULT_LIMIT if limit is None else int(limit)
    if lim <= 0:
        lim = DEFAULT_LIMIT
    if lim > 5000:
        lim = 5000

    _ensure_dir()
    path = _path(t)
    lock = _locks[t]
    now = int(time.time() * 1000)
    cutoff = _cutoff_ms(now)

    with lock:
        entries = _read_entries(path)
        pruned = _prune_list(entries, cutoff)
        if len(pruned) != len(entries):
            _write_entries(path, pruned)
        entries = pruned

    if since_ts is not None:
        try:
            since = int(since_ts)
        except (TypeError, ValueError):
            since = 0
        if since > 0:
            entries = [e for e in entries if int(e.get("ts") or 0) >= since]

    entries.sort(key=lambda e: int(e.get("ts") or 0), reverse=True)
    return entries[:lim]


def prune_all() -> Dict[str, int]:
    """启动时批量 prune，返回各 type 保留条数。"""
    _ensure_dir()
    now = int(time.time() * 1000)
    cutoff = _cutoff_ms(now)
    counts: Dict[str, int] = {}
    for t in LOG_TYPES:
        path = _path(t)
        lock = _locks[t]
        with lock:
            entries = _read_entries(path)
            pruned = _prune_list(entries, cutoff)
            if len(pruned) != len(entries):
                _write_entries(path, pruned)
            counts[t] = len(pruned)
    return counts


def clear_logs(log_type: str) -> int:
    """清空某 type 的全部日志，返回清空前条数。"""
    t = _normalize_type(log_type)
    _ensure_dir()
    path = _path(t)
    lock = _locks[t]
    with lock:
        entries = _read_entries(path)
        n = len(entries)
        _write_entries(path, [])
    return n


def delete_logs(log_type: str, ids: List[str]) -> int:
    """按 id 删除若干条，返回实际删除条数。"""
    t = _normalize_type(log_type)
    id_set = {str(x).strip() for x in (ids or []) if str(x).strip()}
    if not id_set:
        return 0
    _ensure_dir()
    path = _path(t)
    lock = _locks[t]
    with lock:
        entries = _read_entries(path)
        kept = [e for e in entries if str(e.get("id") or "") not in id_set]
        removed = len(entries) - len(kept)
        if removed:
            _write_entries(path, kept)
        return removed
