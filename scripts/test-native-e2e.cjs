// Official DevTools automation against a fresh, isolated copy of the built app.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const automator = require("miniprogram-automator");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

async function main() {
  const fixture = await fs.mkdtemp(
    path.join(os.tmpdir(), "timenook-native-e2e-"),
  );
  const output = path.join(fixture, "evidence");
  await fs.mkdir(output);
  await fs.cp("dist/miniprogram", path.join(fixture, "dist/miniprogram"), {
    recursive: true,
  });
  const config = JSON.parse(await fs.readFile("project.config.json", "utf8"));
  await fs.writeFile(
    path.join(fixture, "project.config.json"),
    JSON.stringify(config, null, 2),
  );
  console.log(`Native E2E fixture: ${fixture}`);
  const cli =
    process.env.WECHAT_DEVTOOLS_CLI ||
    "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
  const port = Number(process.env.TIMENOOK_NATIVE_E2E_PORT || 9422);
  await promisify(execFile)(cli, [
    "auto",
    "--project",
    fixture,
    "--auto-port",
    String(port),
    "--trust-project",
  ]);
  // A newly opened DevTools project exposes its port before the base library
  // is ready. Probe Tool.getInfo before the SDK's synchronous version check.
  const sdkRequire = require("node:module").createRequire(
    require.resolve("miniprogram-automator"),
  );
  const WebSocket = sdkRequire("ws");
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("DevTools base library did not start"));
    }, 45000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ id: "ready", method: "Tool.getInfo", params: {} }),
      ),
    );
    ws.on("message", (raw) => {
      const result = JSON.parse(String(raw));
      if (result.id !== "ready") return;
      if (result.result?.SDKVersion) {
        clearTimeout(timer);
        ws.close();
        resolve();
      } else
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                id: "ready",
                method: "Tool.getInfo",
                params: {},
              }),
            ),
          500,
        );
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
  const steps = [];
  const state = () =>
    mp.evaluate(function () {
      var ps = getCurrentPages();
      var page = ps[ps.length - 1];
      return page
        ? { route: page.route, data: page.data, marker: page.nativeE2EMarker }
        : null;
    });
  async function page(name) {
    const expected = `pages/${name}/index`;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const current = await state();
      if (
        current &&
        current.route === expected &&
        Object.keys(current.data).length > 2
      ) {
        // Give native onShow/setData and the renderer a frame after routing.
        await new Promise((resolve) => setTimeout(resolve, 800));
        const shown = await state();
        if (shown?.route === expected) return shown.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Native page did not become ready: ${name}`);
  }
  const call = (name, ...args) =>
    mp.evaluate(
      function (name, args) {
        var ps = getCurrentPages();
        var current = ps[ps.length - 1];
        return current[name].apply(current, args);
      },
      name,
      args,
    );
  const input = (field, value) =>
    call("input", { currentTarget: { dataset: { field } }, detail: { value } });
  async function evidence(name) {
    await mp.screenshot({ path: path.join(output, `${name}.png`) });
    steps.push(name);
    console.log(`PASS ${name}`);
  }
  async function tab(name) {
    await mp.evaluate(function (name) {
      var ps = getCurrentPages();
      var bar = ps[ps.length - 1].getTabBar();
      if (!bar) throw new Error("Native custom tab bar is missing");
      bar.switchTab({ currentTarget: { dataset: { page: name } } });
    }, name);
    await page(name);
    assert.equal(
      await mp.evaluate(function () {
        var ps = getCurrentPages();
        return ps[ps.length - 1].getTabBar().data.selected;
      }),
      name,
    );
  }
  try {
    await mp.mockWxMethod("showModal", { confirm: true, cancel: false });
    await mp.reLaunch("/pages/home/index?browse=1");
    await page("home");
    await call("choose", { currentTarget: { dataset: { recipient: "妈妈" } } });
    let d = await page("purchase");
    assert.equal(d.recipient, "妈妈");
    await call("agree");
    await call("pay");
    d = await page("invite");
    assert.equal(d.p.recipient, "妈妈");
    const purchased = d.p.id;
    await evidence("purchase-invite");
    await call("preview");
    d = await page("welcome");
    assert.equal(d.p.id, purchased);
    assert.equal(d.agreed, false);
    await call("accept");
    d = await page("interview");
    assert.equal(d.flowStep, "prepare");
    assert.equal(d.state, "idle");
    await call("chooseAnother");
    const originalQuestion = (await page("interview")).question;
    await call("change");
    assert.notEqual((await page("interview")).question, originalQuestion);
    await call("closeQuestionPicker");
    await evidence("participation-interview");

    // The experience build's demo has no remote ASR. Continue with its explicitly
    // labelled sample stories; never represent them as this run's transcription.
    await mp.reLaunch("/pages/home/index?browse=1");
    await page("home");
    await call("experience");
    d = await page("project");
    assert.equal(d.p.sample, true);
    const sample = d.p.id;
    await mp.evaluate(function () {
      var ps = getCurrentPages();
      var p = ps[ps.length - 1];
      p.nativeE2EMarker = "preserve-this-page";
      p.filter({ currentTarget: { dataset: { filter: "pending" } } });
    });
    await tab("book");
    await tab("account");
    await tab("project");
    const retained = await state();
    assert.equal(
      retained.marker,
      "preserve-this-page",
      "Tab navigation must retain the Page instance",
    );
    assert.equal(
      retained.data.filter,
      "pending",
      "Tab navigation must retain the filter",
    );
    await tab("project");
    assert.equal((await state()).marker, "preserve-this-page");
    await evidence("tabs-retain-page");

    await call("story", { currentTarget: { dataset: { id: "sample-2" } } });
    d = await page("story");
    await call("confirm");
    d = await page("story");
    assert.equal(d.s.confirmedVersion, d.s.version);
    await call("edit");
    await page("edit-story");
    await input("title", "E2E示例校对后的故事");
    await call("save");
    d = await page("story");
    assert.notEqual(
      d.s.confirmedVersion,
      d.s.version,
      "Editing must invalidate the prior confirmation",
    );
    await call("confirm");
    d = await page("story");
    assert.equal(d.s.confirmedVersion, d.s.version);
    await evidence("story-edited-reconfirmed");

    await mp.switchTab("/pages/book/index");
    await page("book");
    await call("manuscript");
    d = await page("manuscript");
    assert.equal(d.pending, 0);
    await call("content");
    await call("layout");
    await call("approve");
    d = await page("print");
    assert.equal(d.ready, true);
    assert.equal(d.submitted, false);
    await call("submit");
    d = await page("print");
    assert.match(d.error, /收件人|手机号|地址/);
    await input("name", "E2E合成收件人");
    await input("phone", "13000000000");
    await input("detail", "合成测试省合成测试市测试路1号（不寄送）");
    await call("submit");
    d = await page("order");
    assert.equal(d.p.printRevision, d.p.revision);
    await evidence("demo-order");
    await call("project");
    await page("project");
    await tab("account");
    d = await page("account");
    assert.ok(d.projects.some((p) => p.id === purchased));
    await call("shop");
    await page("home");
    await call("choose", { currentTarget: { dataset: { recipient: "爸爸" } } });
    d = await page("purchase");
    assert.equal(d.recipient, "爸爸");
    await call("agree");
    await call("pay");
    d = await page("invite");
    assert.equal(d.p.recipient, "爸爸");
    assert.notEqual(d.p.id, purchased);
    await evidence("father-repeat-purchase");
    await call("project");
    d = await page("project");
    assert.equal(d.p.recipient, "爸爸");
    await tab("account");
    d = await page("account");
    assert.ok(d.projects.some((p) => p.id === sample));
    assert.ok(d.projects.some((p) => p.id === purchased));
    await evidence("projects-preserved");
    await fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          mode: "native local demo; sample stories; no microphone or remote payment",
          steps,
        },
        null,
        2,
      ),
    );
    console.log(`Native E2E passed. Evidence: ${output}`);
  } finally {
    await mp.restoreWxMethod("showModal").catch(() => {});
    await mp.disconnect();
  }
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack);
    process.exit(1);
  },
);
