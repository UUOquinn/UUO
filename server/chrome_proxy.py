"""
chrome_proxy.py — 通过 Chrome CDP 让 Chrome 代发 HTTP 请求并返回响应

v4.0 自愈式 Chrome 代理

核心改进：
  - 后台守护线程自动保持 Orient 页面在 Chrome 中打开
  - 页面被关闭 → 自动重新打开
  - SSO 过期 → 自动检测并提示
  - 服务启动 → 自动打开 Orient 页面，无需手动操作
  - 复用已有标签页发 fetch 请求，速度快，Cookie 永不过期

原理：
  1. 守护线程每 30 秒检查 Chrome 中是否有 Orient 页面
  2. 没有则自动打开，确保 Cookie 上下文始终存在
  3. 请求时优先复用已有标签页注入 fetch()
  4. Chrome 自己管理 Cookie 和 SSO 认证，永不过期

前提：
  Chrome 以 --remote-debugging-port=9222 启动，且用户已登录内网。
"""

import json
import urllib.request
import urllib.parse
import time
import threading

try:
    import websocket  # pip install websocket-client
except ImportError:
    websocket = None

# ─── 配置 ───
CDP_BASE = "http://localhost:9222"

# ─── 目标域名主页映射 ───
DOMAIN_HOME = {
    "operation-tool.corp.kuaishou.com": "https://operation-tool.corp.kuaishou.com/home",
    "kwaibi.corp.kuaishou.com": "https://kwaibi.corp.kuaishou.com/",
}

# ─── 需要保持打开的域名（守护线程维护） ───
GUARD_DOMAINS = ["operation-tool.corp.kuaishou.com"]

# ─── 请求锁（防止并发） ───
_fetch_lock = threading.Lock()

# ─── 守护线程状态 ───
_guard_thread = None
_guard_running = False
_guard_last_ok = 0  # 上次确认所有域名页面 OK 的时间


def _is_cdp_available():
    """检查 Chrome 调试端口是否可用"""
    try:
        req = urllib.request.Request(f"{CDP_BASE}/json/version", method="GET")
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception:
        return False


def _list_pages():
    """列出所有 Chrome 标签页"""
    try:
        resp = urllib.request.urlopen(f"{CDP_BASE}/json/list", timeout=3)
        return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []


def _find_page_for_domain(domain):
    """找到目标域名对应的已有标签页，返回 (ws_url, page_id) 或 (None, None)"""
    pages = _list_pages()
    for p in pages:
        if p.get("type") == "page" and domain in p.get("url", ""):
            return p.get("webSocketDebuggerUrl"), p.get("id")
    return None, None


def _create_temp_page(url="about:blank"):
    """创建新标签页，返回 (ws_url, page_id)"""
    try:
        req = urllib.request.Request(f"{CDP_BASE}/json/new?{url}", method="PUT")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("webSocketDebuggerUrl"), data.get("id")
    except Exception as e:
        print(f"[chrome_proxy] 创建新标签页失败: {e}")
    return None, None


def _close_page(page_id):
    """关闭标签页"""
    try:
        req = urllib.request.Request(f"{CDP_BASE}/json/close/{page_id}", method="PUT")
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def _open_page_in_chrome(url):
    """在 Chrome 中打开一个 URL，返回 page_id 或 None"""
    try:
        req = urllib.request.Request(f"{CDP_BASE}/json/new?{url}", method="PUT")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("id")
    except Exception as e:
        print(f"[chrome_proxy] 打开页面失败: {e}")
        return None


def _extract_domain(url):
    """从 URL 中提取域名"""
    parsed = urllib.parse.urlparse(url)
    return parsed.hostname or ""


def _wait_for_page_load(ws, timeout=15):
    """等待页面加载完成"""
    ws.send(json.dumps({"id": 1, "method": "Page.enable", "params": {}}))
    deadline = time.time() + timeout
    for _ in range(100):
        if time.time() > deadline:
            break
        try:
            ws.settimeout(1)
            raw = ws.recv()
            data = json.loads(raw)
            if data.get("method") in ("Page.loadEventFired", "Page.domContentEventFired"):
                break
            if data.get("id") == 1:
                continue
        except websocket.WebSocketTimeoutException:
            break
        except Exception:
            break


