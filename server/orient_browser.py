"""
orient_browser.py — Playwright 浏览器代理模块 v5.1

v5.1 彻底解决 SSO 过期问题：
  - 心跳保活：每 5 分钟自动刷新 Orient 页面，保持 SSO session 不过期
  - 请求方式：page.request API（与浏览器共享 Cookie）
  - 关键修复：请求前先 page.goto 确保页面在 Orient 域名下，
    这样 page.request 使用的 Cookie 才是最新的 SSO session
  - SSO 过期时自动弹窗等登录，登录后自动恢复
  - 请求失败后 SSO 自愈 + 重试

线程安全方案：
  Playwright 对象必须在使用它的线程中创建和操作。
  我们用一个专属线程运行 Playwright 事件循环，
  其他线程通过 queue 传递请求和接收结果。
"""

import json
import os
import time
import threading
import queue

# ─── 配置 ───
SESSION_DIR = os.environ.get(
    "ORIENT_SESSION_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "orient_session")
)

# ─── 心跳保活间隔（秒）───
HEARTBEAT_INTERVAL = 300  # 5 分钟

# ─── SSO 登录等待超时（秒） ───
SSO_WAIT_TIMEOUT = 120

# ─── 请求队列 ───
_request_queue = queue.Queue()
_response_events = {}  # request_id → threading.Event
_response_data = {}    # request_id → result dict
_request_counter = 0
_request_lock = threading.Lock()

# ─── 全局状态 ───
_initialized = False
_login_ok = False
_browser_thread = None
_sso_waiting = False
_last_heartbeat = 0
_status = {
    "source": "playwright",
    "initialized": False,
    "loginOk": False,
    "ssoWaiting": False,
    "sessionDir": SESSION_DIR,
}


def _next_request_id():
    global _request_counter
    with _request_lock:
        _request_counter += 1
        return f"req_{_request_counter}"


def _send_request(method, path, body=None, timeout=30):
    """向 Playwright 线程发送请求，等待结果"""
    req_id = _next_request_id()
    event = threading.Event()
    _response_events[req_id] = event
    _response_data[req_id] = None

    _request_queue.put({
        "id": req_id,
        "method": method,
        "path": path,
        "body": body,
        "timeout": timeout,
    })

    # 等待结果（留出 SSO 自愈时间）
    wait_timeout = timeout + SSO_WAIT_TIMEOUT + 10
    if event.wait(timeout=wait_timeout):
        result = _response_data.pop(req_id, None)
        _response_events.pop(req_id, None)
        return result
    else:
        _response_events.pop(req_id, None)
        _response_data.pop(req_id, None)
        return {"ok": False, "status": 0, "body": "", "error": "请求超时"}


def orient_get(path, timeout=30):
    """发 GET 请求到 Orient API（线程安全）"""
    return _send_request("GET", path, None, timeout)


def orient_post(path, body, timeout=30):
    """发 POST 请求到 Orient API（线程安全）"""
    return _send_request("POST", path, body, timeout)


def get_status():
    """获取浏览器代理状态"""
    return _status.copy()


def ensure_ready():
    """确保浏览器已初始化且已登录"""
    return _initialized and _login_ok


# ─── Playwright 专属线程 ───

def _browser_thread_main():
    """Playwright 线程主函数——创建浏览器、处理请求、心跳保活"""
    global _initialized, _login_ok, _status, _last_heartbeat

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[orient_browser] Playwright 未安装")
        return

    os.makedirs(SESSION_DIR, exist_ok=True)

    try:
        pw = sync_playwright().start()
        context = pw.chromium.launch_persistent_context(
            SESSION_DIR,
            headless=False,
            viewport={"width": 1280, "height": 800},
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            ignore_default_args=["--enable-automation"],
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/136.0.0.0 Safari/537.36"
            ),
        )

        page = context.pages[0] if context.pages else context.new_page()
        _initialized = True
        _status["initialized"] = True
        print("[orient_browser] Chromium 已启动（非 headless）")

        # 自动检查登录
        _check_and_wait_login(page, timeout=SSO_WAIT_TIMEOUT)

        _last_heartbeat = time.time()

        # 主循环：处理请求 + 心跳保活
        while True:
            try:
                req = _request_queue.get(timeout=5)
                if req is None:
                    break

                result = _handle_request(page, req)
                _response_data[req["id"]] = result
                _response_events[req["id"]].set()

            except queue.Empty:
                # 没有请求，检查心跳
                _do_heartbeat(page)
                continue
            except Exception as e:
                print(f"[orient_browser] 请求处理异常: {e}")

        context.close()
        pw.stop()

    except Exception as e:
        print(f"[orient_browser] 浏览器线程异常: {e}")
        _initialized = False
        _status["initialized"] = False


# ─── 心跳保活 ───

