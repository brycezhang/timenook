# 完整资料导出（T25）

本地工程消费 T21 的当前主体、绑定/epoch 及版本化资料、T20 的确定 PDF、ADR0017 的长期服务与 T11/T12 的共享本人核验工单。仅在既有 `environment=test`、`books.mode=synthetic-local` 的隔离组合入口启用；实际 D03/D06/D08 尚未冻结，不能据此开通正式导出或销售。

## 用户与共享工单

讲述者从“我的 → 完整资料导出”提交本次完整范围和接收人；可以本人领取，或单独明确授权发起人领取。一般共享许可、付款或客服登录都不自动授予导出权。用户可查询实际状态、处理人、原订单公示的工作日时限和人工按原工作日历核算的截止时间；导出已包含，不额外收费。

客服沿原共享工单核验身份和范围，再受理并执行受控打包。没有个人微信的讲述者由客服代录本人申请、按 D08 核验具体替代接收人和渠道；必须单独记录接收引用，不能默认给发起人。仅该工单核验客服可领取替代渠道包，实际交付后记录回执；本人或获授权发起人通过产品入口领取，设备保存/发送成功后回执。已完成资料包长期有效，回执只记录交付事实。

内容领取复用 Participation 当前有效同意判断；新的流序号本身不是授权。当前采集用途被拒绝或协助授权已失效时，旧申请/旧包停止打包、完成、领取和回执；最少查询与权利申请/受理仍可用，列表逐工单返回 `canDownload=false` / `EXPORT_CURRENT_AUTHORIZATION_REQUIRED`。恢复适用用途后，旧工单仍按原绑定、版本和当前授权核验。

本人也可在拒绝继续采集后，重新明确申请导出历史资料并经客服核验该新范围，无需为了导出重新同意采集。创建 export 工单时在项目锁内冻结实际 collection 同意记录 ID 与当时有效状态到不可变 `CareRequest.exportCollectionStamp`；当前不可用事实与申请时一致、且该新工单已核验，才可作为该工单专属导出授权。拒绝前的申请、同键重放、后来才核验的旧申请不因此升级；后来新的拒绝或失效事实使此前专属授权失效。新授权只作用于新工单，旧包的接收人及版本范围不变，不恢复普通内容浏览。未选择普通采集的无微信讲述者仍可按原 D08 专属核验渠道行使导出权，买方的一般 sharing 既不替代也不是本人专属导出授权的前提。这里的事实匹配不依赖时间精度或活动流 sequence。

| 入口                                            | 行为                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `GET/POST /v1/projects/:id/exports`             | 本人申请、当前接收人及实际状态；申请幂等且不自动核验                        |
| `GET /v1/projects/:id/exports/:caseId/download` | 固定接收人、当前会话、主体/绑定/epoch、完整来源重验                         |
| `POST /v1/projects/:id/exports/:caseId/receipt` | 接收人核对具体 ZIP hash 后记录回执                                          |
| `/v1/admin/care-requests/:caseId/export`        | 在共享工单中查询受理/打包状态                                               |
| 上述运营入口的 `/accept`、`/pack`、`/delivery`  | 本人/范围核验后受理、实际打包、替代渠道实际回执；沿用管理飞书身份/CSRF/审计 |
| `GET` 上述运营入口的 `/download`                | 仅已核验替代交付、工单核验客服、当前授权有效                                |
| `POST /v1/admin/exports/cleanup`                | 仅清理技术孤儿包；保留仍被引用的 ready/delivered ZIP                        |

公网部署目标为 TimeNook 独立域名下的 `/api/v1`，代理只剥离 `/api` 一次，见 [ADR 0015](adr/0015-dedicated-domain-ingress.md)。预览路由和 `wx.request/downloadFile` 白名单按这些确定入口配置并验证；无 OSS 可分享跳转。

## 固定版本与实际产物

导出包保存原始录音 MP3、原始文件 ASR 转录 TXT、本人确认的具体故事版本 TXT、原图及衍生照片、已完成且该版本仍获授权的 PDF、`README.txt` 和 `manifest.json`。清单逐份记录相对路径、字节数、SHA256、来源和版本关系；故事来源保留段落来源、转录/音频及照片快照、人工校对和本人版本关系。AI 整理与人工校对标识跟随所导出的版本，原始录音不标成合成音频。测试样本在说明中另行明确为合成。

