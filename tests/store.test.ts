import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sampleProject } from "../miniprogram/domain/model";
import {
  clear,
  demo,
  list,
  read,
  save,
  select,
  start,
} from "../miniprogram/services/store";

let stored: unknown;
let failWrite = false;
Object.assign(globalThis, {
  wx: {
    getStorageSync: () => structuredClone(stored),
    setStorageSync: (_key: string, value: unknown) => {
      if (failWrite) throw new Error("storage full");
      stored = structuredClone(value);
    },
  },
});
beforeEach(() => {
  stored = undefined;
  failWrite = false;
});

test("repeat purchase preserves every field of the legacy project", () => {
  const original = sampleProject();
  original.recordings = [
    { id: "original", path: "saved-audio", question: "童年", duration: 1000 },
  ];
  stored = structuredClone(original);
  assert.deepEqual(read(), original);
  const second = start("爸爸");
  assert.equal(list().length, 2);
  assert.equal(read()!.id, second.id);
  assert.deepEqual(read(original.id), original);
  assert.deepEqual(read()!.stories, []);
  assert.deepEqual(select(original.id), original);
  assert.equal(read()!.id, original.id);
});

test("two purchases in the same millisecond stay distinct, including same recipient", (t) => {
  t.mock.method(Date, "now", () => 12345);
  const first = start("妈妈");
  const second = start("妈妈");
  assert.notEqual(first.id, second.id);
  assert.equal(list().length, 2);
  assert.equal(read()!.id, second.id);
});

test("saving a previous project cannot overwrite or select the active project", () => {
  const first = start("妈妈");
  const second = start("爸爸");
  first.title = "妈妈的时光";
  save(first);
  assert.equal(read(first.id)!.title, first.title);
  assert.deepEqual(read(), second);
  assert.throws(() => select("missing"), /不存在/);
  assert.deepEqual(read(), second);
});

test("failed purchase write leaves the legacy project and selection untouched", () => {
  const original = sampleProject();
  stored = structuredClone(original);
  failWrite = true;
  assert.throws(() => start("爸爸"), /storage full/);
  assert.deepEqual(stored, original);
  assert.deepEqual(read(), original);
});

test("sample preview preserves purchases and reopens the existing sample", () => {
  const purchased = start("妈妈");
  const sample = demo();
  select(purchased.id);
  const reopened = demo();
  assert.equal(reopened.id, sample.id);
  assert.deepEqual(read(purchased.id), purchased);
  assert.equal(list().length, 2);
});

test("reset only removes the current project and keeps other projects", () => {
  const first = start("妈妈");
  const second = start("爸爸");
  clear();
  assert.deepEqual(read(), first);
  assert.equal(read(second.id), null);
  assert.throws(() => save(second), /不存在/);
  clear();
  assert.equal(read(), null);
  assert.deepEqual(list(), []);
});

test("unrecognized stored data cannot be overwritten by a purchase", () => {
  stored = { version: 99, original: "保留" };
  assert.throws(() => start("妈妈"), /无法读取/);
  assert.deepEqual(stored, { version: 99, original: "保留" });
});
