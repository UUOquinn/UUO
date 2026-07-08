"""
chrome_cookie.py — 通过 Chrome DevTools Protocol (CDP) 提取浏览器真实 Cookie

原理（v2.0 — 请求拦截法）：
  1. Chrome 启动时带 --remote-debugging-port=9222
  2. 在 Chrome 已打开的 Orient 标签页里注入一个 XHR 请求
  3. 用 CDP Fetch 域拦截该请求，读取 Chrome 真正发送的 Cookie 头
  4. 这样获取的是 Chrome 内部实际使用的 Cookie，而非 CDP Cookie Store 中的旧值

为什么不用 Storage.getCookies / Network.getAllCookies：
  CDP 的 Cookie Store 返回的 JSESSIONID 与 Chrome 实际使用的不一致，
  导致提取到的 Cookie 发请求时返回登录页。通过拦截真实请求获取的 Cookie 才是有效的。

优点：
  - 获取的是 Chrome 真正使用的 Cookie，100% 正确
  - 用户只需在 Chrome 里保持登录即可，无需手动复制粘贴
  - Chrome 自动 SSO 续期，本模块自动获取新 Cookie
"""

import json
import urllib.request
import urllib.error
import time

try:
    import websocket  # pip install websocket-client
except ImportError:
    websocket = None

# ─── 配置 ───
CDP_BASE = "http://localhost:9222"

# ─── 缓存 ───
_cookie_cache = None
_cookie_cache_at = 0
_CACHE_TTL = 30  # 30 秒缓存


def _is_cdp_available():
    """检查 Chrome 调试端口是否可用"""
    try:
        req = urllib.request.Request(f"{CDP_BASE}/json/version", method="GET")
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception:
        return False


def _get_orient_page():
    """获取已打开的 Orient 标签页的 WebSocket URL

    优先找 operation-tool.corp.kuaishou.com 的标签页，
    因为在那个页面上下文里发 XHR 能获得正确的 Cookie。
    """
    try:
        resp = urllib.request.urlopen(f"{CDP_BASE}/json/list", timeout=3)
        pages = json.loads(resp.read().decode("utf-8"))
        # 优先找 Orient 页面
        for p in pages:
            url = p.get("url", "")
            if p.get("type") == "page" and "operation-tool.corp.kuaishou.com" in url:
                return p.get("webSocketDebuggerUrl")
        # 降级：找任意 page
        for p in pages:
            if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                return p["webSocketDebuggerUrl"]
    except Exception:
        pass
    return None


