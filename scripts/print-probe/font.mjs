import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export const FONT = Object.freeze({
  name: "Noto Sans CJK SC Regular",
  version: "2.004",
  license: "SIL Open Font License 1.1",
  url: "https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
  sha256: "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b",
});
export const fontPath = new URL(
  "../../.cache/print-probe/NotoSansCJKsc-Regular.otf",
  import.meta.url,
);
export async function readFont() {
  const bytes = await readFile(fontPath);
  if (createHash("sha256").update(bytes).digest("hex") !== FONT.sha256)
    throw Error("FONT_INTEGRITY_FAILED");
  return bytes;
}
