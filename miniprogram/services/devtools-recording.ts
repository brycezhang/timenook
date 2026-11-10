import {
  MAX_RECORDING_BYTES,
  MAX_RECORDING_DURATION_MS,
} from "../../packages/contracts/src/recording";
import { Mp3Encoder } from "./mp3-encoder";

/** Devtools can return WebM bytes even when RecorderManager requests MP3. */
export async function prepareDevtoolsRecording(
  tempFilePath: string,
  clientClipId: string,
  duration: number,
  maxDurationMs: number,
): Promise<{ duration: number; savedPath?: string }> {
  if (wx.getDeviceInfo?.().platform !== "devtools") return { duration };
  const fs = wx.getFileSystemManager();
  const data = await new Promise<ArrayBuffer>((resolve, reject) =>
    fs.readFile({
      filePath: tempFilePath,
      success: (r) => resolve(r.data as ArrayBuffer),
      fail: reject,
    }),
  );
  const header = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  if (
    !header.every((v, i) => v === [0x1a, 0x45, 0xdf, 0xa3][i]) ||
    header.length !== 4
  )
    return { duration };
  const context = wx.createWebAudioContext();
  try {
    const audio = await new Promise<WechatMiniprogram.AudioBuffer>(
      (resolve, reject) => context.decodeAudioData(data, resolve, reject),
    );
    const samples = Math.floor((audio.length * 16000) / audio.sampleRate);
    if (
      !samples ||
      audio.duration * 1000 > MAX_RECORDING_DURATION_MS ||
      audio.numberOfChannels > 2
    )
      throw new Error("模拟器录音超出处理范围");
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
      audio.getChannelData(i),
    );
    const ratio = audio.sampleRate / 16000;
    const encoder = new Mp3Encoder(1, 16000, 48);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const append = (chunk: Uint8Array) => {
      bytes += chunk.length;
      if (bytes > MAX_RECORDING_BYTES) throw new Error("录音文件超过保存上限");
      chunks.push(new Uint8Array(chunk));
    };
    for (let offset = 0; offset < samples; offset += 1152) {
      const pcm = new Int16Array(Math.min(1152, samples - offset));
      for (let i = 0; i < pcm.length; i++) {
        const start = Math.floor((offset + i) * ratio);
        const end = Math.min(
          audio.length,
          Math.max(start + 1, Math.floor((offset + i + 1) * ratio)),
        );
        let sum = 0;
        for (const channel of channels)
          for (let j = start; j < end; j++) sum += channel[j];
        const value = Math.max(
          -1,
          Math.min(1, sum / ((end - start) * channels.length)),
        );
        pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
      }
      append(encoder.encodeBuffer(pcm));
      if (offset && offset % (1152 * 24) === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    append(encoder.flush());
    const encodedDuration = (bytes / 216) * 36;
    if (!bytes || bytes % 216 || encodedDuration > maxDurationMs)
      throw new Error("录音时长超过本次额度，原文件仍保留");
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    const savedPath = `${wx.env.USER_DATA_PATH}/recording-${clientClipId}.mp3`;
    await new Promise<void>((resolve, reject) =>
      fs.writeFile({
        filePath: savedPath,
        data: output.buffer,
        success: () => resolve(),
        fail: reject,
      }),
    );
    return { savedPath, duration: encodedDuration };
  } finally {
    context.close();
  }
}
