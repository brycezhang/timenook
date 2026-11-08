# WV04：Vue 选题、录音与自动整理

## 已实现

网页独立 Vue 路由为 `/app/projects/:projectId/record`。不带采访编号时进入真实项目题库，可选择题目或自写话题；每次新建使用独立草稿编号。开始采访的请求在本机固定命令，未知结果重试沿用原命令；成功后地址记录 `interviewId`，补录或显式恢复进入同一采访。普通新故事入口不会自动复用旧采访。

采集器从原浏览器预览抽到 `packages/browser-media/src`，产品与旧预览共用纯媒体模块，未引入 WXML/WXSS 页面运行器。真实 AudioWorklet 采集、独立 Worker 编码单声道 16kHz MP3，支持暂停、继续、结束与中断保存。用户结束录音后，MP3、摘要及采访/实际问题归属先在 IndexedDB 的同一记录提交，再自动上传；未确认上传的片段按产品账号和项目隔离，刷新后显式恢复，重试沿用原片段和服务端上传预留。

网页复用当前成员权限、Cookie/CSRF、私有对象上传和封存接口。服务端保存成功后由现有 Worker 自动转写、整理故事；页面轮询实际任务，处理失败按服务端可重试事实提供操作。概览按确定故事版本与任务结果显示就绪，正文在故事页读取。原声回听先重验当前权限，再下载并校验字节数和 SHA-256；离页、退出与跨标签账号变化清理播放对象和旧视图。

## 本地验证

`tests/web-mvp/recording.test.mjs` 使用隔离 PostgreSQL schema、真实 Redis/BullMQ、公开 HTTP 与 HTTPS 构建后页面。只有短信/ASR/生成供应商传输及浏览器麦克风输入为隔离替身；MP3 编码、IndexedDB、上传、服务端任务和故事版本均实际执行。

验证路径：自写话题 → 实际 MP3 录音 → 暂停/继续 → 结束自动上传 → 网络中断 → 刷新保留原片段 → 项目切换隔离 → 同片段重试 → ASR 明确失败 → 重试原任务 → 故事就绪 → 原声解码播放。另验证新故事不恢复旧采访、拒绝麦克风无录音成功、320/1440px 无横向溢出，以及已有原声播放时跨标签退出清理。

执行命令：

```sh
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api db:generate
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
pnpm --filter @timenook/web typecheck
pnpm --filter @timenook/web build
pnpm exec tsc -p tsconfig.preview.json --noEmit
node --test --test-timeout=120000 tests/web-mvp/recording.test.mjs
```

测试仅允许本机 PostgreSQL/Redis。运行时另提供本机连接环境变量，不读取真实供应商凭据或私人样本。阶段截图留在 Git 忽略的 `test-results/web-recording/`。

## 实际验收边界

本记录为本地工程交付，不代表真实手机麦克风、Safari/Android 中断/后台恢复、真实 OSS/ASR/故事生成供应商或部署成功。WV05 的照片起点与照片管理另行交付；本轮未推送、部署或发布票据。
