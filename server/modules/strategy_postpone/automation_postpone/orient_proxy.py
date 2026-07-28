"""Orient 三级代理封装（不依赖 ProxyHandler）。"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Dict, Optional, Tuple

_PW_BASE = "https://operation-tool.corp.kuaishou.com/operation-tool/rest"
_COOKIE_FILE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "cookie.json")
)


def _load_cookie() -> str:
    if not os.path.exists(_COOKIE_FILE):
        return ""
    try:
        with open(_COOKIE_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        cookie = (cfg.get("kwabi") or "").strip()
        if "请填写" in cookie:
            return ""
        return cookie
    except Exception:
        return ""


def _parse_pw_result(pw_result: Optional[dict]) -> Tuple[Optional[dict], Optional[str]]:
    if not pw_result:
        return None, "Playwright 代理不可用"
    if pw_result.get("ok"):
        body = pw_result.get("body", "")
        try:
            return json.loads(body), None
        except (json.JSONDecodeError, TypeError):
            if "login" in str(body).lower() or "<html" in str(body).lower():
                return None, "COOKIE_EXPIRED"
            return None, f"JSON解析失败: {str(body)[:80]}"
    status = pw_result.get("status", 0)
    err = pw_result.get("error", "")
    if status == 401 or err == "COOKIE_EXPIRED":
        return None, "COOKIE_EXPIRED"
    return None, f"Playwright status={status}, error={err}"


def _parse_chrome_result(result: Optional[dict]) -> Tuple[Optional[dict], Optional[str]]:
    if result is None:
        return None, "Chrome 代理不可用"
    if not result.get("ok"):
        error = result.get("error", "未知错误")
        status = result.get("status", 0)
        if status == 401:
            return None, "COOKIE_EXPIRED"
        return None, error
    body_text = result.get("body", "")
    if not body_text:
        return None, "空响应"
    if "<html" in body_text.lower() or "login" in body_text.lower()[:200]:
        return None, "COOKIE_EXPIRED"
    try:
        return json.loads(body_text), None
    except json.JSONDecodeError:
        return None, f"Chrome JSON解析失败: {body_text[:80]}"


def proxy_get(full_url: str) -> Tuple[Optional[dict], Optional[str]]:
    from chrome_proxy import fetch_via_chrome
    from orient_browser import orient_get as _pw_get

    path = full_url
    if "/operation-tool/rest" in full_url:
        path = full_url.split("/operation-tool/rest", 1)[1]

    resp_data, err = None, None
    try:
        resp_data, err = _parse_pw_result(_pw_get(path))
    except Exception as e:
        err = f"Playwright异常: {e}"

    if err != "COOKIE_EXPIRED" and (err or resp_data is None):
        try:
            resp_data, err = _parse_chrome_result(fetch_via_chrome(full_url, method="GET"))
        except Exception as e:
            err = f"Chrome异常: {e}"
            resp_data = None

    if err == "COOKIE_EXPIRED":
        return None, "COOKIE_EXPIRED"

    if err or resp_data is None:
        cookie = _load_cookie()
        try:
            req = urllib.request.Request(full_url, method="GET")
            if cookie:
                req.add_header("Cookie", cookie)
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8")
            if "<html" in text.lower():
                return None, "COOKIE_EXPIRED"
            resp_data = json.loads(text)
            err = None
        except Exception as e2:
            return None, str(e2)

    return resp_data, err


def proxy_post(full_url: str, payload: dict) -> Tuple[Optional[dict], Optional[str]]:
    from chrome_proxy import fetch_via_chrome
    from orient_browser import orient_post as _pw_post

    path = full_url
    if "/operation-tool/rest" in full_url:
        path = full_url.split("/operation-tool/rest", 1)[1]

    resp_data, err = None, None
    try:
        resp_data, err = _parse_pw_result(_pw_post(path, payload))
    except Exception as e:
        err = f"Playwright异常: {e}"

    if err == "COOKIE_EXPIRED":
        return None, "COOKIE_EXPIRED"

    if err or resp_data is None:
        try:
            resp_data, err = _parse_chrome_result(
                fetch_via_chrome(full_url, method="POST", body=payload)
            )
        except Exception as e:
            err = f"Chrome异常: {e}"
            resp_data = None

    if err == "COOKIE_EXPIRED":
        return None, "COOKIE_EXPIRED"

    if err or resp_data is None:
        cookie = _load_cookie()
        try:
            body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                full_url,
                data=body,
                headers={"Content-Type": "application/json"},
            )
            if cookie:
                req.add_header("Cookie", cookie)
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode("utf-8")
            if "<html" in text.lower():
                return None, "COOKIE_EXPIRED"
            resp_data = json.loads(text)
            err = None
        except Exception as e2:
            return None, str(e2)

    return resp_data, err


def orient_get_by_id(strategy_id: int) -> Tuple[Optional[dict], Optional[str]]:
    """第一版仅定向 orientControl/get。"""
    url = f"{_PW_BASE}/orientControl/get?id={strategy_id}"
    return proxy_get(url)


def orient_merge_edit(body: dict) -> Tuple[Optional[dict], Optional[str]]:
    url = f"{_PW_BASE}/orientControl/mergeEditV2"
    return proxy_post(url, body)
