import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inventory,
  partitions,
  plan,
  sourceFile,
} from "../../scripts/ci/tests.mjs";

test("all existing and new files run exactly once, with export scenarios on distinct shards", () => {
  const files = [
    "complete-export",
    "complete-export-stream",
    "complete-export-checkpoint",
    "complete-export-authority",
    "new-feature",
    "book-pdf",
    "refunds",
  ].map((name) => `apps/api/test/${name}.test.ts`);
  const shards = partitions(files, "api");
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.deepEqual(partitions([...files].reverse(), "api"), shards);
  assert.ok(
    shards.every(
      (shard) =>
        shard.filter((file) => file.includes("complete-export")).length === 1,
    ),
  );
  assert.throws(() => partitions([...files, files[0]], "api"), /Duplicate/);
});

test("test inventory matches original non-recursive globs and rejects empty or wrong coordinates", (t) => {
  const root = mkdtempSync(join(tmpdir(), "timenook-ci-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps/api/test/nested"), { recursive: true });
  for (const name of [
    "a.test.ts",
    "b.test.ts",
    "c.test.ts",
    "d.test.ts",
    "helper.ts",
    "nested/ignored.test.ts",
  ])
    writeFileSync(join(root, "apps/api/test", name), "");
  assert.equal(inventory(root, "api").length, 4);
  assert.equal(plan(root, "api", 1).files.length, 1);
  assert.throws(() => plan(root, "api", 0));
  assert.throws(() => plan(root, "api", 5));
  assert.throws(() => plan(root, "api", 1, 3));
  assert.throws(() => inventory(root, "unknown"));
  assert.equal(
    sourceFile("apps/api/dist-test/test/refunds.test.js"),
    "apps/api/test/refunds.test.ts",
  );
});
