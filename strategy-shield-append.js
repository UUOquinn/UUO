/* ═══════════════════════════════════════════════════════
 *  新屏蔽广告信息并集生效
 *  往 type=7「新屏蔽（屏蔽的广告信息并集生效）」策略的 mediaCluster.appId 追加应用 ID
 *  流程：GET → 校验 type=7 → 合并 appId → 预览 → mergeEditV2 提审
 * ═══════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const API_BASE = window.__API_BASE__ || "";
  const RULE_TYPE = 7;
  const RULE_LABEL = "新屏蔽（屏蔽的广告信息并集生效）";
  const INDUSTRY_VERSION = "6.6";
  const SUBMIT_FIELDS = [
    "id",
    "name",
    "type",
    "background",
    "shieldType",
    "shieldMediaType",
    "shieldUserType",
    "beginTime",
    "endTime",
    "adCluster",
    "mediaCluster",
  ];

  /** @type {null | { id: string, body: object, added: string[], skipped: string[], beforeCount: number, afterCount: number, name: string }} */
  let pendingSubmit = null;

  function getKwabiCookie() {
    return localStorage.getItem("kwabi-auth-cookie") || "";
  }

  function _apiHeaders(extra) {
    const h = { "Content-Type": "application/json", ...extra };
    const cookie = getKwabiCookie();
    if (cookie) h["X-Kwabi-Cookie"] = cookie;
    return h;
  }

  async function orientGet(id) {
    const resp = await fetch(`${API_BASE}/api/strategy/renew/get`, {
      method: "POST",
      headers: _apiHeaders(),
      body: JSON.stringify({ id }),
    });
    const result = await resp.json();
    if (!result.success) {
      if (result.error === "COOKIE_EXPIRED" && window.markCookieExpired) {
        await window.markCookieExpired();
      }
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
      if (result.error === "COOKIE_EXPIRED" && window.markCookieExpired) {
        await window.markCookieExpired();
      }
      throw new Error(result.error || `POST 策略 ${id} 失败`);
    }
    const biz = result.data || {};
    const bizStatus = biz.status;
    const bizMsg = biz.message || "";
    if (bizStatus !== 200) {
      if (bizStatus === 412) {
        throw new Error(`业务 412: ${bizMsg || "行业版本系统升级，请刷新页面重试"}`);
      }
      if (bizStatus === 500) {
        throw new Error(`业务 500: ${bizMsg || "内部系统繁忙"}`);
      }
      throw new Error(`业务 ${bizStatus}: ${bizMsg || "提交失败"}`);
    }
    return biz.data || biz;
  }

  function extractStrategyPayload(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("GET 策略详情返回为空");
    }
    if (raw.adCluster != null || raw.mediaCluster != null || raw.type != null) {
      return raw;
    }
    if (raw.data && typeof raw.data === "object") {
      const inner = raw.data;
      if (inner.adCluster != null || inner.mediaCluster != null || inner.type != null) {
        return inner;
      }
      if (inner.data && typeof inner.data === "object") {
        const deep = inner.data;
        if (deep.adCluster != null || deep.mediaCluster != null) return deep;
      }
    }
    if (raw.strategy && typeof raw.strategy === "object") return raw.strategy;
    if (raw.detail && typeof raw.detail === "object") return raw.detail;
    throw new Error("无法从 GET 响应中识别策略对象");
  }

  function sanitizeForSubmit(detail) {
    const body = {};
    for (const key of SUBMIT_FIELDS) {
      if (detail[key] !== undefined) {
        body[key] = JSON.parse(JSON.stringify(detail[key]));
      }
    }
    if (body.adCluster && typeof body.adCluster === "object") {
      body.adCluster.industryVersion = INDUSTRY_VERSION;
      if (body.adCluster.maxNum != null && typeof body.adCluster.maxNum === "object") {
        delete body.adCluster.maxNum;
      }
    }
    if (body.mediaCluster && typeof body.mediaCluster === "object") {
      if (body.mediaCluster.maxNum != null && typeof body.mediaCluster.maxNum === "object") {
        delete body.mediaCluster.maxNum;
      }
    }
    body.id = detail.id;
    return body;
  }

  function tokenizeIds(text) {
    return String(text || "")
      .split(/[\s,，;；|、]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{3,}$/.test(s));
  }

  function splitAppIdList(raw) {
    return String(raw || "")
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function mergeAppIds(existingRaw, toAdd) {
    const oldList = splitAppIdList(existingRaw);
    const oldSet = new Set(oldList);
    const added = [];
    const skipped = [];
    for (const id of toAdd) {
      if (oldSet.has(id)) {
        skipped.push(id);
        continue;
      }
      oldSet.add(id);
      added.push(id);
      oldList.push(id);
    }
    return {
      merged: oldList.join(","),
      added,
      skipped,
      beforeCount: oldList.length - added.length,
      afterCount: oldList.length,
    };
  }

  function readForm() {
    const raw = String(document.getElementById("shieldAppendAppIds")?.value || "").trim();
    const parsed = parseFreeText(raw);
    if (parsed) return { ...parsed, appRaw: raw };

    // 兜底：第一个数字=策略ID，其余=应用ID
    const all = tokenizeIds(raw);
    if (all.length >= 2) {
      return {
        strategyId: all[0],
        appIds: [...new Set(all.slice(1))],
        appRaw: raw,
      };
    }
    return { strategyId: "", appIds: [], appRaw: raw };
  }

  function parseFreeText(text) {
    const t = String(text || "").trim();
    if (!t) return null;

    const sidMatch =
      t.match(/(?:策略\s*ID|策略id|strategy\s*id)\s*[:：]?\s*(\d{4,})/i) ||
      t.match(/^(\d{4,})\b/);
    const strategyId = sidMatch ? sidMatch[1] : "";
    if (!strategyId) return null;

    let appPart = t;
    if (sidMatch) {
      appPart = t.slice(sidMatch.index + sidMatch[0].length);
    }
    const appLabel = appPart.match(/(?:应用\s*ID|app\s*id|appid)\s*[:：]?\s*([\s\S]+)/i);
    if (appLabel) appPart = appLabel[1];

    let appIds = [...new Set(tokenizeIds(appPart))];
    // 若未标「应用ID」且正文只剩一串数字：第一个当策略，其余当 appId
    if (!appIds.length) {
      const all = tokenizeIds(t);
      if (all.length >= 2 && all[0] === strategyId) {
        appIds = [...new Set(all.slice(1))];
      }
    }

    if (strategyId && appIds.length) {
      return { strategyId, appIds };
    }
    return null;
  }

  const messagesEl = () => document.getElementById("shieldAppendMessages");

  function addMsg(role, html) {
    const el = messagesEl();
    if (!el) return;
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
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function previewList(ids, limit) {
    const n = limit || 12;
    if (!ids.length) return "（无）";
    const head = ids.slice(0, n).map(escHtml).join(", ");
    return ids.length > n ? `${head} …共 ${ids.length} 个` : head;
  }

  function setBusy(busy) {
    const previewBtn = document.getElementById("shieldAppendPreview");
    const submitBtn = document.getElementById("shieldAppendSubmit");
    if (previewBtn) previewBtn.disabled = !!busy;
    if (submitBtn) submitBtn.disabled = !!busy;
  }

  async function buildPreview(strategyId, appIds) {
    addSystemMsg(`<p>策略 <strong>${escHtml(strategyId)}</strong>：正在获取详情…</p>`);
    const rawData = await orientGet(strategyId);
    const detail = extractStrategyPayload(rawData);
    const type = Number(detail.type);
    if (type !== RULE_TYPE) {
      throw new Error(
        `策略类型不是「${RULE_LABEL}」（type=${type || "?"}），已拒绝修改`
      );
    }

    const mediaType = String(detail.shieldMediaType || "");
    if (mediaType && !/(^|,)appId(,|$)/.test(mediaType)) {
      throw new Error(
        `该策略媒体维度为「${mediaType}」，不含 appId，无法追加应用ID`
      );
    }

    if (!detail.mediaCluster || typeof detail.mediaCluster !== "object") {
      detail.mediaCluster = {};
    }

    const merge = mergeAppIds(detail.mediaCluster.appId, appIds);
    if (!merge.added.length) {
      throw new Error("没有可追加的新 appId（全部已存在）");
    }

    const nextDetail = {
      ...detail,
      id: detail.id ?? Number(strategyId),
      mediaCluster: {
        ...detail.mediaCluster,
        appId: merge.merged,
      },
    };
    const body = sanitizeForSubmit(nextDetail);

    pendingSubmit = {
      id: String(strategyId),
      body,
      added: merge.added,
      skipped: merge.skipped,
      beforeCount: merge.beforeCount,
      afterCount: merge.afterCount,
      name: String(detail.name || ""),
    };

    addSystemMsg(`
      <h4>预览变更</h4>
      <p>策略 <strong>${escHtml(strategyId)}</strong>
        ${pendingSubmit.name ? `「${escHtml(pendingSubmit.name)}」` : ""}
        · ${escHtml(RULE_LABEL)}</p>
      <ul>
        <li>当前 appId：<strong>${pendingSubmit.beforeCount}</strong> 个</li>
        <li>追加后：<strong>${pendingSubmit.afterCount}</strong> 个</li>
        <li>新增：<strong class="ok">${pendingSubmit.added.length}</strong> 个 → ${previewList(pendingSubmit.added)}</li>
        <li>已存在跳过：${pendingSubmit.skipped.length} 个 → ${previewList(pendingSubmit.skipped, 8)}</li>
      </ul>
      <p>确认无误后点击下方「确认提交并提审」。</p>
    `);

    const submitBtn = document.getElementById("shieldAppendSubmit");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.add("is-ready");
    }
    return pendingSubmit;
  }

  async function confirmSubmit() {
    if (!pendingSubmit) {
      addSystemMsg("<p class=\"err\">请先点击「预览变更」，确认后再提交。</p>");
      return;
    }
    const job = pendingSubmit;
    addSystemMsg(
      `<p>策略 <strong>${escHtml(job.id)}</strong>：提交 mergeEditV2 提审（追加 ${job.added.length} 个 appId）…</p>`
    );
    try {
      await orientSubmit(job.id, job.body);
      addSystemMsg(
        `<p class="ok">策略 <strong>${escHtml(job.id)}</strong>：✓ 追加提交成功（请到列表确认撤回/版本 diff，并走审核）</p>`
      );
      pendingSubmit = null;
      const submitBtn = document.getElementById("shieldAppendSubmit");
      if (submitBtn) submitBtn.classList.remove("is-ready");
    } catch (err) {
      addSystemMsg(`<p class="err">提交失败：${escHtml(err.message)}</p>`);
      throw err;
    }
  }

  async function handlePreviewFromForm() {
    const { strategyId, appIds } = readForm();
    if (!strategyId || !/^\d{4,}$/.test(strategyId)) {
      addSystemMsg("<p class=\"err\">请填写有效的策略 ID（至少 4 位数字）</p>");
      return;
    }
    if (!appIds.length) {
      addSystemMsg("<p class=\"err\">请填写要追加的应用 ID（逗号/空格/换行分隔）</p>");
      return;
    }

    const summary = `策略ID ${strategyId} · 追加 ${appIds.length} 个 appId`;
    addUserMsg(summary);
    if (typeof window.recordFunnelHistory === "function") {
      window.recordFunnelHistory(summary, "strategy-shield-append");
    }

    pendingSubmit = null;
    setBusy(true);
    try {
      await buildPreview(strategyId, appIds);
    } catch (err) {
      addSystemMsg(`<p class="err">${escHtml(err.message)}</p>`);
      pendingSubmit = null;
    } finally {
      setBusy(false);
      const submitBtn = document.getElementById("shieldAppendSubmit");
      if (submitBtn) submitBtn.disabled = !pendingSubmit;
    }
  }

  async function handleSubmitClick() {
    if (!pendingSubmit) {
      await handlePreviewFromForm();
      return;
    }
    setBusy(true);
    try {
      await confirmSubmit();
    } catch (_) {
      /* already logged */
    } finally {
      setBusy(false);
      const submitBtn = document.getElementById("shieldAppendSubmit");
      if (submitBtn) submitBtn.disabled = !pendingSubmit;
    }
  }

  /** 首页/聊天转发：自由文本 */
  async function handleFreeText(text) {
    const input = document.getElementById("shieldAppendAppIds");
    if (input) input.value = String(text || "").trim();
    const parsed = parseFreeText(text) || readForm();
    if (!parsed.strategyId || !parsed.appIds?.length) {
      addSystemMsg(
        "<p>未能解析。请输入：<code>策略ID 15183 应用ID 3432900003,3432900001</code></p>"
      );
      return;
    }
    await handlePreviewFromForm();
  }

  window.sendShieldAppend = handleFreeText;

  function init() {
    const previewBtn = document.getElementById("shieldAppendPreview");
    const submitBtn = document.getElementById("shieldAppendSubmit");
    const appInput = document.getElementById("shieldAppendAppIds");
    if (!previewBtn || !submitBtn || !appInput) return;

    submitBtn.disabled = true;

    previewBtn.addEventListener("click", () => {
      handlePreviewFromForm();
    });
    submitBtn.addEventListener("click", () => {
      handleSubmitClick();
    });

    appInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handlePreviewFromForm();
      }
    });
  }

  window.onStrategyShieldAppendViewEnter = function () {};

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
