import {
  appendFileSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// This deliberately does not serialize result.error(s), stdout, stderr,
// attachments, steps or page data: admin tests can contain passwords/MFA seeds.
export default class TimingReporter {
  constructor() {
    this.root = realpathSync(
      process.env.TIMENOOK_CI_ROOT ??
        process.env.GITHUB_WORKSPACE ??
        process.cwd(),
    );
    this.file =
      process.env.TIMENOOK_CI_TEST_REPORT ??
      join(process.env.TIMENOOK_CI_REPORT_DIR, "tests.jsonl");
    this.counts = {
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      interrupted: 0,
    };
    this.actual = new Set();
    this.metadata = {
      schemaVersion: 1,
      suite: process.env.TIMENOOK_CI_SUITE ?? null,
      sha: process.env.CHECK_HEAD ?? process.env.GITHUB_SHA ?? null,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, "");
  }
  path(file) {
    return relative(this.root, realpathSync(resolve(file)))
      .split(sep)
      .join("/");
  }
  write(row) {
    appendFileSync(
      this.file,
      JSON.stringify({ ...this.metadata, ...row }) + "\n",
    );
  }
  onBegin(config, suite) {
    const tests = suite.allTests();
    this.write({
      type: "plan",
      tests: tests.length,
      files: [
        ...new Set(tests.map((test) => this.path(test.location.file))),
      ].sort(),
      cases: tests.map((test) => ({
        id: test.id,
        file: this.path(test.location.file),
        titlePath: test.titlePath(),
      })),
    });
  }
  onTestEnd(test, result) {
    const file = this.path(test.location.file);
    this.actual.add(file);
    this.counts.tests++;
    this.counts[result.status]++;
    this.write({
      type: "test",
      id: test.id,
      file,
      name: test.title,
      titlePath: test.titlePath(),
      project: test.parent.project()?.name ?? "",
      status: result.status,
      durationMs: result.duration,
      retry: result.retry,
    });
  }
  onEnd(result) {
    this.write({
      type: "summary",
      status: result.status,
      durationMs: result.duration,
      counts: this.counts,
      files: [...this.actual].sort(),
    });
  }
  printsToStdio() {
    return false;
  }
}