def _do_heartbeat(page):
    """心跳保活：定期刷新 Orient 页面，保持 SSO session 不过期"""
    global _login_ok, _last_heartbeat, _status

    now = time.time()
    if now - _last_heartbeat < HEARTBEAT_INTERVAL:
        return

    _last_heartbeat = now

    try:
        page.goto(
            "https://operation-tool.corp.kuaishou.com/home",
            timeout=15000,
            wait_until="domcontentloaded"
        )
        url = page.url

        if "sso" in url.lower() or "login" in url.lower():
            _login_ok = False
            _status["loginOk"] = False
            print("[orient_browser] 💓 心跳检测：SSO 已过期，等待重新登录…")

            deadline = time.time() + SSO_WAIT_TIMEOUT
            while time.time() < deadline:
                try:
                    url = page.url
                    if "operation-tool" in url and "sso" not in url.lower():
                        _login_ok = True
                        _status["loginOk"] = True
                        print("[orient_browser] 💓 心跳检测：SSO 重新登录成功")
                        return
                except Exception:
                    pass
                time.sleep(2)

            print("[orient_browser] 💓 心跳检测：SSO 登录等待超时")
        else:
            _login_ok = True
            _status["loginOk"] = True
            print("[orient_browser] 💓 心跳保活：SSO session 已刷新")

    except Exception as e:
        print(f"[orient_browser] 💓 心跳异常: {e}")


# ─── SSO 登录检查 ───

def _check_and_wait_login(page, timeout=SSO_WAIT_TIMEOUT):
    """检查登录状态，如需要则等待用户在浏览器窗口中完成 SSO 登录"""
    global _login_ok, _sso_waiting, _status

    try:
        page.goto(
            "https://operation-tool.corp.kuaishou.com/home",
            timeout=20000,
            wait_until="domcontentloaded"
        )
        url = page.url

        if "sso" in url.lower() or "login" in url.lower():
            _login_ok = False
            _sso_waiting = True
            _status["loginOk"] = False
            _status["ssoWaiting"] = True
            print("[orient_browser] ⚠️ SSO 已过期，需要重新登录！")
            print("[orient_browser]    浏览器窗口已弹出，请在窗口中完成内网 SSO 登录")
            print(f"[orient_browser]    登录成功后 API 将立即可用（等待最多 {timeout} 秒）")

            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    url = page.url
                    if "operation-tool" in url and "sso" not in url.lower():
                        _login_ok = True
                        _sso_waiting = False
                        _status["loginOk"] = True
                        _status["ssoWaiting"] = False
                        print("[orient_browser] ✓ SSO 登录成功！API 已恢复")
                        return
                except Exception:
                    pass
                time.sleep(2)

            _sso_waiting = False
            _status["ssoWaiting"] = False
            print(f"[orient_browser] ✗ SSO 登录等待超时（{timeout}秒）")
        else:
            _login_ok = True
            _status["loginOk"] = True
            print("[orient_browser] ✓ 已登录 Orient")

    except Exception as e:
        print(f"[orient_browser] 登录检查失败: {e}")
        _login_ok = False
        _sso_waiting = False
        _status["loginOk"] = False
        _status["ssoWaiting"] = False


# ─── SSO 自愈 ───

def _try_sso_recovery(page):
    """SSO 自愈：导航到 Orient 首页，等待用户重新登录"""
    global _login_ok, _sso_waiting, _status

    if _sso_waiting:
        deadline = time.time() + SSO_WAIT_TIMEOUT
        while time.time() < deadline:
            if _login_ok:
                return True
            time.sleep(1)
        return False

    _sso_waiting = True
    _status["ssoWaiting"] = True
    print("[orient_browser] 🔄 SSO 过期，自动触发重新登录…")

    try:
        page.goto(
            "https://operation-tool.corp.kuaishou.com/home",
            timeout=15000,
            wait_until="domcontentloaded"
        )

        url = page.url
        if "sso" not in url.lower() and "login" not in url.lower():
            _login_ok = True
            _sso_waiting = False
            _status["loginOk"] = True
            _status["ssoWaiting"] = False
            print("[orient_browser] ✓ SSO 自动恢复成功")
            _last_heartbeat = time.time()
            return True

        print("[orient_browser] ⚠️ 请在弹出的浏览器窗口中完成 SSO 登录！")
        deadline = time.time() + SSO_WAIT_TIMEOUT
        while time.time() < deadline:
            try:
                url = page.url
                if "operation-tool" in url and "sso" not in url.lower():
                    _login_ok = True
                    _sso_waiting = False
                    _status["loginOk"] = True
                    _status["ssoWaiting"] = False
                    print("[orient_browser] ✓ SSO 重新登录成功！API 已恢复")
                    _last_heartbeat = time.time()
                    return True
            except Exception:
                pass
            time.sleep(2)

    except Exception as e:
        print(f"[orient_browser] SSO 恢复异常: {e}")

    _sso_waiting = False
    _status["ssoWaiting"] = False
    print(f"[orient_browser] ✗ SSO 重新登录超时（{SSO_WAIT_TIMEOUT}秒）")
    return False


