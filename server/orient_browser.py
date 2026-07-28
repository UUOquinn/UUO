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

# Cursor/沙箱常注入不存在的浏览器目录，导致 launch 失败并拖慢启动
_pw_browsers = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")
if not _pw_browsers or "cursor-sandbox-cache" in _pw_browsers:
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = os.path.expanduser(
        "~/Library/Caches/ms-playwright"
    )

# ─── 心跳保活间隔（秒）───
HEARTBEAT_INTERVAL = 300  # 5 分钟

# ─── SSO 登录等待超时（秒） ───
SSO_WAIT_TIMEOUT = 120
# API 请求触发的 SSO 自愈上限（避免一条请求占满 Playwright 线程数分钟）
SSO_API_RECOVERY_TIMEOUT = int(os.environ.get("SSO_API_RECOVERY_TIMEOUT", "25"))
# HTTP 层等待 Playwright 线程的最长时间（与 orient_get timeout 配合）
ORIENT_PW_WAIT_MAX = int(os.environ.get("ORIENT_PW_WAIT_MAX", "45"))

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
_watchdog_thread = None
_sso_waiting = False
_last_heartbeat = 0
_last_restart_at = 0.0
_RESTART_COOLDOWN = int(os.environ.get("ORIENT_PW_RESTART_COOLDOWN", "30"))
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

    if not _browser_thread or not _browser_thread.is_alive():
        # 进程内自愈：线程已死则尝试重启，避免 HTTP 仍 200 但 Orient 全挂
        if not ensure_alive():
            _response_events.pop(req_id, None)
            return {"ok": False, "status": 0, "body": "", "error": "Playwright 未启动"}
        # 冷启动未就绪时仍可能短暂失败
        if not _browser_thread or not _browser_thread.is_alive():
            _response_events.pop(req_id, None)
            return {"ok": False, "status": 0, "body": "", "error": "Playwright 未启动"}

    if _status.get("ssoWaiting") and not _login_ok:
        _response_events.pop(req_id, None)
        return {"ok": False, "status": 503, "body": "", "error": "SSO_RECOVERING"}

    _request_queue.put({
        "id": req_id,
        "method": method,
        "path": path,
        "body": body,
        "timeout": timeout,
    })

    # 等待结果（SSO 自愈在 Playwright 线程内，HTTP 层不宜等满 120s）
    wait_timeout = min(timeout + 15, ORIENT_PW_WAIT_MAX)
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
    st = _status.copy()
    st["queueDepth"] = _request_queue.qsize()
    st["threadAlive"] = bool(_browser_thread and _browser_thread.is_alive())
    return st


def ensure_ready():
    """确保浏览器已初始化且已登录"""
    return _initialized and _login_ok


def queue_busy(threshold=1):
    """是否有待处理的 Playwright 请求（供后台任务让路）"""
    return _request_queue.qsize() >= threshold


