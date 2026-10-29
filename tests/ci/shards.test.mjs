import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inventory,
  browserInventory,
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

test("browser plans consume recursive official collection and preserve every project case exactly once", (t) => {
  const root = mkdtempSync(join(tmpdir(), "timenook-ci-browser-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "tests/admin");
  mkdirSync(join(directory, "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules/@playwright/test"), { recursive: true });
  for (const name of ["first.spec.ts", "nested/second.test.mjs"])
    writeFileSync(join(directory, name), "// fixture\n");
  const fixture = {
    config: { rootDir: directory },
    errors: [],
    suites: [
      {
        specs: [
          {
            id: "mobile-first",
            file: "first.spec.ts",
            tests: [{ projectName: "mobile" }],
          },
        ],
        suites: [
          {
            specs: [
              {
                id: "mobile-second",
                file: "nested/second.test.mjs",
                tests: [{ projectName: "mobile" }],
              },
              {
                id: "desktop-second",
                file: "nested/second.test.mjs",
                tests: [{ projectName: "desktop" }],
              },
            ],
          },
        ],
      },
    ],
  };
  // The lightweight changes job needs only Node, while the implementation still
  // obtains its inventory through the same official CLI entry point.
  writeFileSync(
    join(root, "node_modules/@playwright/test/cli.js"),
    `
const args = process.argv.slice(2);
if (!args.includes('--list') || !args.includes('--reporter=json') || !args.includes('playwright.admin.config.mjs')) process.exit(2);
console.log(${JSON.stringify(JSON.stringify(fixture))});
`,
  );
  const collected = browserInventory(root, "admin");
  assert.deepEqual(collected.files, [
    "tests/admin/first.spec.ts",
    "tests/admin/nested/second.test.mjs",
  ]);
  assert.equal(collected.cases.length, 3);
  const plans = [plan(root, "admin", 1), plan(root, "admin", 2)];
  assert.deepEqual(
    plans
      .flatMap((p) => p.cases)
      .map((c) => c.id)
      .sort(),
    ["desktop-second", "mobile-first", "mobile-second"],
  );
  assert.ok(plans.every((p) => p.allCases.length === 3));
  assert.deepEqual(inventory(root, "admin"), collected.files);
  const cli = join(root, "node_modules/@playwright/test/cli.js");
  fixture.suites[0].specs.push(fixture.suites[0].specs[0]);
  writeFileSync(
    cli,
    `console.log(${JSON.stringify(JSON.stringify(fixture))});\n`,
  );
  assert.throws(() => browserInventory(root, "admin"), /Duplicate/);
  writeFileSync(cli, "console.log('not-json');\n");
  assert.throws(() => browserInventory(root, "admin"), /Invalid/);
  writeFileSync(cli, "process.exit(1);\n");
  assert.throws(() => browserInventory(root, "admin"), /collection failed/);
});

test("matching Node glob entries that are symlinks or directories fail closed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "timenook-ci-special-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests/directory.test.ts"), { recursive: true });
  assert.throws(() => inventory(root, "frontend"), /regular file/);
  rmSync(join(root, "tests/directory.test.ts"), { recursive: true });
  writeFileSync(join(root, "tests/source.ts"), "");
  symlinkSync("source.ts", join(root, "tests/link.test.ts"));
  assert.throws(() => inventory(root, "frontend"), /regular file/);
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
