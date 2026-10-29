import { relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

// TestsStream can include error objects, stdout and diagnostic payloads. Persist
// only the timing/identity fields needed to audit complete CI execution.
export default async function* report(source) {
  const root = realpathSync(
    process.env.TIMENOOK_CI_ROOT ??
      process.env.GITHUB_WORKSPACE ??
      process.cwd(),
  );
  const path = (file) =>
    file
      ? relative(root, realpathSync(resolve(file)))
          .split(sep)
          .join("/")
      : null;
  const metadata = {
    schemaVersion: 1,
    suite: process.env.TIMENOOK_CI_SUITE ?? null,
    sha: process.env.CHECK_HEAD ?? process.env.GITHUB_SHA ?? null,
  };
  const files = new Set();
  const containers = { tests: 0, passed: 0, failed: 0, topLevel: 0 };
  for await (const { type, data } of source) {
    if (type === "test:pass" || type === "test:fail") {
      const file = path(data.file);
      if (file) files.add(file);
      const container = data.name === data.file;
      const status =
        data.skip !== undefined && data.skip !== false
          ? "skipped"
          : data.todo !== undefined && data.todo !== false
            ? "todo"
            : type === "test:pass"
              ? "passed"
              : "failed";
      if (container) {
        containers.tests++;
        containers.topLevel++;
        containers[type === "test:pass" ? "passed" : "failed"]++;
      }
      yield JSON.stringify({
        ...metadata,
        type: container ? "file" : "test",
        file,
        name: container ? file : data.name,
        status,
        durationMs: data.details.duration_ms,
        nesting: data.nesting,
        testNumber: data.testNumber,
        kind: data.details.type ?? "test",
      }) + "\n";
    } else if (type === "test:summary") {
      const file = path(data.file);
      if (file) files.add(file);
      const counts = {};
      for (const key of [
        "tests",
        "passed",
        "failed",
        "cancelled",
        "skipped",
        "todo",
        "suites",
        "topLevel",
      ])
        counts[key] = data.counts[key] ?? 0;
      if (!file)
        for (const [key, value] of Object.entries(containers))
          counts[key] -= value;
      yield JSON.stringify({
        ...metadata,
        type: "summary",
        file,
        status: data.success ? "passed" : "failed",
        durationMs: data.duration_ms,
        counts,
        files: [...files].sort(),
      }) + "\n";
    }
  }
}
