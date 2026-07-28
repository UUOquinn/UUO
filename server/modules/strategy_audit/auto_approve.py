"""白名单自动审核守护：status=1 全流程；卡单内存补跑；status=6 列表补跑；status=12 封禁期。"""

from __future__ import annotations

import os
import threading
import time

from .constants import BAN_WAIT_CHECK, CHECK_PASS, WAIT_CHECK
from .flows import run_ban_flow, run_normal_flow, run_publish_and_push
from .resolve import query_by_creator
from .whitelist import load_whitelist

AUTO_APPROVE_INTERVAL = int(os.environ.get("AUTO_APPROVE_INTERVAL", "300"))
# 进程启动后稍等再跑首轮（等 Playwright 就绪），之后按 INTERVAL 循环
AUTO_APPROVE_START_DELAY = int(os.environ.get("AUTO_APPROVE_START_DELAY", "15"))

_log = []
_running = False
_last_result = None
_lock = threading.Lock()

# Orient status=6 列表常漏单：用内存记住「审核成功但发布失败」的 approve_id，跨轮补跑
_stuck_publish = {}  # approve_id -> {strategy_id, creator_id, creator_name, fails, ts}
# 历史字段：推全不再跨轮挂队列（能推当场推，不能推就结束）。保留空 dict 兼容 status API。
_stuck_push = {}
_STUCK_MAX_FAILS = 8

# 日志展示用流程名（写入文本，首页直接可读）
_MODE_LABEL = {
    "normal": "普通审核",
    "ban": "封禁期审核",
    "publish_replay": "发布补跑",
    "normal+replay": "普通+同轮补跑",
    "stuck_publish": "发布卡单补跑",
    "stuck_push": "推全补跑",  # 仅兼容旧日志文案
}


def _mode_label(mode):
    key = str(mode or "").strip()
    return _MODE_LABEL.get(key, key or "-")


def _strategy_title(rule_id, rule_name=""):
    name = str(rule_name or "").strip()
    if name:
        return f"#{rule_id}「{name}」"
    return f"#{rule_id}"


def _audit_publish_text(result):
    """审核/发布结果文案。"""
    if not result:
        return "-"
    if result.get("banPublishConfirm"):
        return "审核过·发布待封禁确认"
    if result.get("auditOk") is False:
        return "审核不过"
    if result.get("publishBypassed"):
        return "审核过·发布不过(已旁路)"
    if result.get("publishOk") is True:
        return "都过"
    if result.get("publishOk") is False:
        return "审核过·发布不过"
    # 封禁期等无单独发布步时，审核成功即记为审核过
    if result.get("auditOk"):
        return "审核过"
    return "-"


def _push_text(result):
    st = result.get("pushStatus") if result else None
    push = (result or {}).get("push") or {}
    if st == "pushed":
        return "是"
    if st == "ban_submitted":
        detail = str(push.get("message") or "已提交封禁期审核").strip()
        return f"是（{detail}）"
    if st == "skipped":
        detail = str(push.get("message") or "无需推全").strip()
        return f"否（{detail}）" if detail else "否"
    if st == "failed":
        detail = str(push.get("message") or push.get("error") or "").strip()
        return f"失败（{detail}）" if detail else "失败"
    return "未执行"


