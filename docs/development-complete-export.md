# 完整资料导出（T25）

2026-10-29 当前方案以 [ADR 0017](adr/0017-lifetime-service-and-retention.md) 为准：导出申请、下载及其必要资料长期有效；下文按新目标更新，代码对齐与本轮验证尚待完成。历史有限期测试保留为当时结果，不证明新规则已实现。

本地工程消费 T21 的当前主体、绑定/epoch 及版本化资料、T20 的确定 PDF、T10/D03 的长期资料服务与 T11/T12 的共享本人核验工单。仅在既有 `environment=test`、`books.mode=synthetic-local` 的隔离组合入口启用；D03 长期规则已决定，其实际存储/删除流程及 D06/D08 仍待核实，不能据此开通正式导出或销售。

## 用户与共享工单

讲述者从“我的 → 完整资料导出”提交本次完整范围和接收人；可以本人领取，或单独明确授权发起人领取。一般共享许可、付款或客服登录都不自动授予导出权。用户可查询实际状态、处理人、原订单公示的工作日时限和人工按原工作日历核算的截止时间；导出已包含，不额外收费。

客服沿原共享工单核验身份和范围，再受理并执行受控打包。没有个人微信的讲述者由客服代录本人申请、按 D08 核验具体替代接收人和渠道；必须单独记录接收引用，不能默认给发起人。仅该工单核验客服可领取替代渠道包，实际交付后记录回执；本人或获授权发起人通过产品入口领取，设备保存/发送成功后回执。回执记录和重复领取不改变原包的确定内容与接收范围；下载服务长期有效。

内容领取复用 Participation 当前有效同意判断；新的流序号本身不是授权。当前采集用途被拒绝或协助授权已失效时，旧申请/旧包停止打包、完成、领取和回执；最少查询与权利申请/受理仍可用，列表逐工单返回 `canDownload=false` / `EXPORT_CURRENT_AUTHORIZATION_REQUIRED`。恢复适用用途后，旧工单仍按原绑定、版本和当前授权核验。

本人也可在拒绝继续采集后，重新明确申请导出历史资料并经客服核验该新范围，无需为了导出重新同意采集。创建 export 工单时在项目锁内冻结实际 collection 同意记录 ID 与当时有效状态到不可变 `CareRequest.exportCollectionStamp`；当前不可用事实与申请时一致、且该新工单已核验，才可作为该工单专属导出授权。拒绝前的申请、同键重放、后来才核验的旧申请不因此升级；后来新的拒绝或失效事实使此前专属授权失效。新授权只作用于新工单，旧包的内容与专属授权不变，不恢复普通内容浏览。未选择普通采集的无微信讲述者仍可按原 D08 专属核验渠道行使导出权，买方的一般 sharing 既不替代也不是本人专属导出授权的前提。这里的事实匹配不依赖时间精度或活动流 sequence。

| 入口                                            | 行为                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `GET/POST /v1/projects/:id/exports`             | 本人申请、当前接收人及实际状态；申请幂等且不自动核验                    |
| `GET /v1/projects/:id/exports/:caseId/download` | 固定接收人、当前会话、主体/绑定/epoch、完整来源与安全授权有效期重验             |
| `POST /v1/projects/:id/exports/:caseId/receipt` | 接收人核对具体 ZIP hash 后记录回执                                      |
| `/v1/admin/care-requests/:caseId/export`        | 在共享工单中查询受理/打包状态                                           |
| 上述运营入口的 `/accept`、`/pack`、`/delivery`  | 本人/范围核验后受理、实际打包、替代渠道实际回执；沿用管理飞书身份/CSRF/审计 |
| `GET` 上述运营入口的 `/download`                | 仅已核验替代交付、工单核验客服、当前有效授权                              |
| `POST /v1/admin/exports/cleanup`                | 受控技术残留/孤儿包补扫；不按服务期限清理有效包或原始资料                                    |

公网部署目标为 TimeNook 独立域名下的 `/api/v1`，代理只剥离 `/api` 一次，见 [ADR 0015](adr/0015-dedicated-domain-ingress.md)。预览路由和 `wx.request/downloadFile` 白名单按这些确定入口配置并验证；无 OSS 可分享跳转。

## 固定版本与实际产物

导出包保存原始录音 MP3、原始文件 ASR 转录 TXT、本人确认的具体故事版本 TXT、原图及衍生照片、已完成且该版本仍获授权的 PDF、`README.txt` 和 `manifest.json`。清单逐份记录相对路径、字节数、SHA256、来源和版本关系；故事来源保留段落来源、转录/音频及照片快照、人工校对和本人版本关系。AI 整理与人工校对标识跟随所导出的版本，原始录音不标成合成音频。测试样本在说明中另行明确为合成。

