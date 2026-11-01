// Bounded official DevTools startup and rendered-page waits shared by both modes.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const automator = require("miniprogram-automator");
const WebSocket = require("node:module").createRequire(
  require.resolve("miniprogram-automator"),
)("ws");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function within(stage, action, timeoutMs = 15000) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Native operation timed out: ${stage}`);
          error.name = "NativeTimeoutError";
          error.stage = stage;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    error.stage ||= stage;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function waitForPage(
  mp,
  name,
  { timeoutMs = 45000, pollMs = 100, ready = () => true } = {},
) {
  let observation = { route: null, rendered: false };
  try {
    return await within(
      `page:${name}:render`,
      async (signal) => {
        while (!signal.aborted) {
          const cdp = mp.CDP();
          const stack = await cdp.sendCommand("MPPage", "getStack", {});
          const current = stack.pages[stack.currentIndex];
          observation.route = current?.path || null;
          if (current?.path !== `pages/${name}/index`) {
            await delay(pollMs);
            continue;
          }
          // Native lifecycle wait runs outside Runtime.evaluate, so an in-flight
          // route cannot send a JS evaluation into a frame being torn down.
          await cdp.sendCommand("MPPage", "waitForReady", {
            webviewId: current.index,
          });
          const snapshot = await mp.evaluate(function () {
            var page = getCurrentPages().slice(-1)[0];
            return page
              ? {
                  route: page.route,
                  data: page.data,
                  rendered: getApp().nativeE2ERouteDone === page.route,
                }
              : null;
          });
          observation = {
            route: snapshot?.route || null,
            rendered: snapshot?.rendered === true,
            busy: snapshot?.data?.busy === true,
            loading: snapshot?.data?.loading === true,
          };
          if (
            snapshot?.route === `pages/${name}/index` &&
            snapshot.rendered &&
            snapshot.data.busy !== true &&
            snapshot.data.loading !== true &&
            ready(snapshot.data)
          ) {
            const visible = await mp.evaluate(function () {
              return new Promise(function (resolve) {
                wx.createSelectorQuery()
                  .selectAll(
                    ".page, .home, .book-page, .interview-focus, .focus-sheet",
                  )
                  .boundingClientRect(function (rects) {
                    resolve(
                      rects.some(function (rect) {
                        return rect.width > 0 && rect.height > 0;
                      }),
                    );
                  })
                  .exec();
              });
            });
            if (visible) return snapshot.data;
          }
          await delay(pollMs);
        }
      },
      timeoutMs,
    );
  } catch (error) {
    error.observation = observation;
    throw error;
  }
}

async function sdkReady(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => finish(false), 2000);
    let done = false;
    function finish(ready) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(ready);
    }
    ws.on("error", () => finish(false));
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ id: "ready", method: "Tool.getInfo", params: {} }),
      ),
    );
    ws.on("message", (raw) => {
      const response = JSON.parse(String(raw));
      if (response.id === "ready") finish(Boolean(response.result?.SDKVersion));
    });
  });
}

async function createRun(mode) {
  const fixture = await fs.mkdtemp(
    path.join(os.tmpdir(), `timenook-native-${mode}-`),
  );
  await fs.chmod(fixture, 0o700);
  const output = path.join(fixture, "evidence");
  await fs.mkdir(output, { mode: 0o700 });
  await fs.cp("dist/miniprogram", path.join(fixture, "dist/miniprogram"), {
    recursive: true,
  });
  // Passive observers in this disposable app distinguish onReady from the end
  // of the native route animation. Starting another navigation before routeDone
  // can tear down DevTools' active AppService frame.
  await fs.appendFile(
    path.join(fixture, "dist/miniprogram/app.js"),
    `
