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
    TIMENOOK_MINIPROGRAM_PROFILE: "development",
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
      env: { USER_DATA_PATH: "/user-data" },
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
    module: (name: string) => load(path.join(root, name)),
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
    ["pages/home/index", "pages/account/index"],
  );
  for (const { pagePath } of config.tabBar.list) {
    const pageConfig = JSON.parse(
      await readFile(path.join(root, `${pagePath}.json`), "utf8"),
    );
    const registry = pageConfig.usingComponents ?? config.usingComponents;
    assert.ok(
      registry && typeof registry === "object" && !Array.isArray(registry),
      `${pagePath} must enable custom components locally or globally for the native custom tab bar`,
    );
  }
  for (const ext of ["js", "json", "wxml", "wxss"])
    assert.ok(
      (await readFile(path.join(root, `custom-tab-bar/index.${ext}`))).length,
    );
  const app = await harness();
  for (const source of ["home", "account"]) {
    const page = await app.open(`pages/${source}/index`);
    for (const target of source === "home" ? ["account"] : ["home"]) {
      page[target]();
      assert.equal(app.navigation(), "switchTab");
      assert.equal(app.route(), `/pages/${target}/index`);
    }
  }
});

test("built new-book preserves an encoded user title and salutation", async () => {
  const app = await harness("live");
  app.storage.set("timenook.session.v1:https://example.test/api/v1", {
    user: { id: "11111111-1111-4111-8111-111111111111" },
    session: {
      id: "22222222-2222-4222-8222-222222222222",
      token: "a".repeat(43),
      expiresAt: "2099-01-01T00:00:00Z",
    },
  });
  const p = await app.open("pages/new-book/index");
  p.input({
    currentTarget: { dataset: { field: "name" } },
    detail: { value: "妈妈的一生 & 回忆" },
  });
  p.input({
    currentTarget: { dataset: { field: "salutation" } },
    detail: { value: "妈妈" },
  });
  p.next();
  const [route, query] = app.route().slice(1).split("?");
  const purchase = await app.open(route, false);
  purchase.onLoad(
    Object.fromEntries(query.split("&").map((pair) => pair.split("="))),
  );
  assert.equal(purchase.data.bookTitle, "妈妈的一生 & 回忆");
  assert.equal(purchase.requestedRecipient, "妈妈");
});

test("release package excludes website and probe routes and ignores stored demo mode", async () => {
  const release = spawnSync(
    process.execPath,
    [path.resolve("scripts/build.mjs")],
    {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        TIMENOOK_MINIPROGRAM_PROFILE: "release",
        TIMENOOK_AUDIO_PROBE_BUILD: "0",
        TIMENOOK_PAYMENT_VERIFICATION: "",
        TIMENOOK_API_BASE_URL: "https://example.test/api/v1",
      },
    },
  );
  assert.equal(release.status, 0, release.stderr);
  const config = JSON.parse(
    await readFile(path.join(root, "app.json"), "utf8"),
  );
  assert.ok(config.pages.includes("pages/interview/index"));
  assert.ok(config.pages.includes("pages/manuscript/index"));
  for (const name of ["account-link", "audio-probe"]) {
    assert.ok(!config.pages.includes(`pages/${name}/index`));
    await assert.rejects(readFile(path.join(root, `pages/${name}/index.js`)), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(root, `services/${name}.js`)), {
      code: "ENOENT",
    });
  }
  for (const name of config.pages) {
    assert.doesNotMatch(
      await readFile(path.join(root, name + ".wxml"), "utf8"),
      /网页|网站|官网|测试|演示|内测|合成验证|本地验证|验证订单|体验购买|useDemo|accountLink|copyInvitation|localVerification/,
    );
  }
  const app = await harness("demo");
  const homeMarkup = await readFile(
    path.join(root, "pages/home/index.wxml"),
    "utf8",
  );
  assert.match(homeMarkup, /class="landing-hero"/);
  assert.match(homeMarkup, /class="benefits"/);
  assert.match(homeMarkup, /含1本实体书/);
  assert.match(homeMarkup, /bindtap="account"/);
  assert.doesNotMatch(homeMarkup, /bindtap="(?:orders|participation|logout)"/);
  const home = await app.open("pages/home/index", false);
  const mode = await app.module("services/mode.js");
  assert.equal(
    mode.dataMode(),
    "live",
    "cached demo cannot change release mode",
  );
  assert.equal(home.accountLink, undefined);
  home.onLoad({});
  assert.equal(
    app.route(),
    "",
    "a stored demonstration project cannot auto-open",
  );
  const invite = await app.open("pages/invite/index", false);
  assert.equal(invite.copyInvitation, undefined);
  const order = await app.open("pages/order/index", false);
  assert.equal(typeof order.retryPayment, "function");
  assert.equal(typeof order.closeOrder, "function");
  const markup = await readFile(
    path.join(root, "pages/order/index.wxml"),
    "utf8",
  );
  assert.match(markup, /bindtap="retryPayment"/);
  assert.match(markup, /bindtap="closeOrder"/);
});
