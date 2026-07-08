"""
chrome_renew.py — 通过 Chrome DevTools Protocol 在编辑页面里抓取真实提交 body

原理：
  1. 找到 Chrome 中 Orient 相关标签页
  2. 让 Chrome 跳转到 /orient/edit/{id} 编辑页
  3. 注入 fetch 拦截器
  4. 点击"修改并自动提审"按钮
  5. 捕获 mergeEditV2 请求的真实 body（含 industryVersion 等隐藏字段）
  6. 修改 endTime +1 月，通过 Chrome 代理重新提交

用途：
  解决 412 错误 — GET 返回的 body 缺少 industryVersion 字段，
  只有编辑页面 JS 构造的 body 才是完整的。
"""

import json
import time
import urllib.request

try:
    import websocket
except ImportError:
    websocket = None

from chrome_proxy import fetch_via_chrome, _is_cdp_available, CDP_BASE


def _get_orient_page_ws():
    """找到 Chrome 中 Orient 相关标签页的 WebSocket URL"""
    try:
        resp = urllib.request.urlopen(f"{CDP_BASE}/json/list", timeout=3)
        pages = json.loads(resp.read().decode("utf-8"))
        for p in pages:
            if p.get("type") == "page" and (
                "operation-tool" in p.get("url", "")
                or "orient" in p.get("url", "")
            ):
                ws_url = p.get("webSocketDebuggerUrl")
                if ws_url:
                    return ws_url
    except Exception as e:
        print(f"[chrome_renew] 获取页面失败: {e}")
    return None


def _eval_js(ws, js_code, timeout=10):
    """在 Chrome 页面执行 JS 并返回结果"""
    ws.send(json.dumps({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {"expression": js_code, "returnByValue": True, "awaitPromise": True}
    }))
    deadline = time.time() + timeout
    ws.settimeout(1)
    while time.time() < deadline:
        try:
            raw = ws.recv()
            data = json.loads(raw)
            if data.get("id") == 1:
                result = data.get("result", {}).get("result", {})
                return result.get("value")
        except websocket.WebSocketTimeoutException:
            continue
        except Exception as e:
            print(f"[chrome_renew] eval err: {e}")
            return None
    return None


def capture_real_body(strategy_id):
    """跳转到编辑页 + 点击按钮 + 捕获真实 mergeEditV2 body

    Args:
        strategy_id: 策略 ID

    Returns:
        dict: 真实 body（含 industryVersion 等字段），失败返回 None
    """
    if websocket is None:
        return None

    if not _is_cdp_available():
        return None

    # Step 1: 跳转到编辑页
    ws_url = _get_orient_page_ws()
    if not ws_url:
        return None
    ws = websocket.create_connection(ws_url, timeout=15, suppress_origin=False)
    ws.send(json.dumps({
        "id": 1,
        "method": "Page.navigate",
        "params": {"url": f"https://operation-tool.corp.kuaishou.com/orient/edit/{strategy_id}"}
    }))
    for _ in range(5):
        raw = ws.recv()
        data = json.loads(raw)
        if data.get("id") == 1:
            break
    ws.close()

    # 等页面加载
    time.sleep(5)

    # Step 2: 重新连 WS（跳转后 WS 可能变了）
    ws_url2 = _get_orient_page_ws()
    if not ws_url2:
        return None
    ws = websocket.create_connection(ws_url2, timeout=15, suppress_origin=False)

    # Step 3: 注入 fetch 拦截器
    js_inject = '''
window.__capturedBody = null;
window.__capturedUrl = null;
var origFetch = window.fetch;
window.fetch = function(url, opts) {
  if (typeof url === "string" && url.includes("mergeEditV2")) {
    window.__capturedUrl = url;
    try { window.__capturedBody = JSON.parse(opts.body); } catch(e) { window.__capturedBody = opts.body; }
  }
  return origFetch.apply(this, arguments);
};
"injected"
'''
    _eval_js(ws, js_inject)

    # Step 4: 点击"修改并自动提审"按钮
    js_click = '''
(function(){
  var btn = null;
  document.querySelectorAll("button").forEach(function(el){
    if (el.textContent.trim() === "修改并自动提审") btn = el;
  });
  if (btn) { btn.click(); return "clicked"; }
  return "not found";
})()
'''
    _eval_js(ws, js_click)

    # 等 3 秒让 fetch 发出去
    time.sleep(3)

    # Step 5: 读取捕获的 body
    js_read = "JSON.stringify({url:window.__capturedUrl, body:window.__capturedBody})"
    val = _eval_js(ws, js_read)
    ws.close()

    if not val:
        return None

    captured = json.loads(val)
    body = captured.get("body")
    if isinstance(body, dict):
        return body
    return None


def renew_via_chrome(strategy_id, new_end_time_ms):
    """完整延期流程：抓真实 body → 修改 endTime → 重新提交

    Args:
        strategy_id: 策略 ID
        new_end_time_ms: 新 endTime（毫秒时间戳）

    Returns:
        dict: {
            "ok": bool,
            "status": int,  # 业务 status
            "message": str,
            "detail": str,  # 错误详情
        }
    """
    # Step 1: 抓真实 body
    body = capture_real_body(strategy_id)
    if not body:
        return {
            "ok": False,
            "status": 0,
            "message": "无法从编辑页捕获真实 body",
            "detail": "可能页面未加载或按钮未找到",
        }

    # Step 2: 修改 endTime
    body["endTime"] = new_end_time_ms
    # id 确保正确
    body["id"] = int(strategy_id)

    # Step 3: 重新提交（通过 Chrome 代理）
    result = fetch_via_chrome(
        "https://operation-tool.corp.kuaishou.com/operation-tool/rest/orientControl/mergeEditV2",
        method="POST",
        body=body,
    )

    if not result or not result.get("ok"):
        return {
            "ok": False,
            "status": 0,
            "message": "Chrome 代理不可用",
            "detail": str(result.get("error") if result else "no result"),
        }

    try:
        resp = json.loads(result.get("body", ""))
        biz_status = resp.get("status", 0)
        biz_msg = resp.get("message", "")
        return {
            "ok": biz_status == 200,
            "status": biz_status,
            "message": biz_msg,
            "detail": result.get("body", "")[:300],
        }
    except Exception as e:
        return {
            "ok": False,
            "status": 0,
            "message": f"解析响应失败: {e}",
            "detail": result.get("body", "")[:300],
        }


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python3 chrome_renew.py <strategy_id>")
        sys.exit(1)
    sid = sys.argv[1]
    print(f"=== 测试捕获策略 {sid} 的真实 body ===")
    body = capture_real_body(sid)
    if body:
        print(f"✓ 捕获成功！字段: {list(body.keys())}")
        print(f"  adCluster.industryVersion: {body.get('adCluster',{}).get('industryVersion','(无)')}")
        print(f"  endTime: {body.get('endTime')}")
    else:
        print("✗ 捕获失败")
