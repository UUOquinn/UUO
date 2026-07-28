# 生产启动（唯一标准）

**写死**：本仓库 Documents 目录 + `guardian.sh run`，端口 `3000`。  
**不要用**：LaunchAgent、Application Support 副本、`start-guardian.sh`。

## 目录

| 项 | 路径 |
|----|------|
| 运行目录 | `<repo-root>` |
| 会话目录 | `…/server/orient_session`（由 `ORIENT_SESSION_DIR` 指向） |
| 守护脚本 | `guardian.sh` |
| 标准入口 | `scripts/start-production.sh` |

## 启动（请在 macOS「终端.app」执行）

```bash
bash <repo-root>/scripts/start-production.sh
```

等价手动：

```bash
cd <repo-root>
bash guardian.sh stop   # 若已有旧守护
nohup bash guardian.sh run >> guardian.log 2>&1 &
```

## 常用命令

```bash
bash guardian.sh status
bash guardian.sh stop
bash guardian.sh restart   # 只重启 app.py，不换守护
```

## 验收

- 本机：`http://127.0.0.1:3000/`
- 内网入口：以本机部署为准（占位示例 `http://workbench.example.corp:3000/`，勿把真实 IP 写入仓库）
- `bash guardian.sh status` 显示服务运行中
- Cookie 状态为 Playwright 已就绪（或等价已登录提示）
