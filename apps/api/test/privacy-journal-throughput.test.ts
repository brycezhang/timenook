import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";

test(
  "three complete source readers stay within the original acquisition budget when individual filesystem completions are delayed",
  { timeout: 30000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      join(tmpdir(), "timenook-journal-throughput-"),
    );
    const config = {
      root: join(directory, "source"),
      key: randomBytes(32).toString("base64"),
    };
    const operations: Promise<unknown>[] = [];
    try {
      const expectedAuthority = await PrivacyJournal.bootstrap(config, {
        databaseId: randomUUID(),
      });
      const journal = new PrivacyJournal({ ...config, expectedAuthority });
      for (let i = 0; i < 86; i++)
        await journal.append({
          eventId: randomUUID(),
          projectId: randomUUID(),
          kind: "revocation",
          occurredAt: "2026-10-28T00:00:00.000Z",
          payload: { purpose: "collection", accessEpoch: i },
        });
      const started = performance.now(),
        baseline = await journal.snapshot();
      const baselineMs = performance.now() - started;
      let opened = 0,
        closed = 0,
        active = 0,
        maxActive = 0,
        originalIoMs = 0;
      const workMs: number[] = [],
        exclusive = Reflect.get(journal, "exclusive");
      // Observation only; no lock acquisition, result, error or authentication is replaced.
      Reflect.set(journal, "exclusive", (work: () => Promise<unknown>) =>
        exclusive.call(journal, async () => {
          const begin = performance.now();
          try {
            return await work();
          } finally {
            workMs.push(performance.now() - begin);
          }
        }),
      );
      const open = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const selected =
          typeof args[0] === "string" &&
          dirname(args[0]) === join(config.root, "events") &&
          /\d{16}-[a-f0-9]{64}\.json$/.test(args[0]);
        const start = performance.now(),
          file = await Reflect.apply(open, fs, args);
        if (!selected) return file;
        originalIoMs += performance.now() - start;
        opened++;
        maxActive = Math.max(maxActive, ++active);
        for (const method of ["stat", "readFile", "close"] as const) {
          const original = file[method];
          Reflect.set(file, method, async (...values: unknown[]) => {
            const start = performance.now(),
              value = await Reflect.apply(original, file, values);
            originalIoMs += performance.now() - start;
            if (method === "close") {
              closed++;
              active--;
            }
            // Original I/O really completes first; only its result delivery waits.
            // Each individual delay is small and no artificial >5s owner is held.
            await delay(8);
            return value;
          });
        }
        await delay(8);
        return file;
      });
      const singleStart = performance.now(),
        slow = await journal.snapshot();
      const singleMs = performance.now() - singleStart;
      assert.equal(slow.hash, baseline.hash);
      const readers = [
        journal.snapshot(),
        journal.snapshot(),
        journal.snapshot(),
      ];
      operations.push(...readers);
      const results = await Promise.allSettled(readers);
      t.diagnostic(
        JSON.stringify({
          baselineMs: Math.round(baselineMs),
          singleMs: Math.round(singleMs),
          workMs: workMs.map(Math.round),
          originalIoMs: Math.round(originalIoMs),
          opened,
          closed,
          maxActive,
          outcomes: results.map((r) =>
            r.status === "fulfilled"
              ? "verified"
              : r.reason instanceof Error &&
                  r.reason.message === "Privacy journal: lock timeout"
                ? "lock timeout"
                : "other error",
          ),
        }),
      );
      assert.ok(
        singleMs < 5000,
        "one whole original snapshot remains below the unchanged acquisition budget",
      );
      assert.equal(opened, closed, "all original event descriptors are closed");
      assert.equal(
        opened,
        4 * 86,
        "all four snapshots really reopen the complete source; the latency control cannot pass through an unobserved cache",
      );
      assert.ok(
        maxActive <= 4,
        "event descriptor and byte-buffer work stays bounded",
      );
      for (const result of results) {
        assert.equal(
          result.status,
          "fulfilled",
          "short per-file waits must not accumulate into an avoidable queued acquisition timeout",
        );
        if (result.status === "fulfilled") {
          assert.equal(result.value.hash, baseline.hash);
          assert.deepEqual(result.value.events, baseline.events);
        }
      }
    } finally {
      await Promise.allSettled(operations);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

import { spawn } from "node:child_process";
async function nativeProbe(lock: string): Promise<string> {
  const code = `const fs=require('node:fs'); const native=require(process.argv[2]);
fs.open(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,(e,fd)=>{
 if(e)process.exit(2);
 native.flock(fd,'exnb',error=>{
  const result=error&&(error.code==='EAGAIN'||error.code==='EWOULDBLOCK')?'blocked':!error?'acquired':'other';
  const close=()=>fs.close(fd,()=>{process.stdout.write(result);});
  if(!error)native.flock(fd,'un',close);else close();
 });
});`;
  const child = spawn(
    process.execPath,
    ["-e", code, lock, require.resolve("fs-ext")],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let output = "";
  child.stdout.on("data", (bytes) => (output += bytes));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("native lock probe failed")),
    );
  });
  return output;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}
