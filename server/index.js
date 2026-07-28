/**
 * 轻量静态托管（npm run dev 备用入口）
 * 生产环境请使用 python3 server/app.py（策略 API + Playwright）
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const STATIC_DIR = path.resolve(__dirname, "..");

app.use(express.static(STATIC_DIR));

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
    message: "请使用 python3 server/app.py 启动完整后端",
  });
});

app.listen(PORT, () => {
  console.log(`\n  静态托管已启动: http://localhost:${PORT}`);
  console.log(`  策略 API 需运行: python3 server/app.py\n`);
});
