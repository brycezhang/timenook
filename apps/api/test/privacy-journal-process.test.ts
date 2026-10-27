import assert from "node:assert/strict";
import { fork, ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  PrivacyJournal,
  PrivacyJournalConfig,
  PublicationWindow,
} from "../src/privacy-journal/privacy-journal";

function start(
  config: PrivacyJournalConfig,
  name: string,
  mode: "publish" | "read" | "wait-publish" | "wait-read",
  count: number,
  pauseAt?: PublicationWindow,
) {
  const ts = __filename.endsWith(".ts");
  const process = fork(
    join(__dirname, "fixtures", `privacy-journal-process.${ts ? "ts" : "js"}`),
    [],
    {
      execArgv: ts ? ["--import", "tsx"] : [],
      env: { ...global.process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const message = new Promise<string>((yes, no) => {
    process.once("message", (value: { type: string }) => yes(value.type));
    process.once("error", no);
    process.once("exit", (code) => {
      if (code) no(new Error(`journal subprocess exited ${code}`));
    });
  });
  const exit = once(process, "exit");
  process.send({ config, name, mode, count, pauseAt });
  return { process, message, exit };
}
async function cleanup(processes: ChildProcess[]) {
  for (const child of processes)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
}

test(
  "two API publishers and an independent worker reader share one lossless source",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "timenook-journal-process-"),
    );
    const children: ChildProcess[] = [];
    try {
      const config = {
        root: join(directory, "source"),
        key: randomBytes(32).toString("base64"),
      };
      const expectedAuthority = await PrivacyJournal.bootstrap(config, {
        databaseId: randomUUID(),
      });
      const commands = [
        start({ ...config, expectedAuthority }, "api-a", "publish", 8),
        start({ ...config, expectedAuthority }, "api-b", "publish", 8),
        start(config, "worker", "read", 20),
      ];
      children.push(...commands.map((child) => child.process));
      assert.deepEqual(
        await Promise.all(commands.map((child) => child.message)),
        ["done", "done", "done"],
      );
      await Promise.all(commands.map((child) => child.exit));
      const snapshot = await new PrivacyJournal(config).snapshot();
      assert.equal(snapshot.generation, 16);
      assert.equal(
        new Set(snapshot.events.map((event) => event.eventId)).size,
        16,
      );
      assert.deepEqual(
        snapshot.events.map((event) => event.generation),
        Array.from({ length: 16 }, (_, index) => index + 1),
      );
    } finally {
      await cleanup(children);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "already-running API and worker keep their original authority after promotion",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "timenook-journal-fence-"));
    const children: ChildProcess[] = [];
    try {
      const config = {
        root: join(directory, "source"),
        key: randomBytes(32).toString("base64"),
      };
      const expectedAuthority = await PrivacyJournal.bootstrap(config, {
        databaseId: randomUUID(),
      });
      const commands = [
        start({ ...config, expectedAuthority }, "old-api", "wait-publish", 1),
        start({ ...config, expectedAuthority }, "old-worker", "wait-read", 1),
      ];
      children.push(...commands.map((command) => command.process));
      assert.deepEqual(
        await Promise.all(commands.map((command) => command.message)),
        ["ready", "ready"],
      );
      const checkpoint = await new PrivacyJournal(config).snapshot();
      await PrivacyJournal.promote(config, {
        expectedAuthority,
        databaseId: randomUUID(),
        checkpoint,
      });
      const results = commands.map((command) =>
        once(command.process, "message"),
      );
      for (const command of commands) command.process.send({ resume: true });
      for (const [result] of await Promise.all(results))
        assert.deepEqual(result, { type: "failed" });
      await Promise.all(commands.map((command) => command.exit));
      assert.equal((await new PrivacyJournal(config).snapshot()).generation, 0);
    } finally {
      await cleanup(children);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

for (const window of [
  "temporary-written",
  "temporary-synced",
  "event-linked",
  "event-directory-synced",
  "head-temporary-synced",
  "head-renamed",
  "head-directory-synced",
] satisfies PublicationWindow[]) {
  test(
    `SIGKILL at ${window} releases the lock and recovers only published complete events`,
    { timeout: 10000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "timenook-journal-kill-"));
      const children: ChildProcess[] = [];
      try {
        const config = {
          root: join(directory, "source"),
          key: randomBytes(32).toString("base64"),
        };
        const expectedAuthority = await PrivacyJournal.bootstrap(config, {
          databaseId: randomUUID(),
        });
        const child = start(
          { ...config, expectedAuthority },
          "crashing-api",
          "publish",
          1,
          window,
        );
        children.push(child.process);
        assert.equal(await child.message, "paused");
        const before = performance.now();
        await assert.rejects(
          new PrivacyJournal({ ...config, lockTimeoutMs: 40 }).snapshot(),
          /lock timeout/,
        );
        assert.ok(
          performance.now() - before < 1000,
          "nonblocking acquisition has a bounded monotonic deadline",
        );
        child.process.kill("SIGKILL");
        const [, signal] = await child.exit;
        assert.equal(signal, "SIGKILL");
        const recovered = new PrivacyJournal({ ...config, expectedAuthority });
        const snapshot = await recovered.snapshot();
        const expectedCount = [
          "temporary-written",
          "temporary-synced",
        ].includes(window)
          ? 0
          : 1;
        assert.equal(snapshot.generation, expectedCount);
        await recovered.append({
          eventId: "after-recovery",
          projectId: "control",
          kind: "revocation",
          occurredAt: "2026-10-27T00:00:01.000Z",
          payload: {},
        });
        assert.equal(
          (await recovered.snapshot()).generation,
          expectedCount + 1,
        );
      } finally {
        await cleanup(children);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
