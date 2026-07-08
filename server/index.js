/**
 * 联盟诊断工作台 - 后端 API 代理服务
 *
 * 职责：
 *  1. 托管前端静态文件（index.html / app.js / styles.css）
 *  2. 代理 /api/dataset/query → KwaiBI 内部数据平台 datasetDataQuery
 *  3. 代理 /api/dataset/metadata → KwaiBI metadataSearchV2
 *  4. 自动转发浏览器 Cookie 实现内网鉴权透传
 *
 * 数据集映射：
 *  85587  — 离线主效果
 *  129496 — 实时主效果
 *  207512 — 请求链路过滤原因
 *  103846 — 召回/粗排/精排漏斗
 */

const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const cors = require("cors");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// ─── KwaiBI 内部数据平台地址（可环境变量覆盖） ───
const KWABI_BASE =
  process.env.KWABI_BASE || "https://kwaibi.corp.kuaishou.com";
const DATASET_QUERY_PATH =
  process.env.DATASET_QUERY_PATH || "/api/v1/dataset/data/query";
const METADATA_SEARCH_PATH =
  process.env.METADATA_SEARCH_PATH || "/api/v1/dataset/metadata/search";

// ─── 中间件 ───
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

// ─── 静态文件托管 ───
const STATIC_DIR = path.resolve(__dirname, "..");
app.use(express.static(STATIC_DIR));

