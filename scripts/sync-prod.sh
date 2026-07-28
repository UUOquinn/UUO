#!/bin/bash
# 生产即本仓库 Documents 目录，无需同步到 Application Support。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "生产目录即仓库本身（写死）："
echo "  $ROOT"
echo "无需 rsync。改完代码后若要热重启 app："
echo "  bash \"$ROOT/guardian.sh\" restart"
echo "完整拉起守护："
echo "  bash \"$ROOT/scripts/start-production.sh\""
