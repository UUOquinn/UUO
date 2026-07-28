/* ═══════════════════════════════════════════════════════
 *  自动延期托管表 — strategy-postpone.js
 *  方案 A：系统内管理页 + 编辑白名单
 * ═══════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const API_BASE = window.__API_BASE__ || "";
  const LS_OPERATOR = "postpone-operator";
  // 默认管理员（本人）；localStorage 未设置时自动使用
  const DEFAULT_OPERATOR = "wb_wuqingyun03";

  let state = {
    items: [],
    perms: {},
    tab: "registry", // registry | editors | status
    editingId: null,
  };

  function getOperator() {
    const saved = (localStorage.getItem(LS_OPERATOR) || "").trim();
    if (saved) return saved;
    // 首次进入：写入默认管理员，避免本人打不开编辑
    localStorage.setItem(LS_OPERATOR, DEFAULT_OPERATOR);
    return DEFAULT_OPERATOR;
  }

  function setOperator(name) {
    const n = (name || "").trim();
    if (n) localStorage.setItem(LS_OPERATOR, n);
    else localStorage.removeItem(LS_OPERATOR);
  }

  function headers(extra) {
    const h = { "Content-Type": "application/json", ...extra };
    const op = getOperator();
    if (op) h["X-Postpone-Operator"] = op;
    const cookie = localStorage.getItem("kwabi-auth-cookie") || "";
    if (cookie) h["X-Kwabi-Cookie"] = cookie;
    return h;
  }

  async function api(path, opts) {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: (opts && opts.method) || "GET",
      headers: headers(),
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 403) {
      const err = new Error(data.message || "无权限");
      err.code = "FORBIDDEN";
      err.perms = data.perms;
      throw err;
    }
    if (!data.success) {
      throw new Error(data.message || data.error || "请求失败");
    }
    return data;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function fmtTime(ms) {
    if (!ms) return "—";
    try {
      return new Date(Number(ms)).toISOString().slice(0, 10);
    } catch {
      return String(ms);
    }
  }

  function openModal() {
    const modal = document.getElementById("postponeModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    const openBtn = document.getElementById("postponeRegistryBtn");
    if (openBtn) openBtn.classList.add("is-active");
    const opInput = document.getElementById("postponeOperatorInput");
    if (opInput) opInput.value = getOperator();
    loadRegistry();
  }

  function closeModal() {
    const modal = document.getElementById("postponeModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    const openBtn = document.getElementById("postponeRegistryBtn");
    if (openBtn) openBtn.classList.remove("is-active");
    const modalPanel = document.querySelector("#postponeModal .postpone-modal-panel");
    if (modalPanel) modalPanel.classList.remove("is-composing");
  }

  function togglePanel() {
    const modal = document.getElementById("postponeModal");
    if (!modal) return;
    if (modal.classList.contains("hidden")) openModal();
    else closeModal();
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll("[data-postpone-tab]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-postpone-tab") === tab);
    });
    const modalPanel = document.querySelector("#postponeModal .postpone-modal-panel");
    if (modalPanel) modalPanel.classList.remove("is-composing");
    renderBody();
    if (tab === "registry") loadRegistry();
    else if (tab === "editors") loadEditors();
    else if (tab === "status") loadStatus();
  }

  async function loadRegistry() {
    const body = document.getElementById("postponeModalBody");
    if (body && state.tab === "registry") {
      body.innerHTML = `<div class="postpone-empty">加载中…</div>`;
    }
    try {
      const res = await api("/api/strategy/postpone/registry");
      state.items = (res.data && res.data.items) || [];
      state.perms = (res.data && res.data.perms) || {};
      updateHeaderMeta();
      if (state.tab === "registry") renderBody();
    } catch (e) {
      if (body) body.innerHTML = `<div class="postpone-empty err">${esc(e.message)}</div>`;
    }
  }

  async function loadEditors() {
    const body = document.getElementById("postponeModalBody");
    if (body) body.innerHTML = `<div class="postpone-empty">加载中…</div>`;
    try {
      const res = await api("/api/strategy/postpone/editors");
      state.perms = (res.data && res.data.perms) || {};
      state.editorData = res.data || {};
      updateHeaderMeta();
      renderBody();
    } catch (e) {
      if (body) body.innerHTML = `<div class="postpone-empty err">${esc(e.message)}</div>`;
    }
  }

  async function loadStatus() {
    const body = document.getElementById("postponeModalBody");
    if (body) body.innerHTML = `<div class="postpone-empty">加载中…</div>`;
    try {
      const res = await api("/api/strategy/postpone/status");
      state.statusData = res.data || {};
      renderBody();
    } catch (e) {
      if (body) body.innerHTML = `<div class="postpone-empty err">${esc(e.message)}</div>`;
    }
  }

  function updateHeaderMeta() {
    const el = document.getElementById("postponeModalSub");
    if (!el) return;
    const p = state.perms || {};
    const enabled = (state.items || []).filter((i) => i.enabled).length;
    const total = (state.items || []).length;
    let permText = "只读";
    if (p.openMode) permText = "开放编辑（尚未锁定管理员）";
    else if (p.canManageEditors) permText = "管理员";
    else if (p.canEdit) permText = "可编辑";
    el.textContent = `${permText} · 共 ${total} 条 · 启用 ${enabled}` +
      (p.operator ? ` · 操作人 ${p.operator}` : " · 未设置操作人");
  }

  function renderBody() {
    const body = document.getElementById("postponeModalBody");
    if (!body) return;
    if (state.tab === "registry") body.innerHTML = renderRegistry();
    else if (state.tab === "editors") body.innerHTML = renderEditors();
    else body.innerHTML = renderStatus();
    bindBodyEvents();
  }

  function renderRegistry() {
    const canEdit = !!(state.perms && state.perms.canEdit);
    const items = state.items || [];
    const rows = items.length
      ? items
          .map((it) => {
            const on = !!it.enabled;
            return `<tr data-sid="${esc(it.strategy_id)}">
              <td><code>${esc(it.strategy_id)}</code></td>
              <td>${esc(it.owner || "—")}</td>
              <td>
                <button type="button" class="postpone-toggle ${on ? "is-on" : ""}" data-action="toggle" data-sid="${esc(it.strategy_id)}" ${canEdit ? "" : "disabled"}>
                  ${on ? "开" : "关"}
                </button>
              </td>
              <td class="postpone-note">${esc(it.note || "")}</td>
              <td class="postpone-ops">
                ${canEdit ? `<button type="button" class="chip-sm" data-action="edit" data-sid="${esc(it.strategy_id)}">改</button>
                <button type="button" class="chip-sm chip-danger" data-action="delete" data-sid="${esc(it.strategy_id)}">删</button>` : "—"}
              </td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="postpone-empty-cell">暂无托管策略，点击右上角「+ 添加」</td></tr>`;

    return `
      <div class="postpone-list-head">
        <div class="postpone-list-title">
          <span class="postpone-list-kicker">当前名单</span>
          <strong>${items.length} 条</strong>
          <span class="postpone-list-sep">·</span>
          <span>启用 ${(items.filter((i) => i.enabled).length)} 条</span>
        </div>
        <div class="postpone-list-actions">
          <label class="postpone-filter" title="筛选列表">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
              <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <input type="search" id="postponeSearch" placeholder="筛选 ID / owner" autocomplete="off" />
          </label>
          ${canEdit ? `<button type="button" class="audit-whitelist-btn" id="postponeAddBtn">+ 添加</button>` : ""}
        </div>
      </div>
      ${!canEdit ? `<p class="postpone-hint">只读 · 操作人须为白名单账号（管理员 wb_wuqingyun03）</p>` : ""}
      <div id="postponeFormPanel" class="postpone-composer hidden" hidden>
        <div class="postpone-composer-head">
          <div>
            <p class="postpone-composer-kicker">托管写入</p>
            <h4 id="postponeFormTitle">添加策略</h4>
          </div>
          <button type="button" class="postpone-composer-x" id="pfCancel" aria-label="关闭">×</button>
        </div>
        <div class="postpone-composer-fields">
          <label class="postpone-field">
            <span>策略 ID <em>*</em></span>
            <input id="pfId" type="text" inputmode="numeric" placeholder="例如 13938" />
          </label>
          <label class="postpone-field">
            <span>Owner</span>
            <input id="pfOwner" type="text" placeholder="业务负责人 / 团队" />
          </label>
          <label class="postpone-field postpone-field-span">
            <span>备注</span>
            <input id="pfNote" type="text" placeholder="可选，说明为何托管" />
          </label>
        </div>
        <div class="postpone-composer-foot">
          <label class="postpone-switch">
            <input id="pfEnabled" type="checkbox" checked />
            <span class="postpone-switch-ui" aria-hidden="true"></span>
            <span class="postpone-switch-text">加入后立即开启自动延期</span>
          </label>
          <button type="button" class="audit-whitelist-btn" id="pfSave">保存</button>
        </div>
      </div>
      <div class="postpone-table-wrap">
        <table class="postpone-table">
          <thead>
            <tr><th>策略 ID</th><th>Owner</th><th>自动延</th><th>备注</th><th>操作</th></tr>
          </thead>
          <tbody id="postponeTableBody">${rows}</tbody>
        </table>
      </div>
      <p class="postpone-foot">扫描节奏：每天早上 09:00 定点；表内且「开」的定向策略，剩余 ≤7 个自然日（含当天/已过期）自动延期。</p>
    `;
  }

  function renderEditors() {
    const canManage = !!(state.perms && state.perms.canManageEditors);
    const data = state.editorData || {};
    const admins = data.admins || [];
    const editors = data.editors || [];
    const openMode = !!(state.perms && state.perms.openMode);

    const adminLis = admins.length
      ? admins.map((n) => `<li><code>${esc(n)}</code>${canManage ? ` <button type="button" class="chip-sm chip-danger" data-action="rm-editor" data-name="${esc(n)}">移除</button>` : ""}</li>`).join("")
      : `<li class="postpone-empty-cell">暂无管理员</li>`;
    const editorLis = editors.length
      ? editors.map((n) => `<li><code>${esc(n)}</code>${canManage ? ` <button type="button" class="chip-sm chip-danger" data-action="rm-editor" data-name="${esc(n)}">移除</button>` : ""}</li>`).join("")
      : `<li class="postpone-empty-cell">暂无编辑人</li>`;

    return `
      ${openMode ? `<p class="postpone-hint warn">当前为开放模式（admins 为空）。请尽快添加至少一名管理员以锁定权限。</p>` : ""}
      ${!canManage ? `<p class="postpone-hint">仅管理员可维护本页。</p>` : ""}
      <div class="postpone-editor-cols">
        <div>
          <h4>管理员 admins</h4>
          <ul class="postpone-list">${adminLis}</ul>
        </div>
        <div>
          <h4>编辑人 editors</h4>
          <ul class="postpone-list">${editorLis}</ul>
        </div>
      </div>
      ${canManage ? `
        <div class="postpone-composer postpone-composer-inline">
          <div class="postpone-composer-head">
            <div>
              <p class="postpone-composer-kicker">权限写入</p>
              <h4>添加编辑人</h4>
            </div>
          </div>
          <div class="postpone-composer-fields">
            <label class="postpone-field postpone-field-span">
              <span>账号 <em>*</em></span>
              <input id="peName" type="text" placeholder="如 wb_zhangsan" />
            </label>
          </div>
          <div class="postpone-composer-foot">
            <label class="postpone-switch">
              <input id="peAsAdmin" type="checkbox" />
              <span class="postpone-switch-ui" aria-hidden="true"></span>
              <span class="postpone-switch-text">同时设为管理员</span>
            </label>
            <button type="button" class="audit-whitelist-btn" id="peSave">添加</button>
          </div>
        </div>` : ""}
    `;
  }

  function renderStatus() {
    const s = state.statusData || {};
    const logs = (s.log || []).slice().reverse();
    const last = s.lastResult;
    return `
      <div class="postpone-status-meta">
        <div>
          守护线程：${s.started ? "已启动" : "未启动"}
          · 运行中：${s.running ? "是" : "否"}
          · 日程 ${esc(s.schedule || "每天 09:00")}
          · 下次 ${esc(s.nextRunAt || "—")}
          · 窗口 ≤${esc(s.dueWithinDays != null ? s.dueWithinDays : 7)} 自然日
        </div>
        <button type="button" class="audit-whitelist-btn" id="postponeTriggerBtn">立即扫描一次</button>
      </div>
      ${last ? `<pre class="postpone-json">${esc(JSON.stringify(last, null, 2))}</pre>` : `<p class="postpone-hint">暂无扫描结果</p>`}
      <h4>最近日志</h4>
      <pre class="postpone-log">${logs.length ? esc(logs.join("\n")) : "（空）"}</pre>
    `;
  }

  function bindBodyEvents() {
    const search = document.getElementById("postponeSearch");
    if (search) {
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        document.querySelectorAll("#postponeTableBody tr[data-sid]").forEach((tr) => {
          const text = tr.textContent.toLowerCase();
          tr.style.display = !q || text.includes(q) ? "" : "none";
        });
      });
    }

    const addBtn = document.getElementById("postponeAddBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        state.editingId = null;
        showForm(null);
      });
    }

    document.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", onRowAction);
    });

    const pfCancel = document.getElementById("pfCancel");
    if (pfCancel) pfCancel.addEventListener("click", hideForm);
    const pfSave = document.getElementById("pfSave");
    if (pfSave) pfSave.addEventListener("click", saveForm);

    const peSave = document.getElementById("peSave");
    if (peSave) {
      peSave.addEventListener("click", async () => {
        const name = (document.getElementById("peName").value || "").trim();
        const asAdmin = !!(document.getElementById("peAsAdmin") || {}).checked;
        if (!name) return alert("请填写账号");
        try {
          await api("/api/strategy/postpone/editors/upsert", {
            method: "POST",
            body: { name, asAdmin },
          });
          await loadEditors();
        } catch (e) {
          alert(e.message);
        }
      });
    }

    const trigger = document.getElementById("postponeTriggerBtn");
    if (trigger) {
      trigger.addEventListener("click", async () => {
        try {
          await api("/api/strategy/postpone/trigger", { method: "POST", body: {} });
          alert("已触发扫描，稍后在本页刷新查看结果");
          setTimeout(loadStatus, 1500);
        } catch (e) {
          alert(e.message);
        }
      });
    }
  }

  function showForm(item) {
    const panel = document.getElementById("postponeFormPanel");
    if (!panel) return;
    panel.classList.remove("hidden");
    panel.hidden = false;
    const modalPanel = document.querySelector("#postponeModal .postpone-modal-panel");
    if (modalPanel) modalPanel.classList.add("is-composing");
    document.getElementById("postponeFormTitle").textContent = item ? `编辑策略 ${item.strategy_id}` : "添加策略";
    const idInput = document.getElementById("pfId");
    idInput.value = item ? item.strategy_id : "";
    idInput.disabled = !!item;
    document.getElementById("pfOwner").value = item ? item.owner || "" : getOperator();
    document.getElementById("pfEnabled").checked = item ? !!item.enabled : true;
    document.getElementById("pfNote").value = item ? item.note || "" : "";
    // 滚到表单顶部，再确保「保存」在可视区
    requestAnimationFrame(() => {
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      const saveBtn = document.getElementById("pfSave");
      if (saveBtn) {
        setTimeout(() => saveBtn.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
      }
    });
    if (!item) setTimeout(() => idInput.focus(), 120);
  }

  function hideForm() {
    const panel = document.getElementById("postponeFormPanel");
    if (panel) {
      panel.classList.add("hidden");
      panel.hidden = true;
    }
    const modalPanel = document.querySelector("#postponeModal .postpone-modal-panel");
    if (modalPanel) modalPanel.classList.remove("is-composing");
    state.editingId = null;
  }

  async function saveForm() {
    const sid = (document.getElementById("pfId").value || "").trim();
    if (!/^\d+$/.test(sid)) {
      alert("策略 ID 必须是数字");
      return;
    }
    try {
      await api("/api/strategy/postpone/registry/upsert", {
        method: "POST",
        body: {
          strategy_id: Number(sid),
          owner: document.getElementById("pfOwner").value || "",
          enabled: !!document.getElementById("pfEnabled").checked,
          note: document.getElementById("pfNote").value || "",
          renew_months: 1,
        },
      });
      hideForm();
      await loadRegistry();
    } catch (e) {
      alert(e.message);
    }
  }

  async function onRowAction(ev) {
    const btn = ev.currentTarget;
    const action = btn.getAttribute("data-action");
    const sid = btn.getAttribute("data-sid");
    const name = btn.getAttribute("data-name");

    if (action === "edit") {
      const item = (state.items || []).find((i) => String(i.strategy_id) === String(sid));
      state.editingId = sid;
      showForm(item || { strategy_id: sid, enabled: true });
      return;
    }
    if (action === "delete") {
      if (!confirm(`确认从托管表移除策略 ${sid}？`)) return;
      try {
        await api("/api/strategy/postpone/registry/delete", {
          method: "POST",
          body: { strategy_id: Number(sid) },
        });
        await loadRegistry();
      } catch (e) {
        alert(e.message);
      }
      return;
    }
    if (action === "toggle") {
      const item = (state.items || []).find((i) => String(i.strategy_id) === String(sid));
      if (!item) return;
      try {
        await api("/api/strategy/postpone/registry/upsert", {
          method: "POST",
          body: {
            strategy_id: Number(sid),
            enabled: !item.enabled,
            owner: item.owner || "",
            note: item.note || "",
            renew_months: item.renew_months || 1,
          },
        });
        await loadRegistry();
      } catch (e) {
        alert(e.message);
      }
      return;
    }
    if (action === "rm-editor") {
      if (!confirm(`确认移除 ${name}？`)) return;
      try {
        await api("/api/strategy/postpone/editors/delete", {
          method: "POST",
          body: { name },
        });
        await loadEditors();
      } catch (e) {
        alert(e.message);
      }
    }
  }

  function bindShell() {
    const openBtn = document.getElementById("postponeRegistryBtn");
    if (openBtn) openBtn.addEventListener("click", openModal);

    const closeBtn = document.getElementById("postponeModalClose");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    const backdrop = document.getElementById("postponeModalBackdrop");
    if (backdrop) backdrop.addEventListener("click", closeModal);

    document.querySelectorAll("[data-postpone-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setTab(btn.getAttribute("data-postpone-tab")));
    });

    const saveOp = document.getElementById("postponeOperatorSave");
    if (saveOp) {
      saveOp.addEventListener("click", () => {
        const v = (document.getElementById("postponeOperatorInput").value || "").trim();
        setOperator(v);
        updateHeaderMeta();
        if (state.tab === "registry") loadRegistry();
        else if (state.tab === "editors") loadEditors();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindShell);
  } else {
    bindShell();
  }

  window.PostponeRegistry = { open: openModal, close: closeModal, toggle: togglePanel };
})();
