# MP05 六章大纲、问题与故事目录交付

对应 [#171](https://github.com/brycezhang/timenook/issues/171)、[规格](spec.md)和 [MP05 票据](tickets/MP05-outline-directory.md)。功能及 390／320 开发者工具原生验收已完成；真实设备与外部供应商结果另验。下文保留分阶段证据，最新结论见文末。

## 当前功能和契约

- 新项目复制六章六十题初稿，固定模板版本 2。关系称呼不改模板，后续模板更新不覆盖项目修改。
- `PlanRevision.content.chapters` 是唯一可写目录；每章包含稳定 `key`、标题、问题和有序 `storyRefs`。`POST /projects/:id/plan` 共用项目锁与乐观版本。`BookContext.directory` 是此计划的只读投影。
- 删除独立 `PlanDirectoryVersion` 表和 `/book/directory` 写接口；无双写、回填或接口别名。网页书稿编辑同步走统一计划，保留问题。API、Prisma、共享契约、小程序和当前网页消费者已更新。
- `PersonalPlan.answers` 按已保存故事返回问题与当前章节关系。题目移章同步对应故事，故事移章同步当前问题；同一故事只归一章。录音的 `ActualPlanQuestion` 来源与文字快照不变。
- 有效题目所属章决定新故事归属；自由讲述、无有效章或原章已删除时保留为未归章。删除章节／问题不删除故事及原声。取消收录后恢复不会强塞第一章。
- PDF 只使用明确归章的故事，跳过空章；删除空目录全收录回退。问题文字或未回答问题修改不使已生成 PDF 失效，目录／正文变化使当前书稿待更新；固定版本的正文、照片、原声清单保持不可变。
- 照片归项目后，故事取消收录不再清空独立选定的封面；封面素材权限仍由现有项目照片接口校验。

## 小程序操作

真实入口为首页「我的书」→「章节目录」。六页为 `directory`、`chapter-outline`、`question`、`question-edit`、`chapter`、`chapter-stories`，统一使用 MP01 的 `tn-navigation` 与 `tn-*` 视觉样式。

目录支持新增章节和原生触摸整章排序；章节中切换问题／故事，新增、编辑、移除及排序问题；详情支持稍后、跳过、恢复和开始回答；开始回答创建真实访谈，携带当前计划版本及问题身份。章节编辑支持改名与章内正文保存；故事管理支持加入、移出、跨章移动和拖动排序。未归章提示进入真实故事筛选，无样例业务回退。

## 验证

- 真实 loopback PostgreSQL／Redis 的计划、模板及目录定向测试 21 项通过；合并 MP07 项目照片模型后，目录和个人计划 9 项再次通过。
- 原生页面逻辑与既有书稿定向测试 22 项通过，前端、API、网页类型检查通过；release 构建及 WXML/WXSS 编译通过（30 页）。
- 已运行真实 PDF 内容测试：空章省略、照片与说明、按故事绑定原声码、分页；未来问题修改保持固定版本、实际目录修改使当前输入过期。PDF 测试使用已校验字体及合成输入。
- 排除故事后封面保留新增真实 API 回归通过（目录测试 3/3）。

## 原生设计对照（仍待完整验收）

已合入 MP01 最终页头与 Tab（`dbc58f4`），在微信开发者工具 `2.02.2609250` / 基础库 `3.17.5`、真实 iPhone 12/13(Pro) 390×844 设备配置验证。`wx.getWindowInfo().windowWidth` 为 390；官方 `simulator_screenshot` 输出保留原生设备外框，PNG 是 602×1300，没有 CSS 宽度模拟或截图缩放。每张截图均为隔离真实数据库项目；身份供应商、音频与 AI 为合成 fixture。真实入口曾逐步点击首页「我的书」→「章节目录」→章节，后续页面通过真实按钮和原生返回操作。

| 画板           | 390px 原生截图与观察                                                                                            | 320px |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| BookDirectory  | [截图](evidence/MP05/native/BookDirectory-390.png)：六章、未归章提示、总数包含未归章，整章排序入口              | 已采集 |
| ChapterOutline | [截图](evidence/MP05/native/ChapterOutline-390.png)：章节身份、问题/故事切换、已回答状态、编辑入口              | 已采集 |
| QuestionDetail | [截图](evidence/MP05/native/QuestionDetail-390.png)：真实问题、章节、稍后/跳过/移除、开始回答                   | 已采集 |
| QuestionEdit   | [截图](evidence/MP05/native/QuestionEdit-390.png)：已修正文案字体继承粗体；题目及必选章节                       | 已采集 |
| ChapterEdit    | [截图](evidence/MP05/native/ChapterEdit-390.png)：已修正原生输入垂直偏移、正文粗体和底色；章名/正文均已实际保存 | 已采集 |
| ChapterStories | [截图](evidence/MP05/native/ChapterStories-390.png)：已修正摘要间距；章内故事与可加入列表使用实际业务数据       | 已采集 |

运行中使用三篇明确合成故事；截图中故事数和题目状态相对画稿的差别来自真实测试数据。固定页头为微信状态栏、胶囊与底部安全区保留原生空间。设计参考在 `design-reference/{390,320}`。

已经通过的原生操作：

- 输入章节名称和正文 → 保存 → 返回章节 → 真实 API 再读取确认修改。
- 输入问题文字 → 保存 → 开始回答 → [录音准备页](evidence/MP05/native/QuestionToRecording-390.png)。真实访谈记录 `childhood-03`、修改后的文字及 `source.chapterKey=childhood`；没有打开真实麦克风。
- 点击故事「移到本章」→ [目标章故事](evidence/MP05/native/CrossChapterStory-390.png) → [目标章已回答问题](evidence/MP05/native/CrossChapterQuestion-390.png)，API 核对故事只归一章、问题同步移动；通过同一公开界面移回也已验证。

[运行清单](evidence/MP05/manifest.json)、[官方 CLI 操作记录](evidence/MP05/cli-actions.jsonl)和[步骤记录](evidence/MP05/cli-results.json)保留当前证据。早期脚本失败是混用持久 SDK 与 CLI、选择器能力和访谈提示文案判断问题，均已识别；不将这些脚本错误计作产品通过或失败。

**当时尚未完成（已在文末关闭）**：GUI 真实拖章/拖故事、组件内「移出」后加入，以及最终全部画板验收。CUA 明确返回 Mac 已锁屏且自动解锁失败，已请用户手动解锁；没有反复重试或绕过。390 截图与已通过操作不代表本票全部原生验收完成。

## 恢复验证与交接

当前真实 API 进程仍在 3422（交互会话 74870），项目 `dc001005-887c-461f-ba16-6d7ef3c00514`。原生临时项目和 evidence 位于 `/var/folders/7t/xgv_t04j7k74jfdhdh1p41tr0000gn/T/timenook-native-mp05-wHp5fn`；已保留 API 签发的合成用户会话。没有输出令牌、登录 code 或私人资料。此项目尚无照片资产，可供 MP07 后续上传验证。

当前可用 CLI helper 是 `/tmp/mp05-native-cli.cjs`，独立操作脚本 `/tmp/mp05-native-move.cjs`。可移植副本在 [harness](evidence/MP05/harness/native.cjs)：设置 `TIMENOOK_NATIVE_PROJECT` 和 `TIMENOOK_NATIVE_PROJECT_ID`，使用 `directory()` 后截图；用 CUA 点击 sort-list 的章节，再运行 `chapter` 采集五个章内页面。CLI 的选择器不能进入该自定义组件，不再混用另一持久 SDK 连接。页面级按钮已提供稳定 ID/class，输入/点击继续使用官方工具。

解锁后，先读取原生页面和实际宽度；从底部设备菜单选择「录音布局 320×568」，等待重载与真实首页就绪，继续六页截图与差异处理。回 390 后，在 GUI 拖动章节和故事的右侧手柄，逐次读取真实 `/plan` 验证顺序；点击组件内「移出」再加入并核对持久化。全部结束再记录完成及清理本次 fixture。不要再调用旧 `/tmp/mp05-native-driver.cjs` 的原生操作命令；该进程只保留 API 服务，最终可 `quit` 清理并关闭该进程。

新建同类隔离服务可参考 [API harness](evidence/MP05/harness/api.cjs)，会把合成登录态写入系统临时目录的 0600 文件；该重建入口仅做语法检查，当前验收仍使用已有进程。工作目录保留独立 node_modules、Prisma、dist-test、release 包和安全本地 `.env` 链接。

旧 `scripts/test-native-design.cjs` 含删除前的 `/book/directory` mock，已交 MP12 更新全链路脚本，不用于本票验收。未执行部署、上传、提审、真实购买或实物制作。iOS／Android 微信真机、真实录音供应商结果由相应验收记录另行确认。

## 2026-11-12 320px 集成续验

六张原生图已补齐并对照，使用真实 MP06 API/PG/Redis 与 release 包。首页进入书稿、目录后，章内入口用真实路由打开；Mac 锁定时没有将 CLI 直接路由当作自定义组件点击或拖动证据。章内显示 11 题（10 个大纲题、1 个家人题），编辑问题、章节名称和故事正文均通过真实输入/保存返回确认。点击“移到本章”完成真实跨章移动，章内故事与章节正文随之显示。目录及故事拖排仍明确待验。

2026-11-12 原生修复复验：真实 CUA 快速拖动重现最后一次 touchmove 的异步查询被 touchend 提前清空，导致顺序未保存。修复后 release `4e38b3f` 在实际 320px 再拖「我的童年」到「求学与成长」后方，界面与真实 API 顺序均变为 learning、childhood；[拖后截图](evidence/MP05/native/BookDirectoryReordered-320.png)保留结果。QuestionEdit 的「所属章节／必选」层级及 ChapterStories「可加入的故事」文案已补采 320；故事页已通过实际加入按钮准备两条故事，行拖动／移出与最新 390 文案待继续。Mac 此时明确锁定，未将受阻的后续动作记为通过。

## MP12 最终原生收尾（2026-11-12）

六张画板已完成 390／320。最终 QuestionEdit 必选标签、ChapterStories 文案均已双宽更新；实际 320 CUA 拖动两条故事交换顺序，再点击组件「移出」，两次界面结果与真实 plan.storyRefs 回读一致。此前章节拖动也已保存，拖排与移出缺口已关闭。 详见[最终脱敏记录](evidence/MP12/native-final-acceptance.json)及 [design-map](design-map.json)；前文时间点的待验项以本段和映射为准。