// ──────────────────────────────────────────────
//  POST /api/dataset/query
// ──────────────────────────────────────────────
// 请求体格式：
// {
//   datasetId: "85587" | "129496" | "207512" | "103846",
//   metrics:   ["联盟总消耗", "广告请求次数", ...],
//   dimensions:["开发者id", "应用id", ...],        // 可选
//   filters: {
//     uid:    ["100001"],
//     app_id: ["67890"],
//     pos_id: ["12345"],
//     ad_style: [],
//     __time: { start: "2025-06-28", end: "2025-06-29" }
//   },
//   compareTime: {                               // 可选，对比时间
//     start: "2025-06-27", end: "2025-06-28"
//   },
//   limit: 1000                                  // 可选
// }
//
// 响应格式：
// {
//   success: true,
//   data: {
//     columns: [...],
//     rows: [[...], ...],
//     total: 42
//   }
// }
// ──────────────────────────────────────────────
app.post("/api/dataset/query", async (req, res) => {
  try {
    const { datasetId, metrics, dimensions, filters, compareTime, limit } =
      req.body;

    if (!datasetId) {
      return res.status(400).json({
        success: false,
        error: "datasetId is required",
      });
    }

    // 构建转发给 KwaiBI 的请求体
    const kwabiPayload = buildKwabiPayload({
      datasetId,
      metrics,
      dimensions,
      filters,
      compareTime,
      limit,
    });

    // 转发浏览器 Cookie（内网鉴权）
    const cookieHeader = buildCookieHeader(req);

    const upstreamUrl = `${KWABI_BASE}${DATASET_QUERY_PATH}`;
    console.log(
      `[proxy] POST ${upstreamUrl} dataset=${datasetId} metrics=${metrics?.length || 0}`
    );

    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify(kwabiPayload),
      timeout: 30000,
    });

    if (!upstreamResp.ok) {
      const text = await upstreamResp.text();
      console.error(`[proxy] upstream ${upstreamResp.status}: ${text.slice(0, 200)}`);
      return res.status(upstreamResp.status).json({
        success: false,
        error: `KwaiBI returned ${upstreamResp.status}`,
        detail: text.slice(0, 500),
      });
    }

    const upstreamData = await upstreamResp.json();
    res.json({
      success: true,
      data: normalizeUpstreamResponse(upstreamData),
    });
  } catch (err) {
    console.error("[proxy] /api/dataset/query error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ──────────────────────────────────────────────
//  POST /api/dataset/metadata
// ──────────────────────────────────────────────
// 请求体：{ datasetId: "85587" }
// 响应：{ success, data: { columns: [...] } }
// ──────────────────────────────────────────────
app.post("/api/dataset/metadata", async (req, res) => {
  try {
    const { datasetId } = req.body;
    if (!datasetId) {
      return res.status(400).json({
        success: false,
        error: "datasetId is required",
      });
    }

    const cookieHeader = buildCookieHeader(req);
    const upstreamUrl = `${KWABI_BASE}${METADATA_SEARCH_PATH}`;

    console.log(`[proxy] POST ${upstreamUrl} dataset=${datasetId}`);

    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ datasetId }),
      timeout: 15000,
    });

    if (!upstreamResp.ok) {
      const text = await upstreamResp.text();
      return res.status(upstreamResp.status).json({
        success: false,
        error: `KwaiBI metadata returned ${upstreamResp.status}`,
        detail: text.slice(0, 500),
      });
    }

    const upstreamData = await upstreamResp.json();
    res.json({
      success: true,
      data: upstreamData,
    });
  } catch (err) {
    console.error("[proxy] /api/dataset/metadata error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ──────────────────────────────────────────────
//  GET /api/dataset/list
// ──────────────────────────────────────────────
// 返回本工作台支持的数据集列表
// ──────────────────────────────────────────────
app.get("/api/dataset/list", (_req, res) => {
  res.json({
    success: true,
    data: [
      {
        id: "85587",
        name: "离线主效果数据",
        type: "offline",
        description: "T-1 及历史数据，对比口径：目标日 vs 前一天",
      },
      {
        id: "129496",
        name: "实时主效果数据",
        type: "realtime",
        description: "当天实时累计，对比口径：今日当前累计 vs 昨日同时间段",
      },
      {
        id: "207512",
        name: "请求链路过滤原因",
        type: "drill",
        description: "有效请求率下降时下钻，查过滤比/过滤次数/请求承接率",
      },
      {
        id: "103846",
        name: "召回/粗排/精排漏斗",
        type: "drill",
        description: "有效填充率下降时下钻，查召粗精混前曝漏斗通过率",
      },
    ],
  });
});

// ──────────────────────────────────────────────
//  构建转发请求体
// ──────────────────────────────────────────────
function buildKwabiPayload({ datasetId, metrics, dimensions, filters, compareTime, limit }) {
  const payload = {
    datasetId: String(datasetId),
  };

  // 指标字段
  if (metrics && metrics.length) {
    payload.metrics = metrics;
  }

  // 维度字段
  if (dimensions && dimensions.length) {
    payload.dimensions = dimensions;
  }

  // 筛选条件 → KwaiBI filter 格式
  const filterList = [];

  if (filters) {
    // uid 筛选
    if (filters.uid && filters.uid.length) {
      filterList.push({
        field: "开发者id",
        operator: "IN",
        value: filters.uid,
      });
    }

    // app_id 筛选
    if (filters.app_id && filters.app_id.length) {
      filterList.push({
        field: "应用id",
        operator: "IN",
        value: filters.app_id,
      });
    }

    // pos_id 筛选
    if (filters.pos_id && filters.pos_id.length) {
      filterList.push({
        field: "广告位id",
        operator: "IN",
        value: filters.pos_id,
      });
    }

    // ad_style 筛选
    if (filters.ad_style && filters.ad_style.length) {
      filterList.push({
        field: "广告场景",
        operator: "IN",
        value: filters.ad_style,
      });
    }

    // 时间筛选
    if (filters.__time) {
      filterList.push({
        field: "__time",
        operator: "BETWEEN",
        value: [filters.__time.start, filters.__time.end],
      });
    }
  }

  if (filterList.length) {
    payload.filters = filterList;
  }

  // 对比时间
  if (compareTime) {
    payload.compareTime = {
      start: compareTime.start,
      end: compareTime.end,
    };
  }

  // limit
  if (limit) {
    payload.limit = limit;
  }

  return payload;
}

// ──────────────────────────────────────────────
//  构建转发 Cookie
// ──────────────────────────────────────────────
function buildCookieHeader(req) {
  const cookies = req.cookies || {};
  const entries = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return entries || "";
}

// ──────────────────────────────────────────────
//  标准化上游响应
// ──────────────────────────────────────────────
function normalizeUpstreamResponse(raw) {
  // KwaiBI 返回格式可能是 { data: { columns, rows } } 或 { columns, rows }
  // 统一为 { columns, rows, total }
  const inner = raw.data || raw;

  const columns = inner.columns || inner.header || [];
  const rows = inner.rows || inner.data || inner.result || [];
  const total = inner.total || rows.length;

  return { columns, rows, total };
}

// ─── 启动 ───
app.listen(PORT, () => {
  console.log(`\n  🚀 联盟诊断工作台后端已启动`);
  console.log(`  📡 代理目标: ${KWABI_BASE}`);
  console.log(`  🌐 访问地址: http://localhost:${PORT}`);
  console.log(`  📋 数据集: 85587 / 129496 / 207512 / 103846\n`);
});
