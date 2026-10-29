# 两端共用的分步讲述

客户端工程票 [W03a #103](https://github.com/brycezhang/timenook/issues/103)，归属 [W03 #98](https://github.com/brycezhang/timenook/issues/98) 与[父规格](delivery/2026-10-29/mobile-web-spec.md)。本轮是基于已合入 T14 等公开契约的客户端工程切片，不代表 W02 内测项目装配、真实网页供应商链路或 W03 整票已完成。

小程序 live 采访页和复用其页面源码的浏览器入口采用同一控制器：选题／照片 → 准备 → 录制 → 本机回听与提交 → 保存处理与可选追问。故事校对、本人版本确认及入书许可继续使用既有故事页面与服务端规则。demo 模式保留明确标注的本机示例。

## 操作和保存边界

- 暂停／继续属于同一次设备录制和同一实际问题；暂停时长不计入录制计时。继续前重新检查采集权限与问题版本。
- 停止录制后先保存本机文件与清单，再进入回听；只有明确点击提交才上传并封存。用户可分别提交多个片段，未提交片段继续留在原账号的本机清单。
- 重录需确认，新片段另存；旧原声继续保留。已经提交的原声不能被重录动作覆盖。实际问题变化后，旧片段继续保留原问题归属。
- 回听播放当前账号、项目清单内的实际本机文件，播放前复核采集授权；离页、失权和开始新录制会停止播放。
- 录制、回听和处理之间的导航不新建采访、不重新提交任务。可继续补录、另选起点、查询恢复，或跳过追问；转写、追问与整理仍按既有输入和授权规则处理。
- 暂停中离开也会停止并尝试保存。只有实际文件与清单持久化成功才显示本机保存；尚未保存或系统强杀前的内存声音不保证恢复。

## 已有验证与后续集成

页面行为测试验证暂停计时、恢复、失权、原问题绑定、回听、重录确认和步骤导航；浏览器用例复用真实 Page、HTTP、PostgreSQL／Redis，仅设备声音、微信和外部 AI 使用明确隔离的合成边界。官方 WXML／WXSS 编译只证明原生页面可编译，不替代微信真机。

浏览器 MediaRecorder 当前使用实际支持的 WebM/Opus 或 MP4 格式，服务端原录音准入只支持 MP3。真实网页录音的格式准入／正规化仍须在 W03 后续集成完成，不能以文件名改成 `.mp3` 认定格式已适配。网页登录的 Cookie 会话与独立应用接入同一页面源，也需由 W01／W02 后续装配验证。

主要相关命令：

```sh
pnpm exec tsx --test tests/interview-recording-page.test.ts tests/browser-recording.test.ts
pnpm typecheck:frontend
pnpm build:frontend
pnpm check:native
pnpm exec playwright test tests/admin/interview-recording.spec.mjs tests/admin/optional-followup.spec.mjs tests/admin/transcription.spec.mjs tests/admin/story-generation.spec.mjs tests/admin/story-confirmation.spec.mjs tests/admin/story-photos.spec.mjs -c playwright.admin.config.mjs
```

完整前端回归及上述浏览器范围的实际结果由本次候选交付记录保存。实际 OSS、浏览器原始音频、供应商、双端真机和公网验收继续分别留证。
