// Local demo only: isolated project, synthetic microphone input, real native files.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRun } = require("./native-automation.cjs");

async function main() {
  const run = await createRun("demo");
  const { fixture, evaluate, page, call, navigate } = run;
  let audioServer, error;
  let d, purchased, sample;
  try {
    // DevTools loads this service before SDK mocks can attach. Substitute only
    // the hardware factory in the disposable copy; all persistence code stays real.
    const audio = await fs.readFile("tests/native-fixtures/silence-1s.mp3");
    audioServer = require("node:http").createServer((request, response) => {
      if (request.url !== "/silence.mp3") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": audio.length,
      });
      response.end(audio);
    });
    await new Promise((resolve, reject) => {
      audioServer.once("error", reject);
      audioServer.listen(0, "127.0.0.1", resolve);
    });
    const audioUrl = `http://127.0.0.1:${audioServer.address().port}/silence.mp3`;
    const recorderFile = path.join(
      fixture,
      "dist/miniprogram/services/recorder.js",
    );
    const recorderSource = await fs.readFile(recorderFile, "utf8");
    assert.equal(recorderSource.split("wx.getRecorderManager()").length, 2);
    const factory = `(function () {
    var handlers = {};
    return {
      onStart: function (fn) { handlers.start = fn; getApp().nativeE2ERecorderMock = true; },
      onStop: function (fn) { handlers.stop = fn; },
      onError: function (fn) { handlers.error = fn; },
      onInterruptionBegin: function () {},
      start: function () { handlers.start(); },
      stop: function () {
        wx.downloadFile({
          url: ${JSON.stringify(audioUrl)},
          success: function (file) { handlers.stop({ tempFilePath: file.tempFilePath, duration: 1000 }); },
          fail: function () { handlers.error(); }
        });
      }
    };
  })()`;
    await fs.writeFile(
      recorderFile,
      recorderSource.replace("wx.getRecorderManager()", factory),
    );

    await run.start();
    const state = () =>
      evaluate(function () {
        var current = getCurrentPages().slice(-1)[0];
        return current
          ? {
              route: current.route,
              data: current.data,
              marker: current.nativeE2EMarker,
            }
          : null;
      });
    const input = (field, value) =>
      call("input", {
        currentTarget: { dataset: { field } },
        detail: { value },
      });
    async function tab(name) {
      await evaluate(function (name) {
        var bar = getCurrentPages().slice(-1)[0].getTabBar();
        if (!bar) throw new Error("Native custom tab bar is missing");
        bar.switchTab({ currentTarget: { dataset: { page: name } } });
      }, name);
      await page(name);
      assert.equal(
        await evaluate(function () {
          return getCurrentPages().slice(-1)[0].getTabBar().data.selected;
        }),
        name,
      );
    }
    await run.step("purchase-invite", async () => {
      await navigate("reLaunch", "/pages/home/index?browse=1");
      await page("home");
      await run.run("demo:modal", () =>
        run.mp.mockWxMethod("showModal", { confirm: true, cancel: false }),
      );
      await call("choose", {
        currentTarget: { dataset: { recipient: "妈妈" } },
      });
      d = await page("purchase");
      assert.equal(d.recipient, "妈妈");
      await call("agree");
      await call("pay");
      d = await page("invite");
      assert.equal(d.p.recipient, "妈妈");
      purchased = d.p.id;

      await run.capture("purchase-invite");
    });
    await run.step("participation-interview", async () => {
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

      await run.capture("participation-interview");
    });
    await run.step("synthetic-recording-saved", async () => {
      assert.equal(
        await evaluate(function () {
          return getApp().nativeE2ERecorderMock;
        }),
        true,
        "RecorderManager fixture must be installed before starting; never open the real microphone",
      );
      await call("startSpeaking");
      assert.equal((await page("interview")).state, "recording");
      await call("record");
      d = await page(
        "interview",
        (data) => data.state === "saved" && data.flowStep === "review",
      );
      assert.equal(d.state, "saved");
      assert.equal(d.flowStep, "review");
      assert.equal(
        await evaluate(function () {
          var stored = wx.getStorageSync("timenook.frontend.v1");
          var p =
            stored &&
            stored.projects &&
            stored.projects.find(function (project) {
              return project.id === stored.activeProjectId;
            });
          var file = p && p.recordings && p.recordings[0];
          if (!file || !file.path || !file.duration) return false;
          return new Promise(function (resolve) {
            wx.getFileSystemManager().getFileInfo({
              filePath: file.path,
              success: function (info) {
                resolve(info.size > 0);
              },
              fail: function () {
                resolve(false);
              },
            });
          });
        }),
        true,
        "Synthetic recording must exist as a nonempty native saved file",
      );

      await run.capture("synthetic-recording-saved");
    });
    await run.step("same-purchased-project-order", async () => {
      await call("submitReview");
      d = await page("story");
      assert.equal(d.s.sample, true);
      await call("confirm");
      await page("story");
      await navigate("switchTab", "/pages/book/index");
      d = await page("book");
      assert.equal(d.p.id, purchased);
      assert.equal(d.p.recordings.length, 1);
      await call("manuscript");
      d = await page("manuscript");
      assert.equal(d.pending, 0);
      await call("content");
      await call("layout");
      await call("approve");
      d = await page("print");
      assert.equal(d.ready, true);
      await call("submit");
      assert.match((await page("print")).error, /收件人|手机号|地址/);
      await input("name", "E2E合成收件人");
      await input("phone", "13000000000");
      await input("detail", "合成测试省合成测试市测试路1号（不寄送）");
      await call("submit");
      d = await page("order");
      assert.equal(d.p.id, purchased);
      assert.equal(d.p.printRevision, d.p.revision);

      await run.capture("same-purchased-project-order");
    });
    await run.step("tabs-retain-page", async () => {
      // The experience build's demo has no remote ASR. Continue with its explicitly
      // labelled sample stories; never represent them as this run's transcription.
      await navigate("reLaunch", "/pages/home/index?browse=1");
      await page("home");
      await call("experience");
      d = await page("project");
      assert.equal(d.p.sample, true);
      sample = d.p.id;
      await evaluate(function () {
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

      await run.capture("tabs-retain-page");
    });
    await run.step("story-edited-reconfirmed", async () => {
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

      await run.capture("story-edited-reconfirmed");
    });
    await run.step("father-repeat-purchase", async () => {
      await navigate("switchTab", "/pages/project/index");
      await page("project");
      await tab("account");
      d = await page("account");
      assert.ok(d.projects.some((p) => p.id === purchased));
      await call("shop");
      await page("home");
      await call("choose", {
        currentTarget: { dataset: { recipient: "爸爸" } },
      });
      d = await page("purchase");
      assert.equal(d.recipient, "爸爸");
      await call("agree");
      await call("pay");
      d = await page("invite");
      assert.equal(d.p.recipient, "爸爸");
      assert.notEqual(d.p.id, purchased);

      await run.capture("father-repeat-purchase");
    });
    await run.step("projects-preserved", async () => {
      await call("project");
      d = await page("project");
      assert.equal(d.p.recipient, "爸爸");
      await tab("account");
      d = await page("account");
      assert.ok(d.projects.some((p) => p.id === sample));
      assert.ok(d.projects.some((p) => p.id === purchased));

      await run.capture("projects-preserved");
    });
  } catch (failure) {
    error = failure;
  } finally {
    if (run.mp) {
      await run.cleanup("demo-page", () =>
        evaluate(function () {
          var current = getCurrentPages().slice(-1)[0];
          if (current && current.onHide) current.onHide();
        }),
      );
      await run.cleanup("demo-modal", () =>
        run.mp.restoreWxMethod("showModal"),
      );
    }
    if (audioServer)
      await run.cleanup(
        "synthetic-audio-server",
        () => new Promise((resolve) => audioServer.close(resolve)),
      );
    process.exitCode = (await run.finish(error)) ? 0 : 1;
  }
}
main().catch(() => {
  console.error(
    "Native demo setup failed; no credentials or application data logged",
  );
  process.exitCode = 1;
});
