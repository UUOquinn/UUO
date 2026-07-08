"""
联盟诊断工作台 - 后端 API 代理服务 (Python)

职责：
  1. 托管前端静态文件（index.html / app.js / styles.css）
  2. 代理 /api/dataset/query  → KwaiBI datasetDataQuery
  3. 代理 /api/dataset/metadata → KwaiBI metadataSearchV2
  4. 策略查询 /api/strategy/meta、/api/strategy/query（本地 Excel 导入数据）
  5. Orient 平台代理：策略延期 / 审核 / 撤回等操作

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

数据集：
  85587  — 离线主效果
  129496 — 实时主效果
  207512 — 请求链路过滤原因
  103846 — 召回/粗排/精排漏斗

启动方式：
  python3 server/app.py
  python3 server/app.py 3000
"""

import http.server
import json
import os
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
from strategy_data import store, parse_query_message

# ─── 配置 ───
PORT = int(os.environ.get("PORT", "3000"))
KWABI_BASE = os.environ.get(
    "KWABI_BASE", "https://kwaibi.corp.kuaishou.com"
)
DATASET_QUERY_PATH = os.environ.get(
    "DATASET_QUERY_PATH", "/api/v1/dataset/data/query"
)
METADATA_SEARCH_PATH = os.environ.get(
    "METADATA_SEARCH_PATH", "/api/v1/dataset/metadata/search"
)

STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# ─── 服务端共享 Cookie 文件（降级模式） ───
SERVER_COOKIE_FILE = os.path.join(os.path.dirname(__file__), "cookie.json")


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
            return cookie
    except Exception:
        return ""


# ─── 数据集列表 ───
DATASETS = [
    {
        "id": "85587",
        "name": "离线主效果数据",
        "type": "offline",
        "description": "T-1 及历史数据，对比口径：目标日 vs 前一天",
    },
    {
        "id": "129496",
        "name": "实时主效果数据",
        "type": "realtime",
        "description": "当天实时累计，对比口径：今日当前累计 vs 昨日同时间段",
    },
    {
        "id": "207512",
        "name": "请求链路过滤原因",
        "type": "drill",
        "description": "有效请求率下降时下钻，查过滤比/过滤次数/请求承接率",
    },
    {
        "id": "103846",
        "name": "召回/粗排/精排漏斗",
        "type": "drill",
        "description": "有效填充率下降时下钻，查召粗精混前曝漏斗通过率",
    },
]