def _get_cookie_via_interception():
    """通过拦截 Chrome 真实请求获取 Cookie（核心方法）

    步骤：
      1. 连接到 Chrome 的 Orient 标签页
      2. 启用 Fetch 域，设置 URL 模式拦截
      3. 在页面里注入一个 XHR 请求到 Orient API
      4. Fetch 拦截该请求，读取 Chrome 实际发送的 Cookie 头
      5. 放行请求，返回捕获的 Cookie 字符串
    """
    if websocket is None:
        raise ImportError("websocket-client 未安装，请运行: pip3 install websocket-client")

    ws_url = _get_orient_page()
    if not ws_url:
        raise RuntimeError("没有找到 Chrome Orient 标签页，请先在 Chrome 中打开 Orient 平台")

    ws = websocket.create_connection(ws_url, timeout=15, suppress_origin=False)

    try:
        # Step 1: 启用 Fetch 域，拦截 Orient API 请求
        ws.send(json.dumps({
            "id": 1,
            "method": "Fetch.enable",
            "params": {
                "patterns": [{
                    "urlPattern": "*operation-tool*",
                    "requestStage": "Request"
                }]
            }
        }))

        # 等待 Fetch.enable 响应
        for _ in range(5):
            raw = ws.recv()
            data = json.loads(raw)
            if data.get("id") == 1:
                break

        # Step 2: 在页面里注入一个无害的 XHR 请求
        # 使用 orientControl/get?id=0 这是一个无效 ID，不会产生副作用
        # 但足以让 Chrome 发出带正确 Cookie 的请求
        ws.send(json.dumps({
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {
                "expression": """
                    new Promise((resolve) => {
                        var xhr = new XMLHttpRequest();
                        xhr.open('GET', '/operation-tool/rest/orientControl/get?id=0');
                        xhr.onload = () => resolve('done');
                        xhr.onerror = () => resolve('error');
                        xhr.send();
                    })
                """,
                "returnByValue": True,
                "awaitPromise": True,
            }
        }))

        # Step 3: 等待 Fetch 拦截请求
        cookie_str = ""
        deadline = time.time() + 10

        while time.time() < deadline:
            try:
                ws.settimeout(1)
                raw = ws.recv()
                data = json.loads(raw)

                if data.get("method") == "Fetch.requestPaused":
                    # 拦截到了！读取 Cookie 头
                    request = data.get("params", {}).get("request", {})
                    headers = request.get("headers", {})
                    cookie_str = headers.get("Cookie", headers.get("cookie", ""))

                    # 放行请求（不修改）
                    request_id = data.get("params", {}).get("requestId", "")
                    ws.send(json.dumps({
                        "id": 100,
                        "method": "Fetch.continueRequest",
                        "params": {"requestId": request_id}
                    }))

                    if cookie_str:
                        return cookie_str

                # XHR 完成了
                if data.get("id") == 2:
                    break

            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                continue

        # 如果 Fetch 没拦截到（可能 kmi 拦截了 XHR），尝试降级方案
        if not cookie_str:
            return _get_cookie_via_cdp_fallback()

        return cookie_str

    finally:
        # 确保 Fetch 域被禁用
        try:
            ws.send(json.dumps({"id": 999, "method": "Fetch.disable", "params": {}}))
            for _ in range(3):
                raw = ws.recv()
                data = json.loads(raw)
                if data.get("id") == 999:
                    break
        except Exception:
            pass
        ws.close()


def _get_cookie_via_cdp_fallback():
    """降级方案：通过 CDP Storage.getCookies 获取 Cookie

    注意：此方法返回的 JSESSIONID 可能与 Chrome 实际使用的不一致，
    仅作为无法拦截请求时的降级方案。
    """
    if websocket is None:
        return ""

    try:
        resp = urllib.request.urlopen(f"{CDP_BASE}/json/version", timeout=3)
        data = json.loads(resp.read().decode("utf-8"))
        ws_url = data.get("webSocketDebuggerUrl")

        if ws_url:
            ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=False)
            try:
                cmd = {"id": 1, "method": "Storage.getCookies", "params": {}}
                ws.send(json.dumps(cmd))
                for _ in range(5):
                    raw = ws.recv()
                    data = json.loads(raw)
                    if data.get("id") == 1:
                        if "result" in data:
                            cookies = data["result"].get("cookies", [])
                            return _filter_and_join_cookies(cookies)
                        break
            finally:
                ws.close()
    except Exception as e:
        print(f"[chrome_cookie] CDP 降级提取失败: {e}")

    return ""


def _filter_and_join_cookies(cookies):
    """过滤目标域名的 Cookie 并拼成 HTTP Cookie 头格式"""
    related = []
    for c in cookies:
        cdomain = c.get("domain", "")
        if "kuaishou.com" in cdomain:
            related.append(c)

    if not related:
        return ""

    # 按域名精确度排序
    related.sort(key=lambda c: -c.get("domain", "").lstrip(".").count("."))

    matched = {}
    for c in related:
        name = c.get("name", "")
        value = c.get("value", "")
        if not name or not value:
            continue
        if name not in matched:
            matched[name] = value

    if not matched:
        return ""

    return "; ".join(f"{k}={v}" for k, v in matched.items())


