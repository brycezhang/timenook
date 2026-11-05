// Release-package integration: real identity/network/providers, synthetic hardware input.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const origin = "https://sgl.wootoon.cn";
const fixtures = new WeakMap();
async function remoteFixture() {
  try {
    const fs = require("node:fs/promises");
    let source = "";
    for await (const part of process.stdin) source += part;
    const { action, key, audio } = JSON.parse(source);
    if (!/^native-e2e-fixture-[a-f0-9-]{36}\.(mp3|png)$/.test(key))
      throw Error();
    const file = "dist/assets/" + key;
    if (action === "put") {
      await fs.writeFile(file, Buffer.from(audio, "base64"), {
        mode: 0o644,
        flag: "wx",
      });
      process.stdout.write(
        JSON.stringify({
          url: "https://timenookapi.threeminreading.com/admin/assets/" + key,
        }),
      );
    } else if (action === "delete") {
      await fs.unlink(file);
      process.stdout.write("{}");
    } else throw Error();
  } catch {
    process.exitCode = 1;
  }
}

async function fixtureObject(action, key, audio) {
  // Serve only this generated fictional input through the existing HTTPS static
  // host, already allowed for native downloads. Remove it after the run.
  const code = "(" + remoteFixture.toString() + ")()";
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const command =
    "cd /data/server/timenook/current/apps/admin && /data/server/timenook/runtime/node-v22.23.4-linux-x64/bin/node -e " +
    quote(code);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "root@106.14.11.96",
        command,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on("data", (x) => (output += x));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Fixture storage unavailable"));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) return reject(new Error("Fixture storage unavailable"));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("Invalid fixture storage result"));
      }
    });
    child.stdin.end(
      JSON.stringify({ action, key, audio: audio?.toString("base64") }),
    );
  });
}

async function prepare(run) {
  // Explicitly fictional input; disclosure stays in the run manifest.
  const text =
    "我小时候住在一座小城，每逢周末就和爷爷去河边散步。河边有一棵大柳树，树下有几块平整的石头，我们总坐在那里。爷爷从口袋里拿出一张旧报纸，耐心地教我折纸船。我第一次折的船歪歪扭扭，刚放进水里就翻了。爷爷没有笑话我，重新拿出一张纸，让我把每一条边都压平。第二只纸船终于浮起来了，我们沿着河岸跟着它走，直到它漂过一座小石桥。那天阳光很好，河水照得亮晶晶，我高兴得一直笑。现在每次看到河边的柳树，我都会想起爷爷低头教我折纸船的样子。我最怀念的就是那段有人耐心陪伴的日子。";
  await fs.writeFile(path.join(run.output, "synthetic-story.txt"), text, {
    mode: 0o600,
  });
  const aiff = path.join(run.output, "synthetic-story.aiff");
  const mp3 = path.join(run.output, "synthetic-story.mp3");
  await exec("say", ["-v", "Tingting", "-r", "210", "-o", aiff, text], {
    timeout: 30000,
  });
  await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-i",
      aiff,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "48k",
      mp3,
    ],
    { timeout: 30000 },
  );
  const audio = await fs.readFile(mp3);
  const probe = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    mp3,
  ]);
  const duration = Math.round(Number(probe.stdout) * 1000);
  assert.ok(duration > 3000 && duration < 120000);
  const key = `native-e2e-fixture-${randomUUID()}.mp3`;
  const object = await fixtureObject("put", key, audio);
  fixtures.set(run, [key]);
  const target = path.join(
    run.fixture,
    "dist/miniprogram/services/local-audio-recorder.js",
  );
  const source = await fs.readFile(target, "utf8");
  assert.equal(source.split("wx.getRecorderManager()").length, 2);
  const factory = `(function(){var h={};return {
    onStart:function(f){h.start=f},onStop:function(f){h.stop=f},onError:function(f){h.error=f},
    onPause:function(f){h.pause=f},onResume:function(f){h.resume=f},onInterruptionBegin:function(){},
    start:function(){h.start()},
    pause:function(){h.pause()},resume:function(){h.resume()},
    stop:function(){wx.downloadFile({url:${JSON.stringify(object.url)},success:function(f){h.stop({tempFilePath:f.tempFilePath,duration:${duration}})},fail:function(e){getApp().nativeMvpInputError=/domain/.test(e.errMsg||'')?'domain':'download';h.error()}})}
  }})()`;
  await fs.writeFile(
    target,
    source.replace("wx.getRecorderManager()", factory),
  );
  const image = await require("sharp")({
    create: { width: 800, height: 600, channels: 3, background: "#cad7b4" },
  })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(run.output, "synthetic-image.png"), image, {
    mode: 0o600,
  });
  const imageKey = `native-e2e-fixture-${randomUUID()}.png`;
  const imageObject = await fixtureObject("put", imageKey, image);
  fixtures.get(run).push(imageKey);
  const photoFile = path.join(
    run.fixture,
    "dist/miniprogram/pages/photos/index.js",
  );
  const photoSource = await fs.readFile(photoFile, "utf8");
  assert.equal(photoSource.split("wx.chooseMedia(").length, 2);
  const chooseMedia = `(function(options){wx.downloadFile({url:${JSON.stringify(imageObject.url)},success:function(f){options.success({tempFiles:[{tempFilePath:f.tempFilePath,size:${image.length},fileType:'image'}]})},fail:options.fail})})(`;
  await fs.writeFile(
    photoFile,
    photoSource.replace("wx.chooseMedia(", chooseMedia),
  );
  run.result.photoInput = {
    synthetic: true,
    width: 800,
    height: 600,
    sha256: createHash("sha256").update(image).digest("hex"),
  };

  run.result.suite = "release-mvp";
  run.result.input = {
    synthetic: true,
    hardware: "substituted",
    bytes: audio.length,
    durationMs: duration,
    sha256: createHash("sha256").update(audio).digest("hex"),
  };
}

