import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import native from "fs-ext";
import {
  PrivacyJournal,
  PrivacyJournalError,
} from "../src/privacy-journal/privacy-journal";
import {
  installPrivacyLockDiagnostic,
  privacyLockDiagnosticState,
  privacyLockFailure,
} from "./privacy-lock-diagnostic";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "timenook-lock-diagnostic-"));
  const config = {
    root: join(directory, "source"),
    key: randomBytes(32).toString("base64"),
  };
  const expectedAuthority = await PrivacyJournal.bootstrap(config, {
    databaseId: randomUUID(),
  });
  return { directory, config: { ...config, expectedAuthority } };
}
const rawFlock = native.flock;
let nativeErrors: unknown[] | undefined;
Reflect.set(native, "flock", function (this: unknown, ...args: unknown[]) {
  if (!nativeErrors) return Reflect.apply(rawFlock, this, args);
  const callback = args[2];
  return Reflect.apply(rawFlock, this, [
    args[0],
    args[1],
    function (this: unknown, ...values: unknown[]) {
      nativeErrors?.push(values[0]);
      return Reflect.apply(
        callback as (...values: unknown[]) => unknown,
        this,
        values,
      );
    },
  ]);
});
let contextUnavailable = false;
installPrivacyLockDiagnostic(() => {
  if (contextUnavailable) throw new Error("unavailable observer context");
  return {};
});

test("the observer distinguishes a real local queue from its authenticated native owner and releases all state", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  const owner = new PrivacyJournal(f.config),
    reader = new PrivacyJournal({ ...f.config, lockTimeoutMs: 50 });
  const exclusive = Reflect.get(owner, "exclusive");
  Reflect.set(owner, "exclusive", (work: () => Promise<unknown>) =>
    exclusive.call(owner, async () => {
      const value = await work();
      entered.resolve();
      await release.promise;
      return value;
    }),
  );
  let owning: Promise<unknown> | undefined;
  try {
    owning = owner.snapshot();
    await entered.promise;
    let original: unknown;
    await assert.rejects(reader.snapshot(), (error) => {
      original = error;
      assert.ok(error instanceof PrivacyJournalError);
      assert.equal(error.message, "Privacy journal: lock timeout");
      return true;
    });
    const record = privacyLockFailure(original)!;
    assert.equal(record.operation.lastObservedPhase, "local_queue");
    assert.equal(record.operation.budgetMs, 50);
    assert.equal(record.operation.nativeAcquisitionCallbackSucceeded, false);
    assert.ok(record.operation.phasesMs.local_queue >= 40);
    assert.notEqual(record.localOwnerWhenReported, "unknown");
    if (record.localOwnerWhenReported === "unknown")
      throw new Error("missing observed owner");
    assert.equal(record.localOwnerWhenReported.method, "snapshot");
    assert.equal(record.localOwnerWhenReported.budgetMs, 5000);
    assert.equal(
      record.localOwnerWhenReported.lastObservedPhase,
      "authenticated_work",
    );
    assert.equal(
      record.localOwnerWhenReported.nativeHeldCallbackObserved,
      true,
    );
    assert.ok(record.localOwnerWhenReported.io["flock.exnb"].count > 0);
    assert.ok(record.localOwnerWhenReported.io["source.readFile"].count > 0);
    assert.equal(
      privacyLockFailure(original),
      record,
      "metadata is keyed by the original error object",
    );
    const json = JSON.stringify(record);
    for (const privateValue of [f.directory, f.config.root, f.config.key])
      assert.ok(!json.includes(privateValue));
  } finally {
    release.resolve();
    await owning;
    await rm(f.directory, { recursive: true, force: true });
  }
  assert.equal(privacyLockDiagnosticState().active, 0);
  assert.equal(privacyLockDiagnosticState().scopes, 0);
  assert.ok(privacyLockDiagnosticState().recent <= 4);
});

