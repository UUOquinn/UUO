/**
 * 首页 — GitHub 风格统一聊天入口 + 三块运行日志
 * 根据用户选择的功能或输入内容路由到策略能力模块
 */

const HOME_FEATURE_PLACEHOLDERS = {
  auto: "问我任何问题… 例如：广告位ID 5118002323，或 延期 13938",
  "strategy-query": "例如：广告位ID 5118002323，或 开发者ID 12345",
  "strategy-audit": "例如：审核 13938，或直接输入策略 ID",
  "strategy-renewal": "例如：延期 13938 14619",
};

const FUNNEL_HISTORY_KEY = "alliance-funnel-history";
const HOME_LOG_POLL_MS = 30000;
const HOME_AUDIT_CACHE_KEY = "alliance-home-audit-log";
const HOME_POSTPONE_CACHE_KEY = "alliance-home-postpone-log";

const HOME_API_PROBES = [
  {
    key: "cookie",
    path: "/api/cookie/status",
    okIf: (resp, body) => {
      if (!resp?.ok || !body?.success) return false;
      const d = body.data || {};
      return !!(d.playwrightReady || d.chromeHasCookie || d.serverConfigured);
    },
    detailIf: (ok, resp, body, ms) => {
      if (!ok) {
        const d = body?.data || {};
        return d.hint || body?.message || body?.error || `HTTP ${resp?.status || "?"}`;
      }
      return `${ms}ms`;
    },
  },
  {
    key: "health",
    path: "/api/health",
    okIf: (resp, body) => !!(resp?.ok && body?.success !== false && body?.data),
    detailIf: (ok, resp, body, ms) => {
      if (!ok) return body?.message || body?.error || `HTTP ${resp?.status || "?"}`;
      const d = body?.data || {};
      if (d.ssoWaiting) return `${ms}ms · SSO等待`;
      if (d.queueDepth > 0) return `${ms}ms · 队列${d.queueDepth}`;
      return `${ms}ms`;
    },
  },
  {
    key: "audit",
    path: "/api/strategy/audit/auto-approve/status",
    okIf: (resp, body) => !!(resp?.ok && body?.success),
    detailIf: (ok, resp, body, ms) => {
      if (!ok) return body?.message || body?.error || `HTTP ${resp?.status || "?"}`;
      return `${ms}ms`;
    },
  },
  {
    key: "postpone",
    path: "/api/strategy/postpone/status",
    okIf: (resp, body) => !!(resp?.ok && body?.success),
    detailIf: (ok, resp, body, ms) => {
      if (!ok) return body?.message || body?.error || `HTTP ${resp?.status || "?"}`;
      return `${ms}ms`;
    },
  },
];

let homeApiProbeInflight = null;
const HOME_LOG_KEEP_DAYS = 30;

const HOME_FEATURE_LABELS = {
  "strategy-query": "查询",
  "strategy-audit": "审核",
  "strategy-renewal": "延期",
  auto: "首页",
};

const HOME_API_BASE = window.__API_BASE__ || "";
const HOME_ERROR_DISMISSED_KEY = "alliance-home-error-dismissed";

let homeLogPollTimer = null;
let homeLogsBound = false;
let auditLogInflight = null;
let postponeLogInflight = null;
let queryLogInflight = null;
let errorLogInflight = null;
let homeLogPrefetchStarted = false;
let auditLogLines = [];
let postponeLogLines = [];
let postponeRawLogLines = [];
let postponeLastResult = null;
let errorLogLines = [];
let errorLogItems = [];
let queryLogItems = [];
let queryLogLoaded = false;
let errorLogLoaded = false;
let auditSearchQuery = "";
let postponeSearchQuery = "";
let querySearchQuery = "";
let errorSearchQuery = "";

function formatErrorCaptureTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getHomeOperator() {
  try {
    return (
      (localStorage.getItem("postpone-operator") || "").trim() ||
      (localStorage.getItem("shield-plat-operator") || "").trim()
    );
  } catch {
    return "";
  }
}

function postponeOperatorHeader() {
  const h = {};
  const op = getHomeOperator();
  if (op) h["X-Postpone-Operator"] = op;
  return h;
}

function formatSharedLogLine(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  const text = String(item.text || "").trim();
  if (!text) return "";
  const op = String(item.operator || "").trim();
  if (!op) return text;
  const m = text.match(/^(\[[\d\-:\s]+\])\s*(.*)$/);
  if (m) return `${m[1]} [${op}] ${m[2]}`;
  return `[${op}] ${text}`;
}

/** 白名单审核日志：空巡回不展示；术语译成中文；补齐可读字段 */
const AUDIT_MODE_LABELS = {
  normal: "普通审核",
  ban: "封禁期审核",
  publish_replay: "发布补跑",
  "normal+replay": "普通+同轮补跑",
  stuck_publish: "发布卡单补跑",
  stuck_push: "推全补跑",
};

function isAuditEmptyCreatorNoise(line) {
  const body = stripHomeLogTs(line);
  return /无待处理策略/.test(body);
}

function humanizeAuditOperator(op) {
  const key = String(op || "").trim();
  if (!key) return "";
  if (key === "system:auto-approve") return "自动审核";
  return key;
}

function humanizeAuditModeToken(mode) {
  const key = String(mode || "").trim();
  return AUDIT_MODE_LABELS[key] || key;
}

/**
 * 把历史/新日志统一成可读行。
 * 例：自动审核 · ✓ #24059「名称」 · 流程=普通审核 · 提交人=x · 审核单=n · 审核/发布：都过 · 立即推全：是
 */
