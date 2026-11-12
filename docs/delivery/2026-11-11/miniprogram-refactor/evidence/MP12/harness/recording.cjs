// MP09 hardware-only fixture. Preparation does not invoke DevTools.
// Runtime prerequisites: follow the automator skill's wechatide status gate,
// set the same TIMENOOK_NATIVE_PROJECT / PROJECT_ID / EVIDENCE as MP05, log in
// as MP12 fixture.stories.actorCode, and INSTALL BEFORE entering interview.
// Commands: install | state | capture | allow | deny | hold | fail | release |
// pass | restore. capture begins on a real ready interview entered from Home.
// Only RecorderManager/permissions and the upload response boundary are replaced.
// No ambient microphone, fake business wx.request, page.setData or server DB edits.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const native = require("../../MP05/harness/native.cjs");
const manifestPath =
  process.env.TIMENOOK_MP12_FIXTURE ||
  path.join(
    process.env.TIMENOOK_REPO || process.cwd(),
    "test-results/mp12-native/fixture.json",
  );

function install() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(native.projectId, manifest.stories.projectId);
  assert.match(manifest.apiBase, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  return native.evaluate(
    async function (base, projectId, sourceInterviewId) {
      const app = getApp();
      if (app.__mp09Hardware) throw Error("Recorder fixture already installed");
      if (getCurrentPages().some((p) => p.route === "pages/interview/index"))
        throw Error(
          "Install before entering interview; restart the isolated runtime if a recorder is already captured",
        );
      const session = wx.getStorageSync("timenook.session.v1:" + base);
      if (!session?.session?.token)
        throw Error("Log in to the isolated story fixture first");
      const header = { authorization: "Bearer " + session.session.token };
      const request = (route) =>
        new Promise((resolve, reject) =>
          wx.request({
            url: base + route,
            header,
            success: (r) =>
              r.statusCode === 200
                ? resolve(r.data.data)
                : reject(Error("Protected fixture source unavailable")),
            fail: () =>
              reject(Error("Protected fixture source network failure")),
          }),
        );
      const sourceBase =
        "/projects/" + projectId + "/interviews/" + sourceInterviewId;
      const interview = await request(sourceBase),
        sourceId = interview.clips.find((c) => c.state === "sealed")?.id;
      if (!sourceId) throw Error("No sealed synthetic source audio");
      const source = await request(sourceBase + "/clips/" + sourceId);
      if (!source.asset || source.durationMs < 1)
        throw Error("Invalid synthetic source metadata");
      const original = {
        getRecorderManager: wx.getRecorderManager,
        getSetting: wx.getSetting,
        authorize: wx.authorize,
        openSetting: wx.openSetting,
        uploadFile: wx.uploadFile,
      };
      const fx = {
        permission: true,
        stage: "idle",
        uploadMode: "pass",
        pendingUpload: null,
        captures: 0,
        events: [],
        original,
        manager: null,
        projectId,
        source: {
          bytes: source.asset.bytes,
          sha256: source.asset.sha256,
          durationMs: source.durationMs,
        },
      };
      const event = (name) => {
        fx.events.push(name);
        if (fx.events.length > 80) fx.events.shift();
      };
      const handlers = {};
      const emit = (name, value) => {
        event(name);
        for (const fn of handlers[name] || []) fn(value);
      };
      const download = () =>
        new Promise((resolve, reject) =>
          wx.downloadFile({
            url: base + sourceBase + "/clips/" + sourceId + "/content",
            header,
            success: (result) => {
              if (result.statusCode !== 200)
                return reject(Error("Protected audio denied"));
              wx.getFileSystemManager().getFileInfo({
                filePath: result.tempFilePath,
                digestAlgorithm: "sha256",
                success: (info) =>
                  info.digest === source.asset.sha256 &&
                  info.size === source.asset.bytes
                    ? resolve(result.tempFilePath)
                    : reject(Error("Synthetic audio checksum mismatch")),
                fail: reject,
              });
            },
            fail: reject,
          }),
        );
      const manager = {
        start() {
          if (fx.stage !== "idle") return;
          if (!fx.permission)
            return setTimeout(
              () =>
                emit("error", { errMsg: "synthetic record permission denied" }),
              0,
            );
          fx.stage = "recording";
          setTimeout(() => emit("start"), 0);
        },
        pause() {
          if (fx.stage === "recording") {
            fx.stage = "paused";
            setTimeout(() => emit("pause"), 0);
          }
        },
        resume() {
          if (fx.stage === "paused") {
            fx.stage = "recording";
            setTimeout(() => emit("resume"), 0);
          }
        },
        stop() {
          if (!["recording", "paused"].includes(fx.stage)) return;
          fx.stage = "stopping";
          emit("stopping");
          // The real download supplies valid MP3 bytes. The application itself
          // saves, hashes, reserves, uploads and seals this new recording clip.
          download()
            .then((file) => {
              fx.stage = "idle";
              emit("stop", { tempFilePath: file, duration: source.durationMs });
            })
            .catch(() => {
              fx.stage = "idle";
              emit("error", { errMsg: "synthetic input download failed" });
            });
        },
      };
      for (const name of [
        "start",
        "stop",
        "error",
        "pause",
        "resume",
        "stopping",
        "interruptionBegin",
        "interruptionEnd",
      ])
        manager["on" + name[0].toUpperCase() + name.slice(1)] = (fn) =>
          (handlers[name] ||= []).push(fn);
      fx.manager = manager;
      wx.getRecorderManager = () => {
        ++fx.captures;
        return manager;
      };
      wx.getSetting = (options) =>
        original.getSetting({
          ...options,
          success: (r) =>
            options.success?.({
              ...r,
              authSetting: { ...r.authSetting, "scope.record": fx.permission },
            }),
        });
      wx.authorize = (options) => {
        if (options.scope !== "scope.record")
          return original.authorize(options);
        const result = {
          errMsg: fx.permission
            ? "authorize:ok"
            : "authorize:fail synthetic permission denied",
        };
        setTimeout(() => {
          (fx.permission ? options.success : options.fail)?.(result);
          options.complete?.(result);
        }, 0);
      };
      wx.openSetting = (options) => {
        const result = {
          authSetting: { "scope.record": fx.permission },
          errMsg: "openSetting:ok",
        };
        setTimeout(() => {
          options.success?.(result);
          options.complete?.(result);
        }, 0);
      };
      wx.uploadFile = (options) => {
        if (options.url !== base + "/recordings/objects")
          return original.uploadFile(options);
        event("upload-request-real");
        return original.uploadFile({
          ...options,
          complete: undefined,
          success: (result) => {
            event("upload-response-real:" + result.statusCode);
            const deliver = () => {
              options.success?.(result);
              options.complete?.(result);
            };
            const lose = () => {
              const error = {
                errMsg:
                  "uploadFile:fail synthetic response lost after real upload",
              };
              event("upload-response-lost");
              options.fail?.(error);
              options.complete?.(error);
            };
            if (fx.uploadMode === "hold") fx.pendingUpload = { deliver, lose };
            else if (fx.uploadMode === "fail") {
              fx.uploadMode = "pass";
              lose();
            } else deliver();
          },
          fail: (error) => {
            options.fail?.(error);
            options.complete?.(error);
          },
        });
      };
      app.__mp09Hardware = fx;
      return {
        installed: true,
        source: fx.source,
        captures: fx.captures,
        boundary:
          "synthetic RecorderManager/permission events; real protected MP3 download and business API",
      };
    },
    [
      manifest.apiBase,
      manifest.stories.projectId,
      manifest.stories.ready.interviewId,
    ],
  );
}

