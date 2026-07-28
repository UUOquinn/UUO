"""自动延期执行器：扫托管表 → 到期窗口内则 +N 月提审。"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

from .orient_proxy import orient_get_by_id, orient_merge_edit
from .registry import list_enabled_items
from .renew_core import (
    add_months_ms,
    days_until_end,
    extract_strategy_payload,
    sanitize_for_submit,
)

# 到期前 N 个自然日内（含当天、已过期）进入延期窗口；按天判定，不精确到分
DUE_WITHIN_DAYS = int(os.environ.get("POSTPONE_DUE_WITHIN_DAYS", "7"))


def _has_strategy_data(resp: Optional[dict]) -> bool:
    if not isinstance(resp, dict):
        return False
    # Orient 外层
    if resp.get("status") not in (None, 200):
        # 有些包装没有 status；有则必须 200
        if "status" in resp and resp.get("status") != 200:
            return False
    data = resp.get("data") if "data" in resp else resp
    if not isinstance(data, dict) or not data:
        return False
    return any(k in data for k in ("id", "name", "endTime", "adCluster", "mediaCluster"))


def renew_one(item: Dict[str, Any], log_fn=None) -> Dict[str, Any]:
    sid = int(item["strategy_id"])
    months = max(1, int(item.get("renew_months") or 1))
    log = log_fn or (lambda m: None)

    log(f"策略 #{sid}：拉取详情…")
    resp, err = orient_get_by_id(sid)
    if err:
        return {"strategy_id": sid, "status": "失败", "reason": err}
    if not _has_strategy_data(resp):
        return {"strategy_id": sid, "status": "失败", "reason": "定向 GET 无有效 data（非定向或不存在）"}

    try:
        # extract 需要带 status 的包装或纯 data
        detail = extract_strategy_payload(resp if "data" in resp else {"data": resp})
    except ValueError as e:
        try:
            detail = extract_strategy_payload(resp.get("data") or resp)
        except ValueError:
            return {"strategy_id": sid, "status": "失败", "reason": str(e)}

    end_ms = detail.get("endTime")
    remain = days_until_end(end_ms)
    if remain is None:
        return {"strategy_id": sid, "status": "跳过", "reason": "无有效 endTime（空或 0）"}
    begin_ms = detail.get("beginTime")
    try:
        begin_i = int(begin_ms) if begin_ms is not None else None
    except (TypeError, ValueError):
        begin_i = None
    # 按天：剩余自然日 > 7 则不延；≤7（含当天 0、已过期负数）自动延期
    if remain > DUE_WITHIN_DAYS:
        return {
            "strategy_id": sid,
            "status": "未到期",
            "reason": f"剩余 {remain} 天 > {DUE_WITHIN_DAYS} 天窗口",
            "endTime": end_ms,
            "daysLeft": remain,
        }

    new_end = add_months_ms(end_ms, months)
    # begin > new_end 会被 Orient 打 411「生效时间范围设置错误」
    if begin_i is not None and begin_i > 0 and int(new_end) <= begin_i:
        return {
            "strategy_id": sid,
            "status": "跳过",
            "reason": "延期后结束时间不晚于开始时间（无效时间范围）",
            "beginTime": begin_i,
            "prevEnd": end_ms,
            "newEnd": new_end,
        }
    body = sanitize_for_submit({**detail, "id": detail.get("id") or sid, "endTime": new_end})
    log(f"策略 #{sid}：endTime {end_ms} → {new_end}，提审…")

    submit_resp, submit_err = orient_merge_edit(body)
    if submit_err:
        return {"strategy_id": sid, "status": "失败", "reason": submit_err}

    status_code = (submit_resp or {}).get("status")
    msg = (submit_resp or {}).get("message") or ""
    if status_code != 200:
        return {
            "strategy_id": sid,
            "status": "失败",
            "reason": f"业务 {status_code}: {msg}",
            "prevEnd": end_ms,
            "newEnd": new_end,
        }

    return {
        "strategy_id": sid,
        "status": "成功",
        "reason": "",
        "prevEnd": end_ms,
        "newEnd": new_end,
        "owner": item.get("owner") or "",
    }


def run_scan(log_fn=None) -> Dict[str, Any]:
    log = log_fn or (lambda m: None)
    items = list_enabled_items()
    if not items:
        log("托管表无 enabled 策略，跳过")
        return {
            "total": 0,
            "success": 0,
            "failed": 0,
            "skipped": 0,
            "notDue": 0,
            "results": [],
            "reason": "empty_registry",
        }

    log(f"开始扫描 {len(items)} 条托管策略（按天判定：剩余≤{DUE_WITHIN_DAYS} 天则延期）…")
    results: List[Dict[str, Any]] = []
    success = failed = skipped = not_due = 0
    for it in items:
        try:
            r = renew_one(it, log_fn=log)
        except Exception as e:
            r = {"strategy_id": it.get("strategy_id"), "status": "失败", "reason": str(e)}
        results.append(r)
        st = r.get("status")
        if st == "成功":
            success += 1
        elif st == "失败":
            failed += 1
        elif st == "未到期":
            not_due += 1
        else:
            skipped += 1
        time.sleep(0.3)

    summary = {
        "total": len(items),
        "success": success,
        "failed": failed,
        "skipped": skipped,
        "notDue": not_due,
        "results": results,
    }
    log(
        f"扫描完成：成功 {success} / 失败 {failed} / 未到期 {not_due} / 其他 {skipped}（共 {len(items)}）"
    )
    return summary
