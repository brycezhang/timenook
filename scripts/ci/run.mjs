import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command || !process.env.TIMENOOK_CI_REPORT_DIR) {
  console.error(
    "Usage: TIMENOOK_CI_REPORT_DIR=... node scripts/ci/run.mjs LABEL COMMAND [ARGS...]",
  );
  process.exitCode = 1;
} else {
  const dir = process.env.TIMENOOK_CI_REPORT_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "phases.json");
  const report = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {
        schemaVersion: 1,
        suite: process.env.TIMENOOK_CI_SUITE ?? null,
        sha: process.env.CHECK_HEAD ?? process.env.GITHUB_SHA ?? null,
        phases: [],
      };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawn(command, args, { stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let spawnFailed = false;
  child.on("error", () => {
    spawnFailed = true;
    console.error("CI phase command could not start");
  });
  child.once("close", (code, signal) => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    const exitCode = spawnFailed ? 1 : code;
    const phase = {
      name,
      status: exitCode === 0 && !signal ? "passed" : "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      exitCode,
      signal,
    };
    report.phases.push(phase);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) {
      const label = name.replace(/[|\r\n]/g, " ");
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        (report.phases.length === 1
          ? "| Phase | Status | Duration |\n| --- | --- | ---: |\n"
          : "") +
          `| ${label} | ${phase.status} | ${(phase.durationMs / 1000).toFixed(2)}s |\n`,
      );
    }
    process.exitCode = exitCode ?? 128 + (constants.signals[signal] ?? 1);
  });
}
