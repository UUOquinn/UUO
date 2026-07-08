/* ═══════════════════════════════════════════════════════
 *  联盟诊断工作台 - 前端主逻辑 v1.2
 *  新增：真实数据源接入 + 漏斗可视化 + Loading 状态
 * ═══════════════════════════════════════════════════════ */

// ─── API 基地址（后端同源，无需跨域） ───
const API_BASE = window.__API_BASE__ || "";

// ─── KwaiBI Cookie 存储 key ───
const KWABI_COOKIE_KEY = "kwabi-auth-cookie";

function getKwabiCookie() {
  return localStorage.getItem(KWABI_COOKIE_KEY) || "";
}

function setKwabiCookie(val) {
  localStorage.setItem(KWABI_COOKIE_KEY, val);
}

// ─── 数据集元信息 ───
const DATASET_META = {
  "85587":  { name: "离线主效果数据", type: "offline" },
  "129496": { name: "实时主效果数据", type: "realtime" },
  "207512": { name: "请求链路过滤原因", type: "drill" },
  "103846": { name: "召回/粗排/精排漏斗", type: "drill" },
};

// ─── 指标识别规则 ───
const METRIC_RULES = [
  { keywords: ["分成", "媒体收益"], metric: "分成金额" },
  { keywords: ["有效请求率", "请求链路"], metric: "有效请求率" },
  { keywords: ["有效填充率"], metric: "有效填充率" },
  { keywords: ["广告填充率"], metric: "广告填充率" },
  { keywords: ["填充率", "填充异常", "返回少"], metric: "广告填充率 或 有效填充率" },
  { keywords: ["曝光率"], metric: "曝光率" },
  { keywords: ["曝光", "曝光少"], metric: "素材曝光量 或 曝光率" },
  { keywords: ["CPM"], metric: "CPM" },
  { keywords: ["CTR", "点击率"], metric: "CTR" },
  { keywords: ["CVR", "转化率"], metric: "CVR" },
  { keywords: ["请求下降", "请求少"], metric: "广告请求次数" },
  { keywords: ["消耗", "不跑量", "跑不出去"], metric: "联盟总消耗" },
];

// ─── 下钻规则 ───
const DRILL_RULES = {
  广告请求次数: { file: "query-mapping.md", direction: "拆媒体 / appid / posid / 广告场景" },
  有效请求率: {
    file: "request-filter-207512.md",
    dataset: "207512",
    direction: "查过滤原因、请求次数、过滤占比",
  },
  广告填充率: { file: "视拆解结果", direction: "先拆有效请求率和有效填充率" },
  有效填充率: {
    file: "recall-rank-funnel-103846.md",
    dataset: "103846",
    direction: "查召回 / 粗排 / 精排 / 混排 / 前端 / 曝光漏斗",
  },
  曝光率: { file: "query-mapping.md", direction: "查广告下发 / 展示 / 上报 / 广告位样式" },
  CPM: { file: "query-mapping.md", direction: "拆预算结构、场景结构、竞价强度、出价变化" },
  CTR: { file: "query-mapping.md", direction: "拆广告场景、广告位、素材、流量质量" },
  CVR: { file: "query-mapping.md", direction: "拆转化目标、产品、行业、人群、落地页" },
};

// ─── 主漏斗指标配置（用于真实查询） ───
const MAIN_FUNNEL_METRICS = [
  "联盟总消耗", "分成金额",
  "广告请求次数", "有效请求次数", "广告返回次数",
  "素材曝光量", "点击量", "转化量",
  "有效请求率", "广告填充率", "有效填充率",
  "曝光率", "CPM", "CTR", "CVR",
];

// ─── 207512 查询指标 ───
const DATASET_207512_METRICS = [
  "ad_request_cnt", "ad_request_num",
  "extend_column_dde9b140-a94d-11ee-bda9-692d93f6ff17",
  "extend_column_fbc3a0d0-901c-11ee-b5b8-cd6074cd673e",
  "extend_column_1f7ab1d0-901d-11ee-b5b8-cd6074cd673e",
  "extend_column_1a0d0910-901c-11ee-b5b8-cd6074cd673e",
  "extend_column_0716c1c0-901c-11ee-b5b8-cd6074cd673e",
  "extend_column_26ff7030-901d-11ee-b5b8-cd6074cd673e",
  "extend_column_a6ea48c0-901c-11ee-b5b8-cd6074cd673e",
  "extend_column_d74dfac0-901c-11ee-b5b8-cd6074cd673e",
  "extend_column_2491e810-901c-11ee-b5b8-cd6074cd673e",
  "extend_column_736f35f0-8a7c-11ee-972b-252fc11f28f8",
  "extend_column_eab5b9e0-8a7c-11ee-972b-252fc11f28f8",
  "extend_column_050df550-8a7d-11ee-972b-252fc11f28f8",
  "extend_column_3fd7d0a0-8a02-11ee-ae5a-19e85075413e",
  "extend_column_7c789980-9435-11ee-9749-53632db4ea1c",
];