function formatAuditDisplayLine(line) {
  let raw = String(line || "").trim();
  if (!raw) return "";

  let ts = "";
  let op = "";
  let body = raw;

  let m = body.match(/^(\[[\d\-:\s]+\])\s*(.*)$/);
  if (m) {
    ts = m[1];
    body = m[2];
  }
  m = body.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (m) {
    op = humanizeAuditOperator(m[1]);
    body = m[2];
  }

  // 旧格式：user [mode] ...
  body = body.replace(
    /^(\S+)\s*\[(normal|ban|publish_replay|normal\+replay|stuck_publish|stuck_push)\]\s*/i,
    (_, user, mode) => `${user} · ${humanizeAuditModeToken(mode)} · `
  );
  // 旧格式：#id [mode]
  body = body.replace(
    /#(\d+)\s*\[(normal|ban|publish_replay|normal\+replay|stuck_publish|stuck_push)\]/gi,
    (_, id, mode) => `#${id} · 流程=${humanizeAuditModeToken(mode)}`
  );
  // 兜底：残留英文模式码
  body = body.replace(
    /\[(normal|ban|publish_replay|normal\+replay|stuck_publish|stuck_push)\]/gi,
    (_, mode) => `流程=${humanizeAuditModeToken(mode)}`
  );

  const parts = [];
  if (ts) parts.push(ts);
  if (op) parts.push(op);
  parts.push(body.trim());
  return parts.join(" · ").replace(/\s·\s·\s/g, " · ");
}

function buildAuditDisplayLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => !isAuditEmptyCreatorNoise(line))
    .map(formatAuditDisplayLine)
    .filter(Boolean);
}

async function fetchJson(path, opts) {
  const resp = await fetch(`${HOME_API_BASE}${path}`, opts);
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}

async function postWorkbenchLog(type, text, meta) {
  const body = String(text || "").trim();
  if (!body) return null;
  try {
    const { json } = await fetchJson("/api/workbench/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...postponeOperatorHeader(),
      },
      body: JSON.stringify({
        type,
        text: body,
        meta: meta && typeof meta === "object" ? meta : {},
        operator: getHomeOperator(),
      }),
    });
    if (!json?.success) return null;
    return json.data || null;
  } catch {
    return null;
  }
}

async function fetchWorkbenchLogs(type, limit) {
  const lim = limit || 500;
  const { json } = await fetchJson(`/api/workbench/logs?type=${encodeURIComponent(type)}&limit=${lim}`);
  if (!json?.success) {
    throw new Error(json?.message || json?.error || "加载失败");
  }
  const items = Array.isArray(json?.data?.items) ? json.data.items : [];
  return items;
}

function collectFreshErrorDetails() {
  const fresh = [];
  const push = (text) => {
    if (text) fresh.push(text);
  };
  auditLogLines.forEach((line) => push(extractAuditFailureDetail(line)));
  postponeRawLogLines.forEach((line) => push(extractPostponeFailureDetail(line)));
  failuresFromPostponeResult(postponeLastResult).forEach(push);
  return fresh;
}