async function readPaidProjectInput(
  file = process.env.TIMENOOK_PAID_PROJECT_INPUT,
) {
  try {
    if (!file || !path.isAbsolute(file)) throw Error();
    const stat = await fs.stat(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw Error();
    const input = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      Object.keys(input).sort().join(",") !== "orderId,projectId" ||
      ![input.orderId, input.projectId].every(
        (id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id),
      )
    )
      throw Error();
    return input;
  } catch {
    throw new Error(
      "A restricted paid-project input file with orderId and projectId is required",
    );
  }
}

function requirePaidProject(order, input) {
  assert.ok(
    order?.id === input.orderId &&
      order.state === "paid" &&
      order.mode === "wechat" &&
      order.listAmount === 99900 &&
      order.amount === 1 &&
      order.isE2e === true &&
      order.project?.id === input.projectId,
    "Paid continuation requires a verified one-fen WeChat order for the same project",
  );
  return order.project.id;
}

async function exercise(run) {
  const { page, call, navigate, evaluate } = run;
  const paid = run.paidProjectInput;
  async function ownerApi(route, data) {
    const response = await evaluate(
      function (route, data, method, key) {
        var base = "https://timenookapi.threeminreading.com/api/v1";
        var stored = wx.getStorageSync("timenook.session.v1:" + base);
        if (!stored) return { status: 401 };
        return new Promise(function (resolve) {
          wx.request({
            url: base + route,
            method: method,
            data: data,
            timeout: 15000,
            header: {
              "content-type":
                method === "GET" ? "text/plain" : "application/json",
              authorization: "Bearer " + stored.session.token,
              "idempotency-key": key,
            },
            success: function (r) {
              resolve({ status: r.statusCode, data: r.data && r.data.data });
            },
            fail: function () {
              resolve({ status: 0 });
            },
          });
        });
      },
      route,
      data ?? null,
      data === undefined ? "GET" : "POST",
      randomUUID(),
    );
    assert.ok(
      response.status >= 200 && response.status < 300,
      "Paid owner request failed",
    );
    return response.data;
  }
  async function confirmStory() {
    if (!paid) return call("decideLive");
    const current = await api(`/projects/${projectId}/stories/${storyId}`);
    assert.equal(current.confirmation.canDecide, true);
    await api(`/projects/${projectId}/stories/${storyId}/decisions`, {
      revisionId: current.revision.id,
      contentHash: current.revision.contentHash,
      expectedVersion: current.version,
      confirmed: true,
      allowInBook: true,
      noticeVersion: current.confirmation.noticeVersion,
      evidenceRef:
        current.confirmation.evidencePrefix +
        "synthetic-paid-e2e-story:" +
        randomUUID(),
    });
    await call("refreshLive");
  }
  let cookie = "",
    csrf = "",
    projectId = "",
    interviewId = "",
    storyId = "";
  let audioHash = "",
    oldRevision = "";
  if (paid && run.paidNarratorStateFile) {
    try {
      const stat = await fs.stat(run.paidNarratorStateFile);
      assert.equal(
        stat.mode & 0o077,
        0,
        "Narrator account state must remain private",
      );
      const state = JSON.parse(
        await fs.readFile(run.paidNarratorStateFile, "utf8"),
      );
      assert.equal(typeof state.cookie, "string");
      cookie = state.cookie;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Private narrator account state is invalid");
    }
  }
  async function api(
    route,
    data,
    method = data === undefined ? "GET" : "POST",
  ) {
    const response = await fetch(origin + "/api/v1" + route, {
      method,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      headers: {
        origin,
        "x-timenook-web": "1",
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(data === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      const jar = new Map(
        cookie
          .split("; ")
          .filter(Boolean)
          .map((c) => {
            const at = c.indexOf("=");
            return [c.slice(0, at), c.slice(at + 1)];
          }),
      );
      for (const item of cookies) {
        const c = item.split(";")[0],
          at = c.indexOf("=");
        jar.set(c.slice(0, at), c.slice(at + 1));
      }
      cookie = [...jar].map(([key, value]) => key + "=" + value).join("; ");
      // Keep only a restricted account-reentry file so a failed provider step
      // can be retried on the same paid project and the same narrator account.
      if (paid && run.paidNarratorStateFile)
        await fs.writeFile(
          run.paidNarratorStateFile,
          JSON.stringify({ cookie }),
          { mode: 0o600 },
        );
    }
    assert.ok(
      response.ok,
      "Web participant HTTP " +
        response.status +
        " for " +
        route.replace(/[0-9a-f-]{36}|[A-Za-z0-9_-]{43}/g, ":id"),
    );
    if (response.status === 204) return;
    const value = await response.json();
    return value.data;
  }
  async function wait(name, predicate, timeout = 180000) {
    return run.run(
      "mvp:wait:" + name,
      async (signal) => {
        while (!signal.aborted) {
          const data = await page(name);
          if (predicate(data)) return data;
          if (name === "story" && data.story?.task?.state === "no_content") {
            run.result.providerOutcome = {
              state: "no_content",
              transcriptVisible: data.liveTranscripts.length > 0,
            };
            const error = new Error("Story provider produced no content");
            error.name = "MvpStoryNoContent";
            throw error;
          }
          assert.ok(
            !data.error && !data.privateError,
            "Page reported failure at " + name,
          );
          if (name === "interview") await call("refreshTasks");
          else if (name === "story") await call("refreshLive");
          else if (name === "book") await call("refresh");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      },
      timeout,
    );
  }
  try {
    await run.step(
      paid
        ? "mvp-existing-verified-paid-project"
        : "mvp-isolated-unpaid-project",
      async () => {
        const account = await api("/web/mock-session", {});
        csrf = account.csrfToken;
        if (paid) {
          const order = await ownerApi("/orders/" + paid.orderId);
          projectId = requirePaidProject(order, paid);
          run.result.project = {
            id: projectId,
            source: "paid",
            isE2e: true,
            payment: true,
            actualFen: 1,
            listAmount: 99900,
            physicalProduction: false,
          };
          run.result.actors = {
            initiator: "real-wechat-owner",
            narrator: "separate-web-acceptance-account",
            input: "synthetic",
            humanConsentAcceptance: false,
          };
          return;
        }
        const project = await api("/web/mock-purchases", {
          purchaseKey: randomUUID(),
          bookTitle: "虚构河边纸船故事验收",
          subjectName: "虚构讲述者",
        });
        projectId = project.projectId;
        assert.match(projectId, /^[0-9a-f-]{36}$/);
        run.result.project = {
          id: projectId,
          source: "internal-acceptance",
          payment: false,
          physicalProduction: false,
        };
      },
    );
    await run.step("mvp-native-invitation-binding-consent", async () => {
      if (paid) {
        const state = await ownerApi(`/projects/${projectId}/participation`);
        assert.equal(state.role, "initiator");
        assert.equal(state.source, "paid");
        assert.equal(state.policyStatus, "paid-e2e");
        // A distinct acceptance account acts as narrator. No account link or
        // second internal project is created; every fact belongs to the paid order.
        if (state.bindingVersion === 0) {
          const invitation = await ownerApi(
            `/projects/${projectId}/invitations`,
            {},
          );
          const notice = await api(`/invitations/${invitation.token}`);
          const request = await api(
            `/invitations/${invitation.token}/requests`,
            {
              noticeVersion: notice.noticeVersion,
              evidenceRef:
                notice.evidencePrefix +
                "synthetic-paid-e2e-narrator-application",
            },
          );
          await ownerApi(`/binding-requests/${request.id}/approve`, {
            expectedBindingVersion: state.bindingVersion,
            evidenceRef:
              state.evidencePrefix + "synthetic-paid-e2e-account-check",
          });
        }
        const narrator = await api(`/projects/${projectId}/participation`);
        assert.equal(narrator.role, "narrator");
        await api(`/projects/${projectId}/consents/start`, {
          noticeVersion: narrator.noticeVersion,
          evidenceRef:
            narrator.evidencePrefix + "synthetic-paid-e2e-purpose-start",
          expectedBindingVersion: narrator.bindingVersion,
          expectedAccessEpoch: narrator.accessEpoch,
        });
        await navigate(
          "reLaunch",
          `/pages/assisted/index?projectId=${projectId}`,
        );
        await page("assisted", (d) => d.participation?.role === "initiator");
        await call("choicesChanged", {
          detail: { value: ["collection", "ai", "sharing"] },
        });
        await call("submitChoices");
        await page("interview", (d) => d.canRecord === true);
        return;
      }
      const invitation = await api(
        "/projects/" + projectId + "/invitations",
        {},
      );
      await navigate(
        "reLaunch",
        "/pages/welcome/index?token=" + invitation.token,
      );
      await page("welcome", (d) => !!d.invitation && d.loggedIn);
      await call("accept");
      await page("welcome", (d) => !!d.status && !d.invitation);
      const requests = await api(
        "/projects/" + projectId + "/binding-requests",
      );
      assert.equal(requests.requests.length, 1);
      await api("/binding-requests/" + requests.requests[0].id + "/approve", {
        expectedBindingVersion: 0,
        evidenceRef: "internal:synthetic-native-mvp-account-check",
      });
      await navigate("reLaunch", "/pages/welcome/index?projectId=" + projectId);
      const d = await page(
        "welcome",
        (d) => d.participation?.role === "narrator",
      );
      assert.ok(d.participation.choices.every((c) => c.granted === null));
      await call("confirmAndStart");
      await page("interview", (d) => d.canRecord === true);
    });
    await run.step("mvp-native-select-pause-resume-save", async () => {
      await call("selectQuestion", {
        currentTarget: { dataset: { kind: "free-narration" } },
      });
      let d = await page("interview", (d) => !!d.interview);
      interviewId = d.interview.id;
      await call("startSpeaking");
      await page("interview", (d) => d.state === "recording");
      await call("togglePause");
      await page("interview", (d) => d.state === "paused");
      await call("togglePause");
      await page("interview", (d) => d.state === "recording");
      await call("record");
      d = await page(
        "interview",
        (d) =>
          (d.flowStep === "review" && d.localClips.length === 1) ||
          d.state === "device-error",
      );
      run.result.hardwareObservation = {
        stage: d.state,
        flowStep: d.flowStep,
        clips: d.localClips.length,
        inputError: await evaluate(function () {
          return getApp().nativeMvpInputError || null;
        }),
      };
      assert.equal(d.state, "local");
      assert.ok(!d.localClips[0].sealed);
      audioHash = d.localClips[0].sha256;
      assert.equal(audioHash, run.result.input.sha256);
      assert.equal(
        await evaluate(function () {
          var d = getCurrentPages().slice(-1)[0].data;
          return (
            wx.getFileSystemManager().statSync(d.localClips[0].path).size > 0
          );
        }),
        true,
      );
    });
    await run.step("mvp-native-cloud-save-real-asr", async () => {
      await call("submitReview");
      const d = await wait("interview", (d) => d.processingReady === true);
      assert.ok(d.localClips[0].sealed);
      assert.equal(d.localClips[0].storage, "oss");
      assert.equal(d.localClips[0].sha256, audioHash);
      run.result.recording = {
        interviewId,
        intentId: d.localClips[0].serverId,
        cloudSaved: true,
        storage: "oss",
        sha256: audioHash,
        transcription: true,
      };
    });
    await run.step("mvp-optional-real-followup", async () => {
      await call("moreQuestion");
      const d = await wait("interview", (d) => !!d.followup?.result);
      assert.ok(["ask", "finish"].includes(d.followup.result.action));
      run.result.followup = { action: d.followup.result.action };
      await call("organizeAfterFollowup");
    });
    await run.step("mvp-real-story-confirmation", async () => {
      let d = await wait("story", (d) => !!d.story?.revision);
      storyId = d.story.id;
      assert.equal(d.story.revision.origin, "ai");
      assert.ok(
        d.story.task.sources.some((source) =>
          source.transcript?.text.includes("纸船"),
        ),
      );
      assert.ok(d.liveParagraphs.some((p) => p.text.includes("纸船")));
      if (d.needsReview) {
        await call("edit");
        let e = await page("edit-story", (d) => !!d.story?.revision);
        for (let index = 0; index < e.reviews.length; index++)
          await call("reviewReason", {
            currentTarget: { dataset: { index: String(index) } },
            detail: {
              value: "明确虚构的合成验收故事，按输入核对，不作为真人事实",
            },
          });
        await call("save");
        await page("story", (d) => !!d.story?.revision);
        await call("refreshLive");
      }
      d = await page("story", (d) => (paid || d.canDecide) && !d.needsReview);
      oldRevision = d.story.revision.id;
      await confirmStory();
      d = await page("story", (d) => d.story?.decision?.confirmed === true);
      assert.equal(d.story.decision.allowInBook, true);
      run.result.story = {
        id: storyId,
        revisionId: d.story.revision.id,
        confirmed: true,
        generationOrigin: "ai",
      };
    });
    await run.step("mvp-photo-after-story-without-rerecording", async () => {
      await call("editLivePhotos");
      const before = await page("photos");
      const priorReferences = (before.snapshot?.entries ?? []).map(
        (p) => p.photoId,
      );
      const priorLocalIds = before.photos.map((p) => p.clientPhotoId);
      await call("choose");
      let photos = await page("photos", (d) =>
        d.photos.some(
          (p) =>
            !priorLocalIds.includes(p.clientPhotoId) && p.state === "local",
        ),
      );
      const localPhoto = photos.photos.find(
        (p) => !priorLocalIds.includes(p.clientPhotoId),
      );
      assert.equal(localPhoto.sha256, run.result.photoInput.sha256);
      await call("upload", {
        currentTarget: { dataset: { id: localPhoto.clientPhotoId } },
      });
      photos = await page("photos", (d) => {
        const uploaded = d.photos.find(
          (p) => p.clientPhotoId === localPhoto.clientPhotoId,
        );
        return (
          uploaded?.state === "sealed" &&
          d.snapshot?.entries.some((p) => p.photoId === uploaded.serverId)
        );
      });
      const photoId = photos.photos.find(
        (p) => p.clientPhotoId === localPhoto.clientPhotoId,
      ).serverId;
      assert.ok(!priorReferences.includes(photoId), "MVP_NEW_PHOTO_REFERENCE");
      assert.ok(
        priorReferences.every((id) =>
          photos.snapshot.entries.some((p) => p.photoId === id),
        ),
        "MVP_PRIOR_PHOTO_REFERENCES_PRESERVED",
      );
      await call("caption", {
        currentTarget: { dataset: { id: photoId } },
        detail: { value: "虚构验收图：绿色色块，与真实人物无关" },
      });
      await call("saveCaption", {
        currentTarget: { dataset: { id: photoId } },
      });
      await call("preview", { currentTarget: { dataset: { id: photoId } } });
      photos = await page("photos", (d) => !!d.previewPath);
      assert.equal(
        photos.snapshot.entries.find((p) => p.photoId === photoId).caption,
        "虚构验收图：绿色色块，与真实人物无关",
      );
      run.result.photo = {
        id: photoId,
        baselineReferenceIds: priorReferences,
        referenceCountAfterUpload: photos.snapshot.entries.length,
        cloudSealed: true,
        privatePreview: true,
        caption: true,
      };
      await call("back");
      await page("story", (d) => !!d.story?.revision);
    });
    await run.step("mvp-edit-invalidates-and-reconfirm", async () => {
      await call("edit");
      await page("edit-story", (d) => !!d.story?.revision);
      await call("applyPhotos");
      await page("edit-story", (d) =>
        d.photoSnapshot?.entries.some((p) => p.photoId === run.result.photo.id),
      );
      await call("input", {
        currentTarget: { dataset: { field: "title" } },
        detail: { value: "河边的纸船与陪伴（虚构验收校对）" },
      });
      await call("save");
      let d = await page(
        "story",
        (d) => !!d.story?.revision && d.story.revision.id !== oldRevision,
      );
      assert.notEqual(
        d.story.decision?.confirmed,
        true,
        "MVP_CONFIRMATION_INVALIDATED",
      );
      assert.ok(d.liveAudioSources.length > 0, "MVP_ORIGINAL_AUDIO_PRESERVED");
      assert.ok(
        d.story.revision.photoSnapshot.entries.some(
          (p) => p.photoId === run.result.photo.id,
        ),
        "MVP_PHOTO_SNAPSHOT_MATCH",
      );
      assert.equal(
        d.story.task.sources[0].intentId,
        run.result.recording.intentId,
        "MVP_ORIGINAL_UPLOAD_INTENT_PRESERVED",
      );
      await confirmStory();
      d = await page("story", (d) => d.story?.decision?.confirmed === true);
      run.result.story.revisionId = d.story.revision.id;
      run.result.story.reconfirmed = true;
    });
    await run.step("mvp-native-tabs-project-and-pdf", async () => {
      await navigate("reLaunch", "/pages/project/index?projectId=" + projectId);
      await page("project", (d) => d.overview?.projectId === projectId);
      await evaluate(function () {
        getCurrentPages().slice(-1)[0].nativeMvpMarker = "retain";
      });
      for (const name of ["book", "account", "project"]) {
        await navigate("switchTab", "/pages/" + name + "/index");
        await page(name);
      }
      assert.equal(
        await evaluate(function () {
          return getCurrentPages().slice(-1)[0].nativeMvpMarker;
        }),
        "retain",
      );
      await navigate("switchTab", "/pages/book/index");
      let book = await page("book", (d) =>
        d.context?.eligibleStories.some((s) => s.id === storyId),
      );
      if (!book.draft.some((c) => c.storyRefs.includes(storyId))) {
        await call("editDirectory");
        if (!book.draft.length) await call("addChapter");
        await call("assignStory", {
          currentTarget: { dataset: { chapter: "0", id: storyId } },
        });
        await call("saveDirectory");
        await page("book", (d) => !d.dirty && !!d.context?.inputHash);
      }
      await call("generate");
      const d = await wait(
        "book",
        (d) => d.context?.current?.state === "ready",
      );
      assert.ok(d.context.current.pageCount > 0);
      run.result.book = {
        versionId: d.context.current.id,
        sha256: d.context.current.pdf.sha256,
        pages: d.context.current.pageCount,
      };
      await call("manuscript");
      await page("manuscript", (d) => d.version?.state === "ready");
      // Downloads and verifies bytes in the real native filesystem; opening the OS viewer is separate.
      const verified = await evaluate(
        function (projectId, versionId, expectedHash) {
          var base = "https://timenookapi.threeminreading.com/api/v1";
          var stored = wx.getStorageSync("timenook.session.v1:" + base);
          return new Promise(function (resolve) {
            wx.downloadFile({
              url:
                base +
                "/projects/" +
                projectId +
                "/book/versions/" +
                versionId +
                "/pdf",
              header: { authorization: "Bearer " + stored.session.token },
              success: function (r) {
                wx.getFileSystemManager().getFileInfo({
                  filePath: r.tempFilePath,
                  digestAlgorithm: "sha256",
                  success: function (info) {
                    wx.getFileSystemManager().unlink({
                      filePath: r.tempFilePath,
                      complete: function () {
                        resolve({
                          status: r.statusCode,
                          hash: info.digest === expectedHash,
                          bytes: info.size,
                        });
                      },
                    });
                  },
                  fail: function () {
                    resolve({ status: 0 });
                  },
                });
              },
              fail: function () {
                resolve({ status: 0 });
              },
            });
          });
        },
        projectId,
        run.result.book.versionId,
        run.result.book.sha256,
      );
      assert.equal(verified.status, 200);
      assert.equal(verified.hash, true);
      assert.ok(verified.bytes > 0);
      run.result.book.nativeDownloadVerified = true;
    });
    await run.step("mvp-both-confirm-same-pdf", async () => {
      await call("chooseContentConfirmation");
      await call("contentEvidence", {
        detail: { value: "internal:虚构验收书稿的文字、原声与同版PDF核对" },
      });
      await call("confirmContent");
      let d = await page(
        "manuscript",
        (d) =>
          d.confirmations?.confirmations[paid ? "initiator" : "narrator"] ===
          true,
      );
      const context = await api(
        "/projects/" + projectId + "/book/confirmations",
      );
      await api("/projects/" + projectId + "/book/confirmations", {
        role: paid ? "narrator" : "initiator",
        bookVersionId: context.bookVersionId,
        snapshotHash: context.snapshotHash,
        pdfHash: context.pdfHash,
        noticeVersion: context.noticeVersion,
        evidenceRef: "internal:synthetic-native-mvp-same-pdf",
      });
      await call("refresh");
      d = await page(
        "manuscript",
        (d) =>
          d.confirmations?.confirmations.narrator &&
          d.confirmations.confirmations.initiator,
      );
      assert.equal(d.confirmations.pdfHash, run.result.book.sha256);
      run.result.book.bothConfirmed = true;
    });
    await run.step("mvp-book-audio-and-anonymous-denial", async () => {
      const manuscript = await page("manuscript", (d) => !!d.version);
      const story = manuscript.version.snapshot.chapters
        .flatMap((c) => c.stories)
        .find((s) => s.id === storyId);
      assert.ok(story.entry?.id);
      const anonymous = await fetch(
        "https://timenookapi.threeminreading.com/api/v1/book-audio/" +
          story.entry.id,
        { signal: AbortSignal.timeout(10000) },
      );
      assert.equal(anonymous.status, 401);
      await navigate(
        "reLaunch",
        "/pages/original-audio/index?entryId=" + story.entry.id,
      );
      const audio = await page("original-audio", (d) => !!d.entry);
      assert.equal(audio.entry.story.revisionId, run.result.story.revisionId);
      assert.equal(audio.entry.clips[0].sha256, run.result.input.sha256);
      await call("play", {
        currentTarget: { dataset: { id: audio.entry.clips[0].clipId } },
      });
      await page("original-audio", (d) => !!d.playingClipId);
      await run.run(
        "mvp:native-audio-progress",
        async (signal) => {
          while (!signal.aborted) {
            if (
              await evaluate(function () {
                var p = getCurrentPages().slice(-1)[0];
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
        await evaluate(function () {
          return !getCurrentPages().slice(-1)[0].audioFile;
        }),
        true,
      );
      run.result.book.audio = {
        sameRevision: true,
        sameHash: true,
        nativePlaybackProgress: true,
        anonymousDenied: true,
        temporaryFileCleared: true,
      };
    });
  } finally {
    if (cookie)
      await run.cleanup("initiator-session", () =>
        api("/web/session", undefined, "DELETE"),
      );
  }
}
async function cleanup(run) {
  for (const key of fixtures.get(run) || [])
    await run.cleanup("synthetic-https-input:" + key.split(".").pop(), () =>
      fixtureObject("delete", key),
    );
}
module.exports = {
  prepare,
  exercise,
  cleanup,
  readPaidProjectInput,
  requirePaidProject,
};
