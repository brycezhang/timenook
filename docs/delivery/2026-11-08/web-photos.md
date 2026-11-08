# WV05：照片、照片讲述与故事原声

## 已实现

项目和录音选题提供「从照片说起」，在独立 Vue 页面选择 JPEG、PNG 或 HEIC 图片，复用现有私有上传、摘要校验与服务端方向/预览处理。可多图逐张上传，当前页面保留失败文件并沿用原上传预留重试。照片说明、删除操作保存新的照片素材快照；已有故事同步创建新故事版本，文字、来源和原声选择继续保留。

照片起点使用 `starterKind: 'photo'` 创建采访，再进入同一个 `/app/projects/:projectId/record?interviewId=…` 页面。准备、录制和暂停持续显示同一采访照片，多图可横向查看；320×568 下暂停/继续/结束按钮保留在底部导航上方。照片管理返回后仍准备同一采访。

故事页按当前故事版本读取确定照片快照；尚无正文时读取同一采访已保存照片。私有图片、PDF 和原声共用 `fetchVerifiedBlob`，通过当前 Cookie 会话下载，核对字节数和 SHA-256 后生成临时对象 URL。离页、退出、跨标签账号变化或接口明确失权时清理；媒体凭据不进入持久浏览器存储。`PrivatePhoto.vue` 可复用于书稿封面选图。

故事原声按当前故事版本的 `audioManifest.intentId` 访问原声网关，支持真实解码和播放；该网关的路径编号是录音上传预留编号，与来源中的 `clipId` 不同。尚无正文时按同一采访已保存录音提供回听。

## 修复的实际问题

- 首次故事整理原来只沿用已有故事的照片快照，因此照片起点的第一篇故事没有照片。真实 HTTP 回归先复现失败；现在仅在不存在基础故事版本时捕获同一采访当前已保存快照。已有版本（包括明确没有照片的版本）继续沿用其选择，后续改说明不会改写旧快照。
- 浏览器照片录音在 320×568 暂停时，结束按钮与底部导航轻微重叠。按实际截图收紧照片、计时和操作间距；照片保持完整显示。

## 本地验证

通过隔离 schema 的真实 PostgreSQL、Redis/BullMQ、公开 HTTP 与构建后的 HTTPS Vue 页面验证。短信、ASR/整理供应商网络和浏览器麦克风输入为隔离替身；图片处理、MP3 编码、上传、任务、故事版本及媒体下载实际执行。

- `apps/api/test/photo-story-generation.test.ts`：照片起点首篇故事捕获照片和说明，之后修改素材说明仍保留原故事快照。
- `tests/web-mvp/photos.test.mjs`：实际上传失败/同文件重试、说明保存与故事显示、删除并更新故事、多图起点、准备/录制/暂停、真实 MP3 上传到故事、故事原声解码播放、320px 布局及跨标签退出撤销私有对象 URL。
- Vue 类型检查和生产构建通过；受影响 API 测试编译通过。页面截图在 Git 忽略的 `output/playwright/web-photo-recording-320.png`。

执行时仅传入本机 PostgreSQL/Redis 连接，命令如下：

```sh
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
pnpm --filter @timenook/web typecheck
pnpm --filter @timenook/web build
# cwd=apps/api
node --test dist-test/test/photo-story-generation.test.js
# cwd=repo
node --test tests/web-mvp/photos.test.mjs
```

## 实际验收边界

以上是本地工程交付。真实手机选图/HEIC、Safari/Android 麦克风、真实 OSS/ASR/整理供应商、同号双端设备和部署后的完整路径仍由后续运行验收记录；本切片未推送、部署或发布执行票。