function readDismissedErrorFps() {
  try {
    const raw = localStorage.getItem(HOME_ERROR_DISMISSED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function writeDismissedErrorFps(set) {
  try {
    localStorage.setItem(
      HOME_ERROR_DISMISSED_KEY,
      JSON.stringify(Array.from(set || []).slice(-800))
    );
  } catch {
    /* ignore */
  }
}

/** 已滚出实时日志的失败指纹可解除忽略，便于再次失败时重新记入 */
function syncDismissedErrorFps(liveFps) {
  const live = liveFps instanceof Set ? liveFps : new Set(liveFps || []);
  const dismissed = readDismissedErrorFps();
  let changed = false;
  dismissed.forEach((fp) => {
    if (!live.has(fp)) {
      dismissed.delete(fp);
      changed = true;
    }
  });
  if (changed) writeDismissedErrorFps(dismissed);
  return dismissed;
}

function errorItemFingerprint(item) {
  if (!item) return "";
  if (item.meta && item.meta.fp) return String(item.meta.fp).trim();
  return stripHomeLogTs(item.text || "");
}

let errorIngestInflight = null;

/** 新失败写入共享库（全员可见，最长 30 天） */
async function ingestErrorDetails(details) {
  // 串行化：轮询并发时避免同一失败被 POST 多遍
  if (errorIngestInflight) {
    await errorIngestInflight;
  }
  const run = (async () => {
    const list = Array.isArray(details)
      ? details.filter((d) => d && !isFalsePositiveErrorLine(d))
      : [];
    const liveSet = new Set(list);
    const dismissed = syncDismissedErrorFps(liveSet);
    if (!list.length) return false;

    const seen = new Set(
      errorLogItems
        .map((e) => errorItemFingerprint(e))
        .filter(Boolean)
    );
    let added = 0;
    const now = Date.now();
    const stamp = formatErrorCaptureTime(now);

    for (const detail of list) {
      const fp = String(detail).trim();
      if (!fp || seen.has(fp) || dismissed.has(fp)) continue;
      seen.add(fp);
      const text = `[${stamp}] ${fp}`;
      const ok = await postWorkbenchLog("error", text, { fp });
      if (ok) {
        errorLogItems.unshift(ok);
        added += 1;
      }
    }

    if (added) {
      errorLogLines = errorLogItems.map(formatSharedLogLine).filter(Boolean).reverse();
      renderErrorLogBody();
    }
    return added > 0;
  })();

  errorIngestInflight = run.finally(() => {
    if (errorIngestInflight === run) errorIngestInflight = null;
  });
  return errorIngestInflight;
}

async function clearErrorLogs() {
  const count = errorLogItems.length || errorLogLines.length;
  const live = collectFreshErrorDetails();
  const dismissed = readDismissedErrorFps();
  live.forEach((fp) => dismissed.add(fp));
  errorLogItems.forEach((item) => {
    const fp = errorItemFingerprint(item);
    if (fp) dismissed.add(fp);
  });
  writeDismissedErrorFps(dismissed);

  try {
    const { json } = await fetchJson("/api/workbench/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...postponeOperatorHeader(),
      },
      body: JSON.stringify({ type: "error", action: "clear" }),
    });
    if (!json?.success) {
      throw new Error(json?.message || json?.error || "清空失败");
    }
  } catch (err) {
    window.alert(`清空失败：${err.message || err}`);
    return false;
  }

  // 清掉旧版本机缓存（若仍残留）
  try {
    localStorage.removeItem("alliance-home-error-log");
  } catch {
    /* ignore */
  }

  errorLogItems = [];
  errorLogLines = [];
  errorSearchQuery = "";
  const errorSearch = document.getElementById("homeErrorLogSearch");
  if (errorSearch) errorSearch.value = "";
  renderErrorLogBody();
  return true;
}

function clearErrorViewOnly() {
  errorSearchQuery = "";
  const errorSearch = document.getElementById("homeErrorLogSearch");
  if (errorSearch) errorSearch.value = "";
  renderErrorLogBody();
}

function stripHomeLogTs(line) {
  return String(line || "")
    .replace(/^\[[\d\-:\s]+\]\s*/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
}

function isHomeErrorNoise(body) {
  return /本轮完成|扫描完成|无待处理策略|守护线程已启动|上一次自动延期仍在执行|开始扫描|托管表无|拉取详情|提审…|封禁期同意发布需确认|封禁期需确认发布|不入卡单/.test(
    body
  );
}

/** 已入库但不应再展示的误报（封禁期确认弹窗等） */
function isFalsePositiveErrorLine(line) {
  const body = stripHomeLogTs(line);
  if (!body) return true;
  if (/封禁期/.test(body) && /是否确认|需要进行人工审核/.test(body)) return true;
  return false;
}

/** 从审核日志抽出：功能 + 策略ID + 详情；非失败明细返回 null */
function extractAuditFailureDetail(line) {
  const body = stripHomeLogTs(line);
  if (!body || isHomeErrorNoise(body) || isAuditEmptyCreatorNoise(body)) return null;

  // 新格式：✗ #id「name」 ... 原因=...
  let m = body.match(/[✗✖]\s*#(\d+)(?:「[^」]*」)?[^\n]*?(?:原因[=：]|发布失败[:：]|失败[:：])\s*(.+)$/i);
  if (m) {
    const detail = (m[2] || "").trim() || "失败";
    // 封禁期「是否确认」是确认弹窗，不是真正发布失败
    if (/是否确认|需要进行人工审核/.test(detail) && /封禁期/.test(detail)) {
      return null;
    }
    let kind = "失败";
    if (/反查审核记录失败/.test(body)) kind = "反查审核记录失败";
    else if (/发布失败/.test(body)) kind = "发布失败";
    else if (/立即推全：失败/.test(body)) kind = "推全失败";
    return `审核 · 策略ID ${m[1]} · ${kind} · ${detail}`;
  }

  m = body.match(/[✗✖]\s*#(\d+)\s*\[([^\]]+)\]\s*(?:反查审核记录失败|发布失败|失败)[:：]?\s*(.*)$/i);
  if (m) {
    const detail = (m[3] || "").trim() || "失败";
    let kind = m[2];
    if (/反查审核记录失败/.test(body)) kind = "反查审核记录失败";
    else if (/发布失败/.test(body)) kind = "发布失败";
    return `审核 · 策略ID ${m[1]} · ${kind} · ${detail}`;
  }

  m = body.match(/#(\d+)\s*\[([^\]]+)\].*推全失败[:：]?\s*(.*)$/);
  if (m) {
    const detail = (m[3] || "").trim() || "推全失败";
    return `审核 · 策略ID ${m[1]} · 推全失败 · ${detail}`;
  }

  // 推全跳过不算失败明细（避免首页红区误报）
  if (/推全跳过|立即推全：否/.test(body) && !/[✗✖]/.test(body)) return null;

  m = body.match(/^(\S+)\s*(?:·\s*)?(?:\[([^\]]+)\]|普通审核|封禁期审核|发布补跑)?[^\n]*查询失败[:：]?\s*(.*)$/);
  if (m && /查询失败/.test(body)) {
    const detail = (m[3] || "").trim() || "查询失败";
    return `审核 · 查询失败 · ${m[1]} · ${detail}`;
  }

  m = body.match(/^(\S+)\s*\[([^\]]+)\]\s*查询返回非200[:：]?\s*(.*)$/);
  if (m) {
    const detail = (m[3] || "").trim() || body;
    return `审核 · 查询异常 · ${m[1]} [${m[2]}] · ${detail}`;
  }

  return null;
}

/** 从延期日志抽出失败明细 */
function extractPostponeFailureDetail(line) {
  const body = stripHomeLogTs(line);
  if (!body || isHomeErrorNoise(body)) return null;

  if (/自动延期异常|守护线程异常/.test(body)) {
    return `延期 · ${body}`;
  }

  const m = body.match(/策略\s*#(\d+).{0,40}?(?:失败|错误)[:：]?\s*(.*)$/);
  if (m) {
    const detail = (m[2] || "").trim() || "失败";
    return `延期 · 策略ID ${m[1]} · ${detail}`;
  }

  return null;
}

function failuresFromPostponeResult(lastResult) {
  if (!lastResult || !Array.isArray(lastResult.results)) return [];
  return lastResult.results
    .filter((r) => r && String(r.status) === "失败")
    .map((r) => {
      const id = r.strategy_id ?? r.strategyId ?? "?";
      const reason = String(r.reason || "失败").trim();
      return `延期 · 策略ID ${id} · ${reason}`;
    });
}

/** 托管延期面板只展示汇总：成功 / 未到期 / 失败 */
function formatPostponeSummaryText(stats) {
  const success = Number(stats?.success) || 0;
  const notDue = Number(stats?.notDue ?? stats?.not_due) || 0;
  const failed = Number(stats?.failed) || 0;
  const skipped = Number(stats?.skipped) || 0;
  const total =
    Number(stats?.total) ||
    success + notDue + failed + skipped;
  let text = `成功 ${success} 条 · 未到期 ${notDue} 条 · 失败 ${failed} 条`;
  if (skipped > 0) text += ` · 其他 ${skipped} 条`;
  text += ` · 共 ${total} 条`;
  return text;
}

function parsePostponeScanSummary(body) {
  const m = String(body || "").match(
    /成功\s*(\d+)\s*\/\s*失败\s*(\d+)\s*\/\s*未到期\s*(\d+)(?:\s*\/\s*其他\s*(\d+))?（共\s*(\d+)）/
  );
  if (!m) return null;
  return {
    success: Number(m[1]) || 0,
    failed: Number(m[2]) || 0,
    notDue: Number(m[3]) || 0,
    skipped: Number(m[4]) || 0,
    total: Number(m[5]) || 0,
  };
}

function buildPostponeSummaryLines(logLines, lastResult) {
  const lines = [];
  const seen = new Set();

  const pushLine = (text) => {
    const t = String(text || "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    lines.push(t);
  };

  (Array.isArray(logLines) ? logLines : []).forEach((raw) => {
    const full = String(raw || "");
    const body = stripHomeLogTs(full);
    const tsMatch = full.match(/^\[([^\]]+)\]/);
    const ts = tsMatch ? tsMatch[1] : "";
    const withTs = (msg) => (ts ? `[${ts}] ${msg}` : msg);

    if (/扫描完成/.test(body)) {
      const stats = parsePostponeScanSummary(body);
      pushLine(withTs(stats ? formatPostponeSummaryText(stats) : body.replace(/^扫描完成：?/, "").trim()));
      return;
    }
    if (/托管表无 enabled/.test(body)) {
      pushLine(withTs(formatPostponeSummaryText({ success: 0, notDue: 0, failed: 0, total: 0 }) + "（无托管策略）"));
      return;
    }
    if (/自动延期异常|守护线程异常/.test(body)) {
      pushLine(withTs(`异常 · ${body}`));
    }
  });

  if (
    lastResult &&
    !lastResult.error &&
    (lastResult.success != null ||
      lastResult.failed != null ||
      lastResult.notDue != null ||
      lastResult.total != null)
  ) {
    const summary = formatPostponeSummaryText(lastResult);
    const already = lines.some((line) => stripHomeLogTs(line) === summary);
    if (!already) pushLine(summary);
  } else if (lastResult?.error) {
    pushLine(`异常 · ${lastResult.error}`);
  }

  return lines;
}

function getSelectedFeature() {
  const el = document.getElementById("homeFeatureSelect");
  const feature = el?.dataset.feature || "auto";
  return feature === "auto" ? null : feature;
}

function detectHomeIntent(text) {
  const t = messageTrim(text);
  if (!t) return null;

  if (/延期|到期|顺延|mergeEdit/i.test(t)) {
    return "strategy-renewal";
  }



  if (/审核|通过|驳回|发布|撤回/.test(t) && /\d{3,}/.test(t)) {
    return "strategy-audit";
  }

  if (/开发者\s*ID|广告位\s*ID|应用\s*ID|pos[_\s-]*id[：:\s]*\d|app[_\s-]*id[：:\s]*\d|\buid[：:\s]*\d/i.test(t)) {
    return "strategy-query";
  }

  if (/^\d{4,}(\s+\d{4,})*$/.test(t)) {
    return "strategy-query";
  }

  if (/^\d{3,}$/.test(t)) {
    return "strategy-audit";
  }

  return "strategy-query";
}

function messageTrim(text) {
  return (text || "").trim();
}

function escHome(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isHomeViewActive() {
  return document.querySelector(".nav-item.active[data-view]")?.dataset.view === "home";
}

function routeFromHome(message) {
  const text = messageTrim(message);
  if (!text) return;

  const target = getSelectedFeature() || detectHomeIntent(text);
  if (!target || typeof window.switchView !== "function") return;

  recordFunnelHistory(text, target);
  window.switchView(target);

  window.setTimeout(() => {
    const inputMap = {
      "strategy-query": "strategyChatInput",
      "strategy-audit": "auditChatInput",
      "strategy-renewal": "renewalChatInput",
    };
    const sendMap = {
      "strategy-query": "strategyChatSend",
      "strategy-audit": "auditChatSend",
      "strategy-renewal": "renewalChatSend",
    };

    const input = document.getElementById(inputMap[target]);
    const sendBtn = document.getElementById(sendMap[target]);
    if (!input) return;


    input.value = text;
    if (target === "strategy-query" && typeof window.sendStrategyQuery === "function") {
      window.sendStrategyQuery(text);
      return;
    }
    sendBtn?.click();
  }, 60);
}

function setHomeFeature(feature, label) {
  const select = document.getElementById("homeFeatureSelect");
  const labelEl = document.getElementById("homeFeatureLabel");
  const input = document.getElementById("homeChatInput");
  if (!select || !labelEl) return;

  select.dataset.feature = feature;
  labelEl.textContent = label;

  document.querySelectorAll(".gh-home-feature-option").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.feature === feature);
  });

  if (input && HOME_FEATURE_PLACEHOLDERS[feature]) {
    input.placeholder = HOME_FEATURE_PLACEHOLDERS[feature];
  }
}

function closeFeatureMenu() {
  const select = document.getElementById("homeFeatureSelect");
  const menu = document.getElementById("homeFeatureMenu");
  if (!select || !menu) return;
  menu.hidden = true;
  select.setAttribute("aria-expanded", "false");
}

function toggleFeatureMenu() {
  const select = document.getElementById("homeFeatureSelect");
  const menu = document.getElementById("homeFeatureMenu");
  if (!select || !menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  select.setAttribute("aria-expanded", open ? "true" : "false");
}

function initHomeFeatureSelect() {
  const select = document.getElementById("homeFeatureSelect");
  const menu = document.getElementById("homeFeatureMenu");
  if (!select || !menu) return;

  select.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFeatureMenu();
  });

  select.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleFeatureMenu();
    } else if (e.key === "Escape") {
      closeFeatureMenu();
    }
  });

  menu.querySelectorAll(".gh-home-feature-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setHomeFeature(btn.dataset.feature, btn.dataset.label);
      closeFeatureMenu();
      document.getElementById("homeChatInput")?.focus();
    });
  });

  document.addEventListener("click", (e) => {
    if (!select.contains(e.target) && !menu.contains(e.target)) {
      closeFeatureMenu();
    }
  });
}