wx.onAppRoute(function () { getApp().nativeE2ERouteDone = null; });
wx.onAppRouteDone(function (event) { getApp().nativeE2ERouteDone = event.path; });
`,
  );
  const config = JSON.parse(await fs.readFile("project.config.json", "utf8"));
  const sourceLibrary = config.libVersion;
  if (mode === "live" && config.appid !== "wxa54f81265fba2439")
    throw new Error("Unexpected live test AppID");
  // Pin the installed stable library in this disposable simulator only.
  // The absent source library silently selected a gray release during diagnosis.
  config.libVersion = process.env.TIMENOOK_NATIVE_LIBRARY || "3.17.5";
  if (!/^\d+\.\d+\.\d+$/.test(config.libVersion))
    throw new Error("Invalid test library version");
  config.projectname = `timenook-native-${mode}`;
  config.setting = { ...config.setting, urlCheck: mode === "live" };
  await fs.writeFile(
    path.join(fixture, "project.config.json"),
    JSON.stringify(config, null, 2),
  );
  const cli =
    process.env.WECHAT_DEVTOOLS_CLI ||
    "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
  const result = {
    passed: false,
    mode,
    urlCheck: config.setting.urlCheck,
    library: {
      sourceRequested: sourceLibrary,
      testRequested: config.libVersion,
    },
    steps: [],
    cleanup: [],
  };
  let mp;
  let active = "setup";
  const save = () =>
    fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
  await save();
  console.log(`Native ${mode} evidence: ${output}`);
  const run = async (stage, action, timeoutMs) => {
    active = stage;
    result.activeStage = stage;
    await save();
    return within(stage, action, timeoutMs);
  };
  async function step(name, action) {
    active = name;
    try {
      await action();
      result.steps.push({ name, passed: true });
      console.log(`PASS ${name}`);
    } catch (error) {
      result.failure = {
        step: name,
        stage: error.stage || active,
        error: error.name,
        ...(error.observation ? { observation: error.observation } : {}),
      };
      result.steps.push({
        name,
        passed: false,
        stage: result.failure.stage,
        error: error.name,
      });
      throw error;
    } finally {
      await save();
    }
  }
  async function start() {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(
        Number(process.env.TIMENOOK_NATIVE_E2E_PORT || 0),
        "127.0.0.1",
        () => {
          const selected = server.address().port;
          server.close(() => resolve(selected));
        },
      );
    });
    await step("startup", async () => {
      await run(
        "startup:official-cli",
        () =>
          promisify(execFile)(
            cli,
            [
              "auto",
              "--project",
              fixture,
              "--auto-port",
              String(port),
              "--trust-project",
            ],
            { timeout: 60000 },
          ),
        65000,
      );
      await run(
        "startup:sdk",
        async (signal) => {
          while (!signal.aborted && !(await sdkReady(port))) await delay(100);
        },
        45000,
      );
      mp = await run("startup:connect", () =>
        automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` }),
      );
      const info = await run("startup:version", () => mp.send("Tool.getInfo"));
      result.devtools = { version: info.version, SDKVersion: info.SDKVersion };
      result.library.resolved = info.SDKVersion;
      if (info.SDKVersion !== config.libVersion) {
        const error = new Error(
          "Install the requested native test library in DevTools local settings",
        );
        error.name = "NativeLibraryMismatch";
        error.stage = "startup:library-version";
        throw error;
      }
      await waitForPage(mp, "home");
    });
  }
  const evaluate = (fn, ...args) =>
    run("app:evaluate", () => mp.evaluate(fn, ...args));
  const page = (name, ready) => {
    active = `page:${name}:render`;
    return waitForPage(mp, name, { ready });
  };
  const call = (name, ...args) =>
    run(`page-method:${name}`, () =>
      mp.evaluate(
        function (name, args) {
          var current = getCurrentPages().slice(-1)[0];
          return current[name].apply(current, args);
        },
        name,
        args,
      ),
    );
  async function navigate(method, url) {
    // SDK route shortcuts contain a fixed three-second sleep. Call the same
    // native API and let page() observe the route, renderer and loading state.
    await run(`route:${method}`, () =>
      mp.CDP().sendCommand("MPPage", method, { url }),
    );
  }
  async function capture(name) {
    try {
      await run(
        `screenshot:${name}`,
        () => mp.screenshot({ path: path.join(output, `${name}.png`) }),
        8000,
      );
    } catch {
      result.screenshots ||= [];
      result.screenshots.push({ name, captured: false });
      await save();
    }
  }
  async function cleanup(name, action) {
    try {
      await run(`cleanup:${name}`, action, 15000);
      result.cleanup.push({ name, passed: true });
    } catch (error) {
      result.cleanup.push({
        name,
        passed: false,
        stage: error.stage || active,
        error: error.name,
      });
    }
    await save();
  }
  async function finish(error) {
    if (error && !result.failure)
      result.failure = { stage: error.stage || active, error: error.name };
    if (mp) await cleanup("disconnect", () => mp.disconnect());
    await cleanup("close-project", () =>
      promisify(execFile)(cli, ["close", "--project", fixture], {
        timeout: 12000,
      }),
    );
    result.passed = !error && result.cleanup.every((item) => item.passed);
    await save();
    console.log(
      `${result.passed ? "PASS" : "FAIL"} native ${mode}; ${result.failure?.stage || "complete"}; evidence: ${output}`,
    );
    return result.passed;
  }
  return {
    fixture,
    output,
    result,
    start,
    run,
    step,
    evaluate,
    page,
    call,
    navigate,
    capture,
    cleanup,
    finish,
    get mp() {
      return mp;
    },
  };
}

module.exports = { within, waitForPage, createRun };
