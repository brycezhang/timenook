# T20 后端及固定渲染集成的本地工程证据

本票从 `9c2fbd5`（T19 已合并，加用户要求先提交的共用服务配置）开始，在 `codex/t20-book-pdf` 实施。这里记录本地合成验证；最终提交、独立 Standards/Spec 审查、PR/main CI 和合并由 root 记录，本文不追认完成。没有修改服务器、环境文件、微信/支付或真实供应商配置，没有采集私人素材。

## 已实现的公开边界

- `GET /v1/projects/:id/book` 提供当前可入书故事、实际目录、输入 token 与当前确定版本；`POST .../book/directory` 使用 T13 的真实目录事务、版本和幂等命令；`POST .../book/versions` 对准确输入 token 冻结一次版本和同库 Task/Outbox。
- `GET .../book/versions/:versionId`、`POST .../retry`、`GET .../pdf` 都重新检查当前 Participation、资料期限和版本。下载前后鉴权，文件校验大小及 SHA256；缓存禁止、附件名由服务端版本 ID 构成。生成重放及重试同样返回适用的最早访问到期时间。
- 快照包含大纲版本/内容、目录版本/顺序、确切已确认且允许入书的故事版本/hash、全文、附记、照片及说明、原声音频顺序和稳定入口、封面、规格与来源标识。一篇故事版本预留一个不可变随机入口，包含多个原始片段；原声访问解析归 T21，本票不使用探针身份或探针入口冒充产品路由。
- 调整未来问题不撤销旧书稿；实际目录、书名、所选故事版本/入书决定、来源标识或渲染配置变化使待生产版本失效。空章节不排版，未确认版本不能加入新书稿。
- `render_book` 复用 T15 唯一 Task/Outbox/Worker；渲染租约/fence 保证并发/迟到结果不重复发布。重启及丢失调度从 PostgreSQL 恢复。同版有限重试最多两次；采集专用协助重试入口拒绝分发私人书稿任务。
- T04 的字体、Chromium、模板分页和独立 PDF.js 检查继续共用。产品分支加入扉页、实际章节与故事目录、故事起始处的一次原声码、全部照片/说明、制作说明和 AI/人工校对来源。`participant` 校对版本仍保留“根据本人讲述经AI整理，并经人工校对”，原声明确为本人原声。
- 实际模板、book-worker、inspect-worker、字体模块、bounded runner 和编译后的适配器字节指纹进入冻结配置。PDF、最终 manifest 和数据库记录绑定 snapshotHash、故事 revision/hash、来源版本及最终 PDF hash。

## 资源与期限

准备阶段先检查全部图片元数据，再读取 blob；上限为 128 张、单张 16 MiB、合计 32 MiB，配置只能降低合计上限。每张随后再次检查大小/hash。渲染及逐页检查分别使用独立进程、256 MiB Node heap、60 秒、进程树 RSS 2048 MiB 采样监控，沿用 T04 既有边界。这不是生产 cgroup 硬隔离的验收。

PDF/确认稿期限按 T10 的 `bookPdf`/`confirmedStories` 独立检查，实际渲染照片还检查 `derivedPhotos`；原声回听期限由 T21 执行，不能拿原声期限替代 PDF 期限。返回当前身份和相关资料的最早到期时间，精确到期拒绝读取。

本地候选为 148×210 mm、0 mm 出血、固定 Noto Sans CJK SC Regular 2.004、Chromium 145.0.7632.6、模板 `t20-a5-v2`。检查保留实际 PDF point 尺寸，允许 Chromium CSS 像素取整的一 point 偏差。D01 印厂规格/实物与 D08 适用方案尚未验收；启动只能显式使用 test/synthetic 配置及 `.invalid` 原声入口，默认无 Book 路由，production 拒绝启用。

## 验证记录

