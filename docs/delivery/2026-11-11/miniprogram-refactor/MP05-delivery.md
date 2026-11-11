# MP05 六章大纲、问题与故事目录交付

对应 [#171](https://github.com/brycezhang/timenook/issues/171)、[规格](spec.md)和 [MP05 票据](tickets/MP05-outline-directory.md)。功能代码已完成；本票尚未完成原生 UI 验收，不标记为完成。以下分别记录已通过检查、原生待验与外部验收。

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

## 原生设计对照

待填写本轮微信开发者工具 390×844 / 320×568 原生截图与操作结果。设计参考来自 `designs/timenook-modern-2026-11-10/project/` 对应六画板和 [390px](design-reference/390/BookDirectory.png)／[320px](design-reference/320/BookDirectory.png) 固定截图；数据使用隔离数据库的合成项目、真实 HTTP 业务接口。微信身份供应商、声音与图片输入为明确测试替身，不代表外部验收。

## 交接与外部待验

旧 `scripts/test-native-design.cjs` 仍含删除前的 `/book/directory` mock，已交 MP12 更新全链路脚本；不用于本票原生验收。未执行部署、上传、提审、真实购买或实物制作。iOS／Android 微信真机和真实录音供应商结果由相应验收记录另行确认。


### 恢复原生验证

MP01 当前独占 DevTools，MP05 尚未启动开发者工具或 3422 fixture。待协调释放后，在 MP05 worktree 执行 `node --env-file=.env /tmp/mp05-native-driver.cjs`（交互终端）。脚本使用现有 API 测试 fixture，新建隔离 PostgreSQL schema／Redis 前缀，提供 `127.0.0.1:3422/v1` 真实 HTTP 服务；在临时正式构建中仅替换 API 地址并关闭本机域名检查，不替换业务网络。

终端出现 READY 后：先 `device` 读取实际宽度，选择 iPhone 12/13(Pro) 的 390×844 机型，`capture` 采集六页；切换「录音布局 320×568」后再 `capture`。每次进入目录重新装入 API 签发的隔离测试会话以适应 VM 重载；截图通过官方 `simulator_screenshot`，仍须核对 PNG 尺寸并逐页对照。再回 390 执行 `verify`（章节改名、问题编辑、选择题目开录）、`drag`（章节与故事原生触摸排序）、`move`（移出、加入、跨章移动及问题关系）。结束用 `quit` 关闭本次临时项目并清理隔离 fixture，不触碰他人窗口。

脚本尚未实际运行，选择器、真实窗口切换与布局结果均待现场确认；失败应修复后补齐六画板记录。工作目录保留 own node_modules、已生成 Prisma、已编译 dist-test、release 包和安全的本地 `.env` 链接。
