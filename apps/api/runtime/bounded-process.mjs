import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
async function processSnapshot() {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
    const rows = stdout
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
export async function runBounded({
  worker,
  args,
  heapMiB,
  rssLimit,
  timeLimit,
  env = {},
}) {
  await processSnapshot();
  let peakRssKb = 0;
  const startedAt = Date.now();
  await new Promise((fulfill, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${heapMiB}`, worker, ...args],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, ...env, VIPS_CONCURRENCY: "1" },
      },
    );
    let error = "",
      exceeded = false,
      monitorFailed = false;
    let descendants = [],
      sampling;
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
      // A slow real ps must not block private-access checks or the wall timer.
      // Keep at most one sample in flight and drain it before reporting success.
      if (sampling) return;
      sampling = (async () => {
        try {
          const rows = await processSnapshot();
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
          if (rssKb > rssLimit * 1024) exceeded = true;
          // The wall timer may have fired while ps was in flight. Apply its
          // termination intent to descendants learned from this late sample.
          if (exceeded) stop();
        } catch {
          monitorFailed = true;
          stop();
        }
      })().finally(() => {
        sampling = undefined;
      });
    }, 50);
    child.stderr.on("data", (chunk) => {
      if (error.length < 1024) error += chunk;
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearInterval(monitor);
      await sampling;
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
  return {
    elapsedMs: Date.now() - startedAt,
    peakSampledRssMiB: Math.round(peakRssKb / 1024),
    limits: {
      rssMiB: rssLimit,
      timeoutMs: timeLimit,
      samplingMs: 50,
      hardOsMemoryLimit: false,
    },
  };
}
