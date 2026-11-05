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

async function cleanup(run) {
  for (const key of fixtures.get(run) || [])
    await run.cleanup("synthetic-https-input:" + key.split(".").pop(), () =>
      fixtureObject("delete", key),
    );
}
module.exports = { prepare, cleanup };