| 公开行为                                     | 实际证据                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份/空项目不编造内容                        | `01-context-red.log` 的 404→要求401；`01-context-green.log` 通过                                                                                  |
| 当前许可版本、并发幂等冻结和原声清单         | `02-freeze-green.log` 曾因忽略已处理核对项而失败；修复后 `02-freeze-green-final.log` 通过                                                         |
| 实际 PDF/下载/完整性                         | `03-render-red-final.log` 的 unavailable→ready；最终实际渲染通过                                                                                  |
| 配置漂移使旧版失效                           | `04-config-red.log` 的 queued→应obsolete；`04-config-green.log` 通过                                                                              |
| 长正文、两篇/两目录、照片和一次原声码        | `05-photo-long.log` 复现真实文字检查失败；修复固定字体的 CJK 字形别名归一化后，再修正 jsQR 对正文误识别出的空 payload；最终 13 页全部严格检查通过 |
| 未来计划不失效、目录/封面/正文失效、撤回隔离 | 最终 Book 回归通过；共享撤回提升 epoch，旧确认不会自动沿用                                                                                        |
| 重启及真实 Redis 调度丢失                    | `09-real-queue-retention.log`：真实入队、Outbox 已投递、只清除隔离队列、API 重启后同一任务/快照成功；不重复 T15 的完整故障矩阵                    |
| PDF 独立保留期                               | `08-retention-red.log` 复现 bookPdf1天到期而其他资料400天仍返回200；修复后403，最终相关回归通过                                                   |
| 准备阶段资源和有限重试                       | `10-resource-red.log` 复现降低图片字节上限后仍出稿；修复后稳定失败且无PDF，重试上限拒绝                                                           |
| 正文中合法“第1页”和页面标题短语              | `11-body-red-resource-green.log` 复现全局移除页眉页脚会误删正文；按每页首尾各移除一次后通过，全文检查仍严格                                       |
| 重放/重试的到期信息                          | `12-replay-expiry-red.log` 复现当前读取有期限而重放返回null；统一期限后通过                                                                       |
| 共享任务 owner                               | `13-task-owner-red.log` 复现向书稿任务提交采集协助重试造成500；现以403明确拒绝                                                                    |

日志均位于 `/tmp/timenook-t20-logs/`。最后边界修复的 `final-boundary-fixes.log` 为 **2/2**。修复后的 Book 全文件曾 **14/14**（`book-final.log`），最后仅增加共享重试拒绝断言并再次定向通过。

此前同轮相关组合为 **70/70**（Book13 + PrintProbe、Transcription、StoryConfirmation、PersonalPlan，`backend-related-final.log`）；印刷核心 **13/13**（`print-final.log`）。最终两处期限返回和共享重试拒绝的窄修复没有改变渲染器或未受影响的这些分支，按范围引用旧证据，不声称它们是窄修复后同次全量。最后 API typecheck/build/test-compile 均成功。root 另记录全工作区、真实浏览器、25→26 升级/重放、原生编译和最终提交门禁。

## 初次提交的合成产物（d20260f，已被下述审查修复版替代）

`/tmp/timenook-t20-artifact-final/` 保留 `book.pdf`、`snapshot.json`、`manifest.json`、全部 13 张 `pages/page-*.png` 和 `pages/inspection.json`。最终 manifest 的 `book` 段绑定来源版本和确认稿 hash。

- PDF SHA256：`ecbefea07ef6769b0a19683f34e187aaa10699f0ceeb371d22ea9551d1173fba`
- snapshotHash：`ce524a06747cc1adcca52c097b947415c997fe2283a7a777f0e657c2fbca6036`
- QR 在实际第4/5页，各一枚；总计两枚原声码和一张照片。4860字长稿跨页完整，图注与 AI/人工来源保留，空章节没有虚构正文。

root 已逐页查看先前相同版式的13页，并对最终变化的第4/5页二维码和 manifest 再核对。上述产物没有真实讲述者资料。真实微信小程序码/手机扫码与播放、适用 D08 标识/供应商准入、印厂接收/印前转换和实物仍为外部待验，不能据此关闭这些验收项或进行生产。

