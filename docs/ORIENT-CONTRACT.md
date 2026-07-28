# Orient 契约与风险登记

抓包/抽样日期：2026-07-22。上游 REST 基址由环境变量配置（文档占位：`https://ops-platform.example.corp/rest`），仓库不写真实域名。

## 1. 审核单 approve 状态迁移真值表

| code | 本仓库常量 | Orient `statusDesc`（真源） | 常见下一步 `changeStatus` |
|------|------------|-----------------------------|---------------------------|
| 1 | `WAIT_CHECK` | 待审核 | → 6 审核通过 / → 3 驳回 |
| 2 | `PUBLISH_PASS` | **发布成功** | 终态（同意发布目标码） |
| 3 | `CHECK_FAIL` | 审核驳回 | 终态 |
| 6 | `CHECK_PASS` | **审核成功**（非「审核通过」文案） | → 2 同意发布 / → 7 拒绝发布 |
| 7 | `PUBLISH_FAIL` | 发布失败 | 终态 |
| 10 | `PUSH_ALL` | （抽样队列空） | 勿与 status=2 混淆 |
| 12 | `BAN_WAIT_CHECK` | 封禁期待审核 | → 13 / → 14 |
| 13 | `BAN_CHECK_PASS` | 封禁期审核通过 | → 封禁期立即推全 type=2 |
| 14 | `BAN_CHECK_FAIL` | 封禁期审核驳回 | 终态 |

编排契约（工作台）：

- **normal**：`1→6→2`，再按 `displayQuickPushBtn` 条件 `quickPushAll?type=0`
- **ban**：`12→13`，再按封禁期按钮 `quickPushAll?type=2`
- **补跑**：白名单用户若卡在 **6**，只跑 `6→2` + 条件推全（不再打审核通过）
- **封禁期二次确认**（同意发布 / 立即推全同文案「是否确认提交审核」）：
  - `changeStatus` 自动带 `confirm=true`（body + query）重试
  - `quickPushAll` 自动带 `confirm=true`；仍提示则改 `type=1` 提交封禁期审批，交由 status=12 队列闭环

`6→2` 目标码确认为 **2**（Orient 操作名常显示为「发布成功」）。瞬时失败时有限重试；不盲改码值。

### 灰度旁路（2026-07-22 #24059）

- 审核通过后策略可能已进 **灰度中**（`lastStatus=8`），审核单仍停在 **审核成功(6)**。
- 此时 `changeStatus→2` 常返回：`操作[发布成功]无法应用于状态[审核成功]`。
- 同一张审核单内嵌的 `flowControl.toolBar.displayQuickPushBtn` 可为 **true**，而 `flowControl/get` 的 `toolBar` 可能为空。
- 编排：发布被拒且命中上述文案时，**仍按推全标志尝试 `quickPushAll`**（`publishBypassed`）；不以「通道探测成功」代替闭环成功。

## 2. 策略运行态 vs 审核单

- `*/get` 的 `status` / `statusDesc`（如「生效中」）与 `approve.status` **不是同一套枚举**。
- `greyStartTime` / `lastStatus=8` 说明策略侧灰度；**不代表**审核单已发布或已立即推全。
- 推全门闩：优先 `*/get` 的 `displayQuickPushBtn` / `toolBar`；缺失时回退审核单内嵌策略体。
- `approve/query?status=6` 列表可能长期为空，卡单依赖内存队列 / 按 id·ruleId 定点查。

## 3. 本轮不改的风险（A8 / A9）

### A8 — GET 多类型 vs POST 仅 orientControl

- 延期/续期：`get` 可探测 flow/dark/general/media；提交写死 `orientControl/mergeEditV2`。
- 自动延期只接受定向；扶持/暗投勿与审核失败混为一谈。

### A9 — 共享 Playwright 队列

- 查询 / 延期 / 审核 / 自动审共用 `orient_browser` 串行队列。
- 自动审在 `queue_busy()` 时跳过或提前结束；日志会写明，避免误判「白名单没扫到」。

## 4. 相关代码

- 常量与标签：`server/modules/strategy_audit/constants.py`
- 编排：`flows.py`、`auto_approve.py`
- 推全：`push_full.py`

## 5. 验收摘记（2026-07-22）

- 单元测试：`python3 -m unittest modules.strategy_audit.tests.test_flows_unit`（T1–T4 类）
- T6 `#23947`：审核单 `46102` 已为 status=2「发布成功」（已离开卡单 6）；策略「生效中」，推全按钮为 false
- T5 通道：同日早些时候对终态策略探测，Orient 能识别「立即推全 / 封禁期立即推全」操作名（业务拒绝 ≠ 通道挂）
