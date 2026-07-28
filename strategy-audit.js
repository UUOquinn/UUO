/* ============================================================
 *  策略审核模块 v5.8 — 推全 + 封禁期 + 编排 flow
 *  核心逻辑：
 *    查询 = orientControl/get（策略信息）
 *    审核 = approve/changeStatus（后端自动转换策略ID→审核记录ID）
 *    立即推全 = {orient|dark|flow}Control/quickPushAll
 *    完整链路 = /api/strategy/audit/flow（normal|ban）
 *  审核状态体系（approve/query）不同于策略生效状态（orientControl/get）
 * ============================================================ */
(function () {
  "use strict";

  const API_BASE = window.__API_BASE__ || "";

  // ─── 审核操作映射 ───
  const ACTION = {
    check_pass:   { code: 6,  label: "审核通过",     color: "ok"  },
    check_fail:   { code: 3,  label: "审核驳回",     color: "err" },
    publish_pass: { code: 2,  label: "同意发布",     color: "ok"  },
    publish_fail: { code: 7,  label: "拒绝发布",     color: "err" },
    ban_pass:     { code: 13, label: "封禁期通过",   color: "ok"  },
    ban_fail:     { code: 14, label: "封禁期驳回",   color: "err" },
  };

  // ─── 策略生效状态（orientControl/get 返回） ───
  const STRATEGY_STATUS = {
    1: "待审核", 2: "待发布", 3: "审核中",
    4: "生效中", 5: "已撤回", 6: "已结束", 7: "草稿",
  };

  // ─── 审核状态（approve/query 返回） ───
  const APPROVE_STATUS = {
    1: "待审核", 2: "发布成功", 3: "审核驳回",
    6: "审核成功", 7: "发布失败", 10: "发布成功(10)",
    12: "封禁期待审核", 13: "封禁期审核通过", 14: "封禁期审核驳回",
  };

  // ─── 工具 ───
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
  const fmtDate = (ms) => { try { return new Date(Number(ms)).toISOString().slice(0, 10); } catch { return "-"; } };
  const fmtTime = (ms) => { try { return new Date(Number(ms)).toLocaleString("zh-CN"); } catch { return "-"; } };

  // ─── 消息 ───
  function addMsg(role, html) {
    const el = $("auditChatMessages");
    if (!el) return;
    const div = document.createElement("div");
    div.className = `agent-msg agent-msg-${role}`;
    div.innerHTML = `<div class="agent-msg-bubble"><div class="agent-msg-content">${html}</div></div>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }
  const addUser = (t) => addMsg("user", `<p>${esc(t)}</p>`);
  const addSys  = (h) => addMsg("system", h);
  const addOk   = (h) => addMsg("system", `<p class="ok">${h}</p>`);
  const addErr  = (h) => addMsg("system", `<p class="err">${h}</p>`);
  const addWarn = (h) => addMsg("system", `<p class="warn">${h}</p>`);

  // ─── API ───
  async function api(url, body) {
    const r = await fetch(`${API_BASE}${url}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const d = await r.json();
    if (!d.success) {
      if (d.error === "COOKIE_EXPIRED" && window.markCookieExpired) await window.markCookieExpired();
      throw new Error(d.message || d.error || "请求失败");
    }
    return d.data;
  }

  // ─── 查询策略 ───
  async function queryOne(id) {
    const resp = await api("/api/strategy/audit/get", { id: Number(id) });
    // 后端返回 Orient 包装：{ status:200, message, data: 策略详情 }
    // 需取内层 data，否则会把业务码 200 误当成生效状态
    let data = resp;
    if (data && data.data && typeof data.data === "object" && (data.data.id != null || data.data.name)) {
      data = data.data;
    }
    if (!data || (data.id == null && !data.name)) throw new Error("未找到策略");
    return data;
  }

  // ─── 渲染策略卡片 ───
  function renderCard(id, data) {
    const name = data.name || "-";
    const code = data.status;
    const desc = data.statusDesc || STRATEGY_STATUS[code] || `状态${code}`;
    const begin = data.beginTime ? fmtDate(data.beginTime) : "-";
    const end   = data.endTime   ? fmtDate(data.endTime)   : "-";
    const createTime = data.createTime ? fmtTime(data.createTime) : "-";
    const creator = data.creatorName || "-";
    const typeName = data._strategyType || data.typeDesc || (data.type === 7 ? "定向策略" : "类型" + data.type);

    // 操作按钮
    const btns = [
      ...Object.entries(ACTION).map(([key, cfg]) =>
        `<button class="chip-sm audit-action-btn${cfg.color === "err" ? " chip-danger" : ""}" data-action="${key}" data-id="${id}">${cfg.label}</button>`
      ),
      `<button class="chip-sm audit-action-btn" data-action="full_audit" data-id="${id}">审核(通过+发布+推全)</button>`,
      `<button class="chip-sm audit-action-btn" data-action="ban_audit" data-id="${id}">封禁审核</button>`,
      `<button class="chip-sm audit-action-btn chip-danger" data-action="push_full" data-id="${id}">立即推全</button>`,
      `<button class="chip-sm audit-action-btn chip-danger" data-action="ban_push_full" data-id="${id}">封禁期立即推全</button>`,
    ].join("");

    addSys(`
      <div class="audit-card">
        <div class="audit-card-header">
          <div><strong>#${id}</strong> <span style="font-weight:500">${esc(name)}</span></div>
          <span class="audit-status ${code === 4 ? 'ok' : code === 2 ? 'err' : ''}">${esc(desc)}</span>
        </div>
        <div class="audit-card-body">
          <div class="audit-field"><span class="label">类型</span><span class="value">${esc(typeName)}</span></div>
          <div class="audit-field"><span class="label">生效时间</span><span class="value">${begin} ~ ${end}</span></div>
          <div class="audit-field"><span class="label">创建时间</span><span class="value">${createTime}</span></div>
          <div class="audit-field"><span class="label">创建者</span><span class="value">${esc(creator)}</span></div>
          <div class="audit-tip">💡 上方为策略<strong>生效状态</strong>。审核操作由 Orient 平台校验，状态不匹配时会自动拒绝。</div>
        </div>
        <div class="audit-card-actions">${btns}</div>
      </div>
    `);
  }

  // ─── 执行审核操作 ───
  // opts: { creatorId, approveId }
  // 返回 true 表示成功，false 表示失败
  async function doAction(id, actionKey, opts) {
    const cfg = ACTION[actionKey];
    if (!cfg) return false;
    opts = opts || {};

    addSys(`<p>策略 <strong>#${id}</strong>：正在执行「${cfg.label}」…</p>`);

    try {
      const body = {
        id: Number(id),
        status: cfg.code,
        reason: cfg.label,
      };
      if (opts.creatorId != null) body.creatorId = Number(opts.creatorId);
      if (opts.approveId != null) body.approveId = Number(opts.approveId);
      await api("/api/strategy/audit/changeStatus", body);

      addOk(`✓ 策略 <strong>#${id}</strong>「${cfg.label}」成功`);

      // 成功后刷新查询
      try {
        const fresh = await queryOne(id);
        const freshLabel = fresh.statusDesc || STRATEGY_STATUS[fresh.status] || `状态${fresh.status}`;
        addSys(`<p>策略当前生效状态：<strong>${freshLabel}</strong></p>`);
      } catch (e) {
        // 刷新失败不影响主流程
      }
      return true;
    } catch (err) {
      const msg = err.message || "";
      addErr(`✗ 策略 <strong>#${id}</strong>「${cfg.label}」失败：${esc(msg)}`);

      if (msg.includes("状态流转") || msg.includes("无法应用")) {
        addWarn(`💡 该策略在 Orient 审核平台当前不允许执行「${cfg.label}」。<br>常见原因：<br>• 策略不在对应审核状态（如需待审核才能审核通过）<br>• 审核单仍为「审核成功」时才可同意发布（目标 status=2）<br>建议：在 <a href="https://operation-tool.corp.kuaishou.com/approve" target="_blank">Orient 审核平台</a> 确认策略审核状态。`);
      } else if (msg.includes("APPROVE_NOT_FOUND") || msg.includes("未找到审核记录")) {
        addWarn(`💡 该策略未在审核平台找到审核记录。<br>可能原因：<br>• 策略尚未提交审核<br>• 策略审核流程已结束<br>• 策略不在当前审核人的审核范围内<br>建议：在 <a href="https://operation-tool.corp.kuaishou.com/approve" target="_blank">Orient 审核平台</a> 确认。`);
      } else if (msg.includes("权限")) {
        addWarn(`💡 Orient 权限限制：不能审批自己提交的策略。`);
      } else if (msg.includes("Cookie") || msg.includes("登录")) {
        addWarn(`💡 Cookie 已过期或未登录。服务端 Playwright 浏览器会自动续期，如仍失败请检查服务端登录状态。`);
      }
      return false;
    }
  }

  async function doFlow(id, mode, opts) {
    const label =
      mode === "ban" ? "封禁审核(通过+条件推全)"
        : mode === "publish_replay" ? "发布补跑(同意发布+条件推全)"
          : "审核(通过+发布+条件推全)";
    opts = opts || {};
    addSys(`<p>策略 <strong>#${id}</strong>：正在执行「${label}」…</p>`);
    try {
      const body = { id: Number(id), mode };
      if (opts.creatorId != null) body.creatorId = Number(opts.creatorId);
      if (opts.approveId != null) body.approveId = Number(opts.approveId);
      const data = await api("/api/strategy/audit/flow", body);
      const push = data.push || {};
      if (!data.ok || data.stuckAt === 6 || (data.auditOk && data.publishOk === false)) {
        const last = (data.steps || []).slice(-1)[0] || {};
        const detail = last.message || push.message || "编排未完全成功";
        if (data.stuckAt === 6 || (data.auditOk && data.publishOk === false)) {
          addErr(`✗ 策略 <strong>#${id}</strong> 发布失败（卡在审核成功）: ${esc(detail)}`);
        } else {
          addErr(`✗ 策略 <strong>#${id}</strong>「${label}」失败：${esc(detail)}`);
        }
        return false;
      }
      if (push.skipped) {
        addOk(`✓ 策略 <strong>#${id}</strong>「${label}」完成（${esc(push.message || "无需推全")}）`);
      } else if (push.ok) {
        addOk(`✓ 策略 <strong>#${id}</strong>「${label}」完成并已推全`);
      } else {
        addOk(`✓ 策略 <strong>#${id}</strong> 审核步骤完成`);
        if (push.message || push.error) {
          addWarn(`推全未成功：${esc(push.message || push.error)}`);
        }
      }
      return true;
    } catch (err) {
      addErr(`✗ 策略 <strong>#${id}</strong>「${label}」失败：${esc(err.message || "")}`);
      return false;
    }
  }

  async function doPushFull(id, mode) {
    const label = mode === "ban" ? "封禁期立即推全" : "立即推全";
    addSys(`<p>策略 <strong>#${id}</strong>：正在执行「${label}」…</p>`);
    try {
      const data = await api("/api/strategy/audit/pushFull", { id: Number(id), mode });
      if (data.skipped) {
        addWarn(`策略 <strong>#${id}</strong>：${esc(data.message || "已跳过")}`);
      } else {
        addOk(`✓ 策略 <strong>#${id}</strong>「${label}」成功`);
      }
      return true;
    } catch (err) {
      addErr(`✗ 策略 <strong>#${id}</strong>「${label}」失败：${esc(err.message || "")}`);
      return false;
    }
  }

  // ─── 命令解析 ───
  function parseCmd(text) {
    const t = text.trim();
    // 提取数字ID
    const ids = [...new Set((t.match(/\b\d{4,}\b/g) || []))];
    // 判断意图
    let intent = "query";
    if (/^(通过|审核通过)\s+/.test(t)) intent = "check_pass";
    else if (/^(发布|同意发布)\s+/.test(t)) intent = "publish_pass";
    else if (/^(驳回|审核驳回)\s+/.test(t)) intent = "check_fail";
    else if (/^(拒绝|拒绝发布)\s+/.test(t)) intent = "publish_fail";
    else if (/^(封禁通过|封禁期通过)\s+/.test(t)) intent = "ban_pass";
    else if (/^(封禁驳回|封禁期驳回)\s+/.test(t)) intent = "ban_fail";
    else if (/^(封禁审核|封禁期审核)\s+/.test(t)) intent = "ban_audit";
    else if (/^(封禁推全|封禁期推全|封禁期立即推全)\s+/.test(t)) intent = "ban_push_full";
    else if (/^(推全|立即推全)\s+/.test(t)) intent = "push_full";
    else if (/^审核\s+/.test(t)) intent = "full_audit";
    return { intent, ids };
  }

  // ─── 主处理 ───
  async function handle(text) {
    if (typeof window.recordFunnelHistory === "function") {
      window.recordFunnelHistory(text, "strategy-audit");
    }
    const { intent, ids } = parseCmd(text);
    if (!ids.length) {
      addSys(`<p>未识别到策略 ID。支持的命令：</p>
        <ul style="margin:8px 0;padding-left:20px;line-height:1.8">
          <li><code>14898</code> — 查询策略信息</li>
          <li><code>通过 14898</code> — 审核通过</li>
          <li><code>发布 14898</code> — 同意发布</li>
          <li><code>驳回 14898</code> — 审核驳回</li>
          <li><code>拒绝 14898</code> — 拒绝发布</li>
          <li><code>审核 14898</code> — 通过+发布+可推全则立即推全</li>
          <li><code>推全 14898</code> — 立即推全</li>
          <li><code>封禁审核 14898</code> — 封禁期通过+可推全则封禁期立即推全</li>
          <li><code>封禁通过 / 封禁驳回 / 封禁推全 14898</code></li>
        </ul>
        <p class="audit-tip">Orient 审核平台会自动校验审核状态；立即推全看详情 displayQuickPushBtn。</p>`);
      return;
    }

    addUser(text);
    $("auditMetaBadge").textContent = `执行中 ${ids.length} 条`;

    for (const id of ids) {
      if (intent === "query") {
        try {
          const data = await queryOne(id);
          renderCard(id, data);
        } catch (err) {
          const msg = err.message || "";
          if (msg.includes("STRATEGY_NOT_FOUND")) {
            addErr(`策略 #${id} 未找到：该 ID 在所有策略类型（定向/扶持/暗投/综合/媒体）中均不存在。`);
            addWarn(`💡 可能原因：<br>• 策略 ID 输入有误<br>• 策略已被删除<br>• 策略尚未在 Orient 平台创建`);
          } else {
            addErr(`策略 #${id} 查询失败：${esc(msg)}`);
          }
        }
      } else if (intent === "full_audit") {
        await doFlow(id, "normal");
      } else if (intent === "ban_audit") {
        await doFlow(id, "ban");
      } else if (intent === "push_full") {
        await doPushFull(id, "normal");
      } else if (intent === "ban_push_full") {
        await doPushFull(id, "ban");
      } else {
        await doAction(id, intent);
      }
    }

    $("auditMetaBadge").textContent = `完成 ${ids.length} 条`;
  }

  // ─── 事件绑定 ───
  function bindEvents() {
    const sendBtn = $("auditChatSend");
    const input = $("auditChatInput");
    if (!sendBtn || !input) return;

    sendBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      handle(text);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });

    // 快捷提示
    document.querySelectorAll("[data-hint-audit]").forEach((btn) => {
      btn.addEventListener("click", () => { input.value = btn.dataset.hintAudit; input.focus(); });
    });

    // 卡片/批量按钮：统一委托到审核视图容器
    const auditView = document.getElementById("viewStrategyAudit");
    if (auditView && !auditView.__auditResultsBound) {
      auditView.__auditResultsBound = true;
      auditView.addEventListener("click", handleAuditResultsClick);
    }
  }

  // ─── View Enter ───
  window.onStrategyAuditViewEnter = function () {
    $("auditMetaBadge").textContent = "就绪";
  };

  // ─── 初始化 ───
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEvents);
  } else {
    bindEvents();
  }

  // ═══════════════════════════════════════════════════════
  //  v5.1 新增：按提交审核人维度审核（不动现有代码）
  //
  //  命令格式：
  //    审核人 张三           — 查询张三的所有待审核策略
  //    审核人 张三 通过       — 批量审核通过张三的所有待审核策略
  //    审核人 wb_wuqingyun03  — 支持花名/wb_前缀用户名
  //
  //  实现方式：在 send 按钮上注册 capturing 事件，
  //  优先拦截"审核人"命令，不匹配则让现有 handle() 处理。
  //  现有功能代码完全不动。
  // ═══════════════════════════════════════════════════════

  // ─── 获取提交审核人列表 ───
  async function fetchAuditUsers() {
    const r = await fetch(`${API_BASE}/api/strategy/audit/users`, {
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.message || d.error || "获取审核人列表失败");
    return d.data || [];
  }

  // ─── 按审核人查询待审核策略 ───
  async function queryByCreator(creatorId, status) {
    const r = await fetch(`${API_BASE}/api/strategy/audit/queryByCreator`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creatorId: Number(creatorId), status: Number(status || 1) }),
      signal: AbortSignal.timeout(45000),
    });
    const d = await r.json();
    if (!d.success) {
      if (d.error === "COOKIE_EXPIRED" && window.markCookieExpired) await window.markCookieExpired();
      throw new Error(d.message || d.error || "查询失败");
    }
    return d.data;
  }

  // ─── 模糊匹配用户名 ───
  function matchUser(users, keyword) {
    const k = keyword.toLowerCase().trim();
    if (!k) return null;
    // 1. 精确匹配（大小写不敏感）
    let m = users.find(u => (u.name || "").toLowerCase() === k);
    if (m) return m;
    // 2. 去掉 wb_ 前缀后精确匹配
    m = users.find(u => (u.name || "").replace(/^wb_/, "").toLowerCase() === k.replace(/^wb_/, ""));
    if (m) return m;
    // 3. 包含匹配
    m = users.find(u => (u.name || "").toLowerCase().includes(k));
    if (m) return m;
    // 4. 去掉 wb_ 前缀后包含匹配
    m = users.find(u => (u.name || "").replace(/^wb_/, "").toLowerCase().includes(k.replace(/^wb_/, "")));
    return m || null;
  }

  // ─── 待审列表：全部 / 部分范围（默认全部，行为与线上一致）───
  function getBlockAllIds(block) {
    try {
      return JSON.parse(block.dataset.allIds || "[]").map(Number).filter(Boolean);
    } catch {
      return [];
    }
  }

  function getBlockSelectedIds(block) {
    return [...block.querySelectorAll(".audit-pick-cb:checked")]
      .map((cb) => Number(cb.value))
      .filter(Boolean);
  }

  function resolveBatchIds(block, fallbackIds) {
    if (!block) return fallbackIds;
    if ((block.dataset.scope || "all") === "partial") return getBlockSelectedIds(block);
    const all = getBlockAllIds(block);
    return all.length ? all : fallbackIds;
  }

  function syncAuditScopeUi(block) {
    if (!block) return;
    const scope = block.dataset.scope || "all";
    const allIds = getBlockAllIds(block);
    const selected = getBlockSelectedIds(block);
    const count = scope === "partial" ? selected.length : allIds.length;

    block.querySelectorAll("[data-audit-scope]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.auditScope === scope);
    });
    block.querySelectorAll(".audit-batch-btn").forEach((btn) => {
      const base = btn.dataset.labelBase;
      if (base) btn.textContent = `${base} (${count})`;
    });
    const countEl = block.querySelector(".audit-scope-count");
    if (countEl) {
      countEl.textContent =
        scope === "partial"
          ? `已选 ${selected.length} / ${allIds.length}`
          : `全部 ${allIds.length} 条`;
    }
    const pickTools = block.querySelector(".audit-pick-tools");
    if (pickTools) pickTools.hidden = scope !== "partial";
  }

  // ─── 渲染审核人的待审核策略列表 ───
  function renderCreatorRecords(creatorName, records, status, creatorId) {
    const statusLabel = APPROVE_STATUS[status] || `状态${status}`;
    if (!records || records.length === 0) {
      addSys(`<p>审核人 <strong>${esc(creatorName)}</strong> 在「${esc(statusLabel)}」下无待审核记录。</p>`);
      return;
    }

    const allIds = records.map((r) => r.ruleId);
    const approveMap = {};
    records.forEach((r) => {
      if (r.ruleId != null && r.id != null) approveMap[String(r.ruleId)] = r.id;
    });
    const recordList = records.map(r => {
      const ruleId = r.ruleId;
      const approveId = r.id != null ? r.id : "";
      const ruleName = esc(r.ruleName || "-");
      const approveStatus = APPROVE_STATUS[r.status] || r.statusDesc || `状态${r.status}`;
      const effectStatus =
        r.strategyStatusDesc ||
        STRATEGY_STATUS[r.strategyStatus] ||
        (r.strategyStatus != null ? `状态${r.strategyStatus}` : "-");
      const typeDesc = r.type === 1 ? "暗投策略" : r.type === 5 ? "定向策略" : r.type === 3 ? "扶持策略" : `类型${r.type}`;
      const st = Number(status);
      let actionBtns = "";
      if (st === 12) {
        actionBtns = `<button class="chip-sm audit-action-btn" data-action="ban_pass" data-id="${ruleId}" data-approve-id="${approveId}">封禁期通过</button>
          <button class="chip-sm chip-danger audit-action-btn" data-action="ban_fail" data-id="${ruleId}" data-approve-id="${approveId}">封禁期驳回</button>
          <button class="chip-sm audit-action-btn" data-action="ban_audit" data-id="${ruleId}" data-approve-id="${approveId}">封禁审核</button>`;
      } else if (st === 6) {
        actionBtns = `<button class="chip-sm audit-action-btn" data-action="publish_pass" data-id="${ruleId}" data-approve-id="${approveId}">同意发布</button>
          <button class="chip-sm audit-action-btn" data-action="full_audit" data-id="${ruleId}" data-approve-id="${approveId}">发布+推全</button>`;
      } else {
        actionBtns = `<button class="chip-sm audit-action-btn" data-action="check_pass" data-id="${ruleId}" data-approve-id="${approveId}">审核通过</button>
          <button class="chip-sm chip-danger audit-action-btn" data-action="check_fail" data-id="${ruleId}" data-approve-id="${approveId}">审核驳回</button>
          <button class="chip-sm audit-action-btn" data-action="full_audit" data-id="${ruleId}" data-approve-id="${approveId}">审核(含推全)</button>`;
      }
      return `<div class="audit-card" data-rule-id="${ruleId}" data-approve-id="${approveId}">
        <div class="audit-card-header">
          <label class="audit-pick" title="部分审核时勾选">
            <input type="checkbox" class="audit-pick-cb" value="${ruleId}">
          </label>
          <div><strong>#${ruleId}</strong> <span style="font-weight:500">${ruleName}</span></div>
          <span class="audit-status">${esc(approveStatus)}</span>
        </div>
        <div class="audit-card-body">
          <div class="audit-field"><span class="label">生效状态</span><span class="value">${esc(effectStatus)}</span></div>
          <div class="audit-field"><span class="label">类型</span><span class="value">${esc(typeDesc)}</span></div>
          <div class="audit-field"><span class="label">提交人</span><span class="value">${esc(r.creatorName || "-")}</span></div>
          <div class="audit-field"><span class="label">审核人</span><span class="value">${esc(r.approverName || "-")}</span></div>
          <div class="audit-tip">💡 「审核状态」见右上角；「生效状态」来自 Orient 策略详情。</div>
        </div>
        <div class="audit-card-actions">${actionBtns}</div>
      </div>`;
    }).join("");

    const idsJson = JSON.stringify(allIds);
    const approveMapJson = JSON.stringify(approveMap).replace(/'/g, "&#39;");
    let batchBtns = "";
    if (status === 1 && allIds.length >= 1) {
      batchBtns = `<div class="audit-batch-row">
        <button class="chip-sm audit-batch-btn" data-batch-action="check_pass" data-label-base="批量审核通过" data-ids='${idsJson}'>批量审核通过 (${allIds.length})</button>
        <button class="chip-sm audit-batch-btn" data-batch-action="publish_pass" data-label-base="批量同意发布" data-ids='${idsJson}'>批量同意发布 (${allIds.length})</button>
        <button class="chip-sm audit-batch-btn" data-batch-action="full_audit" data-label-base="批量审核(含推全)" data-ids='${idsJson}'>批量审核(含推全) (${allIds.length})</button>
      </div>`;
    } else if (status === 6 && allIds.length >= 1) {
      batchBtns = `<div class="audit-batch-row">
        <button class="chip-sm audit-batch-btn" data-batch-action="publish_pass" data-label-base="批量同意发布" data-ids='${idsJson}'>批量同意发布 (${allIds.length})</button>
        <button class="chip-sm audit-batch-btn" data-batch-action="publish_replay" data-label-base="批量发布+推全" data-ids='${idsJson}'>批量发布+推全 (${allIds.length})</button>
      </div>`;
    } else if (status === 12 && allIds.length >= 1) {
      batchBtns = `<div class="audit-batch-row">
        <button class="chip-sm audit-batch-btn" data-batch-action="ban_pass" data-label-base="批量封禁期通过" data-ids='${idsJson}'>批量封禁期通过 (${allIds.length})</button>
        <button class="chip-sm audit-batch-btn" data-batch-action="ban_audit" data-label-base="批量封禁审核(含推全)" data-ids='${idsJson}'>批量封禁审核(含推全) (${allIds.length})</button>
      </div>`;
    }

    const scopeBar = allIds.length >= 1
      ? `<div class="audit-scope-row">
          <span class="audit-scope-label">审核范围</span>
          <button type="button" class="chip-sm audit-scope-btn is-active" data-audit-scope="all">全部策略</button>
          <button type="button" class="chip-sm audit-scope-btn" data-audit-scope="partial">部分策略</button>
          <span class="audit-scope-count">全部 ${allIds.length} 条</span>
          <span class="audit-pick-tools" hidden>
            <button type="button" class="chip-sm" data-audit-pick-all>全选</button>
            <button type="button" class="chip-sm" data-audit-pick-none>清空</button>
          </span>
        </div>`
      : "";

    const creatorAttr = creatorId != null ? ` data-creator-id="${creatorId}"` : "";
    addSys(`
      <div class="audit-creator-block" id="auditPendingBlock" data-scope="all" data-all-ids='${idsJson}' data-approve-map='${approveMapJson}'${creatorAttr}>
        <div class="audit-creator-summary">${esc(creatorName)} · ${esc(statusLabel)} · ${records.length} 条</div>
        ${scopeBar}
        ${batchBtns}
        ${recordList}
      </div>
    `);
  }

  function optsFromBlock(block, ruleId, approveIdHint) {
    const opts = {};
    if (block && block.dataset.creatorId) opts.creatorId = Number(block.dataset.creatorId);
    let approveId = approveIdHint;
    if (approveId == null && block && block.dataset.approveMap) {
      try {
        const map = JSON.parse(block.dataset.approveMap);
        approveId = map[String(ruleId)];
      } catch (_) { /* ignore */ }
    }
    if (approveId != null && approveId !== "") opts.approveId = Number(approveId);
    return opts;
  }

  // ─── 为审核记录补齐策略生效状态（orientControl/get）───
  async function enrichRecordsWithStrategyStatus(records) {
    if (!records || !records.length) return records || [];
    const out = [];
    for (const r of records) {
      const item = { ...r };
      try {
        const detail = await queryOne(r.ruleId);
        item.strategyStatus = detail.status;
        item.strategyStatusDesc =
          detail.statusDesc || STRATEGY_STATUS[detail.status] || `状态${detail.status}`;
      } catch (err) {
        item.strategyStatusDesc = "查询失败";
      }
      out.push(item);
    }
    return out;
  }

  // ─── 按审核人维度处理 ───
  async function handleByCreator(text) {
    const m = text.match(/^审核人\s+(.+?)(?:\s+(通过|发布|驳回|拒绝))?$/);
    if (!m) return false;

    const keyword = m[1].trim();
    const actionKeyword = m[2];

    addSys(`<p>正在查询提交审核人 <strong>${esc(keyword)}</strong> 的待审核策略…</p>`);

    // Step 1: 获取审核人列表
    let users;
    try {
      users = await fetchAuditUsers();
    } catch (err) {
      addErr(`获取审核人列表失败：${esc(err.message)}`);
      if (err.message.includes("Cookie") || err.message.includes("登录")) {
        addWarn(`💡 Cookie 已过期或未登录。服务端 Playwright 浏览器会自动续期，如仍失败请检查服务端登录状态。`);
      }
      return true;
    }

    // Step 2: 模糊匹配
    const matched = matchUser(users, keyword);
    if (!matched) {
      addErr(`未找到匹配「${esc(keyword)}」的审核人。`);
      addWarn(`💡 可用审核人共 ${users.length} 位。请尝试更精确的用户名（如 wb_xxx 或去掉 wb_ 前缀）。`);
      return true;
    }

    addOk(`匹配到审核人：${esc(matched.name)}（ID: ${matched.id}）`);

    const inWhitelist = isRealtimeAllowed(matched.id);

    // Step 3: 查询该审核人的待审核记录（status=1）
    let data;
    try {
      data = await queryByCreator(matched.id, 1);
    } catch (err) {
      addErr(`查询失败：${esc(err.message)}`);
      return true;
    }

    // Step 4: 补齐生效状态后渲染（含批量操作按钮）
    addSys(`<p>正在补齐策略生效状态…</p>`);
    const enriched = await enrichRecordsWithStrategyStatus(data.records || []);
    renderCreatorRecords(matched.name, enriched, 1, matched.id);

    // Step 5: 白名单用户未指定操作时自动两步审核；非白名单仅展示列表，由用户点批量按钮
    if (data.records.length === 0) {
      addSys(`<p>该审核人当前无待审核策略，无需操作。</p>`);
    } else if (actionKeyword) {
      const actionMap = { 通过: "check_pass", 发布: "publish_pass", 驳回: "check_fail", 拒绝: "publish_fail" };
      const actionKey = actionMap[actionKeyword];
      if (actionKey) {
        addSys(`<p>开始批量「${ACTION[actionKey].label}」${data.records.length} 条策略…</p>`);
        for (const r of data.records) {
          await doAction(r.ruleId, actionKey, {
            creatorId: matched.id,
            approveId: r.id,
          });
        }
      }
    } else if (inWhitelist) {
      addSys(`<p>白名单用户：开始批量审核（通过+发布+条件推全）${data.records.length} 条策略…</p>`);
      for (const r of data.records) {
        await doFlow(r.ruleId, "normal", {
          creatorId: matched.id,
          approveId: r.id,
        });
      }
    }

    return true;
  }

  // ─── 拦截 send 按钮事件：优先处理"审核人"命令（capturing 阶段）───
  const _creatorSendBtn = $("auditChatSend");
  const _creatorInput = $("auditChatInput");
  if (_creatorSendBtn && _creatorInput) {
    _creatorSendBtn.addEventListener("click", async (e) => {
      const text = _creatorInput.value.trim();
      if (!text) return;
      if (/^审核人\s+/.test(text)) {
        // 拦截！阻止现有 handle() 执行
        e.stopImmediatePropagation();
        e.preventDefault();
        _creatorInput.value = "";
        if (typeof window.recordFunnelHistory === "function") {
          window.recordFunnelHistory(text, "strategy-audit");
        }
        addUser(text);
        $("auditMetaBadge").textContent = "查询审核人…";
        try {
          await handleByCreator(text);
        } catch (err) {
          addErr(`执行失败：${esc(err.message || "")}`);
        }
        $("auditMetaBadge").textContent = "就绪";
      }
    }, true); // capturing 阶段优先于现有 bubbling 阶段
  }

  // ─── 审核结果区事件委托（消息区 + 待审核独立容器） ───
  async function handleAuditResultsClick(e) {
    const scopeBtn = e.target.closest("[data-audit-scope]");
    if (scopeBtn) {
      const block = scopeBtn.closest(".audit-creator-block");
      if (!block) return;
      block.dataset.scope = scopeBtn.dataset.auditScope || "all";
      syncAuditScopeUi(block);
      return;
    }

    const pickAllBtn = e.target.closest("[data-audit-pick-all]");
    if (pickAllBtn) {
      const block = pickAllBtn.closest(".audit-creator-block");
      if (!block) return;
      block.querySelectorAll(".audit-pick-cb").forEach((cb) => { cb.checked = true; });
      syncAuditScopeUi(block);
      return;
    }

    const pickNoneBtn = e.target.closest("[data-audit-pick-none]");
    if (pickNoneBtn) {
      const block = pickNoneBtn.closest(".audit-creator-block");
      if (!block) return;
      block.querySelectorAll(".audit-pick-cb").forEach((cb) => { cb.checked = false; });
      syncAuditScopeUi(block);
      return;
    }

    const batchBtn = e.target.closest(".audit-batch-btn");
    if (batchBtn) {
      const action = batchBtn.dataset.batchAction;
      const block = batchBtn.closest(".audit-creator-block");
      let fallback = [];
      try { fallback = JSON.parse(batchBtn.dataset.ids || "[]"); } catch { fallback = []; }
      const ids = resolveBatchIds(block, fallback);
      if (!ids.length) {
        if (block && block.dataset.scope === "partial") {
          addWarn("请先勾选要审核的策略，或切换回「全部策略」。");
        }
        return;
      }
      const label = ACTION[action]?.label || action;
      const scopeNote = block && block.dataset.scope === "partial" ? "（已选部分）" : "";
      addSys(`<p>开始批量「${esc(label)}」${ids.length} 条策略${scopeNote}…</p>`);
      for (const id of ids) {
        const opts = optsFromBlock(block, id);
        if (action === "full_audit") await doFlow(id, "normal", opts);
        else if (action === "publish_replay") await doFlow(id, "publish_replay", opts);
        else if (action === "ban_audit") await doFlow(id, "ban", opts);
        else if (action === "push_full") await doPushFull(id, "normal");
        else if (action === "ban_push_full") await doPushFull(id, "ban");
        else await doAction(id, action, opts);
      }
      return;
    }

    const actionBtn = e.target.closest(".audit-action-btn");
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      const id = actionBtn.dataset.id;
      if (!action || !id) return;
      const block = actionBtn.closest(".audit-creator-block");
      const opts = optsFromBlock(block, id, actionBtn.dataset.approveId);
      if (action === "full_audit") await doFlow(id, "normal", opts);
      else if (action === "publish_replay") await doFlow(id, "publish_replay", opts);
      else if (action === "ban_audit") await doFlow(id, "ban", opts);
      else if (action === "push_full") await doPushFull(id, "normal");
      else if (action === "ban_push_full") await doPushFull(id, "ban");
      else await doAction(id, action, opts);
    }
  }

  function handleAuditResultsChange(e) {
    const cb = e.target.closest && e.target.closest(".audit-pick-cb");
    if (!cb && !(e.target && e.target.classList && e.target.classList.contains("audit-pick-cb"))) return;
    const input = cb || e.target;
    const block = input.closest(".audit-creator-block");
    if (block) syncAuditScopeUi(block);
  }

  function bindAuditResultsDelegation(container) {
    if (!container || container.__auditResultsBound) return;
    container.__auditResultsBound = true;
    container.addEventListener("click", handleAuditResultsClick);
    container.addEventListener("change", handleAuditResultsChange);
  }

  // ═══════════════════════════════════════════════════════
  //  v5.3 高级可搜索组合框（替换 v5.2 原生 select）
  //  支持实时搜索过滤、键盘导航、毛玻璃下拉面板
  // ═══════════════════════════════════════════════════════

  let _auditUsersList = [];
  let _auditUsersLoaded = false;
  let _auditActiveIndex = -1;

  // v5.6 实时审核白名单
  let _realtimeWhitelistIds = new Set(); // 白名单用户 ID 集合
  let _realtimeWhitelistList = []; // 完整白名单（名称、添加时间）
  let _realtimeWhitelistLoaded = false;

  // ─── 加载实时审核白名单 ───
  async function loadRealtimeWhitelist(force) {
    if (_realtimeWhitelistLoaded && !force) return;
    try {
      const r = await fetch(`${API_BASE}/api/strategy/audit/realtime-whitelist`);
      const d = await r.json();
      if (d.success && Array.isArray(d.data)) {
        _realtimeWhitelistList = d.data.map((u) => ({
          id: u.id,
          name: u.name || "",
          addedAt: u.addedAt || u.added_at || u.addTime || "",
        }));
        _realtimeWhitelistIds = new Set(_realtimeWhitelistList.map((u) => Number(u.id)));
      }
      _realtimeWhitelistLoaded = true;
    } catch (err) {
      console.error("[audit] 加载白名单失败:", err);
      _realtimeWhitelistLoaded = true; // 失败也标记已加载，避免反复重试
    }
  }

  // ─── 白名单弹窗 ───
  function renderWhitelistObjectCard(u) {
    const name = esc(u.name || "");
    const id = Number(u.id) || 0;
    const addedAt = esc(u.addedAt || "");
    return `<pre class="audit-whitelist-card"><span class="wl-punct">{</span>
  <span class="wl-key">name</span><span class="wl-punct">:</span> <span class="wl-str">"${name}"</span><span class="wl-punct">,</span>
  <span class="wl-key">id</span><span class="wl-punct">:</span> <span class="wl-num">${id}</span><span class="wl-punct">,</span>
  <span class="wl-key">addedAt</span><span class="wl-punct">:</span> <span class="wl-str">"${addedAt}"</span>
<span class="wl-punct">}</span></pre>`;
  }

  function renderWhitelistModalBody() {
    const body = $("auditWhitelistModalBody");
    if (!body) return;
    if (!_realtimeWhitelistList.length) {
      body.innerHTML = `<div class="audit-whitelist-empty">暂无白名单用户</div>`;
      return;
    }
    body.innerHTML = _realtimeWhitelistList.map(renderWhitelistObjectCard).join("");
  }

  async function openWhitelistModal() {
    const modal = $("auditWhitelistModal");
    if (!modal) return;
    const body = $("auditWhitelistModalBody");
    if (body) {
      body.innerHTML = `<div class="audit-whitelist-empty">加载中…</div>`;
    }
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    await loadRealtimeWhitelist(true);
    renderWhitelistModalBody();
  }

  function closeWhitelistModal() {
    const modal = $("auditWhitelistModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  // ─── 判断用户是否在白名单内 ───
  function isRealtimeAllowed(uid) {
    return _realtimeWhitelistIds.has(Number(uid));
  }

  // ─── 加载审核人列表 ───
  async function loadAuditUsersToSelector() {
    const input = $("auditReviewerSearch");
    if (!input) return;
    if (_auditUsersLoaded) return;

    input.placeholder = "加载中…";
    input.disabled = true;
    try {
      // 同时加载审核人列表和白名单
      const [users] = await Promise.all([
        fetchAuditUsers(),
        loadRealtimeWhitelist(),
      ]);
      _auditUsersList = users.sort((a, b) =>
        (a.name || "").localeCompare(b.name || "")
      );
      _auditUsersLoaded = true;
      input.disabled = false;
      input.placeholder = "搜索审核人…";
    } catch (err) {
      input.placeholder = "加载失败";
      input.disabled = false;
      console.error("[audit] 加载审核人列表失败:", err);
    }
  }

  // ─── 渲染下拉列表 ───
  function renderReviewerDropdown(query) {
    const dropdown = $("auditReviewerDropdown");
    if (!dropdown) return;

    const q = (query || "").toLowerCase().trim();
    const filtered = !q
      ? _auditUsersList.slice(0, 50) // 默认显示前50个
      : _auditUsersList.filter((u) => {
          const name = (u.name || "").toLowerCase();
          const id = String(u.id || "");
          // 支持去掉 wb_ 前缀、按 ID 搜索
          const stripped = name.replace(/^wb_/, "");
          return (
            name.includes(q) ||
            stripped.includes(q) ||
            id.includes(q)
          );
        }).slice(0, 50); // 最多显示50条

    _auditActiveIndex = -1;

    if (filtered.length === 0) {
      dropdown.innerHTML = `<div class="audit-reviewer-item-empty">未找到匹配「${esc(query)}」的审核人</div>`;
      return;
    }

    dropdown.innerHTML = filtered
      .map(
        (u, i) => {
          const realtimeTag = isRealtimeAllowed(u.id)
            ? `<span class="audit-reviewer-item-tag is-realtime">实时</span>`
            : `<span class="audit-reviewer-item-tag is-normal">普通</span>`;
          return `
      <div class="audit-reviewer-item" data-uid="${u.id}" data-name="${esc(u.name)}" data-index="${i}">
        <div class="audit-reviewer-item-main">
          <span class="audit-reviewer-item-name">${esc(u.name)}</span>
          ${realtimeTag}
        </div>
        <span class="audit-reviewer-item-id">${u.id}</span>
      </div>
    `;
        }
      )
      .join("");
  }

  // ─── 打开/关闭下拉 ───
  function openReviewerDropdown() {
    const cb = $("auditReviewerCombobox");
    if (cb) cb.classList.add("open");
    renderReviewerDropdown($("auditReviewerSearch")?.value || "");
  }

  function closeReviewerDropdown() {
    const cb = $("auditReviewerCombobox");
    if (cb) cb.classList.remove("open");
    _auditActiveIndex = -1;
  }

  // ─── 选中审核人 ───
  async function selectReviewer(uid, name) {
    const input = $("auditReviewerSearch");
    if (input) {
      input.value = name;
      input.blur();
    }
    closeReviewerDropdown();

    // 模拟"审核人 XXX"命令
    const fakeText = `审核人 ${name}`;
    addUser(fakeText);
    $("auditMetaBadge").textContent = "查询审核人…";
    try {
      await handleByCreator(fakeText);
    } catch (err) {
      addErr(`执行失败：${esc(err.message || "")}`);
    }
    $("auditMetaBadge").textContent = isRealtimeAllowed(uid) ? "就绪" : "仅逐条查询";
  }

  // ─── 高亮当前项 ───
  function updateActiveItem() {
    const dropdown = $("auditReviewerDropdown");
    if (!dropdown) return;
    const items = dropdown.querySelectorAll(".audit-reviewer-item");
    items.forEach((el, i) => {
      el.classList.toggle("active", i === _auditActiveIndex);
    });
    // 滚动到可见
    if (_auditActiveIndex >= 0 && items[_auditActiveIndex]) {
      items[_auditActiveIndex].scrollIntoView({ block: "nearest" });
    }
  }

  // ─── 绑定组合框事件 ───
  const _cb = $("auditReviewerCombobox");
  const _searchInput = $("auditReviewerSearch");
  const _dropdown = $("auditReviewerDropdown");

  if (_cb && _searchInput && _dropdown) {
    // 输入框聚焦 → 打开下拉；已选中时全选便于重新搜索
    _searchInput.addEventListener("focus", () => {
      if (!_auditUsersLoaded) return;
      if (_searchInput.value) {
        _searchInput.select();
      }
      openReviewerDropdown();
    });

    // 点击输入框区域（含图标）也打开
    const inputWrap = _cb.querySelector(".audit-reviewer-input-wrap");
    if (inputWrap) {
      inputWrap.addEventListener("mousedown", (e) => {
        if (e.target === _searchInput) return;
        e.preventDefault();
        _searchInput.focus();
      });
    }

    // 输入框输入 → 过滤
    _searchInput.addEventListener("input", (e) => {
      if (!_auditUsersLoaded) return;
      openReviewerDropdown();
      renderReviewerDropdown(e.target.value);
    });

    // 键盘导航
    _searchInput.addEventListener("keydown", (e) => {
      const items = _dropdown.querySelectorAll(".audit-reviewer-item");

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!_cb.classList.contains("open")) openReviewerDropdown();
        if (items.length === 0) return;
        _auditActiveIndex = Math.min(_auditActiveIndex + 1, items.length - 1);
        updateActiveItem();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length === 0) return;
        _auditActiveIndex = Math.max(_auditActiveIndex - 1, 0);
        updateActiveItem();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items.length === 0) return;
        if (_auditActiveIndex >= 0 && items[_auditActiveIndex]) {
          const el = items[_auditActiveIndex];
          selectReviewer(el.dataset.uid, el.dataset.name);
        } else {
          const el = items[0];
          selectReviewer(el.dataset.uid, el.dataset.name);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (_cb.classList.contains("open")) {
          closeReviewerDropdown();
        } else {
          _searchInput.value = "";
          _searchInput.blur();
        }
      }
    });

    // 点击下拉项
    _dropdown.addEventListener("mousedown", (e) => {
      // 阻止失焦导致下拉先关闭、点不到
      e.preventDefault();
    });
    _dropdown.addEventListener("click", (e) => {
      const item = e.target.closest(".audit-reviewer-item");
      if (!item) return;
      selectReviewer(item.dataset.uid, item.dataset.name);
    });

    // 点击外部关闭下拉
    document.addEventListener("click", (e) => {
      if (!_cb.contains(e.target)) {
        closeReviewerDropdown();
      }
    });
  }

  // ─── 绑定白名单弹窗 ───
  const _whitelistTag = $("auditWhitelistTag");
  if (_whitelistTag) {
    _whitelistTag.addEventListener("click", () => {
      openWhitelistModal();
    });
  }
  const _whitelistClose = $("auditWhitelistModalClose");
  const _whitelistBackdrop = $("auditWhitelistModalBackdrop");
  if (_whitelistClose) _whitelistClose.addEventListener("click", closeWhitelistModal);
  if (_whitelistBackdrop) _whitelistBackdrop.addEventListener("click", closeWhitelistModal);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = $("auditWhitelistModal");
    if (modal && !modal.classList.contains("hidden")) closeWhitelistModal();
  });

  // 当审核视图被激活时，加载审核人列表
  const _origViewEnter = window.onStrategyAuditViewEnter;
  window.onStrategyAuditViewEnter = function () {
    if (typeof _origViewEnter === "function") _origViewEnter.call(this);
    $("auditMetaBadge").textContent = "就绪";
    loadAuditUsersToSelector();
  };
})();
