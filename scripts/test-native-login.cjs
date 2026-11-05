// Real wx.login + HTTPS API only. Never invoke payment or microphone APIs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { createRun } = require("./native-automation.cjs");
const base = "https://timenookapi.threeminreading.com/api/v1";

async function main() {
  const run = await createRun("live");
  const mvp = process.argv.includes("--mvp")
    ? require("./native-mvp.cjs")
    : null;
  if (process.argv.includes("--paid-project")) {
    assert.ok(mvp, "--paid-project requires --mvp");
    run.paidProjectInput = await mvp.readPaidProjectInput();
    run.paidNarratorStateFile =
      process.env.TIMENOOK_PAID_PROJECT_INPUT + ".narrator.json";
  }
  const { evaluate, page, navigate } = run;
  let error;
  const identityAction = (name) =>
    run.run(
      `live:${name}`,
      () =>
        run.mp.evaluate(function (name) {
          return getCurrentPages().slice(-1)[0][name]();
        }, name),
      75000,
    );
  const request = (route, source = "current") =>
    evaluate(
      function (base, route, source) {
        var stored = wx.getStorageSync("timenook.session.v1:" + base);
        var previous = getApp().nativeSmokePrevious;
        var session =
          source === "previous" ? previous : source === "none" ? null : stored;
        return new Promise(function (resolve) {
          wx.request({
            url: base + route,
            method: "GET",
            timeout: 10000,
            header: Object.assign(
              { "content-type": "text/plain" },
              session
                ? { authorization: "Bearer " + session.session.token }
                : {},
            ),
            success: function (response) {
              var data = response.data && response.data.data;
              resolve({
                status: response.statusCode,
                sameUser: !!session && !!data && data.id === session.user.id,
                orders:
                  data && Array.isArray(data.orders)
                    ? data.orders.length
                    : null,
                participations:
                  data && Array.isArray(data.projects)
                    ? data.projects.length
                    : null,
              });
            },
            fail: function () {
              resolve({ status: 0 });
            },
          });
        });
      },
      base,
      route,
      source,
    );
  try {
    await run.step("live-api-build", async () => {
      const module = { exports: {} };
      require("node:vm").runInNewContext(
        await fs.readFile("dist/miniprogram/config.js", "utf8"),
        { module },
      );
      assert.equal(module.exports.API_BASE_URL, base);
      if (mvp)
        assert.equal(
          module.exports.NATIVE_RELEASE,
          true,
          "MVP acceptance requires the release package",
        );
    });
    if (mvp)
      await run.step("synthetic-hardware-preparation", () => mvp.prepare(run));
    await run.start();
    await run.step("real-domain-enforcement", async () => {
      const blocked = await evaluate(function () {
        return new Promise(function (resolve) {
          wx.request({
            url: "https://timenook-native-domain-probe.invalid/denied",
            timeout: 5000,
            success: function () {
              resolve(false);
            },
            fail: function (error) {
              resolve(
                /url not in domain list|不在.*合法域名/.test(
                  error.errMsg || "",
                ),
              );
            },
          });
        });
      });
      assert.equal(
        blocked,
        true,
        "The native runtime must reject an unconfigured request domain",
      );
      run.result.domainEnforcement = true;
    });
    await run.step("real-wechat-login-current-account", async () => {
      await identityAction("login");
      await page(
        "home",
        (data) => Boolean(data.userId) && data.mode === "live",
      );
      assert.equal(
        await evaluate(function (base) {
          var stored = wx.getStorageSync("timenook.session.v1:" + base);
          var current = getCurrentPages().slice(-1)[0];
          getApp().nativeSmokePrevious = stored;
          return !!stored && stored.user.id === current.data.userId;
        }, base),
        true,
      );
      assert.deepEqual(await request("/users/me"), {
        status: 200,
        sameUser: true,
        orders: null,
        participations: null,
      });
      assert.equal((await request("/users/me", "none")).status, 401);
    });
    await run.step("persisted-session-restore", async () => {
      await navigate("reLaunch", "/pages/home/index?browse=1");
      await page(
        "home",
        (data) => Boolean(data.userId) && data.status === "已连接服务端账号",
      );
      assert.equal(
        await evaluate(function (base) {
          var stored = wx.getStorageSync("timenook.session.v1:" + base);
          var previous = getApp().nativeSmokePrevious;
          return (
            !!stored &&
            stored.session.id === previous.session.id &&
            getCurrentPages().slice(-1)[0].data.userId === previous.user.id
          );
        }, base),
        true,
      );
      assert.equal((await request("/users/me")).sameUser, true);
    });
    await run.step("logout-rejects-old-session", async () => {
      await identityAction("logout");
      await page(
        "home",
        (data) => !data.userId && data.status === "已退出登录",
      );
      assert.equal(
        await evaluate(function (base) {
          return !wx.getStorageSync("timenook.session.v1:" + base);
        }, base),
        true,
      );
      assert.equal((await request("/users/me", "previous")).status, 401);
    });
    await run.step("real-relogin-same-account-new-session", async () => {
      await identityAction("login");
      await page("home", (data) => Boolean(data.userId));
      assert.equal(
        await evaluate(function (base) {
          var stored = wx.getStorageSync("timenook.session.v1:" + base);
          var previous = getApp().nativeSmokePrevious;
          return (
            !!stored &&
            stored.user.id === previous.user.id &&
            stored.session.id !== previous.session.id
          );
        }, base),
        true,
      );
      assert.equal((await request("/users/me")).sameUser, true);
    });
    await run.step("authenticated-participation-page", async () => {
      const response = await request("/participations");
      assert.equal(response.status, 200);
      await run.run("live:participation-navigation", () =>
        run.mp.evaluate(function () {
          getCurrentPages().slice(-1)[0].participation();
        }),
      );
      await page(
        "welcome",
        (data) => data.loggedIn === true && Array.isArray(data.memberships),
      );
    });
    await run.step("authenticated-order-availability", async () => {
      const response = await request("/orders");
      // The parent deployment may still use the internal acceptance assembly.
      // Record that boundary; --orders-required makes ordinary-merchant support mandatory.
      const required = process.argv.includes("--orders-required");
      assert.ok(
        response.status === 200 || (!required && response.status === 404),
      );
      if (response.status === 200) assert.ok(Number.isInteger(response.orders));
      run.result.orders = {
        status: response.status,
        available: response.status === 200,
        required,
      };
      await navigate("reLaunch", "/pages/order/index");
      await page("order", (data) =>
        response.status === 200
          ? Array.isArray(data.orders) && !data.paymentError
          : Boolean(data.paymentError),
      );
    });
    if (mvp) await mvp.exercise(run);
  } catch (failure) {
    error = failure;
  } finally {
    if (mvp) await mvp.cleanup(run);
    if (run.mp)
      await run.cleanup("revoke-test-sessions", async () => {
        const cleaned = await run.run("cleanup:revoke-test-sessions", () =>
          run.mp.evaluate(function (base) {
            var key = "timenook.session.v1:" + base;
            var current = wx.getStorageSync(key),
              previous = getApp().nativeSmokePrevious;
            var sessions = [current, previous].filter(
              function (value, index, all) {
                return (
                  value &&
                  all.findIndex(function (other) {
                    return other && other.session.id === value.session.id;
                  }) === index
                );
              },
            );
            return Promise.all(
              sessions.map(function (stored) {
                return new Promise(function (resolve) {
                  wx.request({
                    url: base + "/sessions/" + stored.session.id,
                    method: "DELETE",
                    timeout: 10000,
                    header: {
                      "content-type": "text/plain",
                      authorization: "Bearer " + stored.session.token,
                    },
                    success: function (response) {
                      resolve(
                        response.statusCode === 204 ||
                          response.statusCode === 401,
                      );
                    },
                    fail: function () {
                      resolve(false);
                    },
                  });
                });
              }),
            ).then(function (results) {
              wx.removeStorageSync(key);
              delete getApp().nativeSmokePrevious;
              return (
                results.every(function (ok) {
                  return ok;
                }) && !wx.getStorageSync(key)
              );
            });
          }, base),
        );
        assert.equal(
          cleaned,
          true,
          "Every cached test session must be revoked and removed",
        );
      });
    process.exitCode = (await run.finish(error)) ? 0 : 1;
  }
}
main().catch(() => {
  console.error(
    "Native live setup failed; no credentials or application data logged",
  );
  process.exitCode = 1;
});
