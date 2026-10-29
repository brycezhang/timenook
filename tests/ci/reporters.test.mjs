import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = resolve(".");
const runner = resolve("scripts/ci/run.mjs");
const nodeReporter = resolve("scripts/ci/node-reporter.mjs");
const browserReporter = resolve("scripts/ci/playwright-reporter.mjs");
const secret = "REPORT_MUST_NOT_CONTAIN_THIS_PRIVATE_VALUE";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "timenook-ci-report-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    TIMENOOK_CI_REPORT_DIR: dir,
    TIMENOOK_CI_ROOT: dir,
    TIMENOOK_CI_SUITE: "fixture",
    CHECK_HEAD: "a".repeat(40),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    PRIVATE_CI_FIXTURE: secret,
  };
  delete env.NODE_TEST_CONTEXT;
  return { dir, env };
}
const lines = (file) =>
  readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);

test("phase runner preserves success and failure, appends timings, and persists no command or output", (t) => {
  const f = fixture(t);
  for (const code of [0, 7]) {
    const result = spawnSync(
      process.execPath,
      [
        runner,
        `phase-${code}`,
        process.execPath,
        "-e",
        `console.log(process.env.PRIVATE_CI_FIXTURE); process.exit(${code})`,
      ],
      { env: f.env, encoding: "utf8" },
    );
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, new RegExp(secret));
  }
  const raw = readFileSync(join(f.dir, "phases.json"), "utf8");
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes("PRIVATE_CI_FIXTURE"));
  const report = JSON.parse(raw);
  assert.equal(report.sha, f.env.CHECK_HEAD);
  assert.equal(report.suite, "fixture");
  assert.deepEqual(
    report.phases.map((x) => x.status),
    ["passed", "failed"],
  );
  assert.deepEqual(
    report.phases.map((x) => x.exitCode),
    [0, 7],
  );
  for (const phase of report.phases) {
    assert.ok(Number.isFinite(phase.durationMs) && phase.durationMs >= 0);
    assert.ok(Date.parse(phase.endedAt) >= Date.parse(phase.startedAt));
  }
  assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8"), /phase-7/);
});

test("phase runner records missing commands and termination as failures", (t) => {
  const f = fixture(t);
  const missing = spawnSync(
    process.execPath,
    [runner, "missing", "timenook-command-does-not-exist"],
    {
      env: f.env,
      encoding: "utf8",
    },
  );
  assert.notEqual(missing.status, 0);
  const killed = spawnSync(
    process.execPath,
    [
      runner,
      "killed",
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ],
    {
      env: f.env,
      encoding: "utf8",
    },
  );
  assert.notEqual(killed.status, 0);
  const report = JSON.parse(readFileSync(join(f.dir, "phases.json"), "utf8"));
  assert.equal(report.phases.length, 2);
  assert.equal(report.phases[1].signal, "SIGTERM");
  assert.ok(report.phases.every((x) => x.status === "failed"));
});

