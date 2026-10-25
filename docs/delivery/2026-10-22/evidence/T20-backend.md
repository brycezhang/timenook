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

## 最终合成产物

`/tmp/timenook-t20-artifact-final/` 保留 `book.pdf`、`snapshot.json`、`manifest.json`、全部 13 张 `pages/page-*.png` 和 `pages/inspection.json`。最终 manifest 的 `book` 段绑定来源版本和确认稿 hash。

- PDF SHA256：`ecbefea07ef6769b0a19683f34e187aaa10699f0ceeb371d22ea9551d1173fba`
- snapshotHash：`ce524a06747cc1adcca52c097b947415c997fe2283a7a777f0e657c2fbca6036`
- QR 在实际第4/5页，各一枚；总计两枚原声码和一张照片。4860字长稿跨页完整，图注与 AI/人工来源保留，空章节没有虚构正文。

root 已逐页查看先前相同版式的13页，并对最终变化的第4/5页二维码和 manifest 再核对。上述产物没有真实讲述者资料。真实微信小程序码/手机扫码与播放、适用 D08 标识/供应商准入、印厂接收/印前转换和实物仍为外部待验，不能据此关闭这些验收项或进行生产。
