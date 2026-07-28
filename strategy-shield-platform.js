/* ═══════════════════════════════════════════════════════
 *  定向屏蔽（平台角度）
 *  - 路由表 / 工单解析（追加维度 + 映射策略）/ 待提审 / 执行记录
 *  - 仅追加 appid/uid/posid，不修改策略其他信息
 *  - 编译任务 → 预览 → mergeEditV2 提审
 * ═══════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const API_BASE = window.__API_BASE__ || "";
  const INDUSTRY_VERSION = "6.6";
  const STORAGE_ROUTES = "shield-platform-routes-v1";
  const STORAGE_LOG = "shield-platform-exec-log-v1";
  /** 本地兜底最多条数 */
  const EXEC_LOG_MAX = 500;
  /** 与共享库一致：最长保留 30 天 */
  const EXEC_LOG_KEEP_DAYS = 30;
  let sharedExecLogItems = null;
  let execLogInflight = null;
  const STORAGE_CATALOG = "shield-platform-catalog-v2";
  const STORAGE_OPERATOR = "shield-plat-operator";
  /** 仅这些人可改策略目录（ID/名称） */
  const CATALOG_EDITORS = ["wb_wuqingyun03", "wuqingyun03", "wqy"];
  const TYPE_LABELS = {
    1: "暗投策略",
    3: "扶持策略",
    5: "标签屏蔽",
    7: "新屏蔽（屏蔽的广告信息并集生效）",
    9: "新联盟明暗投",
  };
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

  const MEDIA_DIM_KEYS = {
    appId: "appId",
    uid: "uid",
    posId: "posId",
  };

  const DIM_LABELS = {
    appId: "appid",
    uid: "uid",
    posId: "posid",
  };

  /** @type {null | object} */
  let pendingSubmit = null;
  /** @type {Set<string>} */
  let selectedStrategyIds = new Set();
  /** ② 追加表单：维度/行业；已选策略以 selectedStrategyIds 为准 */
  let appendForm = {
    dim: "appId",
    industry: "",
  };
  /** 执行记录弹窗筛选 */
  let execLogFilter = "all";
  let execLogQuery = "";

  function inferAppendDim(name) {
    const n = String(name || "");
    if (/posid|pos维度|\bpos\b|广告位/i.test(n)) return "posId";
    if (/\buid\b|UID维度|开发者-/i.test(n)) return "uid";
    if (/appid|APPID|app维度|\bAPP\b|应用/i.test(n)) return "appId";
    return "appId";
  }

  /** 名称里的 uid/appid/pos 标记已由 appendDim 字段区分，展示时去掉 */
  function stripDimFromName(name) {
    let n = String(name || "").trim();
    n = n.replace(/^(?:APP\s*ID|APPID|UID|POS\s*ID|POSID|POS)\s*[-_－]\s*/i, "");
    n = n.replace(
      /[（(]\s*(?:APP\s*ID|APPID|UID|POS\s*ID|POSID|POS|APP)\s*(?:维度)?\s*[）)]?/gi,
      ""
    );
    n = n.replace(/[-_－]?\s*(?:app|posid|uid|APPID|POSID|UID)\s*维度/gi, "");
    n = n.replace(
      /[-_＿]\s*(?:APP\s*ID|APPID|UID|POS\s*ID|POSID|POS|APP)(?=\s*[-_＿]|$)/gi,
      ""
    );
    n = n.replace(
      /(?<=[】\]）)])\s*(?:APP\s*ID|APPID|UID|POS\s*ID|POSID|POS|APP)\b/gi,
      ""
    );
    n = n.replace(
      /(?<=[\u4e00-\u9fffA-Za-z0-9])(?:APP\s*ID|APPID|UID|POS\s*ID|POSID)(?=\s*[-_＿]|$)/gi,
      ""
    );
    n = n.replace(
      /(?<=[）)])\s*(?:APP\s*ID|APPID|UID|POS\s*ID|POSID|POS|APP)(?=\s*[-_＿]|$)/gi,
      ""
    );
    n = n.replace(/【\s*$/, "").replace(/[（(]\s*$/, "");
    n = n.replace(/[-_＿]{2,}/g, "-");
    n = n.replace(/^[-_＿\s]+|[-_＿\s]+$/g, "");
    n = n.replace(/[（(]\s*[）)]/g, "");
    n = n.replace(/\s{2,}/g, " ").trim();
    n = n.replace(/[-_＿]+(?=新$)/, "-");
    return n;
  }

  function normalizeCatalogItem(it) {
    const rawName = String(it?.name || "").trim();
    const appendDim = MEDIA_DIM_KEYS[it?.appendDim]
      ? it.appendDim
      : inferAppendDim(rawName);
    return {
      id: String(it?.id || "").trim(),
      name: stripDimFromName(rawName),
      appendDim,
    };
  }

  function normalizeOperator(v) {
    return String(v || "")
      .trim()
      .toLowerCase()
      .replace(/^wb_/, "");
  }

  function getOperator() {
    return (
      localStorage.getItem(STORAGE_OPERATOR) ||
      localStorage.getItem("postpone-operator") ||
      ""
    ).trim();
  }

  function canEditCatalog(operatorOverride) {
    const op = normalizeOperator(
      operatorOverride != null ? operatorOverride : getOperator()
    );
    if (!op) return false;
    return CATALOG_EDITORS.some((e) => normalizeOperator(e) === op);
  }

  function seedCatalog() {
    const seed = window.__SHIELD_PLAT_CATALOG_SEED__;
    if (!Array.isArray(seed)) return [];
    return seed.map((g) => ({
      group: String(g.group || "未分组"),
      items: (g.items || []).map((it) => normalizeCatalogItem(it)),
    }));
  }

  function loadCatalog() {
    try {
      const raw = localStorage.getItem(STORAGE_CATALOG);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.map((g) => ({
            group: String(g.group || "未分组"),
            items: (g.items || []).map((it) => normalizeCatalogItem(it)),
          }));
        }
      }
    } catch (_) {
      /* ignore */
    }
    const seeded = seedCatalog();
    saveCatalog(seeded);
    return seeded;
  }

  function saveCatalog(list) {
    localStorage.setItem(STORAGE_CATALOG, JSON.stringify(list || []));
  }

  function flatCatalogItems(catalog) {
    const out = [];
    (catalog || []).forEach((g) => {
      (g.items || []).forEach((it) => {
        if (it && it.id) out.push({ ...it, group: g.group });
      });
    });
    return out;
  }

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
    if (!raw || typeof raw !== "object") throw new Error("GET 策略详情返回为空");
    if (raw.adCluster != null || raw.mediaCluster != null || raw.type != null) return raw;
    if (raw.data && typeof raw.data === "object") {
      const inner = raw.data;
      if (inner.adCluster != null || inner.mediaCluster != null || inner.type != null) return inner;
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
    // Orient mergeEditV2 要求 background 非空；GET 常不返回
    const bg = typeof body.background === "string" ? body.background.trim() : "";
    if (!bg) {
      const name = typeof detail.name === "string" ? detail.name.trim() : "";
      body.background = name || (detail.id != null ? `策略${detail.id}延期续期` : "延期续期");
    }
    return body;
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function tokenizeIds(text) {
    return String(text || "")
      .split(/[\s,，;；|、]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{3,}$/.test(s));
  }

  function splitIdList(raw) {
    return String(raw || "")
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function mergeIds(existingRaw, toAdd) {
    const oldList = splitIdList(existingRaw);
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

  function normText(s) {
    return String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function uid() {
    return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /* ─── 路由表 localStorage ─── */

  function loadRoutes() {
    try {
      const raw = localStorage.getItem(STORAGE_ROUTES);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function saveRoutes(list) {
    localStorage.setItem(STORAGE_ROUTES, JSON.stringify(list || []));
  }

  function loadExecLogLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_LOG);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return pruneExecLog(list);
    } catch (_) {
      return [];
    }
  }

  function entryTs(entry) {
    const n = Number(entry && entry.at);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(entry && entry.time);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function pruneExecLog(list) {
    const cutoff = Date.now() - EXEC_LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    const kept = (list || [])
      .filter((e) => {
        const ts = entryTs(e);
        return !ts || ts >= cutoff;
      })
      .slice(0, EXEC_LOG_MAX);
    return kept;
  }

  function saveExecLogLocal(list) {
    localStorage.setItem(
      STORAGE_LOG,
      JSON.stringify(pruneExecLog(list || []).slice(0, EXEC_LOG_MAX))
    );
  }

  function entryFromSharedItem(item) {
    const meta = (item && item.meta) || {};
    return {
      ok: !!meta.ok,
      time: meta.time || "",
      strategyId: meta.strategyId || "",
      strategyName: meta.strategyName || "",
      appendDim: meta.appendDim || "",
      added: meta.added || 0,
      addedIds: Array.isArray(meta.addedIds) ? meta.addedIds : [],
      message: meta.message || item.text || "",
      at: item.ts || Date.now(),
      operator: item.operator || "",
    };
  }

  function loadExecLog() {
    if (Array.isArray(sharedExecLogItems)) {
      return sharedExecLogItems.map(entryFromSharedItem);
    }
    return loadExecLogLocal();
  }

  async function fetchSharedExecLog() {
    if (execLogInflight) return execLogInflight;
    const run = (async () => {
      try {
        const resp = await fetch(
          `${API_BASE}/api/workbench/logs?type=shield&limit=500`
        );
        const json = await resp.json().catch(() => ({}));
        if (!json?.success) throw new Error(json?.error || "load failed");
        sharedExecLogItems = Array.isArray(json?.data?.items)
          ? json.data.items
          : [];
        renderExecLog();
      } catch (_) {
        if (!Array.isArray(sharedExecLogItems)) sharedExecLogItems = null;
        renderExecLog();
      } finally {
        if (execLogInflight === run) execLogInflight = null;
      }
    })();
    execLogInflight = run;
    return run;
  }

  function formatShieldLogText(entry) {
    const status = entry.ok ? "成功" : "失败";
    const name = entry.strategyName || "（无名称）";
    const dim = entry.appendDim || "?";
    const msg = entry.message ? ` · ${entry.message}` : "";
    return `${status} · 策略 ${entry.strategyId || ""} ${name} · ${dim}${msg}`;
  }

  async function pushExecLog(entry) {
    const full = {
      ...entry,
      at: entry.at || Date.now(),
    };
    const local = loadExecLogLocal();
    local.unshift(full);
    saveExecLogLocal(local);

    const op = getOperator();
    const headers = { "Content-Type": "application/json" };
    if (op) headers["X-Postpone-Operator"] = op;
    try {
      await fetch(`${API_BASE}/api/workbench/logs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "shield",
          text: formatShieldLogText(full),
          operator: op,
          meta: {
            ok: !!full.ok,
            time: full.time || "",
            strategyId: full.strategyId || "",
            strategyName: full.strategyName || "",
            appendDim: full.appendDim || "",
            added: full.added || 0,
            addedIds: Array.isArray(full.addedIds) ? full.addedIds : [],
            message: full.message || "",
          },
        }),
      });
    } catch (_) {
      /* local already saved */
    }
    await fetchSharedExecLog();
  }

  function clearExecLogView() {
    /* 共享库不提供全员清空；仅刷新展示 */
    fetchSharedExecLog();
  }

  function typeLabel(type) {
    const n = Number(type);
    if (TYPE_LABELS[n]) return `${TYPE_LABELS[n]}（type=${n}）`;
    if (Number.isFinite(n)) return `类型 ${n}`;
    return "未知类型";
  }

  /* ─── 工单解析 ─── */

  /**
   * 支持：
   * 1) 表头行：uid,appid,posid,屏蔽行业,产品名称
   * 2) 无表头：行业\t产品\tappid,appid 或 行业,产品,appid
   */
  function parseTicketText(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return [];

    const splitLine = (line) => {
      if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
      // 逗号分隔但注意 ID 列表里也有逗号：优先按「前两列文本 + 其余」不够稳
      // 用正则：若像 CSV 表头或固定 5 列则按逗号；否则尝试 | / ；
      if (line.includes("|")) return line.split("|").map((c) => c.trim());
      if (line.includes("；")) return line.split("；").map((c) => c.trim());
      return line.split(",").map((c) => c.trim());
    };

    const firstCells = splitLine(lines[0]).map((c) => c.toLowerCase());
    const headerMap = {
      uid: firstCells.findIndex((c) => /^(uid|开发者id|开发者)$/.test(c)),
      appid: firstCells.findIndex((c) => /^(appid|app_id|应用id|应用)$/.test(c)),
      posid: firstCells.findIndex((c) => /^(posid|pos_id|广告位id|广告位)$/.test(c)),
      industry: firstCells.findIndex((c) => /^(屏蔽行业|行业|industry)$/.test(c)),
      product: firstCells.findIndex((c) => /^(产品名称|产品|product)$/.test(c)),
    };
    const hasHeader =
      headerMap.industry >= 0 ||
      headerMap.appid >= 0 ||
      headerMap.uid >= 0 ||
      headerMap.posid >= 0;

    const rows = [];
    const start = hasHeader ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      const cells = splitLine(lines[i]);
      let row;
      if (hasHeader) {
        row = {
          uid: headerMap.uid >= 0 ? cells[headerMap.uid] || "" : "",
          appid: headerMap.appid >= 0 ? cells[headerMap.appid] || "" : "",
          posid: headerMap.posid >= 0 ? cells[headerMap.posid] || "" : "",
          industry: headerMap.industry >= 0 ? cells[headerMap.industry] || "" : "",
          product: headerMap.product >= 0 ? cells[headerMap.product] || "" : "",
        };
      } else if (cells.length >= 3) {
        // 行业, 产品, ids…
        row = {
          industry: cells[0] || "",
          product: cells[1] || "",
          appid: cells.slice(2).join(","),
          uid: "",
          posid: "",
        };
      } else {
        continue;
      }
      rows.push({
        ...row,
        line: i + 1,
        raw: lines[i],
      });
    }
    return rows;
  }

  function pickRoute(routes, industry, product) {
    const ind = normText(industry);
    const prod = normText(product);
    if (!ind) return null;
    const enabled = routes.filter((r) => r.enabled !== false);
    // 精确：行业+产品
    if (prod) {
      const exact = enabled.find(
        (r) => normText(r.industry) === ind && normText(r.product) === prod
      );
      if (exact) return exact;
    }
    // 行业兜底（产品名为空）
    const industryOnly = enabled.find(
      (r) => normText(r.industry) === ind && !normText(r.product)
    );
    return industryOnly || null;
  }

  function idsForDim(row, dim) {
    if (dim === "appId") return tokenizeIds(row.appid);
    if (dim === "uid") return tokenizeIds(row.uid);
    if (dim === "posId") return tokenizeIds(row.posid);
    return [];
  }

  function collectIdPools(ticketRows) {
    const appId = new Set();
    const uid = new Set();
    const posId = new Set();
    for (const row of ticketRows) {
      tokenizeIds(row.appid).forEach((id) => appId.add(id));
      tokenizeIds(row.uid).forEach((id) => uid.add(id));
      tokenizeIds(row.posid).forEach((id) => posId.add(id));
    }
    return {
      appId: [...appId],
      uid: [...uid],
      posId: [...posId],
    };
  }

  function itemAppendDim(item) {
    return MEDIA_DIM_KEYS[item.appendDim]
      ? item.appendDim
      : inferAppendDim(item.name);
  }

  function catalogGroups() {
    return loadCatalog().map((g) => String(g.group || "未分组"));
  }

  function strategiesForAppend(opts) {
    const dim = (opts && opts.dim) || appendForm.dim;
    const industryExact = String(
      (opts && opts.industry != null ? opts.industry : appendForm.industry) || ""
    ).trim();
    const industrySoft = String(
      $("shieldPlatIndustrySearch")?.value || industryExact || ""
    ).trim();
    const q = String((opts && opts.q) || "")
      .trim()
      .toLowerCase();
    return flatCatalogItems(loadCatalog()).filter((it) => {
      if (itemAppendDim(it) !== dim) return false;
      const group = String(it.group || "");
      if (industryExact) {
        if (group !== industryExact) return false;
      } else if (industrySoft) {
        if (!group.toLowerCase().includes(industrySoft.toLowerCase())) {
          return false;
        }
      }
      if (!q) return true;
      return (
        String(it.id).includes(q) ||
        String(it.name).toLowerCase().includes(q) ||
        group.toLowerCase().includes(q)
      );
    });
  }

  function resolveFromCatalog(ticketRows, selectedItems) {
    const pools = collectIdPools(ticketRows);
    const tasks = [];
    const unresolved = [];
    if (!ticketRows.length) {
      return { tasks, unresolved };
    }
    if (!selectedItems.length) {
      return { tasks, unresolved, needSelect: true };
    }

    const anyIds = pools.appId.length + pools.uid.length + pools.posId.length;
    if (!anyIds) {
      unresolved.push({
        line: "-",
        industry: "—",
        product: "—",
        reason: "工单中没有可追加的 uid / appid / posid",
      });
      return { tasks, unresolved };
    }

    for (const item of selectedItems) {
      const dim = MEDIA_DIM_KEYS[item.appendDim]
        ? item.appendDim
        : inferAppendDim(item.name);
      const ids = pools[dim] || [];
      if (!ids.length) {
        unresolved.push({
          line: "-",
          industry: item.name,
          product: item.id,
          reason: `策略需要 ${dim}，工单未提供该维 ID`,
        });
        continue;
      }
      tasks.push({
        strategyId: String(item.id),
        strategyName: item.name,
        appendDim: dim,
        ids,
        ticketCount: ticketRows.length,
        industry: item.group || "策略目录",
        product: item.name,
        routeId: `catalog:${item.id}`,
      });
    }
    return { tasks, unresolved };
  }

  function resolveTickets(ticketRows, routes) {
    const catalog = loadCatalog();
    const selectedItems = flatCatalogItems(catalog).filter((it) =>
      selectedStrategyIds.has(String(it.id))
    );

    // 优先：右侧勾选策略目录 → 工单 ID 映射进这些策略
    if (selectedItems.length) {
      return resolveFromCatalog(ticketRows, selectedItems);
    }

    /** @type {Map<string, { strategyId: string, appendDim: string, ids: Set<string>, sources: object[], route: object, strategyName?: string }>} */
    const byStrategy = new Map();
    const unresolved = [];
    const catalogById = new Map(
      flatCatalogItems(catalog).map((it) => [String(it.id), it])
    );

    for (const row of ticketRows) {
      const route = pickRoute(routes, row.industry, row.product);
      if (!route) {
        unresolved.push({
          ...row,
          reason: "未勾选右侧策略，且无匹配路由（请勾选策略目录或配置路由）",
        });
        continue;
      }
      const dim = MEDIA_DIM_KEYS[route.appendDim] ? route.appendDim : "appId";
      const ids = idsForDim(row, dim);
      if (!ids.length) {
        const any =
          tokenizeIds(row.appid).length ||
          tokenizeIds(row.uid).length ||
          tokenizeIds(row.posid).length;
        unresolved.push({
          ...row,
          reason: any
            ? `路由要求追加 ${dim}，但本行该维无有效 ID`
            : "uid/appid/posid 均为空",
        });
        continue;
      }

      const key = `${route.strategyId}::${dim}`;
      if (!byStrategy.has(key)) {
        const cat = catalogById.get(String(route.strategyId));
        byStrategy.set(key, {
          strategyId: String(route.strategyId),
          strategyName: cat?.name || "",
          appendDim: dim,
          ids: new Set(),
          sources: [],
          route,
        });
      }
      const task = byStrategy.get(key);
      ids.forEach((id) => task.ids.add(id));
      task.sources.push(row);
    }

    const tasks = [...byStrategy.values()].map((t) => ({
      strategyId: t.strategyId,
      strategyName: t.strategyName || "",
      appendDim: t.appendDim,
      ids: [...t.ids],
      ticketCount: t.sources.length,
      industry: t.route.industry,
      product: t.route.product || "（整行业）",
      routeId: t.route.id,
    }));

    return { tasks, unresolved };
  }

  /* ─── DOM ─── */

  const $ = (id) => document.getElementById(id);

  function renderRoutes() {
    const tbody = $("shieldPlatRouteBody");
    if (!tbody) return;
    const routes = loadRoutes();
    if (!routes.length) {
      tbody.innerHTML =
        '<tr class="shield-plat-empty-row"><td colspan="6">暂无路由，先在上方添加一条</td></tr>';
      return;
    }
    tbody.innerHTML = routes
      .map((r) => {
        const on = r.enabled !== false;
        return `<tr data-id="${escHtml(r.id)}">
          <td>${escHtml(r.industry)}</td>
          <td>${escHtml(r.product || "—")}</td>
          <td><code>${escHtml(r.strategyId)}</code></td>
          <td>${escHtml(r.appendDim || "appId")}</td>
          <td>${on ? '<span class="shield-plat-tag is-on">启用</span>' : '<span class="shield-plat-tag is-off">停用</span>'}</td>
          <td class="shield-plat-actions">
            <button type="button" class="btn-sm" data-act="toggle">${on ? "停用" : "启用"}</button>
            <button type="button" class="btn-sm" data-act="del">删除</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  function execLogMatch(e, q, filter) {
    if (filter === "ok" && !e.ok) return false;
    if (filter === "err" && e.ok) return false;
    if (!q) return true;
    const ids = Array.isArray(e.addedIds)
      ? e.addedIds
      : Array.isArray(e.ids)
        ? e.ids
        : [];
    const hay = [
      e.time,
      e.operator,
      e.strategyId,
      e.strategyName,
      e.appendDim,
      e.message,
      ids.join(" "),
      e.ok ? "成功" : "失败",
    ]
      .map((x) => String(x || "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  }

  function renderExecLog() {
    const el = $("shieldPlatExecLog");
    const list = loadExecLog();
    const q = String(execLogQuery || "")
      .trim()
      .toLowerCase();
    const filtered = list.filter((e) => execLogMatch(e, q, execLogFilter));

    const meta = $("shieldPlatExecLogMeta");
    const modalMeta = $("shieldPlatExecLogModalMeta");
    const summary = $("shieldPlatExecLogSummary");
    const metaText = list.length
      ? `共 ${list.length} 条 · 全员共享 · 保留约 ${EXEC_LOG_KEEP_DAYS} 天`
      : `暂无记录 · 全员共享 · 保留约 ${EXEC_LOG_KEEP_DAYS} 天`;
    if (meta) meta.textContent = metaText;
    if (modalMeta) {
      modalMeta.textContent = list.length
        ? `共 ${list.length} 条` +
          (filtered.length !== list.length
            ? ` · 当前显示 ${filtered.length} 条`
            : "") +
          ` · 全员共享 · 保留约 ${EXEC_LOG_KEEP_DAYS} 天`
        : metaText;
    }
    if (summary) {
      summary.textContent = list.length
        ? `${list.length} 条记录 · 点击打开 · 支持搜索`
        : "暂无记录 · 点击打开";
    }

    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p class="shield-plat-muted">暂无执行记录</p>';
      return;
    }
    if (!filtered.length) {
      el.innerHTML = '<p class="shield-plat-muted">无匹配记录</p>';
      return;
    }
    el.innerHTML = filtered
      .map((e) => {
        const ok = e.ok ? "ok" : "err";
        const dim = e.appendDim || "?";
        const ids = Array.isArray(e.addedIds)
          ? e.addedIds
          : Array.isArray(e.ids)
            ? e.ids
            : [];
        const idText = ids.length
          ? ids.join(", ")
          : e.added
            ? `${e.added}个(旧记录无明细)`
            : "—";
        const name = e.strategyName || "（无名称）";
        const status = e.ok ? "成功" : "失败";
        const op = String(e.operator || "").trim();
        return `<article class="shield-plat-log-card is-${ok}">
          <header class="shield-plat-log-card-head">
            <span class="shield-plat-log-badge">${status}</span>
            <span class="shield-plat-log-time">${escHtml(e.time || "")}</span>
            ${
              op
                ? `<span class="shield-plat-log-op">${escHtml(op)}</span>`
                : ""
            }
            <span class="shield-plat-tag">${escHtml(dim)}</span>
          </header>
          <div class="shield-plat-log-card-body">
            <div class="shield-plat-log-card-title">
              <code>${escHtml(e.strategyId || "")}</code>
              <span>${escHtml(name)}</span>
            </div>
            <div class="shield-plat-log-card-ids"><span>追加 ID</span><code>${escHtml(
              idText
            )}</code></div>
            ${
              e.message
                ? `<p class="shield-plat-log-msg">${escHtml(e.message)}</p>`
                : ""
            }
          </div>
        </article>`;
      })
      .join("");
  }

  function openExecLogModal() {
    const modal = $("shieldPlatExecLogModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    fetchSharedExecLog();
    const search = $("shieldPlatExecLogSearch");
    if (search) {
      search.value = execLogQuery;
      setTimeout(() => search.focus(), 0);
    }
  }

  function closeExecLogModal() {
    const modal = $("shieldPlatExecLogModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  function renderCatalog() {
    const body = $("shieldPlatCatalogBody");
    const state = $("shieldPlatEditState");
    const opInput = $("shieldPlatOperatorInput");
    if (opInput && !opInput.value) opInput.value = getOperator();
    const editable = canEditCatalog(opInput?.value || getOperator());
    if (state) {
      state.textContent = editable ? "可编辑" : "只读";
      state.className = `shield-plat-tag ${editable ? "is-on" : "is-off"}`;
    }
    if (!body) return;

    const q = String($("shieldPlatCatalogSearch")?.value || "")
      .trim()
      .toLowerCase();
    const catalog = loadCatalog();
    const focusDim = appendForm.dim;
    const hasSel = selectedStrategyIds.size > 0;
    let html = "";
    let shown = 0;
    catalog.forEach((g, gi) => {
      const items = (g.items || []).filter((it) => {
        if (!q) return true;
        return (
          String(it.id).includes(q) ||
          String(it.name).toLowerCase().includes(q) ||
          String(g.group || "")
            .toLowerCase()
            .includes(q)
        );
      });
      if (!items.length) return;
      shown += items.length;
      html += `<div class="shield-plat-cat-group" data-gi="${gi}">
        <div class="shield-plat-cat-group-head">
          <strong title="${escHtml(g.group)}">${escHtml(g.group)}</strong>
          <span class="shield-plat-cat-count">${items.length}</span>
          <button type="button" class="btn-sm" data-act="select-group">选用本组</button>
        </div>`;
      items.forEach((it) => {
        const id = String(it.id);
        const checked = selectedStrategyIds.has(id) ? "checked" : "";
        const dim = itemAppendDim(it);
        const dimLabel = DIM_LABELS[dim] || dim;
        const selected = selectedStrategyIds.has(id);
        const dimMiss = hasSel ? dim !== focusDim : false;
        const rowClass = [
          "shield-plat-cat-row",
          selected ? "is-selected" : "",
          dimMiss ? "is-dim-miss" : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (editable) {
          html += `<label class="${rowClass}" data-id="${escHtml(id)}" data-gi="${gi}" data-dim="${escHtml(dim)}">
            <input class="shield-plat-cat-check-input" type="checkbox" data-act="toggle-sel" ${checked} aria-label="选择策略 ${escHtml(id)}">
            <input class="shield-plat-cat-id" data-field="id" value="${escHtml(id)}" title="可编辑：策略ID" aria-label="策略ID">
            <input class="shield-plat-cat-name" data-field="name" value="${escHtml(it.name)}" title="可编辑：${escHtml(it.name)}" aria-label="策略名称">
            <span class="shield-plat-cat-dim" title="追加维">${escHtml(dimLabel)}</span>
          </label>`;
        } else {
          html += `<label class="${rowClass}" data-id="${escHtml(id)}" data-gi="${gi}" data-dim="${escHtml(dim)}">
            <input class="shield-plat-cat-check-input" type="checkbox" data-act="toggle-sel" ${checked} aria-label="选择策略 ${escHtml(id)}">
            <code class="shield-plat-cat-id-ro" title="${escHtml(id)}">${escHtml(id)}</code>
            <span class="shield-plat-cat-name-ro" title="${escHtml(it.name)}">${escHtml(it.name)}</span>
            <span class="shield-plat-cat-dim" title="追加维">${escHtml(dimLabel)}</span>
          </label>`;
        }
      });
      html += "</div>";
    });
    if (!html) {
      body.innerHTML = '<p class="shield-plat-muted">无匹配策略</p>';
      return;
    }
    body.innerHTML =
      `<p class="shield-plat-cat-result">显示 ${shown} 条` +
      (hasSel ? ` · 已选 ${selectedStrategyIds.size}` : "") +
      `</p>` +
      html;
  }

  function hideSuggest(el) {
    if (!el) return;
    el.hidden = true;
    el.innerHTML = "";
  }

  function selectedCatalogItems() {
    const byId = new Map(
      flatCatalogItems(loadCatalog()).map((it) => [String(it.id), it])
    );
    return [...selectedStrategyIds]
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
  }

  function pruneSelectedToDim(dim) {
    const keep = new Set();
    selectedCatalogItems().forEach((it) => {
      if (itemAppendDim(it) === dim) keep.add(String(it.id));
    });
    selectedStrategyIds = keep;
  }

  function syncDimRadio() {
    const dimRadio = document.querySelector(
      `input[name="shieldPlatAppendDim"][value="${appendForm.dim}"]`
    );
    if (dimRadio) dimRadio.checked = true;
  }

  function renderAppendTarget() {
    const el = $("shieldPlatAppendTarget");
    if (!el) return;
    const items = selectedCatalogItems().filter(
      (it) => itemAppendDim(it) === appendForm.dim
    );
    if (!items.length) {
      el.className = "shield-plat-append-target";
      el.textContent = "未选择策略";
      return;
    }
    const dimLabel = DIM_LABELS[appendForm.dim] || appendForm.dim;
    el.className = "shield-plat-append-target is-ready";
    el.innerHTML =
      `<span class="shield-plat-append-dim-tag" title="当前维度">${escHtml(
        dimLabel
      )}</span>` +
      `<div class="shield-plat-append-chips">` +
      items
        .map((it) => {
          const short =
            String(it.name || "").length > 18
              ? `${String(it.name).slice(0, 18)}…`
              : it.name;
          return `<span class="shield-plat-append-chip" title="${escHtml(
            `${it.id} · ${it.name}`
          )}">
            <code>${escHtml(it.id)}</code>
            <span class="shield-plat-append-chip-name">${escHtml(short)}</span>
            <button type="button" class="shield-plat-append-chip-x" data-act="remove-chip" data-id="${escHtml(
              it.id
            )}" aria-label="移除 ${escHtml(it.id)}">×</button>
          </span>`;
        })
        .join("") +
      `</div>`;
  }

  function refreshAppendUi(opts) {
    const keepSuggest = !!(opts && opts.keepSuggest);
    renderAppendTarget();
    renderCatalog();
    if (!keepSuggest) {
      hideSuggest($("shieldPlatIndustrySuggest"));
      // 策略下拉在多选时保留，便于连续点选
    }
  }

  /** 同维 toggle；不同维则切维并只保留该项 */
  function toggleAppendStrategy(item) {
    if (!item) {
      selectedStrategyIds.clear();
      refreshAppendUi();
      return;
    }
    const id = String(item.id);
    const dim = itemAppendDim(item);
    if (dim !== appendForm.dim) {
      appendForm.dim = dim;
      syncDimRadio();
      selectedStrategyIds.clear();
      selectedStrategyIds.add(id);
      appendForm.industry = String(item.group || appendForm.industry || "");
      const indInput = $("shieldPlatIndustrySearch");
      if (indInput && appendForm.industry) indInput.value = appendForm.industry;
    } else if (selectedStrategyIds.has(id)) {
      selectedStrategyIds.delete(id);
    } else {
      selectedStrategyIds.add(id);
      if (!appendForm.industry && item.group) {
        appendForm.industry = String(item.group);
        const indInput = $("shieldPlatIndustrySearch");
        if (indInput) indInput.value = appendForm.industry;
      }
    }
    refreshAppendUi({ keepSuggest: true });
    const box = $("shieldPlatStrategySuggest");
    if (box && !box.hidden) {
      renderStrategySuggest($("shieldPlatStrategySearch")?.value || "");
    }
  }

  function renderIndustrySuggest(q) {
    const box = $("shieldPlatIndustrySuggest");
    if (!box) return;
    const query = String(q || "")
      .trim()
      .toLowerCase();
    const groups = catalogGroups().filter((g) => {
      if (!query) return true;
      return g.toLowerCase().includes(query);
    });
    if (!groups.length) {
      box.hidden = false;
      box.innerHTML =
        '<div class="shield-plat-suggest-empty">无匹配行业</div>';
      return;
    }
    box.hidden = false;
    box.innerHTML = groups
      .slice(0, 40)
      .map(
        (g) =>
          `<button type="button" class="shield-plat-suggest-item is-one-line is-industry" data-act="pick-industry" data-industry="${escHtml(
            g
          )}" role="option" title="${escHtml(g)}"><span class="shield-plat-suggest-name">${escHtml(
            g
          )}</span></button>`
      )
      .join("");
  }

  function renderStrategySuggest(q) {
    const box = $("shieldPlatStrategySuggest");
    if (!box) return;
    const list = strategiesForAppend({ q });
    if (!list.length) {
      box.hidden = false;
      box.innerHTML =
        '<div class="shield-plat-suggest-empty">当前维度下无匹配策略</div>';
      return;
    }
    box.hidden = false;
    box.innerHTML = list
      .slice(0, 50)
      .map((it) => {
        const dimLabel = DIM_LABELS[itemAppendDim(it)] || itemAppendDim(it);
        const selected = selectedStrategyIds.has(String(it.id));
        return `<button type="button" class="shield-plat-suggest-item is-one-line${
          selected ? " is-picked" : ""
        }" data-act="pick-strategy" data-id="${escHtml(it.id)}" role="option" title="${escHtml(
          `${it.id} · ${it.name}`
        )}">
          <span class="shield-plat-suggest-check" aria-hidden="true">${
            selected ? "✓" : ""
          }</span>
          <code>${escHtml(it.id)}</code>
          <span class="shield-plat-suggest-name">${escHtml(it.name)}</span>
          <span class="shield-plat-tag">${escHtml(dimLabel)}</span>
        </button>`;
      })
      .join("");
  }

  function onAppendDimChange() {
    const checked = document.querySelector(
      'input[name="shieldPlatAppendDim"]:checked'
    );
    const nextDim = checked ? checked.value : "appId";
    appendForm.dim = MEDIA_DIM_KEYS[nextDim] ? nextDim : "appId";
    pruneSelectedToDim(appendForm.dim);
    hideSuggest($("shieldPlatStrategySuggest"));
    refreshAppendUi();
  }

  function clearAppendForm() {
    appendForm = {
      dim: "appId",
      industry: "",
    };
    const dimRadio = document.querySelector(
      'input[name="shieldPlatAppendDim"][value="appId"]'
    );
    if (dimRadio) dimRadio.checked = true;
    if ($("shieldPlatAppendIds")) $("shieldPlatAppendIds").value = "";
    if ($("shieldPlatIndustrySearch")) $("shieldPlatIndustrySearch").value = "";
    if ($("shieldPlatStrategySearch")) $("shieldPlatStrategySearch").value = "";
    selectedStrategyIds.clear();
    hideSuggest($("shieldPlatIndustrySuggest"));
    hideSuggest($("shieldPlatStrategySuggest"));
    refreshAppendUi();
    const sum = $("shieldPlatResolveSummary");
    if (sum) sum.textContent = "";
    const unBox = $("shieldPlatUnresolved");
    if (unBox) unBox.innerHTML = "";
  }

  function submitAppendToTasks() {
    const dim = appendForm.dim;
    const ids = tokenizeIds($("shieldPlatAppendIds")?.value || "");
    if (!ids.length) {
      alert(`请填写要追加的 ${DIM_LABELS[dim] || dim}`);
      return;
    }
    const items = selectedCatalogItems().filter(
      (it) => itemAppendDim(it) === dim
    );
    if (!items.length) {
      alert("请先搜索并多选映射策略");
      return;
    }

    const list = $("shieldPlatTaskList");
    const prev = Array.isArray(list?._tasks) ? list._tasks.slice() : [];
    items.forEach((item) => {
      const existIdx = prev.findIndex(
        (t) =>
          String(t.strategyId) === String(item.id) && String(t.appendDim) === dim
      );
      const mergedIds = new Set(existIdx >= 0 ? prev[existIdx].ids || [] : []);
      ids.forEach((id) => mergedIds.add(id));
      const task = {
        strategyId: String(item.id),
        strategyName: item.name,
        appendDim: dim,
        ids: [...mergedIds],
        ticketCount: 1,
        industry: item.group || "策略目录",
        product: item.name,
        routeId: `catalog:${item.id}`,
      };
      if (existIdx >= 0) prev[existIdx] = task;
      else prev.push(task);
    });

    renderResolveResult({ tasks: prev, unresolved: [] });
    renderCatalog();

    const sum = $("shieldPlatResolveSummary");
    if (sum) {
      sum.textContent = `已加入待提审：${items.length} 条策略 · ${
        DIM_LABELS[dim]
      } ×${ids.length}（仅追加 ID，不改策略其他信息）`;
    }
    const unBox = $("shieldPlatUnresolved");
    if (unBox) {
      unBox.innerHTML =
        '<p class="shield-plat-muted">下一步：在 Log · 待提审任务中预览并确认提审</p>';
    }
  }

  function onAppendPanelClick(ev) {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "remove-chip") {
      const id = String(btn.getAttribute("data-id") || "");
      if (id) selectedStrategyIds.delete(id);
      refreshAppendUi({ keepSuggest: true });
      const box = $("shieldPlatStrategySuggest");
      if (box && !box.hidden) {
        renderStrategySuggest($("shieldPlatStrategySearch")?.value || "");
      }
      return;
    }
    if (btn.dataset.act === "pick-industry") {
      const industry = String(btn.getAttribute("data-industry") || "");
      appendForm.industry = industry;
      const indInput = $("shieldPlatIndustrySearch");
      if (indInput) indInput.value = industry;
      hideSuggest($("shieldPlatIndustrySuggest"));
      // 行业切换不强制清空已选；策略下拉会按行业软过滤
      const stInput = $("shieldPlatStrategySearch");
      if (stInput) {
        stInput.focus();
        renderStrategySuggest(stInput.value);
      }
      return;
    }
    if (btn.dataset.act === "pick-strategy") {
      ev.preventDefault();
      const id = String(btn.getAttribute("data-id") || "");
      const item = flatCatalogItems(loadCatalog()).find(
        (it) => String(it.id) === id
      );
      if (item) toggleAppendStrategy(item);
    }
  }

  function persistCatalogEditsFromDom() {
    if (!canEditCatalog()) return;
    const catalog = loadCatalog();
    const body = $("shieldPlatCatalogBody");
    if (!body) return;
    body.querySelectorAll(".shield-plat-cat-row").forEach((row) => {
      const gi = Number(row.getAttribute("data-gi"));
      const oldId = row.getAttribute("data-id");
      const idInput = row.querySelector('[data-field="id"]');
      const nameInput = row.querySelector('[data-field="name"]');
      if (!catalog[gi] || !idInput || !nameInput) return;
      const items = catalog[gi].items || [];
      const idx = items.findIndex((it) => String(it.id) === String(oldId));
      if (idx < 0) return;
      const nextId = String(idInput.value || "").trim();
      const nextName = String(nameInput.value || "").trim();
      if (!/^\d{2,}$/.test(nextId) || !nextName) return;
      const wasSelected = selectedStrategyIds.has(String(oldId));
      if (wasSelected && String(oldId) !== nextId) {
        selectedStrategyIds.delete(String(oldId));
        selectedStrategyIds.add(nextId);
      }
      items[idx] = {
        ...items[idx],
        id: nextId,
        name: stripDimFromName(nextName) || nextName,
        appendDim: MEDIA_DIM_KEYS[items[idx].appendDim]
          ? items[idx].appendDim
          : inferAppendDim(nextName),
      };
      row.setAttribute("data-id", nextId);
    });
    saveCatalog(catalog);
  }

  function renderResolveResult(result) {
    const box = $("shieldPlatTaskList");
    const unBox = $("shieldPlatUnresolved");
    if (!box || !unBox) return;

    if (result.needSelect) {
      box.innerHTML =
        '<p class="shield-plat-muted">请先在②选择维度并映射策略</p>';
      unBox.innerHTML = "";
      box._tasks = [];
      return;
    }

    if (!result.tasks.length && !result.unresolved.length) {
      box.innerHTML =
        '<p class="shield-plat-muted">选择维度并映射策略后，任务会出现在这里</p>';
      unBox.innerHTML = "";
      return;
    }

    if (!result.tasks.length) {
      box.innerHTML =
        '<p class="shield-plat-muted">暂无待提审任务（检查勾选策略与工单 ID 维度是否匹配）</p>';
    } else {
      box.innerHTML = result.tasks
        .map((t, idx) => {
          const idsPreview = t.ids.slice(0, 8).map(escHtml).join(", ");
          const more = t.ids.length > 8 ? ` …共 ${t.ids.length}` : "";
          const title = t.strategyName
            ? `${escHtml(t.strategyName)}`
            : `策略 ${escHtml(t.strategyId)}`;
          return `<article class="shield-plat-task" data-task-idx="${idx}">
          <header>
            <strong>${title}</strong>
            <code>${escHtml(t.strategyId)}</code>
            <span class="shield-plat-tag">${escHtml(t.appendDim)}</span>
          </header>
          <p>待追加 ${t.ids.length} 个 ID · 来自 ${t.ticketCount} 行工单</p>
          <p class="shield-plat-ids"><code>${idsPreview}${more}</code></p>
          <div class="shield-plat-task-actions">
            <button type="button" class="btn-sm btn-sm-primary" data-act="preview">预览变更</button>
            <button type="button" class="btn-sm" data-act="submit" disabled>确认提审</button>
          </div>
          <div class="shield-plat-task-preview" hidden></div>
        </article>`;
        })
        .join("");
    }

    box._tasks = result.tasks;

    if (result.unresolved.length) {
      unBox.innerHTML =
        `<h3>未映射 ${result.unresolved.length} 条</h3>` +
        result.unresolved
          .map(
            (u) =>
              `<div class="shield-plat-unresolved-item">
                <span>${escHtml(String(u.line))}</span>
                <span>${escHtml(u.industry || "—")} / ${escHtml(u.product || "—")}</span>
                <span class="is-err">${escHtml(u.reason)}</span>
              </div>`
          )
          .join("");
    } else if (result.tasks.length) {
      unBox.innerHTML = '<p class="shield-plat-muted">工单 ID 已映射到勾选策略</p>';
    } else {
      unBox.innerHTML = "";
    }
  }

  function addRouteFromForm() {
    const industry = String($("shieldPlatRouteIndustry")?.value || "").trim();
    const product = String($("shieldPlatRouteProduct")?.value || "").trim();
    const strategyId = String($("shieldPlatRouteStrategy")?.value || "").trim();
    const appendDim = String($("shieldPlatRouteDim")?.value || "appId");
    if (!industry) {
      alert("请填写屏蔽行业");
      return;
    }
    if (!/^\d{3,}$/.test(strategyId)) {
      alert("请填写有效策略ID");
      return;
    }
    if (!MEDIA_DIM_KEYS[appendDim]) {
      alert("追加维度无效");
      return;
    }
    const list = loadRoutes();
    list.push({
      id: uid(),
      industry,
      product,
      strategyId,
      appendDim,
      enabled: true,
      adReady: true,
    });
    saveRoutes(list);
    renderRoutes();
    if ($("shieldPlatRouteIndustry")) $("shieldPlatRouteIndustry").value = "";
    if ($("shieldPlatRouteProduct")) $("shieldPlatRouteProduct").value = "";
    if ($("shieldPlatRouteStrategy")) $("shieldPlatRouteStrategy").value = "";
  }

  function onRouteTableClick(ev) {
    const btn = ev.target.closest("[data-act]");
    const tr = ev.target.closest("tr[data-id]");
    if (!btn || !tr) return;
    const id = tr.getAttribute("data-id");
    const list = loadRoutes();
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    if (btn.dataset.act === "del") {
      list.splice(idx, 1);
      saveRoutes(list);
      renderRoutes();
      return;
    }
    if (btn.dataset.act === "toggle") {
      list[idx].enabled = list[idx].enabled === false;
      saveRoutes(list);
      renderRoutes();
    }
  }

  function syncAppendFromCatalogSelection(id, checked) {
    const item = flatCatalogItems(loadCatalog()).find(
      (it) => String(it.id) === String(id)
    );
    if (!checked) {
      selectedStrategyIds.delete(String(id));
      refreshAppendUi({ keepSuggest: true });
      return;
    }
    if (!item) {
      renderCatalog();
      return;
    }
    const dim = itemAppendDim(item);
    if (dim !== appendForm.dim) {
      appendForm.dim = dim;
      syncDimRadio();
      // 切维：保留本次勾选，清掉其他维
      selectedStrategyIds.clear();
      selectedStrategyIds.add(String(item.id));
    } else {
      selectedStrategyIds.add(String(item.id));
    }
    if (item.group) {
      appendForm.industry = String(item.group);
      const indInput = $("shieldPlatIndustrySearch");
      if (indInput) indInput.value = appendForm.industry;
    }
    refreshAppendUi({ keepSuggest: true });
  }

  function onCatalogClick(ev) {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "select-group") {
      const group = btn.closest(".shield-plat-cat-group");
      const rows = [
        ...(group?.querySelectorAll(".shield-plat-cat-row") || []),
      ];
      const matches = rows.filter(
        (row) => row.getAttribute("data-dim") === appendForm.dim
      );
      if (!matches.length) {
        alert("本组没有与当前添加维度匹配的策略");
        return;
      }
      matches.forEach((row) => {
        const id = row.getAttribute("data-id");
        if (id) selectedStrategyIds.add(String(id));
      });
      refreshAppendUi({ keepSuggest: true });
    }
  }

  function onCatalogChange(ev) {
    const t = ev.target;
    if (t && t.matches && t.matches('input[data-act="toggle-sel"]')) {
      const row = t.closest(".shield-plat-cat-row");
      const id = row?.getAttribute("data-id");
      if (!id) return;
      syncAppendFromCatalogSelection(id, !!t.checked);
      return;
    }
    if (t && t.matches && t.matches("[data-field]")) {
      persistCatalogEditsFromDom();
      renderCatalog();
    }
  }

  function setTaskBusy(article, busy) {
    article.querySelectorAll("button").forEach((b) => {
      if (b.dataset.act === "submit" && !article._pending) {
        b.disabled = true;
        return;
      }
      if (b.dataset.act === "submit" && article._pending && !busy) {
        b.disabled = false;
        return;
      }
      b.disabled = !!busy;
    });
  }

  async function previewTask(article, task) {
    const previewEl = article.querySelector(".shield-plat-task-preview");
    const submitBtn = article.querySelector('[data-act="submit"]');
    article._pending = null;
    if (submitBtn) submitBtn.disabled = true;
    setTaskBusy(article, true);
    if (previewEl) {
      previewEl.hidden = false;
      previewEl.innerHTML = "<p>正在拉取策略详情…</p>";
    }
    try {
      const rawData = await orientGet(task.strategyId);
      const detail = extractStrategyPayload(rawData);
      const type = Number(detail.type);
      const mediaType = String(detail.shieldMediaType || "");
      const dim = task.appendDim;
      if (mediaType && !new RegExp(`(^|,)${dim}(,|$)`).test(mediaType)) {
        throw new Error(`策略媒体维为「${mediaType}」，不含 ${dim}`);
      }
      if (!detail.mediaCluster || typeof detail.mediaCluster !== "object") {
        detail.mediaCluster = {};
      }
      const merge = mergeIds(detail.mediaCluster[dim], task.ids);
      if (!merge.added.length) {
        throw new Error(`没有可追加的新 ${dim}（全部已存在）`);
      }
      const nextDetail = {
        ...detail,
        id: detail.id ?? Number(task.strategyId),
        mediaCluster: {
          ...detail.mediaCluster,
          [dim]: merge.merged,
        },
      };
      const body = sanitizeForSubmit(nextDetail);
      article._pending = {
        id: String(task.strategyId),
        strategyName: String(detail.name || task.strategyName || ""),
        body,
        added: merge.added,
        skipped: merge.skipped,
        beforeCount: merge.beforeCount,
        afterCount: merge.afterCount,
        appendDim: dim,
      };
      pendingSubmit = article._pending;
      if (previewEl) {
        previewEl.innerHTML = `
          <p><strong>${escHtml(detail.name || "")}</strong> · ${escHtml(dim)}
            ${merge.beforeCount} → ${merge.afterCount}</p>
          <p class="shield-plat-muted">策略类型：${escHtml(typeLabel(type))}</p>
          <p>新增：<code>${escHtml(merge.added.slice(0, 16).join(", "))}${
            merge.added.length > 16 ? "…" : ""
          }</code></p>
          ${
            merge.skipped.length
              ? `<p class="shield-plat-muted">已存在跳过 ${merge.skipped.length} 个</p>`
              : ""
          }
          <p class="shield-plat-muted">确认后将 mergeEditV2 提审</p>`;
      }
      if (submitBtn) submitBtn.disabled = false;
    } catch (err) {
      if (previewEl) {
        previewEl.innerHTML = `<p class="is-err">${escHtml(err.message || String(err))}</p>`;
      }
    } finally {
      setTaskBusy(article, false);
      if (article._pending) {
        const sb = article.querySelector('[data-act="submit"]');
        if (sb) sb.disabled = false;
      }
    }
  }

  async function submitTask(article) {
    const pending = article._pending;
    if (!pending) {
      alert("请先预览变更");
      return;
    }
    if (!confirm(`确认向策略 ${pending.id} 追加 ${pending.added.length} 个 ${pending.appendDim} 并提审？`)) {
      return;
    }
    setTaskBusy(article, true);
    const previewEl = article.querySelector(".shield-plat-task-preview");
    try {
      await orientSubmit(pending.id, pending.body);
      const time = new Date().toLocaleString("zh-CN", { hour12: false });
      pushExecLog({
        ok: true,
        time,
        strategyId: pending.id,
        strategyName: pending.strategyName || "",
        appendDim: pending.appendDim,
        added: pending.added.length,
        addedIds: pending.added.slice(),
        message: "提审成功",
      });
      renderExecLog();
      if (previewEl) {
        previewEl.innerHTML = `<p class="is-ok">已提审：+${pending.added.length} 个 ${escHtml(
          pending.appendDim
        )}</p>`;
      }
      article._pending = null;
      const sb = article.querySelector('[data-act="submit"]');
      if (sb) sb.disabled = true;
    } catch (err) {
      pushExecLog({
        ok: false,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        strategyId: pending.id,
        strategyName: pending.strategyName || "",
        appendDim: pending.appendDim,
        added: 0,
        addedIds: [],
        message: err.message || String(err),
      });
      renderExecLog();
      if (previewEl) {
        previewEl.innerHTML += `<p class="is-err">${escHtml(err.message || String(err))}</p>`;
      }
    } finally {
      setTaskBusy(article, false);
    }
  }

  function onTaskListClick(ev) {
    const btn = ev.target.closest("[data-act]");
    const article = ev.target.closest(".shield-plat-task");
    if (!btn || !article) return;
    const list = $("shieldPlatTaskList");
    const tasks = list?._tasks || [];
    const idx = Number(article.getAttribute("data-task-idx"));
    const task = tasks[idx];
    if (!task) return;
    if (btn.dataset.act === "preview") {
      previewTask(article, task);
      return;
    }
    if (btn.dataset.act === "submit") {
      submitTask(article);
    }
  }

  function exportRoutes() {
    const blob = new Blob([JSON.stringify(loadRoutes(), null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "shield-platform-routes.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importRoutes(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || "[]"));
        if (!Array.isArray(data)) throw new Error("JSON 须为数组");
        const normalized = data
          .map((r) => ({
            id: r.id || uid(),
            industry: String(r.industry || "").trim(),
            product: String(r.product || "").trim(),
            strategyId: String(r.strategyId || "").trim(),
            appendDim: MEDIA_DIM_KEYS[r.appendDim] ? r.appendDim : "appId",
            enabled: r.enabled !== false,
            adReady: r.adReady !== false,
          }))
          .filter((r) => r.industry && /^\d{3,}$/.test(r.strategyId));
        saveRoutes(normalized);
        renderRoutes();
        alert(`已导入 ${normalized.length} 条路由`);
      } catch (err) {
        alert(err.message || String(err));
      }
    };
    reader.readAsText(file);
  }

  function init() {
    if (!$("viewStrategyShieldPlatform")) return;

    renderRoutes();
    fetchSharedExecLog();
    renderCatalog();
    renderAppendTarget();

    $("shieldPlatRouteAdd")?.addEventListener("click", addRouteFromForm);
    $("shieldPlatRouteBody")?.addEventListener("click", onRouteTableClick);
    $("shieldPlatAppendBtn")?.addEventListener("click", submitAppendToTasks);
    $("shieldPlatAppendClear")?.addEventListener("click", clearAppendForm);
    document.querySelectorAll('input[name="shieldPlatAppendDim"]').forEach((el) => {
      el.addEventListener("change", onAppendDimChange);
    });

    const appendPanel = document.querySelector("#viewStrategyShieldPlatform .shield-plat-append-grid");
    appendPanel?.addEventListener("click", onAppendPanelClick);

    $("shieldPlatIndustrySearch")?.addEventListener("focus", (e) => {
      renderIndustrySuggest(e.target.value);
    });
    $("shieldPlatIndustrySearch")?.addEventListener("input", (e) => {
      appendForm.industry = "";
      renderIndustrySuggest(e.target.value);
    });
    $("shieldPlatStrategySearch")?.addEventListener("focus", (e) => {
      renderStrategySuggest(e.target.value);
    });
    $("shieldPlatStrategySearch")?.addEventListener("input", (e) => {
      // 仅过滤下拉，不清空已选（支持多选连续搜索）
      renderStrategySuggest(e.target.value);
    });

    document.addEventListener("click", (ev) => {
      if (ev.target.closest(".shield-plat-suggest-field")) return;
      if (ev.target.closest(".shield-plat-append-target")) return;
      hideSuggest($("shieldPlatIndustrySuggest"));
      hideSuggest($("shieldPlatStrategySuggest"));
    });

    $("shieldPlatTaskList")?.addEventListener("click", onTaskListClick);
    $("shieldPlatExportRoutes")?.addEventListener("click", exportRoutes);
    $("shieldPlatImportRoutes")?.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importRoutes(file);
      e.target.value = "";
    });

    $("shieldPlatCatalogBody")?.addEventListener("click", onCatalogClick);
    $("shieldPlatCatalogBody")?.addEventListener("change", onCatalogChange);
    $("shieldPlatCatalogSearch")?.addEventListener("input", () => {
      persistCatalogEditsFromDom();
      renderCatalog();
    });
    $("shieldPlatCatalogClearSel")?.addEventListener("click", () => {
      selectedStrategyIds.clear();
      refreshAppendUi();
    });
    $("shieldPlatExecLogOpen")?.addEventListener("click", openExecLogModal);
    $("shieldPlatExecLogClose")?.addEventListener("click", closeExecLogModal);
    $("shieldPlatExecLogBackdrop")?.addEventListener("click", closeExecLogModal);
    $("shieldPlatExecLogSearch")?.addEventListener("input", (e) => {
      execLogQuery = String(e.target.value || "");
      renderExecLog();
    });
    document.querySelectorAll(".shield-plat-exec-filter").forEach((btn) => {
      btn.addEventListener("click", () => {
        execLogFilter = btn.getAttribute("data-filter") || "all";
        document.querySelectorAll(".shield-plat-exec-filter").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
        renderExecLog();
      });
    });
    $("shieldPlatExecLogClear")?.addEventListener("click", () => {
      alert(
        `执行记录为全员共享，最长保留 ${EXEC_LOG_KEEP_DAYS} 天，不支持单人清空。已刷新最新列表。`
      );
      clearExecLogView();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      const modal = $("shieldPlatExecLogModal");
      if (modal && !modal.classList.contains("hidden")) closeExecLogModal();
    });
    $("shieldPlatOperatorSave")?.addEventListener("click", () => {
      const v = String($("shieldPlatOperatorInput")?.value || "").trim();
      localStorage.setItem(STORAGE_OPERATOR, v);
      if (v) localStorage.setItem("postpone-operator", v);
      renderCatalog();
    });
  }

  window.onStrategyShieldPlatformViewEnter = function () {
    renderRoutes();
    fetchSharedExecLog();
    renderCatalog();
    renderAppendTarget();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
