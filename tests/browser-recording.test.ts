import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const compiled = await build({
  entryPoints: ["preview/media.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral",
});
test("browser pause keeps one recording and excludes paused time, including stopping while paused", async () => {
  let now = 1000,
    recorder: any,
    stoppedTracks = 0;
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  class Device {
    state = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onpause?: () => void;
    onresume?: () => void;
    constructor() {
      recorder = this;
    }
    static isTypeSupported(type: string) {
      return type === "audio/webm;codecs=opus";
    }
    start() {
      this.state = "recording";
    }
    pause() {
      this.state = "paused";
      this.onpause?.();
    }
    resume() {
      this.state = "recording";
      this.onresume?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({
        data: new Blob(["controlled audio"], { type: this.mimeType }),
      });
      this.onstop?.();
    }
  }
  const module = { exports: {} as any };
  runInNewContext(compiled.outputFiles[0].text, {
    module,
    exports: module.exports,
    Blob,
    URL,
    Date: Clock,
    MediaRecorder: Device,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop() {
                stoppedTracks++;
              },
            },
          ],
        }),
      },
    },
    window: { setTimeout },
    clearTimeout,
    document: { addEventListener() {} },
  });
  const api = module.exports.createRecorder();
  const events: string[] = [];
  let completed: any;
  api.onPause(() => events.push("paused"));
  api.onResume(() => events.push("resumed"));
  api.onStop((value: any) => {
    completed = value;
  });
  await api.start({ duration: 300000 });
  const original = recorder;
  now += 2000;
  api.pause();
  now += 60000;
  api.resume();
  now += 1000;
  api.pause();
  now += 60000;
  api.stop();
  assert.equal(recorder, original);
  assert.deepEqual(events, ["paused", "resumed", "paused"]);
  assert.equal(completed.duration, 3000);
  assert.equal(
    (await fetch(completed.tempFilePath)).headers.get("content-type"),
    "audio/webm;codecs=opus",
  );
  assert.equal(stoppedTracks, 1);
  URL.revokeObjectURL(completed.tempFilePath);
});
