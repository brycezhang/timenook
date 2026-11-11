# MP09 语音讲述、照片与可靠保存

范围：[#175](https://github.com/brycezhang/timenook/issues/175)。基于集成 `e68b332`，消费 MP01 公共界面、MP06 家人题/大纲题采访输入、MP07 项目照片和 MP08 同故事补录契约。七个画板对应功能已本地实现，原生逐画板与真机验收待执行；未部署、上传体验版或操作真实资料。

## 可操作路径

- 首页推荐题、家人提问、大纲问题通过 `interviewId&prepare=1` 直接显示当时实际问题。来源读取 `ActualPlanQuestion.source.kind='family'` 的关系和昵称，录音操作者不替换原提问人；采访及章节关联沿用服务端快照。
- 新建讲述使用独立 `draftId`，只恢复该草稿对应的采访；不读上一采访作为新故事。照片和自由讲述沿用各自实际起点。准备页只显示问题、照片、换题和整块可点的麦克风/开始录音；换题替换当前空准备页进入真实大纲，不保留可返回误录的旧题准备页。
- 所有起点读取并展示本次 `PhotoMaterials`。加图进入 MP07 项目照片选择；录制时先等待原生暂停回调再跳转，返回后重新核验权限及照片，继续同一原生片段，暂停期间不累计时长。逐张移除只追加本次照片关联快照，不删除项目素材或其他故事引用。
- 单段上限十分钟，实际开始/继续都复核当前问题和可用额度；保留项目累计六小时与剩余额度规则。手动结束和原生到时停止均先完成本机文件/清单保存，再自动上传、封存；复用后端自动转写/整理，用户不需要另行封存或提交转写。
- 上传显示实际 `wx.uploadFile.onProgressUpdate`，尚无字节进度时显示动态保存条；传输到 100% 后仍等待封存结果。成功替换为同采访的故事页，后台继续整理。未知上传/封存结果按同一原片段查询和重试，不新增故事或重复素材。
- 详情补录保留同一采访及其问题，新片段从零计时；已有片段/故事保留，准备页不提供换题。跨项目离开后迟到的保存仍由录音实例写回原项目，不能导航或污染后来页面。
- 应用左上返回在录制/暂停/本机保存中提供“保存并离开／继续讲述”，保存成功后回原书。原生返回/Android back 通过 `enableAlertBeforeUnload` 提醒；系统手势返回和小程序退出受平台限制不一定弹窗，`onHide/onUnload` 仍停止并交由原录音实例完成本机保存。回到同一采访自动恢复，另一新讲述页面显示真实未上传片段的恢复入口。
- 麦克风错误显示设置入口，授权恢复后保留同题。文件保存失败与麦克风错误分开处理，未完成本机保存时只提供重试保存。会话/项目权限变化清空私有显示并停止采集，原文件继续保留。

删除旧的选题/回听/手动文字处理页面流程和未使用的 `interview-flow` 模块；原声回听与整理结果归 MP08 故事页。未修改 API、数据库或网页视觉；共享 `SessionClient.uploadRecording` 只增加可选进度回调，现有调用不变。

`tn-navigation` 增加可选 `interceptBack` 属性；为 true 时触发 `back` 事件交给页面处理，默认继续使用原页面栈。录音页以 `intercept-back="{{true}}" bindback="leave"` 消费。

## 验证

- 页面公开控制器 21 项通过：家人来源、直接准备、换题/自由讲述、所有起点照片与移除、异步暂停→照片→原片段继续、同故事补录/新草稿隔离、手动结束/十分钟原生到时自动保存、真实进度回调、未知封存恢复、原生文件持久化失败恢复、麦克风设置、保存离开、原生卸载、权限/账号变化及跨项目迟到保存。硬件与 HTTP 响应为明确隔离夹具，不代表微信原生运行通过。
- 真实 PostgreSQL/Redis 的 `interview-recording.test.ts` 与 `project-member-recording.test.ts` 共 17 项通过：真实 MP3 校验/时长、封存幂等、并发/剩余额度、原片段原问题、跨项目约束及两段录音自动形成同一故事。ASR、模型与 OSS 外部边界为隔离供应商，不等于真实供应商验收。
- 65 项相关录音转换、故事回听/补录、项目照片、会话与正式包回归通过；首次正式包体积断言因基线邀请图超过原预算失败，root 已在 `0b84e2b` 压缩原图，同步最新集成后仅补验受影响构建。
- `pnpm typecheck:frontend` 与 `pnpm build:miniprogram` 通过（34 个正式页面）；先独立构建 contracts，再生成本工作树 Prisma client 并编译 API 测试。仅使用本机 PostgreSQL/Redis 与随机隔离 schema/prefix，未共享可变 node_modules/Prisma 目录。

可复现命令（仓库根）：

```sh
pnpm exec tsx --test --test-timeout=30000 tests/interview-recording-page.test.ts tests/devtools-recording.test.ts tests/story-page.test.ts tests/story-photos-page.test.ts tests/session.test.ts tests/native-build.test.ts
pnpm typecheck:frontend
pnpm build:miniprogram
```

API 测试从 `apps/api` 目录运行：

```sh
node --env-file=../../.env --test --test-concurrency=1 --test-timeout=120000 dist-test/test/interview-recording.test.js dist-test/test/project-member-recording.test.js
```

## 原生与外部待验

Mac 锁屏且开发者工具由 root 单写，本工作树没有操作 DevTools/CUA/CLI。下表全部为待验，浏览器、控制器或构建不替代原生截图与点击证据。设计参考沿用 `design-reference/390` 与 `design-reference/320` 的对应画板。

| 画板 | 真实入口/状态 | 待验内容 |
| --- | --- | --- |
| RecordReady | 首页当前题／家人题／大纲题 → interview，`screen=ready` | 390/320 来源、长问题、整块开始、换题返回 |
| RecordReadyPhoto | 照片起讲／任一起点添加照片后准备 | 照片190px、滑动、逐张移除、真实私有预览 |
| Recording | `startSpeaking`，`screen=recording` | 计时、照片154px、暂停/结束底栏、窄屏及安全区 |
| RecordPaused | 暂停／加图返回，`screen=paused` | 系统相册往返、继续保留时长、异步暂停回调 |
| Upload | 结束／十分钟到时，`screen=saving` | 真实微信本机保存、真实上传进度、转到故事整理 |
| UploadFailed | 实际上传失败，`screen=failed` | 原片段保留、重试、稍后再试与重进恢复 |
| RecordBlocked | 原生麦克风失败，`screen=blocked` | 拒绝→设置授权→同题重试；不能以手工改页面数据冒充 |

iPhone/Android 真机麦克风、授权弹层、十分钟实录、系统手势/退出、微信相册、实际 OSS/ASR/模型及供应商结果仍待验。原生夹具若需注入音频/照片，必须使用 `wx.downloadFile` 产生的临时文件，不能把 `http://usr` 缓存路径当 `saveFile` 临时输入；此前 MP07 已明确该平台边界。
