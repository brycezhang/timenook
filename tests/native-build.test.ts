import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const fixture = await mkdtemp(path.join(tmpdir(), "timenook-native-build-"));
after(() => rm(fixture, { recursive: true, force: true }));
await cp("miniprogram", path.join(fixture, "miniprogram"), { recursive: true });
await cp(
  "packages/contracts/src",
  path.join(fixture, "packages/contracts/src"),
  {
    recursive: true,
  },
);
const build = spawnSync(process.execPath, [path.resolve("scripts/build.mjs")], {
  cwd: fixture,
  encoding: "utf8",
  env: {
    ...process.env,
    TIMENOOK_AUDIO_PROBE_BUILD: "0",
    TIMENOOK_PAYMENT_VERIFICATION: "",
    TIMENOOK_API_BASE_URL: "https://example.test/api/v1",
  },
});
assert.equal(build.status, 0, build.stderr);
const root = path.join(fixture, "dist/miniprogram");
const pages: string[] = JSON.parse(
  await readFile(path.join(root, "app.json"), "utf8"),
).pages;

async function harness(mode = "demo") {
  const storage = new Map<string, any>([["timenook.mode.v1", mode]]);
  const modules = new Map<string, { exports: any }>();
  let page: any;
  let route = "";
  let navigation = "";
  const context = {
    console,
    Page(definition: any) {
      page = definition;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync: (key: string) => structuredClone(storage.get(key)),
      setStorageSync: (key: string, value: unknown) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      showModal: (options: any) =>
        options.success?.({ confirm: true, cancel: false }),
      showToast: () => {},
      getRecorderManager: () => ({
        onStart() {},
        onStop() {},
        onError() {},
        onInterruptionBegin() {},
      }),
      reLaunch: ({ url }: { url: string }) => {
        route = url;
        navigation = "reLaunch";
      },
      navigateTo: ({ url }: { url: string }) => {
        route = url;
        navigation = "navigateTo";
      },
      switchTab: ({ url }: { url: string }) => {
        route = url;
        navigation = "switchTab";
      },
    },
  };
  async function load(file: string): Promise<any> {
    assert.ok(
      file.startsWith(root + path.sep),
      `上传包外的模块不能加载：${path.relative(root, file)}`,
    );
    const cached = modules.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} };
    modules.set(file, module);
    const source = await readFile(file, "utf8");
    // Resolve the emitted CommonJS graph using only files inside miniprogramRoot.
    const dependencies = new Map<string, any>();
    for (const match of source.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith("."),
        `原生包不支持外部依赖：${specifier}`,
      );
      const target = path.resolve(path.dirname(file), specifier);
      dependencies.set(
        specifier,
        await load(target.endsWith(".js") ? target : target + ".js"),
      );
    }
    runInNewContext(
      `(function(require, module, exports) {\n${source}\n})`,
      context,
      { filename: file },
    )(
      (specifier: string) => {
        assert.ok(
          dependencies.has(specifier),
          `未解析的原生依赖：${specifier}`,
        );
        return dependencies.get(specifier);
      },
      module,
      module.exports,
    );
    return module.exports;
  }
  return {
    storage,
    route() {
      return route;
    },
    navigation() {
      return navigation;
    },
    async open(name: string, initialize = true) {
      page = undefined;
      // Page entrypoints execute on each load; service modules remain shared.
      const file = path.join(root, name + ".js");
      modules.delete(file);
      await load(file);
      assert.ok(page?.data, `${name} 必须成功注册页面`);
      if (initialize) page.onLoad?.({});
      return page;
    },
  };
}

test("uploaded native package registers every route without modules outside miniprogramRoot", async () => {
  for (const mode of ["demo", "live"]) {
    const app = await harness(mode);
    for (const name of pages) await app.open(name, false);
  }
});

test("native tab handlers use cached tab navigation and the package supplies its custom bar", async () => {
  const config = JSON.parse(
    await readFile(path.join(root, "app.json"), "utf8"),
  );
  assert.equal(config.tabBar.custom, true);
  assert.deepEqual(
    config.tabBar.list.map((item: { pagePath: string }) => item.pagePath),
    ["pages/project/index", "pages/book/index", "pages/account/index"],
  );
  for (const ext of ["js", "json", "wxml", "wxss"])
    assert.ok(
      (await readFile(path.join(root, `custom-tab-bar/index.${ext}`))).length,
    );
  const app = await harness();
  for (const source of ["project", "book", "account"]) {
    const page = await app.open(`pages/${source}/index`);
    for (const target of ["project", "book", "account"]) {
      page[target]();
      assert.equal(app.navigation(), "switchTab");
      assert.equal(app.route(), `/pages/${target}/index`);
    }
  }
});

for (const recipient of ["妈妈", "爸爸"]) {
  test(`built native purchase keeps the encoded ${recipient} selection and loads the invitation`, async () => {
    const app = await harness();
    const home = await app.open("pages/home/index");
    home.choose({ currentTarget: { dataset: { recipient } } });
    const [route, query] = app.route().slice(1).split("?");
    const purchase = await app.open(route);
    // WeChat passes the encoded query to onLoad; the browser bridge's
    // URLSearchParams would decode this and hide a native-only regression.
    purchase.onLoad(
      Object.fromEntries(query.split("&").map((pair) => pair.split("="))),
    );
    assert.equal(purchase.data.recipient, recipient);
    purchase.agree();
    purchase.pay();
    assert.equal(app.route(), "/pages/invite/index");
    const invite = await app.open(app.route().slice(1));
    await invite.onShow();
    assert.equal(invite.data.mode, "demo");
    assert.equal(invite.data.p.recipient, recipient);
    assert.equal(
      invite.data.bookImage,
      recipient === "爸爸" ? "/assets/father-book.jpg" : "/assets/book.jpg",
    );
    invite.preview();
    assert.equal(app.route(), "/pages/welcome/index");
    const welcome = await app.open(app.route().slice(1));
    await welcome.onShow();
    assert.equal(welcome.data.p.id, invite.data.p.id);
  });
}
