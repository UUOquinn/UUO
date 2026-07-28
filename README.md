# 联盟诊断工作台

内网运营工作台前端 + Python 静态服务 / API 代理。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | 原生 HTML / CSS / JavaScript（无 React / Vue） |
| 样式 | 自研样式表 + 玻璃拟态主题（`staging-glass.css`） |
| 后端 | Python 3 `http.server`（`server/app.py`）：静态资源 + REST 代理 |
| 浏览器自动化 | Playwright（持久化 Chromium 会话，代理内网平台请求） |
| 进程保活 | Bash 守护脚本 `guardian.sh`（检测端口、崩溃重启） |
| 包管理 | npm（可选 Node 轻量入口，不含策略能力） |

## 实现能力（技术视角）

- **工作台壳层**：侧栏导航、多视图切换、深链到产品手册
- **模块化前端**：首页 / 策略查询 / 策略审核 / 策略延期 / 产品手册各自独立 JS
- **服务端代理**：浏览器只访问本机 HTTP API，由后端转发上游请求
- **会话保活**：Playwright 心跳与 SSO 短自愈，降低人工续登频率
- **后台任务**：定时扫描类逻辑以守护线程方式挂在 Python 进程内
- **可观测**：结构化运行日志目录（本地文件，不入库）

## 仓库结构（简）

```
index.html / *.js / *.css   前端界面与模块
server/app.py              HTTP 入口
server/orient_browser.py   Playwright 代理
server/modules/            业务模块（查询 / 审核 / 延期等）
guardian.sh                生产守护
scripts/                   启动与运维脚本
docs/                      说明文档
```

## 本地启动

生产约定：本仓库目录下使用 `guardian.sh run`（详见 `docs/PRODUCTION-STARTUP.md`）。

```bash
bash scripts/start-production.sh
# 或
bash guardian.sh run
```

默认端口 `3000`。会话、Cookie、运行日志等敏感/运行时文件已通过 `.gitignore` 排除，不会进入版本库。
