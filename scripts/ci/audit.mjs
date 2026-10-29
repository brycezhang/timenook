import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, plan, sourceFile } from "./tests.mjs";

export const jobs = {
  build: [
    ["frontend", 1],
    ["print", 1],
    ["release", 1],
  ],
  "api-1": [["api", 1]],
  "api-2": [["api", 2]],
  "api-3": [["api", 3]],
  "api-4": [["api", 4]],
  "browser-1": [["admin", 1]],
  "browser-2": [["admin", 2]],
  website: [["website", 1]],
};
const setup = ["pnpm-setup", "pnpm-install"];
export function expectedPhases(suite) {
  if (suite === "build")
    return [
      ...setup,
      "prisma-generate",
      "print-font",
      "docs",
      "ci-report-tests",
      "typecheck",
      "frontend-tests",
      "print-tests",
      "release-tests",
      "build",
      "prisma-runtime",
      "candidate-package",
      "candidate-verify",
    ];
  if (suite === "website")
    return [...setup, "browser-install", "website-tests", "website-package"];
  return [
    ...setup,
    "audio-tools",
    "prisma-generate",
    "print-font",
    ...(suite.startsWith("browser") ? ["browser-install"] : []),
    "database-migrate",
    "contracts-build",
    "test-compile",
    ...(suite === "api-1" ? ["openapi"] : []),
    ...(suite.startsWith("browser")
      ? ["api-build", "admin-tests"]
      : ["api-tests"]),
  ];
}
const equal = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const requireThat = (condition, message) => {
  if (!condition) throw Error(message);
};

export function audit(root, directory, sha) {
  const rows = [];
  const phases = [];
  const groupFiles = new Map();
  for (const [suite, groups] of Object.entries(jobs)) {
    const reportDir = resolve(directory, `ci-report-${suite}`);
    const read = (name) =>
      JSON.parse(readFileSync(resolve(reportDir, name), "utf8"));
    const stage = read("phases.json");
    requireThat(
      stage.sha === sha && stage.suite === suite && stage.phases.length > 0,
      `Invalid phase report: ${suite}`,
    );
    requireThat(
      equal(
        stage.phases.map((phase) => phase.name),
        expectedPhases(suite),
      ),
      `Missing or duplicate phase: ${suite}`,
    );
    requireThat(
      stage.phases.every(
        (phase) =>
          phase.status === "passed" && phase.exitCode === 0 && !phase.signal,
      ),
      `Failed phase: ${suite}`,
    );
    phases.push(...stage.phases.map((phase) => ({ suite, ...phase })));
    for (const [group, index] of groups) {
      const expected = plan(root, group, index);
      const selected = read(`${group}-plan.json`);
      requireThat(
        selected.sha === sha &&
          selected.group === group &&
          selected.index === index &&
          selected.count === expected.count &&
          equal(selected.allFiles, expected.allFiles) &&
          equal(selected.files, expected.files),
        `Changed test plan: ${suite}/${group}`,
      );
      const events = readFileSync(resolve(reportDir, `${group}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      requireThat(
        events.every((row) => row.sha === sha && row.suite === suite),
        `Stale test report: ${suite}/${group}`,
      );
      const summary = events.findLast(
        (row) => row.type === "summary" && !row.file,
      );
      requireThat(
        summary?.status === "passed" && summary.counts.tests > 0,
        `Missing/failed/empty test summary: ${suite}/${group}`,
      );
      const tests = events.filter(
        (row) => row.type === "test" && row.kind !== "suite",
      );
      requireThat(
        tests.length > 0 && tests.every((row) => row.status === "passed"),
        `Unsuccessful tests: ${suite}/${group}`,
      );
      requireThat(
        equal(
          [...new Set(tests.map((row) => sourceFile(row.file)))],
          expected.files,
        ),
        `Missing executed test file: ${suite}/${group}`,
      );
      requireThat(
        equal([...new Set(summary.files.map(sourceFile))], expected.files),
        `Incomplete summary files: ${suite}/${group}`,
      );
      const identities = tests.map((row) => row.id);
      requireThat(
        tests.length === summary.counts.tests,
        `Inconsistent test count: ${suite}/${group}`,
      );
      if (["admin", "website"].includes(group)) {
        requireThat(
          new Set(identities).size === identities.length,
          `Duplicate test execution: ${suite}/${group}`,
        );
        const announced = events.find((row) => row.type === "plan");
        requireThat(
          announced?.tests === tests.length &&
            equal(
              announced.cases.map((row) => row.id),
              identities,
            ),
          `Incomplete browser cases: ${suite}/${group}`,
        );
      }
      const previous = groupFiles.get(group) ?? [];
      groupFiles.set(group, [...previous, ...expected.files]);
      rows.push({
        suite,
        group,
        files: expected.files.length,
        tests: tests.length,
        durationMs: summary.durationMs,
      });
    }
  }
  for (const [group, files] of groupFiles)
    requireThat(
      equal(files, inventory(root, group)) &&
        new Set(files).size === files.length,
      `Incomplete shard union: ${group}`,
    );
  return { schemaVersion: 1, sha, rows, phases };
}

function main() {
  const directory = resolve(process.argv[2]);
  const sha = process.env.CHECK_HEAD ?? process.env.GITHUB_SHA;
  const results = JSON.parse(process.env.CHECK_JOB_RESULTS ?? "{}");
  const errors = [];
  if (
    !["build", "api", "browser", "website"].every(
      (name) => results[name]?.result === "success",
    )
  )
    errors.push("A required parallel job failed, was cancelled or did not run");
  let report;
  try {
    report = audit(process.cwd(), directory, sha);
  } catch (error) {
    errors.push(error.message);
  }
  if (report) {
    writeFileSync(
      resolve(directory, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    const table =
      `## Complete CI execution\n\nCandidate: \`${sha}\`\n\n| Job | Group | Files | Tests | Test duration |\n| --- | --- | ---: | ---: | ---: |\n` +
      report.rows
        .map(
          (row) =>
            `| ${row.suite} | ${row.group} | ${row.files} | ${row.tests} | ${(row.durationMs / 1000).toFixed(1)}s |`,
        )
        .join("\n") +
      "\n";
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  }
  if (errors.length) throw Error(errors.join("; "));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