def _export_session_cookies(page):
    """把 Playwright 会话 Cookie 写回 cookie.json，供 urllib 降级备用。

    不打印 Cookie 内容。字段名沿用历史 kwabi（Orient urllib 降级也读它）。
    """
    try:
        cookies = page.context.cookies()
    except Exception as e:
        print(f"[orient_browser] 导出 Cookie 失败（读取）: {e}")
        return False

    parts = []
    for c in cookies or []:
        domain = (c.get("domain") or "").lstrip(".")
        name = c.get("name") or ""
        value = c.get("value") or ""
        if not name or not value:
            continue
        if "kuaishou" not in domain and "operation-tool" not in domain:
            continue
        parts.append(f"{name}={value}")

    if not parts:
        return False

    cookie_header = "; ".join(parts)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookie.json")
    data = {}
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
    except Exception:
        data = {}

    data["kwabi"] = cookie_header
    data["source"] = "playwright-export"
    data["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        print(f"[orient_browser] 已同步会话 Cookie → cookie.json（{len(parts)} 项，降级备用）")
        return True
    except Exception as e:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass
        print(f"[orient_browser] 导出 Cookie 失败（写入）: {e}")
        return False


def _is_browser_closed_error(err):
    """Chromium/page/context 被关掉后的典型错误。"""
    msg = str(err or "").lower()
    return (
        "has been closed" in msg
        or "target closed" in msg
        or "browser has been closed" in msg
        or "context or browser has been closed" in msg
    )


def _mark_browser_dead(reason=""):
    """浏览器已死：清状态，供 health / 自愈感知。"""
    global _initialized, _login_ok, _sso_waiting
    _initialized = False
    _login_ok = False
    _sso_waiting = False
    _status["initialized"] = False
    _status["loginOk"] = False
    _status["ssoWaiting"] = False
    if reason:
        print(f"[orient_browser] 浏览器已失效: {reason}")


def _clear_stale_profile_locks(session_dir):
    """清理已死进程留下的 Chromium 单例锁，避免窗口闪一下就退出。"""
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        path = os.path.join(session_dir, name)
        if not os.path.lexists(path):
            continue
        try:
            target = os.readlink(path) if os.path.islink(path) else ""
        except OSError:
            target = ""
        # macOS 常见形式：hostname-pid
        stale = True
        if target and "-" in target:
            maybe_pid = target.rsplit("-", 1)[-1]
            if maybe_pid.isdigit():
                try:
                    os.kill(int(maybe_pid), 0)
                    stale = False  # 进程仍在，勿删
                except OSError:
                    stale = True
        if stale:
            try:
                os.unlink(path)
                print(f"[orient_browser] 已清理残留锁: {name}")
            except OSError as e:
                print(f"[orient_browser] 清理锁失败 {name}: {e}")


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
    _clear_stale_profile_locks(SESSION_DIR)

    try:
        pw = sync_playwright().start()
        context = None
        last_err = None
        for attempt in range(1, 4):
            try:
                _clear_stale_profile_locks(SESSION_DIR)
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
                break
            except Exception as e:
                last_err = e
                msg = str(e).lower()
                busy = (
                    "user data directory is already in use" in msg
                    or "processsingleton" in msg
                    or "singleton" in msg
                )
                print(f"[orient_browser] 启动失败({attempt}/3): {e}")
                if not busy or attempt >= 3:
                    raise
                _clear_stale_profile_locks(SESSION_DIR)
                time.sleep(1.5)
        if context is None:
            raise last_err or RuntimeError("Chromium launch failed")

        page = context.pages[0] if context.pages else context.new_page()
        _initialized = True
        _status["initialized"] = True
        print("[orient_browser] Chromium 已启动（非 headless）")

        # 启动只做短检查；勿等满 120s，否则模块 API 全部排队导致页面假死
        _check_and_wait_login(page, timeout=8)
        if _login_ok:
            _export_session_cookies(page)

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

                # Chromium 被手动关掉后，结束线程，交给 watchdog 重启
                if result and _is_browser_closed_error(result.get("error")):
                    _mark_browser_dead(result.get("error"))
                    break

            except queue.Empty:
                # 窗口被关掉时尽快退出，勿等满 5 分钟心跳
                try:
                    if page.is_closed():
                        _mark_browser_dead("page.is_closed()")
                        break
                except Exception as pe:
                    if _is_browser_closed_error(pe):
                        _mark_browser_dead(str(pe))
                        break
                # 队列空闲才心跳；有积压时绝不占线程
                if _request_queue.empty():
                    try:
                        _do_heartbeat(page)
                    except RuntimeError as he:
                        if _is_browser_closed_error(he):
                            _mark_browser_dead(str(he))
                            break
                        raise
                continue
            except Exception as e:
                print(f"[orient_browser] 请求处理异常: {e}")
                try:
                    if "req" in locals() and req and req.get("id"):
                        _response_data[req["id"]] = {
                            "ok": False, "status": 0, "body": "", "error": str(e)
                        }
                        _response_events[req["id"]].set()
                except Exception:
                    pass
                if _is_browser_closed_error(e):
                    _mark_browser_dead(str(e))
                    break

        try:
            context.close()
        except Exception:
            pass
        try:
            pw.stop()
        except Exception:
            pass

    except Exception as e:
        print(f"[orient_browser] 浏览器线程异常: {e}")
        _mark_browser_dead(str(e))


# ─── 心跳保活 ───

def _do_heartbeat(page):
    """心跳保活：定期刷新 Orient 页面，保持 SSO session 不过期。

    绝不为等登录而阻塞 Playwright 线程（以前最多卡 120 秒导致全站假死）。
    """
    global _login_ok, _last_heartbeat, _status, _sso_waiting

    now = time.time()
    if now - _last_heartbeat < HEARTBEAT_INTERVAL:
        return
    if not _request_queue.empty():
        return

    _last_heartbeat = now

    try:
        page.goto(
            "https://operation-tool.corp.kuaishou.com/home",
            timeout=12000,
            wait_until="domcontentloaded"
        )
        # 心跳途中若来了用户请求，立刻结束，把线程让出去
        if not _request_queue.empty():
            return

        url = page.url
        if "sso" in url.lower() or "login" in url.lower():
            _login_ok = False
            _sso_waiting = False
            _status["loginOk"] = False
            _status["ssoWaiting"] = False
            print("[orient_browser] 💓 心跳检测：SSO 已过期（不阻塞等待，下次 API 再触发短自愈）")
        else:
            _login_ok = True
            _status["loginOk"] = True
            print("[orient_browser] 💓 心跳保活：SSO session 已刷新")
            _export_session_cookies(page)

    except Exception as e:
        print(f"[orient_browser] 💓 心跳异常: {e}")
        if _is_browser_closed_error(e):
            raise RuntimeError(str(e))


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
                        _export_session_cookies(page)
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
            _export_session_cookies(page)

    except Exception as e:
        print(f"[orient_browser] 登录检查失败: {e}")
        _login_ok = False
        _sso_waiting = False
        _status["loginOk"] = False
        _status["ssoWaiting"] = False


# ─── SSO 自愈 ───

def _try_sso_recovery(page, timeout=None):
    """SSO 自愈：导航到 Orient 首页，等待用户重新登录"""
    global _login_ok, _sso_waiting, _status

    recovery_timeout = SSO_WAIT_TIMEOUT if timeout is None else timeout

    if _sso_waiting:
        deadline = time.time() + min(recovery_timeout, 30)
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
            _export_session_cookies(page)
            return True

        print("[orient_browser] ⚠️ 请在弹出的浏览器窗口中完成 SSO 登录！")
        deadline = time.time() + recovery_timeout
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
                    _export_session_cookies(page)
                    return True
            except Exception:
                pass
            time.sleep(2)

    except Exception as e:
        print(f"[orient_browser] SSO 恢复异常: {e}")

    _sso_waiting = False
    _status["ssoWaiting"] = False
    print(f"[orient_browser] ✗ SSO 重新登录超时（{recovery_timeout}秒）")
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
            if not _try_sso_recovery(page, SSO_API_RECOVERY_TIMEOUT):
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
                if _try_sso_recovery(page, SSO_API_RECOVERY_TIMEOUT):
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

            if _try_sso_recovery(page, SSO_API_RECOVERY_TIMEOUT):
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

def ensure_alive():
    """若 Playwright 线程已死，按冷却时间自动重启（进程内自愈）。

    不阻塞等待冷启动完成，避免拖死 HTTP 请求线程。
    """
    global _initialized, _login_ok, _last_restart_at, _sso_waiting

    if _browser_thread and _browser_thread.is_alive():
        return True

    now = time.time()
    if now - _last_restart_at < _RESTART_COOLDOWN:
        return False

    _last_restart_at = now
    _initialized = False
    _login_ok = False
    _sso_waiting = False
    _status["initialized"] = False
    _status["loginOk"] = False
    _status["ssoWaiting"] = False
    print("[orient_browser] 检测到浏览器线程已退出，正在自动重启…")
    return start(wait_init=False)


def _watchdog_loop():
    """后台巡检：线程异常退出后自动拉起。"""
    while True:
        time.sleep(15)
        try:
            if not _browser_thread or not _browser_thread.is_alive():
                ensure_alive()
        except Exception as e:
            print(f"[orient_browser] watchdog 异常: {e}")


def _ensure_watchdog():
    global _watchdog_thread
    if _watchdog_thread and _watchdog_thread.is_alive():
        return
    _watchdog_thread = threading.Thread(
        target=_watchdog_loop, daemon=True, name="orient-pw-watchdog"
    )
    _watchdog_thread.start()


def start(wait_init=True):
    """启动浏览器线程（非阻塞）

    wait_init=True：启动时等待 initialized（或慢启动仍返回 True）。
    wait_init=False：仅拉起线程即返回，供请求路径/自愈使用。
    """
    global _browser_thread

    if _browser_thread and _browser_thread.is_alive():
        _ensure_watchdog()
        return True

    _browser_thread = threading.Thread(target=_browser_thread_main, daemon=True)
    _browser_thread.start()
    _ensure_watchdog()

    if not wait_init:
        return bool(_browser_thread and _browser_thread.is_alive())

    # 冷启动常见 10～30 秒；过短会误报超时，随后窗口才起来像「闪退」
    wait_sec = int(os.environ.get("ORIENT_PW_INIT_WAIT", "45"))
    deadline = time.time() + max(15, wait_sec)
    while time.time() < deadline:
        if _initialized:
            return True
        if not _browser_thread.is_alive():
            print("[orient_browser] 浏览器线程已退出，初始化失败")
            return False
        time.sleep(0.5)

    # 线程仍在跑：慢启动，不当作失败（避免误导 + 勿触发上层重启杀进程）
    if _browser_thread.is_alive():
        print(
            f"[orient_browser] 浏览器仍在启动中（已等 {wait_sec}s），后台继续初始化…"
        )
        return True

    print("[orient_browser] 浏览器初始化超时")
    return False


def stop():
    """停止浏览器线程"""
    global _browser_thread
    if _browser_thread:
        _request_queue.put(None)
        _browser_thread.join(timeout=5)
        _browser_thread = None
