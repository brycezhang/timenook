import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
test("product distribution excludes prototype authentication and publishes complete MP3 notices/source", async () => {
  const dist = join(root, "apps/web/dist");
  for (const name of await readdir(join(root, "third-party/lamejs-1.2.7"))) {
    assert.deepEqual(
      await readFile(join(dist, "third-party/lamejs-1.2.7", name)),
      await readFile(join(root, "third-party/lamejs-1.2.7", name)),
      `published encoder source/notice ${name}`,
    );
  }
  for (const name of await readdir(join(dist, "assets"))) {
    if (!/\.(js|css)$/.test(name)) continue;
    assert.doesNotMatch(
      await readFile(join(dist, "assets", name), "utf8"),
      /状态预览|accountPreview|loginOutcome|mock-session|mock-purchases|preview\/runtime|designs\/timenook/,
      `formal product asset ${name}`,
    );
  }
});
