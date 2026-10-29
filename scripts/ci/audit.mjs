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
      "browser-install",
      "database-migrate",
      "docs",
      "ci-report-tests",
      "typecheck",
      "frontend-tests",
      "print-tests",
      "release-tests",
      "build",
      "openapi",
      "prisma-runtime",
      "candidate-package",
      "candidate-verify",
    ];
  if (suite === "website")
    return [
      ...setup,
      "browser-install",
      "docs",
      "website-typecheck",
      "website-build",
      "website-tests",
      "website-package",
      "website-verify",
    ];
  return [
    ...setup,
    "audio-tools",
    "prisma-generate",
    "print-font",
    "browser-install",
    "database-migrate",
    "contracts-build",
    "test-compile",
    ...(suite.startsWith("browser")
      ? ["api-build", "admin-tests"]
      : ["api-tests"]),
  ];
}
const equal = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const caseKeys = (cases, withProject = false) =>
  cases.map((row) =>
    JSON.stringify(
      withProject ? [row.id, row.file, row.project] : [row.id, row.file],
    ),
  );
const requireThat = (condition, message) => {
  if (!condition) throw Error(message);
};

export function audit(root, directory, sha, mode = "full") {
  requireThat(["full", "website"].includes(mode), "Unknown CI audit mode");
  requireThat(
    typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    "Invalid CI candidate SHA",
  );
  const rows = [];
  const phases = [];
  const groupFiles = new Map();
  const selectedJobs = mode === "website" ? { website: jobs.website } : jobs;
  for (const [suite, groups] of Object.entries(selectedJobs)) {
    const reportDir =
      mode === "website" ? directory : resolve(directory, `ci-report-${suite}`);
    const read = (name) =>
      JSON.parse(readFileSync(resolve(reportDir, name), "utf8"));
    const stage = read("phases.json");
    requireThat(
      stage.sha === sha &&
        stage.suite === suite &&
        Array.isArray(stage.phases) &&
        stage.phases.length > 0,
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
    requireThat(
      stage.phases.every(
        (phase) => Number.isFinite(phase.durationMs) && phase.durationMs >= 0,
      ),
      `Invalid phase duration: ${suite}`,
    );
    phases.push(
      ...stage.phases.map((phase) => {
        const timing = {};
        for (const name of ["startedAt", "endedAt"])
          if (phase[name] !== undefined) {
            requireThat(
              typeof phase[name] === "string" &&
                Number.isFinite(Date.parse(phase[name])),
              `Invalid phase timestamp: ${suite}`,
            );
            timing[name] = new Date(phase[name]).toISOString();
          }
        return {
          suite,
          name: phase.name,
          status: phase.status,
          exitCode: phase.exitCode,
          signal: phase.signal ?? null,
          durationMs: phase.durationMs,
          ...timing,
        };
      }),
    );
    for (const [group, index] of groups) {
      const expected = plan(root, group, index);
      if (group === "website")
        requireThat(
          equal(
            [...new Set(expected.allCases.map((row) => row.project))],
            ["compact-mobile", "desktop", "mobile"],
          ),
          "Website discovery must include all three projects",
        );
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
      const summaries = events.filter(
        (row) => row.type === "summary" && !row.file,
      );
      const summary = summaries[0];
      requireThat(
        summaries.length === 1 &&
          events.at(-1) === summary &&
          summary?.status === "passed" &&
          summary.counts.tests > 0 &&
          Number.isFinite(summary.durationMs) &&
          summary.durationMs >= 0,
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
          equal(
            caseKeys(selected.allCases, true),
            caseKeys(expected.allCases, true),
          ) &&
            equal(
              caseKeys(selected.cases, true),
              caseKeys(expected.cases, true),
            ) &&
            equal(caseKeys(tests, true), caseKeys(expected.cases, true)),
          `Browser discovery differs from execution: ${suite}/${group}`,
        );
        requireThat(
          new Set(identities).size === identities.length,
          `Duplicate test execution: ${suite}/${group}`,
        );
        const announcements = events.filter((row) => row.type === "plan");
        const announced = announcements[0];
        requireThat(
          announcements.length === 1 &&
            announced?.tests === tests.length &&
            equal(caseKeys(announced.cases), caseKeys(expected.cases)),
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
  return { schemaVersion: 1, mode, sha, rows, phases };
}

function main() {
  const [directoryArgument, mode = "full", ...extra] = process.argv.slice(2);
  requireThat(
    Boolean(directoryArgument) &&
      !extra.length &&
      ["full", "website"].includes(mode),
    "Invalid CI audit arguments",
  );
  const directory = resolve(directoryArgument);
  const sha = process.env.CHECK_HEAD ?? process.env.GITHUB_SHA;
  const errors = [];
  if (mode === "full") {
    const results = JSON.parse(process.env.CHECK_JOB_RESULTS ?? "{}");
    if (
      !["build", "api", "browser", "website"].every(
        (name) => results[name]?.result === "success",
      )
    )
      errors.push(
        "A required parallel job failed, was cancelled or did not run",
      );
  }
  let report;
  try {
    report = audit(process.cwd(), directory, sha, mode);
  } catch (error) {
    errors.push("CI execution report validation failed");
  }
  if (report) {
    writeFileSync(
      resolve(directory, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    const table =
      `## ${mode === "website" ? "Website" : "Complete"} CI execution\n\nCandidate: \`${sha}\`\n\n| Job | Group | Files | Tests | Test duration |\n| --- | --- | ---: | ---: | ---: |\n` +
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
    console.error("CI execution audit failed");
    process.exitCode = 1;
  }
}