/* ─── 查询日志（共享服务端，最长 30 天） ─── */

function loadFunnelHistoryLocal() {
  try {
    const raw = localStorage.getItem(FUNNEL_HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveFunnelHistoryLocal(list) {
  try {
    localStorage.setItem(FUNNEL_HISTORY_KEY, JSON.stringify((list || []).slice(0, 50)));
  } catch {
    /* quota / private mode */
  }
}

function formatHistoryTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYday) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function queryItemsForRender() {
  if (queryLogLoaded) {
    return queryLogItems.map((item) => ({
      text: item.text,
      feature: (item.meta && item.meta.feature) || "strategy-query",
      at: item.ts || Date.now(),
      operator: item.operator || "",
    }));
  }
  return loadFunnelHistoryLocal();
}

function renderQueryLog() {
  const listEl = document.getElementById("homeQueryLogList");
  const pill = document.getElementById("homeQueryLogPill");
  if (!listEl) return;

  const list = queryItemsForRender();
  const q = querySearchQuery.trim().toLowerCase();
  const filtered = !q
    ? list
    : list.filter((item) => {
        const text = String(item.text || "").toLowerCase();
        const tag = HOME_FEATURE_LABELS[item.feature] || "";
        const op = String(item.operator || "").toLowerCase();
        return text.includes(q) || tag.toLowerCase().includes(q) || op.includes(q);
      });

  if (pill) {
    pill.textContent = q
      ? `匹配 ${filtered.length}/${list.length}`
      : `共享 · ${list.length} · ${HOME_LOG_KEEP_DAYS}天`;
  }

  if (!list.length) {
    listEl.innerHTML = `<li class="gh-home-query-empty">暂无查询记录。在首页或各模块发送后会出现在这里（全员共享，保留 ${HOME_LOG_KEEP_DAYS} 天）。</li>`;
    return;
  }

  if (!filtered.length) {
    listEl.innerHTML = `<li class="gh-home-query-empty">没有匹配「${escHome(querySearchQuery.trim())}」的记录</li>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((item) => {
      const feature = item.feature || "strategy-query";
      const tag = HOME_FEATURE_LABELS[feature] || "查询";
      const op = String(item.operator || "").trim();
      const opHtml = op
        ? `<span class="gh-home-query-op" title="操作人">${escHome(op)}</span>`
        : "";
      return `<li class="gh-home-query-item" role="button" tabindex="0" data-text="${escHome(item.text)}" data-feature="${escHome(feature)}">
        <span class="gh-home-query-main">
          <span class="gh-home-query-tag">${escHome(tag)}</span>
          ${opHtml}
          <span class="gh-home-query-text">${escHome(item.text)}</span>
        </span>
        <time class="gh-home-query-time">${escHome(formatHistoryTime(item.at))}</time>
      </li>`;
    })
    .join("");
}

async function loadQueryHomeLog(opts) {
  const force = !!(opts && opts.force);
  if (!force && queryLogInflight) return queryLogInflight;

  const run = (async () => {
    try {
      const items = await fetchWorkbenchLogs("query", 500);
      queryLogItems = items;
      queryLogLoaded = true;
      renderQueryLog();
    } catch {
      if (!queryLogLoaded) renderQueryLog();
    } finally {
      if (queryLogInflight === run) queryLogInflight = null;
    }
  })();

  queryLogInflight = run;
  return run;
}

async function recordFunnelHistory(text, feature) {
  const t = messageTrim(text);
  if (!t) return;

  const feat = feature || "strategy-query";
  const top = queryItemsForRender()[0];
  if (top && top.text === t && Date.now() - (top.at || 0) < 60000) {
    return;
  }

  const local = loadFunnelHistoryLocal();
  local.unshift({ text: t, feature: feat, at: Date.now() });
  saveFunnelHistoryLocal(local);

  await postWorkbenchLog("query", t, { feature: feat });
  await loadQueryHomeLog({ force: true });
  if (document.getElementById("homeQueryLogList")) {
    renderQueryLog();
  }
}

function clearFunnelHistoryView() {
  querySearchQuery = "";
  const querySearch = document.getElementById("homeQueryLogSearch");
  if (querySearch) querySearch.value = "";
  renderQueryLog();
}

function replayQueryHistory(text, feature) {
  const t = messageTrim(text);
  if (!t) return;
  const target = feature || detectHomeIntent(t) || "strategy-query";
  if (typeof window.switchView !== "function") return;

  window.switchView(target);
  window.setTimeout(() => {
    const inputMap = {
      "strategy-query": "strategyChatInput",
      "strategy-audit": "auditChatInput",
      "strategy-renewal": "renewalChatInput",
    };
    const sendMap = {
      "strategy-query": "strategyChatSend",
      "strategy-audit": "auditChatSend",
      "strategy-renewal": "renewalChatSend",
    };
    const input = document.getElementById(inputMap[target]);
    const sendBtn = document.getElementById(sendMap[target]);
    if (!input) return;
    input.value = t;
    if (target === "strategy-query" && typeof window.sendStrategyQuery === "function") {
      window.sendStrategyQuery(t);
      return;
    }
    sendBtn?.click();
  }, 60);
}

/* ─── 审核 / 延期 / 错误日志（共享 API） ─── */

function formatInterval(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 86400) return `${Math.round(n / 86400)}天`;
  if (n >= 3600) return `${Math.round(n / 3600)}h`;
  if (n >= 60) return `${Math.round(n / 60)}min`;
  return `${n}s`;
}

function readHomeLogCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function writeHomeLogCache(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* quota / private mode */
  }
}

function logBodyText(lines, emptyText) {
  const arr = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!arr.length) return emptyText || "（暂无日志）";
  return arr.slice().reverse().join("\n");
}

function setLogBody(el, lines, emptyText) {
  if (!el) return;
  const next = logBodyText(lines, emptyText);
  if (el.textContent === next) return;
  el.textContent = next;
}

function setPillText(pill, text, busy) {
  if (!pill) return;
  if (pill.textContent !== text) pill.textContent = text;
  pill.classList.toggle("is-busy", !!busy);
}

function filterLogLines(lines, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return Array.isArray(lines) ? lines : [];
  return (Array.isArray(lines) ? lines : []).filter((line) =>
    String(line || "").toLowerCase().includes(q)
  );
}

function rebuildErrorLogLines() {
  ingestErrorDetails(collectFreshErrorDetails());
  renderErrorLogBody();
}

function renderErrorLogBody() {
  const body = document.getElementById("homeErrorLogBody");
  const pill = document.getElementById("homeErrorLogPill");
  const visible = errorLogLines.filter((line) => !isFalsePositiveErrorLine(line));
  const filtered = filterLogLines(visible, errorSearchQuery);
  if (pill) pill.textContent = String(filtered.length);
  const empty = errorSearchQuery.trim()
    ? `（无匹配「${errorSearchQuery.trim()}」）`
    : `暂无失败或错误记录（全员共享 · 点「清空」可删除）`;
  setLogBody(body, filtered, empty);
}

function renderAuditLogBody() {
  const body = document.getElementById("homeAuditLogBody");
  const filtered = filterLogLines(
    buildAuditDisplayLines(auditLogLines),
    auditSearchQuery
  );
  const empty = auditSearchQuery.trim()
    ? `（无匹配「${auditSearchQuery.trim()}」）`
    : "（暂无有策略的审核记录：名下无待审时不展示空巡回）";
  setLogBody(body, filtered, empty);
}

function renderPostponeLogBody() {
  const body = document.getElementById("homePostponeLogBody");
  const filtered = filterLogLines(postponeLogLines, postponeSearchQuery);
  const empty = postponeSearchQuery.trim()
    ? `（无匹配「${postponeSearchQuery.trim()}」）`
    : "（暂无延期汇总：等待下一轮扫描）";
  setLogBody(body, filtered, empty);
}

function applyAuditLogView(data) {
  const pill = document.getElementById("homeAuditLogPill");
  if (!data) return;
  const interval = formatInterval(data.interval);
  setPillText(
    pill,
    data.running
      ? `执行中${interval ? ` · ${interval}` : ""}`
      : `空闲${interval ? ` · ${interval}` : ""}`,
    !!data.running
  );
  auditLogLines = Array.isArray(data.log) ? data.log.slice() : [];
  renderAuditLogBody();
  rebuildErrorLogLines();
}

function applyPostponeLogView(data) {
  const pill = document.getElementById("homePostponeLogPill");
  if (!data) return;
  const interval =
    formatInterval(data.interval) ||
    (data.intervalDays != null ? `${data.intervalDays}天` : "");
  postponeRawLogLines = Array.isArray(data.log) ? data.log.slice() : [];
  postponeLastResult = data.lastResult || null;
  postponeLogLines = buildPostponeSummaryLines(postponeRawLogLines, postponeLastResult);

  const parts = [];
  if (data.running) parts.push("执行中");
  else if (data.started) parts.push("已启动");
  else parts.push("未启动");
  if (interval) parts.push(interval);
  if (
    postponeLastResult &&
    !postponeLastResult.error &&
    (postponeLastResult.success != null || postponeLastResult.failed != null)
  ) {
    const s = Number(postponeLastResult.success) || 0;
    const f = Number(postponeLastResult.failed) || 0;
    const n = Number(postponeLastResult.notDue ?? postponeLastResult.not_due) || 0;
    parts.push(`成功${s}/未到期${n}/失败${f}`);
  }
  setPillText(pill, parts.join(" · "), !!data.running);
  renderPostponeLogBody();
  rebuildErrorLogLines();
}

function paintHomeLogCache() {
  const audit = readHomeLogCache(HOME_AUDIT_CACHE_KEY);
  const postpone = readHomeLogCache(HOME_POSTPONE_CACHE_KEY);
  if (audit) applyAuditLogView(audit);
  if (postpone) applyPostponeLogView(postpone);
  return { audit: !!audit, postpone: !!postpone };
}

function slimAuditCache(data) {
  return {
    running: !!data.running,
    interval: data.interval,
    log: Array.isArray(data.log) ? data.log.slice(-200) : [],
  };
}

function slimPostponeCache(data) {
  const lr = data?.lastResult || null;
  const failResults = Array.isArray(lr?.results)
    ? lr.results.filter((r) => r && String(r.status) === "失败").slice(-40)
    : [];
  const summary =
    lr && !lr.error
      ? {
          success: Number(lr.success) || 0,
          failed: Number(lr.failed) || 0,
          notDue: Number(lr.notDue ?? lr.not_due) || 0,
          skipped: Number(lr.skipped) || 0,
          total: Number(lr.total) || 0,
          results: failResults,
        }
      : lr?.error
        ? { error: lr.error, results: failResults }
        : failResults.length
          ? { results: failResults }
          : null;
  return {
    running: !!data.running,
    started: !!data.started,
    interval: data.interval,
    intervalDays: data.intervalDays,
    log: Array.isArray(data.log) ? data.log.slice(-200) : [],
    lastResult: summary,
  };
}

function hasLogPanelContent(id) {
  const el = document.getElementById(id);
  const t = (el?.textContent || "").trim();
  return t && t !== "加载中…";
}

function paintHomeApiRow(row, result) {
  if (!row) return;
  row.classList.remove("is-pending", "is-ok", "is-err");
  row.classList.add(result.ok ? "is-ok" : "is-err");
  const state = row.querySelector(".gh-home-api-state");
  if (state) {
    state.textContent = result.ok
      ? `正常 · ${result.detail}`
      : `异常 · ${result.detail}`;
    state.title = result.detail || "";
  }
}

async function probeHomeApiOne(probe) {
  const started = performance.now();
  try {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(`${HOME_API_BASE}${probe.path}`, {
      method: "GET",
      credentials: "include",
      signal: ctrl.signal,
      headers: postponeOperatorHeader(),
    });
    clearTimeout(kill);
    const ms = Math.round(performance.now() - started);
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    const ok = typeof probe.okIf === "function"
      ? !!probe.okIf(resp, body)
      : !!(resp.ok && body && body.success !== false);
    const detail = typeof probe.detailIf === "function"
      ? probe.detailIf(ok, resp, body, ms)
      : ok
        ? `${ms}ms`
        : body?.message || body?.error || `HTTP ${resp.status}`;
    return { key: probe.key, ok, detail: String(detail || "") };
  } catch (err) {
    return {
      key: probe.key,
      ok: false,
      detail: err?.name === "AbortError" ? "超时" : "网络异常",
    };
  }
}

async function loadHomeApiStatus(opts) {
  const force = !!(opts && opts.force);
  if (!force && homeApiProbeInflight) return homeApiProbeInflight;
  if (!document.getElementById("homeApiStatusBody")) return null;

  const run = (async () => {
    const body = document.getElementById("homeApiStatusBody");
    const pill = document.getElementById("homeApiStatusPill");
    const updated = document.getElementById("homeApiStatusUpdated");
    body?.querySelectorAll(".gh-home-api-row").forEach((row) => {
      row.classList.remove("is-ok", "is-err");
      row.classList.add("is-pending");
      const state = row.querySelector(".gh-home-api-state");
      if (state) state.textContent = "检测中…";
    });

    try {
      const results = [];
      for (const probe of HOME_API_PROBES) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await probeHomeApiOne(probe));
      }
      results.forEach((result) => {
        const row = body?.querySelector(`.gh-home-api-row[data-key="${result.key}"]`);
        paintHomeApiRow(row, result);
      });
      const okCount = results.filter((r) => r.ok).length;
      setPillText(pill, `${okCount}/${results.length} 正常`, okCount < results.length);
      if (updated) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        updated.textContent = `更新于 ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      }
    } catch {
      setPillText(pill, "不可用", false);
      if (updated) updated.textContent = "探测失败";
    } finally {
      if (homeApiProbeInflight === run) homeApiProbeInflight = null;
    }
  })();

  homeApiProbeInflight = run;
  return run;
}

