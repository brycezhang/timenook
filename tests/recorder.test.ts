import test from "node:test";
import assert from "node:assert/strict";
import { createProject, type Project } from "../miniprogram/domain/model";
const handlers: Record<string, (value?: any) => void> = {};
let p: Project = createProject("妈妈");
p.consent = true;
let stored: unknown = p;
let failWrite = false,
  failFile = false,
  saveCalls = 0,
  stops = 0;
const manager = {
  onStart(fn: any) {
    handlers.start = fn;
  },
  onStop(fn: any) {
    handlers.stop = fn;
  },
  onError(fn: any) {
    handlers.error = fn;
  },
  onInterruptionBegin(fn: any) {
    handlers.interrupt = fn;
  },
  start() {},
  stop() {
    stops++;
    handlers.stop({ tempFilePath: "temp-audio", duration: 1500 });
  },
};
Object.assign(globalThis, {
  wx: {
    getRecorderManager: () => manager,
    getStorageSync: () => structuredClone(stored),
    setStorageSync: (_key: string, value: unknown) => {
      if (failWrite) throw Error("storage full");
      stored = structuredClone(value);
    },
    getFileSystemManager: () => ({
      saveFile(o: any) {
        saveCalls++;
        if (failFile) o.fail(Error("disk full"));
        else o.success({ savedFilePath: "saved-audio" });
      },
    }),
  },
});
const { recorder } = await import("../miniprogram/services/recorder");
const { read, save, start, select } =
  await import("../miniprogram/services/store");
let state = "";
recorder.subscribe((s) => (state = s.state));
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("permission error does not create fake saved audio", () => {
  recorder.start("问题");
  handlers.error();
  assert.equal(state, "error");
  assert.equal(read(p.id)!.recordings.length, 0);
  recorder.reset();
});
test("leaving during permission prompt stops late-starting recorder", async () => {
  recorder.start("问题");
  recorder.stop();
  handlers.start();
  await flush();
  assert.equal(stops, 1);
  assert.equal(state, "saved");
  assert.equal(read(p.id)!.recordings.length, 1);
  recorder.reset();
});
test("metadata failure can retry without resaving a moved temp file", async () => {
  failWrite = true;
  recorder.start("问题2");
  handlers.start();
  recorder.stop();
  await flush();
  assert.equal(state, "error");
  assert.equal(recorder.hasPending, true);
  const calls = saveCalls;
  failWrite = false;
  await recorder.retry();
  assert.equal(state, "saved");
  assert.equal(saveCalls, calls);
  assert.equal(read(p.id)!.recordings.length, 2);
  await recorder.retry();
  assert.equal(read(p.id)!.recordings.length, 2);
  recorder.reset();
});
test("file failure retains pending recording and blocks replacement until retry", async () => {
  failFile = true;
  recorder.start("问题3");
  handlers.start();
  recorder.stop();
  await flush();
  assert.equal(state, "error");
  assert.equal(recorder.hasPending, true);
  recorder.start("不能覆盖");
  assert.equal(state, "error");
  failFile = false;
  await recorder.retry();
  assert.equal(state, "saved");
  assert.equal(read(p.id)!.recordings[2].question, "问题3");
  recorder.reset();
});
test("switching projects during save keeps audio with its original project", async () => {
  recorder.start("妈妈的童年");
  handlers.start();
  const other = start("爸爸");
  recorder.stop();
  await flush();
  assert.equal(state, "saved");
  assert.equal(read()!.id, other.id);
  assert.equal(read()!.recordings.length, 0);
  assert.equal(read(p.id)!.recordings[3].question, "妈妈的童年");
  recorder.reset();
  select(p.id);
});
test("recording requires narrator consent", () => {
  p = read()!;
  p.consent = false;
  save(p);
  assert.throws(() => recorder.start("问题"), /参与/);
});
