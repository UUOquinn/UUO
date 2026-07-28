#!/bin/bash
# 兼容旧入口名：等同 start-production.sh（Documents + guardian.sh run）
exec bash "$(cd "$(dirname "$0")" && pwd)/start-production.sh" "$@"
