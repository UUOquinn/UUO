# 联盟诊断工作台

内网运营工作台：前端界面 + 本机 Python 服务（静态资源与 API 代理）。

## 已实现功能

### 工作台首页
- 漏斗诊断入口与查询记录
- 白名单审核日志、托管延期日志等运行日志面板
- 侧栏 Cookie / 登录态展示（以本机代理会话为准）

### 策略查询
- 自然语言 / ID 类输入，实时查询策略列表与明细
- 结果区展示策略字段、生效状态等（只读查询）

### 策略审核
- 按策略 ID 查询详情并展示审核相关操作
- 白名单审核（含弹窗名单）
- 审核通过 / 驳回、同意发布 / 拒绝发布等状态流转
- 立即推全、封禁期审核链路
- 自动审核守护（后台定时）

### 策略延期
- 策略 ID 延期（顺延周期并提审）
- 自动延期托管表（托管策略名单维护）
- 托管扫描后台任务

### 产品手册
- 能力说明、架构与启动约定（站内文档）

### 工程能力
- Playwright 持久会话代理上游请求
- `guardian.sh` 进程保活与自动拉起
- 运行日志落盘（本地，不入库）

> 灰显「即将上线」模块（如 CPM 排查等）尚未实现，不计入上表。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | 原生 HTML / CSS / JavaScript |
| 样式 | 自研样式 + 玻璃拟态主题 |
| 后端 | Python 3 `http.server`（`server/app.py`） |
| 浏览器自动化 | Playwright（持久化 Chromium） |
| 保活 | Bash `guardian.sh` |
| 可选 | npm / Node 轻量入口（不含策略能力） |

## API 地址约定（占位，非真实）

浏览器**只访问本机服务**；真实上游域名与内网 IP **不写进仓库**，由本机环境变量注入。

| 用途 | 占位示例 | 说明 |
|------|----------|------|
| 本机工作台 | `http://127.0.0.1:3000` | 默认端口，可改 `PORT` |
| 本机 API 前缀 | `http://127.0.0.1:3000/api/*` | 前端相对路径 `/api/...` |
| 上游运营平台 | `https://ops-platform.example.corp/rest` | 对应环境变量如 `ORIENT_API_BASE` |
| 上游数据平台 | `https://bi-platform.example.corp` | 对应环境变量如 `KWABI_BASE` |
| 内网访问入口 | `http://workbench.example.corp:3000` | 部署机局域网地址，本地配置 |

本地可参考（勿提交真实值）：

```bash
export ORIENT_API_BASE="https://ops-platform.example.corp/rest"
export KWABI_BASE="https://bi-platform.example.corp"
export PORT=3000
```

## MCP 约定（占位，非真实）

若通过 Cursor / 其它客户端挂载 MCP，**真实 MCP URL、Token 仅放在本机客户端配置**，不进入本仓库。

| 用途 | 占位示例 |
|------|----------|
| MCP SSE / HTTP | `https://mcp.example.local/sse` |
| MCP 鉴权头 | `Authorization: Bearer <LOCAL_TOKEN>` |

仓库内不包含 MCP 服务器实现与生产凭证；需要时在 Cursor 的 MCP 设置中自行填写本机地址。

## 仓库结构（简）

```
index.html / *.js / *.css   前端
server/app.py              HTTP 入口
server/orient_browser.py   Playwright 代理
server/modules/            查询 / 审核 / 延期等模块
guardian.sh                生产守护
scripts/                   启动脚本
docs/                      说明（契约文档中的上游地址亦为占位或脱敏）
```

## 本地启动

```bash
bash scripts/start-production.sh
# 或
bash guardian.sh run
```

默认端口 `3000`。会话、Cookie、运行日志、托管表数据等已通过 `.gitignore` 排除。更多约定见 `docs/PRODUCTION-STARTUP.md`。