test("a separate process native owner produces real EAGAIN callbacks without claiming local ownership of its lock", async (t) => {
  const f = await fixture();
  const child: ChildProcess = fork(
    join(__dirname, "fixtures", "privacy-journal-process.js"),
    [],
    {
      execArgv: [],
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = once(child, "exit");
  const observedFlock = native.flock,
    forwarded: unknown[] = [];
  nativeErrors = [];
  t.mock.method(native, "flock", function (this: unknown, ...args: unknown[]) {
    const callback = args[2];
    return Reflect.apply(observedFlock, this, [
      args[0],
      args[1],
      function (this: unknown, ...values: unknown[]) {
        forwarded.push(values[0]);
        return Reflect.apply(
          callback as (...values: unknown[]) => unknown,
          this,
          values,
        );
      },
    ]);
  });
  try {
    const ready = once(child, "message");
    child.send({
      config: f.config,
      name: "diagnostic-native-owner",
      mode: "publish",
      count: 1,
      pauseAt: "temporary-synced",
    });
    assert.deepEqual(await ready, [{ type: "paused" }, undefined]);
    let original: unknown;
    await assert.rejects(
      new PrivacyJournal({ ...f.config, lockTimeoutMs: 80 }).snapshot(),
      (error) => {
        original = error;
        return (
          error instanceof PrivacyJournalError &&
          error.message === "Privacy journal: lock timeout"
        );
      },
    );
    const record = privacyLockFailure(original)!;
    assert.ok(record.operation.phasesMs.native_acquisition >= 50);
    assert.ok(record.operation.io["flock.exnb"].count > 0);
    assert.equal(record.operation.nativeAcquisitionCallbackSucceeded, false);
    assert.equal(record.operation.nativeHeldCallbackObserved, false);
    if (record.localOwnerWhenReported !== "unknown")
      assert.equal(
        record.localOwnerWhenReported.nativeHeldCallbackObserved,
        false,
      );
    // The source lock is still held by the independent process. No observer
    // call removes it or turns an expected timeout into a successful read.
    assert.equal(child.exitCode, null);
    assert.equal(forwarded.length, nativeErrors.length);
    assert.ok(forwarded.length > 0);
    for (let i = 0; i < forwarded.length; i++)
      assert.equal(
        forwarded[i],
        nativeErrors[i],
        "the original native callback error is forwarded once, in order, without replacement",
      );
  } finally {
    nativeErrors = undefined;
    child.kill("SIGKILL");
    await exited;
    await rm(f.directory, { recursive: true, force: true });
  }
  assert.equal(privacyLockDiagnosticState().active, 0);
  assert.equal(privacyLockDiagnosticState().scopes, 0);
});

test("successful original I/O stays silent and a real corrupt source retains its original error and bounded released metadata", async (t) => {
  const output: string[] = [];
  t.mock.method(
    process.stderr,
    "write",
    (...args: Parameters<typeof process.stderr.write>) => {
      output.push(String(args[0]));
      return true;
    },
  );
  const f = await fixture();
  try {
    const journal = new PrivacyJournal(f.config);
    contextUnavailable = true;
    for (let i = 0; i < 8; i++)
      assert.equal((await journal.snapshot()).generation, 0);
    contextUnavailable = false;
    const event = await journal.append({
      eventId: randomUUID(),
      projectId: randomUUID(),
      kind: "revocation",
      occurredAt: new Date().toISOString(),
      payload: { purpose: "synthetic-diagnostic" },
    });
    assert.equal(event.generation, 1);
    assert.equal((await journal.snapshot()).events[0].eventId, event.eventId);
    assert.deepEqual(output, []);
    assert.equal(privacyLockDiagnosticState().recent, 4);
    await writeFile(join(f.config.root, "head.json"), "{", { mode: 0o600 });
    let original: unknown;
    const authenticated = Reflect.get(journal, "authenticated");
    Reflect.set(journal, "authenticated", async (...args: unknown[]) => {
      try {
        return await authenticated.apply(journal, args);
      } catch (error) {
        original = error;
        throw error;
      }
    });
    const snapshot = journal.snapshot();
    await assert.rejects(snapshot, (error) => {
      assert.equal(error, original);
      assert.equal(
        (error as Error).message,
        "Privacy journal: source JSON is truncated or invalid",
      );
      return true;
    });
    const record = privacyLockFailure(original)!;
    assert.equal(record.operation.nativeAcquisitionCallbackSucceeded, true);
    assert.equal(record.operation.nativeUnlockCallbackSucceeded, true);
    assert.equal(record.operation.io["source.readFile"].count, 1);
    assert.ok(record.operation.io["lock.close"].count > 0);
    assert.equal(privacyLockDiagnosticState().active, 0);
    assert.equal(privacyLockDiagnosticState().scopes, 0);
    assert.deepEqual(
      output,
      [],
      "metadata collection itself never prints an original parser/body/path",
    );
  } finally {
    contextUnavailable = false;
    await rm(f.directory, { recursive: true, force: true });
  }
});