def _merge_cookies(intercepted_cookie, cdp_cookie):
    """合并拦截法和 CDP 法的 Cookie

    策略：
      - 拦截法获取的 Cookie 是 Chrome 发送给 Orient 的真实 Cookie（JSESSIONID 正确）
      - CDP 法获取的 Cookie 覆盖所有域名（包括 KwaiBI 等）
      - 同名字段：拦截法优先（因为更准确）
      - 不同字段：全部保留
    """
    if not intercepted_cookie:
        return cdp_cookie
    if not cdp_cookie:
        return intercepted_cookie

    # 解析成 dict
    intercepted = {}
    for part in intercepted_cookie.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            intercepted[k.strip()] = v.strip()

    cdp = {}
    for part in cdp_cookie.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cdp[k.strip()] = v.strip()

    # 合并：拦截法优先
    merged = {**cdp, **intercepted}

    return "; ".join(f"{k}={v}" for k, v in merged.items())


def get_chrome_cookie(force_refresh=False):
    """获取目标域名的 Cookie（带缓存）

    v2.0: 请求拦截法（Orient 域名）+ CDP Cookie Store（其他域名如 KwaiBI）合并

    Args:
        force_refresh: True 则忽略缓存，强制重新提取

    Returns:
        Cookie 字符串（如 "JSESSIONID=xxx; accessproxy_session=xxx; ..."）
        如果 Chrome 未启动或未登录，返回空字符串
    """
    global _cookie_cache, _cookie_cache_at

    now = time.time()
    if not force_refresh and _cookie_cache and (now - _cookie_cache_at) < _CACHE_TTL:
        return _cookie_cache

    if not _is_cdp_available():
        return ""

    # Step 1: 尝试拦截法获取 Orient 真实 Cookie
    intercepted = ""
    try:
        intercepted = _get_cookie_via_interception()
    except Exception as e:
        print(f"[chrome_cookie] 请求拦截法失败: {e}")

    # Step 2: 用 CDP 获取所有域名的 Cookie（补充 KwaiBI 等）
    cdp_cookie = ""
    try:
        cdp_cookie = _get_cookie_via_cdp_fallback()
    except Exception as e:
        print(f"[chrome_cookie] CDP 获取失败: {e}")

    # Step 3: 合并两者（拦截法优先）
    merged = _merge_cookies(intercepted, cdp_cookie)

    if merged:
        _cookie_cache = merged
        _cookie_cache_at = now
        return merged

    return ""


def get_chrome_cookie_status():
    """获取 Chrome Cookie 状态信息（用于前端展示）"""
    if not _is_cdp_available():
        return {
            "available": False,
            "reason": "Chrome 调试端口未启动",
            "hint": "请运行带 --remote-debugging-port=9222 的 Chrome",
        }

    # 检查是否有 Orient 标签页
    has_orient_page = _get_orient_page() is not None

    cookie = get_chrome_cookie()
    if not cookie:
        if has_orient_page:
            return {
                "available": True,
                "hasCookie": False,
                "reason": "Chrome 已打开 Orient 但 Cookie 提取失败",
                "hint": "请在 Chrome 中刷新 Orient 页面后再试",
            }
        else:
            return {
                "available": True,
                "hasCookie": False,
                "reason": "Chrome 已启动但未打开 Orient 平台",
                "hint": "请在 Chrome 中打开 https://operation-tool.corp.kuaishou.com/orient",
            }

    # 解析 Cookie 字段
    fields = [c.strip() for c in cookie.split(";") if c.strip()]
    has_session = any(f.startswith("JSESSIONID=") for f in fields)
    has_access = any(f.startswith("accessproxy_session=") for f in fields)

    return {
        "available": True,
        "hasCookie": True,
        "fieldCount": len(fields),
        "hasSession": has_session,
        "hasAccess": has_access,
        "hint": "Chrome Cookie 实时同步中" if (has_session and has_access) else "Cookie 不完整，请检查 Chrome 登录状态",
    }


if __name__ == "__main__":
    # 命令行测试
    print("=== Chrome Cookie 状态 ===")
    status = get_chrome_cookie_status()
    print(json.dumps(status, ensure_ascii=False, indent=2))

    print("\n=== 提取的 Cookie ===")
    cookie = get_chrome_cookie(force_refresh=True)
    if cookie:
        print(f"长度: {len(cookie)} 字符")
        print(f"前 100 字符: {cookie[:100]}...")
    else:
        print("未获取到 Cookie")
