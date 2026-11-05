import fs from "node:fs";
import { spawnSync } from "node:child_process";
const compiler =
  process.env.WECHAT_COMPILER_DIR ||
  "/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec";
if (!fs.existsSync(compiler + "/wcc")) {
  console.error(
    "WeChat compiler not found. Set WECHAT_COMPILER_DIR to the official DevTools wcc-exec directory.",
  );
  process.exit(1);
}
const root = process.argv.includes("--built")
  ? "dist/miniprogram"
  : "miniprogram";
const pages = JSON.parse(fs.readFileSync(root + "/app.json", "utf8")).pages;
const files = fs.readdirSync(root, { recursive: true });
for (const [tool, ext] of [
  ["wcc", ".wxml"],
  ["wcsc", ".wxss"],
]) {
  const sources = files.filter((file) => file.endsWith(ext));
  const result = spawnSync(
    compiler + "/" + tool,
    ["-o", "/dev/null", ...sources],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(result.status || 1);
  }
  console.log(`${tool}: ${pages.length} pages compiled successfully`);
}