## d20260f 之后的正式审查修复

正式 Spec 审查指出两处 P2：完整照片说明/附记被当作不可分块，合法内容会失败；以及 PRD 8.2 的称呼和可选封面照片缺失。它们均已修复，没有引入新的排版引擎或上传系统。

### 长说明及附记

沿用 T04 原有字符二分分页及标点边界规则，抽出同一个文字流函数，正文、产品照片说明及本人附记共同消费。照片仍作为确定尺寸图片，说明按原顺序紧随图片并可跨页，全部附记继续完整排版。探针原有照片路径及布局保持。

`review-pagination-red.log` 从真实录音/故事生成、公开照片及故事版本/本人确认到书稿任务，复现 145mm 肖像照片+300字说明、4500字本人附记均无法出稿；`review-pagination-green.log` 两项通过。测试另从鉴权下载的 PDF 独立使用 PDF.js 提取各页，逐一核对完整文字、实际页数、图像和照片→说明→附记顺序。两类极端样本位于 `/tmp/timenook-t20-pagination-review/`。

### 确定的称呼及封面照片

- 增加 Book 自己的不可变 `BookCoverVersion`：默认 version0、空称呼、不使用封面照片；以当前项目授权、乐观版本和既有 BookCommand 幂等命令保存。已在尚未合并的第26条迁移中加入表/外键/不可变触发器，没有新增第27条，也没有修改 Project/T19 写规则。
- `GET .../book` 返回 cover 设置和可选照片；`POST .../book/cover` 接受 expectedVersion、最多120字称呼以及可空的 print asset ID。选项只来自当前本人确认并允许入书的故事照片，携带原 interview/photo/asset ID、bytes/hash、说明及尺寸；原有 Media 网关负责当前鉴权读取，不另发公开图片地址。
- 快照冻结封面设置版本、称呼和确切照片；修改设置、改变故事版本或撤回来源故事的入书许可使待生产书稿失效。选择资产不再可用时保持设置可供纠正，但不能重新生成。封面文字和选定照片进入同一输入/快照 hash。
- 封面与内页可使用同一资产；准备 buffer 和图片文件按 assetId 去重，两个实际排版位置分别计入独立 PDF 图像检查。封面使用固定字体和保留图片空间的固定版式，完整120字书名与120字称呼及肖像照片可同时留在第一页，没有裁文或把封面图片挪到内页。

`review-cover-red.log` 的公开入口404变为 `review-cover-green.log` 成功；后者同时验证并发幂等、过期版本/未知资产拒绝、旧版失效、快照历史保持、实际下载 PDF 的封面称呼和封面/内页同图。`review-cover-recovery.log` 中的最大长度封面及撤回来源许可检查通过。仅新增一个确定封面 owner，没有自由排版、模板平台或商业政策扩展。

### 旧提交 CI 的测试恢复边界

旧提交 d20260f 的 CI `40169268188` 中，恢复用例在20秒等待内超时，不能计为成功。原用例会把前序独立场景留下的有效 queued 书稿一起调度；这个总等待不是目标任务恢复时延的独立证据。当前用例先重建本票独立可丢弃夹具，再保留真实 Redis 入队→Outbox 已投递→清除隔离队列→API 重启→同一任务恢复的链路，明确断言只有一个 due 任务。等待上限90秒，超时报告完成的 job ID 及目标项目真实任务 state/lease/error。生产资源、租约及任务截止时间没有放宽，也不把这个测试等待写为服务 SLA。

### 审查修复版最终验证及产物

