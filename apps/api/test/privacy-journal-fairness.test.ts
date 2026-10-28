import assert from "node:assert/strict";
import fs from "node:fs/promises";
import timers from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}
/** Pause only after the original verified read, while the original native lock
 * is still held. No read, authentication, result or error is replaced. */
function holdVerifiedRead(
  journal: PrivacyJournal,
  hold: (readMs: number) => Promise<void>,
) {
  const original = Reflect.get(journal, "exclusive");
  Reflect.set(journal, "exclusive", function (work: () => Promise<unknown>) {
    return original.call(journal, async () => {
      const start = performance.now(),
        result = await work();
      await hold(performance.now() - start);
      return result;
    });
  });
}

test(
  "a queued reader receives the real source before a short snapshot owner can reacquire it",
  { timeout: 20000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      join(tmpdir(), "timenook-journal-fair-"),
    );
    const operations: Promise<unknown>[] = [];
    let stop = () => {};
    try {
      const config = {
          root: join(directory, "source"),
          key: randomBytes(32).toString("base64"),
        },
        expectedAuthority = await PrivacyJournal.bootstrap(config, {
          databaseId: randomUUID(),
        }),
        owner = new PrivacyJournal({ ...config, expectedAuthority });
      for (let index = 0; index < 86; index++)
        await owner.append({
          eventId: randomUUID(),
          projectId: randomUUID(),
          kind: "revocation",
          occurredAt: "2026-10-28T00:00:00.000Z",
          payload: { purpose: "collection", accessEpoch: index },
        });
      // The final directory is real/private; only an ancestor is a legal alias.
      await fs.symlink(directory, join(directory, "alias"), "dir");
      const reader = new PrivacyJournal({
          ...config,
          root: join(directory, "alias", "source"),
          expectedAuthority,
        }),
        actor = new AsyncLocalStorage<string>(),
        firstRead = deferred(),
        prepared = deferred(),
        firstRelease = deferred(),
        readerFinished = deferred(),
        realpath = fs.realpath,
        delay = timers.setTimeout;
      let nextPoll = deferred(),
        done = false,
        ownerTurns = 0,
        readerTurns = 0,
        maxReadMs = 0,
        maxHeldMs = 0,
        maxOwnerSnapshotMs = 0;
      stop = () => {
        done = true;
        firstRelease.resolve();
        readerFinished.resolve();
      };
      // Observe original FS preparation and original timer scheduling only. The
      // old poller is offered each release just after its last missed window;
      // a queued handoff can use that same release without another polling tick.
      t.mock.method(
        fs,
        "realpath",
        async (...args: Parameters<typeof realpath>) => {
          const result = await Reflect.apply(realpath, fs, args);
          if (actor.getStore() === "reader") prepared.resolve();
          return result;
        },
      );
      t.mock.method(
        timers,
        "setTimeout",
        (...args: Parameters<typeof delay>) => {
          const result = Reflect.apply(delay, timers, args);
          if (actor.getStore() === "reader") {
            nextPoll.resolve();
            nextPoll = deferred();
          }
          return result;
        },
      );
      holdVerifiedRead(owner, async (readMs) => {
        const held = performance.now() - readMs;
        maxReadMs = Math.max(maxReadMs, readMs);
        if (++ownerTurns === 1) {
          firstRead.resolve();
          await firstRelease.promise;
        } else if (!done)
          await Promise.race([nextPoll.promise, readerFinished.promise]);
        maxHeldMs = Math.max(maxHeldMs, performance.now() - held);
      });
      holdVerifiedRead(reader, async () => {
        readerTurns++;
      });
      const owning = actor.run("owner", async () => {
        while (!done) {
          const start = performance.now();
          await owner.snapshot();
          maxOwnerSnapshotMs = Math.max(
            maxOwnerSnapshotMs,
            performance.now() - start,
          );
        }
      });
      operations.push(owning);
      void owning.catch(() => {});
      await Promise.race([firstRead.promise, owning]);
      const start = performance.now();
      let error: unknown;
      const reading = actor
        .run("reader", () => reader.snapshot())
        .catch((failure) => {
          error = failure;
          return undefined;
        })
        .finally(() => {
          done = true;
          readerFinished.resolve();
        });
      operations.push(reading);
      await prepared.promise;
      await new Promise<void>((yes) => setImmediate(yes));
      firstRelease.resolve();
      const result = await reading;
      await owning;
      t.diagnostic(
        JSON.stringify({
          ownerTurns,
          readerTurns,
          maxReadMs: Math.round(maxReadMs),
          maxWorkWithGateMs: Math.round(maxHeldMs),
          maxOwnerSnapshotMs: Math.round(maxOwnerSnapshotMs),
          readerElapsedMs: Math.round(performance.now() - start),
        }),
      );
      assert.equal(
        error,
        undefined,
        "short reacquisitions must not starve a queued reader",
      );
      assert.equal(readerTurns, 1);
      assert.equal(result?.generation, 86);
      assert.equal(result?.events.length, 86);
    } finally {
      stop();
      await Promise.allSettled(operations);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "an expired queued reader cannot release the active native owner or block its successor",
  { timeout: 10000 },
  async (t) => {
    const directory = await fs.mkdtemp(
        join(tmpdir(), "timenook-journal-cancel-"),
      ),
      release = deferred(),
      operations: Promise<unknown>[] = [];
    try {
      const config = {
          root: join(directory, "source"),
          key: randomBytes(32).toString("base64"),
        },
        expectedAuthority = await PrivacyJournal.bootstrap(config, {
          databaseId: randomUUID(),
        }),
        owner = new PrivacyJournal({ ...config, expectedAuthority }),
        locked = deferred();
      holdVerifiedRead(owner, async () => {
        locked.resolve();
        await release.promise;
      });
      const holding = owner.snapshot();
      operations.push(holding);
      void holding.catch(() => {});
      await Promise.race([locked.promise, holding]);
      const actor = new AsyncLocalStorage<string>(),
        expiredQueued = deferred(),
        successorQueued = deferred(),
        timeout = globalThis.setTimeout;
      // Observe each original queued waiter's real deadline timer, after enqueue.
      // No timer result/delivery, deadline, native operation or error is replaced.
      t.mock.method(
        globalThis,
        "setTimeout",
        (...args: Parameters<typeof timeout>) => {
          const result = Reflect.apply(timeout, globalThis, args);
          if (actor.getStore() === "expired") expiredQueued.resolve();
          if (actor.getStore() === "successor") successorQueued.resolve();
          return result;
        },
      );
      let expiredSettled = false,
        entered = false;
      const expired = actor.run("expired", () =>
          new PrivacyJournal({ ...config, lockTimeoutMs: 1000 }).snapshot(),
        ),
        rejected = assert.rejects(expired, /lock timeout/).then(() => {
          expiredSettled = true;
        });
      operations.push(rejected);
      await expiredQueued.promise;
      const successor = new PrivacyJournal(config);
      holdVerifiedRead(successor, async () => {
        entered = true;
      });
      const succeeding = actor.run("successor", () => successor.snapshot());
      operations.push(succeeding);
      void succeeding.catch(() => {});
      await successorQueued.promise;
      assert.equal(
        expiredSettled,
        false,
        "both waiters must be queued before cancellation",
      );
      await rejected;
      assert.equal(
        entered,
        false,
        "timeout cannot steal the active native lock",
      );
      release.resolve();
      await holding;
      assert.equal((await succeeding).generation, 0);
      assert.equal(entered, true);
      assert.equal((await new PrivacyJournal(config).snapshot()).generation, 0);
    } finally {
      release.resolve();
      await Promise.allSettled(operations);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
