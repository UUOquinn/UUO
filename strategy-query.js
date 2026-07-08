/**
 * 策略查询 — Agent 聊天界面
 * API 不可用时自动回退到本地 strategies.json 查询
 */

const SEARCH_FIELDS = {
  developerId: "开发者ID",
  posId: "广告位ID",
  appId: "应用ID",
};

const strategyState = {
  meta: null,
  mode: null,
  loading: false,
  initialized: false,
};

const localStore = {
  loaded: false,
  loading: null,
  meta: null,
  rows: [],
  index: { developerId: {}, posId: {}, appId: {} },
};

function tokenize(value) {
  if (value == null) return [];
  const text = String(value).trim();
  if (!text) return [];
  return text.split(/[;；,\s]+/).map((t) => t.trim()).filter(Boolean);
}

function buildLocalIndexes() {
  localStore.index = { developerId: {}, posId: {}, appId: {} };
  localStore.rows.forEach((row, i) => {
    for (const [key, fieldName] of Object.entries(SEARCH_FIELDS)) {
      for (const token of tokenize(row[fieldName])) {
        if (!localStore.index[key][token]) {
          localStore.index[key][token] = new Set();
        }
        localStore.index[key][token].add(i);
      }
    }
  });
}

async function ensureLocalStore() {
  if (localStore.loaded) return localStore.meta;
  if (!localStore.loading) {
    localStore.loading = (async () => {
      const res = await fetch("/data/strategies.json");
      if (!res.ok) {
        throw new Error(`无法加载策略数据 (${res.status})`);
      }
      const payload = await res.json();
      localStore.rows = payload.rows || [];
      localStore.meta = {
        source: payload.source || "",
        importedAt: payload.importedAt || "",
        fields: payload.fields || [],
        total: localStore.rows.length,
      };
      buildLocalIndexes();
      localStore.loaded = true;
      return localStore.meta;
    })();
  }
  return localStore.loading;
}

function uniq(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function parseQueryMessage(message) {
  const text = (message || "").trim();
  if (!text) {
    return { developerIds: [], posIds: [], appIds: [], parsed: {} };
  }

  const developerIds = [];
  const posIds = [];
  const appIds = [];
  const parsed = {};

  const patterns = [
    ["developerIds", /开发者\s*ID[：:\s]*([0-9;；,\s]+)/gi, "开发者ID"],
    ["posIds", /广告位\s*ID[：:\s]*([0-9;；,\s]+)/gi, "广告位ID"],
    ["appIds", /应用\s*ID[：:\s]*([0-9;；,\s]+)/gi, "应用ID"],
    ["developerIds", /\buid[：:\s]*([0-9;；,\s]+)/gi, "uid"],
    ["posIds", /\bpos[_\s-]*id[：:\s]*([0-9;；,\s]+)/gi, "pos_id"],
    ["appIds", /\bapp[_\s-]*id[：:\s]*([0-9;；,\s]+)/gi, "app_id"],
  ];

  for (const [key, pattern, label] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const values = tokenize(match[1]).filter((v) => /^\d+$/.test(v));
      if (!values.length) continue;
      parsed[label] = values;
      if (key === "developerIds") developerIds.push(...values);
      else if (key === "posIds") posIds.push(...values);
      else appIds.push(...values);
    }
  }

  if (!developerIds.length && !posIds.length && !appIds.length) {
    const numbers = tokenize(text).filter((n) => /^\d+$/.test(n));
    if (numbers.length) {
      appIds.push(...numbers);
      parsed["自动识别为应用ID"] = numbers;
    }
  }

  return {
    developerIds: uniq(developerIds),
    posIds: uniq(posIds),
    appIds: uniq(appIds),
    parsed,
  };
}

function queryLocal(developerIds = [], posIds = [], appIds = []) {
  if (!developerIds.length && !posIds.length && !appIds.length) {
    return { total: 0, rows: [], matchedBy: {} };
  }

  const candidateSets = [];
  const matchedBy = {};

  const addSet = (key, ids, label) => {
    const idxSet = new Set();
    for (const val of ids) {
      const bucket = localStore.index[key][val];
      if (bucket) {
        for (const i of bucket) idxSet.add(i);
      }
    }
    candidateSets.push(idxSet);
    matchedBy[label] = ids;
  };

  if (developerIds.length) addSet("developerId", developerIds, "开发者ID");
  if (posIds.length) addSet("posId", posIds, "广告位ID");
  if (appIds.length) addSet("appId", appIds, "应用ID");

  let resultIdx = candidateSets[0];
  if (candidateSets.length > 1) {
    resultIdx = new Set(
      [...candidateSets[0]].filter((i) => candidateSets.every((s) => s.has(i)))
    );
  }

  const rows = [...resultIdx].sort((a, b) => a - b).map((i) => localStore.rows[i]);
  return { total: rows.length, rows, matchedBy };
}