def log_add(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    _log.append(f"[{ts}] {msg}")
    if len(_log) > 100:
        _log.pop(0)
    print(f"[auto-approve] {msg}")
    try:
        from modules.workbench_log import append as _wb_append

        _wb_append("audit", f"[{ts}] {msg}", operator="system:auto-approve")
    except Exception as e:
        print(f"[auto-approve] persist log failed: {e}")


def get_status():
    return {
        "running": _running,
        "interval": AUTO_APPROVE_INTERVAL,
        "lastResult": _last_result,
        "log": list(_log[-30:]),
        "stuckPublish": len(_stuck_publish),
        "stuckPush": len(_stuck_push),
    }


def is_running():
    return _running


def _remember_stuck_publish(strategy_id, approve_id, creator_id, creator_name):
    if not approve_id:
        return
    aid = int(approve_id)
    prev = _stuck_publish.get(aid) or {}
    _stuck_publish[aid] = {
        "strategy_id": int(strategy_id),
        "approve_id": aid,
        "creator_id": creator_id,
        "creator_name": creator_name,
        "fails": int(prev.get("fails") or 0),
        "ts": time.time(),
    }


def _clear_stuck_publish(approve_id):
    if approve_id is None:
        return
    _stuck_publish.pop(int(approve_id), None)


def _remember_stuck_push(strategy_id, creator_id, creator_name, approve_id=None):
    """已废弃：推全不入跨轮队列。保留空实现以免外部误调。"""
    return


def _clear_stuck_push(strategy_id):
    _stuck_push.pop(int(strategy_id), None)


def _drain_legacy_stuck_push():
    """一次性清空历史上挂着的推全补跑队列。"""
    n = len(_stuck_push)
    if n:
        _stuck_push.clear()
        log_add(f"已清空历史推全补跑队列 {n} 条（策略变更：不能推全则结束，不再跨轮补跑）")
    return n


def _log_flow_result(
    rule_id,
    mode,
    result,
    user_result,
    rule_name="",
    creator_name="",
    approve_id=None,
    note="",
):
    title = _strategy_title(rule_id, rule_name)
    flow = _mode_label(mode)
    who = str(creator_name or "").strip() or "-"
    aid = result.get("approve_id") if result else None
    if aid is None:
        aid = approve_id
    aid_txt = str(aid) if aid is not None else "-"
    ap = _audit_publish_text(result)
    push_txt = _push_text(result)
    note_txt = f" 备注={note}" if note else ""

    if result.get("ok"):
        user_result["approved"] += 1
        push = result.get("push") or {}
        if push.get("skipped"):
            user_result["pushSkipped"] += 1
        elif push.get("ok") and not push.get("skipped"):
            user_result["pushed"] += 1
        mark = "✓"
        # 推全失败仍可能 overall ok=False；此处 ok 分支内失败用说明
        if push and not push.get("skipped") and push.get("ok") is False:
            mark = "✓"
        if result.get("banPublishConfirm") or result.get("banPushConfirm"):
            mark = "…"
            if not note:
                if result.get("banPushConfirm"):
                    note = "封禁期推全需确认（已自动 confirm；仍待平台/人工，不入卡单）"
                else:
                    note = "封禁期同意发布需确认（审核已成功，不入卡单/不算错误）"
        note_txt = f" 备注={note}" if note else ""
        log_add(
            f"  {mark} {title} 流程={flow} 提交人={who} 审核单={aid_txt} "
            f"审核/发布：{ap} 立即推全：{push_txt}{note_txt}"
        )
        return

    if result.get("skipStuckQueue") or result.get("banPublishConfirm") or result.get("banPushConfirm"):
        # 软终态：不记失败、不入卡单
        user_result["approved"] += 1
        note_txt = f" 备注={note or '封禁期需确认，不入卡单'}"
        log_add(
            f"  … {title} 流程={flow} 提交人={who} 审核单={aid_txt} "
            f"审核/发布：{ap} 立即推全：{push_txt}{note_txt}"
        )
        return

    user_result["failed"] += 1
    steps = result.get("steps") or [{}]
    last = steps[-1] if steps else {}
    # 原因优先取失败步；避免旁路后用推全文案误标成「发布失败」
    fail_step = None
    for s in reversed(steps):
        if not s.get("ok") and not s.get("skipped"):
            fail_step = s
            break
    src = fail_step or last
    err_code = src.get("error") or ""
    err_msg = src.get("message") or src.get("error") or "未知错误"
    step_name = src.get("step") or ""
    if err_code == "APPROVE_NOT_FOUND":
        reason = f"反查审核记录失败：{err_msg}"
    elif step_name in ("quick_push", "ban_quick_push"):
        reason = f"立即推全失败：{err_msg}"
    elif result.get("stuckAt") == CHECK_PASS or (
        result.get("auditOk") and result.get("publishOk") is False
    ):
        reason = f"发布失败：{err_msg}"
    else:
        reason = str(err_msg)
    note_txt = f" 备注={note}" if note else ""
    log_add(
        f"  ✗ {title} 流程={flow} 提交人={who} 审核单={aid_txt} "
        f"审核/发布：{ap} 立即推全：{push_txt} 原因={reason}{note_txt}"
    )


def _after_result(
    rule_id,
    mode,
    result,
    creator_id,
    creator_name,
    approve_id,
    user_result,
    rule_name="",
):
    """记日志 + 维护发布卡单队列。推全：当场结果即终态，不入跨轮补跑。"""
    aid = result.get("approve_id") or approve_id
    note = ""
    if result.get("ok"):
        _clear_stuck_publish(aid)
        push = result.get("push") or {}
        if result.get("banPublishConfirm") or result.get("banPushConfirm"):
            note = (
                "封禁期推全需确认（已自动 confirm；仍待平台/人工，不入卡单/不算错误）"
                if result.get("banPushConfirm")
                else "封禁期同意发布需确认（审核已成功，不入卡单/不算错误）"
            )
            _clear_stuck_push(rule_id)
        elif push.get("reason") == "ban_audit_submitted":
            note = "已提交封禁期审核，等待 status=12 队列"
            _clear_stuck_push(rule_id)
        elif push.get("skipped") and push.get("reason") == "flag_false":
            # 审核+发布已过，按钮未就绪 = 业务上当前不能推全；不挂内存队列
            note = "不能推全（按钮未就绪），不入补跑"
            _clear_stuck_push(rule_id)
        elif push.get("skipped"):
            reason = push.get("reason") or "skipped"
            note = f"不能推全（{reason}），不入补跑"
            _clear_stuck_push(rule_id)
        elif push.get("ok") and not push.get("skipped"):
            _clear_stuck_push(rule_id)
        _log_flow_result(
            rule_id,
            mode,
            result,
            user_result,
            rule_name=rule_name,
            creator_name=creator_name,
            approve_id=aid,
            note=note,
        )
        return

    if result.get("skipStuckQueue") or result.get("banPublishConfirm") or result.get("banPushConfirm"):
        _clear_stuck_publish(aid)
        _clear_stuck_push(rule_id)
        _log_flow_result(
            rule_id,
            mode,
            result,
            user_result,
            rule_name=rule_name,
            creator_name=creator_name,
            approve_id=aid,
            note=note or "封禁期需确认，不入卡单",
        )
        return

    if result.get("stuckAt") == CHECK_PASS or (
        result.get("auditOk") and result.get("publishOk") is False
    ):
        _remember_stuck_publish(rule_id, aid, creator_id, creator_name)
        note = f"已入发布卡单队列({len(_stuck_publish)})"
    _log_flow_result(
        rule_id,
        mode,
        result,
        user_result,
        rule_name=rule_name,
        creator_name=creator_name,
        approve_id=aid,
        note=note,
    )


def _process_user_queue(creator_id, creator_name, status_val, mode):
    """查询某用户某状态下的记录并跑 flow。

    mode: normal | ban | publish_replay
    """
    resp, err = query_by_creator(creator_id, status_val)
    user_result = {
        "name": creator_name,
        "id": creator_id,
        "queue": mode,
        "pending": 0,
        "approved": 0,
        "failed": 0,
        "pushed": 0,
        "pushSkipped": 0,
    }

    if err:
        log_add(f"{creator_name} · {_mode_label(mode)} · 查询失败: {err}")
        return user_result, 0, 0

    if not resp or resp.get("status") != 200:
        log_add(f"{creator_name} · {_mode_label(mode)} · 查询返回非200: {resp}")
        return user_result, 0, 0

    records = (resp.get("data") or {}).get("data") or []
    user_result["pending"] = len(records)
    if not records:
        # 名下无策略：不写日志，避免首页刷屏
        return user_result, 0, 0

    log_add(f"{creator_name} · {_mode_label(mode)} · 待处理 {len(records)} 条")
    for record in records:
        rule_id = record.get("ruleId")
        if not rule_id:
            user_result["failed"] += 1
            continue

        approve_id = record.get("id")
        rule_name = record.get("ruleName") or ""
        run_mode = mode
        if mode == "ban":
            result = run_ban_flow(
                rule_id,
                reason_prefix="自动",
                creator_id=creator_id,
                approve_id=approve_id,
            )
        elif mode == "publish_replay":
            result = run_publish_and_push(
                rule_id,
                reason_prefix="自动补跑",
                creator_id=creator_id,
                approve_id=approve_id,
            )
        else:
            result = run_normal_flow(
                rule_id,
                reason_prefix="自动",
                creator_id=creator_id,
                approve_id=approve_id,
            )
            # 同进程立即补跑：不依赖 Orient status=6 列表（常漏单）
            if (
                not result.get("ok")
                and result.get("stuckAt") == CHECK_PASS
            ):
                aid = result.get("approve_id") or approve_id
                log_add(
                    f"  … {_strategy_title(rule_id, rule_name)} 发布失败，同进程延长重试 审核单={aid}"
                )
                time.sleep(1)
                result = run_publish_and_push(
                    rule_id,
                    reason_prefix="自动同轮补跑",
                    creator_id=creator_id,
                    approve_id=aid,
                    publish_retries=4,
                    publish_retry_interval=1.0,
                )
                run_mode = "normal+replay"

        _after_result(
            rule_id,
            run_mode,
            result,
            creator_id,
            creator_name,
            approve_id,
            user_result,
            rule_name=rule_name,
        )
        time.sleep(0.1)

    return user_result, user_result["approved"], user_result["failed"]


def _process_memory_stuck(results):
    """跨轮：仅补「审核成功但发布失败」卡单；推全不跨轮挂账。"""
    if _stuck_publish:
        log_add(f"内存发布卡单 {len(_stuck_publish)} 条，开始补跑")
    for aid, item in list(_stuck_publish.items()):
        if int(item.get("fails") or 0) >= _STUCK_MAX_FAILS:
            log_add(
                f"  ✗ {_strategy_title(item['strategy_id'])} 流程={_mode_label('stuck_publish')} "
                f"超过 {_STUCK_MAX_FAILS} 次，移出队列"
            )
            _stuck_publish.pop(aid, None)
            continue
        ur = {
            "name": item.get("creator_name"),
            "id": item.get("creator_id"),
            "queue": "stuck_publish",
            "pending": 1,
            "approved": 0,
            "failed": 0,
            "pushed": 0,
            "pushSkipped": 0,
        }
        result = run_publish_and_push(
            item["strategy_id"],
            reason_prefix="卡单补跑",
            creator_id=item.get("creator_id"),
            approve_id=item.get("approve_id"),
            publish_retries=4,
            publish_retry_interval=1.0,
        )
        if not result.get("ok"):
            item["fails"] = int(item.get("fails") or 0) + 1
            _stuck_publish[aid] = item
        _after_result(
            item["strategy_id"],
            "stuck_publish",
            result,
            item.get("creator_id"),
            item.get("creator_name"),
            item.get("approve_id"),
            ur,
        )
        _merge_user_result(results, ur)
        time.sleep(0.1)

    # 推全不再跨轮补跑（历史队列已在 run_once 入口清空）
    return


def _merge_user_result(results, ur):
    results["total"] += ur["pending"]
    results["approved"] += ur["approved"]
    results["failed"] += ur["failed"]
    results["pushed"] += ur["pushed"]
    results["pushSkipped"] += ur["pushSkipped"]
    results["users"].append(ur)


def run_once():
    global _running, _last_result

    with _lock:
        if _running:
            log_add("上一次自动审核仍在执行，跳过")
            return {"skipped": True, "reason": "already_running"}
        _running = True

    try:
        # 启动后首轮或任意一轮：清掉历史推全补跑挂账
        _drain_legacy_stuck_push()

        whitelist = load_whitelist()
        if not whitelist:
            log_add("白名单为空，跳过自动审核")
            result = {"total": 0, "approved": 0, "failed": 0, "users": [], "reason": "empty_whitelist"}
            _last_result = result
            return result

        results = {
            "total": 0,
            "approved": 0,
            "failed": 0,
            "pushed": 0,
            "pushSkipped": 0,
            "users": [],
        }

        # 先消化内存卡单（不依赖 status=6 列表）
        _process_memory_stuck(results)

        for user in whitelist:
            try:
                from orient_browser import queue_busy
                if queue_busy():
                    log_add("Playwright 队列忙，自动审核提前结束本轮（共享会话）")
                    break
            except Exception:
                pass

            creator_id = user["id"]
            creator_name = user.get("name", str(creator_id))

            ur1, _, _ = _process_user_queue(creator_id, creator_name, WAIT_CHECK, "normal")
            _merge_user_result(results, ur1)

            ur6, _, _ = _process_user_queue(
                creator_id, creator_name, CHECK_PASS, "publish_replay"
            )
            _merge_user_result(results, ur6)

            ur2, _, _ = _process_user_queue(creator_id, creator_name, BAN_WAIT_CHECK, "ban")
            _merge_user_result(results, ur2)

        log_add(
            f"本轮完成: 共 {results['total']} 条, "
            f"成功 {results['approved']}, 失败 {results['failed']}, "
            f"推全 {results['pushed']}, 跳过推全 {results['pushSkipped']}, "
            f"卡单发布队列 {len(_stuck_publish)}"
        )
        _last_result = results
        return results
    except Exception as e:
        log_add(f"自动审核异常: {e}")
        return {"total": 0, "approved": 0, "failed": 0, "error": str(e)}
    finally:
        _running = False


def daemon_loop():
    log_add(
        f"自动审核守护线程已启动 "
        f"(首轮约 {AUTO_APPROVE_START_DELAY}s 后，之后间隔 {AUTO_APPROVE_INTERVAL} 秒)"
    )
    time.sleep(max(0, AUTO_APPROVE_START_DELAY))
    while True:
        try:
            try:
                from orient_browser import queue_busy

                busy = queue_busy()
            except Exception:
                busy = False
            if busy:
                log_add("Playwright 队列忙，本轮自动审核跳过（共享会话）")
            else:
                run_once()
        except Exception as e:
            log_add(f"守护线程异常: {e}")
            time.sleep(30)
            continue
        time.sleep(AUTO_APPROVE_INTERVAL)


def start_daemon():
    t = threading.Thread(target=daemon_loop, daemon=True, name="auto-approve-daemon")
    t.start()
    return t


def trigger_async():
    if _running:
        return False, "ALREADY_RUNNING"

    def _run():
        run_once()

    threading.Thread(target=_run, daemon=True).start()
    return True, None