# ─── 请求处理（v5.1 核心改造）───

def _ensure_page_on_orient(page):
    """确保页面在 Orient 域名下
    
    v5.1 关键修复：
      page.request 使用的 Cookie 取决于当前页面域名。
      如果页面不在 operation-tool 域名下，Cookie 不会发送。
      所以在每次发请求前，先确保页面在 Orient 域名上。
    """
    try:
        current_url = page.url
        if "operation-tool.corp.kuaishou.com" not in current_url:
            page.goto(
                "https://operation-tool.corp.kuaishou.com/home",
                timeout=15000,
                wait_until="domcontentloaded"
            )
    except Exception as e:
        print(f"[orient_browser] 确保页面在 Orient 域名失败: {e}")


def _handle_request(page, req):
    """在 Playwright 线程中处理单个请求

    v5.1 核心改造：
      1. 请求前先确保页面在 Orient 域名下（Cookie 同步关键）
      2. 使用 page.request API 发请求（不再用 page.evaluate + fetch）
      3. 请求失败后自动 SSO 自愈 + 重试
    """
    global _login_ok, _status

    method = req["method"]
    path = req["path"]
    body = req.get("body")
    timeout = req.get("timeout", 30)

    # 步骤 1：确保页面在 Orient 域名下（Cookie 同步关键！）
    _ensure_page_on_orient(page)

    # 步骤 2：检查页面 URL 判断是否需要 SSO 登录
    try:
        current_url = page.url
        if "sso" in current_url.lower() or "login" in current_url.lower():
            _login_ok = False
            _status["loginOk"] = False
            if not _try_sso_recovery(page):
                return {"ok": False, "status": 401, "body": "", "error": "COOKIE_EXPIRED"}
    except Exception:
        pass

    # 步骤 3：发请求
    url = "https://operation-tool.corp.kuaishou.com/operation-tool/rest" + path

    try:
        if method == "GET":
            resp = page.request.get(url, timeout=timeout * 1000)
        else:
            resp = page.request.post(url, data=body, timeout=timeout * 1000)

        if not resp.ok:
            if resp.status in (401, 403):
                _login_ok = False
                _status["loginOk"] = False

                # SSO 自愈 + 重试
                if _try_sso_recovery(page):
                    _ensure_page_on_orient(page)
                    if method == "GET":
                        resp = page.request.get(url, timeout=timeout * 1000)
                    else:
                        resp = page.request.post(url, data=body, timeout=timeout * 1000)

                    if resp.ok:
                        return {"ok": True, "status": resp.status, "body": resp.text(), "error": None}
                    else:
                        body_text = resp.text()[:500]
                        return {"ok": False, "status": resp.status, "body": body_text, "error": f"HTTP {resp.status}"}

                return {"ok": False, "status": 401, "body": "", "error": "COOKIE_EXPIRED"}

            body_text = resp.text()[:500]
            return {"ok": False, "status": resp.status, "body": body_text, "error": f"HTTP {resp.status}"}

        body_text = resp.text()
        content_type = resp.headers.get("content-type", "")

        if "json" not in content_type and body_text.strip().startswith("<!"):
            _login_ok = False
            _status["loginOk"] = False

            if _try_sso_recovery(page):
                _ensure_page_on_orient(page)
                if method == "GET":
                    resp = page.request.get(url, timeout=timeout * 1000)
                else:
                    resp = page.request.post(url, data=body, timeout=timeout * 1000)

                if resp.ok:
                    body_text = resp.text()
                    content_type = resp.headers.get("content-type", "")
                    if "json" in content_type or not body_text.strip().startswith("<!"):
                        return {"ok": True, "status": resp.status, "body": body_text, "error": None}

            return {"ok": False, "status": 401, "body": "", "error": "COOKIE_EXPIRED"}

        return {"ok": True, "status": resp.status, "body": body_text, "error": None}

    except Exception as e:
        error_str = str(e)
        if "timeout" in error_str.lower():
            return {"ok": False, "status": 0, "body": "", "error": "请求超时"}
        return {"ok": False, "status": 0, "body": "", "error": error_str}


# ─── 启停 ───

def start():
    """启动浏览器线程（非阻塞）"""
    global _browser_thread

    if _browser_thread and _browser_thread.is_alive():
        return True

    _browser_thread = threading.Thread(target=_browser_thread_main, daemon=True)
    _browser_thread.start()

    deadline = time.time() + 15
    while time.time() < deadline:
        if _initialized:
            return True
        time.sleep(0.5)

    print("[orient_browser] 浏览器初始化超时")
    return False


def stop():
    """停止浏览器线程"""
    global _browser_thread
    if _browser_thread:
        _request_queue.put(None)
        _browser_thread.join(timeout=5)
        _browser_thread = None
