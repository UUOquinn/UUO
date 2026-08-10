/**
 * 模块服务状态（生产 :3000 / 测试 :3001）
 * - 独立 div，渲染在输入框左侧空白区（不塞进输入框）
 * - 每个功能模块探测自己的只读 / 安全探测 API
 */
(function () {
  if (location.port !== "3000" && location.port !== "3001") return;

  const API_BASE = window.__API_BASE__ || "";
  const REFRESH_MS = 30000;

  /**
   * @typedef {{ key: string, label: string, path: string, method?: string, body?: any, okIf?: Function }} Probe
   * @typedef {{ key: string, label: string, path?: string, mount?: string, probes?: Probe[] }} ViewCheck
   */

  /** @type {Record<string, ViewCheck>} */
  const VIEW_CHECK = {
    viewStrategyAudit: {
      key: "audit",
      label: "/api/strategy/audit/users",
      path: "/api/strategy/audit/users",
    },
    viewStrategyRenewal: {
      key: "renewal",
      label: "/api/strategy/postpone/registry",
      path: "/api/strategy/postpone/registry",
    },
    viewStrategyShieldPlatform: {
      key: "orient-shield",
      label: "定向屏蔽",
      mount: "shield-plat",
      probes: [
        {
          key: "cookie",
          label: "/api/cookie/status",
          path: "/api/cookie/status",
          method: "GET",
        },
        {
          key: "renew-get",
          label: "/api/strategy/renew/get",
          path: "/api/strategy/renew/get",
          method: "POST",
          body: {},
          // 故意不传 id：期望 400 id is required，只验通路，不打 Orient（登录态看 Cookie）
          okIf: (resp, body) => {
            if (!resp) return false;
            if (resp.status === 404) return false;
            if (resp.status === 400) return true;
            if (body && /id is required|required/i.test(String(body.error || body.message || ""))) {
              return true;
            }
            // 带 Cookie 时偶发走到上游：策略不存在也算通路正常
            if (body && body.error === "STRATEGY_NOT_FOUND") return true;
            if (body && body.error === "COOKIE_EXPIRED") return false;
            return resp.ok === true;
          },
        },
        {
          key: "renew-submit",
          label: "/api/strategy/renew/submit",
          path: "/api/strategy/renew/submit",
          method: "POST",
          body: {},
          // 故意不传 id/body：期望 400，证明接口在线且未真实提审
          okIf: (resp, body) => {
            if (!resp) return false;
            if (resp.status === 404) return false;
            if (body && body.error === "COOKIE_EXPIRED") return false;
            if (resp.status === 400) return true;
            if (body && /id and body|required/i.test(String(body.error || body.message || ""))) {
              return true;
            }
            return resp.ok === true;
          },
        },
      ],
    },
    viewStrategyQuery: {
      key: "query",
      label: "/api/strategy/meta",
      path: "/api/strategy/meta",
    },
    viewDataAgent: {
      key: "dataagent",
      label: "/api/dataagent/status",
      path: "/api/dataagent/status",
    },
  };

  const VIEW_IDS = Object.keys(VIEW_CHECK);

  let timer = null;
  let probing = false;

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  /** @param {ViewCheck} check */
  function getProbes(check) {
    if (Array.isArray(check.probes) && check.probes.length) return check.probes;
    return [
      {
        key: check.key,
        label: check.label,
        path: check.path,
        method: "GET",
      },
    ];
  }

  /** 清掉上一版误塞进输入框的结构，把搜索条还原 */
  function cleanupLegacy(panel) {
    if (!panel) return;
    const row = panel.querySelector(".module-tools-row");
    if (!row) return;
    const searchBar = row.querySelector(".module-search-bar-top");
    const hint = panel.querySelector(".module-hint-slot");
    const composer = panel.querySelector(".agent-chat-composer");
    if (searchBar) {
      if (hint) panel.insertBefore(searchBar, hint);
      else if (composer) panel.insertBefore(searchBar, composer);
      else panel.insertBefore(searchBar, panel.firstChild);
    }
    row.remove();
  }

  function buildBlock(viewId, check) {
    const probes = getProbes(check);
    const root = el("aside", "module-api-health");
    root.dataset.view = viewId;
    root.dataset.key = check.key;
    root.dataset.layout = "v3-inline";
    root.setAttribute("aria-label", `${check.label} API 服务状态`);

    const head = el("div", "module-api-health-head");
    head.appendChild(el("span", "module-api-health-title", "API 服务状态"));
    const refreshBtn = el("button", "module-api-health-refresh");
    refreshBtn.type = "button";
    refreshBtn.title = "刷新探测";
    refreshBtn.setAttribute("aria-label", "刷新探测");
    refreshBtn.textContent = "刷新";
    head.appendChild(refreshBtn);

    const body = el("div", "module-api-health-body");
    const showPath = probes.length > 1;
    probes.forEach((probe) => {
      const row = el("div", "module-api-health-row is-pending");
      row.dataset.key = probe.key;
      const name = probe.label || probe.path;
      // 多探针：名称即标准 path；不再重复展示 path 列
      if (showPath) {
        row.classList.add("is-inline");
        row.innerHTML =
          `<span class="module-api-health-dot" aria-hidden="true"></span>` +
          `<span class="module-api-health-name" title="${probe.path}">${name}</span>` +
          `<span class="module-api-health-state">检测中…</span>`;
      } else {
        row.innerHTML =
          `<span class="module-api-health-dot" aria-hidden="true"></span>` +
          `<span class="module-api-health-name" title="${probe.path}">${name}</span>` +
          `<span class="module-api-health-state">检测中…</span>`;
      }
      body.appendChild(row);
    });

    const foot = el("div", "module-api-health-foot");
    foot.innerHTML = '<span class="module-api-health-updated">尚未检测</span>';

    root.appendChild(head);
    root.appendChild(body);
    root.appendChild(foot);
    refreshBtn.addEventListener("click", () => probeVisible(true));
    return root;
  }

  function findHealthBlock(viewId) {
    return (
      document.querySelector(
        `#${viewId} #shieldPlatApiHealthSlot > .module-api-health[data-view="${viewId}"]`
      ) ||
      document.querySelector(
        `#${viewId} > .module-api-health[data-view="${viewId}"]`
      ) ||
      document.querySelector(
        `#${viewId} > .agent-chat-shell > .module-api-health[data-view="${viewId}"]`
      )
    );
  }

  function mountIntoView(viewId) {
    const check = VIEW_CHECK[viewId];
    if (!check) return false;

    // 定向屏蔽：挂到「执行记录」下方槽位
    if (check.mount === "shield-plat") {
      const slot = document.getElementById("shieldPlatApiHealthSlot");
      if (!slot) return false;
      let block = findHealthBlock(viewId);
      // 旧版挂在 view 顶层，或探针行数变化时重建
      const needRebuild =
        block &&
        (block.parentElement !== slot ||
          block.dataset.layout !== "v3-inline" ||
          block.querySelectorAll(".module-api-health-row").length !==
            getProbes(check).length);
      if (needRebuild) {
        block.remove();
        block = null;
      }
      if (!block) {
        block = buildBlock(viewId, check);
        slot.appendChild(block);
      }
      return true;
    }

    const shell = document.querySelector(`#${viewId} .agent-chat-shell`);
    const panel = shell?.querySelector(".chat-mod-panel");
    if (!shell || !panel) return false;

    cleanupLegacy(panel);

    let block = shell.querySelector(
      `:scope > .module-api-health[data-view="${viewId}"]`
    );
    if (!block) {
      block = panel.querySelector(".module-api-health");
      if (block) {
        block.remove();
        block = null;
      }
    }
    if (!block) {
      block = buildBlock(viewId, check);
      shell.appendChild(block);
    }
    return true;
  }

  function mountAll() {
    let ok = true;
    VIEW_IDS.forEach((viewId) => {
      if (!mountIntoView(viewId)) ok = false;
    });
    return ok;
  }

  function getKwabiCookie() {
    return localStorage.getItem("kwabi-auth-cookie") || "";
  }

  function apiHeaders(extra) {
    const h = { ...(extra || {}) };
    const cookie = getKwabiCookie();
    if (cookie) h["X-Kwabi-Cookie"] = cookie;
    return h;
  }

  /** @param {Probe} probe */
  async function probeOne(probe) {
    const started = performance.now();
    const method = String(probe.method || "GET").toUpperCase();
    const paths =
      method === "GET"
        ? [probe.path, "/api/health"].filter((p, i, arr) => arr.indexOf(p) === i)
        : [probe.path];
    let lastErr = null;

    for (const path of paths) {
      try {
        const ctrl = new AbortController();
        const kill = setTimeout(() => ctrl.abort(), 8000);
        /** @type {RequestInit} */
        const opts = {
          method,
          credentials: "include",
          signal: ctrl.signal,
          headers: apiHeaders(
            method === "POST" ? { "Content-Type": "application/json" } : undefined
          ),
        };
        if (method === "POST") {
          opts.body = JSON.stringify(probe.body != null ? probe.body : {});
        }
        const resp = await fetch(`${API_BASE}${path}`, opts);
        clearTimeout(kill);
        const ms = Math.round(performance.now() - started);
        let body = null;
        try {
          body = await resp.json();
        } catch (_) {
          body = null;
        }
        if (resp.status === 404 && method === "GET" && path !== "/api/health") {
          lastErr = "接口未就绪";
          continue;
        }

        let ok;
        if (typeof probe.okIf === "function") {
          ok = !!probe.okIf(resp, body, ms);
        } else {
          ok =
            resp.ok &&
            body &&
            body.success !== false &&
            (body.error == null || body.error === "");
        }

        let detail;
        if (ok) {
          detail = `${ms}ms`;
          if (body && body.error === "STRATEGY_NOT_FOUND") detail = `${ms}ms · 通路正常`;
          if (resp.status === 400 && method === "POST") detail = `${ms}ms · 通路正常`;
        } else {
          const errCode = body && (body.error || body.message);
          if (errCode === "COOKIE_EXPIRED" || /COOKIE_EXPIRED/i.test(String(errCode || ""))) {
            detail = "Orient Cookie 过期，请重新登录";
          } else {
            detail = errCode || `HTTP ${resp.status}`;
          }
        }

        return {
          key: probe.key,
          ok: !!ok,
          detail,
          path,
        };
      } catch (err) {
        lastErr = err.name === "AbortError" ? "超时" : "网络异常";
      }
    }
    return {
      key: probe.key,
      ok: false,
      detail: lastErr || "网络异常",
      path: probe.path,
    };
  }

  function paintRow(row, result) {
    if (!row) return;
    row.classList.remove("is-pending", "is-ok", "is-err");
    row.classList.add(result.ok ? "is-ok" : "is-err");
    const state = row.querySelector(".module-api-health-state");
    if (state) {
      state.textContent = result.ok
        ? `正常 · ${result.detail}`
        : `异常 · ${result.detail}`;
      state.title = result.detail || "";
    }
  }

  function paintBlock(block, results) {
    const now = new Date();
    const timeText = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes()
    ).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

    const list = Array.isArray(results) ? results : [results];
    list.forEach((result) => {
      const row =
        block.querySelector(`.module-api-health-row[data-key="${result.key}"]`) ||
        block.querySelector(".module-api-health-row");
      paintRow(row, result);
    });
    const updated = block.querySelector(".module-api-health-updated");
    if (updated) updated.textContent = `更新于 ${timeText}`;
  }

  function activeViewId() {
    const active = document.querySelector(".view:not(.hidden)");
    if (active && VIEW_CHECK[active.id]) return active.id;
    return null;
  }

  async function probeVisible(force) {
    if (probing && !force) return;
    const viewId = activeViewId();
    if (!viewId) return;
    const check = VIEW_CHECK[viewId];
    const block = findHealthBlock(viewId);
    if (!check || !block) return;

    probing = true;
    const probes = getProbes(check);
    block
      .querySelectorAll(".module-api-health-row")
      .forEach((row) => row.classList.add("is-pending"));
    try {
      const results = [];
      for (const probe of probes) {
        results.push(await probeOne(probe));
      }
      paintBlock(block, results);
    } finally {
      probing = false;
    }
  }

  async function probeAllMounted(force) {
    if (probing && !force) return;
    probing = true;
    try {
      for (const viewId of VIEW_IDS) {
        const check = VIEW_CHECK[viewId];
        const block = findHealthBlock(viewId);
        if (!check || !block) continue;
        const probes = getProbes(check);
        block
          .querySelectorAll(".module-api-health-row")
          .forEach((row) => row.classList.add("is-pending"));
        const results = [];
        for (const probe of probes) {
          results.push(await probeOne(probe));
        }
        paintBlock(block, results);
      }
    } finally {
      probing = false;
    }
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => probeVisible(false), REFRESH_MS);
  }

  function onViewChange() {
    requestAnimationFrame(() => {
      mountAll();
      probeVisible(true);
    });
  }

  function hookViewSwitch() {
    document.querySelector(".nav")?.addEventListener("click", (event) => {
      if (event.target.closest("[data-view]")) onViewChange();
    });
    const original = window.switchView;
    if (typeof original === "function" && !original.__apiHealthHooked) {
      const wrapped = function () {
        const result = original.apply(this, arguments);
        onViewChange();
        setTimeout(onViewChange, 60);
        return result;
      };
      wrapped.__apiHealthHooked = true;
      window.switchView = wrapped;
    }
  }

  function boot() {
    let tries = 0;
    const wait = () => {
      tries += 1;
      if (mountAll() || tries >= 40) {
        probeVisible(true);
        startTimer();
        hookViewSwitch();
        return;
      }
      setTimeout(wait, 100);
    };
    wait();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 50));
  } else {
    setTimeout(boot, 50);
  }
})();
