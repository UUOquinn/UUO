/* ═══════════════════════════════════════════════════════
 *  联盟诊断工作台 - 壳层逻辑（导航 / Cookie / 手册深链）
 * ═══════════════════════════════════════════════════════ */

const API_BASE = window.__API_BASE__ || "";
const KWABI_COOKIE_KEY = "kwabi-auth-cookie";

function getKwabiCookie() {
  return localStorage.getItem(KWABI_COOKIE_KEY) || "";
}

function setKwabiCookie(val) {
  localStorage.setItem(KWABI_COOKIE_KEY, val);
}

function applyCookieStatusUI(d, statusEl) {
  const status = statusEl || document.getElementById("kwabiCookieStatus");
  if (!status || !d) return;
  if (d.playwrightReady) {
    status.textContent = "Playwright 已就绪 ✓";
    status.className = "cookie-status ok";
    status.title = d.hint || "Playwright API 代理（同内网可用）";
    status.style.fontWeight = "";
    clearCookieExpired();
    return true;
  }
  if (d.serverConfigured) {
    status.textContent = "服务端已就绪 ✓";
    status.className = "cookie-status ok";
    status.title = d.hint || "";
    status.style.fontWeight = "";
    clearCookieExpired();
    return true;
  }
  if (d.source === "playwright-needs-login") {
    status.textContent = "Playwright 待登录";
    status.className = "cookie-status err";
    status.title = d.hint || "请在服务端弹出的浏览器窗口完成 SSO";
    return false;
  }
  status.textContent = "服务端未配置";
  status.className = "cookie-status err";
  status.title = d.hint || "";
  return false;
}

async function markCookieExpired() {
  const status = document.getElementById("kwabiCookieStatus");
  const config = document.querySelector(".cookie-config");
  const hasPersonalCookie = !!getKwabiCookie();

  // 先复核：生产主路径是 Playwright，不是 cookie.json
  try {
    const resp = await fetch(`${API_BASE}/api/cookie/status`, {
      signal: AbortSignal.timeout(5000),
    });
    const result = await resp.json();
    const d = (result && result.data) || {};
    if (result.success && (d.playwrightReady || d.serverConfigured)) {
      applyCookieStatusUI(d, status);
      return;
    }
    if (status) {
      if (hasPersonalCookie) {
        status.textContent = "个人 Cookie 已过期，请重新配置";
      } else if (d.source === "playwright-needs-login" || d.source === "playwright") {
        status.textContent = "Orient SSO 已过期，请在服务端浏览器完成登录";
      } else {
        status.textContent = "登录态失效，请完成 Playwright SSO 或更新个人 Cookie";
      }
      status.className = "cookie-status err";
      status.style.fontWeight = "700";
      status.title = d.hint || "";
    }
  } catch (_) {
    if (status) {
      status.textContent = hasPersonalCookie
        ? "个人 Cookie 已过期，请重新配置"
        : "登录态失效，请检查 Playwright SSO";
      status.className = "cookie-status err";
      status.style.fontWeight = "700";
    }
  }

  if (config) {
    config.classList.add("cookie-expired");
    if (!window.__cookieExpiredNotified) {
      window.__cookieExpiredNotified = true;
      config.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  window.__cookieExpired = true;
}

function clearCookieExpired() {
  const config = document.querySelector(".cookie-config");
  if (config) config.classList.remove("cookie-expired");
  window.__cookieExpired = false;
  window.__cookieExpiredNotified = false;
}

function isCookieExpiredError(err) {
  const msg = String((err && err.message) || err || "");
  return /COOKIE_EXPIRED|Cookie 已过期|API 401|API 403/.test(msg);
}

window.markCookieExpired = markCookieExpired;
window.clearCookieExpired = clearCookieExpired;
window.isCookieExpiredError = isCookieExpiredError;

function switchView(view) {
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });

  document.getElementById("viewHome")?.classList.toggle("hidden", view !== "home");
  document.getElementById("viewStrategyQuery")?.classList.toggle("hidden", view !== "strategy-query");
  document.getElementById("viewStrategyAudit")?.classList.toggle("hidden", view !== "strategy-audit");
  document.getElementById("viewStrategyRenewal")?.classList.toggle("hidden", view !== "strategy-renewal");
  document.getElementById("viewStrategyShieldPlatform")?.classList.toggle("hidden", view !== "strategy-shield-platform");
  document.getElementById("viewDataAgent")?.classList.toggle("hidden", view !== "dataagent");
  document.getElementById("viewHandbook")?.classList.toggle("hidden", view !== "handbook");

  const isFullChat =
    view === "strategy-query" ||
    view === "strategy-audit" ||
    view === "strategy-renewal" ||
    view === "strategy-shield-platform" ||
    view === "dataagent";
  const isHome = view === "home";
  const isHandbook = view === "handbook";
  document.querySelector(".content")?.classList.toggle("content-strategy-query", isFullChat);
  document.querySelector(".content")?.classList.toggle("content-home", isHome);
  document.getElementById("resetBtn")?.classList.add("hidden");
  document.getElementById("statusBadge")?.classList.add("hidden");

  const titles = {
    home: "首页",
    "strategy-query": "策略查询",
    "strategy-audit": "策略审核",
    "strategy-renewal": "策略延期",
    "strategy-shield-platform": "定向屏蔽",
    dataagent: "Data Agent",
    handbook: "产品手册",
  };
  const crumb = document.getElementById("breadcrumbCurrent");
  if (crumb) crumb.textContent = titles[view] || "工作台";

  if (view === "home" && /^#hb-/.test(location.hash || "")) {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (_) {
      /* ignore */
    }
  }

  if (view === "home" && typeof window.onHomeViewEnter === "function") {
    window.onHomeViewEnter();
  }
  if (view === "strategy-query" && typeof window.onStrategyQueryViewEnter === "function") {
    window.onStrategyQueryViewEnter();
  }
  if (view === "strategy-audit" && typeof window.onStrategyAuditViewEnter === "function") {
    window.onStrategyAuditViewEnter();
  }
  if (view === "strategy-renewal" && typeof window.onStrategyRenewalViewEnter === "function") {
    window.onStrategyRenewalViewEnter();
  }
  if (view === "strategy-shield-platform" && typeof window.onStrategyShieldPlatformViewEnter === "function") {
    window.onStrategyShieldPlatformViewEnter();
  }
  if (view === "dataagent" && typeof window.onDataAgentViewEnter === "function") {
    window.onDataAgentViewEnter();
  }
  if (view === "handbook") {
    const hash = (location.hash || "").trim();
    if (hash && hash.startsWith("#hb-")) {
      window.setTimeout(() => {
        document.querySelector(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    }
  }

  closeMobileSidebar();
}

window.switchView = switchView;

function applyHandbookDeepLink() {
  const params = new URLSearchParams(location.search || "");
  const viewParam = (params.get("view") || "").trim();
  const hash = (location.hash || "").trim();
  if (viewParam === "handbook" || /^#hb-/.test(hash)) {
    switchView("handbook");
    return true;
  }
  return false;
}

function closeMobileSidebar() {
  document.querySelector(".app-shell")?.classList.remove("sidebar-open");
  document.body.classList.remove("sidebar-open");
}

function initMobileNav() {
  const toggle = document.getElementById("sidebarToggle");
  const backdrop = document.getElementById("sidebarBackdrop");
  const shell = document.querySelector(".app-shell");

  toggle?.addEventListener("click", () => {
    const open = shell?.classList.toggle("sidebar-open");
    document.body.classList.toggle("sidebar-open", Boolean(open));
  });

  backdrop?.addEventListener("click", closeMobileSidebar);

  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });
}

