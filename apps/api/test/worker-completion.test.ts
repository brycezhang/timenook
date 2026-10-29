import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { waitForWorkerJobs } from "./worker-completion";

function listenersRemoved(events: EventEmitter) {
  for (const event of ["completed", "failed", "error"])
    assert.equal(events.listenerCount(event), 0, event);
}

test("expected Worker progress keeps a still-dispatching frontier alive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter();
  let finishDispatch!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    finishDispatch = resolve;
  });
  const waiting = waitForWorkerJobs(
    events,
    async (declareExpected) => {
      declareExpected(["first", "last"]);
      await dispatch;
    },
    10,
  );
  const settled = waiting.then(
    () => "completed",
    () => "failed",
  );
  t.mock.timers.tick(9);
  events.emit("completed", { id: "first" });
  t.mock.timers.tick(9);
  events.emit("completed", { id: "last" });
  finishDispatch();
  await waiting;
  assert.equal(await settled, "completed");
  listenersRemoved(events);
});

test("finite expected Worker jobs can progress beyond one idle budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter();
  const waiting = waitForWorkerJobs(
    events,
    async (declareExpected) => {
      declareExpected(["first", "last"]);
    },
    10,
  );
  const settled = waiting.then(
    () => "completed",
    () => "failed",
  );
  await new Promise<void>(setImmediate);
  t.mock.timers.tick(9);
  events.emit("completed", { id: "first" });
  t.mock.timers.tick(9);
  events.emit("completed", { id: "last" });
  await waiting;
  assert.equal(await settled, "completed");
  listenersRemoved(events);
  t.mock.timers.tick(100);
});

test("duplicate and unrelated completions neither finish nor extend missing target work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter();
  let finishDispatch!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    finishDispatch = resolve;
  });
  const waiting = waitForWorkerJobs(
    events,
    async (declareExpected) => {
      declareExpected(["first", "missing"]);
      await dispatch;
    },
    10,
  );
  const rejected = assert.rejects(waiting, /Worker made no progress: missing/);
  await new Promise<void>(setImmediate);
  events.emit("completed", { id: "first" });
  t.mock.timers.tick(9);
  events.emit("completed", { id: "first" });
  events.emit("completed", { id: "unrelated" });
  t.mock.timers.tick(1);
  await rejected;
  finishDispatch();
  listenersRemoved(events);
});

test("Worker failed and error events reject immediately and clean listeners", async () => {
  for (const event of ["failed", "error"] as const) {
    const events = new EventEmitter();
    const error = new Error("synthetic worker failure");
    const waiting = waitForWorkerJobs(events, async (declareExpected) => {
      declareExpected(["target"]);
    });
    const rejected = assert.rejects(
      waiting,
      event === "failed"
        ? /Worker job failed: target/
        : /synthetic worker failure/,
    );
    await new Promise<void>(setImmediate);
    if (event === "failed") events.emit(event, { id: "target" }, error);
    else events.emit(event, error);
    await rejected;
    listenersRemoved(events);
  }
});

test("early completions, empty frontiers and wake failures clean listeners", async () => {
  for (const expected of [[], ["early"]]) {
    const events = new EventEmitter();
    await waitForWorkerJobs(events, async (declareExpected) => {
      events.emit("completed", { id: "early" });
      declareExpected(expected);
    });
    listenersRemoved(events);
  }
  const events = new EventEmitter();
  await assert.rejects(
    waitForWorkerJobs(events, async () => {
      throw new Error("synthetic wake failure");
    }),
    /synthetic wake failure/,
  );
  listenersRemoved(events);
});

test("a stalled scheduling call fails and removes all listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter();
  const waiting = waitForWorkerJobs(events, () => new Promise(() => {}), 10);
  const rejected = assert.rejects(
    waiting,
    /Worker made no progress: scheduling/,
  );
  t.mock.timers.tick(9);
  events.emit("completed", { id: "unknown" });
  t.mock.timers.tick(1);
  await rejected;
  listenersRemoved(events);
});

test("completed jobs cannot hide a stalled final dispatch acknowledgement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter();
  const waiting = waitForWorkerJobs(
    events,
    async (declareExpected) => {
      declareExpected(["target"]);
      events.emit("completed", { id: "target" });
      await new Promise(() => {});
    },
    10,
  );
  const rejected = assert.rejects(waiting, /Worker made no progress: dispatch/);
  t.mock.timers.tick(10);
  await rejected;
  listenersRemoved(events);
});
