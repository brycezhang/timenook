import captureUrl from "./mp3-capture-worklet.ts?worker&url";
type Run = {
  state: string;
  context?: AudioContext;
  stream?: MediaStream;
  worker?: Worker;
  node?: AudioWorkletNode;
  source?: MediaStreamAudioSourceNode;
  capturePort?: MessagePort;
  timer?: ReturnType<typeof setTimeout>;
};
export function createMp3Recorder(temporaryFile: (blob: Blob) => string) {
  let current: Run | undefined;
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  const emit = (event: string, ...args: unknown[]) =>
    handlers[event]?.forEach((fn) => fn(...args));
  async function cleanup(run: Run) {
    clearTimeout(run.timer);
    run.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    run.source?.disconnect();
    run.node?.disconnect();
    run.node?.port.close();
    run.capturePort?.close();
    run.worker?.terminate();
    if (run.context && run.context.state !== "closed")
      await run.context.close().catch(() => {});
  }
  function fail(run: Run, message: string) {
    if (current !== run) return;
    if (run.state === "failed") return;
    run.state = "failed";
    void cleanup(run).finally(() => {
      if (current === run) {
        current = undefined;
        emit("Error", { errMsg: message });
      }
    });
  }
  function arm(run: Run, message: string, timeout = 10000) {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => fail(run, message), timeout);
  }
  function stopping(run: Run) {
    if (current !== run || run.state === "stopping") return;
    run.state = "stopping";
    run.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    emit("Stopping");
    arm(run, "音频保存处理超时，请重新录制");
  }
  const api = {
    async start(options: { duration: number }) {
      if (current) return;
      const maxDuration = Math.min(options.duration, 300000);
      // Two MP3 frames cover this fixed encoder's delay + padding.
      const maxSamples = Math.floor((maxDuration * 16) / 576) * 576 - 1152;
      const run: Run = { state: "starting" };
      current = run;
      if (!Number.isFinite(maxDuration) || maxSamples < 1) {
        fail(run, "剩余录音额度不足以保存一段 MP3");
        return;
      }
      arm(run, "麦克风或音频处理初始化超时，请重试", 30000);
      try {
        if (
          !navigator.mediaDevices?.getUserMedia ||
          typeof AudioContext === "undefined" ||
          typeof AudioWorkletNode === "undefined" ||
          typeof Worker === "undefined"
        )
          throw Error(
            "此浏览器暂不支持所需录音能力，请使用支持音频处理的浏览器",
          );
        const context = (run.context = new AudioContext({ sampleRate: 16000 }));
        if (context.sampleRate !== 16000 || !context.audioWorklet)
          throw Error("此浏览器无法建立 16kHz 录音");
        const resumed = context.resume();
        const media = navigator.mediaDevices
          .getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } })
          .then((stream) => {
            if (current !== run || run.state === "failed") {
              stream.getTracks().forEach((track) => track.stop());
              throw Error("录音已结束");
            }
            run.stream = stream;
            return stream;
          });
        const worker = (run.worker = new Worker(
          new URL("./mp3-encoder-worker.ts", import.meta.url),
          { type: "module" },
        ));
        const channel = new MessageChannel();
        run.capturePort = channel.port1;
        const ready = new Promise<void>((resolve, reject) => {
          worker.onerror = () => {
            reject(Error("音频编码器启动失败"));
            fail(run, "音频编码失败，请重试");
          };
          worker.onmessageerror = () => fail(run, "音频编码消息失败");
          worker.onmessage = ({ data }) => {
            if (current !== run || run.state === "failed") return;
            if (data.kind === "ready") resolve();
            else if (data.kind === "error") {
              reject(Error(data.message));
              fail(run, data.message);
            } else if (data.kind === "complete") {
              run.state = "finishing";
              void cleanup(run).then(() => {
                if (current !== run) return;
                current = undefined;
                const blob = new Blob([data.output], { type: "audio/mpeg" });
                emit("Stop", {
                  tempFilePath: temporaryFile(blob),
                  duration: data.duration,
                  fileSize: blob.size,
                });
              });
            }
          };
        });
        worker.postMessage(
          { kind: "init", port: channel.port2, maxSamples, maxDuration },
          [channel.port2],
        );
        await Promise.all([
          media,
          resumed,
          ready,
          context.audioWorklet.addModule(captureUrl),
        ]);
        if (current !== run || run.state === "failed") return;
        context.onstatechange = () => {
          if (
            current === run &&
            ["recording", "paused"].includes(run.state) &&
            context.state !== "running"
          ) {
            emit("InterruptionBegin");
            api.stop();
          }
        };
        const node = (run.node = new AudioWorkletNode(
          context,
          "timenook-mp3-capture",
          {
            processorOptions: { maxSamples },
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          },
        ));
        node.onprocessorerror = () => fail(run, "音频采集处理失败");
        node.port.onmessageerror = () => fail(run, "音频采集消息失败");
        node.port.onmessage = ({ data }) => {
          if (current !== run || ["failed", "finishing"].includes(run.state))
            return;
          if (data.kind === "error") fail(run, data.message);
          else if (data.kind === "stopping") stopping(run);
          else if (
            data.kind === "started" ||
            data.kind === "resumed" ||
            data.kind === "paused"
          ) {
            if (run.state === "stopping") return;
            clearTimeout(run.timer);
            run.state = data.kind === "paused" ? "paused" : "recording";
            emit(
              data.kind === "started"
                ? "Start"
                : data.kind === "paused"
                  ? "Pause"
                  : "Resume",
            );
          }
        };
        node.port.postMessage({ kind: "connect", port: channel.port1 }, [
          channel.port1,
        ]);
        run.source = context.createMediaStreamSource(run.stream!);
        run.source.connect(node);
        node.connect(context.destination); // output remains silent; keeps capture processing alive
        for (const track of run.stream!.getTracks())
          track.onended = () => {
            emit("InterruptionBegin");
            api.stop();
          };
        node.port.postMessage({ kind: "start" });
        if (run.state === "stopping") node.port.postMessage({ kind: "stop" });
      } catch (error) {
        fail(run, error instanceof Error ? error.message : "麦克风不可用");
      }
    },
    pause() {
      const run = current;
      if (run?.state !== "recording") return;
      run.state = "pausing";
      arm(run, "暂停录音未能确认，请重试", 3000);
      run.node?.port.postMessage({ kind: "pause" });
    },
    resume() {
      const run = current;
      if (run?.state !== "paused") return;
      run.state = "resuming";
      arm(run, "继续录音未能确认，请重试", 3000);
      void run.context?.resume().catch(() => fail(run, "浏览器无法继续录音"));
      run.node?.port.postMessage({ kind: "resume" });
    },
    stop() {
      const run = current;
      if (!run || ["stopping", "finishing", "failed"].includes(run.state))
        return;
      stopping(run);
      run.node?.port.postMessage({ kind: "stop" });
    },
  } as Record<string, any>;
  for (const name of [
    "Start",
    "Stop",
    "Stopping",
    "Pause",
    "Resume",
    "Error",
    "InterruptionBegin",
  ])
    api["on" + name] = (fn: (...args: any[]) => void) =>
      (handlers[name] ??= []).push(fn);
  const interrupt = () => {
    if (current) {
      emit("InterruptionBegin");
      api.stop();
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) interrupt();
  });
  window.addEventListener("pagehide", interrupt);
  return api;
}