# ─── 筛选字段中文→英文字段映射 ───
FILTER_FIELD_MAP = {
    "uid": "开发者id",
    "app_id": "应用id",
    "pos_id": "广告位id",
    "ad_style": "广告场景",
}


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    """自定义 HTTP 请求处理器，同时处理静态文件和 API 代理"""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("directory", STATIC_DIR)
        super().__init__(*args, **kwargs)

    # ─── 静态文件已由 SimpleHTTPRequestHandler 处理 ───

    def do_GET(self):
        """GET 请求：静态文件 + API"""
        if self.path == "/api/dataset/list":
            self._send_json(200, {"success": True, "data": DATASETS})
            return
        if self.path == "/api/strategy/meta":
            self._handle_strategy_meta()
            return
        if self.path == "/api/cookie/status":
            self._handle_cookie_status()
            return
        super().do_GET()

    # ─── /api/cookie/status ───
    def _handle_cookie_status(self):
        pw_status = _pw_status()
        pw_login_ok = pw_status.get("loginOk", False)

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

        self._send_json(200, {
            "success": True,
            "data": {
                "source": source,
                "serverConfigured": server_configured,
                "chromeAvailable": chrome_available,
                "chromeHasCookie": chrome_has_cookie,
                "playwrightReady": pw_login_ok,
                "hint": hint,
            },
        })

    def do_POST(self):
        """POST 请求：代理 API"""
        if self.path == "/api/dataset/query":
            self._handle_dataset_query()
        elif self.path == "/api/dataset/metadata":
            self._handle_dataset_metadata()
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
            meta = store.get_meta()
            self._send_json(200, {"success": True, "data": meta})
        except FileNotFoundError as e:
            self._send_json(404, {"success": False, "error": str(e)})
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
                parsed_result = parse_query_message(message)
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

            result = store.query(
                developer_ids=developer_ids,
                pos_ids=pos_ids,
                app_ids=app_ids,
            )
            meta = store.get_meta()
            self._send_json(200, {
                "success": True,
                "data": {
                    "parsed": parsed_display,
                    "matchedBy": result["matchedBy"],
                    "total": result["total"],
                    "fields": meta.get("fields", []),
                    "rows": result["rows"],
                },
            })
        except FileNotFoundError as e:
            self._send_json(404, {"success": False, "error": str(e)})
        except Exception as e:
            print(f"[strategy] error: {e}")
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
            return x_kwabi_cookie
        cookie = self.headers.get("Cookie", "")
        if cookie:
            return cookie
        return _load_server_cookie_file()

    # ─── /api/dataset/query ───
    def _handle_dataset_query(self):
        body = self._read_json_body()
        if body is None:
            return

        dataset_id = body.get("datasetId")
        if not dataset_id:
            self._send_json(400, {"success": False, "error": "datasetId is required"})
            return

        kwabi_payload = self._build_kwabi_payload(body)
        upstream_url = f"{KWABI_BASE}{DATASET_QUERY_PATH}"
        print(f"[proxy] POST {upstream_url} dataset={dataset_id}")

        # 优先使用 Chrome 代理
        resp_data, err = self._chrome_proxy_post(upstream_url, kwabi_payload)

        if err == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Chrome 未登录或 Cookie 已过期，请重新登录",
            })
            return

        if err and resp_data is None:
            # Chrome 代理失败，尝试降级
            print(f"[proxy] Chrome 代理失败 ({err})，尝试降级 urllib")
            resp_data, err = self._urllib_post(upstream_url, kwabi_payload)
            if err:
                if err == "COOKIE_EXPIRED":
                    self._send_json(401, {
                        "success": False,
                        "error": "COOKIE_EXPIRED",
                        "message": "Cookie 已过期或未登录，请启动 Chrome 并登录内网",
                    })
                else:
                    self._send_json(500, {"success": False, "error": err})
                return

        normalized = self._normalize_response(resp_data)
        self._send_json(200, {"success": True, "data": normalized})

    # ─── /api/dataset/metadata ───
    def _handle_dataset_metadata(self):
        body = self._read_json_body()
        if body is None:
            return

        dataset_id = body.get("datasetId")
        if not dataset_id:
            self._send_json(400, {"success": False, "error": "datasetId is required"})
            return

        upstream_url = f"{KWABI_BASE}{METADATA_SEARCH_PATH}"
        print(f"[proxy] POST {upstream_url} dataset={dataset_id}")

        # 优先使用 Chrome 代理
        resp_data, err = self._chrome_proxy_post(upstream_url, {"datasetId": dataset_id})

        if err == "COOKIE_EXPIRED":
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Chrome 未登录或 Cookie 已过期，请重新登录",
            })
            return

        if err and resp_data is None:
            # Chrome 代理失败，尝试降级
            resp_data, err = self._urllib_post(upstream_url, {"datasetId": dataset_id})
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

    # ─── Playwright 代理请求（策略延期专用） ───
    def _pw_proxy_get(self, url):
        """通过 Playwright 发 GET 请求"""
        path = url.replace("https://operation-tool.corp.kuaishou.com/operation-tool/rest", "")
        result = _pw_get(path)
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
        """
        # 优先级1: Playwright API 代理
        resp_data, err = self._pw_proxy_post(url, payload)
        if err != "COOKIE_EXPIRED" and (resp_data is not None or err is None):
            if err is None or resp_data is not None:
                return resp_data, err

        if err == "COOKIE_EXPIRED":
            return None, "COOKIE_EXPIRED"

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

    # ─── 策略ID → 审核记录ID 转换 ───
    # approve/changeStatus 接口的 id 参数是审核记录 ID，不是策略 ID
    # 需要先查询 approve/query 获取审核记录 ID
    def _resolve_approve_id(self, strategy_id, approve_status=None):
        """通过 approve/query 查询审核记录 ID

        Args:
            strategy_id: 策略 ID（ruleId）
            approve_status: 审核状态过滤（1=待审核, 3=审核驳回, 6=审核通过, 等）
                            如果为 None，搜索所有状态

        Returns:
            (approve_id, error_msg) — approve_id 为 None 表示未找到
        """
        approve_url = (
            "https://operation-tool.corp.kuaishou.com"
            "/operation-tool/rest/approve/query"
        )

        # 如果指定了审核状态，直接查询
        if approve_status is not None:
            payload = {"pager": {"pageNum": 1, "pageSize": 100}, "status": approve_status}
            resp_data, err = self._proxy_post_for_approve(approve_url, payload)
            if err:
                return None, f"查询审核记录失败: {err}"
            if resp_data:
                records = resp_data.get("data", {}).get("data", [])
                for r in records:
                    if r.get("ruleId") == int(strategy_id):
                        return r.get("id"), None
            return None, f"策略 #{strategy_id} 在审核状态 {approve_status} 下未找到审核记录"

        # 未指定审核状态，搜索所有常见状态
        for status_val in [1, 2, 3, 6, 7, 10]:
            payload = {"pager": {"pageNum": 1, "pageSize": 100}, "status": status_val}
            resp_data, err = self._proxy_post_for_approve(approve_url, payload)
            if err:
                continue
            if resp_data:
                records = resp_data.get("data", {}).get("data", [])
                for r in records:
                    if r.get("ruleId") == int(strategy_id):
                        return r.get("id"), None

        return None, f"策略 #{strategy_id} 未找到审核记录（可能未提交审核）"

    # ─── /api/strategy/audit/changeStatus ───
    def _handle_approve_proxy(self, action):
        body = self._read_json_body()
        if body is None:
            return

        strategy_id = body.get("id")
        target_status = body.get("status")

        # 关键：approve/changeStatus 的 id 是审核记录 ID，不是策略 ID
        # 需要先查询 approve/query 获取审核记录 ID
        # 根据目标操作推断审核状态：
        #   审核通过(6)/审核驳回(3) → 查待审核(1)
        #   同意发布(2)/拒绝发布(7) → 查审核通过(6)
        query_status = 1 if target_status in (6, 3) else 6
        approve_id, resolve_err = self._resolve_approve_id(strategy_id, query_status)

        if resolve_err:
            # 尝试搜索所有状态
            approve_id, resolve_err = self._resolve_approve_id(strategy_id)

        if approve_id is None:
            self._send_json(200, {
                "success": False,
                "error": "APPROVE_NOT_FOUND",
                "message": resolve_err,
            })
            return

        # 用审核记录 ID 替换策略 ID
        payload = {
            "id": approve_id,  # 审核记录 ID
            "status": target_status,
            "reason": body.get("reason", ""),
        }

        upstream_url = (
            f"https://operation-tool.corp.kuaishou.com"
            f"/operation-tool/rest/approve/{action}"
        )
        print(f"[approve] POST {action} strategy_id={strategy_id} → approve_id={approve_id} status={target_status}")

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
        cookie_expired = False
        for strategy_id in ids:
            target_status = int(status_val)

            # 策略ID → 审核记录ID
            query_status = 1 if target_status in (6, 3) else 6
            approve_id, resolve_err = self._resolve_approve_id(strategy_id, query_status)
            if approve_id is None:
                approve_id, resolve_err = self._resolve_approve_id(strategy_id)

            if approve_id is None:
                errors.append({"id": strategy_id, "error": resolve_err})
                continue

            upstream_url = (
                f"https://operation-tool.corp.kuaishou.com"
                f"/operation-tool/rest/approve/changeStatus"
            )
            payload = {"id": approve_id, "status": target_status, "reason": body.get("reason", "")}

            # 三级降级代理：Playwright → Chrome CDP → urllib
            resp_data, err = self._proxy_post_for_approve(upstream_url, payload)

            if err == "COOKIE_EXPIRED":
                cookie_expired = True
                break

            if err:
                errors.append({"id": strategy_id, "error": err})
            else:
                ok, err_msg = self._check_orient_status(resp_data)
                if ok:
                    results.append({"id": strategy_id, "success": True, "data": resp_data})
                else:
                    errors.append({"id": strategy_id, "error": err_msg, "detail": resp_data})

        if cookie_expired:
            self._send_json(401, {
                "success": False,
                "error": "COOKIE_EXPIRED",
                "message": "Orient 未登录，请登录后重试",
            })
            return

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

    # ─── 构建转发请求体 ───
    def _build_kwabi_payload(self, body):
        payload = {"datasetId": str(body.get("datasetId", ""))}

        if body.get("metrics"):
            payload["metrics"] = body["metrics"]

        if body.get("dimensions"):
            payload["dimensions"] = body["dimensions"]

        filters = body.get("filters", {})
        filter_list = []

        for key, field_name in FILTER_FIELD_MAP.items():
            values = filters.get(key, [])
            if values:
                filter_list.append({
                    "field": field_name,
                    "operator": "IN",
                    "value": values,
                })

        time_filter = filters.get("__time")
        if time_filter:
            filter_list.append({
                "field": "__time",
                "operator": "BETWEEN",
                "value": [time_filter.get("start", ""), time_filter.get("end", "")],
            })

        if filter_list:
            payload["filters"] = filter_list

        if body.get("compareTime"):
            payload["compareTime"] = body["compareTime"]

        if body.get("limit"):
            payload["limit"] = body["limit"]

        return payload

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

    # ─── 标准化上游响应 ───
    def _normalize_response(self, raw):
        inner = raw.get("data", raw)
        columns = inner.get("columns", inner.get("header", []))
        rows = inner.get("rows", inner.get("data", inner.get("result", [])))
        total = inner.get("total", len(rows))
        return {"columns": columns, "rows": rows, "total": total}

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
        self.send_response(status)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Kwabi-Cookie")
        self.send_header("Access-Control-Allow-Credentials", "true")

    def log_message(self, format, *args):
        """精简日志输出"""
        print(f"[http] {args[0]}" if args else "")


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

    try:
        strategy_meta = store.load()
        strategy_info = f"{strategy_meta['total']} 条策略"
    except Exception as e:
        strategy_info = f"未加载 ({e})"

    # 启动 Playwright 浏览器（API 模式代理）
    # 浏览器在专属线程中运行，通过 queue 与 HTTP 服务器通信
    from orient_browser import start as _pw_start, get_status as _pw_status
    _pw_start()
    
    pw_status = _pw_status()
    
    # 启动 Chrome 守护线程（降级模式）
    start_guard()

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

    with http.server.HTTPServer(("", port), ProxyHandler) as server:
        print(f"\n  🚀 联盟诊断工作台后端已启动 (Python)")
        print(f"  📡 代理目标: {KWABI_BASE}")
        print(f"  🌐 本机访问: http://localhost:{port}")
        print(f"  🌐 内网访问: http://{local_ip}:{port}  (同内网用户可打开)")
        print(f"  📋 数据集: 85587 / 129496 / 207512 / 103846")
        print(f"  📁 静态文件: {STATIC_DIR}")
        print(f"  📊 策略数据: {strategy_info}")
        print(f"  🔧 请求模式: {mode_hint}")
        print(f"  🌐 Playwright: {'✓ 已就绪' if pw_status.get('loginOk') else '需登录 (python3 server/orient_browser.py --login)'}")
        print(f"  🛡 降级模式: Chrome CDP / urllib")
        print(f"  💡 提示: Playwright API 模式下同内网用户可直接使用\n")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n  🛑 服务已停止")
            server.server_close()


if __name__ == "__main__":
    main()
