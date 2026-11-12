const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const readline = require("node:readline");
const repo = process.cwd();
const { createRun } = require(path.join(repo, "scripts/native-automation.cjs"));
const api = require(path.join(repo, "apps/api/dist-test/test/book-fixture.js"));
const { verifiedPhone } = require(
  path.join(repo, "apps/api/dist-test/test/wechat-profile-fixture.js"),
);
const base = "http://127.0.0.1:3423/v1";
let run, failure;
const captures = [];
async function page(name, ready = () => true) {
  return run.page(name, (d) => !d.loading && !d.busy && ready(d));
}
async function tap(selector) {
  const p = await run.mp.currentPage();
  const el = await p.$(selector);
  assert.ok(el, selector);
  await el.tap();
}
async function back() {
  const p = await run.mp.currentPage();
  const nav = await p.$("tn-navigation");
  await (await nav.$(".navigation-back")).tap();
}
async function auth(account) {
  await run.evaluate(
    (base, session) => {
      if (session) wx.setStorageSync(`timenook.session.v1:${base}`, session);
      else wx.removeStorageSync(`timenook.session.v1:${base}`);
    },
    base,
    account
      ? {
          user: { id: account.id },
          session: {
            id: account.sessionId,
            token: account.token,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        }
      : null,
  );
}
async function screenshot(name, width) {
  const info = await run.evaluate(() => wx.getWindowInfo());
  assert.equal(info.windowWidth, width);
  const rects = await run.evaluate(
    () =>
      new Promise((resolve) =>
        wx
          .createSelectorQuery()
          .select(".tn-page")
          .boundingClientRect()
          .select(".tn-dock")
          .boundingClientRect()
          .exec(resolve),
      ),
  );
  assert.ok(rects[0].width <= width);
  if (rects[1]) {
    assert.ok(rects[1].width <= width);
    assert.ok(rects[1].top >= 150);
  }
  await promisify(execFile)(
    "wechatide",
    [
      "-c",
      "Codex",
      "simulator_screenshot",
      "--project",
      run.fixture,
      "--path",
      path.join(run.output, `${name}-${width}.png`),
      "--optimize",
      "false",
      "--wait-for-selector",
      ".tn-page",
    ],
    { timeout: 15000 },
  );
  captures.push({
    board: name,
    width,
    route: (await run.mp.currentPage()).path,
    viewport: { width: info.windowWidth, height: info.windowHeight },
    rects,
  });
  await fs.writeFile(
    path.join(run.output, "screenshots.json"),
    JSON.stringify(captures, null, 2),
  );
  console.log(`CAPTURE ${name} ${width}`);
}
async function phoneLogin(account, consentPrompt) {
  await run.evaluate((who) => {
    wx.login = (options) =>
      options.success({ code: `${who}:${Date.now()}`, errMsg: "login:ok" });
  }, account.who);
  const p = await run.mp.currentPage(),
    quick = await p.$("quick-login");
  assert.ok(quick);
  if (consentPrompt) {
    await (await quick.$(".quick-login-submit")).tap();
    await quick.callMethod("continueLogin", {
      detail: {
        code: "synthetic-native-phone-proof",
        errMsg: "getPhoneNumber:ok",
      },
    });
  } else {
    await (await quick.$(".quick-login-check")).tap();
    await quick.callMethod("login", {
      detail: {
        code: "synthetic-native-phone-proof",
        errMsg: "getPhoneNumber:ok",
      },
    });
  }
}
async function capture() {
  const width = (await run.evaluate(() => wx.getWindowInfo())).windowWidth;
  assert.ok([390, 320].includes(width));
  await run.step(
    `designated gift eight boards and complete real API journey at ${width}px`,
    async () => {
      const p = await api.project(),
        recipient = await api.login();
      const phone = verifiedPhone("synthetic-timenook", recipient.who);
      api.data(
        await api.request(
          "POST",
          `/v1/projects/${p.projectId}/metadata`,
          p.buyer.token,
          { expectedVersion: 0, bookTitle: "爸爸的时光故事" },
        ),
      );
      await auth(p.buyer);
      await run.navigate("reLaunch", `/pages/order/index?id=${p.orderId}`);
      await page("order", (d) => d.activeOrder?.state === "paid");
      await tap(".tn-dock .tn-button");
      await page("gift-recipient", (d) => d.loaded);
      let current = await run.mp.currentPage(),
        inputs = await current.$$("input");
      await inputs[0].input("爸爸");
      await inputs[1].input(phone);
      await screenshot("GiftRecipient", width);
      await tap(".tn-dock .tn-button");
      let share = await page("gift-share", (d) => !!d.gift);
      const oldPath = (
        await (await run.mp.currentPage()).callMethod("onShareAppMessage")
      ).path;
      assert.equal(
        oldPath,
        `/pages/gift-claim/index?token=${share.gift.token}`,
      );
      await tap(".gift-share-page .tn-link");
      await page("gift-recipient", (d) => d.loaded);
      await tap(".tn-dock .tn-button");
      share = await page("gift-share", (d) => !!d.gift && d.gift.version === 2);
      await screenshot("GiftShare", width);
      const sharePath = (
        await (await run.mp.currentPage()).callMethod("onShareAppMessage")
      ).path;
      assert.notEqual(sharePath, oldPath);
      await auth(null);
      await run.navigate("reLaunch", oldPath);
      await page("gift-claim", (d) => d.screen === "invalid");
      await screenshot("GiftInvalid", width);
      await tap(".tn-dock .tn-button");
      await page("home");
      await run.navigate("navigateTo", sharePath);
      await page("gift-claim", (d) => d.screen === "open" && !!d.gift);
      await screenshot("GiftOpen", width);
      await tap(".tn-dock .tn-button");
      await page("gift-claim", (d) => d.screen === "verify");
      await screenshot("GiftVerify", width);
      current = await run.mp.currentPage();
      let quick = await current.$("quick-login");
      await (await quick.$(".quick-login-terms button")).tap();
      await page("terms");
      await back();
      await page("gift-claim", (d) => d.screen === "verify");
      await phoneLogin(p.buyer, true);
      await page("gift-claim", (d) => d.screen === "mismatch");
      await screenshot("GiftMismatch", width);
      await tap(".tn-dock .tn-button");
      await page("gift-claim", (d) => d.screen === "verify");
      await phoneLogin(recipient, false);
      await page("gift-claim", (d) => d.screen === "accept");
      assert.equal(
        (
          await api.request(
            "GET",
            `/v1/projects/${p.projectId}/overview`,
            recipient.token,
          )
        ).statusCode,
        403,
        "verification has not joined",
      );
      await back();
      await page("home");
      await run.navigate("navigateTo", sharePath);
      await page("gift-claim", (d) => d.screen === "open");
      await tap(".tn-dock .tn-button");
      await page("gift-claim", (d) => d.screen === "accept");
      await screenshot("GiftAccept", width);
      await tap(".tn-dock .tn-button");
      const claimed = await page("gift-claim", (d) => d.screen === "claimed");
      assert.equal(claimed.projectId, p.projectId);
      await screenshot("GiftClaimed", width);
      await tap(".tn-dock .tn-button");
      await page("home", (d) => d.overview?.projectId === p.projectId);
      await run.navigate("navigateTo", sharePath);
      const reopen = await page("gift-claim", (d) => d.screen === "claimed");
      assert.equal(reopen.projectId, p.projectId);
      assert.equal(
        await api.db.projectMember.count({
          where: { projectId: p.projectId, userId: recipient.id },
        }),
        1,
      );
      await auth(p.buyer);
      await run.navigate(
        "reLaunch",
        `/pages/gift-share/index?projectId=${p.projectId}`,
      );
      const owner = await page(
        "gift-share",
        (d) => d.gift?.state === "claimed",
      );
      assert.equal(owner.gift.token, share.gift.token);
      assert.equal(
        await (await run.mp.currentPage()).$(".gift-share-page .tn-link"),
        null,
      );
    },
  );
}
(async () => {
  try {
    process.chdir(path.join(repo, "apps/api"));
    await api.startBookFixture();
    await api.app.listen(3423, "127.0.0.1");
    process.chdir(repo);
    run = await createRun("mp03");
    const configPath = path.join(run.fixture, "dist/miniprogram/config.js");
    const source = await fs.readFile(configPath, "utf8");
    assert.ok(
      source.includes("https://timenookapi.threeminreading.com/api/v1"),
    );
    await fs.writeFile(
      configPath,
      source.replaceAll("https://timenookapi.threeminreading.com/api/v1", base),
    );
    await run.start();
    console.log("READY capture | device | paths | quit");
    const input = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    for await (const command of input) {
      try {
        if (command === "quit") break;
        if (command === "capture") await capture();
        if (command === "device")
          console.log(
            await run.evaluate(() => ({
              width: wx.getWindowInfo().windowWidth,
              height: wx.getWindowInfo().windowHeight,
            })),
          );
        if (command === "paths")
          console.log({ fixture: run.fixture, evidence: run.output });
        console.log("DONE " + command);
      } catch (error) {
        failure = error;
        console.log("FAILED " + command + ": " + error.message);
      }
    }
  } catch (error) {
    failure = error;
    console.log("FAILED SETUP " + error.message);
  } finally {
    if (run) {
      if (new Set(captures.map((c) => `${c.board}:${c.width}`)).size !== 16)
        failure ||= new Error("MP03 native coverage incomplete");
      try {
        await auth(null);
      } catch {}
      await run.finish(failure);
    }
    await api.stopBookFixture();
  }
  process.exitCode = failure ? 1 : 0;
})();
