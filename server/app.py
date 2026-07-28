"""
联盟诊断工作台 - 后端 API 代理服务 (Python)

职责：
  1. 托管前端静态文件（index.html / app.js / styles.css）
  2. 策略查询 /api/strategy/meta、/api/strategy/query（Operation 实时 orientControl/query）
  3. Orient 平台代理：策略延期 / 审核 / 撤回等操作

请求方式（三级降级）：
  优先级1: Playwright API 代理（orient_browser.py）
    - 使用 Playwright Chromium 的 page.request API 发请求
    - 走浏览器网络栈，通过 KSAP 认证
    - 同内网用户均可使用（共享服务端浏览器 session）
    - 需要 SSO 登录（首次启动自动弹出浏览器窗口）

  优先级2: Chrome CDP 代理（chrome_proxy.py）
    - 通过 Chrome DevTools Protocol 注入 fetch 请求
    - 需要用户的 Chrome 开启远程调试端口

  优先级3: urllib 降级模式
    - 直接用 Python urllib 发请求
    - 需要手动配置 Cookie（cookie.json）
    - KSAP 会拦截，大概率失败

Cookie 管理：
  Playwright 模式：浏览器自动管理 Cookie 和 SSO 认证
  Chrome CDP 模式：Chrome 守护线程自动保持登录态
  urllib 模式：从 server/cookie.json 读取手动配置的 Cookie

启动方式：
  python3 server/app.py
  python3 server/app.py 3000
"""

import http.server
import json
import os
import re
import socketserver
import sys
import time
import threading
import urllib.request
import urllib.error
import urllib.parse
from http import HTTPStatus


# ─── Cookie 失效异常 ───
class CookieExpiredError(Exception):
    """上游返回登录页 HTML，说明 Cookie 已过期"""
    pass

from chrome_proxy import fetch_via_chrome, get_chrome_cookie_status as _get_chrome_cookie_status, start_guard
from orient_browser import orient_get as _pw_get, orient_post as _pw_post, ensure_ready as _pw_ensure, get_status as _pw_status
from modules.strategy_query import (
    get_live_meta as _sq_get_meta,
    query_live as _sq_query_live,
    parse_query_message as _sq_parse,
)

# ─── v5.5 新功能分包：策略类型探测模块 ───
# 解决扶持策略查询失败：orientControl/get 对不存在的策略也返回 status=200
# 新模块 server/modules/strategy_probe.py 提供 has_strategy_data 检查
from modules.strategy_probe import has_strategy_data, STRATEGY_API_PREFIXES as _STRATEGY_API_PREFIXES

# ─── v5.8 策略自动延期托管（表驱动） ───
from modules.strategy_postpone.automation_postpone import (
    load_registry as _postpone_load_registry,
    upsert_item as _postpone_upsert_item,
    delete_item as _postpone_delete_item,
    load_editors as _postpone_load_editors,
    upsert_editor as _postpone_upsert_editor,
    delete_editor as _postpone_delete_editor,
    get_operator_perms as _postpone_get_perms,
    get_postpone_status,
    run_postpone_once,
    start_postpone_daemon,
    POSTPONE_INTERVAL,
    POSTPONE_HOUR,
    POSTPONE_MINUTE,
)

# ─── 配置 ───
PORT = int(os.environ.get("PORT", "3000"))

STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# ─── 服务端共享 Cookie 文件（降级模式） ───
SERVER_COOKIE_FILE = os.path.join(os.path.dirname(__file__), "cookie.json")

# ─── v5.6+ 策略审核域（modules/strategy_audit）───
from modules.strategy_audit import (
    change_approve_status as _audit_change_status,
    run_flow as _audit_run_flow,
    push_full_forced as _audit_push_full,
    load_whitelist as _load_realtime_whitelist,
    auto_approve_status as _auto_approve_get_status,
    auto_approve_trigger as _auto_approve_trigger,
    start_auto_approve_daemon as _start_auto_approve_daemon,
    query_by_creator as _audit_query_by_creator,
)
from modules.strategy_audit.auto_approve import AUTO_APPROVE_INTERVAL

# ─── 共享工作台日志（JSONL，最长 30 天）───
from modules.workbench_log import (
    LOG_TYPES as _WB_LOG_TYPES,
    DEFAULT_LIMIT as _WB_LOG_DEFAULT_LIMIT,
    append as _wb_log_append,
    list_logs as _wb_log_list,
    prune_all as _wb_log_prune_all,
    clear_logs as _wb_log_clear,
    delete_logs as _wb_log_delete,
)

# 审核人列表短缓存，避免健康探测/多标签重复打满 Playwright
_AUDIT_USERS_CACHE = {"ts": 0.0, "data": None}
_AUDIT_USERS_CACHE_TTL = 90
_AUDIT_USERS_CACHE_LOCK = threading.Lock()


