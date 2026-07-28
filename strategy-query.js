/**
 * 策略查询 — Agent 聊天界面
 * 每次查询经 /api/strategy/query 实时打 Operation/orientControl/query
 */

const strategyState = {
  meta: null,
  loading: false,
  initialized: false,
};

function updateMetaBadge(badge, meta, suffix = "") {
  if (!badge || !meta) return;
  const asof = meta.dataAsOfText || "";
  const imported = asof ? ` · 查询于 ${asof}` : " · 实时";
  const mode = suffix ? ` · ${suffix}` : "";
  badge.textContent = `实时策略${imported}${mode}`;
  badge.classList.remove("err");
  updateDataAsofHint(meta, suffix);
}

function updateDataAsofHint(meta, suffix = "") {
  const el = document.getElementById("strategyDataAsof");
  if (!el) return;
  if (!meta) {
    el.textContent = "数据来源：Operation 实时查询（尚未查询）";
    return;
  }
  const asof = meta.dataAsOfText || "";
  const src = meta.source ? ` · ${meta.source}` : " · Operation 实时";
  const mode = suffix ? ` · ${suffix}` : "";
  if (asof) {
    el.textContent = `上次查询时间：${asof}${src}${mode}`;
  } else {
    el.textContent = `数据来源：Operation 实时查询（用户查询时拉取）${mode}`;
  }
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

/** 广告主维度：有值才展示 */
const ADVERTISER_FIELDS = [
  "产品名称",
  "账户ID",
  "快手ID",
  "UnitID",
  "小店通物料类型",
  "一级行业",
  "二级行业",
  "浅度优化目标",
  "深度优化目标",
  "计划类型",
  "出价类型",
  "设备类型",
  "投放范围",
  "计划ID",
  "创意ID",
  "视频ID",
  "营销目标",
  "是否应用直投",
];

/** 单条摘要（先看这些） */
const SUMMARY_FIELDS = [
  "规则名称",
  "投放范围",
  "是否应用直投",
  "是否屏蔽权益卡",
  "是否屏蔽涉黄",
];

/** 长名单字段：默认只显示个数，点开再看 */
const LIST_FIELDS = [
  "产品名称",
  "账户ID",
  "快手ID",
  "UnitID",
  "小店通物料类型",
  "一级行业",
  "二级行业",
  "计划ID",
  "创意ID",
  "视频ID",
  "营销目标",
];

/** 合集里按「值 ×次数」统计的枚举字段（规则名称单独展示） */
const ENUM_AGG_FIELDS = [
  "投放范围",
  "是否应用直投",
  "是否屏蔽权益卡",
  "是否屏蔽涉黄",
  "浅度优化目标",
  "深度优化目标",
  "计划类型",
  "出价类型",
  "设备类型",
  "广告样式",
];

/** 作用媒体范围（去重个数） */
const MEDIA_SCOPE_FIELDS = ["开发者ID", "广告位ID", "应用ID"];

/**
 * 按规则名称分桶（顺序敏感：先屏蔽 → 明暗投 → 定向/定投 → 其他）
 * 「联盟明投-人群包定向」归明暗投。
 */
const RULE_BUCKETS = [
  {
    key: "block",
    title: "① 屏蔽类",
    shortLabel: "屏蔽",
    verb: "屏蔽",
    match: (name) => name.includes("屏蔽"),
  },
  {
    key: "brightDark",
    title: "② 明暗投类",
    shortLabel: "明暗投",
    verb: "明暗投",
    match: (name) => /明暗投|明投|暗投/.test(name),
  },
  {
    key: "orient",
    title: "③ 定向/定投类",
    shortLabel: "定投",
    verb: "定向",
    match: (name) => /定投|定向/.test(name),
  },
  {
    key: "other",
    title: "④ 其他/未标注",
    shortLabel: "其他",
    verb: "覆盖",
    match: () => true,
  },
];

function classifyRuleBucket(ruleName) {
  const name = String(ruleName || "").trim();
  for (const bucket of RULE_BUCKETS) {
    if (bucket.key === "other") continue;
    if (bucket.match(name)) return bucket;
  }
  return RULE_BUCKETS.find((b) => b.key === "other");
}

function listFieldLabel(verb, field) {
  const map = {
    产品名称: `${verb}了哪些产品`,
    账户ID: `${verb}了哪些账户`,
    一级行业: `${verb}了哪些一级行业`,
    二级行业: `${verb}了哪些二级行业`,
    营销目标: `${verb}了哪些营销目标`,
    快手ID: `${verb}的快手ID`,
    UnitID: `${verb}的 UnitID`,
    小店通物料类型: `${verb}的小店通物料类型`,
    计划ID: `${verb}的计划ID`,
    创意ID: `${verb}的创意ID`,
    视频ID: `${verb}的视频ID`,
  };
  return map[field] || field;
}

function hasFieldValue(value) {
  return !(value === null || value === undefined || String(value).trim() === "");
}

function tokenizeFieldValue(value) {
  return String(value ?? "")
    .split(/[;；,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function getStrategyTitle(row, index) {
  return row["策略名"] || row["规则名称"] || `策略 #${index + 1}`;
}

function renderCollapsedList(field, value, label) {
  const tokens = tokenizeFieldValue(value);
  const count = tokens.length || (hasFieldValue(value) ? 1 : 0);
  if (!count) return "";
  const full = escapeHtml(value);
  const title = label || field;
  return `<details class="strategy-list-fold">
    <summary>${escapeHtml(title)}：<strong>${count}</strong> 个</summary>
    <div class="strategy-list-fold-body">${full}</div>
  </details>`;
}

function renderSummaryRows(row) {
  return SUMMARY_FIELDS.filter((field) => hasFieldValue(row[field]))
    .map(
      (field) => `<div class="strategy-field">
        <dt>${escapeHtml(field)}</dt>
        <dd>${formatFieldValue(row[field])}</dd>
      </div>`
    )
    .join("");
}

function renderListFolds(row) {
  return LIST_FIELDS.filter((field) => hasFieldValue(row[field]))
    .map((field) => renderCollapsedList(field, row[field]))
    .join("");
}

function renderExtraShortFields(row) {
  const skip = new Set([...SUMMARY_FIELDS, ...LIST_FIELDS]);
  return ADVERTISER_FIELDS.filter(
    (field) => !skip.has(field) && hasFieldValue(row[field])
  )
    .map(
      (field) => `<div class="strategy-field">
        <dt>${escapeHtml(field)}</dt>
        <dd>${formatFieldValue(row[field])}</dd>
      </div>`
    )
    .join("");
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
  // staging 主题：欢迎说明改由框外「输入提示」承担，这里不再插入欢迎气泡
  if (location.port === "3001" || location.port === "3000") return;
  appendMessage(
    "assistant",
    `<div class="agent-msg-bubble-title">策略查询助手</div>
     <p>每次查询实时请求 Operation。默认只返回<strong>生效中</strong>策略；查询后按顺序展示：<strong>维度合集（按屏蔽/明暗投/定投拆分）</strong> → <strong>策略清单</strong> → <strong>单条明细</strong>。</p>
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
  parts.push(`<span class="parsed-tag"><strong>状态</strong> 生效中</span>`);
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

function emptyAggState() {
  const enumCounts = {};
  for (const field of ["规则名称", ...ENUM_AGG_FIELDS]) {
    enumCounts[field] = new Map();
  }
  const listUnions = {};
  for (const field of LIST_FIELDS) {
    listUnions[field] = new Set();
  }
  const mediaUnions = {};
  for (const field of MEDIA_SCOPE_FIELDS) {
    mediaUnions[field] = new Set();
  }
  return { rows: [], enumCounts, listUnions, mediaUnions };
}

function accumulateRowIntoAgg(state, row) {
  state.rows.push(row);
  for (const field of ["规则名称", ...ENUM_AGG_FIELDS]) {
    const raw = row[field];
    if (!hasFieldValue(raw)) continue;
    const key = String(raw).trim();
    const map = state.enumCounts[field];
    map.set(key, (map.get(key) || 0) + 1);
  }
  for (const field of LIST_FIELDS) {
    const raw = row[field];
    if (!hasFieldValue(raw)) continue;
    const tokens = tokenizeFieldValue(raw);
    if (tokens.length) tokens.forEach((t) => state.listUnions[field].add(t));
    else state.listUnions[field].add(String(raw).trim());
  }
  for (const field of MEDIA_SCOPE_FIELDS) {
    const raw = row[field];
    if (!hasFieldValue(raw)) continue;
    const tokens = tokenizeFieldValue(raw);
    if (tokens.length) tokens.forEach((t) => state.mediaUnions[field].add(t));
    else state.mediaUnions[field].add(String(raw).trim());
  }
}

function groupRowsByRuleBucket(rows) {
  const groups = {};
  for (const bucket of RULE_BUCKETS) {
    groups[bucket.key] = emptyAggState();
  }
  for (const row of rows) {
    const bucket = classifyRuleBucket(row["规则名称"]);
    accumulateRowIntoAgg(groups[bucket.key], row);
  }
  return groups;
}

function renderEnumCountLine(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .map(
      ([val, count]) =>
        `<code>${escapeHtml(val)}</code> <span class="agg-count">×${count}</span>`
    )
    .join(" · ");
}

function renderBucketAggregate(bucket, state) {
  if (!state.rows.length) return "";

  const parts = [];
  const ruleMap = state.enumCounts["规则名称"];
  if (ruleMap.size) {
    parts.push(`<div class="strategy-agg-rule">规则：${renderEnumCountLine(ruleMap)}</div>`);
  }

  const listFolds = LIST_FIELDS.filter((field) => state.listUnions[field].size > 0)
    .map((field) => {
      const set = state.listUnions[field];
      const full = [...set].join(";");
      const label = listFieldLabel(bucket.verb, field);
      return `<details class="strategy-list-fold">
        <summary>${escapeHtml(label)}：<strong>${set.size}</strong> 个</summary>
        <div class="strategy-list-fold-body">${escapeHtml(full)}</div>
      </details>`;
    })
    .join("");
  if (listFolds) {
    parts.push(`<div class="strategy-agg-folds">${listFolds}</div>`);
  }

  const enumItems = ENUM_AGG_FIELDS.filter((field) => state.enumCounts[field].size > 0)
    .map((field) => {
      return `<div class="strategy-agg-enum-row">
        <span class="strategy-agg-enum-key">${escapeHtml(field)}</span>
        <span class="strategy-agg-enum-vals">${renderEnumCountLine(state.enumCounts[field])}</span>
      </div>`;
    })
    .join("");
  if (enumItems) {
    parts.push(`<div class="strategy-agg-enums">${enumItems}</div>`);
  }

  const mediaBits = MEDIA_SCOPE_FIELDS.filter((field) => state.mediaUnions[field].size > 0).map(
    (field) => {
      const short =
        field === "开发者ID" ? "开发者" : field === "广告位ID" ? "广告位" : "应用";
      return `${short} <strong>${state.mediaUnions[field].size}</strong> 个`;
    }
  );
  if (mediaBits.length) {
    parts.push(
      `<div class="strategy-agg-media">作用媒体范围：${mediaBits.join(" · ")}</div>`
    );
  }

  if (!parts.length) {
    parts.push(`<p class="agent-muted">该类型暂无可汇总的广告主维度。</p>`);
  }

  return `<section class="strategy-agg-bucket" data-bucket="${escapeHtml(bucket.key)}">
    <div class="strategy-agg-bucket-title">${escapeHtml(bucket.title)}（${state.rows.length} 条）</div>
    ${parts.join("")}
  </section>`;
}

function renderDimensionAggregate(rows) {
  const groups = groupRowsByRuleBucket(rows);
  const bucketHtml = RULE_BUCKETS.map((bucket) =>
    renderBucketAggregate(bucket, groups[bucket.key])
  )
    .filter(Boolean)
    .join("");

  if (!bucketHtml) {
    return `<div class="strategy-agg-panel">
      <div class="strategy-section-title">维度合集（按策略类型拆分 · 基于 ${rows.length} 条）</div>
      <p class="agent-muted">本批策略暂无可汇总的广告主 / 屏蔽维度。</p>
    </div>`;
  }

  return `<div class="strategy-agg-panel">
    <div class="strategy-section-title">维度合集（按策略类型拆分 · 基于 ${rows.length} 条）</div>
    <p class="agent-muted strategy-agg-hint">先按屏蔽 / 明暗投 / 定投分开看整体对象，再对单条明细。</p>
    ${bucketHtml}
  </div>`;
}

function renderNameList(rows) {
  const items = rows
    .map((row, i) => {
      const title = getStrategyTitle(row, i);
      const sid = row["策略id"] ?? "";
      const status = row["状态"] ?? "";
      const statusClass = getStrategyStatusClass(status);
      const bucket = classifyRuleBucket(row["规则名称"]);
      return `<li class="strategy-name-item">
        <span class="strategy-name-index">${i + 1}.</span>
        <span class="strategy-name-title">${escapeHtml(title)}</span>
        <span class="strategy-name-meta">
          ${sid ? `<span class="strategy-id">ID ${escapeHtml(sid)}</span>` : ""}
          ${status ? `<span class="${statusClass}">${escapeHtml(status)}</span>` : ""}
          <span class="strategy-bucket-tag">${escapeHtml(bucket.shortLabel)}</span>
        </span>
      </li>`;
    })
    .join("");

  return `<div class="strategy-name-panel">
    <div class="strategy-section-title">策略清单（共 ${rows.length} 条）</div>
    <ol class="strategy-name-list">${items}</ol>
  </div>`;
}

function renderStrategyCard(row, index) {
  const title = getStrategyTitle(row, index);
  const sid = row["策略id"] ?? "";
  const status = row["状态"] ?? "";
  const statusClass = getStrategyStatusClass(status);

  const summaryHtml = renderSummaryRows(row);
  const extraHtml = renderExtraShortFields(row);
  const listHtml = renderListFolds(row);

  const summaryBlock = summaryHtml
    ? `<div class="strategy-section">
        <div class="strategy-section-title">摘要</div>
        <dl class="strategy-field-grid">${summaryHtml}</dl>
      </div>`
    : "";
  const extraBlock = extraHtml
    ? `<div class="strategy-section">
        <div class="strategy-section-title">其他广告主字段</div>
        <dl class="strategy-field-grid">${extraHtml}</dl>
      </div>`
    : "";
  const listBlock = listHtml
    ? `<div class="strategy-section">
        <div class="strategy-section-title">长名单（点开查看）</div>
        <div class="strategy-agg-folds">${listHtml}</div>
      </div>`
    : "";

  const bodySections =
    (summaryBlock + extraBlock + listBlock) ||
    `<p class="agent-muted">该策略暂无广告主维度或屏蔽相关字段。</p>`;

  return `<details class="strategy-card">
    <summary class="strategy-card-summary">
      <span class="strategy-card-title">${index + 1}. ${escapeHtml(title)}</span>
      <span class="strategy-card-meta">
        ${sid ? `<span class="strategy-id">ID ${escapeHtml(sid)}</span>` : ""}
        ${status ? `<span class="${statusClass}">${escapeHtml(status)}</span>` : ""}
      </span>
    </summary>
    <div class="strategy-card-body">${bodySections}</div>
  </details>`;
}

function renderAssistantResult(data) {
  const { total, rows, parsed, matchedBy } = data;

  let body;
  if (total === 0) {
    body = `<p>未找到<strong>生效中</strong>的匹配策略。请检查 ID 是否正确，或尝试单独查询某一维度。</p>
      ${renderParsedSummary(parsed, matchedBy)}`;
  } else {
    const cards = rows
      .map((row, i) => renderStrategyCard(row, i))
      .join("");
    body = `
      ${renderParsedSummary(parsed, matchedBy)}
      ${renderDimensionAggregate(rows)}
      ${renderNameList(rows)}
      <div class="strategy-section-title strategy-detail-title">单条明细（默认折叠）</div>
      <div class="strategy-result-list">${cards}</div>`;
  }

  appendMessage("assistant", body);
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
  if (badge) badge.textContent = "实时模式";

  try {
    const res = await fetch("/api/strategy/meta");
    if (res.ok) {
      const json = await res.json();
      if (json.success) {
        strategyState.meta = json.data;
        updateMetaBadge(badge, json.data);
        return;
      }
    }
  } catch (err) {
    console.warn("[strategy] live meta unavailable:", err);
  }

  updateDataAsofHint({ source: "operation-tool" });
  if (badge) {
    badge.textContent = "实时模式 · 待查询";
    badge.classList.remove("err");
  }
}

async function sendStrategyQuery(message) {
  if (strategyState.loading) return;
  const text = (message || "").trim();
  if (!text) return;

  if (typeof window.recordFunnelHistory === "function") {
    window.recordFunnelHistory(text, "strategy-query");
  }

  strategyState.loading = true;
  const sendBtn = document.getElementById("strategyChatSend");
  const input = document.getElementById("strategyChatInput");
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;

  renderUserMessage(text);
  renderThinking();

  try {
    setThinkingText("正在实时查询 Operation 策略…");
    const res = await fetch("/api/strategy/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const json = await res.json();
    if (!json.success) {
      if (res.status === 401 || json.error === "COOKIE_EXPIRED") {
        throw new Error("Operation 未登录或 Cookie 过期，请联系管理员在服务端完成登录");
      }
      throw new Error(json.message || json.error || `HTTP ${res.status}`);
    }
    const data = json.data;
    if (data.meta) {
      strategyState.meta = { ...(strategyState.meta || {}), ...data.meta };
      updateMetaBadge(document.getElementById("strategyMetaBadge"), strategyState.meta);
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
}

window.sendStrategyQuery = sendStrategyQuery;
window.onStrategyQueryViewEnter = function onStrategyQueryViewEnter() {
  initStrategyQuery();
  document.getElementById("strategyChatInput")?.focus();
};
