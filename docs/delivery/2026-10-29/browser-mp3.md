# W03b 浏览器 MP3 工程验证

票据 [#106](https://github.com/brycezhang/timenook/issues/106)，父票 W03 #98。工程基线是 W03a PR #104 的 main `f95c65239baade8f1648cb2347f28c7826af6ab9`；其完整 main CI [40878824249](https://github.com/brycezhang/timenook/actions/runs/40878824249) 成功后才开始依赖实现。

## 已实现范围

真实浏览器通过 16kHz AudioContext／AudioWorklet／独立 Worker 生成单声道 MP3；暂停继续保留同一 encoder、采样上限处理 padding，停止立即进入保存处理。录前授权返回冻结套餐和当前消费／预留下的预算；最终封存仍在服务端核对权限、唯一性、reservation 和 FFmpeg 实际解码时长。本机保存后的字节和 SHA-256 不变；未确认封存时继续保留原件。

固定 `@breezystack/lamejs@1.2.7`，输出的独立 ESM asset 与 npm 发布包逐字节一致，完整源码和许可随浏览器构建分发。实现约束和源码位置见[浏览器录音原件](../../development-browser-mp3.md)。

## 本地实际结果

环境：Node 22.23.4／pnpm 10.34.7、Playwright Chromium、loopback PostgreSQL／Redis、真实 FFmpeg／FFprobe。设备声音替换为真实 48kHz AudioContext oscillator 经 MediaStreamDestination 产生的 MediaStream；录音端 context、worklet、worker、编码和文件链路均真实。

- RED：浏览器实际输出 `audio/webm;codecs=opus`，1秒额度测试要求 `audio/mpeg` 失败；录前授权没有 `maxDurationMs` 失败；异步停止编码期间仍显示 recording 失败。各项实现后通过。
- 生产构建在 `/app/` 基址运行真实 Worker／Worklet 和独立原样 encoder asset。实际等待 5 分钟采样的 MP3 经 FFmpeg 解码为 **299988ms**，未超过 2MiB／300000ms。1秒额度解码 **972ms**，920ms剩余额度解码 **900ms**。
- 真实 Page → IndexedDB → 刷新恢复 → HTTP 上传／封存 → 公开原声 content 下载：字节、SHA-256、MIME 和 FFmpeg 解码时长完全对应；暂停的1100ms未加入音频时长。实际问题归属和客户端原件清单保留。
- 浏览器录音测试覆盖权限拒绝、Worker 加载失败后的真实轨道释放、暂停后离页收尾、小额度不足和持久化后的临时 Blob URL 清理；5分钟长测和其余短测分别执行，合计8个用例通过。
- 前端全部 **388/388**；录音 API **20/20**（真实 PostgreSQL／Redis，含当前预算和并发预留）；相关产品浏览器 **27/27**；整仓 typecheck／build 通过；官方 wcc／wcsc **25页**编译通过。

录前预算的实际 API 断言包含每段300000ms默认值、合成2秒套餐、消费后920ms、并发上传预留后拒绝新录制，以及第二段封存后344ms。预算查询不创建新预留，最终上传竞争仍由服务端裁决。

## 复现

```sh
pnpm db:generate
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
pnpm typecheck
pnpm test:frontend
(cd apps/api && node --env-file=../../.env --test dist-test/test/interview-recording.test.js)
pnpm exec playwright test tests/admin/browser-mp3.spec.mjs tests/admin/interview-recording.spec.mjs tests/admin/optional-followup.spec.mjs tests/admin/transcription.spec.mjs tests/admin/story-generation.spec.mjs tests/admin/story-confirmation.spec.mjs tests/admin/story-photos.spec.mjs -c playwright.admin.config.mjs
pnpm build
pnpm check:native
```

数据库／Redis配置只允许 loopback，测试新建独立 schema／key prefix 并清理。该次实际命令和日志保存在工作区外 `browser-mp3-impl-106.md` 的任务记录，不包含凭据或私人音频。

## 未完成的真实条件

本票是浏览器 MP3 工程切片，不代表 W03 整票或部署已经完成。网页 Cookie 产品入口／W02内测项目装配、真实 OSS、正式 ASR、实际手机麦克风及 Safari／iOS／Android 的权限、锁屏、来电、设备耗电／音质、小程序微信真机、公网部署和真实内容完整验收分别留待对应责任票。官方编译和合成声音不追认这些结果。