采用普通 ZIP STORE（不压缩）格式及 CRC32；实现核对 [PKWARE ZIP 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) 的普通文件、中央目录与结束记录；不使用 ZIP64 或专有扩展。测试以独立 Python `zipfile` 解压、检查数量/全部 hash 与确切 PDF hash。manifest 本身通过外层 ZIP 的 SHA256 保护，避免自引用 hash。

原素材尚未创建的类别可为零，清单及可读说明如实区分；已封存录音缺少原始转录时显示 `EXPORT_TRANSCRIPT_PENDING`，缺件、hash 不符或版本撤回不发布可领取包。单次最多 510 个内容文件、内容合计 128 MiB，超出进入明确人工待办，不交付截断包。打包使用持久 `CareExport` 状态、短租约和 fence；进程中断后同一工单可恢复，旧执行不能覆盖新执行。它是客服主动运行的有界打包工具，沿用 T15 Worker 的恢复/补扫入口，没有新增自助编排平台。

## 长期导出与清理边界

本人可随时提出完整资料导出申请，已受理请求按 D06 人工处理 SLA 完成。导出资格、有效包下载和支撑打包的原声、转录、确认故事、原图/衍生照片与 PDF 不按服务时间到期。原销售配置中的短期限不能继续阻止新申请、完成打包或领取；若必填日期采用 2099-12-31，仅为占位而非业务截止。

首次完成仍固定实际 ready 时间、包 hash、大小、来源与版本清单及接收范围；重试、进程恢复、回执和重复领取不能替换确定内容或扩大授权。下载前后重验当前权限，确切故事确认/入书许可撤回、换绑或主动删除仍阻止旧包。开始、完成和领取按实际 manifest 核对源文件和当前授权，缺失来源或未知类别不能发布不完整包。

小程序在下载完成后重新查询 epoch、同一文件 hash 和当前授权，校验本地实际大小/hash，再由用户保存或发送；离页、切号、安全授权到期或迟到响应清理本次临时包，不提供给新会话。会话和单次访问能力仍可到期，用户在当前授权有效时可以重新登录或重新取得访问能力继续下载。

Worker 和受控清理入口取消按服务期限清理有效导出包的规则。失败打包、无有效引用的孤儿 ZIP 等技术残留仍可按精确归属清理，不删除有效包或支撑长期服务的源资料。主动删除通过 T26 调用 `CompleteExports.purgeProject(projectId)`：访问撤销提交后，撤销包状态、增加 fence、清空内容 manifest 并删除所涉包及孤儿文件。路径只由服务端固定 ID 生成并校验。已传输字节、已导出副本及纸书不能远程收回。

已消费 T24 [PR #61](https://github.com/brycezhang/timenook/pull/61) / main `78ccf6d` 的 `ProjectStreams`。用户入口在包文件 I/O 前捕获 `userFence`，替代交付在管理员核验后、文件 I/O 前捕获 `fence`，将原 epoch 和撤回序号交给同一 `guard`。已核对大小/hash的有界 ZIP 保留完整 Content-Length，按最多64KiB发送；每块及背压空闲每100ms重验当前会话、主体/绑定/epoch、确切版本、实际资料类别和安全授权有效期，替代交付另重验核验管理员的当前权限。撤回、换绑、安全授权到期或管理员退出会中止活动流；旧序号的补扫不终止新授权后同 epoch 的流，也不影响其他项目。范围与共享机制见[撤回与活动访问](development-withdrawal.md)。这仍不能收回已传输字节或用户主动保存的副本。

## 复现

先安装锁定依赖、准备固定字体和 Chromium、使用本地 PostgreSQL/Redis；不要加载云端或生产 `.env`。测试自行创建唯一 schema 和 Redis 前缀并清理，不操作业务数据库。

```sh
pnpm db:generate
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
pnpm --filter @timenook/api exec node --test --test-concurrency=1 dist-test/test/complete-export.test.js
pnpm exec tsx --test tests/complete-export-page.test.ts tests/cloud-preview.test.ts
pnpm exec playwright test -c playwright.admin.config.mjs tests/admin/complete-export.spec.mjs
pnpm check:native
```

以上命令需显式设置回环 `DATABASE_URL` 和 `REDIS_URL`。浏览器 fixture 使用 5195/3445/3446 独立端口，只有微信/支付/AI 协议使用明确合成替身，实际 API、PG/Redis、Page/Vben 与 ZIP 均真实运行。D03 实际长期保留/主动删除、D06 工作日历/负责人、D08 身份/接收/渠道、双端设备及实际交付由本票与责任票另留证。

新验收须覆盖时间推进与 Worker 重启后仍可申请、打包和领取，且旧服务期限不触发清理；同时复验撤回活动流、当前接收授权、管理员退出、完整性及孤儿文件清理。
