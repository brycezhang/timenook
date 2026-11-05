# 浏览器录音原件

工程票 [W03b #106](https://github.com/brycezhang/timenook/issues/106)，归属 W03／统一分步讲述。沿用 [ADR0006](adr/0006-file-asr-after-save.md)：本机保存 → 明确提交 → 上传封存 → 文件转写。浏览器本次生成的 MP3 就是录制原件；已保存或封存文件不被转换覆盖，上传字节、SHA-256、原声读取和 ASR 取源继续指向同一文件。

## 采集与编码

浏览器需要安全上下文、`getUserMedia`、`AudioContext`、`AudioWorklet` 和模块 Worker。录制时建立并核实实际 16kHz 的 AudioContext；MediaStreamAudioSourceNode 将设备实际采样率转换到该 context。Worklet 按实际输入 block 和通道下混、夹限、量化成单声道 Int16 PCM，每批最多 1152 样本，通过独立 MessagePort 交给编码 Worker。主线程不执行 MP3 编码。

Worker 使用固定 `@breezystack/lamejs@1.2.7`，参数单声道／16kHz／48kbps。它动态导入原样独立 ESM asset；应用构建不把库内联或压缩进主线程／Worker。来源、版权、完整 LGPL v3／GPL v3 和对应源码归档见 [第三方说明](../third-party/lamejs-1.2.7/NOTICE.md)。浏览器产物同目录发布 `third-party/lamejs-1.2.7/`；开发预览也可读取该路径。

暂停先排空当前 PCM 批次并确认，再报告暂停；暂停期间不采样，也不 flush MP3。继续沿用同一 encoder 与实际问题，仍须经页面授权检查。停止将最后 PCM 和 finish 依次发到同一 FIFO 通道，收到完整 MP3 后清理设备，再发 Stop。停止处理期间立即显示“正在处理并保存”，文件与清单真正持久化后才显示已在本机保存。退出、切账号、失权及后台结束复用此设备生命周期；尚在内存中的片段不保证系统强杀恢复。

Worklet 最多允许 8 个未确认 PCM 批次（9216 样本／18KiB）；编码跟不上时明确失败，不无限排队。Worker 的输出累计硬限 2MiB；最终组装时最多同时保留两份输出，PCM 不按整段保留。初始化限 30 秒、暂停／继续确认限 3 秒、停止编码限 10 秒；异常、轨道结束与 context 中断均清理 tracks、node／ports、context、Worker，并经原有错误回调释放录音 lease。缺失所需浏览器能力时明确失败。

## 解码时长和额度

`POST .../recording-start` 返回 `maxDurationMs`：冻结套餐每段上限、300000ms 硬上限、总额度减已消费和上传预留的最小值。它仍核对当前实际问题和授权，不创建上传预留。两端页面将此预算传到录音接口；demo／受控探针默认仍为 5 分钟。继续录音仍重验权限和当前问题。

该固定编码参数输出没有 ID3 的 MPEG-2 Layer III 帧，每帧 216 bytes／576 样本／36ms。采集上限为：

```text
floor(maxDurationMs × 16 / 576) × 576 − 1152 samples
```

两帧余量覆盖编码 delay／padding；不足以采到一个样本的预算在请求麦克风前失败。Worker 检查最终帧头／长度并以实际帧数报告含 padding 的 MP3 时长，拒绝超过预算的产物。5 分钟采集最多 4798656 样本，产物解码 299988ms；1 秒额度产物解码 972ms。暂停时间不进入样本数。

预算只是录前快照；同时录制或上传可能改变剩余额度，未提前预占。本机录音不保证一定能上传，最终 create/upload/seal 在服务端锁内按当前授权、reservation 和真实 FFmpeg 解码时长裁决。失败保留本机原文件；服务端 5 分钟、2MiB 和总额度规则保持原有值。

## 验证

- `tests/admin/browser-mp3.spec.mjs` 用 `/app/` 基址的生产构建和真实 48kHz 合成流，覆盖 MP3 实际解码、小额度／5分钟边界、权限拒绝、Worker 加载失败、暂停和离页；构建同时逐字节检查独立 encoder asset、源码与许可文件。
- `tests/admin/interview-recording.spec.mjs` 的真实 adapter 用例仅替换麦克风输入，保留实际 Worklet／Worker／IndexedDB／Page／HTTP／PostgreSQL／Redis，验证暂停继续、刷新恢复和原件封存后下载字节、摘要、MIME、FFmpeg 解码时长完全对应。
- API 真实 PostgreSQL／Redis 用例验证录前预算不形成预留、已消费／并发预留压缩剩余额度，保留原有封存权威。

实际手机麦克风、Safari／iOS／Android 的权限／锁屏／来电、真实 OSS 与 ASR、小程序真机仍须分别验收。上述合成音源工程测试不能替代这些结果。可复现命令及当次结果见[交付记录](delivery/2026-10-29/browser-mp3.md)。
