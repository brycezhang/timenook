import { mkdir, rm, rename, lstat, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// S0 only. These are local probe ceilings, not product/printing specifications.
if (
  process.env.PRINT_PROBE_ENABLED !== "synthetic-local" ||
  process.env.NODE_ENV === "production"
) {
  console.error("PRINT_PROBE_DISABLED");
  process.exit(1);
}
const [command, input, output, ...args] = process.argv.slice(2);
function processSnapshot() {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    if (
      !rows.some(([pid]) => pid === process.pid) ||
      rows.some(
        (row) =>
          row.length !== 3 || row.some((n) => !Number.isFinite(n) || n < 0),
      )
    )
      throw Error();
    return rows;
  } catch {
    throw Error("RESOURCE_MONITOR_FAILED");
  }
}
let staging;
try {
  if (!["photo", "book", "inspect"].includes(command) || !input || !output)
    throw Error("INVALID_COMMAND");
  const target = resolve(output);
  if (
    await lstat(target).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw Error("OUTPUT_ALREADY_EXISTS");
  const maximumRss = command === "photo" ? 384 : 2048,
    maximumTime = command === "photo" ? 15000 : 60000;
  const rssLimit = Number(process.env.PRINT_PROBE_RSS_MIB ?? maximumRss),
    timeLimit = Number(process.env.PRINT_PROBE_TIMEOUT_MS ?? maximumTime);
  if (
    !Number.isInteger(rssLimit) ||
    rssLimit < 1 ||
    rssLimit > maximumRss ||
    !Number.isInteger(timeLimit) ||
    timeLimit < 1 ||
    timeLimit > maximumTime
  )
    throw Error("INVALID_RESOURCE_LIMIT");
  processSnapshot();
  let peakRssKb = 0;
  const startedAt = Date.now();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  staging = `${target}.partial-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  await new Promise((fulfill, reject) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${command === "photo" ? 128 : 256}`,
        fileURLToPath(new URL(`./${command}-worker.mjs`, import.meta.url)),
        resolve(input),
        staging,
        ...args,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, VIPS_CONCURRENCY: "1" },
      },
    );
    let error = "",
      exceeded = false,
      monitorFailed = false;
    let descendants = [];
    const stop = () => {
      for (const pid of descendants.reverse())
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      exceeded = true;
      stop();
    }, timeLimit);
    // RSS watchdog includes native/WASM allocations; it is a sampled local safeguard,
    // not an OS hard cgroup limit. Production must use a separate resource-limited worker.
    const monitor = setInterval(() => {
      try {
        const rows = processSnapshot();
        const ids = new Set([child.pid]);
        for (let changed = true; changed;) {
          changed = false;
          for (const [pid, parent] of rows)
            if (ids.has(parent) && !ids.has(pid)) {
              ids.add(pid);
              changed = true;
            }
        }
        descendants = [...ids].filter((pid) => pid !== child.pid);
        const rssKb = rows.reduce(
          (total, [pid, , rss]) => total + (ids.has(pid) ? rss : 0),
          0,
        );
        peakRssKb = Math.max(peakRssKb, rssKb);
        if (rssKb > rssLimit * 1024) {
          exceeded = true;
          stop();
        }
      } catch {
        monitorFailed = true;
        stop();
      }
    }, 50);
    child.stderr.on("data", (chunk) => {
      if (error.length < 1024) error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(monitor);
      if (code !== 0 || monitorFailed || exceeded)
        reject(
          Error(
            monitorFailed
              ? "RESOURCE_MONITOR_FAILED"
              : exceeded
                ? "DECODE_RESOURCE_LIMIT"
                : error.trim() || "PHOTO_REJECTED",
          ),
        );
      else fulfill();
    });
  });
  await writeFile(
    resolve(staging, "runtime.json"),
    JSON.stringify(
      {
        elapsedMs: Date.now() - startedAt,
        peakSampledRssMiB: Math.round(peakRssKb / 1024),
        limits: {
          rssMiB: rssLimit,
          timeoutMs: timeLimit,
          samplingMs: 50,
          hardOsMemoryLimit: false,
        },
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  await rename(staging, target);
  staging = undefined;
  console.log(`${command.toUpperCase()}_READY`);
} catch (error) {
  if (staging) await rm(staging, { recursive: true, force: true });
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "PROBE_FAILED",
  );
  process.exitCode = 1;
}