async function initCookiePanel() {
  const input = document.getElementById("kwabiCookieInput");
  const saveBtn = document.getElementById("kwabiCookieSave");
  const testBtn = document.getElementById("kwabiCookieTest");
  const status = document.getElementById("kwabiCookieStatus");
  if (!status) return;

  try {
    const resp = await fetch(`${API_BASE}/api/cookie/status`, {
      signal: AbortSignal.timeout(8000),
    });
    const result = await resp.json();
    const d = result.data || {};
    if (result.success) {
      applyCookieStatusUI(d, status);
    } else {
      status.textContent = "状态未知";
      status.className = "cookie-status";
    }
  } catch {
    status.textContent = "状态未知";
    status.className = "cookie-status";
  }

  const saved = getKwabiCookie();
  if (saved && input) {
    input.value = saved;
    // 个人覆盖仅作 KwaiBI 补充；Orient 仍以 Playwright 为准，勿盖掉已就绪状态
    if (!status.classList.contains("ok")) {
      status.textContent = "使用个人 Cookie";
      status.className = "cookie-status ok";
    }
  }

  saveBtn?.addEventListener("click", () => {
    const val = input?.value.trim() || "";
    if (!val) {
      localStorage.removeItem(KWABI_COOKIE_KEY);
      status.textContent = "已清除，使用服务端共享 Cookie";
      status.className = "cookie-status ok";
      status.style.fontWeight = "";
      clearCookieExpired();
    } else {
      setKwabiCookie(val);
      status.textContent = "已保存（个人覆盖）";
      status.className = "cookie-status ok";
      status.style.fontWeight = "";
      clearCookieExpired();
    }
  });

  testBtn?.addEventListener("click", async () => {
    const val = input?.value.trim() || "";
    if (val) setKwabiCookie(val);
    status.textContent = "验证中…";
    status.className = "cookie-status";

    try {
      const resp = await fetch(`${API_BASE}/api/cookie/status`, {
        signal: AbortSignal.timeout(8000),
      });
      const result = await resp.json();
      if (!result.success) {
        throw new Error(result.error || "状态接口失败");
      }
      const d = result.data || {};
      if (d.playwrightReady || d.serverConfigured) {
        applyCookieStatusUI(d, status);
        status.textContent = d.playwrightReady ? "Playwright 已就绪 ✓" : "服务连通 ✓";
      } else {
        throw new Error(d.hint || "Playwright 未就绪");
      }
    } catch (err) {
      status.textContent = `验证失败: ${err.message}`;
      status.className = "cookie-status err";
    }
  });
}

document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

initMobileNav();
initCookiePanel();

if (document.documentElement.classList.contains("github-ui")) {
  const params = new URLSearchParams(location.search || "");
  if (params.get("view") === "handbook") {
    switchView("handbook");
  } else {
    if (/^#hb-/.test(location.hash || "")) {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch (_) {
        /* ignore */
      }
    }
    switchView("home");
  }
  window.addEventListener("hashchange", () => {
    if (/^#hb-/.test(location.hash || "")) applyHandbookDeepLink();
  });
} else {
  switchView("home");
}
