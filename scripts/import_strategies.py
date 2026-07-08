#!/usr/bin/env python3
"""将 策略信息全量表.xlsx 导入为 data/strategies.json"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("请先安装 openpyxl: pip install openpyxl")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = Path.home() / "Downloads" / "策略信息7.8.xlsx"
OUT_PATH = ROOT / "data" / "strategies.json"


def import_excel(xlsx_path: Path):
    if not xlsx_path.exists():
        raise FileNotFoundError(f"未找到 Excel 文件: {xlsx_path}")

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    headers = [str(h).strip() if h is not None else "" for h in next(rows_iter)]

    rows = []
    for row in rows_iter:
        if all(cell is None or str(cell).strip() == "" for cell in row):
            continue
        item = {}
        for i, field in enumerate(headers):
            if not field:
                continue
            val = row[i] if i < len(row) else None
            if val is None:
                item[field] = ""
            elif isinstance(val, float) and val == int(val):
                item[field] = str(int(val))
            else:
                item[field] = str(val).strip()
        rows.append(item)

    wb.close()

    payload = {
        "source": xlsx_path.name,
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "fields": headers,
        "rows": rows,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(f"已导入 {len(rows)} 条策略 → {OUT_PATH}")
    return payload


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    import_excel(src)
