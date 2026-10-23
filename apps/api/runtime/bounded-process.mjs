import { spawn, execFileSync } from "node:child_process";
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
export async function runBounded({
  worker,
  args,
  heapMiB,
  rssLimit,
  timeLimit,
  env = {},
}) {
  processSnapshot();
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
