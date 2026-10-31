import fs from "node:fs";
import { spawnSync } from "node:child_process";
const compiler =
  process.env.WECHAT_COMPILER_DIR ||
  "/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc-exec";
if (!fs.existsSync(compiler + "/wcc")) {
  console.error(
    "WeChat compiler not found. Set WECHAT_COMPILER_DIR to the official DevTools wcc-exec directory.",
  );
  process.exit(1);
}
const pages = JSON.parse(fs.readFileSync("miniprogram/app.json", "utf8")).pages;
const sources = [...pages, "custom-tab-bar/index"];
for (const [tool, ext, extra] of [
  ["wcc", ".wxml", []],
  ["wcsc", ".wxss", ["app.wxss", "styles/tokens.wxss"]],
]) {
  const result = spawnSync(
    compiler + "/" + tool,
    ["-o", "/dev/null", ...sources.map((p) => p + ext), ...extra],
    { cwd: "miniprogram", encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(result.status || 1);
  }
  console.log(`${tool}: ${pages.length} pages compiled successfully`);
}
