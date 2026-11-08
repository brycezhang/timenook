// Real-time thread: downmix/quantize only. Encoding runs in the dedicated Worker.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor,
): void;
class Mp3Capture extends AudioWorkletProcessor {
  private pcm = new Int16Array(1152);
  private used = 0;
  private samples = 0;
  private readonly maxSamples: number;
  private encoder?: MessagePort;
  private pending = new Set<number>();
  private sequence = 0;
  private state = "idle";
  constructor(options: { processorOptions: { maxSamples: number } }) {
    super();
    this.maxSamples = options.processorOptions.maxSamples;
    this.port.onmessage = ({ data }) => {
      if (data.kind === "connect") {
        this.encoder = data.port;
        this.encoder!.onmessage = ({ data: reply }) => {
          if (reply.kind === "ack") this.pending.delete(reply.sequence);
        };
      } else if (data.kind === "start" || data.kind === "resume") {
        if (!this.alive()) return;
        this.state = "recording";
        this.port.postMessage({
          kind: data.kind === "start" ? "started" : "resumed",
        });
      } else if (data.kind === "pause" && this.state === "recording") {
        this.flush();
        if (!this.alive()) return;
        this.state = "paused";
        this.port.postMessage({ kind: "paused" });
      } else if (data.kind === "stop") this.finish();
    };
  }
  private alive() {
    return this.state !== "stopped";
  }
  private flush() {
    if (!this.used || this.state === "stopped") return;
    // At most 8 * 1152 samples (576 ms / 18 KiB) await encoder acknowledgment.
    if (!this.encoder || this.pending.size >= 8) {
      this.state = "stopped";
      this.port.postMessage({
        kind: "error",
        message: "音频编码未能跟上录制，请重新录制较短片段",
      });
      return;
    }
    const sequence = ++this.sequence,
      pcm = this.pcm.slice(0, this.used);
    this.pending.add(sequence);
    this.encoder.postMessage({ kind: "pcm", sequence, pcm }, [pcm.buffer]);
    this.used = 0;
  }
  private finish() {
    if (!this.alive()) return;
    this.flush();
    if (!this.alive()) return;
    this.state = "stopped";
    this.port.postMessage({ kind: "stopping" });
    // FIFO on this same port: final PCM is always encoded before MP3 flush.
    this.encoder?.postMessage({ kind: "finish", samples: this.samples });
  }
  process(inputs: Float32Array[][]) {
    if (this.state !== "recording") return this.alive();
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      if (this.samples >= this.maxSamples) {
        this.finish();
        break;
      }
      let mono = 0;
      for (const channel of channels) mono += channel[frame] ?? 0;
      mono = Math.max(-1, Math.min(1, mono / channels.length));
      this.pcm[this.used++] = Math.round(mono * (mono < 0 ? 32768 : 32767));
      this.samples++;
      if (this.used === this.pcm.length) this.flush();
      if (!this.alive()) break;
    }
    if (this.samples >= this.maxSamples) this.finish();
    return this.alive();
  }
}
registerProcessor("timenook-mp3-capture", Mp3Capture);
export {};