async function loadErrorHomeLog(opts) {
  const force = !!(opts && opts.force);
  if (!force && errorLogInflight) return errorLogInflight;

  const run = (async () => {
    try {
      const items = await fetchWorkbenchLogs("error", 500);
      errorLogItems = items;
      errorLogLoaded = true;
      errorLogLines = items.map(formatSharedLogLine).filter(Boolean).reverse();
      renderErrorLogBody();
    } catch {
      renderErrorLogBody();
    } finally {
      if (errorLogInflight === run) errorLogInflight = null;
    }
  })();

  errorLogInflight = run;
  return run;
}

async function loadAuditHomeLog(opts) {
  const force = !!(opts && opts.force);
  const body = document.getElementById("homeAuditLogBody");
  const pill = document.getElementById("homeAuditLogPill");

  if (!force && auditLogInflight) return auditLogInflight;

  if (!hasLogPanelContent("homeAuditLogBody") && body) {
    body.textContent = "加载中…";
  }

  const run = (async () => {
    try {
      const [statusRes, logsRes] = await Promise.all([
        fetchJson("/api/strategy/audit/auto-approve/status"),
        fetchJson("/api/workbench/logs?type=audit&limit=500"),
      ]);
      const data = statusRes.json?.data || {};
      if (!statusRes.json?.success) {
        throw new Error(statusRes.json?.message || statusRes.json?.error || "加载失败");
      }
      let logLines = Array.isArray(data.log) ? data.log.slice() : [];
      if (logsRes.json?.success && Array.isArray(logsRes.json?.data?.items)) {
        // API 最新在前；转成最旧在前，配合 logBodyText reverse 后最新置顶
        logLines = logsRes.json.data.items
          .map(formatSharedLogLine)
          .filter(Boolean)
          .reverse();
      }
      const slim = slimAuditCache({ ...data, log: logLines });
      writeHomeLogCache(HOME_AUDIT_CACHE_KEY, slim);
      applyAuditLogView(slim);
    } catch (err) {
      if (!hasLogPanelContent("homeAuditLogBody") || (body?.textContent || "").startsWith("加载")) {
        setPillText(pill, "不可用", false);
        if (body) body.textContent = `加载失败：${err.message || err}`;
      }
    } finally {
      if (auditLogInflight === run) auditLogInflight = null;
    }
  })();

  auditLogInflight = run;
  return run;
}

