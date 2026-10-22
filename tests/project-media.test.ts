import test from "node:test";
import assert from "node:assert/strict";
import { demo, read } from "../miniprogram/services/store";

let stored: unknown;
let page: any;
let completeFile: (value: { savedFilePath: string }) => void;
let finishPicking: Promise<void>;
Object.assign(globalThis, {
  Page: (definition: unknown) => {
    page = definition;
  },
  wx: {
    getStorageSync: () => structuredClone(stored),
    setStorageSync: (_key: string, value: unknown) => {
      stored = structuredClone(value);
    },
    chooseMedia: (options: any) => {
      finishPicking = options.success({
        tempFiles: [{ tempFilePath: "photo-temp" }],
      });
    },
    getFileSystemManager: () => ({
      saveFile: (options: any) => {
        completeFile = options.success;
      },
    }),
    showToast: () => assert.fail("photo save should succeed"),
  },
});
await import("../miniprogram/pages/story/index");

test("a photo completing after a project switch stays in the original story", async () => {
  const first = demo("妈妈");
  page.data.id = "sample-0";
  page.photos();
  const second = demo("爸爸");
  completeFile({ savedFilePath: "saved-photo" });
  await finishPicking;
  assert.equal(read()!.id, second.id);
  assert.deepEqual(read(first.id)!.stories[0].photos, ["saved-photo"]);
  assert.equal(read(first.id)!.stories[0].confirmedVersion, null);
  assert.deepEqual(read(second.id), second);
});