采用普通 ZIP STORE（不压缩）格式及 CRC32；实现核对 [PKWARE ZIP 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) 的普通文件、中央目录与结束记录；不使用 ZIP64 或专有扩展。测试以独立 Python `zipfile` 解压、检查数量/全部 hash 与确切 PDF hash。manifest 本身通过外层 ZIP 的 SHA256 保护，避免自引用 hash。

原素材尚未创建的类别可为零，清单及可读说明如实区分；已封存录音缺少原始转录时显示 `EXPORT_TRANSCRIPT_PENDING`，缺件、hash 不符或版本撤回不发布可领取包。单次最多 510 个内容文件、内容合计 128 MiB，超出进入明确人工待办，不交付截断包。打包使用持久 `CareExport` 状态、短租约和 fence；进程中断后同一工单可恢复，旧执行不能覆盖新执行。它是客服主动运行的有界打包工具，沿用 T15 Worker 的恢复/补扫入口，没有新增自助编排平台。

## 长期资格、安全授权及技术清理

`exportRequests` 和已完成包长期有效，均返回 `expiresAt:null`。首次完成只保存 readyAt/hash/manifest；制作、交付、受理、回执、重试或超过 2099 年都不形成业务截止。D06 工作日处理时限与工单 dueAt 继续执行。资料被本人核验删除后拒绝生成或领取，显示 `EXPORT_SOURCE_DELETED`；当前授权失效显示 `EXPORT_CURRENT_AUTHORIZATION_REQUIRED`。缺件/hash 错误仍不发布部分归档。

小程序在下载后重查 epoch、当前接收授权与同一文件 hash，核对实际大小/hash，再由用户保存；离页、切号或迟到响应清理设备临时文件。`ProjectStreams` 在文件 I/O 前捕获 fence，并持续重验当前会话、主体/绑定/epoch、版本许可和来源可用性。用户撤回、换绑、删除及管理员退出仍中止活动流；长期资格不使安全会话或客服限时授权永久化。

`CompleteExports.cleanupTemporary()` 由 Worker 的 recoverDue 和受控 `/v1/admin/exports/cleanup` 调用。只清理确定未被 ready/delivered 记录引用、也未被当前 packing fence/有效 lease 占用的 ZIP。API/Worker 不再按服务期限清理必要资料或已完成包。`purgeProject(projectId)` 仍在撤回/删除访问已拒绝后撤销包状态、增加 fence、清空 manifest 并删除文件；不能收回已传输副本或纸书。

## 客服替代交付的独立安全授权

无微信替代交付使用不可变 `ExportStaffGrant`，与资料包长期资格分别存储。首次受理只消费原本人核验事实，从原 verifiedAt 起最多30分钟；延迟受理、重复accept、工单completed或客服重新飞书登录不延长它。原核验客服以外的人不能取得或使用该授权。

过期后由原核验客服沿 `POST /v1/admin/care-requests/:caseId/export/access-verification` 记录新的受控本人核验：须匹配本项目D08身份流程和本人确认渠道，核对当前讲述者/绑定/epoch、具体接收人和渠道，并记录告知版本、完整资料交付用途、本次明确同意和新的受限核验记录引用。服务端最多30分钟，后台选择15分钟。登录或单独提供未来日期不能续签；同键只返回原授权，旧核验记录换键也不能复用。授权表只保存主体/操作人、范围、时间及证据/接收引用hash等最少事实，原受限核验记录仍由既有运营流程保管。

领取在文件I/O前后和流中持续重验当前授权、原核验人、binding/epoch/撤回序号和有效期，并固定首次捕获的grant ID。新的授权不会接续旧活动流；撤回、换绑和安全授权到期停止私有字节。后台取包后重查同一grant及包hash，使用staffAccess.expiresAt，不再把包的expiresAt=null当成下载失败。普通用户领取不要求客服授权，也不恢复任何业务到期日。

#105 Spec P1复现从8天后无新本人核验仍HTTP200变为403；受控新核验后同包hash仍可领取。新增5条公开HTTP/活动流用例和2条浏览器流程通过，相关导出/授权/删除回归与最终CI分别记录。质量与履约私人访问继续消费其独立本人限时grant，D06/D07与安全TTL各自适用。

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