function updateMetaBadge(badge, meta, suffix = "") {
  if (!badge || !meta) return;
  const imported = meta.importedAt ? ` · ${meta.importedAt.slice(0, 10)}` : "";
  const mode = suffix ? ` · ${suffix}` : "";
  badge.textContent = `${meta.total} 条策略${imported}${mode}`;
  badge.classList.remove("err");
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatFieldValue(value) {
  if (value === null || value === undefined || value === "") {
    return '<span class="field-empty">—</span>';
  }
  return escapeHtml(value);
}

function getMessagesEl() {
  return document.getElementById("strategyChatMessages");
}

function scrollChatToBottom() {
  const el = getMessagesEl();
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
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

function renderWelcomeMessage() {
  appendMessage(
    "assistant",
    `<div class="agent-msg-bubble-title">策略查询助手</div>
     <p>已导入策略信息全量表，支持按以下条件查询，返回<strong>全部策略字段</strong>：</p>
     <ul class="agent-tip-list">
       <li><code>开发者ID</code> / <code>uid</code></li>
       <li><code>广告位ID</code> / <code>pos_id</code></li>
       <li><code>应用ID</code> / <code>app_id</code></li>
     </ul>
     <p class="agent-muted">多条件同时输入时取交集；仅输入数字时默认识别为应用ID。</p>`
  );
}

function renderUserMessage(text) {
  appendMessage("user", `<p>${escapeHtml(text)}</p>`);
}

function renderThinking() {
  const container = getMessagesEl();
  if (!container) return;

  const msg = document.createElement("div");
  msg.className = "agent-msg agent-msg-assistant";
  msg.id = "strategyThinking";
  msg.innerHTML = `
    <div class="agent-msg-bubble agent-msg-bubble-thinking">
      <div class="agent-msg-content">
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-text">正在查询策略…</span>
      </div>
    </div>`;
  container.appendChild(msg);
  scrollChatToBottom();
}

function removeThinking() {
  document.getElementById("strategyThinking")?.remove();
}

function renderParsedSummary(parsed, matchedBy) {
  const parts = [];
  const source = matchedBy && Object.keys(matchedBy).length ? matchedBy : parsed;
  for (const [key, values] of Object.entries(source || {})) {
    const list = Array.isArray(values) ? values.join("、") : values;
    parts.push(`<span class="parsed-tag"><strong>${escapeHtml(key)}</strong> ${escapeHtml(list)}</span>`);
  }
  return parts.length
    ? `<div class="parsed-summary">${parts.join("")}</div>`
    : "";
}

function getStrategyStatusClass(status) {
  const text = String(status || "").trim();
  if (text === "已失效") return "strategy-status strategy-status-expired";
  if (text === "待提交" || text === "待审核") return "strategy-status strategy-status-pending";
  if (text === "生效中") return "strategy-status strategy-status-active";
  return "strategy-status";
}

function renderStrategyCard(row, fields, index) {
  const title = row["策略名"] || row["规则名称"] || `策略 #${index + 1}`;
  const sid = row["策略id"] ?? "";
  const status = row["状态"] ?? "";
  const statusClass = getStrategyStatusClass(status);

  const fieldRows = (fields || Object.keys(row))
    .map((field) => {
      const value = row[field];
      let valueHtml = formatFieldValue(value);
      if (field === "状态" && value) {
        valueHtml = `<span class="${getStrategyStatusClass(value)}">${escapeHtml(value)}</span>`;
      }
      return `<div class="strategy-field">
        <dt>${escapeHtml(field)}</dt>
        <dd>${valueHtml}</dd>
      </div>`;
    })
    .join("");

  return `<details class="strategy-card">
    <summary class="strategy-card-summary">
      <span class="strategy-card-title">${escapeHtml(title)}</span>
      <span class="strategy-card-meta">
        ${sid ? `<span class="strategy-id">ID ${escapeHtml(sid)}</span>` : ""}
        ${status ? `<span class="${statusClass}">${escapeHtml(status)}</span>` : ""}
      </span>
    </summary>
    <dl class="strategy-field-grid">${fieldRows}</dl>
  </details>`;
}

function renderAssistantResult(data) {
  const { total, rows, fields, parsed, matchedBy } = data;

  let body;
  if (total === 0) {
    body = `<p>未找到匹配策略。请检查 ID 是否正确，或尝试单独查询某一维度。</p>`;
  } else {
    const cards = rows
      .map((row, i) => renderStrategyCard(row, fields, i))
      .join("");
    body = `
      ${renderParsedSummary(parsed, matchedBy)}
      <p class="result-count">共找到 <strong>${total}</strong> 条策略，以下为全部字段：</p>
      <div class="strategy-result-list">${cards}</div>`;
  }

  appendMessage(
    "assistant",
    body
  );
}

function renderError(message) {
  appendMessage(
    "err",
    `<strong>查询失败</strong><p>${escapeHtml(message || "未知错误")}</p>`
  );
}

function setThinkingText(text) {
  const el = document.querySelector("#strategyThinking .thinking-text");
  if (el) el.textContent = text;
}

async function loadStrategyMeta() {
  const badge = document.getElementById("strategyMetaBadge");
  if (badge) badge.textContent = "加载中…";

  try {
    const res = await fetch("/api/strategy/meta");
    if (res.ok) {
      const json = await res.json();
      if (json.success) {
        strategyState.meta = json.data;
        strategyState.mode = "api";
        updateMetaBadge(badge, json.data);
        return;
      }
    }
  } catch (err) {
    console.warn("[strategy] API meta unavailable:", err);
  }

  try {
    if (badge) badge.textContent = "加载本地数据…";
    const meta = await ensureLocalStore();
    strategyState.meta = meta;
    strategyState.mode = "local";
    updateMetaBadge(badge, meta, "本地模式");
  } catch (err) {
    if (badge) {
      badge.textContent = "数据未加载";
      badge.classList.add("err");
    }
    console.error("[strategy] local meta error:", err);
  }
}

async function runLocalQuery(text) {
  if (!localStore.loaded) {
    setThinkingText("正在加载策略数据（首次约需数秒）…");
    await ensureLocalStore();
  }

  const parsed = parseQueryMessage(text);
  if (!parsed.developerIds.length && !parsed.posIds.length && !parsed.appIds.length) {
    throw new Error("请提供开发者ID、广告位ID 或 应用ID");
  }

  setThinkingText("正在查询策略…");
  const result = queryLocal(parsed.developerIds, parsed.posIds, parsed.appIds);
  return {
    parsed: parsed.parsed,
    matchedBy: result.matchedBy,
    total: result.total,
    fields: localStore.meta.fields,
    rows: result.rows,
  };
}

async function sendStrategyQuery(message) {
  if (strategyState.loading) return;
  const text = (message || "").trim();
  if (!text) return;

  strategyState.loading = true;
  const sendBtn = document.getElementById("strategyChatSend");
  const input = document.getElementById("strategyChatInput");
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;

  renderUserMessage(text);
  renderThinking();

  try {
    let data = null;

    if (strategyState.mode !== "local") {
      try {
        const res = await fetch("/api/strategy/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        const json = await res.json();
        if (json.success) {
          data = json.data;
        } else if (res.status !== 404 && json.error !== "Not found") {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
      } catch (apiErr) {
        if (strategyState.mode === "api") {
          console.warn("[strategy] API query failed, fallback to local:", apiErr);
        }
      }
    }

    if (!data) {
      data = await runLocalQuery(text);
      if (strategyState.mode !== "local") {
        strategyState.mode = "local";
        updateMetaBadge(
          document.getElementById("strategyMetaBadge"),
          localStore.meta,
          "本地模式"
        );
      }
    }

    removeThinking();
    renderAssistantResult(data);
  } catch (err) {
    removeThinking();
    renderError(err.message || "查询失败，请刷新页面后重试");
  } finally {
    strategyState.loading = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) {
      input.disabled = false;
      input.value = "";
      input.focus();
    }
  }
}

function initStrategyQuery() {
  if (strategyState.initialized) return;
  strategyState.initialized = true;

  const input = document.getElementById("strategyChatInput");
  const sendBtn = document.getElementById("strategyChatSend");
  const messages = getMessagesEl();

  if (!input || !sendBtn || !messages) return;

  renderWelcomeMessage();
  loadStrategyMeta();
  ensureLocalStore().catch(() => {});

  sendBtn.addEventListener("click", () => sendStrategyQuery(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendStrategyQuery(input.value);
    }
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  document.querySelectorAll(".chip-sm[data-hint]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const hint = chip.dataset.hint || "";
      input.value = (input.value + hint).trimStart();
      input.focus();
    });
  });
}

window.initStrategyQuery = initStrategyQuery;
window.sendStrategyQuery = sendStrategyQuery;
window.onStrategyQueryViewEnter = function onStrategyQueryViewEnter() {
  initStrategyQuery();
  document.getElementById("strategyChatInput")?.focus();
};