test("Node reporter captures nested test and file totals without stdout, errors, diagnostics or skip reasons", (t) => {
  const f = fixture(t);
  const file = join(f.dir, "sample.test.mjs");
  writeFileSync(
    file,
    `import { test } from 'node:test';
test('parent', async t => { await t.test('child', () => console.log(${JSON.stringify(secret)})); });
test('failure', t => { t.diagnostic(${JSON.stringify(secret)}); throw Error(${JSON.stringify(secret)}); });
test('skipped', { skip: ${JSON.stringify(secret)} }, () => {});
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-reporter=${nodeReporter}`,
      `--test-reporter-destination=${join(f.dir, "tests.jsonl")}`,
      file,
    ],
    { env: f.env, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  const raw = readFileSync(join(f.dir, "tests.jsonl"), "utf8");
  assert.ok(!raw.includes(secret));
  const report = lines(join(f.dir, "tests.jsonl"));
  const tests = report.filter((x) => x.type === "test");
  assert.deepEqual(tests.map((x) => x.name).sort(), [
    "child",
    "failure",
    "parent",
    "skipped",
  ]);
  assert.equal(tests.find((x) => x.name === "child").nesting, 1);
  assert.equal(tests.find((x) => x.name === "failure").status, "failed");
  assert.equal(tests.find((x) => x.name === "skipped").status, "skipped");
  assert.ok(tests.every((x) => x.file === "sample.test.mjs"));
  const summary = report.findLast(
    (x) => x.type === "summary" && x.file === null,
  );
  assert.equal(summary.status, "failed");
  assert.equal(summary.counts.tests, 4);
  assert.equal(summary.counts.skipped, 1);
  assert.deepEqual(summary.files, ["sample.test.mjs"]);
});

test("Node reporter exposes an empty file so the aggregate gate can reject an empty suite", (t) => {
  const f = fixture(t);
  const file = join(f.dir, "empty.test.mjs");
  writeFileSync(file, "// deliberately empty fixture\n");
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-reporter=${nodeReporter}`,
      `--test-reporter-destination=${join(f.dir, "tests.jsonl")}`,
      file,
    ],
    { env: f.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = lines(join(f.dir, "tests.jsonl"));
  assert.ok(report.some((x) => x.file === "empty.test.mjs"));
  assert.equal(
    report.findLast((x) => x.type === "summary" && x.file === null).counts
      .tests,
    0,
  );
});

test("Node reporter retains every completed file and suite identity across multiple workers", (t) => {
  const f = fixture(t);
  const files = ["one.test.mjs", "two.test.mjs"].map((name) =>
    join(f.dir, name),
  );
  writeFileSync(
    files[0],
    "import {describe,it} from 'node:test'; describe('suite',()=>it('first',()=>{}));\n",
  );
  writeFileSync(
    files[1],
    "import {test} from 'node:test'; test('second',()=>{});\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=2",
      `--test-reporter=${nodeReporter}`,
      `--test-reporter-destination=${join(f.dir, "tests.jsonl")}`,
      ...files,
    ],
    { env: f.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = lines(join(f.dir, "tests.jsonl"));
  const summary = report.findLast(
    (x) => x.type === "summary" && x.file === null,
  );
  assert.deepEqual(summary.files, ["one.test.mjs", "two.test.mjs"]);
  assert.equal(summary.counts.tests, 2);
  assert.equal(summary.counts.suites, 1);
  assert.equal(summary.counts.passed, 2);
  assert.equal(
    report.filter((x) => x.type === "summary" && x.file !== null).length,
    2,
  );
});

test("Playwright reporter records all project cases and final status without error or attachment content", (t) => {
  const f = fixture(t);
  const testModule = pathToFileURL(
    join(root, "node_modules/@playwright/test/index.mjs"),
  ).href;
  writeFileSync(
    join(f.dir, "sample.spec.mjs"),
    `import { test, expect } from ${JSON.stringify(testModule)};
test('success', () => expect(1).toBe(1));
test('failure', async () => { console.log(${JSON.stringify(secret)}); await test.info().attach('private', { body: ${JSON.stringify(secret)}, contentType: 'text/plain' }); throw Error(${JSON.stringify(secret)}); });
`,
  );
  writeFileSync(
    join(f.dir, "playwright.config.mjs"),
    `export default { testDir: ${JSON.stringify(f.dir)}, workers: 1, retries: 0, reporter: [[${JSON.stringify(browserReporter)}]], projects: [{name:'mobile'}, {name:'desktop'}], outputDir: ${JSON.stringify(join(f.dir, "output"))} };`,
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      join(f.dir, "playwright.config.mjs"),
    ],
    {
      env: f.env,
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.notEqual(result.status, 0);
  const raw = readFileSync(join(f.dir, "tests.jsonl"), "utf8");
  assert.ok(!raw.includes(secret));
  const report = lines(join(f.dir, "tests.jsonl"));
  assert.equal(report[0].type, "plan");
  assert.equal(report[0].tests, 4);
  assert.deepEqual(report[0].files, ["sample.spec.mjs"]);
  const tests = report.filter((x) => x.type === "test");
  assert.equal(tests.length, 4);
  assert.deepEqual([...new Set(tests.map((x) => x.project))].sort(), [
    "desktop",
    "mobile",
  ]);
  assert.equal(report.at(-1).status, "failed");
  assert.equal(report.at(-1).counts.tests, 4);
  assert.equal(report.at(-1).counts.failed, 2);
});

test("Playwright reporter exposes an empty plan and process failure without collecting global errors", (t) => {
  const f = fixture(t);
  const output = join(f.dir, "explicit-report.jsonl");
  writeFileSync(
    join(f.dir, "playwright.config.mjs"),
    `export default { testDir: ${JSON.stringify(f.dir)}, reporter: [[${JSON.stringify(browserReporter)}]] };`,
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      join(f.dir, "playwright.config.mjs"),
    ],
    {
      env: { ...f.env, TIMENOOK_CI_TEST_REPORT: output },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.notEqual(result.status, 0);
  const report = lines(output);
  assert.equal(report[0].type, "plan");
  assert.equal(report[0].tests, 0);
  assert.equal(report.at(-1).status, "failed");
  assert.equal(report.at(-1).counts.tests, 0);
});
