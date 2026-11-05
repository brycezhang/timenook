import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const port = 5193;
const base = `http://127.0.0.1:${port}`;
let server, production;
test.beforeAll(async () => {
  production = await mkdtemp(join(tmpdir(), "timenook-browser-mp3-build-"));
  const built = spawnSync(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "build",
      "--config",
      "tests/browser/vite.config.mjs",
      "--outDir",
      production,
    ],
    { encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
  const encoder = (await readdir(join(production, "assets"))).find((name) =>
    name.startsWith("lamejs-"),
  );
  expect(await readFile(join(production, "assets", encoder))).toEqual(
    await readFile("node_modules/@breezystack/lamejs/dist/lamejs.js"),
  );
  for (const file of [
    "source.tar.gz",
    "NOTICE.md",
    "UPSTREAM-LICENSE.txt",
    "LGPL-3.0.txt",
    "GPL-3.0.txt",
  ])
    expect(
      await readFile(join(production, "third-party/lamejs-1.2.7", file)),
    ).toEqual(await readFile(join("third-party/lamejs-1.2.7", file)));
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--config",
      "tests/browser/vite.config.mjs",
      "--outDir",
      production,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { stdio: "ignore" },
  );
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${base}/app/tests/browser/recorder.html`)).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
});
test.afterAll(async () => {
  if (server && server.exitCode === null)
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill("SIGTERM");
    });
  if (production) await rm(production, { recursive: true, force: true });
});
async function open(page) {
  await page.goto(`${base}/app/tests/browser/recorder.html`);
  await page.waitForFunction(
    () => typeof window.browserRecorder === "function",
  );
}
async function record(page, duration) {
  await open(page);
  return page.evaluate(async (duration) => {
    const source = new AudioContext({ sampleRate: 48000 });
    const oscillator = source.createOscillator(),
      output = source.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    oscillator.connect(output);
    oscillator.start();
    await source.resume();
    navigator.mediaDevices.getUserMedia = async () => output.stream;
    const recorder = window.browserRecorder();
    try {
      const result = await new Promise((resolve, reject) => {
        recorder.onError((value) => reject(Error(value.errMsg)));
        recorder.onStop(resolve);
        recorder.start({ duration });
      });
      const response = await fetch(result.tempFilePath),
        bytes = new Uint8Array(await response.arrayBuffer());
      URL.revokeObjectURL(result.tempFilePath);
      return {
        duration: result.duration,
        mime: response.headers.get("content-type"),
        bytes: Array.from(bytes),
        tracks: output.stream.getTracks().map((track) => track.readyState),
        sourceRate: source.sampleRate,
      };
    } finally {
      recorder.stop();
      oscillator.stop();
      await source.close();
    }
  }, duration);
}
async function inspect(result) {
  const dir = await mkdtemp(join(tmpdir(), "timenook-real-browser-mp3-"));
  try {
    const path = join(dir, "recording.mp3");
    await writeFile(path, Buffer.from(result.bytes));
    const probe = spawnSync(
      process.env.FFPROBE_PATH ?? "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,sample_rate,channels",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout).streams).toEqual([
      { codec_name: "mp3", sample_rate: "16000", channels: 1 },
    ]);
    const decoded = spawnSync(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        path,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { maxBuffer: 10000000 },
    );
    expect(decoded.status, decoded.stderr.toString()).toBe(0);
    return decoded.stdout.length / 32;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("a one-second remaining budget produces an actual 16k mono MP3 within decoded budget from a real 48k source", async ({
  page,
}) => {
  const result = await record(page, 1000);
  expect(result.mime).toBe("audio/mpeg");
  expect(result.sourceRate).toBe(48000);
  expect(result.tracks).toEqual(["ended"]);
  expect(result.duration).toBe(972);
  expect(await inspect(result)).toBe(972);
});
test("five-minute capture stops at the encoded duration limit without relaxing decoder bounds", async ({
  page,
}) => {
  test.setTimeout(380000);
  const result = await record(page, 300000);
  expect(result.mime).toBe("audio/mpeg");
  expect(result.duration).toBe(299988);
  expect(result.bytes.length).toBeLessThanOrEqual(2097152);
  expect(await inspect(result)).toBe(299988);
  expect(result.tracks).toEqual(["ended"]);
});

test("an insufficient budget fails before requesting microphone access", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    let requested = false;
    navigator.mediaDevices.getUserMedia = async () => {
      requested = true;
      throw Error("unexpected microphone access");
    };
    const recorder = window.browserRecorder();
    const message = await new Promise((resolve) => {
      recorder.onError((value) => resolve(value.errMsg));
      recorder.start({ duration: 100 });
    });
    return { requested, message };
  });
  expect(result.requested).toBe(false);
  expect(result.message).toContain("额度不足");
});

test("microphone permission denial reports failure without a saved recording", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
    const recorder = window.browserRecorder();
    let saved = false;
    recorder.onStop(() => {
      saved = true;
    });
    const message = await new Promise((resolve) => {
      recorder.onError((value) => resolve(value.errMsg));
      recorder.start({ duration: 1000 });
    });
    return { saved, message };
  });
  expect(result.saved).toBe(false);
  expect(result.message).toContain("Permission denied");
});

test("a Worker loading failure releases the actual microphone stream", async ({
  page,
}) => {
  await page.route("**/assets/mp3-encoder-worker-*.js", (route) =>
    route.abort("failed"),
  );
  await open(page);
  const result = await page.evaluate(async () => {
    const source = new AudioContext({ sampleRate: 48000 }),
      output = source.createMediaStreamDestination();
    navigator.mediaDevices.getUserMedia = async () => output.stream;
    const recorder = window.browserRecorder();
    const message = await new Promise((resolve) => {
      recorder.onError((value) => resolve(value.errMsg));
      recorder.start({ duration: 1000 });
    });
    const tracks = output.stream.getTracks().map((track) => track.readyState);
    await source.close();
    return { message, tracks };
  });
  expect(result.message).toContain("编码");
  expect(result.tracks).toEqual(["ended"]);
});

test("leaving while paused finishes the same MP3 without encoding the paused interval", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const source = new AudioContext({ sampleRate: 48000 }),
      oscillator = source.createOscillator(),
      output = source.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    await source.resume();
    navigator.mediaDevices.getUserMedia = async () => output.stream;
    const recorder = window.browserRecorder(),
      events = [];
    recorder.onStart(() => {
      events.push("start");
      setTimeout(() => recorder.pause(), 300);
    });
    recorder.onPause(() => {
      events.push("pause");
      setTimeout(() => window.dispatchEvent(new Event("pagehide")), 1100);
    });
    recorder.onStopping(() => events.push("saving"));
    try {
      const result = await new Promise((resolve, reject) => {
        recorder.onStop(resolve);
        recorder.onError((value) => reject(Error(value.errMsg)));
        recorder.start({ duration: 2000 });
      });
      const response = await fetch(result.tempFilePath),
        bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      URL.revokeObjectURL(result.tempFilePath);
      return {
        bytes,
        duration: result.duration,
        events,
        tracks: output.stream.getTracks().map((track) => track.readyState),
      };
    } finally {
      recorder.stop();
      oscillator.stop();
      await source.close();
    }
  });
  expect(result.events).toEqual(["start", "pause", "saving"]);
  expect(result.duration).toBeGreaterThan(250);
  expect(result.duration).toBeLessThan(600);
  expect(await inspect(result)).toBe(result.duration);
  expect(result.tracks).toEqual(["ended"]);
});

test("persisting a recording releases its temporary Blob URL while the saved file remains available", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const files = window.browserFiles,
      temporary = files.temporaryFile(
        new Blob(["synthetic persistent file"], { type: "audio/mpeg" }),
      );
    const saved = await files.saveBlob(temporary),
      restored = await files.resolveBlob(saved);
    const body = await (await fetch(restored)).text();
    let released = false;
    try {
      await fetch(temporary);
    } catch {
      released = true;
    }
    URL.revokeObjectURL(restored);
    return { released, body };
  });
  expect(result.released).toBe(true);
  expect(result.body).toBe("synthetic persistent file");
});

test("a 920ms remainder stays within the actual decoder budget", async ({
  page,
}) => {
  const result = await record(page, 920);
  expect(result.mime).toBe("audio/mpeg");
  expect(result.duration).toBe(900);
  expect(await inspect(result)).toBe(900);
});