test(
  "an invalid batch member cannot release native EX before the other original reads and descriptors settle",
  { timeout: 10000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      join(tmpdir(), "timenook-journal-drain-"),
    );
    const config = {
      root: join(directory, "source"),
      key: randomBytes(32).toString("base64"),
    };
    const heldRead = deferred(),
      releaseRead = deferred(),
      badRead = deferred(),
      fourthReleased = deferred();
    let reading: Promise<unknown> | undefined,
      publicSettled = false,
      fourthClosed = false,
      fourthOpened = false,
      originalError: unknown,
      publicError: unknown;
    try {
      const expectedAuthority = await PrivacyJournal.bootstrap(config, {
        databaseId: randomUUID(),
      });
      const journal = new PrivacyJournal({ ...config, expectedAuthority });
      for (let i = 0; i < 4; i++)
        await journal.append({
          eventId: randomUUID(),
          projectId: randomUUID(),
          kind: "revocation",
          occurredAt: "2026-10-28T00:00:00.000Z",
          payload: { purpose: "collection", accessEpoch: i },
        });
      const files = (await fs.readdir(join(config.root, "events"))).sort();
      const first = join(config.root, "events", files[0]),
        fourth = join(config.root, "events", files[3]);
      await fs.writeFile(first, "{", { mode: 0o600 });
      const authenticated = Reflect.get(journal, "authenticated");
      Reflect.set(journal, "authenticated", async (...args: unknown[]) => {
        try {
          return await authenticated.apply(journal, args);
        } catch (error) {
          if (args[0] === first) {
            originalError = error;
            badRead.resolve();
          }
          throw error;
        }
      });
      const open = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const file = await Reflect.apply(open, fs, args);
        if (args[0] === fourth) {
          fourthOpened = true;
          const read = file.readFile,
            close = file.close;
          Reflect.set(file, "readFile", async (...values: unknown[]) => {
            const bytes = await Reflect.apply(read, file, values);
            heldRead.resolve();
            await releaseRead.promise;
            return bytes;
          });
          Reflect.set(file, "close", async () => {
            try {
              await close.call(file);
              fourthClosed = true;
            } finally {
              fourthReleased.resolve();
            }
          });
        }
        return file;
      });
      reading = journal
        .snapshot()
        .catch((error) => {
          publicError = error;
        })
        .finally(() => {
          publicSettled = true;
        });
      await Promise.all([heldRead.promise, badRead.promise]);
      assert.equal(
        await nativeProbe(join(config.root, "lock")),
        "blocked",
        "the real kernel EX must remain held while an original event FD still awaits close",
      );
      assert.equal(fourthClosed, false);
      assert.equal(publicSettled, false);
      releaseRead.resolve();
      await reading;
      if (fourthOpened) await fourthReleased.promise;
      assert.equal(fourthClosed, true);
      assert.equal(
        publicError,
        originalError,
        "the original authenticated error survives the batch",
      );
      assert.equal(
        (publicError as Error).message,
        "Privacy journal: source JSON is truncated or invalid",
      );
      assert.equal(
        await nativeProbe(join(config.root, "lock")),
        "acquired",
        "EX is released after the original FD has closed",
      );
    } finally {
      releaseRead.resolve();
      await reading;
      if (fourthOpened) await fourthReleased.promise;
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
