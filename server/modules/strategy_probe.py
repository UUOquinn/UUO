"""
strategy_probe — 策略类型探测模块

v5.5 新增，解决扶持策略查询失败的问题。

Orient 平台的 orientControl/get 接口对不存在的策略也返回 status=200，
但 data 字段为空（None 或空 dict），导致「策略类型自动探测」逻辑
误判为命中定向策略，从而跳过 flowControl 等真正的策略类型。

本模块提供 has_strategy_data() 二次校验，判断响应是否真的包含
策略数据，避免空壳响应干扰探测流程。

导出：
  - has_strategy_data(resp_data)  判断响应是否包含真实策略数据
  - STRATEGY_API_PREFIXES          策略类型 API 前缀映射表
"""

# ─── 策略类型 API 映射表 ───
# Orient 平台不同策略类型使用不同的 API 前缀
# 格式: (api_prefix, type_label)
#   api_prefix:  URL 路径段，如 orientControl → /operation-tool/rest/orientControl/get
#   type_label:  中文标签，用于日志和返回数据标注
#
# 探测顺序：从上到下依次尝试，第一个 has_strategy_data 返回 True 的即为命中类型
STRATEGY_API_PREFIXES = [
    ("orientControl",  "定向策略"),   # /operation-tool/rest/orientControl/get
    ("flowControl",    "扶持策略"),    # /operation-tool/rest/flowControl/get
    ("darkControl",    "暗投策略"),    # /operation-tool/rest/darkControl/get
    ("generalControl", "综合策略"),   # /operation-tool/rest/generalControl/get
    ("mediaControl",   "媒体策略"),   # /operation-tool/rest/mediaControl/get
]


def has_strategy_data(resp_data):
    """检查 Orient API 响应是否真的包含策略数据

    背景：
        Orient 的 orientControl/get 接口有一个坑——即使查询的策略 ID
        不属于定向策略（比如实际是扶持策略），接口也会返回 status=200，
        但 data 字段为 None 或空 dict。如果只看 status，会误判命中。

    校验逻辑：
        1. resp_data 本身必须是 dict 且非空
        2. resp_data["data"] 必须存在且非空
        3. data 是 dict 时，至少包含一个策略标识字段（id / ruleId / name）
        4. data 是 list 时，长度 > 0 即视为有效

    Args:
        resp_data: Orient API 返回的完整 JSON 响应 dict

    Returns:
        True  — 响应包含真实策略数据，可以信任
        False — 响应为空壳（status=200 但 data 为空），需要继续尝试下一个类型

    Examples:
        >>> has_strategy_data({"status": 200, "data": {"id": 123, "name": "测试"}})
        True
        >>> has_strategy_data({"status": 200, "data": None})
        False
        >>> has_strategy_data({"status": 200, "data": {}})
        False
    """
    if not resp_data:
        return False

    if not isinstance(resp_data, dict):
        return False

    data = resp_data.get("data")
    if data is None:
        return False

    # data 是 dict（单条策略详情）
    if isinstance(data, dict):
        # 空 dict 视为空壳
        if not data:
            return False
        # 检查是否包含策略标识字段
        # Orient 策略响应通常包含 id 或 ruleId 或 name 中的至少一个
        if data.get("id") is not None:
            return True
        if data.get("ruleId") is not None:
            return True
        if data.get("name") is not None:
            return True
        # data 有内容但无标准标识字段
        # 保守处理：如果有其他业务字段，视为有效
        # 但如果只有 totalCount/pager 等分页字段，视为空壳
        pagination_keys = {"totalCount", "pager", "pageNum", "pageSize"}
        business_keys = set(data.keys()) - pagination_keys
        return len(business_keys) > 0

    # data 是 list（策略列表）
    if isinstance(data, list):
        return len(data) > 0

    # data 是其他类型（字符串、数字等），非空即视为有效
    return bool(data)


def get_strategy_type_label(api_prefix):
    """根据 API 前缀获取策略类型中文标签

    Args:
        api_prefix: API 前缀，如 "orientControl"

    Returns:
        对应的中文标签，如 "定向策略"；未匹配时返回 None
    """
    for prefix, label in STRATEGY_API_PREFIXES:
        if prefix == api_prefix:
            return label
    return None
