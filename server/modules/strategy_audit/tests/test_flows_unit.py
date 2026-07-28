"""strategy_audit 编排单测（mock Orient，不打真实网络）。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]  # .../server
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class TestFlowsStuckAt(unittest.TestCase):
    def test_publish_fail_sets_stuck_at_6_when_push_not_ready(self):
        from modules.strategy_audit import flows

        def fake_change(sid, target, reason="", creator_id=None, approve_id=None, confirm=False):
            if int(target) == 6:
                return {"ok": True, "error": None, "message": None, "approve_id": 99, "data": None}
            return {
                "ok": False,
                "error": "ORIENT_FAILED",
                "message": "操作[发布成功]无法应用于状态[审核成功]",
                "approve_id": 99,
                "data": None,
            }

        with mock.patch.object(flows, "change_approve_status", side_effect=fake_change), \
             mock.patch.object(
                 flows,
                 "maybe_push_full",
                 return_value={
                     "ok": True,
                     "skipped": True,
                     "reason": "flag_false",
                     "message": "推全跳过",
                     "error": None,
                 },
             ) as push_mock, \
             mock.patch.object(flows.time, "sleep", return_value=None):
            result = flows.run_normal_flow(23947, creator_id=1, approve_id=99, reason_prefix="测")
            push_mock.assert_called_once()
            self.assertFalse(result["ok"])
            self.assertTrue(result["auditOk"])
            self.assertFalse(result["publishOk"])
            self.assertTrue(result["publishBypassed"])
            self.assertEqual(result["stuckAt"], 6)
            self.assertEqual(result["steps"][0]["step"], "check_pass")
            self.assertEqual(result["steps"][-1]["step"], "quick_push")

    def test_publish_blocked_but_push_succeeds(self):
        from modules.strategy_audit import flows

        def fake_change(sid, target, reason="", creator_id=None, approve_id=None, confirm=False):
            return {
                "ok": False,
                "error": "ORIENT_FAILED",
                "message": "操作[发布成功]无法应用于状态[审核成功]",
                "approve_id": 46242,
                "data": None,
            }

        with mock.patch.object(flows, "change_approve_status", side_effect=fake_change), \
             mock.patch.object(
                 flows,
                 "maybe_push_full",
                 return_value={
                     "ok": True,
                     "skipped": False,
                     "reason": "pushed",
                     "message": None,
                     "error": None,
                     "pushFlagsFrom": "approve_embed",
                 },
             ) as push_mock, \
             mock.patch.object(flows.time, "sleep", return_value=None):
            result = flows.run_publish_and_push(
                24059, creator_id=1, approve_id=46242, publish_retries=1
            )
            push_mock.assert_called_once()
            self.assertTrue(result["ok"])
            self.assertFalse(result["publishOk"])
            self.assertTrue(result["publishBypassed"])
            self.assertEqual(result["pushStatus"], "pushed")
            self.assertIsNone(result["stuckAt"])

    def test_publish_replay_only_calls_publish(self):
        from modules.strategy_audit import flows

        calls = []

        def fake_change(sid, target, reason="", creator_id=None, approve_id=None, confirm=False):
            calls.append(int(target))
            return {"ok": True, "error": None, "message": None, "approve_id": approve_id, "data": None}

        with mock.patch.object(flows, "change_approve_status", side_effect=fake_change), \
             mock.patch.object(
                 flows,
                 "maybe_push_full",
                 return_value={"ok": True, "skipped": True, "message": "flag false", "error": None},
             ), \
             mock.patch.object(flows.time, "sleep", return_value=None):
            result = flows.run_publish_and_push(
                100, creator_id=1, approve_id=55, publish_retries=1
            )
            self.assertEqual(calls, [2])
            self.assertTrue(result["ok"])
            self.assertEqual(result["pushStatus"], "skipped")
            self.assertIsNone(result["stuckAt"])
            self.assertFalse(result.get("publishBypassed"))


class TestResolveApproveIdReuse(unittest.TestCase):
    def test_change_skips_resolve_when_approve_id_given(self):
        from modules.strategy_audit import resolve

        with mock.patch.object(resolve, "resolve_approve_id") as resolve_mock, \
             mock.patch.object(
                 resolve,
                 "proxy_post",
                 return_value=({"status": 200, "message": "ok"}, None),
             ), \
             mock.patch(
                 "modules.strategy_audit.resolve.check_orient_ok",
                 create=True,
             ):
            # patch check via approve_proxy used inside change_approve_status
            with mock.patch(
                "modules.strategy_audit.approve_proxy.check_orient_ok",
                return_value=(True, None),
            ):
                result = resolve.change_approve_status(
                    24062, 6, reason="x", creator_id=1, approve_id=46102
                )
            resolve_mock.assert_not_called()
            self.assertTrue(result["ok"])
            self.assertEqual(result["approve_id"], 46102)


class TestMaybePushPoll(unittest.TestCase):
    def test_poll_then_push(self):
        from modules.strategy_audit import push_full

        details = [
            ({"status": 4, "displayQuickPushBtn": False}, "flowControl", None),
            ({"status": 4, "displayQuickPushBtn": True}, "flowControl", None),
        ]
        idx = {"i": 0}

        def fake_get(*args, **kwargs):
            i = idx["i"]
            idx["i"] += 1
            return details[min(i, len(details) - 1)]

        with mock.patch.object(push_full, "get_strategy_detail", side_effect=fake_get), \
             mock.patch.object(
                 push_full,
                 "call_quick_push_all",
                 return_value={"ok": True, "skipped": False, "error": None, "message": None, "data": {}},
             ) as call_push, \
             mock.patch.object(push_full.time, "sleep", return_value=None):
            result = push_full.maybe_push_full(1, mode="normal", poll_times=3, poll_interval=0.1)
            self.assertTrue(result["ok"])
            self.assertFalse(result["skipped"])
            self.assertEqual(result.get("pollAttempt"), 2)
            call_push.assert_called_once()

    def test_poll_exhausted_skip(self):
        from modules.strategy_audit import push_full

        with mock.patch.object(
            push_full,
            "get_strategy_detail",
            return_value=({"status": 4, "displayQuickPushBtn": False}, "flowControl", None),
        ), mock.patch.object(push_full, "call_quick_push_all") as call_push, \
             mock.patch.object(push_full.time, "sleep", return_value=None):
            result = push_full.maybe_push_full(1, mode="normal", poll_times=2, poll_interval=0.1)
            call_push.assert_not_called()
            self.assertTrue(result["ok"])
            self.assertTrue(result["skipped"])
            self.assertEqual(result.get("reason"), "flag_false")

    def test_merge_flags_from_approve_embed(self):
        from modules.strategy_audit import push_full

        detail = {"id": 24059, "status": 4, "toolBar": None, "displayQuickPushBtn": None}
        with mock.patch.object(
            push_full,
            "_approve_embed_for_strategy",
            return_value=(
                {
                    "id": 24059,
                    "toolBar": {"displayQuickPushBtn": True},
                    "lastStatus": 8,
                },
                "flowControl",
                {"id": 46242},
            ),
        ):
            merged, prefix = push_full.merge_push_flags_from_approve(detail, 24059, approve_id=46242)
            self.assertEqual(prefix, "flowControl")
            self.assertTrue(merged.get("displayQuickPushBtn"))
            self.assertEqual(merged.get("_pushFlagsFrom"), "approve_embed")
            self.assertTrue(push_full.can_quick_push(merged))


class TestAutoApprovePublishReplayQueue(unittest.TestCase):
    def test_publish_replay_mode_uses_publish_flow(self):
        from modules.strategy_audit import auto_approve

        called = {}

        def fake_query(creator_id, status_val, page_size=100, max_pages=30):
            return {
                "status": 200,
                "data": {"data": [{"id": 77, "ruleId": 23947}], "totalCount": 1},
            }, None

        def fake_pub(*args, **kwargs):
            called["yes"] = True
            return {
                "ok": True,
                "steps": [{"step": "publish_pass", "ok": True}],
                "push": {"ok": True, "skipped": True, "message": "skip"},
                "auditOk": True,
                "publishOk": True,
                "pushStatus": "skipped",
            }

        with mock.patch.object(auto_approve, "query_by_creator", side_effect=fake_query), \
             mock.patch.object(auto_approve, "run_publish_and_push", side_effect=fake_pub), \
             mock.patch.object(auto_approve, "run_normal_flow") as normal, \
             mock.patch.object(auto_approve.time, "sleep", return_value=None):
            ur, _, _ = auto_approve._process_user_queue(1, "u", 6, "publish_replay")
            normal.assert_not_called()
            self.assertTrue(called.get("yes"))
            self.assertEqual(ur["approved"], 1)

    def test_push_skip_does_not_enqueue_stuck_push(self):
        from modules.strategy_audit import auto_approve

        auto_approve._stuck_push.clear()
        ur = {
            "name": "u",
            "id": 1,
            "queue": "normal",
            "pending": 1,
            "approved": 0,
            "failed": 0,
            "pushed": 0,
            "pushSkipped": 0,
        }
        result = {
            "ok": True,
            "auditOk": True,
            "publishOk": True,
            "pushStatus": "skipped",
            "push": {
                "ok": True,
                "skipped": True,
                "reason": "flag_false",
                "message": "不能推全",
            },
            "steps": [],
        }
        with mock.patch.object(auto_approve, "log_add"):
            auto_approve._after_result(100, "normal", result, 1, "u", 9, ur)
            self.assertEqual(len(auto_approve._stuck_push), 0)
        self.assertEqual(ur["pushSkipped"], 1)

    def test_ban_confirm_prompt_retries_with_confirm(self):
        from modules.strategy_audit import flows

        calls = []

        def fake_change(*args, **kwargs):
            calls.append(dict(kwargs))
            if not kwargs.get("confirm"):
                return {
                    "ok": False,
                    "message": "当前配置时间段为封禁期，当前配置需要进行人工审核，是否确认提交审核？",
                    "approve_id": 99,
                }
            return {"ok": True, "approve_id": 99, "message": None}

        with mock.patch.object(flows, "change_approve_status", side_effect=fake_change), \
             mock.patch.object(
                 flows,
                 "maybe_push_full",
                 return_value={"ok": True, "skipped": True, "reason": "flag_false", "message": "skip"},
             ), \
             mock.patch.object(flows.time, "sleep", return_value=None):
            result = flows.run_publish_and_push(23947, approve_id=99, publish_retries=3)
            self.assertTrue(result.get("ok"))
            self.assertTrue(result.get("publishOk"))
            self.assertFalse(result.get("banPublishConfirm"))
            self.assertEqual(len(calls), 2)
            self.assertFalse(calls[0].get("confirm"))
            self.assertTrue(calls[1].get("confirm"))

    def test_ban_confirm_still_pending_skips_stuck_queue(self):
        from modules.strategy_audit import flows

        def fake_change(*args, **kwargs):
            return {
                "ok": False,
                "message": "当前配置时间段为封禁期，需要进行人工审核，是否确认提交审核？",
                "approve_id": 99,
            }

        with mock.patch.object(flows, "change_approve_status", side_effect=fake_change), \
             mock.patch.object(flows.time, "sleep", return_value=None):
            result = flows.run_publish_and_push(23947, approve_id=99, publish_retries=3)
            self.assertTrue(result.get("ok"))
            self.assertTrue(result.get("banPublishConfirm"))
            self.assertTrue(result.get("skipStuckQueue"))
            self.assertIsNone(result.get("stuckAt"))

    def test_normal_flow_propagates_ban_publish_confirm(self):
        from modules.strategy_audit import flows

        with mock.patch.object(
            flows,
            "change_approve_status",
            return_value={"ok": True, "approve_id": 99},
        ), mock.patch.object(
            flows,
            "run_publish_and_push",
            return_value={
                "ok": True,
                "steps": [],
                "push": None,
                "publishOk": False,
                "publishBypassed": False,
                "pushStatus": None,
                "stuckAt": None,
                "skipStuckQueue": True,
                "banPublishConfirm": True,
                "approve_id": 99,
            },
        ), mock.patch.object(flows.time, "sleep", return_value=None):
            result = flows.run_normal_flow(21563, approve_id=99)
            self.assertTrue(result.get("ok"))
            self.assertTrue(result.get("banPublishConfirm"))
            self.assertTrue(result.get("skipStuckQueue"))

    def test_bypass_push_ban_confirm_soft_ok(self):
        from modules.strategy_audit import flows

        def fake_change(*args, **kwargs):
            return {
                "ok": False,
                "message": "操作[发布成功]无法应用于状态[审核成功]",
                "approve_id": 99,
            }

        with mock.patch.object(flows, "change_approve_status", side_effect=fake_change), \
             mock.patch.object(
                 flows,
                 "maybe_push_full",
                 return_value={
                     "ok": False,
                     "skipped": False,
                     "reason": "ban_push_confirm_pending",
                     "message": "当前配置时间段为封禁期，需要进行人工审核，是否确认提交审核？",
                 },
             ), \
             mock.patch.object(flows.time, "sleep", return_value=None):
            result = flows.run_publish_and_push(21563, approve_id=99, publish_retries=1)
            self.assertTrue(result.get("ok"))
            self.assertTrue(result.get("publishBypassed"))
            self.assertTrue(result.get("banPushConfirm"))
            self.assertTrue(result.get("skipStuckQueue"))
            self.assertIsNone(result.get("stuckAt"))


class TestPushBanConfirm(unittest.TestCase):
    def test_push_retries_confirm_then_ban_submit(self):
        from modules.strategy_audit import push_full

        calls = []

        def fake_call(sid, prefix, push_type, confirm=False):
            calls.append({"type": push_type, "confirm": confirm})
            if push_type == 0 and not confirm:
                return {
                    "ok": False,
                    "skipped": False,
                    "message": "当前配置时间段为封禁期，需要进行人工审核，是否确认提交审核？",
                }
            if push_type == 0 and confirm:
                return {
                    "ok": False,
                    "skipped": False,
                    "message": "当前配置时间段为封禁期，需要进行人工审核，是否确认提交审核？",
                }
            if push_type == 1 and confirm:
                return {"ok": True, "skipped": False, "message": None}
            return {"ok": False, "skipped": False, "message": "other"}

        with mock.patch.object(push_full, "call_quick_push_all", side_effect=fake_call):
            result = push_full._push_with_ban_confirm(21563, "flowControl", "normal")
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("reason"), "ban_audit_submitted")
            self.assertEqual(
                [(c["type"], c["confirm"]) for c in calls],
                [(0, False), (0, True), (1, True)],
            )


if __name__ == "__main__":
    unittest.main()