// ─── 207512 过滤比中文名映射 ───
const FILTER_207512_NAMES = {
  "extend_column_dde9b140-a94d-11ee-bda9-692d93f6ff17": "请求合法性校验过滤比",
  "extend_column_fbc3a0d0-901c-11ee-b5b8-cd6074cd673e": "bidding反作弊过滤比",
  "extend_column_1f7ab1d0-901d-11ee-b5b8-cd6074cd673e": "adn反作弊过滤比",
  "extend_column_1a0d0910-901c-11ee-b5b8-cd6074cd673e": "反作弊过滤比",
  "extend_column_0716c1c0-901c-11ee-b5b8-cd6074cd673e": "价值分过滤比",
  "extend_column_26ff7030-901d-11ee-b5b8-cd6074cd673e": "adn价值分过滤比",
  "extend_column_a6ea48c0-901c-11ee-b5b8-cd6074cd673e": "adn短时间无广告过滤比",
  "extend_column_d74dfac0-901c-11ee-b5b8-cd6074cd673e": "bidding短时间无广告过滤比",
  "extend_column_2491e810-901c-11ee-b5b8-cd6074cd673e": "短时间无广告过滤比",
  "extend_column_736f35f0-8a7c-11ee-972b-252fc11f28f8": "反作弊过滤_过滤次数",
  "extend_column_eab5b9e0-8a7c-11ee-972b-252fc11f28f8": "全局价值分过滤_过滤次数",
  "extend_column_050df550-8a7d-11ee-972b-252fc11f28f8": "短时间无广告过滤_过滤次数",
  "extend_column_3fd7d0a0-8a02-11ee-ae5a-19e85075413e": "过滤原因_聚合价值分等",
  "extend_column_7c789980-9435-11ee-9749-53632db4ea1c": "请求承接率",
};

// ─── 103846 查询指标 ───
const DATASET_103846_METRICS = [
  "recall_cnt", "preranking_cnt", "ranking_cnt",
  "mix_cnt", "front_cnt", "ad_item_impression_cnt", "__count__",
];

// ─── 103846 漏斗中文名 ───
const FUNNEL_103846_NAMES = {
  recall_cnt: "召回量",
  preranking_cnt: "粗排量",
  ranking_cnt: "精排量",
  mix_cnt: "混排量",
  front_cnt: "前端/下发量",
  ad_item_impression_cnt: "广告曝光量",
};

const HISTORY_KEY = "alliance-funnel-history";

/* ═══════════════════════════════════════════════════
 *  工具函数
 * ═══════════════════════════════════════════════════ */

