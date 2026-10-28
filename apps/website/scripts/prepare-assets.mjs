import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const target = new URL("../public/", import.meta.url);
// This generated directory contains only this explicit public asset allowlist.
await rm(target, { recursive: true, force: true });
await mkdir(new URL("assets/", target), { recursive: true });
for (const [source, name] of [
  ["design/brand/shiguangli-logo-original.jpg", "logo.jpg"],
  ["miniprogram/assets/book.jpg", "book.jpg"],
  ["miniprogram/assets/family.jpg", "family.jpg"],
]) {
  await copyFile(new URL(source, root), new URL(`assets/${name}`, target));
}
// The first delivery is a preview; promotion follows real WeChat acceptance.
await writeFile(new URL("robots.txt", target), "User-agent: *\nDisallow: /\n");
console.log(`Public website assets prepared: ${fileURLToPath(target)}`);
