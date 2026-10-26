# 完整资料导出（T25）

本地工程消费 T21 的当前主体、绑定/epoch 及版本化资料、T20 的确定 PDF、T10/D03 的独立期限与 T11/T12 的共享本人核验工单。仅在既有 `environment=test`、`books.mode=synthetic-local` 的隔离组合入口启用；实际 D03/D06/D08 尚未冻结，不能据此开通正式导出或销售。

## 用户与共享工单

讲述者从“我的 → 完整资料导出”提交本次完整范围和接收人；可以本人领取，或单独明确授权发起人领取。一般共享许可、付款或客服登录都不自动授予导出权。用户可查询实际状态、处理人、原订单公示的工作日时限和人工按原工作日历核算的截止时间；导出已包含，不额外收费。

客服沿原共享工单核验身份和范围，再受理并执行受控打包。没有个人微信的讲述者由客服代录本人申请、按 D08 核验具体替代接收人和渠道；必须单独记录接收引用，不能默认给发起人。仅该工单核验客服可领取替代渠道包，实际交付后记录回执；本人或获授权发起人通过产品入口领取，设备保存/发送成功后回执。回执记录和重复领取均不重置下载期限。

| 入口                                            | 行为                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `GET/POST /v1/projects/:id/exports`             | 本人申请、当前接收人及实际状态；申请幂等且不自动核验                    |
| `GET /v1/projects/:id/exports/:caseId/download` | 固定接收人、当前会话、主体/绑定/epoch、完整来源与包期限重验             |
| `POST /v1/projects/:id/exports/:caseId/receipt` | 接收人核对具体 ZIP hash 后记录回执                                      |
| `/v1/admin/care-requests/:caseId/export`        | 在共享工单中查询受理/打包状态                                           |
| 上述运营入口的 `/accept`、`/pack`、`/delivery`  | 本人/范围核验后受理、实际打包、替代渠道实际回执；沿用管理 MFA/CSRF/审计 |
| `GET` 上述运营入口的 `/download`                | 仅已核验替代交付、工单核验客服、有效包期限                              |
| `POST /v1/admin/exports/cleanup`                | 受控到期与孤儿包补扫；不清理原始资料                                    |

公网统一添加 `/timenook`，代理只剥离一次，沿用 ADR 0009。预览路由和 `wx.request/downloadFile` 白名单只开放这些确定入口；无 OSS 可分享跳转。

## 固定版本与实际产物

导出包保存原始录音 MP3、原始文件 ASR 转录 TXT、本人确认的具体故事版本 TXT、原图及衍生照片、已完成且该版本仍获授权的 PDF、`README.txt` 和 `manifest.json`。清单逐份记录相对路径、字节数、SHA256、来源和版本关系；故事来源保留段落来源、转录/音频及照片快照、人工校对和本人版本关系。AI 整理与人工校对标识跟随所导出的版本，原始录音不标成合成音频。测试样本在说明中另行明确为合成。

采用普通 ZIP STORE（不压缩）格式及 CRC32；实现核对 [PKWARE ZIP 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) 的普通文件、中央目录与结束记录；不使用 ZIP64 或专有扩展。测试以独立 Python `zipfile` 解压、检查数量/全部 hash 与确切 PDF hash。manifest 本身通过外层 ZIP 的 SHA256 保护，避免自引用 hash。

原素材尚未创建的类别可为零，清单及可读说明如实区分；已封存录音缺少原始转录时显示 `EXPORT_TRANSCRIPT_PENDING`，缺件、hash 不符或版本撤回不发布可领取包。单次最多 510 个内容文件、内容合计 128 MiB，超出进入明确人工待办，不交付截断包。打包使用持久 `CareExport` 状态、短租约和 fence；进程中断后同一工单可恢复，旧执行不能覆盖新执行。它是客服主动运行的有界打包工具，沿用 T15 Worker 的恢复/补扫入口，没有新增自助编排平台。

## 三类期限及清理

申请资格读取旧订单的 T10/D03 `exportRequests`，恰好到期停止新申请；本地合成固定处理约定是按时受理的请求可继续处理，但仍受原资料保留期和当前授权限制。该处理约定及实际值须随 D03 冻结后才能启用正式业务，不能从合成结果推定商业承诺。

已受理请求首次打包时，若本次实际资料类别已到期，打包命令保存并返回 `failed` / `EXPORT_SOURCE_RETENTION_EXPIRED`，用户与运营查询均显示该原因，不能继续显示等待打包。慢打包跨期也保存此原因并拒绝发布；权限失效、源文件缺失及读取错误分别沿原检查处理。重复打包不改变受理时间或原处理截止，不生成 ready 时间、下载期限或可领取文件。

包首次完成时，按原 D03 `retention.exportPackages` 的 `export_ready` 起算确定下载截止。数据库约束固定本次主体、接收人、版本域、首次 ready 时间、包 hash 和截止；重试、进程恢复、回执和重复领取不能延长。下载前后重验，确切故事确认/入书版本撤回也拒绝。开始、完成及领取按本次实际文件分类分别核验原声、转录、确认稿、原图、衍生图和 PDF 的独立保留期；原图仍有效不能放行已到期衍生图，未消费的资料类别也不误阻整个包。小程序在下载完成后重新查询 epoch、同一文件 hash 和期限，校验本地实际大小/hash，再由用户保存或发送；离页、切号或迟到响应清理本次临时包，不提供给新会话。

`CompleteExports.cleanupExpired()` 由 T15 Worker 每次 `recoverDue()` 以及受控清理入口补扫到期和孤儿 ZIP。原始资料仍按自己的保留/删除台账处理，包清理不删除原始资产。T26 可调用 `CompleteExports.purgeProject(projectId)`：访问撤销提交后，撤销包状态、增加 fence、清空内容 manifest 并删除包及孤儿文件。存储位置为 `books.storageRoot/exports/<caseId>-<fence>.zip`，路径只由服务端固定 ID 生成并校验。已传输字节、已导出副本及纸书不能远程收回。

T24 的跨进程活动流终止由 T24 责任票提供；本票独立基线先实现完成/下载两端重验，组合后须复验流式传输联动，不能用上述前后检查冒充活动流终止。

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

以上命令需显式设置回环 `DATABASE_URL` 和 `REDIS_URL`。浏览器 fixture 使用 5195/3445/3446 独立端口，只有微信/支付/AI 协议使用明确合成替身，实际 API、PG/Redis、Page/Vben 与 ZIP 均真实运行。真实 D03、D06 工作日历/负责人、D08 身份/接收/渠道、双端设备及实际交付由本票与责任票另留证。
