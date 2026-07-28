/* ═══════════════════════════════════════════════════════
 *  策略延期模块 - 前端逻辑 v1.0
 *  调用后端 /api/strategy/renew/get + /submit
 *  实现：GET 策略详情 → endTime+1月 → POST mergeEditV2
 * ═══════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const API_BASE = window.__API_BASE__ || "";

  // ─── KwaiBI Cookie 复用 ───
  function getKwabiCookie() {
    return localStorage.getItem("kwabi-auth-cookie") || "";
  }

  function _apiHeaders(extra) {
    const h = { "Content-Type": "application/json", ...extra };
    const cookie = getKwabiCookie();
    if (cookie) {
      h["X-Kwabi-Cookie"] = cookie;
    }
    return h;
  }

  // ─── Orient API 调用 ───
  async function orientGet(id) {
    const resp = await fetch(`${API_BASE}/api/strategy/renew/get`, {
      method: "POST",
      headers: _apiHeaders(),
      body: JSON.stringify({ id }),
    });
    const result = await resp.json();
    if (!result.success) {
      if (result.error === "COOKIE_EXPIRED" && window.markCookieExpired) await window.markCookieExpired();
      throw new Error(result.error || `GET 策略 ${id} 失败`);
    }
    return result.data;
  }

  async function orientSubmit(id, body) {
    const resp = await fetch(`${API_BASE}/api/strategy/renew/submit`, {
      method: "POST",
      headers: _apiHeaders(),
      body: JSON.stringify({ id, body }),
    });
    const result = await resp.json();
    if (!result.success) {
      if (result.error === "COOKIE_EXPIRED" && window.markCookieExpired) await window.markCookieExpired();
      throw new Error(result.error || `POST 策略 ${id} 失败`);
    }
    // 检查业务层 status（Orient API 返回 {status:200, message:...} 或 {status:412, message:...}）
    const biz = result.data || {};
    const bizStatus = biz.status;
    const bizMsg = biz.message || "";
    if (bizStatus !== 200) {
      // 412: 行业版本错误（提交 body 字段不对/策略状态不允许修改）
      // 500: 内部错误（可能字段格式错）
      if (bizStatus === 412) {
        throw new Error(`业务 412: ${bizMsg || "行业版本系统升级，请刷新页面重试"}`);
      } else if (bizStatus === 500) {
        throw new Error(`业务 500: ${bizMsg || "内部系统繁忙"}`);
      } else {
        throw new Error(`业务 ${bizStatus}: ${bizMsg || "提交失败"}`);
      }
    }
    return biz.data || biz;
  }

  // ─── 延期逻辑 ───
  function addOneMonthMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) throw new Error(`无效的 endTime: ${ms}`);
    const d = new Date(n);
    d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }

  function extractStrategyPayload(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("GET 策略详情返回为空");
    }
    // Orient API 返回结构: {status, message, data: {id, adCluster, mediaCluster, endTime, ...}}
    // 后端代理可能返回外层包装或直接内层
    if (raw.adCluster != null || raw.mediaCluster != null) return raw;
    // 内层 data 字段
    if (raw.data && typeof raw.data === "object") {
      const inner = raw.data;
      if (inner.adCluster != null || inner.mediaCluster != null) return inner;
      // 再深一层（可能后端包了多层）
      if (inner.data && typeof inner.data === "object") {
        const deep = inner.data;
        if (deep.adCluster != null || deep.mediaCluster != null) return deep;
      }
    }
    if (raw.strategy && typeof raw.strategy === "object") return raw.strategy;
    if (raw.detail && typeof raw.detail === "object") return raw.detail;
    throw new Error("无法从 GET 响应中识别策略对象");
  }

  // 提交时只保留这 11 个必需字段（从 Orient 编辑页真实 mergeEditV2 请求抓包得到）
  // 多传字段（status / statusDesc / createTime / updateTime / isDel 等）会导致 412 错误
  const SUBMIT_FIELDS = [
    "id", "name", "type", "background",
    "shieldType", "shieldMediaType", "shieldUserType",
    "beginTime", "endTime",
    "adCluster", "mediaCluster",
  ];

  // Orient 平台行业版本号（前端 JS 动态加，GET 接口不返回，必须手动加，否则 412 错误）
  const INDUSTRY_VERSION = "6.6";

  function sanitizeForSubmit(detail) {
    // 只保留 SUBMIT_FIELDS 里的字段
    const body = {};
    for (const key of SUBMIT_FIELDS) {
      if (detail[key] !== undefined) {
        body[key] = JSON.parse(JSON.stringify(detail[key]));
      }
    }
    // 关键：给 adCluster 加 industryVersion 字段（平台版本号，GET 不返回但提交必须）
    if (body.adCluster && typeof body.adCluster === "object") {
      body.adCluster.industryVersion = INDUSTRY_VERSION;
      // 删除 maxNum 对象字段（无法反序列化）
      if (body.adCluster.maxNum != null && typeof body.adCluster.maxNum === "object") {
        delete body.adCluster.maxNum;
      }
    }
    // mediaCluster 同样处理 maxNum
    if (body.mediaCluster && typeof body.mediaCluster === "object") {
      if (body.mediaCluster.maxNum != null && typeof body.mediaCluster.maxNum === "object") {
        delete body.mediaCluster.maxNum;
      }
    }
    // 强制设置 id
    body.id = detail.id;
    // Orient mergeEditV2 要求 background 非空；GET 常不返回，延期场景自动补
    const bg = typeof body.background === "string" ? body.background.trim() : "";
    if (!bg) {
      const name = typeof detail.name === "string" ? detail.name.trim() : "";
      body.background = name || (detail.id != null ? `策略${detail.id}延期续期` : "延期续期");
    }
    return body;
  }

  // ─── ID 提取 ───
  function extractIds(text) {
    // 提取纯数字（5位以上为策略ID）
    const nums = text.match(/\b\d{4,}\b/g) || [];
    // 去重
    return [...new Set(nums)];
  }

  // ─── UI 渲染 ───
  const messagesEl = () => document.getElementById("renewalChatMessages");
  const inputEl = () => document.getElementById("renewalChatInput");
  const badgeEl = () => document.getElementById("renewalMetaBadge");

  function addMsg(role, html) {
    const el = messagesEl();
    const div = document.createElement("div");
    div.className = `agent-msg agent-msg-${role}`;
    div.innerHTML = `<div class="agent-msg-bubble"><div class="agent-msg-content">${html}</div></div>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function addUserMsg(text) {
    addMsg("user", `<p>${escHtml(text)}</p>`);
  }

  function addSystemMsg(html) {
    addMsg("system", html);
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function formatTime(ms) {
    try {
      return new Date(Number(ms)).toISOString().slice(0, 10);
    } catch {
      return String(ms);
    }
  }

  // ─── 执行延期 ───
  async function renewOne(id) {
    addSystemMsg(`<p>策略 <strong>${id}</strong>：正在获取详情…</p>`);

    let detail;
    try {
      const rawData = await orientGet(id);
      detail = extractStrategyPayload(rawData);
    } catch (err) {
      addSystemMsg(`<p class="err">策略 ${id} GET 失败：${escHtml(err.message)}</p>`);
      return { id, status: "失败", reason: err.message };
    }

    const prevEnd = detail.endTime;
    const newEnd = addOneMonthMs(prevEnd);
    const body = sanitizeForSubmit({
      ...detail,
      id: detail.id ?? Number(id),
      endTime: newEnd,
    });

    addSystemMsg(
      `<p>策略 <strong>${id}</strong>：结束时间 ${formatTime(prevEnd)} → ${formatTime(newEnd)}，提交提审…</p>`
    );

    try {
      await orientSubmit(String(id), body);
      addSystemMsg(
        `<p class="ok">策略 <strong>${id}</strong>：✓ 延期提交成功（请到列表确认 撤回/版本diff）</p>`
      );
      return {
        id,
        status: "成功",
        prevEnd: formatTime(prevEnd),
        newEnd: formatTime(newEnd),
        reason: "",
      };
    } catch (err) {
      addSystemMsg(`<p class="err">策略 ${id} POST 失败：${escHtml(err.message)}</p>`);
      return { id, status: "失败", prevEnd: formatTime(prevEnd), newEnd: "-", reason: err.message };
    }
  }

  async function handleRenewal(text) {
    if (typeof window.recordFunnelHistory === "function") {
      window.recordFunnelHistory(text, "strategy-renewal");
    }
    const ids = extractIds(text);
    if (!ids.length) {
      addSystemMsg("<p>未识别到策略 ID，请输入数字 ID（如 13938）</p>");
      return;
    }

    addUserMsg(text);
    badgeEl().textContent = `执行中 ${ids.length} 条`;

    addSystemMsg(`<p>开始延期 <strong>${ids.length}</strong> 条策略…</p>`);

    const results = [];
    for (const id of ids) {
      const result = await renewOne(id);
      results.push(result);
    }

    // 汇总表
    const ok = results.filter((r) => r.status === "成功").length;
    const fail = results.filter((r) => r.status !== "成功").length;

    let tableRows = results
      .map(
        (r) =>
          `<tr><td>${r.id}</td><td>${r.prevEnd || "-"}</td><td>${r.newEnd || "-"}</td><td class="${r.status === "成功" ? "ok" : "err"}">${r.status}</td><td>${escHtml(r.reason || "-")}</td></tr>`
      )
      .join("");

    addSystemMsg(`
      <h4>延期汇总</h4>
      <p>成功 ${ok}，失败 ${fail}</p>
      <div class="data-table-wrap"><table class="data-table">
        <thead><tr><th>策略ID</th><th>原结束时间</th><th>新结束时间</th><th>状态</th><th>原因</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    `);

    badgeEl().textContent = `完成 ${ok}/${ids.length}`;
  }

  // ─── 事件绑定 ───
  function init() {
    const sendBtn = document.getElementById("renewalChatSend");
    const input = inputEl();

    if (!sendBtn || !input) return;

    sendBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      handleRenewal(text);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    // 快捷按钮
    document.querySelectorAll("[data-hint-renewal]").forEach((btn) => {
      btn.addEventListener("click", () => {
        input.value = btn.dataset.hintRenewal;
        input.focus();
      });
    });
  }

  // ─── View Enter Hook ───
  window.onStrategyRenewalViewEnter = function () {
    const cookie = getKwabiCookie();
    if (cookie) {
      badgeEl().textContent = "就绪";
      badgeEl().style.color = "";
    } else {
      // 没有个人 Cookie，但服务端可能配了，默认显示"就绪"
      badgeEl().textContent = "就绪";
      badgeEl().style.color = "";
    }
  };

  // ─── 初始化 ───
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
