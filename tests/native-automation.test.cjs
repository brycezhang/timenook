const assert = require("node:assert/strict");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const { waitForPage, within } = require("../scripts/native-automation.cjs");

function nativeApp(phases) {
  let reads = 0,
    current;
  const context = {
    getApp() {
      return {
        nativeE2ERouteDone: current.routeDone === false ? null : current.route,
      };
    },
    getCurrentPages() {
      return current
        ? [{ route: current.route, data: current.data || {} }]
        : [];
    },
    wx: {
      createSelectorQuery() {
        assert.equal(
          current.ready,
          true,
          "Do not query a renderer before its Page.onReady",
        );
        return {
          selectAll(selector) {
            this.matches = selector
              .split(",")
              .map((value) => value.trim())
              .includes(current.rootClass || ".page");
            return this;
          },
          boundingClientRect(callback) {
            callback(
              current.visible && this.matches
                ? [{ width: 375, height: 600 }]
                : [],
            );
            return this;
          },
          exec() {},
        };
      },
    },
  };
  return {
    CDP: () => ({
      sendCommand: async (domain, method, params) => {
        assert.equal(domain, "MPPage");
        if (method === "getStack") {
          current = phases[Math.min(reads++, phases.length - 1)];
          return {
            pages: current ? [{ path: current.route, index: 42 }] : [],
            currentIndex: current ? 0 : -1,
          };
        }
        assert.equal(method, "waitForReady");
        assert.equal(params.webviewId, 42);
        return current.ready ? { ready: true } : new Promise(() => {});
      },
    }),
    evaluate: (fn) => runInNewContext(`(${fn.toString()})()`, context),
    reads: () => reads,
  };
}

test("SDK-only welcome state cannot pass as a rendered business page", async () => {
  await assert.rejects(
    waitForPage(nativeApp([null]), "home", { timeoutMs: 15, pollMs: 1 }),
    {
      stage: "page:home:render",
      observation: {
        route: null,
        rendered: false,
      },
    },
  );
});

test("page readiness requires the requested route, real lifecycle, native content and completed business state", async () => {
  const mp = nativeApp([
    { route: "pages/home/index", ready: true, visible: true },
    { route: "pages/story/index", ready: true, visible: false },
    {
      route: "pages/story/index",
      ready: true,
      visible: true,
      data: { loading: true },
    },
    {
      route: "pages/story/index",
      ready: true,
      visible: true,
      data: { confirmed: true },
    },
  ]);
  const data = await waitForPage(mp, "story", {
    timeoutMs: 2000,
    pollMs: 1,
    ready: (data) => data.confirmed,
  });
  assert.equal(data.confirmed, true);
  assert.equal(mp.reads(), 4);
});

test("a routed page with an empty renderer does not satisfy readiness", async () => {
  await assert.rejects(
    waitForPage(
      nativeApp([{ route: "pages/home/index", ready: true, visible: false }]),
      "home",
      { timeoutMs: 15, pollMs: 1 },
    ),
    { stage: "page:home:render" },
  );
});

test("onReady without completed native route animation cannot start the next action", async () => {
  await assert.rejects(
    waitForPage(
      nativeApp([
        {
          route: "pages/home/index",
          ready: true,
          routeDone: false,
          visible: true,
        },
      ]),
      "home",
      { timeoutMs: 15, pollMs: 1 },
    ),
    { stage: "page:home:render" },
  );
});

test("the demo book's actual book-page root is a visible native business page", async () => {
  const data = await waitForPage(
    nativeApp([
      {
        route: "pages/book/index",
        ready: true,
        visible: true,
        rootClass: ".book-page",
        data: { title: "Synthetic book" },
      },
    ]),
    "book",
    { timeoutMs: 2000, pollMs: 1 },
  );
  assert.equal(data.title, "Synthetic book");
});

test("timed-out waits stop polling and retain only safe loading observations", async () => {
  const mp = nativeApp([
    {
      route: "pages/home/index",
      ready: true,
      visible: true,
      data: {
        busy: true,
        token: "must-not-appear",
        userContent: "must-not-appear",
      },
    },
  ]);
  await assert.rejects(
    waitForPage(mp, "home", { timeoutMs: 15, pollMs: 1 }),
    (error) => {
      assert.equal(
        JSON.stringify(error.observation),
        '{"route":"pages/home/index","rendered":true,"busy":true,"loading":false}',
      );
      return true;
    },
  );
  const stoppedAt = mp.reads();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(mp.reads(), stoppedAt);
});

test("hung native commands fail at the exact operation stage", async () => {
  await assert.rejects(
    within("login:request", () => new Promise(() => {}), 5),
    { stage: "login:request", name: "NativeTimeoutError" },
  );
});

test("a native route awaiting Page.onReady cannot execute runtime or renderer queries", async () => {
  const app = nativeApp([{ route: "pages/home/index", ready: false }]);
  app.evaluate = () => {
    assert.fail("Runtime evaluation must wait for the native lifecycle");
  };
  await assert.rejects(waitForPage(app, "home", { timeoutMs: 15 }), {
    stage: "page:home:render",
  });
});
