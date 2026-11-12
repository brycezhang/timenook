# MP10 封面草稿、PDF 与固定版本原声

范围：[#176](https://github.com/brycezhang/timenook/issues/176)，对应[模块票](tickets/MP10-book-pdf.md)。功能已实现，集成轮已完成下述 320px 原生路径；390px、尚未复验的交互及手机扫码分别待验。

## 可操作路径与接口

- 首页书名／封面 → `/pages/book/index?projectId=…` → 点击封面 → `/pages/cover/index`。书名、寄语和照片保留在同一页面草稿；选图页通过原生 EventChannel 回传选择，返回继续编辑。离开封面页丢弃草稿，不写接口。封面展示与前三张候选均来自当前项目真实照片，没有示例照片回退。
- `POST /projects/:id/book/cover` 一次接收 `expectedVersion`、`expectedMetadataVersion`、`title`、`salutation`、`photoAssetId`。同一项目事务核验封面／项目版本与照片归属后，写入项目书名和封面版本；任一失败均不保存。购买订单中的冻结书名不变。未知结果重试复用同一幂等键。`BookContext` 响应结构不变，网页消费者同步一次保存，并修复从统一章节的响应式对象初始化本地目录草稿失败的问题。
- 书稿页从实际 API 状态展示空稿、生成中、失败、就绪与待更新；失败重试原任务，待更新生成新版，只有当前就绪稿显示预览／制作入口。未归章故事独立提示；只要已有归章内容即可生成。没有归章故事时进入章节管理，不生成空稿。
- `/pages/manuscript/index?projectId=…&versionId=…` 下载该版本的真实 PDF，核验 bytes/hash 后调用 `wx.openDocument`。下载／系统打开失败呈现重试状态；离开清理临时副本。没有自定义翻页器、可编辑 PDF 目录或 PDF 内播放器。制作入口保持 `/pages/print/index?projectId=…`，供 MP11 继续使用。
- PDF 继续使用固定 Chromium、已校验 CJK 字体、真实照片和分页／文本／二维码检查。模板 `t20-a5-v4` 使用“时光故事”品牌与白色页面；封面后直接为只读目录，移除产品书稿的旧技术试验标题页。章节和章内故事来自统一 plan，空章／未答题略过。制作规格和生产授权仍由原有后台事实判断。
- 书中原声入口 `/pages/original-audio/index?entryId=…`，同时支持既有扫码 `scene`／`q` 参数。登录后校验当前成员权限，播放冻结故事版本的录音；可暂停／继续／拖动进度，立即显示片段真实总时长。新增 `BookAudioEntryView.photo` 为同一冻结故事版本的可读照片，后续改稿／换照片不替换旧版本。离开、退出、授权变化时停止播放器并清理临时文件和照片。
- 本次没有新增数据库私有载荷。书名仍写 `Project.bookTitle`，寄语／图片引用仍写 `BookCoverVersion`，原声照片仅投影现有不可变 `StoryRevision.photoSnapshot`；沿用现有 erasure-registry 与临时文件清理，无额外删除框架或旧接口别名。

## 已执行检查

- 真实 loopback PostgreSQL/Redis：`book-cover-draft`、`outline-directory`、`book-audio`、`book-pdf` 共 24 项通过。覆盖封面三字段同次提交与失败回滚、订单书名不变、版本冲突、章节顺序／空章、未归章、真实 PDF 页数与 hash、二维码授权，以及改稿后旧原声和照片不变。
- `book-page`、`cover-page`、`senior-flow`、`book-audio-page`、`native-build` 共 49 项通过。覆盖选图零写入、取消零写入、保存与未知结果重试、就绪稿入口、系统打开失败／再试、下载完整性、权限失效与临时文件清理、暂停和拖动。后续局部调整轮询与下载失败状态后，受影响书稿／原声 35 项再次通过；合入阶段性 integration 后，封面／目录 API 4 项通过；最终合入 integration `7f15afb`（含 MP06）后，书稿／封面／原声控制器及 release 包检查 41 项通过。
- Chromium／WebKit `tests/web-mvp/book.test.mjs` 两条完整路径通过：项目照片封面、保存、六章初始目录与追加章节、真实 PDF 下载、冻结原声、退出后私有访问撤销。短信／照片／录音供应商边界仍使用 fixture。
- 共享 contracts 构建、API 测试编译、前端与网页类型检查、最终 37 页 release 包及 Web 构建通过。工作树独立安装依赖、生成 Prisma；本机环境配置与字体缓存不进入 Git。
- [真实 PDF 渲染记录](evidence/MP10/pdf/manifest.json)及 [封面](evidence/MP10/pdf/page-001.png)、[目录](evidence/MP10/pdf/page-002.png)、[故事和原声码](evidence/MP10/pdf/page-003.png)、[照片说明](evidence/MP10/pdf/page-004.png)、[制作说明](evidence/MP10/pdf/page-005.png)均来自真实 Worker 生成的五页 PDF，已逐页目视检查字号、留白、完整文字和图片，无溢出或裁切。红色图片与标题、音频、供应商响应均为明确合成夹具。原 PDF 在本工作树忽略目录 `output/pdf/mp10/cover-photo/book.pdf`，不是线上用户资料。
- API 重现命令（`apps/api` 目录）：`node --env-file=../../.env --test --test-concurrency=1 --test-timeout=120000 dist-test/test/book-cover-draft.test.js dist-test/test/outline-directory.test.js dist-test/test/book-audio.test.js dist-test/test/book-pdf.test.js`。隔离 schema、Redis namespace 和工作目录已由 fixture 清理。

## 逐画板原生待验

当前页面按各自 `.dc.html` 与 MP01 共享样式实现，使用 `tn-navigation` 和白底／`#46563C`。设计参考位于 `design-reference/390` 和 `design-reference/320`；没有用网页截图替代原生证据。

| 画板 | 真实入口／状态 | 仍待验 |
| --- | --- | --- |
| BookEmpty | 首页书名 → book，无可用故事、无版本 | 390/320、开始讲述、目录与封面 |
| BookOverview | book，归章内容／生成中／就绪版本 | 390/320、轮询、故事与照片数量、制作入口 |
| BookCover | book 整块封面 → cover → 选图返回 | 390/320、键盘、安全区、取消不写与一次保存 |
| BookReader | 就绪 book → manuscript | 390/320、当前冻结书名／照片、系统调用 |
| PdfDocument | manuscript → `wx.openDocument` | 微信系统外壳独立验证；PDF 内容已按上述五页图核对 |
| BookChanged | 实际改稿后 book 或旧 manuscript | 390/320、重新生成、返回书稿 |
| BookGenerateFailed | 实际 render task 失败后 book | 390/320、原任务重试和恢复 |
| ReaderFailed | manuscript 实际下载／系统打开失败 | 390/320、重试打开和返回 |
| OriginalAudio | 印刷版本原声码／固定 entryId | 390/320、原地登录、照片、播放暂停拖动、退出清理 |

真实微信手机号授权、手机扫码规则、手机系统 PDF 查看器外壳、iOS/Android 播放和文件清理、实际 OSS 与录音供应商、纸质二维码及印厂制作均另验。未上传体验版、提审、部署、真实付款或生产。

## MP12 集成原生检查点（2026-11-12）

正式 37 页 release 包 `74d7185`，仅临时副本 API 指向真实本地服务。实际窗口为 320×568；[检查记录](evidence/MP12/native-book-print-320.json)保留 PDF hash 与已观察结果，截图位于 [MP10/native](evidence/MP10/native)。身份、支付、AI 与存储供应商仍是明确合成夹具。

- 首页封面 → 空书稿／就绪概览 → 预览 → 实际下载 PDF。`wx.openDocument` 返回成功，WPS 打开相同本地文件名，显示四页、正确中文封面／寄语、红色合成照片和目录／故事缩略图，且显示「未上云」。这是开发者工具调用与实际内容的关联证据；手机查看器外壳另验，不制作假的 320/390 系统页面截图。
- 仅注入外部文档查看器失败后，实际点击产生 ReaderFailed；恢复真实 `wx.openDocument` 后点击重新打开，页面错误清除并成功打开。
- 封面实际输入书名／寄语，进入选图页选择不用照片，返回后草稿保留；保存后 API 回读两字段与照片为空均一致。再次编辑未保存书名，真实退出提示确认后回读仍为已保存标题。选图返回出现多余离开提示，已交由修复轮处理；带照片往返仍待修复后原生复验。
- BookChanged、BookEmpty、BookOverview、BookCover、BookReader、ReaderFailed、OriginalAudio 均已采集 320。真实 PDF 失败重试已恢复就绪，但失败页新增重试图标后的截图待复采；原声页面已读取冻结版本与真实时长，长音频暂停／拖动继续待验。

上表的待验列为初始验收清单；最新逐画板状态以 design-map 为准。390、封面修复复验、原声完整播放操作继续进行。
