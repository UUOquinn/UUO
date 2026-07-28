"""策略审核域常量 — 与 Operation / Orient 枚举对齐。

真值表见 docs/ORIENT-CONTRACT.md（2026-07-22 抽样）。
Orient statusDesc 以平台返回为准；本表 LABEL 与之对齐。
"""

# ─── approve 状态码 ───
WAIT_CHECK = 1
PUBLISH_PASS = 2          # 同意发布 → Orient 文案「发布成功」
CHECK_FAIL = 3
CHECK_PASS = 6            # 审核通过动作；Orient 文案「审核成功」
PUBLISH_FAIL = 7
PUSH_GREY = 8
PUSH_ALL = 10             # 平台侧「推全」相关（与 status=2 不同码）
PUSH_FAIL = 11
BAN_WAIT_CHECK = 12       # 封禁期待审核
BAN_CHECK_PASS = 13       # 封禁期审核通过
BAN_CHECK_FAIL = 14       # 封禁期审核驳回
BAN_QUICK_PUSH = 15       # 封禁期立即推全（策略侧状态）
GREY_FINISH = 16

# Orient approve/query 返回的 statusDesc（真源）
APPROVE_STATUS_LABEL = {
    WAIT_CHECK: "待审核",
    PUBLISH_PASS: "发布成功",
    CHECK_FAIL: "审核驳回",
    CHECK_PASS: "审核成功",
    PUBLISH_FAIL: "发布失败",
    PUSH_ALL: "发布成功(10)",
    BAN_WAIT_CHECK: "封禁期待审核",
    BAN_CHECK_PASS: "封禁期审核通过",
    BAN_CHECK_FAIL: "封禁期审核驳回",
}

# changeStatus 目标状态 → 优先查询的前置 approve 状态
TARGET_TO_QUERY_STATUS = {
    CHECK_PASS: WAIT_CHECK,
    CHECK_FAIL: WAIT_CHECK,
    PUBLISH_PASS: CHECK_PASS,
    PUBLISH_FAIL: CHECK_PASS,
    BAN_CHECK_PASS: BAN_WAIT_CHECK,
    BAN_CHECK_FAIL: BAN_WAIT_CHECK,
}

# resolve 未指定状态时的搜索顺序（含封禁期）
RESOLVE_STATUS_ORDER = [
    WAIT_CHECK, PUBLISH_PASS, CHECK_FAIL, CHECK_PASS,
    PUBLISH_FAIL, PUSH_ALL, BAN_WAIT_CHECK, BAN_CHECK_PASS, BAN_CHECK_FAIL,
]

# 同意发布（6→2）有限重试；间隔用退避，缓解 Orient 状态未就绪
PUBLISH_RETRY_TIMES = 4
PUBLISH_RETRY_INTERVAL = 1.0
# 审核通过 → 同意发布 之间的固定等待（秒）
CHECK_TO_PUBLISH_DELAY = 0.5
# 发布成功后推全轮询（首次立即查，失败再隔 interval）
PUSH_POLL_TIMES = 4
PUSH_POLL_INTERVAL = 0.8
# 发布退避上限（秒）
PUBLISH_BACKOFF_CAP = 6.0

# ─── quickPushAll type ───
QUICK_PUSH_NORMAL = 0          # 立即推全
QUICK_PUSH_BAN_SUBMIT = 1      # 提交封禁期审批（封禁期确认后兜底）
QUICK_PUSH_BAN = 2             # 封禁期立即推全

# 支持 quickPushAll 的策略 API 前缀（Operation 前端契约）
QUICK_PUSH_PREFIXES = ("orientControl", "darkControl", "flowControl")

ORIENT_REST_BASE = "https://operation-tool.corp.kuaishou.com/operation-tool/rest"
APPROVE_QUERY_PATH = "/approve/query"
APPROVE_CHANGE_PATH = "/approve/changeStatus"

# 详情上判断是否可推全的按钮标志位
FLAG_QUICK_PUSH = "displayQuickPushBtn"
FLAG_BAN_QUICK_PUSH = "displayProhibitionPeriodQuickPushBtn"
FLAG_PUSH = "displayPushBtn"