function parseList(value) {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function detectMetric(question, selected) {
  if (selected && selected !== "auto") {
    return selected;
  }
  for (const rule of METRIC_RULES) {
    if (rule.keywords.some((keyword) => question.includes(keyword))) {
      return rule.metric;
    }
  }
  return "联盟总消耗";
}

function detectDateMode(question, selected) {
  if (selected !== "auto") {
    return selected;
  }
  if (/实时|今天|当天|当前|现在/.test(question)) {
    return "today";
  }
  if (/近\d+天|最近\d+天/.test(question)) {
    return "range";
  }
  return "history";
}

function getDatasetInfo(dateMode) {
  if (dateMode === "today") {
    return {
      mainDataset: "129496",
      compare: "今日当前累计 vs 昨日同时间段",
      label: "实时主效果数据",
    };
  }
  if (dateMode === "range") {
    return {
      mainDataset: "85587",
      compare: "近 N 天日均 vs 上一周期 N 天日均",
      label: "离线主效果数据",
    };
  }
  return {
    mainDataset: "85587",
    compare: "目标日 vs 前一天，可补充上周同日",
    label: "离线主效果数据",
  };
}

function getDrillPlan(metric) {
  if (metric.includes("有效填充率")) {
    return DRILL_RULES.有效填充率;
  }
  if (metric.includes("广告填充率")) {
    return DRILL_RULES.广告填充率;
  }
  return DRILL_RULES[metric] || null;
}

function buildFilters({ uid, appId, posId, adStyle }) {
  const filters = {};
  if (uid.length) filters.uid = uid;
  if (appId.length) filters.app_id = appId;
  if (posId.length) filters.pos_id = posId;
  if (adStyle.length) filters.ad_style = adStyle;
  return filters;
}

function formatFilters(filters) {
  const entries = Object.entries(filters);
  if (!entries.length) return "无";
  return entries
    .map(([key, values]) => `${key} in (${values.join(", ")})`)
    .join(" AND ");
}

function buildConclusion(metric, drillPlan) {
  if (!drillPlan) {
    return `当前目标指标为「${metric}」。先查主漏斗，确认异常后再决定是否下钻。`;
  }
  if (drillPlan.dataset === "207512") {
    return `若主漏斗确认「${metric}」下降，优先进入 207512，查看过滤原因、请求次数和过滤占比。`;
  }
  if (drillPlan.dataset === "103846") {
    return `若主漏斗确认「${metric}」或广告返回次数异常，优先进入 103846，查看召粗精链路异常阶段。`;
  }
  if (metric.includes("广告填充率")) {
    return "若广告填充率下降，先拆有效请求率和有效填充率；有效请求率先查 207512，有效填充率再查 103846。";
  }
  return `若主漏斗确认「${metric}」异常，按 ${drillPlan.file} 的方向继续排查。`;
}

/* ═══════════════════════════════════════════════════
 *  时间计算
 * ═══════════════════════════════════════════════════ */

function getDateRange(dateMode) {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);

  if (dateMode === "today") {
    // 今日实时 vs 昨日同时间段
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return {
      target: { start: fmt(today), end: fmt(today) },
      compare: { start: fmt(yesterday), end: fmt(yesterday) },
    };
  }

  // 历史单日 / 近N天 → 默认 T-1 vs T-2
  const t1 = new Date(today);
  t1.setDate(t1.getDate() - 1);
  const t2 = new Date(today);
  t2.setDate(t2.getDate() - 2);
  return {
    target: { start: fmt(t1), end: fmt(t1) },
    compare: { start: fmt(t2), end: fmt(t2) },
  };
}

/* ═══════════════════════════════════════════════════
 *  API 调用层
 * ═══════════════════════════════════════════════════ */

function _apiHeaders(extra) {
  const h = { "Content-Type": "application/json", ...extra };
  const cookie = getKwabiCookie();
  if (cookie) {
    h["X-Kwabi-Cookie"] = cookie;
  }
  return h;
}

// ─── Cookie 失效全局提示 ───
// 当后端返回 COOKIE_EXPIRED 错误时，标记侧边栏 Cookie 状态为红色"已过期"
// 并滚动到 Cookie 配置区域，提示用户重新配置
function markCookieExpired() {
  const status = document.getElementById("kwabiCookieStatus");
  const config = document.querySelector(".cookie-config");
  const hasPersonalCookie = !!getKwabiCookie();

  if (status) {
    if (hasPersonalCookie) {
      // 用户自己配的 Cookie 过期了，提示用户重新配
      status.textContent = "个人 Cookie 已过期，请重新配置";
    } else {
      // 服务端共享 Cookie 过期了，提示联系维护者
      status.textContent = "服务端 Cookie 已过期，请联系维护者更新 server/cookie.json";
    }
    status.className = "cookie-status err";
    status.style.fontWeight = "700";
  }
  if (config) {
    config.classList.add("cookie-expired");
    // 只在第一次触发时滚动，避免频繁打扰
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

// ─── 统一 API 错误检测：判断是否 Cookie 失效 ───
function isCookieExpiredError(err) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("COOKIE_EXPIRED") ||
    msg.includes("Cookie 已过期") ||
    msg.includes("Cookie 可能已过期") ||
    /^API 401/.test(msg) ||
    /^API 403/.test(msg)
  );
}

// 暴露给其他模块使用
window.markCookieExpired = markCookieExpired;
window.clearCookieExpired = clearCookieExpired;
window.isCookieExpiredError = isCookieExpiredError;