function control(action) {
  assert.ok(
    ["allow", "deny", "hold", "fail", "release", "pass", "restore"].includes(
      action,
    ),
  );
  return native.evaluate(
    function (action) {
      const app = getApp(),
        fx = app.__mp09Hardware;
      if (!fx) throw Error("Install recorder fixture first");
      if (action === "allow" || action === "deny")
        fx.permission = action === "allow";
      if (["hold", "pass"].includes(action)) fx.uploadMode = action;
      if (action === "fail" || action === "release") {
        const pending = fx.pendingUpload;
        fx.pendingUpload = null;
        fx.uploadMode = action === "fail" && !pending ? "fail" : "pass";
        if (pending) (action === "fail" ? pending.lose : pending.deliver)();
      }
      if (action === "restore") {
        if (fx.stage !== "idle" || fx.pendingUpload)
          throw Error("Finish recording/upload before restoring hardware");
        Object.assign(wx, fx.original);
        delete app.__mp09Hardware;
        return { restored: true };
      }
      return {
        stage: fx.stage,
        permission: fx.permission,
        uploadMode: fx.uploadMode,
        pendingUpload: !!fx.pendingUpload,
      };
    },
    [action],
  );
}
function state() {
  return native.evaluate(function () {
    const p = getCurrentPages().slice(-1)[0],
      d = p.data,
      fx = getApp().__mp09Hardware;
    return {
      route: p.route,
      screen: d.screen,
      state: d.state,
      busy: d.busy,
      pageLoading: d.pageLoading,
      canRecord: d.canRecord,
      photos: d.recordingPhotos?.length || 0,
      interviewId: d.interview?.id || p.interviewId || "",
      storyId: d.story?.id || "",
      sealed: d.localClips?.filter((c) => c.sealed).length || 0,
      hardware: fx
        ? {
            stage: fx.stage,
            captures: fx.captures,
            permission: fx.permission,
            pendingUpload: !!fx.pendingUpload,
            source: fx.source,
            events: fx.events,
          }
        : null,
    };
  });
}
function waitFor(predicate, label) {
  for (let i = 0; i < 15; i++) {
    const value = state();
    if (predicate(value)) return value;
  }
  throw Error("MP09 state not ready: " + label);
}
function capture() {
  const width = native.evaluate(function () {
    return wx.getWindowInfo().windowWidth;
  });
  assert.ok([390, 320].includes(width));
  const ready = waitFor(
    (s) =>
      s.route === "pages/interview/index" &&
      s.screen === "ready" &&
      !s.pageLoading &&
      !s.busy,
    "ready",
  );
  assert.ok(
    ready.hardware?.captures > 0,
    "RecorderManager was not captured from fixture; rebuild/restart and install before navigation",
  );
  assert.equal(ready.photos, 0, "Start with a new interview without photos");
  native.step(
    "MP09 synthetic hardware with real upload/seal at " + width,
    () => {
      native.snap("RecordReady", width);
      control("deny");
      native.tap(".start-recording");
      waitFor((s) => s.screen === "blocked" && !s.busy, "permission denied");
      native.snap("RecordBlocked", width);
      control("allow");
      native.tap(".recording-dock .tn-button");
      waitFor((s) => s.screen === "ready", "permission restored");
      native.tap(".add-photo");
      waitFor(
        (s) => s.route === "pages/photos/index" && !s.pageLoading && !s.busy,
        "photo picker",
      );
      native.tap(".photo-tile");
      native.tap(".photos-page .tn-dock .tn-button");
      waitFor(
        (s) =>
          s.route === "pages/interview/index" &&
          s.screen === "ready" &&
          s.photos > 0 &&
          !s.busy,
        "photo attached",
      );
      native.snap("RecordReadyPhoto", width);
      native.tap(".start-recording");
      waitFor((s) => s.screen === "recording" && !s.busy, "recording");
      native.snap("Recording", width);
      native.tap(".photo-heading .tn-link");
      waitFor(
        (s) =>
          s.route === "pages/photos/index" &&
          !s.pageLoading &&
          !s.busy &&
          s.hardware.stage === "paused",
        "adding photos pauses the native recorder",
      );
      native.tap(".photos-page .tn-dock .tn-button");
      waitFor(
        (s) => s.route === "pages/interview/index" && s.screen === "paused",
        "return from photos preserves pause",
      );
      native.snap("RecordPaused", width);
      native.tap(".toggle-recording");
      waitFor((s) => s.screen === "recording" && !s.busy, "resume");
      control("hold");
      native.tap(".finish-recording");
      waitFor(
        (s) => s.screen === "saving" && s.hardware.pendingUpload,
        "real uploaded response held",
      );
      native.snap("Upload", width);
      control("fail");
      waitFor(
        (s) => s.screen === "failed" && !s.busy,
        "real upload response lost",
      );
      native.snap("UploadFailed", width);
      native.tap(".recording-dock .tn-button");
      const saved = waitFor(
        (s) => s.route === "pages/story/index" && !s.pageLoading,
        "retry sealed and entered story",
      );
      assert.ok(saved.interviewId);
      const result = native.evaluate(
        async function (base, projectId, interviewId) {
          const s = wx.getStorageSync("timenook.session.v1:" + base);
          const value = await new Promise((resolve, reject) =>
            wx.request({
              url:
                base + "/projects/" + projectId + "/interviews/" + interviewId,
              header: { authorization: "Bearer " + s.session.token },
              success: (r) =>
                r.statusCode === 200
                  ? resolve(r.data.data)
                  : reject(Error("Saved recording API check failed")),
              fail: reject,
            }),
          );
          return {
            clipCount: value.clips.length,
            sealed: value.clips.filter((c) => c.state === "sealed").length,
          };
        },
        [
          JSON.parse(fs.readFileSync(manifestPath, "utf8")).apiBase,
          native.projectId,
          saved.interviewId,
        ],
      );
      assert.ok(result.sealed > 0, "No real sealed server clip");
      fs.writeFileSync(
        path.join(native.evidence, `recording-boundary-${width}.json`),
        JSON.stringify(
          {
            ...result,
            nativeWidth: width,
            syntheticHardware: true,
            syntheticDurationMs: saved.hardware.source.durationMs,
            realApi: true,
            realUploadBeforeLostResponse: true,
            ambientMicrophone: false,
            events: saved.hardware.events,
          },
          null,
          2,
        ),
      );
    },
  );
}
module.exports = { install, control, state, capture };
if (require.main === module) {
  const action = process.argv[2];
  if (action === "install") console.log(JSON.stringify(install()));
  else if (action === "state") console.log(JSON.stringify(state()));
  else if (action === "capture") capture();
  else if (action) console.log(JSON.stringify(control(action)));
  else
    console.log(
      "Prepare only. Commands: install | state | capture | allow | deny | hold | fail | release | pass | restore",
    );
}
