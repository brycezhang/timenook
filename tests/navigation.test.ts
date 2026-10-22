import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../miniprogram/domain/model";

const pages: any[] = [];
const routes: string[] = [];
let stored: unknown = createProject("妈妈");
Object.assign(globalThis, {
  Page: (definition: unknown) => pages.push(definition),
  wx: {
    getStorageSync: () => structuredClone(stored),
    navigateTo: ({ url }: { url: string }) => routes.push(url),
    reLaunch: ({ url }: { url: string }) => routes.push(url),
  },
});
await import("../miniprogram/pages/home/index");
await import("../miniprogram/pages/account/index");

test("returning users enter their project by default but can explicitly browse gifts", () => {
  pages[0].onLoad({});
  assert.deepEqual(routes.splice(0), ["/pages/project/index"]);
  pages[1].shop();
  assert.deepEqual(routes.splice(0), ["/pages/home/index?browse=1"]);
  pages[0].onLoad({ browse: "1" });
  assert.deepEqual(routes, []);
  pages[0].project();
  assert.deepEqual(routes.splice(0), ["/pages/project/index"]);
});

test("users without a project remain on the gift homepage", () => {
  stored = undefined;
  pages[0].onLoad({});
  assert.deepEqual(routes, []);
});
