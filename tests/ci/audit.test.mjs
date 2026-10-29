import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jobs, audit, expectedPhases } from "../../scripts/ci/audit.mjs";
import { plan } from "../../scripts/ci/tests.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "timenook-ci-audit-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "reports");
  const sha = "a".repeat(40);
  const write = (file, value) => writeFileSync(file, JSON.stringify(value));
  for (const [dir, suffix, count] of [
    ["tests", ".test.ts", 1],
    ["apps/api/test", ".test.ts", 4],
    ["tests/print-probe", ".test.mjs", 1],
    ["tests/release", ".test.mjs", 1],
    ["tests/admin", ".spec.mjs", 2],
    ["apps/website/tests", ".spec.ts", 1],
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
    for (let n = 0; n < count; n++)
      writeFileSync(join(root, dir, `${n}${suffix}`), "");
  }
  for (const [suite, groups] of Object.entries(jobs)) {
    const dir = join(directory, `ci-report-${suite}`);
    mkdirSync(dir, { recursive: true });
    write(join(dir, "phases.json"), {
      sha,
      suite,
      phases: expectedPhases(suite).map((name) => ({
        name,
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 1,
      })),
    });
    for (const [group, index] of groups) {
      const p = plan(root, group, index);
      write(join(dir, `${group}-plan.json`), { sha, ...p });
      const browser = ["admin", "website"].includes(group);
      const rows = p.files.map((file, n) => ({
        sha,
        suite,
        type: "test",
        file,
        id: `${file}-${n}`,
        name: "case",
        status: "passed",
        durationMs: 1,
      }));
      const events = browser
        ? [{ sha, suite, type: "plan", tests: rows.length, cases: rows }]
        : [];
      events.push(...rows, {
        sha,
        suite,
        type: "summary",
        file: null,
        files: p.files,
        status: "passed",
        counts: { tests: rows.length },
        durationMs: 1,
      });
      writeFileSync(
        join(dir, `${group}.jsonl`),
        events.map(JSON.stringify).join("\n") + "\n",
      );
    }
  }
  return { root, directory, sha, write };
}

test("aggregate validates all eight jobs and the exact union of test files", (t) => {
  const f = fixture(t);
  const report = audit(f.root, f.directory, f.sha);
  assert.equal(report.rows.length, 10);
  assert.equal(report.rows.filter((row) => row.group === "api").length, 4);
  assert.equal(report.sha, f.sha);
});

for (const failure of [
  "missing-shard",
  "stale-sha",
  "cancelled-phase",
  "missing-phase",
  "wrong-plan",
  "missing-case",
  "skipped-case",
  "empty-tests",
  "duplicate-case",
]) {
  test(`aggregate fails closed for ${failure}`, (t) => {
    const f = fixture(t);
    const dir = join(f.directory, "ci-report-browser-1");
    const phaseFile = join(dir, "phases.json");
    const file = join(dir, "admin.jsonl");
    let events = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    if (failure === "missing-shard") unlinkSync(phaseFile);
    if (failure === "stale-sha")
      events.forEach((row) => (row.sha = "b".repeat(40)));
    if (failure === "cancelled-phase" || failure === "missing-phase") {
      const phases = JSON.parse(readFileSync(phaseFile, "utf8"));
      if (failure === "cancelled-phase") phases.phases[0].signal = "SIGTERM";
      else phases.phases.pop();
      f.write(phaseFile, phases);
    }
    if (failure === "wrong-plan") {
      const p = join(dir, "admin-plan.json");
      const selected = JSON.parse(readFileSync(p, "utf8"));
      selected.files = ["tests/admin/unknown.spec.mjs"];
      f.write(p, selected);
    }
    if (failure === "missing-case")
      events = events.filter((row) => row.type !== "test");
    if (failure === "skipped-case")
      events.find((row) => row.type === "test").status = "skipped";
    if (failure === "empty-tests") events.at(-1).counts.tests = 0;
    if (failure === "duplicate-case") {
      events.splice(1, 0, { ...events[1] });
      events.at(-1).counts.tests++;
    }
    writeFileSync(file, events.map(JSON.stringify).join("\n") + "\n");
    assert.throws(() => audit(f.root, f.directory, f.sha));
  });
}