async function loadPostponeHomeLog(opts) {
  const force = !!(opts && opts.force);
  const body = document.getElementById("homePostponeLogBody");
  const pill = document.getElementById("homePostponeLogPill");

  if (!force && postponeLogInflight) return postponeLogInflight;

  if (!hasLogPanelContent("homePostponeLogBody") && body) {
    body.textContent = "加载中…";
  }

  const run = (async () => {
    try {
      const [statusRes, logsRes] = await Promise.all([
        fetchJson("/api/strategy/postpone/status", {
          headers: postponeOperatorHeader(),
        }),
        fetchJson("/api/workbench/logs?type=postpone&limit=500"),
      ]);
      const data = statusRes.json?.data || {};
      if (!statusRes.json?.success) {
        throw new Error(statusRes.json?.message || statusRes.json?.error || "加载失败");
      }
      let logLines = Array.isArray(data.log) ? data.log.slice() : [];
      if (logsRes.json?.success && Array.isArray(logsRes.json?.data?.items)) {
        // API 最新在前；转成最旧在前，配合 logBodyText reverse 后最新置顶
        logLines = logsRes.json.data.items
          .map(formatSharedLogLine)
          .filter(Boolean)
          .reverse();
      }
      const slim = slimPostponeCache({ ...data, log: logLines });
      writeHomeLogCache(HOME_POSTPONE_CACHE_KEY, slim);
      applyPostponeLogView(slim);
    } catch (err) {
      if (!hasLogPanelContent("homePostponeLogBody") || (body?.textContent || "").startsWith("加载")) {
        setPillText(pill, "不可用", false);
        if (body) body.textContent = `加载失败：${err.message || err}`;
      }
    } finally {
      if (postponeLogInflight === run) postponeLogInflight = null;
    }
  })();

  postponeLogInflight = run;
  return run;
}

