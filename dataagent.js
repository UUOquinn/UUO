/**
 * Data Agent — 布局对齐策略审核：仅输入框 + API 服务状态
 * 无 Cookie / 新会话 / 顶栏徽标 / 欢迎说明
 */
(function () {
  "use strict";

  const API_BASE = window.__API_BASE__ || "";

  const state = {
    loading: false,
    conversationId: null,
    bound: false,
  };

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getMessagesEl() {
    return document.getElementById("daChatMessages");
  }

  function scrollChatToBottom() {
    const el = getMessagesEl();
    if (el) el.scrollTop = el.scrollHeight;
  }

  function appendMessage(role, html) {
    const container = getMessagesEl();
    if (!container) return;
    const msg = document.createElement("div");
    msg.className = `agent-msg agent-msg-${role}`;
    msg.innerHTML = `<div class="agent-msg-bubble"><div class="agent-msg-content">${html}</div></div>`;
    container.appendChild(msg);
    scrollChatToBottom();
  }

  function renderThinking() {
    const container = getMessagesEl();
    if (!container) return null;
    const msg = document.createElement("div");
    msg.className = "agent-msg agent-msg-assistant";
    msg.dataset.thinking = "1";
    msg.innerHTML =
      '<div class="agent-msg-bubble"><div class="agent-msg-content"><p class="agent-muted">处理中…</p></div></div>';
    container.appendChild(msg);
    scrollChatToBottom();
    return msg;
  }

  function clearThinking() {
    getMessagesEl()?.querySelectorAll('[data-thinking="1"]').forEach((n) => n.remove());
  }

  function headers(json) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    const kwabi = localStorage.getItem("kwabi-auth-cookie") || "";
    if (kwabi) {
      h["X-DataAgent-Cookie"] = kwabi;
      h["X-Kwabi-Cookie"] = kwabi;
    }
    return h;
  }

  async function sendChat(text) {
    const question = String(text || "").trim();
    if (!question || state.loading) return;
    state.loading = true;

    appendMessage("user", `<p>${escapeHtml(question)}</p>`);
    renderThinking();
    const input = document.getElementById("daChatInput");
    if (input) input.value = "";

    try {
      const body = { message: question };
      if (state.conversationId) body.conversationId = state.conversationId;

      const resp = await fetch(`${API_BASE}/api/dataagent/chat`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(130000),
      });
      const result = await resp.json().catch(() => ({}));
      clearThinking();

      if (!resp.ok || result.success === false) {
        const err = result.message || result.error || `HTTP ${resp.status}`;
        if (String(result.error || err).includes("COOKIE") || resp.status === 401) {
          if (typeof window.markCookieExpired === "function") window.markCookieExpired();
        }
        appendMessage("assistant", `<p class="agent-muted">${escapeHtml(err)}</p>`);
        return;
      }

      const d = result.data || {};
      if (d.conversationId) state.conversationId = d.conversationId;
      const answer = String(d.answer || "").trim() || "（空回答）";
      appendMessage("assistant", `<p>${escapeHtml(answer).replace(/\n/g, "<br>")}</p>`);
    } catch (e) {
      clearThinking();
      appendMessage("assistant", `<p class="agent-muted">${escapeHtml(e.message || e)}</p>`);
    } finally {
      state.loading = false;
    }
  }

  function bindOnce() {
    if (state.bound) return;
    state.bound = true;
    document.getElementById("daChatSend")?.addEventListener("click", () => {
      sendChat(document.getElementById("daChatInput")?.value || "");
    });
    document.getElementById("daChatInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChat(e.target.value);
      }
    });
  }

  window.onDataAgentViewEnter = function onDataAgentViewEnter() {
    bindOnce();
  };
})();