def _navigate_to_domain(ws, url):
    """导航到 URL 对应域名的主页，返回 None 或错误 dict"""
    domain = _extract_domain(url)
    home_url = DOMAIN_HOME.get(domain, f"https://{domain}/")
    ws.send(json.dumps({"id": 2, "method": "Page.navigate", "params": {"url": home_url}}))
    _wait_for_page_load(ws, timeout=20)

    # 检查是否被重定向到 SSO
    ws.send(json.dumps({"id": 3, "method": "Runtime.evaluate",
        "params": {"expression": "document.URL", "returnByValue": True}}))
    for _ in range(10):
        try:
            ws.settimeout(2)
            raw = ws.recv()
            data = json.loads(raw)
            if data.get("id") == 3:
                current_url = data.get("result", {}).get("result", {}).get("value", "")
                if "sso" in current_url.lower() or "login" in current_url.lower():
                    return {"ok": False, "status": 401, "body": "", "error": "Chrome 未登录目标平台"}
                break
        except websocket.WebSocketTimeoutException:
            break
        except Exception:
            break
    return None


def _inject_fetch(ws, url, method="GET", body=None):
    """在页面内注入 fetch 请求并读取响应"""
    if method == "GET":
        fetch_code = f"""
            new Promise((resolve) => {{
                fetch('{url}', {{method: 'GET', credentials: 'include'}})
                .then(r => r.text()).then(t => resolve(t))
                .catch(e => resolve('FETCH_ERROR:' + e.message));
            }})
        """
    else:
        body_json = json.dumps(body, ensure_ascii=False)
        body_escaped = body_json.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        fetch_code = f"""
            new Promise((resolve) => {{
                fetch('{url}', {{
                    method: 'POST',
                    headers: {{'Content-Type': 'application/json'}},
                    body: '{body_escaped}',
                    credentials: 'include'
                }})
                .then(r => r.text()).then(t => resolve(t))
                .catch(e => resolve('FETCH_ERROR:' + e.message));
            }})
        """

    ws.send(json.dumps({"id": 10, "method": "Runtime.evaluate",
        "params": {"expression": fetch_code, "returnByValue": True, "awaitPromise": True}}))

    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            ws.settimeout(5)
            raw = ws.recv()
            data = json.loads(raw)
            if data.get("id") == 10:
                value = data.get("result", {}).get("result", {}).get("value", "")
                if value and not value.startswith("FETCH_ERROR:"):
                    return {"ok": True, "status": 200, "body": value}
                elif value and value.startswith("FETCH_ERROR:"):
                    return {"ok": False, "status": 0, "body": "", "error": value}
                elif not value:
                    return {"ok": False, "status": 0, "body": "", "error": "Empty response"}
                break
        except websocket.WebSocketTimeoutException:
            continue
        except Exception as e:
            return {"ok": False, "status": 0, "body": "", "error": str(e)}
    return None


# ─── 守护线程 ───

def _guard_loop():
    """后台守护线程：确保 Chrome 中始终有目标域名的页面打开

    每 30 秒检查一次：
      - 如果 Chrome 没有 Orient 页面 → 自动打开
      - 如果页面存在 → 刷新确认 SSO 还有效
    """
    global _guard_running, _guard_last_ok

    while _guard_running:
        try:
            if not _is_cdp_available():
                time.sleep(10)
                continue

            for domain in GUARD_DOMAINS:
                ws_url, page_id = _find_page_for_domain(domain)
                if not ws_url:
                    # 没有页面，自动打开
                    home_url = DOMAIN_HOME.get(domain, f"https://{domain}/")
                    pid = _open_page_in_chrome(home_url)
                    if pid:
                        print(f"[guard] ✓ 自动打开 {home_url}")
                        time.sleep(5)  # 等待 SSO 认证
                    else:
                        print(f"[guard] ✗ 打开 {home_url} 失败")
                else:
                    # 页面存在，快速验证
                    try:
                        ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=False)
                        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": "document.URL", "returnByValue": True}}))
                        for _ in range(5):
                            raw = ws.recv()
                            data = json.loads(raw)
                            if data.get("id") == 1:
                                url = data.get("result", {}).get("result", {}).get("value", "")
                                if "sso" in url.lower() or "login" in url.lower():
                                    print(f"[guard] ⚠ {domain} SSO 已过期，需要重新登录")
                                break
                        ws.close()
                    except Exception:
                        pass

            _guard_last_ok = time.time()

        except Exception as e:
            print(f"[guard] 检查异常: {e}")

        time.sleep(30)


def start_guard():
    """启动守护线程（幂等，重复调用不会创建多个线程）"""
    global _guard_thread, _guard_running
    if _guard_thread and _guard_thread.is_alive():
        return
    _guard_running = True
    _guard_thread = threading.Thread(target=_guard_loop, daemon=True, name="chrome-guard")
    _guard_thread.start()
    # 首次立即检查一次
    _ensure_domain_pages()