function refreshHomeLogs(opts) {
  renderQueryLog();
  paintHomeLogCache();
  loadQueryHomeLog(opts);
  loadErrorHomeLog(opts);
  loadAuditHomeLog(opts);
  loadPostponeHomeLog(opts);
  loadHomeApiStatus(opts);
}

/** 脚本一加载就开始预取，抢在 UI 绑定之前 */
function prefetchHomeLogsEarly() {
  if (homeLogPrefetchStarted) return;
  homeLogPrefetchStarted = true;
  paintHomeLogCache();
  loadQueryHomeLog();
  loadErrorHomeLog();
  loadAuditHomeLog();
  loadPostponeHomeLog();
  loadHomeApiStatus();
}

function startHomeLogPoll() {
  stopHomeLogPoll();
  homeLogPollTimer = window.setInterval(() => {
    if (!isHomeViewActive()) {
      stopHomeLogPoll();
      return;
    }
    loadQueryHomeLog();
    loadErrorHomeLog();
    loadAuditHomeLog();
    loadPostponeHomeLog();
    loadHomeApiStatus();
  }, HOME_LOG_POLL_MS);
}

function stopHomeLogPoll() {
  if (homeLogPollTimer) {
    window.clearInterval(homeLogPollTimer);
    homeLogPollTimer = null;
  }
}

