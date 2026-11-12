# MP08 故事编辑、回听与随时归章

范围：[#174](https://github.com/brycezhang/timenook/issues/174)。消费 MP05 单一章节、MP07 项目照片与 MP01 公共界面契约；实施分支已合入集成 `dbc58f4`，其中包含 MP05 `577c189` 的“暂不入书保留项目封面”修复。本票本地功能已实现；390px 原生进展见文末，320px 仍待补齐，不表示已部署或真机通过。

## 可操作路径

- 首页故事数 → 故事列表 → 整卡打开真实故事。卡片读取当前项目标题、章节/处理状态、正文摘要、原声时长及故事版本的私有照片。没有素材时不放示例照片。
- 故事详情 → 编辑文字 → 保存新版 → 返回详情。沿用故事版本冲突校验，正文校对保留已有照片快照与原声清单；退出编辑期间的迟到响应不改变后来页面。
- 详情里的章节入口、未归章列表的“选择章节” → 新增 `/pages/assign-story/index?projectId=…&storyId=…` → 选择并保存。使用 `GET/POST /projects/:id/plan`，同一个故事只保留目标章引用；跨章问题联动由既有服务端事务处理。
- 章节管理可移出引用，也可通过章节故事详情选择新章。选择章节页的“移出章节”保留普通未归章故事；“暂不入书”明确排除。未归章列表单独展示排除的故事，可重新选择章节或恢复为未归章。两种状态均保留正文、照片与原声。
- 从暂不入书恢复到某章时先恢复 inclusion，再保存当前 plan。若后一步发生版本冲突，页面显示错误，故事保留为未归章；不会宣称归章成功或丢弃素材。
- 原声复用现有鉴权下载、hash 校验、暂停/继续、拖动进度、精确时间与临时文件清理；详情展示同一故事全部片段。详情“继续讲述”携带原 interviewId，重新打开录音准备，不创建第二篇故事。
- 整理中展示已保存原声和结构化骨架，可回当前故事书；失败保留播放器和可重试任务的“重新整理”。无语音/未成故事时显示实际状态并可补录。所有页面使用 `tn-navigation`、`tn-*` 白底/橄榄绿样式，无功能标题重复。

本票没有改写 API、数据库模型或共享契约；网页/后台接口保持 MP05/MP07 当前模型。

## 逐画板入口与待验

设计参考：[390px 故事详情](design-reference/390/Story.png)、[320px 故事详情](design-reference/320/Story.png)，全部页面见[参考清单](design-reference/manifest.json)。页面结构与尺寸按对应 `.dc.html` 实现。原生 390px/320px、键盘与安全区检查当前均待执行；未用浏览器截图替代。

| 画板 | 实际路由/状态与进入方式 | 原生证据 |
| --- | --- | --- |
| Stories | 首页故事数 → `/pages/stories/index?projectId=…` | 待 DevTools 窗口 |
| Story | 列表/章节整卡 → `/pages/story/index?projectId=…&storyId=…`，已归章版本 | 待 390/320 截图、播放暂停和拖动 |
| StoryEdit | 详情“编辑文字” → `/pages/edit-story/index?projectId=…&storyId=…` | 待保存返回、长文、键盘截图 |
| StoryProcessing | 真实 compose task 排队/处理中；保存录音后进入详情 | 待离开返回及截图 |
| StoryFailed | 真实 compose task 失败；同一详情读取实际 retryable | 待回听、重试及截图 |
| StoryUnassigned | 同一详情，`included=true` 且 `chapter=null` | 待归章及截图 |
| UnassignedStories | 目录未归章入口/故事列表未归章计数 → stories `filter=unassigned` | 待排除/恢复和截图 |
| AssignStory | 详情章节/未归章列表 → `/pages/assign-story/index` | 待无章→归章→跨章→移出→暂不入书→恢复 |

## 已执行验证

- `pnpm typecheck:frontend`、`pnpm build:miniprogram` 通过；正式包注册归章页，开发状态选择器未新增。官方 wcc/wcsc 和 DevTools 运行因串行窗口约定暂未执行。
- 121 项相关页面/正式包检查覆盖 story-management、story-page、story-photos-page、interview-recording-page、native-build。首次有 1 项旧断言仍要求故事列表先进入选题，按本票直接录音准备入口更新；该场景定向复测通过，其余 118 项通过；随后增加的同章顺序保持、转写依赖失败呈现 2 项定向测试通过。播放器拖动、鉴权、下载完整性与临时文件清理沿用已通过的实际控制器测试。
- 真实 PostgreSQL/Redis：`story-management.test.ts` 与 `outline-directory.test.ts` 共 4 项通过。验证正文新版本/旧版本冲突、照片及原声保留、归章唯一性、跨章、移出、排除/恢复、跨项目拒绝、补录仍是同一故事且保留前两段并增加第三段。MP05 的已选封面不随故事排除而清空及目录/PDF 快照回归一起通过。
- API 执行命令（`apps/api` 目录）：`node --env-file=../../.env --test --test-concurrency=1 --test-timeout=120000 dist-test/test/story-management.test.js dist-test/test/outline-directory.test.js`。使用随机隔离 schema 与 Redis prefix，结束后清理。一次从仓库根目录误启动造成 fixture 找不到 Prisma CLI；修正工作目录后上述 4 项完整通过，未改迁移或业务代码绕过。

微信登录、相册/麦克风、实际 OSS/ASR/整理供应商及手机原声回听仍独立待验。测试音频、图片和外部提供方响应为明确隔离夹具；本票未上传体验版、提审、发布或操作真实资金。

## 2026-11-12 原生集成记录

- 从真实首页故事数进入列表、已有故事、编辑页、选择章节、未归章故事与列表；已采集八张 [390px 原生图](evidence/MP08/native)。七张完成参考对照，失败图当前是过期任务，仍待可重试任务复采。320px 均待补齐，不能据此记作整票原生通过。
- 编辑标题及正文后保存，返回详情读取真实新版本；未归章列表选择「求学与成长」保存，再从详情移出，实际返回「未归章」。同一故事的照片与原声仍保留。
- 已将原生发现的标题与日期呈现差异按参考修正：列表为「故事列表」，列表和详情以月日展示保存日期。修复后列表、详情、未归章详情及选择章节已复采。
- 最后复验使用 37 页 release 构建产物，只在隔离副本中把 API 地址改为 loopback。真实按钮「照片与说明」进入照片页，「继续讲述」进入同一采访。没有页面业务状态注入。
- 失败任务在首次捕获时已超过 fixture 的十分钟期限，因此真实按钮是「继续讲述」；点击进入原采访，未将其描述为重试成功。后续将使用有效期内的供应商失败补验「重新整理」。处理中的另一真实任务保持等待，读取封存原声与结构化骨架。
- 本次呈现修复后相关 37 项测试、前端类型检查及 release 构建通过。原生回听暂停／拖动、排除恢复与真实设备录音仍未补验。