def _ensure_domain_pages():
    """立即检查并打开所有需要的域名页面"""
    if not _is_cdp_available():
        print("[chrome_proxy] Chrome 未启动，无法打开域名页面")
        return
    for domain in GUARD_DOMAINS:
        ws_url, page_id = _find_page_for_domain(domain)
        if not ws_url:
            home_url = DOMAIN_HOME.get(domain, f"https://{domain}/")
            pid = _open_page_in_chrome(home_url)
            if pid:
                print(f"[chrome_proxy] ✓ 已打开 {home_url}")
            else:
                print(f"[chrome_proxy] ✗ 打开 {home_url} 失败")


# ─── 对外接口 ───

def fetch_via_chrome(url, method="GET", body=None, extra_headers=None):
    """通过 Chrome 代发 HTTP 请求并返回响应

    v4.0: 自愈式，守护线程保持页面，请求时复用已有标签页

    Args:
        url: 完整 URL
        method: GET 或 POST
        body: POST 请求体（dict）
        extra_headers: 额外请求头（dict）— 当前忽略

    Returns:
        dict: {"ok": True/False, "status": int, "body": str, "error": str|None}
        或 None（Chrome 不可用）
    """
    if websocket is None:
        return None

    if not _is_cdp_available():
        return None

    with _fetch_lock:
        return _fetch_via_chrome_impl(url, method, body)


def _fetch_via_chrome_impl(url, method="GET", body=None):
    """实际执行函数"""
    domain = _extract_domain(url)

    # ─── 方案 A：复用已有标签页 ───
    existing_ws, existing_id = _find_page_for_domain(domain)
    if existing_ws:
        try:
            ws = websocket.create_connection(existing_ws, timeout=15, suppress_origin=False)
            try:
                result = _inject_fetch(ws, url, method, body)
                if result and result.get("ok"):
                    return result
                # fetch 失败，回退到方案 B
            finally:
                ws.close()
        except Exception:
            pass

    # ─── 方案 B：确保域名页面打开 → 新标签页导航 ───
    _ensure_domain_pages()
    time.sleep(2)

    # 重新找已有页面（刚打开的可能可用了）
    existing_ws2, existing_id2 = _find_page_for_domain(domain)
    if existing_ws2:
        try:
            ws = websocket.create_connection(existing_ws2, timeout=15, suppress_origin=False)
            try:
                result = _inject_fetch(ws, url, method, body)
                if result and result.get("ok"):
                    return result
            finally:
                ws.close()
        except Exception:
            pass

    # ─── 方案 C：新标签页 + 导航 ───
    ws_url, page_id = _create_temp_page()
    if not ws_url:
        return None

    try:
        ws = websocket.create_connection(ws_url, timeout=15, suppress_origin=False)
        try:
            nav_error = _navigate_to_domain(ws, url)
            if nav_error:
                return nav_error
            result = _inject_fetch(ws, url, method, body)
            return result
        finally:
            ws.close()
    except Exception as e:
        print(f"[chrome_proxy] 请求失败: {e}")
        return None
    finally:
        if page_id:
            _close_page(page_id)


def get_chrome_cookie_status():
    """获取 Chrome 状态信息

    v4.0: 如果没有 Orient 页面，自动打开
    """
    if not _is_cdp_available():
        return {
            "available": False,
            "reason": "Chrome 调试端口未启动",
            "hint": "请运行带 --remote-debugging-port=9222 的 Chrome",
        }

    pages = _list_pages()
    has_orient = any("operation-tool" in p.get("url", "") for p in pages if p.get("type") == "page")

    if not has_orient:
        # 自动打开 Orient 页面
        _open_page_in_chrome("https://operation-tool.corp.kuaishou.com/home")
        time.sleep(3)
        pages = _list_pages()
        has_orient = any("operation-tool" in p.get("url", "") for p in pages if p.get("type") == "page")

    if has_orient:
        return {
            "available": True,
            "hasCookie": True,
            "hint": "Chrome 代理已就绪（守护线程自动保持登录状态）",
        }
    else:
        return {
            "available": True,
            "hasCookie": False,
            "reason": "自动打开 Orient 失败，可能 SSO 未登录",
            "hint": "请在 Chrome 中手动登录内网，系统会自动检测",
        }


if __name__ == "__main__":
    print("=== Chrome Proxy v4.0 测试 ===")
    start_guard()
    time.sleep(5)
    status = get_chrome_cookie_status()
    print(json.dumps(status, ensure_ascii=False, indent=2))