async function fetchDatasetQuery(payload) {
  const resp = await fetch(`${API_BASE}/api/dataset/query`, {
    method: "POST",
    headers: _apiHeaders(),
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 401) markCookieExpired();
    throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const result = await resp.json();
  if (!result.success) {
    if (result.error === "COOKIE_EXPIRED") markCookieExpired();
    throw new Error(result.error || "查询失败");
  }
  clearCookieExpired();
  return result.data;
}

async function fetchMetadata(datasetId) {
  const resp = await fetch(`${API_BASE}/api/dataset/metadata`, {
    method: "POST",
    headers: _apiHeaders(),
    credentials: "include",
    body: JSON.stringify({ datasetId }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 401) markCookieExpired();
    throw new Error(`Metadata API ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const result = await resp.json();
  if (!result.success) {
    if (result.error === "COOKIE_EXPIRED") markCookieExpired();
    throw new Error(result.error || "元数据查询失败");
  }
  return result.data;
}

/* ═══════════════════════════════════════════════════
 *  历史记录
 * ═══════════════════════════════════════════════════ */

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(entry) {
  const history = [entry, ...getHistory()].slice(0, 20);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  updateQueryCount();
  renderHistory();
}

function updateQueryCount() {
  document.getElementById("statQueryCount").textContent = String(getHistory().length);
}

/* ═══════════════════════════════════════════════════
 *  表单与视图
 * ═══════════════════════════════════════════════════ */

function fillForm(form) {
  document.getElementById("question").value = form.question || "";
  document.getElementById("dateMode").value = form.dateMode || "auto";
  document.getElementById("anomalyMetric").value = form.anomalyMetric || "auto";
  document.getElementById("uid").value = form.uid || "";
  document.getElementById("appId").value = form.appId || "";
  document.getElementById("posId").value = form.posId || "";
  document.getElementById("adStyle").value = form.adStyle || "";
}

function getFormData() {
  return {
    question: document.getElementById("question").value.trim(),
    dateMode: document.getElementById("dateMode").value,
    anomalyMetric: document.getElementById("anomalyMetric").value,
    uid: document.getElementById("uid").value,
    appId: document.getElementById("appId").value,
    posId: document.getElementById("posId").value,
    adStyle: document.getElementById("adStyle").value,
  };
}

function switchView(view) {
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.getElementById("viewHome")?.classList.toggle("hidden", view !== "home");
  document.getElementById("viewDiagnosis").classList.toggle("hidden", view !== "diagnosis");
  document.getElementById("viewHistory").classList.toggle("hidden", view !== "history");
  document.getElementById("viewStrategyQuery").classList.toggle("hidden", view !== "strategy-query");
  document.getElementById("viewStrategyAudit").classList.toggle("hidden", view !== "strategy-audit");
  document.getElementById("viewStrategyRenewal").classList.toggle("hidden", view !== "strategy-renewal");

  const isFullChat = view === "strategy-query" || view === "strategy-audit" || view === "strategy-renewal";
  const isHome = view === "home";
  document.querySelector(".content")?.classList.toggle("content-strategy-query", isFullChat);
  document.querySelector(".content")?.classList.toggle("content-home", isHome);
  document.getElementById("resetBtn")?.classList.toggle("hidden", isFullChat || isHome);
  document.getElementById("statusBadge")?.classList.toggle("hidden", isFullChat || isHome);

  const titles = {
    home: "首页",
    diagnosis: "漏斗诊断",
    history: "查询记录",
    "strategy-query": "策略查询",
    "strategy-audit": "策略审核",
    "strategy-renewal": "策略延期",
  };
  document.getElementById("breadcrumbCurrent").textContent = titles[view] || "工作台";

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

  closeMobileSidebar();
}

window.switchView = switchView;

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

function resetForm() {
  fillForm({
    question: "",
    dateMode: "auto",
    anomalyMetric: "auto",
    uid: "",
    appId: "",
    posId: "",
    adStyle: "",
  });
  document.getElementById("resultContent").classList.add("hidden");
  document.getElementById("resultEmpty").classList.remove("hidden");
  document.getElementById("resultStatus").textContent = "等待生成";
}

/* ═══════════════════════════════════════════════════
 *  渲染：漏斗条形图（纯 CSS）
 * ═══════════════════════════════════════════════════ */

function renderFunnelBarHTML(stages) {
  if (!stages || !stages.length) return "";
  const maxVal = Math.max(...stages.map((s) => s.value || 0), 1);

  return `<div class="funnel-chart">
    ${stages
      .map((s) => {
        const pct = ((s.value || 0) / maxVal) * 100;
        const rate = s.rate ? ` <span class="funnel-rate">(${s.rate})</span>` : "";
        return `<div class="funnel-row">
        <div class="funnel-label">${s.label}${rate}</div>
        <div class="funnel-bar-track">
          <div class="funnel-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="funnel-value">${formatNum(s.value)}</div>
      </div>`;
      })
      .join("")}
  </div>`;
}

function renderFunnelBar103846(rows) {
  if (!rows || !rows.length) return "<p>无漏斗数据</p>";

  return rows
    .map((row) => {
      const stages = [
        { label: "召回", value: row.recall_cnt },
        { label: "粗排", value: row.preranking_cnt, rate: row.recall_cnt ? `${((row.preranking_cnt / row.recall_cnt) * 100).toFixed(1)}%` : "" },
        { label: "精排", value: row.ranking_cnt, rate: row.preranking_cnt ? `${((row.ranking_cnt / row.preranking_cnt) * 100).toFixed(1)}%` : "" },
        { label: "混排", value: row.mix_cnt, rate: row.ranking_cnt ? `${((row.mix_cnt / row.ranking_cnt) * 100).toFixed(1)}%` : "" },
        { label: "前端", value: row.front_cnt, rate: row.mix_cnt ? `${((row.front_cnt / row.mix_cnt) * 100).toFixed(1)}%` : "" },
        { label: "曝光", value: row.ad_item_impression_cnt, rate: row.front_cnt ? `${((row.ad_item_impression_cnt / row.front_cnt) * 100).toFixed(1)}%` : "" },
      ];
      return renderFunnelBarHTML(stages);
    })
    .join("");
}

function renderFunnelBar207512(rows) {
  if (!rows || !rows.length) return "<p>无过滤数据</p>";

  return rows
    .map((row) => {
      const stages = [];
      // 取过滤比 Top 5
      const filterRatios = Object.entries(FILTER_207512_NAMES)
        .filter(([, name]) => name.includes("过滤比"))
        .map(([key, name]) => ({ key, name, value: parseFloat(row[key]) || 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 5);

      for (const fr of filterRatios) {
        stages.push({
          label: fr.name.replace("过滤比", ""),
          value: Math.round(fr.value * (row.ad_request_num || 1)),
          rate: fr.value ? `${(fr.value * 100).toFixed(1)}%` : "-",
        });
      }

      return `<div class="funnel-section">
        <div class="funnel-section-title">请求量 ${formatNum(row.ad_request_cnt)} / 请求次数 ${formatNum(row.ad_request_num)}</div>
        ${renderFunnelBarHTML(stages)}
      </div>`;
    })
    .join("");
}

/* ═══════════════════════════════════════════════════
 *  渲染：数据表格
 * ═══════════════════════════════════════════════════ */

function renderDataTableHTML(columns, rows) {
  if (!columns || !rows) return "<p>无数据</p>";

  const colNames = columns.map((c) =>
    FILTER_207512_NAMES[c] || FUNNEL_103846_NAMES[c] || c
  );

  return `<div class="data-table-wrap"><table class="data-table">
    <thead><tr>${colNames.map((n) => `<th>${n}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map(
        (row) =>
          `<tr>${(Array.isArray(row) ? row : columns.map((c) => row[c]))
            .map((v) => `<td>${formatNum(v)}</td>`)
            .join("")}</tr>`
      )
      .join("")}</tbody>
  </table></div>`;
}

/* ═══════════════════════════════════════════════════
 *  渲染：主漏斗对比表格
 * ═══════════════════════════════════════════════════ */

function renderMainFunnelCompareTable(targetRow, compareRow, columns) {
  if (!targetRow && !compareRow) return "<p>主漏斗查询无数据</p>";

  const metrics = MAIN_FUNNEL_METRICS.filter((m) => columns.includes(m));

  return `<div class="data-table-wrap"><table class="data-table compare-table">
    <thead><tr>
      <th>指标</th><th>目标期</th><th>对比期</th><th>变化</th>
    </tr></thead>
    <tbody>${metrics
      .map((m) => {
        const tv = targetRow ? (targetRow[m] ?? "-") : "-";
        const cv = compareRow ? (compareRow[m] ?? "-") : "-";
        const change = calcChange(tv, cv, m);
        const cls = change ? (change.includes("↓") ? "decline" : "growth") : "";
        return `<tr>
          <td>${m}</td>
          <td>${formatNum(tv)}</td>
          <td>${formatNum(cv)}</td>
          <td class="${cls}">${change || "-"}</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table></div>`;
}

/* ═══════════════════════════════════════════════════
 *  格式化与计算
 * ═══════════════════════════════════════════════════ */

function formatNum(v) {
  if (v === null || v === undefined || v === "-") return "-";
  if (typeof v === "string") return v;
  if (Number.isNaN(v)) return "-";
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + "万";
  if (Number.isInteger(v)) return v.toLocaleString("zh-CN");
  return v.toFixed(2);
}

function calcChange(target, compare, metric) {
  const tv = parseFloat(target);
  const cv = parseFloat(compare);
  if (isNaN(tv) || isNaN(cv) || cv === 0) return null;

  // 率类指标：看 pp 变化
  const rateMetrics = ["有效请求率", "广告填充率", "有效填充率", "曝光率", "CTR", "CVR"];
  if (rateMetrics.includes(metric)) {
    const diff = tv - cv;
    const arrow = diff > 0 ? "↑" : "↓";
    return `${arrow} ${Math.abs(diff).toFixed(2)}pp`;
  }

  // 量级指标：看百分比
  const pct = ((tv - cv) / cv) * 100;
  const arrow = pct > 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(pct).toFixed(1)}%`;
}

/* ═══════════════════════════════════════════════════
 *  渲染：完整诊断结果
 * ═══════════════════════════════════════════════════ */

function renderResult(payload) {
  const empty = document.getElementById("resultEmpty");
  const content = document.getElementById("resultContent");
  const status = document.getElementById("resultStatus");

  status.textContent = "已生成";
  empty.classList.add("hidden");
  content.classList.remove("hidden");

  const {
    metric, mainDataset, datasetLabel, compare, drillDataset,
    filtersText, displayDimensions, conclusion, nextStep,
    mainData, drillData, drillQuery, dataMode,
  } = payload;

  // 主漏斗数据区域
  let mainDataHTML = "";
  if (mainData && mainData.rows && mainData.rows.length) {
    const targetRow = mainData.rows[0];
    const compareRow = mainData.rows.length > 1 ? mainData.rows[1] : null;
    mainDataHTML = `
      <div class="result-block">
        <h3>主漏斗数据 <span class="data-badge">真实数据</span></h3>
        ${renderMainFunnelCompareTable(targetRow, compareRow, mainData.columns || [])}
      </div>`;
  } else if (mainData) {
    mainDataHTML = `
      <div class="result-block">
        <h3>主漏斗数据</h3>
        <div class="note">查询返回空结果，请检查筛选条件或时间范围</div>
        ${renderDataTableHTML(mainData.columns || [], mainData.rows || [])}
      </div>`;
  }

  // 下钻数据区域
  let drillDataHTML = "";
  if (drillData && drillData.rows && drillData.rows.length) {
    if (drillDataset === "207512") {
      drillDataHTML = `
        <div class="result-block">
          <h3>请求链路过滤分析 <span class="data-badge">207512</span></h3>
          ${renderFunnelBar207512(drillData.rows)}
          ${renderDataTableHTML(drillData.columns, drillData.rows)}
        </div>`;
    } else if (drillDataset === "103846") {
      drillDataHTML = `
        <div class="result-block">
          <h3>召粗精漏斗分析 <span class="data-badge">103846</span></h3>
          ${renderFunnelBar103846(drillData.rows)}
          ${renderDataTableHTML(drillData.columns, drillData.rows)}
        </div>`;
    }
  }

  content.innerHTML = `
    <div class="result-summary">${conclusion}</div>

    <div class="result-block">
      <h3>识别结果</h3>
      <div class="tag-row">
        <span class="tag">目标指标：${metric}</span>
        <span class="tag">主数据集：${mainDataset}</span>
        ${drillDataset ? `<span class="tag">下钻：${drillDataset}</span>` : ""}
      </div>
    </div>

    <div class="result-block">
      <h3>查询口径</h3>
      <ul class="info-list">
        <li><span class="label">主数据集</span><span class="value">${mainDataset}（${datasetLabel}）</span></li>
        <li><span class="label">对比口径</span><span class="value">${compare}</span></li>
        <li><span class="label">筛选条件</span><span class="value">${filtersText}</span></li>
        <li><span class="label">展示维度</span><span class="value">${displayDimensions}</span></li>
      </ul>
    </div>

    ${mainDataHTML}

    ${drillDataHTML}

    <div class="result-block">
      <h3>执行路径</h3>
      <ol class="timeline">
        <li>查主漏斗（${mainDataset}）</li>
        <li>判断目标指标和第一个异常链路指标</li>
        <li>${nextStep}</li>
      </ol>
    </div>

    ${
      drillQuery
        ? `<div class="result-block">
            <h3>下钻查询草案</h3>
            <pre>${JSON.stringify(drillQuery, null, 2)}</pre>
          </div>`
        : ""
    }
  `;
}

/* ═══════════════════════════════════════════════════
 *  渲染：历史记录
 * ═══════════════════════════════════════════════════ */

function renderHistory() {
  const list = document.getElementById("historyList");
  const history = getHistory();

  if (!history.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗂️</div>
        <h3>暂无查询记录</h3>
        <p>生成诊断口径后会自动保存在这里。</p>
      </div>`;
    return;
  }

  list.innerHTML = history
    .map(
      (item, index) => `
      <article class="history-item">
        <h3>${item.question}</h3>
        <div class="history-meta">
          <span class="tag">指标：${item.metric}</span>
          <span class="tag">数据集：${item.mainDataset}</span>
          ${item.drillDataset ? `<span class="tag">下钻：${item.drillDataset}</span>` : ""}
          ${item.dataMode ? `<span class="tag">${item.dataMode === "real" ? "真实数据" : "口径模式"}</span>` : ""}
        </div>
        <div class="history-time">${item.time}</div>
        <div class="history-actions">
          <button type="button" data-reuse="${index}">复用</button>
        </div>
      </article>`
    )
    .join("");

  list.querySelectorAll("[data-reuse]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = history[Number(button.dataset.reuse)];
      fillForm(item.form);
      switchView("diagnosis");
      generateDiagnosis();
    });
  });
}

/* ═══════════════════════════════════════════════════
 *  核心：生成诊断（含真实数据查询）
 * ═══════════════════════════════════════════════════ */

async function generateDiagnosis() {
  const form = getFormData();
  if (!form.question) {
    alert("请先输入诊断问题");
    return;
  }

  const dateMode = detectDateMode(form.question, form.dateMode);
  const metric = detectMetric(form.question, form.anomalyMetric);
  const filters = buildFilters({
    uid: parseList(form.uid),
    appId: parseList(form.appId),
    posId: parseList(form.posId),
    adStyle: parseList(form.adStyle),
  });

  const datasetInfo = getDatasetInfo(dateMode);
  const drillPlan = getDrillPlan(metric);
  const dateRange = getDateRange(dateMode);

  const drillQuery =
    drillPlan?.dataset === "207512"
      ? build207512Query(filters)
      : drillPlan?.dataset === "103846"
        ? build103846Query(filters)
        : null;

  // ─── 显示 Loading ───
  const content = document.getElementById("resultContent");
  const empty = document.getElementById("resultEmpty");
  const status = document.getElementById("resultStatus");

  empty.classList.add("hidden");
  content.classList.remove("hidden");
  status.textContent = "查询中…";
  content.innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <h3>正在查询真实数据…</h3>
      <p>正在调用 ${datasetInfo.mainDataset}（${datasetInfo.label}）</p>
    </div>`;

  // ─── 查询主漏斗真实数据 ───
  let mainData = null;
  let dataMode = "spec"; // spec = 口径模式, real = 真实数据

  try {
    const mainResult = await fetchDatasetQuery({
      datasetId: datasetInfo.mainDataset,
      metrics: MAIN_FUNNEL_METRICS,
      filters: {
        ...filters,
        __time: dateRange.target,
      },
      compareTime: dateRange.compare,
      limit: 100,
    });

    mainData = mainResult;
    dataMode = "real";
    status.textContent = "已生成（真实数据）";
  } catch (err) {
    console.warn("[主漏斗查询失败，回退口径模式]", err.message);
    status.textContent = "已生成（口径模式）";
    dataMode = "spec";
  }

  // ─── 查询下钻数据 ───
  let drillData = null;
  if (drillPlan?.dataset && dataMode === "real") {
    try {
      const drillMetrics =
        drillPlan.dataset === "207512"
          ? DATASET_207512_METRICS
          : DATASET_103846_METRICS;

      const drillResult = await fetchDatasetQuery({
        datasetId: drillPlan.dataset,
        metrics: drillMetrics,
        filters: {
          ...filters,
          __time: dateRange.target,
        },
        limit: 100,
      });

      drillData = drillResult;
    } catch (err) {
      console.warn(`[下钻查询 ${drillPlan.dataset} 失败]`, err.message);
    }
  }

  // ─── 渲染结果 ───
  const payload = {
    metric,
    mainDataset: datasetInfo.mainDataset,
    datasetLabel: datasetInfo.label,
    compare: datasetInfo.compare,
    drillDataset: drillPlan?.dataset || "",
    filtersText: formatFilters(filters),
    displayDimensions: Object.keys(filters).length ? Object.keys(filters).join(" / ") : "无",
    conclusion: buildConclusion(metric, drillPlan),
    nextStep: drillPlan
      ? `读取 ${drillPlan.file}，方向：${drillPlan.direction}`
      : "继续按主漏斗链路定位第一个异常指标",
    drillQuery,
    mainData,
    drillData,
    dataMode,
  };

  renderResult(payload);

  // 更新状态卡片
  document.getElementById("statMainDataset").textContent = payload.mainDataset;
  document.getElementById("statDrillDataset").textContent = payload.drillDataset || "暂不下钻";

  // 更新状态标记
  const badge = document.querySelector(".status-badge");
  if (badge) {
    badge.textContent = dataMode === "real" ? "数据模式" : "口径模式";
    badge.className = `status-badge ${dataMode === "real" ? "badge-live" : ""}`;
  }

  // 保存历史
  saveHistory({
    question: form.question,
    metric: payload.metric,
    mainDataset: payload.mainDataset,
    drillDataset: payload.drillDataset,
    dataMode: payload.dataMode,
    time: new Date().toLocaleString("zh-CN"),
    form,
  });
}

function build207512Query(filters) {
  return {
    datasetId: "207512",
    dimensions: Object.keys(filters).length ? Object.keys(filters) : ["无额外展示维度"],
    metrics: DATASET_207512_METRICS,
    filters: formatFilters(filters),
    note: "过滤占比 = 当前行 ad_request_num / 全部行 ad_request_num 之和",
  };
}

function build103846Query(filters) {
  return {
    datasetId: "103846",
    metrics: DATASET_103846_METRICS,
    filters: formatFilters(filters),
    note: "按阶段计算通过率，定位异常漏斗阶段",
  };
}

/* ═══════════════════════════════════════════════════
 *  事件绑定
 * ═══════════════════════════════════════════════════ */

document.getElementById("generateBtn").addEventListener("click", generateDiagnosis);
document.getElementById("resetBtn").addEventListener("click", resetForm);
document.getElementById("clearHistoryBtn").addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  updateQueryCount();
  renderHistory();
});

document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

document.querySelectorAll(".chip[data-example]").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.getElementById("question").value = chip.dataset.example;
    generateDiagnosis();
  });
});

updateQueryCount();
renderHistory();
initMobileNav();

// ─── Cookie 配置面板 ───
async function initCookiePanel() {
  const input = document.getElementById("kwabiCookieInput");
  const saveBtn = document.getElementById("kwabiCookieSave");
  const testBtn = document.getElementById("kwabiCookieTest");
  const status = document.getElementById("kwabiCookieStatus");

  // 启动时查询服务端 Cookie 状态
  try {
    const resp = await fetch(`${API_BASE}/api/cookie/status`);
    const result = await resp.json();
    if (result.success && result.data?.serverConfigured) {
      status.textContent = "服务端已就绪 ✓";
      status.className = "cookie-status ok";
    } else {
      status.textContent = "服务端未配置";
      status.className = "cookie-status err";
    }
  } catch {
    status.textContent = "状态未知";
    status.className = "cookie-status";
  }

  // 回显已存 Cookie（用户自己配置过的）
  const saved = getKwabiCookie();
  if (saved) {
    input.value = saved;
    // 用户自己配过，显示"个人覆盖"
    status.textContent = "使用个人 Cookie";
    status.className = "cookie-status ok";
  }

  saveBtn.addEventListener("click", () => {
    const val = input.value.trim();
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

  testBtn.addEventListener("click", async () => {
    const val = input.value.trim();
    if (val) {
      setKwabiCookie(val);
    }
    status.textContent = "验证中…";
    status.className = "cookie-status";

    try {
      const data = await fetchDatasetQuery({
        datasetId: "85587",
        metrics: ["联盟总消耗"],
        filters: { __time: { start: "2025-06-28", end: "2025-06-29" } },
        limit: 1,
      });
      status.textContent = val ? "个人 Cookie 验证通过 ✓" : "服务端 Cookie 验证通过 ✓";
      status.className = "cookie-status ok";
      status.style.fontWeight = "";
      clearCookieExpired();
    } catch (err) {
      status.textContent = `验证失败: ${err.message}`;
      status.className = "cookie-status err";
    }
  });
}

initCookiePanel();

if (document.documentElement.classList.contains("github-ui")) {
  switchView("home");
}
