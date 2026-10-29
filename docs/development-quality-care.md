# 原单质量售后与重印（T28）

T28 / [#29](https://github.com/brycezhang/timenook/issues/29) 沿用 T23 生产尝试、T27 退款及共享客服工单。当前只支持明确隔离的合成配置；D06/D07、实际印厂责任与回执、设备及商户能力仍须真实验收。

## 用户与运营流程

买方或当前绑定讲述者从原订单/生产记录选择实际已交付的一次制作，提交质量情形与最多 1500 字说明。后端固定原付款单、唯一首本生产单、原尝试、书稿/PDF hash 与物流关联；申请时间由服务端保存。用户选择可读的版本/交付记录，内部句柄由页面传递。

说明进入项目所属的可清理 `quality_evidence`，申请、命令及审计保留摘要与必要身份事实。列表/共享工单元数据不携带说明正文、地址或 PDF 字节。运营通过飞书管理会话、`care:write`、CSRF 与审计领取工单，按原销售 D06 日历/流程核验并录入绝对截止及证据引用。负责人、领取时间和截止一次固定，重放不延长；测试中的未来时间不代表商业 SLA。

本人明确选择原版 PDF、本次文字证据或两者，授予当前负责人限时读取；有效期最多 30 分钟。发起人使用本人在场的既有 `book_confirmation` 协助 Session 才能代操作；付款本身不能授权。本人授权绑定原尝试、subject、绑定版本、epoch 和当前撤回序号。每次读取通过 Participation.subjectCareGrantIn 重验本人当前 collection 与原授权方式；同机方式须是本次有效 book_confirmation Session。向发起人 sharing 是独立目的，本人可以拒绝买方共享而单独授权客服，买方普通内容访问仍拒绝。相关同机拒绝即使未递增 epoch，也会使旧 grant 失效；合法重授用途后，须明确重新授予本次质量访问。同机 AI/sharing 单项拒绝不取消这份专属印刷核对权限。

专属授权不放宽 T23 的实际投产条件；重印 preflight 继续执行原 bookGrantIn 等条件。

整合 T25 已发布 main `79f82e5` 后，质量授权、普通参与状态与完整资料导出共用 Participation.effectiveConsentIn 对当前 self/assisted 同意的判断。质量仍须当前 collection 和本次限时 grant；导出拒绝继续采集后的专属权利仍由原导出工单不可变 collection fact 与本人核验控制。两份工单的专属权限互不替代，任何一份都不恢复买方普通共享或首本生产权限。

PDF 使用 T24 的 `ProjectStreams`：文件读取前捕获 fence，发送前及持续传输期间检查当前工单、负责人、用途、scope、绑定和到期。无产品 Authorization 的受控运营调用明确选择本次专属目的；携带产品 Authorization 的普通路径仍按真实用户派生用途，不能被 override 绕过。原文件按照原尝试的确定书稿取回，后来生成的新稿不会覆盖质量核对证据。运营证据读取不附带地址；生产/配送继续走本次生产尝试的独立授权。

客服看清确定版本和证据后，按原销售 D07 对申请情形选择重印或退款。申请资格取原服务端申请时刻与首次交付起算的原窗口，起点包含、终点不包含；及时申请不因客服跨窗口处理而失效。核验保存原窗口及核验事实。系统不自动判质量责任，也不提供任意退款金额或成功状态输入。

## 原单尝试与确认

获准重印在原首本生产单下新增 `quality_request_id` 关联的尝试。首本权益保持 consumed；不新增购买、available 或 reserved 权益。数据库只允许同一原单至多一个非 cancelled/delivered 的活动尝试；handoff_pending、in_production、shipped、cancellation_pending 都占位。已经交付的历史尝试、确认、PDF/地址绑定和首次交付事实保留。

- 原文件：重新核对原尝试的书稿/PDF/地址 hash、当前本人授权及实际印厂状态，原 PDF 中每个确定故事版本的当前入书许可也须有效。后来不同草稿不覆盖原文件，撤销原版入书许可会阻止新重印，明确重新许可后可继续原单。
- 改稿：仅获准的 revised 质量上下文开放现有地址/确认入口，`qualityRevisionRequestId` 标识这一上下文。生成核验后的新书稿/PDF，双方对该版重新确认，地址须由发起人确认。`replacement` 只有在当前新稿和双方 fresh 确认都有效时返回，运营直接使用服务端绑定。

普通首本提交不能复活 consumed 权益。新尝试独立冻结稿、地址和两方确认；交接及材料读取继续重验。T27 的 productionFrozen、firstCopyCancellationRequired、creationState 仍执行；售后不清除商业冻结/终止。质量取消只结束本次尝试，不恢复原首本。未知接单先核实同一尝试，明确取消后才可继续原单救济。

后续质量交付记录在本次尝试及不可变回执中；原 `FulfillmentDelivery` 和 `delivery_completed` 起算事实保持唯一，资料服务长期有效，不因重印或新的签收改变。

## 接口

共享契约在 `packages/contracts/src/quality-care.ts`；所有写命令携带 `Idempotency-Key`，已有申请的写命令携带 `expectedVersion`。

- `GET/POST /v1/orders/:orderId/quality-care`：已交付选项、申请及进展；买方和当前绑定讲述者可见最少状态。
- `POST /v1/orders/:orderId/quality-care/:id/access`：本人/合规同机的限时 scope 授权。
- `POST /v1/orders/:orderId/quality-care/:id/refund`：真实买方将已核验质量申请交给同一退款用例。
- `GET /v1/admin/quality/cases/:caseId`：共享工单的质量元数据、有效新版绑定和实际结果。
- `POST …/:caseId/assign`、`/review`、`/reprints`：领取、按原政策核验与原单新尝试；重印还要求 fulfillment 权限。
- `GET …/:caseId/materials`、`/pdf`：按限时 scope 取得最少文字证据或原 PDF。

退款组合在真实产品会话锁下执行，锁序为 Session → PaymentOrder → Project；调用 `Refunds.requestIn` 时已经持有同一订单锁。退款申请保留原质量申请时刻及稳定单号，批准、提交、通知和查询均沿 T27。质量页只投影该退款实际状态，资金预留和终态仍由原退款用例控制。用户实际金额在原订单退款页查询。退款与资料删除分别执行。

## T26 清理消费清单

T28 不新增证据图片/上传对象或副本存储；本次新增内容为 `quality_evidence.description`，必要资料长期保留；本人核验删除后拒绝新增私人说明或读取，最少申请状态仍可查询。T26 按以下项目关联接入同一用户删除清单，实际外部执行单独留证：

| 资产/类别                       | 项目与定位                                                                                                                         | 清理责任                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 质量文字证据 `quality_evidence` | project_id + request_id + category=quality_evidence                                                                                | 清空 description，记录 erased_at；覆盖数据库及备份/历史副本，不能只隐藏 UI                                 |
| 专属授权事实                    | quality_grants.project_id / request_id / assisted_session_id / access_sequence / expires_at                                        | 按冻结规则清理授权关联或保留最少审计；清理内容前一并撤销本项目所有有效能力，不能只删最新一行而复活旧 grant |
| 运营核验引用                    | quality_requests.assignment_evidence_ref / review_evidence_ref；care_requests.verification_evidence，按 case_id 关联项目           | 按冻结保留规则清理可识别内容；保留最少状态、时间、hash及必要审计事实                                       |
| 售后新稿及确定 PDF              | 仍是既有 book_versions/book_outputs 和 books.storageRoot 下的 object_key                                                           | 复用 Book/PDF 类别清单，遍历所有尝试引用，覆盖新旧稿、临时目录和历史对象                                   |
| 生产地址/物流副本               | 既有 first_copy_addresses / first_copy_orders / fulfillment_attempts / fulfillment_records.evidence，沿 attempt_id/project_id 定位 | 复用生产地址/履约类别，包含质量尝试的冻结副本                                                              |
| 浏览器/小程序临时 PDF、证据显示 | 当前申请/工单及授权截止                                                                                                            | 前端离页、切号、到期与权限失败清理；主动另存及实际印厂副本按原规则分别说明                                 |

`quality_commands` 只保存请求 hash，不嵌入用户正文；`quality_grants` 仅是有期限的授权事实。不得以后向不可清理命令/审计 JSON 塞入新增私人内容。T26 的逐层清理和删除后防复活仍由责任票交付，本文清单不代表已经删除。

## 本地验证

使用本机独立 timenook_t28 数据库、Redis namespace 与显式合成供应商协议；不要使用云连接。

```sh
pnpm db:generate
pnpm db:migrate
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
```

在 apps/api 目录运行真实数据库公开 HTTP 回归，保持 serial 以避免共享本地 PostgreSQL 连接池饱和：

```sh
node --env-file=../../.env --test --test-concurrency=1 dist-test/test/quality-care.test.js dist-test/test/first-copy.test.js dist-test/test/fulfillment.test.js dist-test/test/refunds.test.js dist-test/test/withdrawal.test.js dist-test/test/book-pdf.test.js
```

实际用户/Vben 浏览器流程使用 5198/3480/3483。真实 D06 日历与负责人、D07 各情形/窗口/金额/权益后果、印厂返工及接取消回执、双端临时文件、正式发货与实际收退款均另留证；本票保持 OPEN，售卖和真实资金/生产操作未放行。
