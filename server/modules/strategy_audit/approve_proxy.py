"""三级降级 Orient POST/GET（Playwright → Chrome CDP → urllib）。"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
import urllib.parse

from .constants import ORIENT_REST_BASE

_COOKIE_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "cookie.json")


def _load_cookie():
    if not os.path.exists(_COOKIE_FILE):
        return ""
    try:
        with open(_COOKIE_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        cookie = (cfg.get("kwabi") or "").strip()
        if "请填写" in cookie:
            return ""
        cookie.encode("latin-1")
        return cookie
    except Exception:
        return ""


def _parse_pw(result):
    if result is None:
        return None, "Playwright 代理不可用"
    if not result.get("ok"):
        error = result.get("error", "未知错误")
        status = result.get("status", 0)
        if status == 401 or error == "COOKIE_EXPIRED":
            return None, "COOKIE_EXPIRED"
        return None, error
    body = result.get("body", "")
    try:
        return json.loads(body), None
    except (json.JSONDecodeError, TypeError):
        if "login" in body.lower() or "<html" in body.lower():
            return None, "COOKIE_EXPIRED"
        return None, f"JSON 解析失败: {body[:100]}"


def _parse_chrome(result):
    if result is None:
        return None, "Chrome 代理不可用"
    if not result.get("ok"):
        error = result.get("error", "未知错误")
        status = result.get("status", 0)
        if status == 401:
            return None, "COOKIE_EXPIRED"
        return None, error
    body = result.get("body", "")
    try:
        return json.loads(body), None
    except (json.JSONDecodeError, TypeError):
        if "login" in body.lower() or "<html" in body.lower():
            return None, "COOKIE_EXPIRED"
        return None, f"JSON 解析失败: {body[:100]}"


def proxy_post(path, payload, timeout=30):
    """POST JSON。path 为 /approve/query 这类相对路径。"""
    from orient_browser import orient_post
    from chrome_proxy import fetch_via_chrome

    url = f"{ORIENT_REST_BASE}{path}"
    resp, err = _parse_pw(orient_post(path, payload, timeout=timeout))
    # Playwright 报 COOKIE_EXPIRED 时仍尝试 Chrome / cookie.json 降级
    if err and resp is None:
        chrome_raw = fetch_via_chrome(url, method="POST", body=payload)
        resp, err = _parse_chrome(chrome_raw)
        if err and resp is None:
            cookie = _load_cookie()
            if not cookie:
                return None, err or "COOKIE_EXPIRED"
            try:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                req.add_header("Cookie", cookie)
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.loads(r.read().decode("utf-8")), None
            except Exception as e:
                return None, str(e)
    return resp, err


def proxy_get(path, timeout=30):
    """GET。path 可含 query，如 /orientControl/get?id=1"""
    from orient_browser import orient_get
    from chrome_proxy import fetch_via_chrome

    url = f"{ORIENT_REST_BASE}{path}"
    resp, err = _parse_pw(orient_get(path, timeout=timeout))
    if err and resp is None:
        chrome_raw = fetch_via_chrome(url, method="GET")
        resp, err = _parse_chrome(chrome_raw)
        if err and resp is None:
            cookie = _load_cookie()
            if not cookie:
                return None, err or "COOKIE_EXPIRED"
            try:
                req = urllib.request.Request(url, method="GET")
                req.add_header("Cookie", cookie)
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.loads(r.read().decode("utf-8")), None
            except Exception as e:
                return None, str(e)
    return resp, err


def proxy_post_query(path, params, timeout=30):
    """POST 且参数走 querystring（quickPushAll 契约）。"""
    qs = urllib.parse.urlencode(params)
    full_path = f"{path}?{qs}" if params else path
    # body 空对象，部分网关要求 POST 有 body
    return proxy_post(full_path, {}, timeout=timeout)


def check_orient_ok(resp_data):
    if not resp_data:
        return False, "空响应"
    if isinstance(resp_data, dict) and "status" in resp_data:
        st = resp_data.get("status")
        if st in (200, "200", 0, "0"):
            return True, None
        return False, resp_data.get("message") or f"业务失败 status={st}"
    return True, None
