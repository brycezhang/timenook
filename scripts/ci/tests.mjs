import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const suites = {
  frontend: { directory: "tests", suffix: ".test.ts", shards: 1 },
  api: { directory: "apps/api/test", suffix: ".test.ts", shards: 4 },
  print: { directory: "tests/print-probe", suffix: ".test.mjs", shards: 1 },
  release: { directory: "tests/release", suffix: ".test.mjs", shards: 1 },
  admin: { directory: "tests/admin", suffix: ".spec.mjs", shards: 2 },
  website: { directory: "apps/website/tests", suffix: ".spec.ts", shards: 1 },
};

// Initial scheduling weights from run 40707495160; these never exclude tests.
// Unknown/new files receive a default cost and are always included.
const costs = {
  "complete-export.test.ts": 269,
  "complete-export-stream.test.ts": 302,
  "complete-export-checkpoint.test.ts": 379,
  "complete-export-authority.test.ts": 390,
  "book-pdf.test.ts": 326,
  "fulfillment.test.ts": 325,
  "quality-care.test.ts": 304,
  "first-copy.test.ts": 299,
  "deletion-recovery.test.ts": 170,
  "active-data-writes.test.ts": 139,
  "transcription.test.ts": 134,
  "story-generation.test.ts": 125,
  "story-confirmation.test.ts": 99,
  "privacy-upgrade.test.ts": 95,
  "refunds.test.ts": 90,
  "withdrawal.test.ts": 85,
  "deletion-review.test.ts": 85,
  "followups.test.ts": 80,
  "deletion-retention.test.ts": 77,
  "deletion-quality.test.ts": 71,
  "book-audio.test.ts": 67,
  "story-photos.test.ts": 53,
};

export function inventory(root, group) {
  const suite = suites[group];
  if (!suite) throw Error("Unknown CI test group");
  const files = readdirSync(resolve(root, suite.directory), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suite.suffix))
    .map((entry) => `${suite.directory}/${entry.name}`)
    .sort();
  if (!files.length) throw Error(`Empty CI test group: ${group}`);
  return files;
}

export function partitions(files, group, count = suites[group]?.shards) {
  if (!Number.isInteger(count) || count < 1 || files.length < count)
    throw Error("Invalid or empty CI shards");
  if (new Set(files).size !== files.length)
    throw Error("Duplicate CI test file");
  const bins = Array.from({ length: count }, () => ({ files: [], cost: 0 }));
  const weight = (file) => costs[basename(file)] ?? 30;
  const sorted = [...files].sort(
    (a, b) => weight(b) - weight(a) || a.localeCompare(b),
  );
  // The four long export scenarios deliberately start on separate runners.
  const anchors =
    group === "api"
      ? sorted.filter((file) =>
          /\/complete-export(?:-[^/]+)?\.test\.ts$/.test(file),
        )
      : [];
  for (const [index, file] of anchors.entries()) {
    const bin = bins[index % count];
    bin.files.push(file);
    bin.cost += weight(file);
  }
  for (const file of sorted.filter((file) => !anchors.includes(file))) {
    const bin = bins.reduce((best, candidate) =>
      candidate.cost < best.cost ? candidate : best,
    );
    bin.files.push(file);
    bin.cost += weight(file);
  }
  return bins.map((bin) => bin.files.sort());
}

export function plan(root, group, index = 1, count = suites[group]?.shards) {
  if (
    count !== suites[group]?.shards ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  )
    throw Error("Unexpected CI shard coordinates");
  const allFiles = inventory(root, group);
  return {
    group,
    index,
    count,
    allFiles,
    files: partitions(allFiles, group, count)[index - 1],
  };
}

export function sourceFile(file) {
  return file
    .replace("apps/api/dist-test/test/", "apps/api/test/")
    .replace(/(apps\/api\/test\/.*)\.js$/, "$1.ts");
}

function main() {
  const [group, indexText = "1"] = process.argv.slice(2);
  const root = resolve(process.env.TIMENOOK_CI_ROOT ?? ".");
  const selected = plan(root, group, Number(indexText));
  const directory = process.env.TIMENOOK_CI_REPORT_DIR;
  if (!directory) throw Error("TIMENOOK_CI_REPORT_DIR is required");
  mkdirSync(directory, { recursive: true });
  const sha = process.env.CHECK_HEAD ?? process.env.GITHUB_SHA ?? "local";
  writeFileSync(
    resolve(directory, `${group}-plan.json`),
    JSON.stringify({ schemaVersion: 1, sha, ...selected }, null, 2) + "\n",
  );
  const report = resolve(directory, `${group}.jsonl`);
  const reporter = resolve(root, "scripts/ci/node-reporter.mjs");
  let cwd = root;
  let command = process.execPath;
  let args;
  if (["admin", "website"].includes(group)) {
    cwd = group === "website" ? resolve(root, "apps/website") : root;
    args = [resolve(root, "node_modules/@playwright/test/cli.js"), "test"];
    if (group === "admin") args.push("-c", "playwright.admin.config.mjs");
    args.push(
      "--reporter=line," + resolve(root, "scripts/ci/playwright-reporter.mjs"),
    );
    args.push(
      ...selected.files.map(
        (file) =>
          relative(cwd, resolve(root, file)).replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          ) + "$",
      ),
    );
  } else {
    const flags = [
      "--test",
      "--test-reporter=tap",
      "--test-reporter-destination=stdout",
      `--test-reporter=${reporter}`,
      `--test-reporter-destination=${report}`,
    ];
    if (group === "frontend") {
      command = resolve(root, "node_modules/.bin/tsx");
      flags.push("--test-timeout=30000");
    }
    if (group === "api") cwd = resolve(root, "apps/api");
    const files = selected.files.map((file) =>
      group === "api"
        ? `dist-test/test/${basename(file).replace(/\.ts$/, ".js")}`
        : relative(cwd, resolve(root, file)),
    );
    args = [...flags, ...files];
  }
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      TIMENOOK_CI_ROOT: root,
      TIMENOOK_CI_TEST_REPORT: report,
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
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
