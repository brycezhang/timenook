// LGPL-3.0 library is an unchanged, independently replaceable ESM asset.
import encoderUrl from "@breezystack/lamejs?url";
const scope = globalThis as unknown as {
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};
scope.onmessage = async ({ data }) => {
  if (data.kind !== "init") return;
  try {
    const library = await import(/* @vite-ignore */ encoderUrl);
    const encoder = new library.Mp3Encoder(1, 16000, 48);
    const port: MessagePort = data.port;
    let samples = 0,
      bytes = 0,
      finished = false;
    const chunks: Uint8Array[] = [];
    function append(chunk: Int8Array) {
      if (!chunk.length) return;
      bytes += chunk.length;
      if (bytes > 2097152) throw Error("录音文件超过保存上限");
      chunks.push(new Uint8Array(chunk));
    }
    port.onmessage = ({ data: message }) => {
      if (finished) return;
      try {
        if (message.kind === "pcm") {
          const pcm = message.pcm;
          if (
            !(pcm instanceof Int16Array) ||
            !pcm.length ||
            pcm.length > 1152 ||
            samples + pcm.length > data.maxSamples
          )
            throw Error("录音采样超过上限");
          samples += pcm.length;
          append(encoder.encodeBuffer(pcm));
          port.postMessage({ kind: "ack", sequence: message.sequence });
        } else if (message.kind === "finish") {
          finished = true;
          if (!samples || message.samples !== samples)
            throw Error("没有取得完整录音");
          append(encoder.flush());
          const output = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
          }
          // Fixed encoder emits untagged MPEG-2 Layer III: 216 bytes / 576 samples.
          // Report the actual encoded frames, including delay/padding, never wall time.
          if (!bytes || bytes % 216) throw Error("MP3 文件不完整");
          for (let frame = 0; frame < bytes; frame += 216) {
            if (
              output[frame] !== 0xff ||
              output[frame + 1] !== 0xf3 ||
              output[frame + 2] !== 0x68 ||
              (output[frame + 3] & 0xc0) !== 0xc0
            )
              throw Error("MP3 格式不符合录音要求");
          }
          const duration = (bytes / 216) * 36;
          if (duration > data.maxDuration || duration > 300000)
            throw Error("MP3 时长超过本次额度");
          chunks.length = 0;
          scope.postMessage({ kind: "complete", output, duration }, [
            output.buffer,
          ]);
          port.close();
        }
      } catch (error) {
        finished = true;
        chunks.length = 0;
        port.close();
        scope.postMessage({
          kind: "error",
          message: error instanceof Error ? error.message : "音频编码失败",
        });
      }
    };
    scope.postMessage({ kind: "ready" });
  } catch {
    scope.postMessage({ kind: "error", message: "音频编码器无法初始化" });
  }
};
