import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBounded } from "../../apps/api/runtime/bounded-process.mjs";
const execFileAsync = promisify(execFile);

async function running(pid) {
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "stat=", "-p", String(pid)],
      { encoding: "utf8" },
    );
    return !!stdout.trim() && !stdout.trim().startsWith("Z");
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), "timenook-watchdog-"));
  const originalPath = process.env.PATH;
  const ps = join(root, "ps");
  const worker = join(root, "worker.mjs");
  const marker = join(root, "monitor-started");
  const release = join(root, "release");
  const pidFile = join(root, "worker-pid");
  await writeFile(
    ps,
    `#!${process.execPath}
const fs=require('node:fs');
const child=require('node:child_process');
const root=${JSON.stringify(root)};
const countFile=root+'/count';
const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8'))+1:1;
fs.writeFileSync(countFile,String(count));
const result=child.spawnSync('/bin/ps',process.argv.slice(2),{encoding:'utf8'});
const workerReady=fs.existsSync(root+'/worker-pid');
const capturedDescendant=${JSON.stringify(mode)}!=='descendant'||(workerReady&&result.stdout.split('\\n').some(line=>{const row=line.trim().split(/\\s+/).map(Number);return row[0]===Number(fs.readFileSync(root+'/descendant-pid','utf8'))&&row[1]===Number(fs.readFileSync(root+'/worker-pid','utf8'));}));
if(count>1&&workerReady&&capturedDescendant){
  fs.writeFileSync(root+'/sample',result.stdout||'');
  fs.writeFileSync(root+'/monitor-started','started');
  ${mode === "fail" ? "process.exit(42);" : "while(!fs.existsSync(root+'/release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);"}
  ${mode === "late-fail" ? "process.exit(42);" : ""}
}
process.stdout.write(result.stdout||'');
process.exit(result.status??1);
`,
    { mode: 0o700 },
  );
  await writeFile(
    worker,
    mode === "descendant"
      ? `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(join(root, "descendant-pid"))},String(child.pid));writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},30000);`
      : `import{writeFileSync,existsSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const safety=setTimeout(()=>clearInterval(timer),2000);const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(root, "worker-exit"))})){clearTimeout(safety);clearInterval(timer)}},5);`,
  );
  process.env.PATH = `${root}:${originalPath}`;
  t.after(async () => {
    process.env.PATH = originalPath;
    if (mode === "descendant") {
      for (const name of ["descendant-pid", "worker-pid"]) {
        try {
          process.kill(
            Number(await readFile(join(root, name), "utf8")),
            "SIGKILL",
          );
        } catch {}
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  async function waitFor(path) {
    const end = performance.now() + 5000;
    for (;;) {
      try {
        await access(path);
        return;
      } catch {
        assert.ok(
          performance.now() < end,
          "controlled monitor reached its real ps invocation",
        );
        await delay(5);
      }
    }
  }
  return {
    marker,
    release,
    pidFile,
    countFile: join(root, "count"),
    workerExit: join(root, "worker-exit"),
    descendantFile: join(root, "descendant-pid"),
    sample: join(root, "sample"),
    waitFor,
    run: (limits = {}) =>
      runBounded({
        worker,
        args: [],
        heapMiB: 32,
        rssLimit: 256,
        timeLimit: 5000,
        ...limits,
      }).then(
        (result) => ({ result }),
        (error) => ({ error }),
      ),
  };
}

test(
  "a deadline also terminates descendants learned from a late real sample",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "descendant");
    const pending = f.run({ timeLimit: 300, rssLimit: 4096 });
    await f.waitFor(f.marker);
    const worker = Number(await readFile(f.pidFile, "utf8"));
    const descendant = Number(await readFile(f.descendantFile, "utf8"));
    const rows = (await readFile(f.sample, "utf8"))
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    assert.equal(
      rows.find(([pid]) => pid === descendant)?.[1],
      worker,
      "original ps captured the real parent before the deadline",
    );
    const workerEnd = performance.now() + 1500;
    while (await running(worker)) {
      assert.ok(
        performance.now() < workerEnd,
        "deadline kills the worker before sample delivery",
      );
      await delay(5);
    }
    await writeFile(
      f.release,
      "deliver original descendant rows after worker death",
    );
    assert.match((await pending).error?.message ?? "", /DECODE_RESOURCE_LIMIT/);
    const descendantEnd = performance.now() + 1500;
    while (await running(descendant)) {
      assert.ok(
        performance.now() < descendantEnd,
        "late-discovered descendant is terminated before rejection completes",
      );
      await delay(5);
    }
  },
);

test(
  "a real pending ps sample leaves the caller event loop available to release it",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "gate");
    const running = f.run();
    await f.waitFor(f.marker);
    const startedSamples = await readFile(f.countFile, "utf8");
    await delay(125);
    assert.equal(
      await readFile(f.countFile, "utf8"),
      startedSamples,
      "a pending sample cannot launch overlapping ps processes",
    );
    await writeFile(f.release, "release the original ps output");
    const outcome = await running;
    assert.equal(
      outcome.error,
      undefined,
      "valid delayed resource monitoring must not fail its worker",
    );
    assert.ok(outcome.result.peakSampledRssMiB > 0);
    assert.equal(outcome.result.limits.samplingMs, 50);
  },
);

test(
  "successful worker exit cannot hide a still-pending monitor failure",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "late-fail");
    let settled = false;
    const running = f.run().then((value) => {
      settled = true;
      return value;
    });
    await f.waitFor(f.marker);
    const pid = Number(await readFile(f.pidFile, "utf8"));
    await writeFile(f.workerExit, "successful worker exit");
    const end = performance.now() + 1500;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        break;
      }
      assert.ok(
        performance.now() < end,
        "controlled worker exits while the monitor remains pending",
      );
      await delay(5);
    }
    assert.equal(settled, false);
    await writeFile(f.release, "release the original monitor failure");
    assert.match(
      (await running).error?.message ?? "",
      /RESOURCE_MONITOR_FAILED/,
    );
  },
);

test(
  "real RSS above the original limit still terminates and rejects the worker",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "gate");
    const running = f.run({ rssLimit: 1 });
    await f.waitFor(f.marker);
    await writeFile(f.release, "allow the original RSS sample");
    assert.match((await running).error?.message ?? "", /DECODE_RESOURCE_LIMIT/);
  },
);

test(
  "a real monitor failure still terminates and rejects its worker",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "fail");
    const outcome = await f.run();
    assert.match(outcome.error?.message ?? "", /RESOURCE_MONITOR_FAILED/);
    const pid = Number(await readFile(f.pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

test(
  "the wall deadline terminates the worker while an actual ps result is pending",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "gate");
    let settled = false;
    const running = f.run({ timeLimit: 300 }).then((value) => {
      settled = true;
      return value;
    });
    await f.waitFor(f.marker);
    const pid = Number(await readFile(f.pidFile, "utf8"));
    const end = performance.now() + 1500;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        break;
      }
      assert.ok(
        performance.now() < end,
        "wall deadline remains active during monitor I/O",
      );
      await delay(5);
    }
    assert.equal(
      settled,
      false,
      "pending monitoring is drained before a final result",
    );
    await writeFile(f.release, "release original output after worker exit");
    assert.match((await running).error?.message ?? "", /DECODE_RESOURCE_LIMIT/);
  },
);
