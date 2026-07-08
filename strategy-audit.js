/* ============================================================
 *  策略审核模块 v5.0 — Playwright 三级降级 + 智能两步审核
 *  核心逻辑：
 *    查询 = orientControl/get（策略信息）
 *    审核 = approve/changeStatus（后端自动转换策略ID→审核记录ID）
 *  审核状态体系（approve/query）不同于策略生效状态（orientControl/get）
 *
 *  v5.0 改动：
 *    - 后端统一 Playwright → Chrome CDP → urllib 三级降级
 *    - 同网用户可直接使用（共享 Playwright session）
 *    - Cookie 自动续期，无需手工维护
 *    - 两步审核：审核通过成功后才执行同意发布
 * ============================================================ */
(function () {
  "use strict";

  const API_BASE = window.__API_BASE__ || "";

  // ─── 审核操作映射 ───
  const ACTION = {
    check_pass:   { code: 6, label: "审核通过",  color: "ok"    },
    check_fail:   { code: 3, label: "审核驳回",  color: "err"   },
    publish_pass: { code: 2, label: "同意发布",  color: "ok"    },
    publish_fail: { code: 7, label: "拒绝发布",  color: "err"   },
  };

  // ─── 策略生效状态（orientControl/get 返回） ───
  const STRATEGY_STATUS = {
    1: "待审核", 2: "待发布", 3: "审核中",
    4: "生效中", 5: "已撤回", 6: "已结束", 7: "草稿",
  };

  // ─── 审核状态（approve/query 返回） ───
  const APPROVE_STATUS = {
    1: "待审核", 2: "待发布/发布成功", 3: "审核驳回",
    6: "审核通过", 7: "发布失败", 10: "发布成功",
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
    });
    const d = await r.json();
    if (!d.success) {
      if (d.error === "COOKIE_EXPIRED" && window.markCookieExpired) window.markCookieExpired();
      throw new Error(d.message || d.error || "请求失败");
    }
    return d.data;
  }

  // ─── 查询策略 ───
  async function queryOne(id) {
    const resp = await api("/api/strategy/audit/get", { id: Number(id) });
    const data = resp?.data;
    if (!data) throw new Error("未找到策略");
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
    const btns = Object.entries(ACTION).map(([key, cfg]) =>
      `<button class="chip-sm audit-action-btn${cfg.color === "err" ? " chip-danger" : ""}" data-action="${key}" data-id="${id}">${cfg.label}</button>`
    ).join("");

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
  // 返回 true 表示成功，false 表示失败
  async function doAction(id, actionKey) {
    const cfg = ACTION[actionKey];
    if (!cfg) return false;

    addSys(`<p>策略 <strong>#${id}</strong>：正在执行「${cfg.label}」…</p>`);

    try {
      await api("/api/strategy/audit/changeStatus", {
        id: Number(id),
        status: cfg.code,
        reason: cfg.label,
      });

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

      if (msg.includes("状态流转")) {
        addWarn(`💡 该策略在 Orient 审核平台当前不允许执行「${cfg.label}」。<br>常见原因：<br>• 策略不在对应审核状态（如需待审核才能审核通过）<br>• 策略不在待发布状态（如需待发布才能同意发布）<br>建议：在 <a href="https://operation-tool.corp.kuaishou.com/approve" target="_blank">Orient 审核平台</a> 确认策略审核状态。`);
      } else if (msg.includes("APPROVE_NOT_FOUND")) {
        addWarn(`💡 该策略未在审核平台找到审核记录。<br>可能原因：<br>• 策略尚未提交审核<br>• 策略审核流程已结束<br>• 策略不在当前审核人的审核范围内<br>建议：在 <a href="https://operation-tool.corp.kuaishou.com/approve" target="_blank">Orient 审核平台</a> 确认。`);
      } else if (msg.includes("权限")) {
        addWarn(`💡 Orient 权限限制：不能审批自己提交的策略。`);
      } else if (msg.includes("Cookie") || msg.includes("登录")) {
        addWarn(`💡 Cookie 已过期或未登录。服务端 Playwright 浏览器会自动续期，如仍失败请检查服务端登录状态。`);
      }
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
    else if (/^审核\s+/.test(t)) intent = "full_audit";
    return { intent, ids };
  }

  // ─── 主处理 ───
  async function handle(text) {
    const { intent, ids } = parseCmd(text);
    if (!ids.length) {
      addSys(`<p>未识别到策略 ID。支持的命令：</p>
        <ul style="margin:8px 0;padding-left:20px;line-height:1.8">
          <li><code>14898</code> — 查询策略信息</li>
          <li><code>通过 14898</code> — 审核通过</li>
          <li><code>发布 14898</code> — 同意发布</li>
          <li><code>驳回 14898</code> — 审核驳回</li>
          <li><code>拒绝 14898</code> — 拒绝发布</li>
          <li><code>审核 14898</code> — 两步审核（通过+发布）</li>
        </ul>
        <p class="audit-tip">Orient 审核平台会自动校验审核状态，操作不合法时会明确提示。</p>`);
      return;
    }

    addUser(text);
    $("auditMetaBadge").textContent = `执行中 ${ids.length} 条`;

    for (const id of ids) {
      if (intent === "query") {
        // 查询
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
        // 两步审核：审核通过 → 等待 → 同意发布
        // 第一步失败则中止，不再执行第二步
        const passOk = await doAction(id, "check_pass");
        if (passOk) {
          // 审核通过成功，等待 1 秒让 Orient 状态流转完成，再同意发布
          addSys(`<p>等待 Orient 状态流转…</p>`);
          await new Promise(r => setTimeout(r, 1000));
          await doAction(id, "publish_pass");
        } else {
          addWarn(`💡 两步审核中止：审核通过失败，不再执行「同意发布」。请确认策略审核状态后重试。`);
        }
      } else {
        // 单步操作
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

    // 卡片按钮事件委托
    const container = $("auditChatMessages");
    if (container) {
      container.addEventListener("click", (e) => {
        const btn = e.target.closest(".audit-action-btn");
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action && id) doAction(id, action);
      });
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
})();
