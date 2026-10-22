import { API_BASE_URL, AUDIO_PROBE_BUILD } from "../../config";
import { AudioProbeClient } from "../../services/audio-probe";
import type {
  ProbeSession,
  ProbeLocalClip,
} from "../../../packages/contracts/src/audio-probe";
let client: AudioProbeClient | undefined;
let privateInput = "";
Page({
  data: {
    hasPendingSave: false,
    enabled: false,
    connected: false,
    stage: "idle",
    message: "受控录音入口未开启",
    clips: [] as ProbeLocalClip[],
    sessionInput: "",
  },
  onLoad() {
    const release =
      wx.getAccountInfoSync().miniProgram.envVersion === "release";
    this.setData({
      enabled: AUDIO_PROBE_BUILD && !release,
      message:
        AUDIO_PROBE_BUILD && !release
          ? "仅用于合成或已获同意的测试样本；不属于产品账号"
          : "受控录音入口未开启",
    });
  },
  input(e: WechatMiniprogram.Input) {
    privateInput = e.detail.value;
  },
  async connect() {
    if (!this.data.enabled) return;
    try {
      const identity: ProbeSession = JSON.parse(privateInput);
      if (
        !/^[0-9a-f-]{36}$/.test(identity.id) ||
        !/^p2_[A-Za-z0-9_-]{43}$/.test(identity.token) ||
        !Number.isFinite(Date.parse(identity.expiresAt)) ||
        Date.parse(identity.expiresAt) <= Date.now()
      )
        throw new Error();
      await client?.onHide();
      client = new AudioProbeClient(API_BASE_URL, identity, true);
      client.subscribe((s) => this.setData(s));
      await client.restore();
      this.setData({ connected: true, sessionInput: "" });
      privateInput = "";
    } catch {
      this.setData({
        message: "测试身份无效或已过期，请用操作员生成的文件重试",
      });
    }
  },
  start() {
    try {
      client?.start();
    } catch {
      this.setData({ message: "测试权限已过期或入口未配置" });
    }
  },
  stop() {
    client?.stop();
  },
  retry() {
    void client?.retrySave();
  },
  async upload(e: WechatMiniprogram.TouchEvent) {
    try {
      await client?.upload(e.currentTarget.dataset.id);
    } catch {
      this.setData({ message: "上传权限已过期，本机文件仍保留" });
    }
  },
  async play(e: WechatMiniprogram.TouchEvent) {
    try {
      await client?.play(e.currentTarget.dataset.id);
    } catch {
      this.setData({ message: "回听未完成，请检查测试权限或封存状态" });
    }
  },
  onHide() {
    void client?.onHide();
  },
  onUnload() {
    client?.unsubscribe();
    void client?.onHide();
    privateInput = "";
  },
});
