"""
server/modules — 新功能分包目录

v5.5 引入，用于隔离新开发的功能模块，避免主 app.py 膨胀。

现有模块（不动）：
  - app.py（主入口）
  - chrome_cookie.py / chrome_proxy.py / chrome_renew.py
  - orient_browser.py

新功能模块（本包）：
  - strategy_probe.py：策略类型探测逻辑
    · has_strategy_data()  判断响应是否真的包含策略数据
    · STRATEGY_API_PREFIXES  策略类型 API 映射表
  - strategy_postpone/：策略延期托管
    · automation_postpone：表驱动自动延期 + 编辑权限 + 定时扫延
  - strategy_query/：策略实时查询（Operation orientControl/query）
    · live_query / orient_fields / parse_message
    · 用户主动查询时请求上游；meta 暴露最近查询时间
"""