def _load_server_cookie_file():
    """直接读取 cookie.json 文件（降级模式用）"""
    if not os.path.exists(SERVER_COOKIE_FILE):
        return ""
    try:
        with open(SERVER_COOKIE_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            cookie = (cfg.get("kwabi") or "").strip()
            if "请填写" in cookie:
                cookie = ""
            return _sanitize_cookie_header(cookie)
    except Exception:
        return ""


def _cookie_file_meta():
    """读取 cookie.json 元信息（不回传 Cookie 内容）"""
    meta = {"updatedAt": "", "source": "", "configured": False}
    if not os.path.exists(SERVER_COOKIE_FILE):
        return meta
    try:
        with open(SERVER_COOKIE_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
        cookie = (cfg.get("kwabi") or "").strip()
        if "请填写" in cookie:
            cookie = ""
        meta["updatedAt"] = str(cfg.get("updatedAt") or "")
        meta["source"] = str(cfg.get("source") or "")
        meta["configured"] = bool(_sanitize_cookie_header(cookie))
    except Exception:
        pass
    return meta


def _sanitize_cookie_header(raw):
    """urllib 要求 Cookie 头为 latin-1；含中文占位符时视为未配置。"""
    if not raw:
        return ""
    try:
        raw.encode("latin-1")
        return raw
    except UnicodeEncodeError:
        return ""


def _pw_err_allows_fallback(err):
    """Playwright 失败是否允许降级到 Chrome/urllib。

    上游已明确返回 HTTP 4xx/5xx（非登录失效）时勿假降级：
    urllib 无 KSAP，几乎必然再失败，徒增噪音。
    仅传输层不可用（未启动/超时等）才降级。
    """
    if not err:
        return False
    if err in ("COOKIE_EXPIRED", "SSO_RECOVERING"):
        return False
    if err.startswith("HTTP "):
        # "HTTP 500" / "HTTP 502: ..."
        parts = err.split()
        if len(parts) >= 2:
            code_str = parts[1].split(":", 1)[0]
            if code_str.isdigit():
                code = int(code_str)
                if code >= 400:
                    return False
        return False
    return True


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    """自定义 HTTP 请求处理器，同时处理静态文件和 API 代理"""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("directory", STATIC_DIR)
        super().__init__(*args, **kwargs)

    # ─── 静态文件已由 SimpleHTTPRequestHandler 处理 ───

    def do_GET(self):
        """GET 请求：静态文件 + API"""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/strategy/meta":
            self._handle_strategy_meta()
            return
        if path == "/api/cookie/status":
            self._handle_cookie_status()
            return
        if path == "/api/health":
            self._handle_health()
            return
        # ─── 共享工作台日志 ───
        if path == "/api/workbench/logs":
            self._handle_workbench_logs_get(qs)
            return
        # ─── v5.1 新增：提交审核人列表（不动现有代码） ───
        if path == "/api/strategy/audit/users":
            self._handle_audit_users()
            return
        # ─── v5.6 新增：实时审核白名单（不动现有代码） ───
        if path == "/api/strategy/audit/realtime-whitelist":
            self._handle_realtime_whitelist()
            return
        # ─── v5.7 新增：自动审核状态查询 ───
        if path == "/api/strategy/audit/auto-approve/status":
            self._handle_auto_approve_status()
            return
        # ─── v5.8 自动延期托管表 / 权限 / 状态 ───
        if path == "/api/strategy/postpone/registry":
            self._handle_postpone_registry_get()
            return
        if path == "/api/strategy/postpone/editors":
            self._handle_postpone_editors_get()
            return
        if path == "/api/strategy/postpone/status":
            self._handle_postpone_status()
            return
        # 静态资源：去掉 query，避免 ?v= 影响文件查找
        self.path = path
        super().do_GET()

    # ─── /api/cookie/status ───
    def _handle_cookie_status(self):
        pw_status = _pw_status()
        pw_login_ok = pw_status.get("loginOk", False)

        if pw_status.get("initialized"):
            chrome_status = {"available": False, "hasCookie": False}
        else:
            chrome_status = _get_chrome_cookie_status()
        chrome_available = chrome_status.get("available", False)
        chrome_has_cookie = chrome_status.get("hasCookie", False)

        server_cookie = _load_server_cookie_file()
        server_configured = bool(server_cookie)

        if pw_login_ok:
            source = "playwright"
            hint = "Playwright API 代理（推荐，同内网用户可用，Cookie 自动续期）"
        elif chrome_available and chrome_has_cookie:
            source = "chrome"
            hint = "Chrome CDP 代理模式（请求通过 Chrome 代发，Cookie 自动续期）"
        elif chrome_available:
            source = "chrome-partial"
            hint = "Chrome 已启动但未登录 Orient，部分功能可能受限"
        elif pw_status.get("initialized") and not pw_login_ok:
            source = "playwright-needs-login"
            hint = "Playwright 浏览器已启动但未登录 SSO，请在弹出的浏览器窗口中完成登录"
        elif server_configured:
            source = "server"
            hint = "Playwright/Chrome 均不可用，使用 cookie.json 降级模式（可能因 KSAP 校验失败）"
        else:
            source = "none"
            hint = "未配置：服务端 Playwright 浏览器会自动弹出登录窗口"

        try:
            self._send_json(200, {
                "success": True,
                "data": {
                    "source": source,
                    "serverConfigured": server_configured,
                    "chromeAvailable": chrome_available,
                    "chromeHasCookie": chrome_has_cookie,
                    "playwrightReady": pw_login_ok,
                    "threadAlive": bool(pw_status.get("threadAlive")),
                    "cookieUpdatedAt": _cookie_file_meta().get("updatedAt") or "",
                    "hint": hint,
                },
            })
        except BrokenPipeError:
            pass

    def _handle_health(self):
        """轻量健康检查：不打 Orient，专供前端状态面板，避免拖死 Playwright"""
        pw = _pw_status()
        cookie_meta = _cookie_file_meta()
        thread_alive = bool(pw.get("threadAlive"))
        ok = bool(pw.get("initialized") and pw.get("loginOk") and thread_alive)
        self._send_json(200, {
            "success": True,
            "data": {
                "ok": ok,
                "playwrightReady": bool(pw.get("loginOk")),
                "playwrightInitialized": bool(pw.get("initialized")),
                "threadAlive": thread_alive,
                "queueDepth": int(pw.get("queueDepth") or 0),
                "ssoWaiting": bool(pw.get("ssoWaiting")),
                "cookieUpdatedAt": cookie_meta.get("updatedAt") or "",
                "cookieSource": cookie_meta.get("source") or "",
            },
        })

    def do_POST(self):
        """POST 请求：代理 API"""
        if self.path == "/api/workbench/logs":
            self._handle_workbench_logs_post()
        elif self.path == "/api/strategy/query":
            self._handle_strategy_query()
        elif self.path == "/api/strategy/renew/get":
            self._handle_orient_get()
        elif self.path == "/api/strategy/renew/submit":
            self._handle_orient_submit()
        elif self.path == "/api/strategy/audit/get":
            self._handle_orient_get()  # 复用 GET 详情
        elif self.path == "/api/strategy/audit/withdraw":
            self._handle_orient_withdraw()
        elif self.path == "/api/strategy/audit/query":
            self._handle_orient_get()
        elif self.path == "/api/strategy/audit/changeStatus":
            self._handle_approve_proxy("changeStatus")
        elif self.path == "/api/strategy/audit/batchPass":
            self._handle_approve_batch()
        elif self.path == "/api/strategy/audit/flow":
            self._handle_audit_flow()
        elif self.path == "/api/strategy/audit/pushFull":
            self._handle_audit_push_full()
        # ─── v5.1 新增：按提交审核人查询（不动现有代码） ───
        elif self.path == "/api/strategy/audit/queryByCreator":
            self._handle_audit_query_by_creator()
        # ─── v5.7 新增：手动触发自动审核 ───
        elif self.path == "/api/strategy/audit/auto-approve/trigger":
            self._handle_auto_approve_trigger()
        # ─── v5.8 自动延期托管写接口 ───
        elif self.path == "/api/strategy/postpone/registry/upsert":
            self._handle_postpone_registry_upsert()
        elif self.path == "/api/strategy/postpone/registry/delete":
            self._handle_postpone_registry_delete()
        elif self.path == "/api/strategy/postpone/editors/upsert":
            self._handle_postpone_editors_upsert()
        elif self.path == "/api/strategy/postpone/editors/delete":
            self._handle_postpone_editors_delete()
        elif self.path == "/api/strategy/postpone/trigger":
            self._handle_postpone_trigger()
        else:
            self._send_json(404, {"success": False, "error": "Not found"})

    def do_OPTIONS(self):
        """CORS preflight"""
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    # ─── /api/strategy/meta ───
    def _handle_strategy_meta(self):
        try:
            meta = _sq_get_meta()
            # 初次进入可能尚未查询过
            if not meta.get("dataAsOfText"):
                meta = {
                    "mode": "live",
                    "source": "operation-tool orientControl/query",
                    "total": 0,
                    "dataAsOfText": "",
                    "dataAsOf": "",
                    "hint": "用户查询时实时请求 Operation 平台",
                }
            self._send_json(200, {"success": True, "data": meta})
        except Exception as e:
            self._send_json(500, {"success": False, "error": str(e)})

    # ─── /api/strategy/query ───
    def _handle_strategy_query(self):
        body = self._read_json_body()
        if body is None:
            return

        message = (body.get("message") or "").strip()
        developer_ids = body.get("developerIds") or []
        pos_ids = body.get("posIds") or []
        app_ids = body.get("appIds") or []

        try:
            if message:
                parsed_result = _sq_parse(message)
                developer_ids = parsed_result["developerIds"] or developer_ids
                pos_ids = parsed_result["posIds"] or pos_ids
                app_ids = parsed_result["appIds"] or app_ids
                parsed_display = parsed_result["parsed"]
            else:
                parsed_display = {}

            if not developer_ids and not pos_ids and not app_ids:
                self._send_json(400, {
                    "success": False,
                    "error": "请提供开发者ID、广告位ID 或 应用ID",
                })
                return

            result, meta = _sq_query_live(
                developer_ids=developer_ids,
                pos_ids=pos_ids,
                app_ids=app_ids,
                hydrate=True,
            )
            self._send_json(200, {
                "success": True,
                "data": {
                    "parsed": parsed_display,
                    "matchedBy": result.get("matchedBy") or {},
                    "total": result.get("total") or 0,
                    "fields": [],
                    "rows": result.get("rows") or [],
                    "meta": meta,
                },
            })
        except RuntimeError as e:
            msg = str(e)
            if msg == "COOKIE_EXPIRED":
                self._send_json(401, {
                    "success": False,
                    "error": "COOKIE_EXPIRED",
                    "message": "Orient 未登录或 Cookie 过期，请先在服务端完成 Operation 登录",
                })
                return
            self._send_json(502, {"success": False, "error": msg})
        except Exception as e:
            print(f"[strategy-live] error: {e}")
            self._send_json(500, {"success": False, "error": str(e)})

    # ─── 通用 Chrome 代理请求 ───
    def _chrome_proxy_get(self, url):
        """通过 Chrome 代理发 GET 请求，返回解析后的 JSON 或错误"""
        result = fetch_via_chrome(url, method="GET")
        return self._process_chrome_result(result)

    def _chrome_proxy_post(self, url, body):
        """通过 Chrome 代理发 POST 请求，返回解析后的 JSON 或错误"""
        result = fetch_via_chrome(url, method="POST", body=body)
        return self._process_chrome_result(result)

    def _process_chrome_result(self, result):
        """处理 Chrome 代理返回的结果"""
        if result is None:
            return None, "Chrome 代理不可用（Chrome 未启动或调试端口未开启）"

        if not result.get("ok"):
            error = result.get("error", "未知错误")
            status = result.get("status", 0)
            if status == 401:
                return None, "COOKIE_EXPIRED"
            return None, error

        body_text = result.get("body", "")
        if not body_text:
            return None, "空响应"

        try:
            return json.loads(body_text), None
        except json.JSONDecodeError:
            if self._is_login_html(body_text):
                return None, "COOKIE_EXPIRED"
            return None, f"非 JSON 响应: {body_text[:100]}"

    # ─── 降级模式：urllib 直接请求 ───
    def _urllib_get(self, url, cookie_header=None):
        """降级：用 urllib 发 GET 请求"""
        if not cookie_header:
            cookie_header = self._get_cookie_header_fallback()
        if not cookie_header:
            return None, "COOKIE_EXPIRED"

        try:
            req = urllib.request.Request(
                url,
                headers={"Cookie": cookie_header},
                method="GET",
            )
            opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)
            # 不跟随重定向，检测 302
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    raise urllib.error.HTTPError(newurl, code, msg, headers, fp)
            opener = urllib.request.build_opener(NoRedirect)
            try:
                with opener.open(req, timeout=15) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                    if self._is_login_html(raw):
                        return None, "COOKIE_EXPIRED"
                    return json.loads(raw), None
            except urllib.error.HTTPError as e:
                if e.code in (301, 302):
                    return None, "COOKIE_EXPIRED"
                if e.code in (401, 403):
                    return None, "COOKIE_EXPIRED"
                detail = e.read().decode("utf-8", errors="replace")[:500]
                return None, f"HTTP {e.code}: {detail[:200]}"
        except Exception as e:
            return None, str(e)

    def _urllib_post(self, url, body, cookie_header=None):
        """降级：用 urllib 发 POST 请求"""
        if not cookie_header:
            cookie_header = self._get_cookie_header_fallback()
        if not cookie_header:
            return None, "COOKIE_EXPIRED"

        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(body).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Cookie": cookie_header,
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                if self._is_login_html(raw):
                    return None, "COOKIE_EXPIRED"
                return json.loads(raw), None
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return None, "COOKIE_EXPIRED"
            detail = e.read().decode("utf-8", errors="replace")[:500]
            return None, f"HTTP {e.code}: {detail[:200]}"
        except Exception as e:
            return None, str(e)

    def _get_cookie_header_fallback(self):
        """降级模式获取 Cookie"""
        x_kwabi_cookie = self.headers.get("X-Kwabi-Cookie", "")
        if x_kwabi_cookie:
            return _sanitize_cookie_header(x_kwabi_cookie)
        cookie = self.headers.get("Cookie", "")
        if cookie:
            return _sanitize_cookie_header(cookie)
        return _load_server_cookie_file()

    # ─── Playwright 代理请求（策略延期专用） ───
    def _pw_proxy_get(self, url, timeout=30):
        """通过 Playwright 发 GET 请求"""
        path = url.replace("https://operation-tool.corp.kuaishou.com/operation-tool/rest", "")
        result = _pw_get(path, timeout=timeout)
        return self._process_pw_result(result)

    def _pw_proxy_post(self, url, body):
        """通过 Playwright 发 POST 请求"""
        path = url.replace("https://operation-tool.corp.kuaishou.com/operation-tool/rest", "")
        result = _pw_post(path, body)
        return self._process_pw_result(result)

    def _process_pw_result(self, result):
        """处理 Playwright 代理返回的结果
        
        v4.1: Playwright 内部已实现 SSO 自愈和请求重试，
        所以这里不需要特殊处理 COOKIE_EXPIRED——如果 Playwright
        返回了 COOKIE_EXPIRED，说明 SSO 自愈也失败了。
        """
        if result is None:
            return None, "Playwright 代理不可用"
        if not result.get("ok"):
            error = result.get("error", "未知错误")
            status = result.get("status", 0)
            if error == "SSO_RECOVERING":
                return None, "SSO_RECOVERING"
            if status == 401 or error == "COOKIE_EXPIRED":
                return None, "COOKIE_EXPIRED"
            return None, error
        try:
            return json.loads(result.get("body", "")), None
        except json.JSONDecodeError:
            # 非 JSON 但 HTTP 200，可能是登录页 HTML
            body = result.get("body", "")
            if self._is_login_html(body):
                return None, "COOKIE_EXPIRED"
            return None, f"JSON 解析失败: {body[:100]}"

    # ─── /api/strategy/renew/get ───
    # ─── 策略类型 API 映射 ───
    # Orient 平台不同策略类型使用不同的 API 前缀
    STRATEGY_API_PREFIXES = [
        ("orientControl", "定向策略"),   # /operation-tool/rest/orientControl/get
        ("flowControl",   "扶持策略"),   # /operation-tool/rest/flowControl/get
        ("darkControl",   "暗投策略"),   # /operation-tool/rest/darkControl/get
        ("generalControl", "综合策略"),  # /operation-tool/rest/generalControl/get
        ("mediaControl",  "媒体策略"),   # /operation-tool/rest/mediaControl/get
    ]

    def _handle_orient_get(self):
        """查询策略详情——自动探测策略类型

        依次尝试 orientControl → flowControl → darkControl → …
        哪个 API 返回 status==200 就用哪个，无需用户手动指定策略类型。
        """
        body = self._read_json_body()
        if body is None:
            return
        strategy_id = body.get("id")
        if not strategy_id:
            self._send_json(400, {"success": False, "error": "id is required"})
            return

        # 依次尝试每种策略类型的 API
        for api_prefix, type_label in self.STRATEGY_API_PREFIXES:
            upstream_url = (
                f"https://operation-tool.corp.kuaishou.com"
                f"/operation-tool/rest/{api_prefix}/get?id={strategy_id}"
            )
            print(f"[orient] GET {upstream_url}  (尝试: {type_label})")

            resp_data, err = self._pw_proxy_get(upstream_url)

            if err == "COOKIE_EXPIRED":
                self._send_json(401, {
                    "success": False,
                    "error": "COOKIE_EXPIRED",
                    "message": "Orient 未登录，请在浏览器窗口中登录",
                })
                return

            if err and resp_data is None:
                if not _pw_err_allows_fallback(err):
                    print(f"[orient] Playwright 上游错误 ({err})，跳过假降级，继续下一类型")
                    continue
                print(f"[orient] Playwright 失败 ({err})，降级 Chrome 代理")
                resp_data, err = self._chrome_proxy_get(upstream_url)

                if err == "COOKIE_EXPIRED":
                    self._send_json(401, {
                        "success": False,
                        "error": "COOKIE_EXPIRED",
                        "message": "Chrome 未登录 Orient 平台",
                    })
                    return

                if err and resp_data is None:
                    print(f"[orient] Chrome 代理也失败 ({err})，降级 urllib")
                    cookie_header = self._get_cookie_header_fallback()
                    resp_data, err = self._urllib_get(upstream_url, cookie_header)
                    if err:
                        if err == "COOKIE_EXPIRED":
                            self._send_json(401, {
                                "success": False,
                                "error": "COOKIE_EXPIRED",
                                "message": "Cookie 已过期或未登录",
                            })
                            return
                        # urllib 也失败，继续尝试下一个策略类型
                        continue

            ok, err_msg = self._check_orient_status(resp_data)
            if ok:
                # v5.5 修复：status=200 但 data 为空时继续尝试下一个类型
                # Orient 的 orientControl/get 对不存在的策略也返回 status=200，
                # 但 data 字段为空。需要用 has_strategy_data 二次校验。
                if not has_strategy_data(resp_data):
                    print(f"[orient] {type_label} API 返回空壳 (status=200 但 data 为空)，继续尝试…")
                    continue
                # 在返回数据中标注策略类型
                if resp_data and isinstance(resp_data, dict):
                    resp_data["_strategyType"] = type_label
                    resp_data["_apiPrefix"] = api_prefix
                self._send_json(200, {"success": True, "data": resp_data})
                return
            else:
                # 该类型 API 查不到，继续尝试下一个
                print(f"[orient] {type_label} API 未命中 ({err_msg})，继续尝试…")
                continue

        # 所有策略类型都试过了，还是没找到
        self._send_json(200, {
            "success": False,
            "error": "STRATEGY_NOT_FOUND",
            "message": f"策略 #{strategy_id} 在所有策略类型中均未找到（定向/扶持/暗投/综合/媒体）",
        })

    # ─── /api/strategy/renew/submit ───
    def _handle_orient_submit(self):
        body = self._read_json_body()
        if body is None:
            return
        strategy_id = body.get("id")
        strategy_body = body.get("body")
        if not strategy_id or not strategy_body:
            self._send_json(400, {"success": False, "error": "id and body are required"})
            return

        upstream_url = (
            f"https://operation-tool.corp.kuaishou.com"
            f"/operation-tool/rest/orientControl/mergeEditV2"
        )
        print(f"[orient] POST {upstream_url} id={strategy_id}")

        # 优先使用 Playwright 代理（API 模式）
        resp_data, err = self._pw_proxy_post(upstream_url, strategy_body)

        if err == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录，请在浏览器窗口中登录",
            })
            return

        if err and resp_data is None:
            if not _pw_err_allows_fallback(err):
                print(f"[orient] Playwright 上游错误 ({err})，跳过假降级")
                self._send_json(502, {"success": False, "error": err})
                return
            # 降级到 Chrome CDP 代理
            print(f"[orient] Playwright 失败 ({err})，降级 Chrome 代理")
            resp_data, err = self._chrome_proxy_post(upstream_url, strategy_body)

            if err == "COOKIE_EXPIRED":
                self._send_json(401, {
                    "success": False,
                    "error": "COOKIE_EXPIRED",
                    "message": "Chrome 未登录 Orient 平台",
                })
                return

            if err and resp_data is None:
                # 再降级到 urllib
                print(f"[orient] Chrome 代理也失败 ({err})，降级 urllib")
                cookie_header = self._get_cookie_header_fallback()
                resp_data, err = self._urllib_post(upstream_url, strategy_body, cookie_header)
                if err:
                    if err == "COOKIE_EXPIRED":
                        self._send_json(401, {
                            "success": False,
                            "error": "COOKIE_EXPIRED",
                            "message": "Cookie 已过期或未登录",
                        })
                    else:
                        self._send_json(500, {"success": False, "error": err})
                    return

        ok, err_msg = self._check_orient_status(resp_data)
        if ok:
            self._send_json(200, {"success": True, "data": resp_data})
        else:
            self._send_json(200, {"success": False, "error": "ORIENT_FAILED", "message": err_msg, "data": resp_data})

    # ─── /api/strategy/audit/withdraw ───
    def _handle_orient_withdraw(self):
        body = self._read_json_body()
        if body is None:
            return
        strategy_id = body.get("id")
        if not strategy_id:
            self._send_json(400, {"success": False, "error": "id is required"})
            return

        upstream_url = (
            f"https://operation-tool.corp.kuaishou.com"
            f"/operation-tool/rest/orientControl/withdraw"
        )
        print(f"[orient] POST withdraw id={strategy_id}")

        payload = {"id": int(strategy_id)}

        # 三级降级代理：Playwright → Chrome CDP → urllib
        resp_data, err = self._proxy_post_for_approve(upstream_url, payload)

        if err == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录，请登录后重试",
            })
            return

        if err and resp_data is None:
            self._send_json(500, {"success": False, "error": err})
            return

        ok, err_msg = self._check_orient_status(resp_data)
        if ok:
            self._send_json(200, {"success": True, "data": resp_data})
        else:
            self._send_json(200, {"success": False, "error": "ORIENT_FAILED", "message": err_msg, "data": resp_data})

    def _proxy_post_with_fallback(self, url, payload, cookie_header=None):
        """统一三级降级 POST：Playwright → Chrome CDP → urllib

        策略延期和审核模块共用此方法，确保同网用户可通过 Playwright 共享 session 使用。
        上游 HTTP 4xx/5xx（非登录）不降级。
        """
        # 优先级1: Playwright API 代理
        resp_data, err = self._pw_proxy_post(url, payload)
        if err != "COOKIE_EXPIRED" and (resp_data is not None or err is None):
            if err is None or resp_data is not None:
                return resp_data, err

        if err == "COOKIE_EXPIRED":
            return None, "COOKIE_EXPIRED"

        if not _pw_err_allows_fallback(err):
            print(f"[proxy] Playwright 上游错误 ({err})，跳过假降级")
            return None, err

        # 优先级2: Chrome CDP 代理
        print(f"[proxy] Playwright 失败 ({err})，降级 Chrome 代理")
        resp_data, err = self._chrome_proxy_post(url, payload)
        if err == "COOKIE_EXPIRED":
            return None, "COOKIE_EXPIRED"
        if err and resp_data is None:
            # 优先级3: urllib 降级
            print(f"[proxy] Chrome 代理也失败 ({err})，降级 urllib")
            if not cookie_header:
                cookie_header = self._get_cookie_header_fallback()
            resp_data, err = self._urllib_post(url, payload, cookie_header)
            if err:
                if err == "COOKIE_EXPIRED":
                    return None, "COOKIE_EXPIRED"
                return None, err

        return resp_data, err

    def _proxy_post_for_approve(self, url, payload):
        """审核模块专用 POST：三级降级 + COOKIE_EXPIRED 返回标记

        与 _proxy_post_with_fallback 类似，但返回 (data, error) 格式，
        error 为 'COOKIE_EXPIRED' 时前端可感知。
        """
        # 优先级1: Playwright API 代理
        resp_data, err = self._pw_proxy_post(url, payload)

        if err == "COOKIE_EXPIRED":
            return None, "COOKIE_EXPIRED"

        if err and resp_data is None:
            if not _pw_err_allows_fallback(err):
                print(f"[approve] Playwright 上游错误 ({err})，跳过假降级")
                return None, err
            # 优先级2: Chrome CDP 代理
            print(f"[approve] Playwright 失败 ({err})，降级 Chrome 代理")
            resp_data, err = self._chrome_proxy_post(url, payload)

            if err == "COOKIE_EXPIRED":
                return None, "COOKIE_EXPIRED"

            if err and resp_data is None:
                # 优先级3: urllib 降级
                print(f"[approve] Chrome 代理也失败 ({err})，降级 urllib")
                cookie_header = self._get_cookie_header_fallback()
                resp_data, err = self._urllib_post(url, payload, cookie_header)
                if err:
                    if err == "COOKIE_EXPIRED":
                        return None, "COOKIE_EXPIRED"
                    return None, err

        return resp_data, err

    # ─── /api/strategy/audit/changeStatus（委托 strategy_audit）───
    def _handle_approve_proxy(self, action):
        body = self._read_json_body()
        if body is None:
            return
        strategy_id = body.get("id")
        target_status = body.get("status")
        if strategy_id is None or target_status is None:
            self._send_json(400, {"success": False, "error": "id and status are required"})
            return

        result = _audit_change_status(
            strategy_id,
            target_status,
            reason=body.get("reason", ""),
            creator_id=body.get("creatorId"),
            approve_id=body.get("approveId"),
        )
        if result.get("error") == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": result.get("message") or "Orient 未登录，请登录后重试",
            })
            return
        if result.get("ok"):
            self._send_json(200, {"success": True, "data": result.get("data")})
        else:
            self._send_json(200, {
                "success": False,
                "error": result.get("error") or "ORIENT_FAILED",
                "message": result.get("message"),
                "data": result.get("data"),
            })

    # ─── /api/strategy/audit/batchPass ───
    def _handle_approve_batch(self):
        body = self._read_json_body()
        if body is None:
            return
        ids = body.get("ids", [])
        if not ids:
            self._send_json(400, {"success": False, "error": "ids is required"})
            return
        status_val = body.get("status")
        if status_val is None:
            self._send_json(400, {"success": False, "error": "status is required"})
            return

        results = []
        errors = []
        for strategy_id in ids:
            result = _audit_change_status(strategy_id, int(status_val), reason=body.get("reason", ""))
            if result.get("error") == "COOKIE_EXPIRED":
                self._send_json(401, {
                    "success": False,
                    "error": "COOKIE_EXPIRED",
                    "message": "Orient 未登录，请登录后重试",
                })
                return
            if result.get("ok"):
                results.append({"id": strategy_id, "success": True, "data": result.get("data")})
            else:
                errors.append({
                    "id": strategy_id,
                    "error": result.get("message") or result.get("error"),
                    "detail": result.get("data"),
                })

        self._send_json(200, {
            "success": len(errors) == 0,
            "data": {
                "results": results,
                "errors": errors,
                "total": len(ids),
                "successCount": len(results),
                "errorCount": len(errors),
            }
        })

    # ─── /api/strategy/audit/flow ───
    def _handle_audit_flow(self):
        body = self._read_json_body()
        if body is None:
            return
        strategy_id = body.get("id")
        if strategy_id is None:
            self._send_json(400, {"success": False, "error": "id is required"})
            return
        mode = body.get("mode") or "normal"
        if mode not in ("normal", "ban", "publish_replay"):
            self._send_json(400, {"success": False, "error": "mode must be normal|ban|publish_replay"})
            return
        result = _audit_run_flow(
            strategy_id,
            mode=mode,
            reason_prefix=body.get("reason", ""),
            creator_id=body.get("creatorId"),
            approve_id=body.get("approveId"),
        )
        cookie_fail = any(
            (s or {}).get("error") == "COOKIE_EXPIRED"
            for s in (result.get("steps") or [])
        ) or (result.get("push") or {}).get("error") == "COOKIE_EXPIRED"
        if cookie_fail:
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录，请登录后重试",
            })
            return
        # 编排结果放在 data；success 表示请求层成功，业务成败看 data.ok / stuckAt
        self._send_json(200, {
            "success": True,
            "data": result,
            "message": None if result.get("ok") else (
                ((result.get("steps") or [{}])[-1] or {}).get("message")
                or "审核编排未完全成功"
            ),
        })

    # ─── /api/strategy/audit/pushFull ───
    def _handle_audit_push_full(self):
        body = self._read_json_body()
        if body is None:
            return
        strategy_id = body.get("id")
        if strategy_id is None:
            self._send_json(400, {"success": False, "error": "id is required"})
            return
        mode = body.get("mode") or "normal"
        if mode not in ("normal", "ban"):
            self._send_json(400, {"success": False, "error": "mode must be normal|ban"})
            return
        result = _audit_push_full(strategy_id, mode=mode)
        if result.get("error") == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录，请登录后重试",
            })
            return
        self._send_json(200, {
            "success": bool(result.get("ok")),
            "data": result,
            "message": result.get("message"),
            "error": result.get("error"),
        })

    # ═══════════════════════════════════════════════════════
    #  共享工作台日志（JSONL，最长 30 天，全员可见）
    # ═══════════════════════════════════════════════════════

    def _handle_workbench_logs_get(self, qs):
        log_type = (qs.get("type") or [""])[0].strip().lower()
        if not log_type:
            self._send_json(400, {
                "success": False,
                "error": "type is required",
                "types": list(_WB_LOG_TYPES),
            })
            return
        try:
            limit_raw = (qs.get("limit") or [str(_WB_LOG_DEFAULT_LIMIT)])[0]
            limit = int(limit_raw)
        except (TypeError, ValueError):
            limit = _WB_LOG_DEFAULT_LIMIT
        since_ts = None
        if qs.get("since"):
            try:
                since_ts = int((qs.get("since") or ["0"])[0])
            except (TypeError, ValueError):
                since_ts = None
        try:
            items = _wb_log_list(log_type, since_ts=since_ts, limit=limit)
        except ValueError as e:
            self._send_json(400, {"success": False, "error": str(e)})
            return
        except Exception as e:
            self._send_json(500, {"success": False, "error": str(e)})
            return
        self._send_json(200, {
            "success": True,
            "data": {"type": log_type, "items": items, "count": len(items)},
        })

    def _handle_workbench_logs_post(self):
        body = self._read_json_body()
        if body is None:
            return
        log_type = (body.get("type") or "").strip().lower()
        action = (body.get("action") or "").strip().lower()

        # 清空 / 按 id 删除（失败日志等需手动清理）
        if action in ("clear", "delete"):
            if not log_type:
                self._send_json(400, {
                    "success": False,
                    "error": "type is required",
                    "types": list(_WB_LOG_TYPES),
                })
                return
            try:
                if action == "clear":
                    removed = _wb_log_clear(log_type)
                else:
                    ids = body.get("ids")
                    if not isinstance(ids, list):
                        self._send_json(400, {"success": False, "error": "ids must be a list"})
                        return
                    removed = _wb_log_delete(log_type, ids)
            except ValueError as e:
                self._send_json(400, {"success": False, "error": str(e)})
                return
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
                return
            self._send_json(200, {
                "success": True,
                "data": {"type": log_type, "action": action, "removed": removed},
            })
            return

        text = body.get("text")
        meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
        op = (
            (self.headers.get("X-Postpone-Operator") or "").strip()
            or (body.get("operator") or "").strip()
        )
        ts = body.get("ts")
        try:
            entry = _wb_log_append(
                log_type,
                text if isinstance(text, str) else str(text or ""),
                operator=op,
                meta=meta,
                ts=int(ts) if ts is not None else None,
            )
        except ValueError as e:
            self._send_json(400, {"success": False, "error": str(e)})
            return
        except Exception as e:
            self._send_json(500, {"success": False, "error": str(e)})
            return
        self._send_json(200, {"success": True, "data": entry})

    # ═══════════════════════════════════════════════════════
    #  v5.1 新增：提交审核人维度审核（不动现有代码）
    #
    #  新增两个接口：
    #    GET  /api/strategy/audit/users         — 获取提交审核人列表
    #    POST /api/strategy/audit/queryByCreator — 按审核人查询待审核策略
    #
    #  复用现有三级降级代理（Playwright → Chrome CDP → urllib），
    #  确保同网用户通过 Playwright 共享 session 直接可用。
    #  SSO 自动保活机制（orient_browser.py 心跳）确保永久可用。
    # ═══════════════════════════════════════════════════════

    # ─── /api/strategy/audit/realtime-whitelist ───
    def _handle_realtime_whitelist(self):
        """返回当前实时审核白名单列表（支持热更新）"""
        whitelist = _load_realtime_whitelist()
        self._send_json(200, {"success": True, "data": whitelist})

    # ─── /api/strategy/audit/auto-approve/status ───
    def _handle_auto_approve_status(self):
        """返回自动审核引擎状态：运行中/上次结果/日志"""
        self._send_json(200, {"success": True, "data": _auto_approve_get_status()})

    # ─── /api/strategy/audit/auto-approve/trigger ───
    def _handle_auto_approve_trigger(self):
        """手动触发一次自动审核（不等守护线程轮询）"""
        ok, err = _auto_approve_trigger()
        if not ok:
            self._send_json(200, {
                "success": False,
                "error": err or "ALREADY_RUNNING",
                "message": "自动审核正在执行中，请稍后",
            })
            return
        self._send_json(200, {
            "success": True,
            "message": "自动审核已触发，请通过 /api/strategy/audit/auto-approve/status 查看进度",
        })

    # ═══════════════════════════════════════════════════════
    #  v5.8 策略自动延期托管（表驱动 + 编辑权限）
    # ═══════════════════════════════════════════════════════

    def _postpone_operator(self):
        return (self.headers.get("X-Postpone-Operator") or "").strip()

    def _handle_postpone_registry_get(self):
        op = self._postpone_operator()
        perms = _postpone_get_perms(op)
        data = _postpone_load_registry()
        self._send_json(200, {
            "success": True,
            "data": {
                "items": data.get("items") or [],
                "perms": perms,
            },
        })

    def _handle_postpone_editors_get(self):
        op = self._postpone_operator()
        perms = _postpone_get_perms(op)
        editors = _postpone_load_editors()
        self._send_json(200, {
            "success": True,
            "data": {
                "admins": editors.get("admins") or [],
                "editors": editors.get("editors") or [],
                "perms": perms,
            },
        })

    def _handle_postpone_status(self):
        self._send_json(200, {"success": True, "data": get_postpone_status()})

    def _handle_postpone_registry_upsert(self):
        body = self._read_json_body()
        if body is None:
            return
        op = self._postpone_operator() or (body.get("operator") or "").strip()
        perms = _postpone_get_perms(op)
        if not perms.get("canEdit"):
            self._send_json(403, {
                "success": False,
                "error": "FORBIDDEN",
                "message": "无编辑权限：请填写操作人账号，并确认已在编辑白名单中（admins 为空时填写账号即可开放编辑）",
                "perms": perms,
            })
            return
        sid = body.get("strategy_id")
        if sid is None:
            self._send_json(400, {"success": False, "error": "strategy_id is required"})
            return
        try:
            item = _postpone_upsert_item(
                int(sid),
                enabled=bool(body.get("enabled", True)),
                owner=str(body.get("owner") or ""),
                renew_months=int(body.get("renew_months") or 1),
                note=str(body.get("note") or ""),
                operator=op,
            )
            self._send_json(200, {"success": True, "data": item, "perms": perms})
        except Exception as e:
            self._send_json(500, {"success": False, "error": str(e)})

    def _handle_postpone_registry_delete(self):
        body = self._read_json_body()
        if body is None:
            return
        op = self._postpone_operator() or (body.get("operator") or "").strip()
        perms = _postpone_get_perms(op)
        if not perms.get("canEdit"):
            self._send_json(403, {
                "success": False,
                "error": "FORBIDDEN",
                "message": "无编辑权限",
                "perms": perms,
            })
            return
        sid = body.get("strategy_id")
        if sid is None:
            self._send_json(400, {"success": False, "error": "strategy_id is required"})
            return
        ok = _postpone_delete_item(int(sid))
        if not ok:
            self._send_json(404, {"success": False, "error": "NOT_FOUND", "message": f"策略 {sid} 不在托管表中"})
            return
        self._send_json(200, {"success": True, "deleted": int(sid)})

    def _handle_postpone_editors_upsert(self):
        body = self._read_json_body()
        if body is None:
            return
        op = self._postpone_operator() or (body.get("operator") or "").strip()
        perms = _postpone_get_perms(op)
        if not perms.get("canManageEditors"):
            self._send_json(403, {
                "success": False,
                "error": "FORBIDDEN",
                "message": "仅管理员可维护编辑权限（开放模式下需先填写操作人账号）",
                "perms": perms,
            })
            return
        name = (body.get("name") or "").strip()
        if not name:
            self._send_json(400, {"success": False, "error": "name is required"})
            return
        as_admin = bool(body.get("asAdmin", False))
        data = _postpone_upsert_editor(name, as_admin=as_admin, operator=op)
        self._send_json(200, {
            "success": True,
            "data": data,
            "perms": _postpone_get_perms(op),
        })

    def _handle_postpone_editors_delete(self):
        body = self._read_json_body()
        if body is None:
            return
        op = self._postpone_operator() or (body.get("operator") or "").strip()
        perms = _postpone_get_perms(op)
        if not perms.get("canManageEditors"):
            self._send_json(403, {
                "success": False,
                "error": "FORBIDDEN",
                "message": "仅管理员可维护编辑权限",
                "perms": perms,
            })
            return
        name = (body.get("name") or "").strip()
        if not name:
            self._send_json(400, {"success": False, "error": "name is required"})
            return
        data = _postpone_delete_editor(name, operator=op)
        self._send_json(200, {
            "success": True,
            "data": data,
            "perms": _postpone_get_perms(op),
        })

    def _handle_postpone_trigger(self):
        status = get_postpone_status()
        if status.get("running"):
            self._send_json(200, {
                "success": False,
                "error": "ALREADY_RUNNING",
                "message": "自动延期正在执行中",
            })
            return

        def _run():
            run_postpone_once()

        threading.Thread(target=_run, daemon=True, name="postpone-trigger").start()
        self._send_json(200, {"success": True, "message": "已触发自动延期扫描"})

    # ─── /api/strategy/audit/users ───
    def _handle_audit_users(self):
        """获取提交审核人列表——代理 Orient common/listUser

        复用三级降级 GET 代理（与 _handle_orient_get 相同模式）。
        同网用户通过 Playwright 共享 session 直接可用。
        """
        now = time.time()
        with _AUDIT_USERS_CACHE_LOCK:
            cached = _AUDIT_USERS_CACHE.get("data")
            if cached is not None and (now - float(_AUDIT_USERS_CACHE.get("ts") or 0)) < _AUDIT_USERS_CACHE_TTL:
                self._send_json(200, {"success": True, "data": cached, "cached": True})
                return

        upstream_url = (
            "https://operation-tool.corp.kuaishou.com"
            "/operation-tool/rest/common/listUser"
        )
        print(f"[audit-users] GET {upstream_url}")

        # 优先 Playwright
        resp_data, err = self._pw_proxy_get(upstream_url, timeout=15)

        if err == "SSO_RECOVERING":
            self._send_json(503, {
                "success": False,
                "error": "SSO_RECOVERING",
                "message": "Orient 登录恢复中，请 10 秒后刷新",
            })
            return

        if err == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录，请在浏览器窗口中登录",
            })
            return

        if err and resp_data is None:
            if not _pw_err_allows_fallback(err):
                print(f"[audit-users] Playwright 上游错误 ({err})，跳过假降级")
                self._send_json(502, {"success": False, "error": err})
                return
            # 降级 Chrome CDP
            print(f"[audit-users] Playwright 失败 ({err})，降级 Chrome 代理")
            resp_data, err = self._chrome_proxy_get(upstream_url)
            if err == "COOKIE_EXPIRED":
                self._send_json(401, {
                    "success": False,
                    "error": "COOKIE_EXPIRED",
                    "message": "Chrome 未登录 Orient 平台",
                })
                return
            if err and resp_data is None:
                # 降级 urllib
                print(f"[audit-users] Chrome 代理也失败 ({err})，降级 urllib")
                cookie_header = self._get_cookie_header_fallback()
                resp_data, err = self._urllib_get(upstream_url, cookie_header)
                if err:
                    if err == "COOKIE_EXPIRED":
                        self._send_json(401, {
                            "success": False,
                            "error": "COOKIE_EXPIRED",
                            "message": "Cookie 已过期或未登录",
                        })
                    else:
                        self._send_json(500, {"success": False, "error": err})
                    return

        ok, err_msg = self._check_orient_status(resp_data)
        if ok:
            user_list = (resp_data or {}).get("data", {}).get("userList", [])
            with _AUDIT_USERS_CACHE_LOCK:
                _AUDIT_USERS_CACHE["ts"] = time.time()
                _AUDIT_USERS_CACHE["data"] = user_list
            self._send_json(200, {"success": True, "data": user_list})
        else:
            self._send_json(200, {
                "success": False,
                "error": "ORIENT_FAILED",
                "message": err_msg,
                "data": resp_data,
            })

    # ─── /api/strategy/audit/queryByCreator ───
    def _handle_audit_query_by_creator(self):
        """按提交审核人查询审核记录——复用 approve/query 接口

        请求体: {creatorId: 1780492464, status: 1}
          - creatorId: 提交审核人的数字ID（从 listUser 获取）
          - status: 审核状态（1=待审核, 6=审核通过, 等），默认 1

        approve/query 支持 creatorId 过滤（不支持 creatorName 字符串过滤）。
        复用 _proxy_post_for_approve 三级降级代理，确保同网用户可用。

        v5.6 说明：白名单仅用于后台自动审核守护线程；手动查询接口不做白名单拦截。
        """
        body = self._read_json_body()
        if body is None:
            return
        creator_id = body.get("creatorId")
        if not creator_id:
            self._send_json(400, {"success": False, "error": "creatorId is required"})
            return

        status_val = body.get("status", 1)  # 默认查待审核
        page_size = body.get("pageSize", 100)
        print(
            f"[audit-by-creator] query_by_creator "
            f"creatorId={creator_id} status={status_val} pageSize={page_size}"
        )

        # 与自动审共用翻页实现，避免 >100 条截断
        resp_data, err = _audit_query_by_creator(
            creator_id, status_val, page_size=int(page_size)
        )

        if err == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录，请登录后重试",
            })
            return

        if err and resp_data is None:
            self._send_json(500, {"success": False, "error": err})
            return

        ok, err_msg = self._check_orient_status(resp_data)
        if ok:
            records = (resp_data or {}).get("data", {}).get("data", [])
            total = (resp_data or {}).get("data", {}).get("totalCount", len(records))
            self._send_json(200, {
                "success": True,
                "data": {
                    "records": records,
                    "total": total,
                    "creatorId": creator_id,
                    "status": status_val,
                }
            })
        else:
            self._send_json(200, {
                "success": False,
                "error": "ORIENT_FAILED",
                "message": err_msg,
                "data": resp_data,
            })

    # ─── Orient 业务响应检查 ───
    def _check_orient_status(self, resp_data):
        """检查 Orient 业务状态码，status==200 才认为成功"""
        if resp_data is None:
            return False, "空响应"
        orient_status = resp_data.get("status")
        if orient_status == 200:
            return True, None
        msg = resp_data.get("message", f"Orient 返回业务状态码 {orient_status}")
        return False, msg

    # ─── 检测上游响应是否为登录页（Cookie 失效） ───
    def _is_login_html(self, raw_text):
        if not raw_text:
            return False
        head = raw_text[:500].lstrip().lower()
        return (
            head.startswith("<!doctype")
            or head.startswith("<html")
            or "sso_login" in head
            or "passport/login" in head
            or "<title>登录" in head
            or "<title>sso" in head
        )

    # ─── 工具方法 ───
    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._send_json(400, {"success": False, "error": "Empty body"})
            return None
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"success": False, "error": "Invalid JSON"})
            return None

    def _send_json(self, status, data):
        try:
            self.send_response(status)
            self._set_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Kwabi-Cookie, X-Postpone-Operator")
        self.send_header("Access-Control-Allow-Credentials", "true")

    def log_message(self, format, *args):
        """精简日志输出"""
        print(f"[http] {args[0]}" if args else "")


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    if "--port" in sys.argv:
        idx = sys.argv.index("--port")
        if idx + 1 < len(sys.argv):
            port = int(sys.argv[idx + 1])

    strategy_info = "实时查询（Operation orientControl/query）"

    # 测试 :3001 — 仅 HTTP + 静态资源，不预启任何后台功能线程
    staging_lite = port == 3001 or os.environ.get("WORKBENCH_STAGING_LITE") == "1"

    try:
        pruned = _wb_log_prune_all()
        print(f"  共享日志已加载（保留≤30天）: {pruned}")
    except Exception as e:
        print(f"  ⚠ 共享日志 prune 失败: {e}")

    from orient_browser import start as _pw_start, get_status as _pw_status

    if staging_lite:
        print("  ⚠ 测试环境：仅启动 Orient Playwright；不启 Chrome 守护 / 自动审核 / 自动延期")
        _pw_start()
        pw_status = _pw_status()
    else:
        # 启动 Playwright 浏览器（API 模式代理）
        _pw_start()
        pw_status = _pw_status()
        start_guard()
        _start_auto_approve_daemon()
        start_postpone_daemon()

    # 检查 Chrome 状态
    chrome_status = _get_chrome_cookie_status()
    
    if pw_status.get("loginOk"):
        mode_hint = "Playwright API 代理（推荐，同内网用户可用）"
    elif chrome_status.get("available") and chrome_status.get("hasCookie"):
        mode_hint = "Chrome CDP 代理 + Playwright API"
    elif chrome_status.get("available"):
        mode_hint = "Chrome 未登录 Orient，请登录"
    else:
        mode_hint = "Playwright API + 降级模式"

    # 获取本机内网 IP
    import socket as _socket
    try:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "127.0.0.1"

    # 设置 SO_REUSEADDR 避免端口占用问题
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer(("", port), ProxyHandler) as server:
        print(f"\n  🚀 联盟诊断工作台后端已启动 (Python)")
        print(f"  🌐 本机访问: http://localhost:{port}")
        print(f"  🌐 内网访问: http://{local_ip}:{port}  (同内网用户可打开)")
        print(f"  📁 静态文件: {STATIC_DIR}")
        print(f"  📊 策略数据: {strategy_info}")
        print(f"  🔧 请求模式: {mode_hint}")
        print(f"  🌐 Playwright: {'✓ 已就绪' if pw_status.get('loginOk') else '需登录 (python3 server/orient_browser.py --login)'}")
        print(f"  🛡 降级模式: Chrome CDP / urllib")
        if staging_lite:
            print(f"  🤖 自动审核: 未启动（测试精简模式）")
            print(f"  ⏱  自动延期: 未启动（测试精简模式）")
        else:
            print(f"  🤖 自动审核: 已启动 (间隔 {AUTO_APPROVE_INTERVAL} 秒)")
            print(
            f"  ⏱  自动延期: 已启动 (每天 {POSTPONE_HOUR:02d}:{POSTPONE_MINUTE:02d} 定点扫描，"
            f"剩余≤7 自然日自动延)"
        )
        print(f"  💡 提示: Playwright API 模式下同内网用户可直接使用\n")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n  🛑 服务已停止")
            server.server_close()


if __name__ == "__main__":
    main()