- API 类型、构建及测试编译成功；Book 全文件 **18/18**：`/tmp/timenook-t20-logs/review-book-final.log`。
- 固定印刷核心 **13/13**：`/tmp/timenook-t20-logs/review-print-final.log`，包含原探针分页/图片/二维码回归。
- root 另核对真实25→26升级/重放与旧大纲/目录/hash 保持；浏览器、整仓构建以及新固定提交的正式双轴/替代 CI 由 root 记录，本文不先行追认。

当前代表样书为 `/tmp/timenook-t20-review-artifact/`，模板 `t20-a5-v3`，13页、两枚原声码、一张照片同时用于封面及内页（独立 PDF 图像总数4）。封面称呼“献给这些年一路相伴的家人”与当前照片一起冻结。原13页中变动的封面及两处二维码页由 root 单独查看，其余版式证据按未变像素复用；不把旧 v2 文件称作当前输出。

- 当前 PDF SHA256：`238e77324c523ef697c3389d094d16bfb6acdeb18c44e1b94a3ae369b773460b`
- 当前 snapshotHash：`7577924124cac257168f4a817eb1baaeebe4a27ee333dca80e456ee2a6c24842`

真实平台、供应商及 D01/D08、印前/实物仍保持待验；上述工作只修复本票本地工程，未执行 Git/GitHub 写操作、部署、真实采集或生产。

### 独立原图预览期限的最后联动修复

封面缩略图取自原有 Media 网关的 `derivedPhotos`，和已经生成的 `bookPdf`/确认稿分别执行 D03。新增实时 `BookVersionView.coverPhotoAccess={allowed,expiresAt}`：没有封面照片、缺少衍生照片规则或该规则已到期时为 false/null；可用时返回当前 Book/操作身份与衍生照片期限的最早到期。它只描述原始图片预览权限，不进入不可变快照、inputHash、PDF hash 或渲染配置。

真实 HTTP 回归使用一份合成套餐，`derivedPhotos` 1天，`bookPdf`/`confirmedStories` 400天。先完成真实照片/本人版本确认、封面选择及固定 PDF；注入一个受控交付事实，验证原图片200与较早的预览到期时间。只推进 JavaScript Date 越过照片期限后，原图片403，而 Book/确定版本/PDF 均继续200、ready；快照、inputHash 和下载文件 SHA256 全部保持。新字段此时变为 false/null，页面可以只清理自身封面缩略图，不误清除仍可读取的书稿/PDF。未知 Media403 仍须前端重新读取当前 Book 区分全局授权变化，不豁免实际身份或共享撤回。

`review-derived-cover-red.log` 记录真实原图片403/PDF200已经成立，但字段缺失；`review-derived-cover-green.log` 新用例 **1/1**通过。最后 API typecheck/build/test-compile 通过；此前相关 Book **18/18**与印刷 **13/13**按未改渲染/快照范围复用，没有冒称19项是同次全量。没有重跑无关 API 套件，没有修改 SQL、生产政策或最终样书；当前238e…PDF及其视觉检查继续适用。前端对应的原图清理/到期/撤回验证及最终整仓 CI 由 root 记录。

### 7f421fb 正式审查后的确认稿与 PDF 独立期限

最终 Spec 审查发现第二处具体 D03 耦合：读取或下载已冻结 PDF 仍要求原确认稿未到期，并将两类期限合并。既有接受的固定政策允许 `confirmedStories` 1天、`bookPdf` 400天，没有要求来源资料必须比 PDF 保留更久。`review-source-retention-red.log` 以真实录音/照片/本人确认及固定渲染生成 ready PDF，只推进受控交付事实对应的 JavaScript Date 越过确认稿期限，复现下载403（预期200）。