function bindHomeLogsOnce() {
  if (homeLogsBound) return;
  homeLogsBound = true;

  document.getElementById("homeApiStatusRefresh")?.addEventListener("click", () => {
    loadHomeApiStatus({ force: true });
  });
  document.getElementById("homeAuditLogRefresh")?.addEventListener("click", () => {
    loadAuditHomeLog({ force: true });
  });
  document.getElementById("homePostponeLogRefresh")?.addEventListener("click", () => {
    loadPostponeHomeLog({ force: true });
  });
  document.getElementById("homeQueryLogClear")?.addEventListener("click", () => {
    clearFunnelHistoryView();
  });

  const auditSearch = document.getElementById("homeAuditLogSearch");
  const postponeSearch = document.getElementById("homePostponeLogSearch");
  const querySearch = document.getElementById("homeQueryLogSearch");
  const errorSearch = document.getElementById("homeErrorLogSearch");

  auditSearch?.addEventListener("input", () => {
    auditSearchQuery = auditSearch.value || "";
    renderAuditLogBody();
  });
  postponeSearch?.addEventListener("input", () => {
    postponeSearchQuery = postponeSearch.value || "";
    renderPostponeLogBody();
  });
  querySearch?.addEventListener("input", () => {
    querySearchQuery = querySearch.value || "";
    renderQueryLog();
  });
  errorSearch?.addEventListener("input", () => {
    errorSearchQuery = errorSearch.value || "";
    renderErrorLogBody();
  });

  document.getElementById("homeErrorLogClear")?.addEventListener("click", async () => {
    const count = errorLogItems.length || errorLogLines.length;
    if (!count) {
      clearErrorViewOnly();
      return;
    }
    const ok = window.confirm(
      `确定清空全部 ${count} 条失败/错误记录？\n（共享日志会删除，当前仍在运行日志里的旧失败不会立刻重新写入）`
    );
    if (!ok) return;
    const btn = document.getElementById("homeErrorLogClear");
    if (btn) btn.disabled = true;
    try {
      await clearErrorLogs();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("homeQueryLogList")?.addEventListener("click", (e) => {
    const item = e.target.closest(".gh-home-query-item");
    if (!item) return;
    replayQueryHistory(item.dataset.text, item.dataset.feature);
  });

  document.getElementById("homeQueryLogList")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const item = e.target.closest(".gh-home-query-item");
    if (!item) return;
    e.preventDefault();
    replayQueryHistory(item.dataset.text, item.dataset.feature);
  });
}

function initHomePage() {
  if (!document.documentElement.classList.contains("github-ui")) return;
  if (!document.getElementById("homeLogs")) return;

  bindHomeLogsOnce();
  renderErrorLogBody();
  renderQueryLog();
  paintHomeLogCache();

  // app.js 在 home.js 之前就可能 switchView("home")，这里补一次日志拉取
  if (isHomeViewActive()) {
    refreshHomeLogs();
    startHomeLogPoll();
  }
}

window.recordFunnelHistory = recordFunnelHistory;

window.onHomeViewEnter = function onHomeViewEnter() {
  refreshHomeLogs();
  startHomeLogPoll();
};

// 尽早预取：不增加轮询频率，只把首包请求提前
prefetchHomeLogsEarly();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHomePage);
} else {
  initHomePage();
}
