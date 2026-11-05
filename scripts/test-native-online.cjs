// Actual deployed HTTPS services and wx.login; only microphone/photo input is synthetic.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createRun } = require("./native-automation.cjs");
const hardware = require("./native-online-fixtures.cjs");
const base = "https://timenookapi.threeminreading.com/api/v1";
const origin = "https://sgl.wootoon.cn";

async function main() {
  const run = await createRun("live");
  const { page, call, navigate, evaluate } = run;
  let error,
    cookie = "",
    csrf = "",
    projectId = "",
    storyId = "",
    interviewId = "";
  let entryId = "";
  async function web(
    route,
    body,
    method = body === undefined ? "GET" : "POST",
  ) {
    const r = await fetch(origin + "/api/v1" + route, {
      method,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      headers: {
        origin,
        "x-timenook-web": "1",
        cookie,
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const jar = new Map(
      cookie
        .split("; ")
        .filter(Boolean)
        .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]),
    );
    for (const c of r.headers.getSetCookie()) {
      const x = c.split(";")[0],
        i = x.indexOf("=");
      jar.set(x.slice(0, i), x.slice(i + 1));
    }
    cookie = [...jar].map(([k, v]) => k + "=" + v).join("; ");
    assert.ok(r.ok, `Acceptance setup HTTP ${r.status}`);
    return r.status === 204 ? null : (await r.json()).data;
  }
  const api = (route, previous = false) =>
    evaluate(
      (base, route, previous) => {
        const s = previous
          ? getApp().onlinePrevious
          : wx.getStorageSync("timenook.session.v1:" + base);
        return new Promise((resolve) =>
          wx.request({
            url: base + route,
            timeout: 15000,
            header: {
              "content-type": "text/plain",
              ...(s ? { authorization: "Bearer " + s.session.token } : {}),
            },
            success: (r) =>
              resolve({ status: r.statusCode, data: r.data?.data }),
            fail: () => resolve({ status: 0 }),
          }),
        );
      },
      base,
      route,
      previous,
    );
  async function wait(name, predicate, refresh, timeout = 180000) {
    return run.run(
      "online:wait:" + name,
      async (signal) => {
        while (!signal.aborted) {
          const d = await page(name);
          assert.ok(
            !d.error && !d.privateError && !d.processingError,
            "Page reports a processing failure",
          );
          if (predicate(d)) return d;
          assert.notEqual(
            d.story?.task?.state,
            "no_content",
            "Provider produced no story",
          );
          if (refresh) await call(refresh);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      },
      timeout,
    );
  }
  try {
    await run.step("release-build-and-production-api", async () => {
      const module = { exports: {} };
      vm.runInNewContext(
        await fs.readFile(
          path.join(run.fixture, "dist/miniprogram/config.js"),
          "utf8",
        ),
        { module },
      );
      assert.equal(module.exports.NATIVE_RELEASE, true);
      assert.equal(module.exports.API_BASE_URL, base);
    });
    if (process.argv.includes("--mvp"))
      await run.step("synthetic-hardware-preparation", () =>
        hardware.prepare(run),
      );
    await run.start();
    await run.step("native-domain-enforcement", async () => {
      const enforced = await evaluate(
        () =>
          new Promise((resolve) =>
            wx.request({
              url: "https://timenook-native-domain-probe.invalid/denied",
              timeout: 5000,
              success: () => resolve(false),
              fail: (e) =>
                resolve(
                  /url not in domain list|不在.*合法域名/.test(e.errMsg || ""),
                ),
            }),
          ),
      );
      assert.equal(enforced, true);
    });
    await run.step("real-wechat-login-and-project-entry", async () => {
      await navigate("switchTab", "/pages/account/index");
      await page("account");
      await call("login");
      await page("account", (d) => d.loggedIn && !d.status);
      assert.equal((await api("/users/me")).status, 200);
      await call("projects");
      await page("projects", (d) => d.loggedIn && !d.status);
      assert.equal((await api("/participations")).status, 200);
      assert.equal((await api("/orders")).status, 200);
    });
    if (process.argv.includes("--mvp")) {
      await run.step(
        "isolated-internal-project-and-native-invitation",
        async () => {
          csrf = (await web("/web/mock-session", {})).csrfToken;
          const p = await web("/web/mock-purchases", {
            purchaseKey: randomUUID(),
            bookTitle: "虚构纸船故事线上验收",
            subjectName: "虚构讲述者",
          });
          projectId = p.projectId;
          assert.match(projectId, /^[0-9a-f-]{36}$/);
          const invite = await web(`/projects/${projectId}/invitations`, {});
          await navigate(
            "navigateTo",
            "/pages/welcome/index?token=" + invite.token,
          );
          await page("welcome", (d) => !!d.invitation);
          await call("accept");
          const h = await page(
            "home",
            (d) => d.overview?.projectId === projectId && !d.status,
          );
          assert.equal(h.overview.canRecord, true);
          const state = await api(`/projects/${projectId}/participation`);
          assert.equal(state.data.role, "member");
          assert.equal(state.data.canInvite, false);
          run.result.project = {
            source: "internal-acceptance",
            payment: false,
            physicalProduction: false,
          };
          const anonymous = await fetch(
            base + `/projects/${projectId}/overview`,
            { signal: AbortSignal.timeout(10000) },
          );
          assert.equal(anonymous.status, 401);
        },
      );
      await run.step("pause-resume-and-automatic-upload", async () => {
        await call("record");
        await page("interview", (d) => d.canRecord);
        await call("selectQuestion", {
          currentTarget: { dataset: { kind: "free-narration" } },
        });
        await page("interview", (d) => !!d.interview);
        await call("startSpeaking");
        await page("interview", (d) => d.state === "recording");
        await call("togglePause");
        await page("interview", (d) => d.state === "paused");
        await call("togglePause");
        await page("interview", (d) => d.state === "recording");
        await call("record");
        const d = await wait(
          "interview",
          (d) => d.uploadSucceeded,
          "refreshTasks",
        );
        assert.equal(d.localClips[0].sha256, run.result.input.sha256);
        assert.equal(d.localClips[0].sealed, true);
      });
      await run.step("optional-real-followup", async () => {
        await wait("interview", (d) => d.processingReady, "refreshTasks");
        await call("moreQuestion");
        const d = await wait(
          "interview",
          (d) => !!d.followup?.result,
          "refreshFollowup",
        );
        assert.ok(["ask", "finish"].includes(d.followup.result.action));
        run.result.followup = { action: d.followup.result.action };
        await call("organizeAfterFollowup");
        await page("story");
      });
      await run.step("real-asr-and-automatic-story", async () => {
        const s = await wait(
          "story",
          (d) => !!d.story?.revision,
          "refreshLive",
        );
        storyId = s.story.id;
        interviewId = s.story.interviewId;
        assert.ok(s.liveParagraphs.some((p) => p.text.includes("纸船")));
        assert.equal(s.story.revision.origin, "ai");
        run.result.providers = { asr: true, story: true, syntheticInput: true };
      });
      await run.step("direct-chapter-editor-and-story-selection", async () => {
        await navigate(
          "navigateTo",
          `/pages/directory/index?projectId=${projectId}`,
        );
        let d = await page("directory", (d) => d.rows.length > 0 && !d.status);
        const chapter = d.rows[0].id;
        await call("open", { detail: { id: chapter } });
        d = await page("chapter", (d) => d.rows.length > 0 && !d.status);
        assert.ok(d.rows.some((r) => r.body.includes("纸船")));
        const row = d.rows.find((r) => r.id === storyId);
        const edited = row.body + "\n\n这是一段明确虚构的线上验收补充。";
        await call("body", {
          currentTarget: { dataset: { id: storyId } },
          detail: { value: edited },
        });
        await call("save");
        await page("directory");
        await call("open", { detail: { id: chapter } });
        d = await page("chapter", (d) => d.rows.length > 0 && !d.status);
        assert.ok(
          d.rows.some((r) => r.body.includes("明确虚构的线上验收补充")),
        );
        await call("choose");
        d = await page("chapter-stories", (d) => !!d.selected && !d.status);
        assert.ok(d.selected.some((r) => r.id === storyId));
      });
      await run.step("photo-auto-upload-and-real-cover-selection", async () => {
        await navigate(
          "navigateTo",
          `/pages/photos/index?projectId=${projectId}&interviewId=${interviewId}&storyId=${storyId}`,
        );
        await page("photos");
        await call("choose");
        const photos = await wait(
          "photos",
          (d) => d.snapshot?.entries?.length > 0,
          null,
          60000,
        );
        await call("editCaption", {
          detail: {
            id: photos.snapshot.entries[0].photoId,
            value: "合成照片：纸船故事的验收配图",
          },
        });
        await call("back");
        await page("chapter-stories");
        await navigate(
          "navigateTo",
          `/pages/cover-photos/index?projectId=${projectId}`,
        );
        let d = await page("cover-photos");
        run.result.coverDiagnostic = {
          rows: d.rows.length,
          loaded: d.rows.filter((x) => x.image).length,
          status: d.status,
        };
        assert.ok(d.rows.length > 0, "cover must offer the uploaded photo");
        assert.equal(d.status, "");
        assert.equal(d.rows[0].caption, "合成照片：纸船故事的验收配图");
        await call("choose", {
          currentTarget: { dataset: { id: d.rows[0].id } },
        });
        await call("save");
        await page("chapter-stories");
        await navigate(
          "navigateTo",
          `/pages/cover/index?projectId=${projectId}`,
        );
        d = await page("cover", (d) => d.hasPhoto && !!d.image && !d.status);
        assert.ok(d.image);
      });
      await run.step("generate-real-pdf-and-verify-download", async () => {
        await navigate(
          "navigateTo",
          `/pages/book/index?projectId=${projectId}`,
        );
        await page("book", (d) => !!d.context && !d.status);
        await call("generate");
        const d = await wait(
          "book",
          (d) => d.context?.current?.state === "ready",
          "refresh",
        );
        assert.ok(d.context.current.pdf.bytes > 0);
        const frozen = d.context.current.snapshot.chapters
          .flatMap((c) => c.stories)
          .find((s) => s.id === storyId);
        assert.ok(
          frozen.paragraphs.some((p) => p.includes("明确虚构的线上验收补充")),
        );
        entryId = frozen.entry.id;
        await call("manuscript");
        await page("manuscript", (d) => !!d.version);
        // Native document viewer is exercised; file size/hash checks are inside openPdf.
        await call("openPdf");
        const verified = await evaluate(() => {
          const p = getCurrentPages().slice(-1)[0];
          return { file: !!p.file, status: p.data.status };
        });
        run.result.pdfObservation = verified;
        assert.match(verified.status, /已打开.*完整 PDF/);
        run.result.pdf = {
          verifiedNativeDownload: true,
          pages: d.context.current.pageCount,
        };
      });
      await run.step("frozen-book-audio-and-native-playback", async () => {
        const anonymous = await fetch(base + "/book-audio/" + entryId, {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(anonymous.status, 401);
        await navigate(
          "reLaunch",
          "/pages/original-audio/index?entryId=" + entryId,
        );
        const d = await page("original-audio", (d) => !!d.entry && !d.status);
        assert.equal(d.entry.clips[0].sha256, run.result.input.sha256);
        await call("play", {
          currentTarget: { dataset: { id: d.entry.clips[0].clipId } },
        });
        await page("original-audio", (d) => !!d.playingClipId);
        await run.run(
          "native-audio-progress",
          async (signal) => {
            while (!signal.aborted) {
              if (
                await evaluate(() => {
                  const p = getCurrentPages().slice(-1)[0];
                  return !!p.player && p.player.currentTime > 0;
                })
              )
                return;
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          },
          15000,
        );
        await call("stop");
        await page("original-audio", (d) => !d.playingClipId);
        assert.equal(
          await evaluate(() => !getCurrentPages().slice(-1)[0].audioFile),
          true,
        );
        run.result.audio = {
          sameFrozenHash: true,
          nativeProgress: true,
          anonymousDenied: true,
          temporaryFileReleased: true,
        };
      });
      await run.step(
        "internal-project-cannot-enter-physical-production",
        async () => {
          await navigate(
            "navigateTo",
            `/pages/print/index?projectId=${projectId}`,
          );
          const d = await page("print", (d) => !!d.context && !d.status);
          assert.equal(d.context.canSubmit, false);
          assert.ok(
            d.context.blockers.includes("PHYSICAL_PRODUCTION_UNAVAILABLE"),
          );
          await call("submit");
          assert.equal((await page("print")).context.production, null);
        },
      );
    }
    await run.step("logout-revokes-current-session", async () => {
      await evaluate((base) => {
        getApp().onlinePrevious = wx.getStorageSync(
          "timenook.session.v1:" + base,
        );
      }, base);
      await navigate("switchTab", "/pages/account/index");
      await page("account", (d) => d.loggedIn);
      await call("logout");
      await page("account", (d) => !d.loggedIn && !d.busy);
      assert.equal((await api("/users/me", true)).status, 401);
    });
  } catch (e) {
    error = e;
  } finally {
    await hardware.cleanup(run);
    if (cookie)
      await run.cleanup("internal-account-session", () =>
        web("/web/session", undefined, "DELETE"),
      );
    if (run.mp)
      await run.cleanup("native-session", async () => {
        await evaluate(async (base) => {
          const key = "timenook.session.v1:" + base,
            s = wx.getStorageSync(key) || getApp().onlinePrevious;
          if (s)
            await new Promise((resolve, reject) =>
              wx.request({
                url: base + "/sessions/" + s.session.id,
                method: "DELETE",
                header: {
                  "content-type": "text/plain",
                  authorization: "Bearer " + s.session.token,
                },
                success: (r) =>
                  [204, 401].includes(r.statusCode)
                    ? resolve()
                    : reject(Error("Revoke failed")),
                fail: reject,
              }),
            );
          wx.removeStorageSync(key);
          delete getApp().onlinePrevious;
        }, base);
      });
    process.exitCode = (await run.finish(error)) ? 0 : 1;
  }
}
main().catch(() => {
  console.error("Online native setup failed; private values omitted");
  process.exitCode = 1;
});