- 冻结书稿读取和两次文件交付鉴权按 `bookPdf` 自身期限及当前操作身份/共享许可执行；`accessExpiresAt` 只合并这些期限。内部当前输入比较不受来源类别到期阻断，内容、入书决定、身份 epoch、封面/目录及渲染配置变化仍使旧稿失效。
- 生成、封面与目录修改、重试（包括幂等重放）以及 Worker 领取/发布保留明确的 `confirmedStories` 检查；涉及照片的渲染继续要求有效 `derivedPhotos`。未放宽任何商业期限或生产许可。
- Context 与 Version 新增实时 `draftAccess={allowed,expiresAt}`，有效期为操作身份/PDF与确认稿的最早期限；来源缺少规则或已到期时为 false/null。该字段不进入任何不可变快照、输入 hash、PDF hash 或渲染配置。封面原图仍由独立的 `coverPhotoAccess` 描述。
- 来源不可用时 Context 的 `inputHash=null`，`eligibleStories` 与 `coverPhotoOptions` 为空；目录和封面仅回退到已授权的当前冻结快照，没有书稿时返回空默认值，不返回无关实时来源。Version 仍表示同一授权冻结快照，排队稿也可查看，但不能继续制作或重试。

`review-source-retention-green.log` 为对应公开 HTTP **1/1 RED→GREEN**：原确认稿到期后 PDF200，下载字节 SHA256、inputHash、snapshotHash及整个冻结内容保持；PDF期限仍为第400天，草稿能力按第1天关闭，所有来源操作403。另验证配置变化仍拒绝PDF、真实书名修改使旧版 obsolete、发起人共享撤回后 Context/Version/PDF 均403，未把到期分离当作全局授权豁免。

完整 Book 文件最终 **21/21**（`review-source-book-final.log`），包括排队任务在来源到期后拒绝 Worker 发布、保持原快照且不产生 PDF、重试403，以及前述原图期限、长说明/附记、封面、队列恢复等回归。API typecheck/build/test-compile 全部通过，`git diff --check` 通过。SQL和渲染器没有改动，未重跑无关 API 或印刷核心；当前样书 SHA256 仍为 `238e77324c523ef697c3389d094d16bfb6acdeb18c44e1b94a3ae369b773460b`，已有逐页视觉及25→26迁移证据继续按未受影响范围使用。前端实时期限清理/权限重查和最终整仓、固定提交审查及替代CI由 root 记录。

### ba44ab0 CI 中共享 Worker 完成事件的测试竞态

CI `40173428942` 在既有转写用例中失败：断言目标任务已进入 `waiting_provider` 时，实际仍是 `submitting`。该用例使用 `once(worker, "completed")` 等待任意 job；`recoverDue` 同时调度前序及当前任务，真实 Worker 并发为2，其他 job 先完成并不表示目标任务已经完成提交。这次只修复测试，没有改变任务、供应商或生产 Worker 行为。

确定性复现仍通过公开 HTTP 保存两条真实合成录音，并使用现有外部供应商夹具的 Promise 阻塞目标提交。另一个真实 Redis job 完成时，明确核对其 ID 不等于目标，目标 HTTP 状态仍是 `submitting`。保留原 `once` 等待的版本稳定复现同一失败（`review-transcription-target-red.log`，1.69秒），没有依赖随机时序或增加 sleep。

修复复用文件内既有 `wake(runtime, targetId)`：其他 job 完成时该目标 Promise 必须仍未结束；释放目标供应商响应后才等待目标 job 完成，并通过公开 HTTP 核对 `waiting_provider`。`finally` 释放夹具、还原 transport 并关闭真实 Worker；既有等待上限没有放宽。定向 **1/1 GREEN**（`review-transcription-target-green.log`），完整转写文件一次 **24/24**（`review-transcription-target-final.log`，47.93秒），API typecheck/test-compile、格式及 diff 检查通过。所有日志位于 `/tmp/timenook-t20-logs/`。

本次逻辑变更仅 `apps/api/test/transcription.test.ts` 及本验证记录。此前冻结的16个后端可执行/契约/SQL文件逐一 SHA256 比较保持不变，不重复运行未受影响的 Book 或渲染器；独立测试修复的最终提交及替代 CI 由 root 记录。
