# 联盟诊断工作台

ToB 风格个人工作台，基于 `alliance-advertiser-funnel-diagnosis-1.1` skill 生成诊断口径。

## 访问地址

启动后，同内网用户可直接访问：

```
http://172.23.178.50:3000/
```

无需任何配置，打开就能用（Cookie 已在服务端共享）。

## 打开方式

### Python 后端（推荐，支持真实数据）

```bash
cd /Users/wqy/Documents/skills/alliance-advertiser-funnel-web
python3 server/app.py
```

启动后日志会显示：
- 本机访问: `http://localhost:3000`
- 内网访问: `http://172.23.178.50:3000` ← 同事用这个

> 后端默认绑定 `0.0.0.0:3000`，同内网用户均可访问。若无法访问，检查 macOS 防火墙是否允许 Python 接受入站连接。

## 服务端共享 Cookie（一次配置，全员免登录）

为了让所有用户**无需任何配置即可使用**，Cookie 统一存放在服务端 `server/cookie.json`。

### 配置步骤（维护者只需做一次）

1. 打开 https://kwaibi.corp.kuaishou.com 登录
2. F12 → Network → 任意请求 → Request Headers → Cookie → 复制完整值
3. 粘贴到 `server/cookie.json` 的 `kwabi` 字段：

```json
{
  "kwabi": "JSESSIONID=xxx; accessproxy_session=xxx; 其余 Cookie..."
}
```

4. 重启后端（`python3 server/app.py`），启动日志会显示 `🍪 服务端 Cookie: ✓ 已配置（用户免登录）`

### 用户使用

打开 `http://localhost:3000` → 直接使用，**无需配置任何 Cookie**。

侧边栏的 Cookie 输入框是**可选**的，默认使用服务端共享 Cookie。如果用户想用自己的 Cookie 覆盖，可以粘贴到输入框并点保存。

### Cookie 过期了怎么办？

通常 1-3 天后 Cookie 会过期，此时：
- 所有用户操作会看到红色提示「服务端 Cookie 已过期，请联系维护者更新 server/cookie.json」
- 维护者重新复制一次 Cookie 粘贴到 `server/cookie.json` 即可，用户无需任何操作

## 数据架构

```
浏览器页面
  → 后端 API (server/app.py :3000)
    → /api/dataset/query  → KwaiBI datasetDataQuery
    → /api/dataset/metadata → KwaiBI metadataSearchV2
      → 数据集 85587  / 离线主效果
      → 数据集 129496 / 实时主效果
      → 数据集 207512 / 请求链路过滤原因
      → 数据集 103846 / 召粗精漏斗
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `KWABI_BASE` | `https://kwaibi.corp.kuaishou.com` | KwaiBI 内部数据平台地址 |
| `DATASET_QUERY_PATH` | `/api/v1/dataset/data/query` | 数据集查询 API 路径 |
| `METADATA_SEARCH_PATH` | `/api/v1/dataset/metadata/search` | 元数据查询 API 路径 |

## 当前能力

- 工作台布局：侧边栏导航 + 顶部栏 + 双栏工作区
- 漏斗诊断：自然语言输入、筛选维度、诊断口径生成
- **真实数据接入**：主漏斗查询 + 下钻数据查询（207512 / 103846）
- **漏斗可视化**：CSS 条形图展示召粗精漏斗、过滤比排名
- **对比表格**：目标期 vs 对比期数据对比，变化方向高亮
- **Loading 状态**：查询中展示动画，失败自动回退口径模式
- 查询记录：本地保存最近 20 条，可一键复用
- 快捷示例：一键填充常见问题

## 双模式说明

| 模式 | 触发条件 | 特点 |
|------|----------|------|
| 数据模式 | KwaiBI API 可访问 | 查询真实数据，展示主漏斗对比表和漏斗图 |
| 口径模式 | API 不可达时自动降级 | 生成查询口径方案，不展示实际数据 |

## 后续扩展

- 数据集管理、CPM 排查、策略延期等模块
- 用户登录与个人配置
