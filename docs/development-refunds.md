# 退款申请与原单对账

T27 / [#28](https://github.com/brycezhang/timenook/issues/28) 的隔离本地工程。当前仅沿用 T10 的 `environment=test`、`payments.mode=local-verification` 及显式外部协议替身；没有生产凭据或真实资金入口。D07、真实商户退款能力和双端收退款尚待责任票验收。

## 公开流程

买方从已付款订单打开「退款申请与进展」，申请原因与说明进入共享客服工单。付款账号仅处理自己的订单钱款，不取得讲述者资料授权。小程序查询实付、已退、处理中预留金额和实际进展；退款与内容删除分开。

客服在「客服工单」打开退款申请，核对原购买快照中的固定 D07 金额、申请窗口、权益后果及核验证据，再批准。金额必须与该情形的原销售政策完全相同，不能临时改价。批准和处理期限只起算一次，立即暂停新投产；请求重放不重置期限。

申请资格按服务端收到并持久化的原申请时间与旧政策窗口比较，起点包含、终点不包含；相关使用/投产/交付事实也按原申请时刻判断。及时申请不因客服跨窗口处理而失效。核验时记录原窗口起止，处理期限另从本次核验事实起算；到期只如实显示逾期，不伪造资金终态或释放未知预留，执行和重试均不延长原截止时间。

批准后「执行原退款」才发起原退款单。网络超时、签名无效或字段不符均保留预留及同一商户退款号，后续先查询原单。只有已验签的明确不存在结果及技术重试间隔后，才允许使用原编号和原参数重试；不是另建一笔退款。`PROCESSING` 和 `ABNORMAL` 仍占用金额，已验签的成功或关闭结果才结算或释放。

原交接未知时，不能执行退款。运营先在 T23 生产与物流中核对真实接单/取消回执，再在退款工单记录对应尝试的核验证据；退款工单不能把未知实物手填成成功或取消。退款成功时仍在制作的原单保留已消费事实；稍后确认取消时，按已经冻结的首本取消后果撤销权益，不能重新恢复可用首本。

全部退款均保留原付款事实、订单、项目和原始资料。全额终止、部分退费保留权益、质量赔付按原 D07 分别执行；原书状态不因退款金额自动重置。零元的事实错误校正属于售后处理，不创建金额为零的微信退款。

## 接口与组合

内部用户接口：

- `POST /v1/orders/:orderId/refunds`：`{ reason, evidenceRef }`，携带 `Idempotency-Key`；当前证据格式仅接受 `synthetic:`，真实凭证未开放。
- `GET /v1/orders/:orderId/refunds`：原订单的金额汇总与申请进展，匿名/他人不能查询。

内部运营接口均通过既有飞书管理会话、`care:write`、CSRF 和审计：

- `GET /v1/admin/refunds/cases/:caseId`、`GET /v1/admin/refunds/:id`。
- `POST /v1/admin/refunds/:id/approve`：原政策 `amountFen`、核验证据；平台无法交付还需已核实的 `failureNotifiedAt`。
- `POST /v1/admin/refunds/:id/production-review`：原生产 `attemptId` 和核验证据，只承认 T23 已确定的接单、发货、交付或取消状态。
- `POST /v1/admin/refunds/:id/submit`、`/reconcile`：空对象，复用同一退款单。
- `POST /v1/admin/refunds/:id/reject`：只有尚未提交供应商的请求才可凭证据结束；不能人工解除未知资金的预留。

通知为内部 `POST /v1/webhooks/wechat-pay/refunds`，公网登记路径为 `/timenook/v1/webhooks/wechat-pay/refunds`；退款通知 URL 沿用已核验支付配置的同一域名，只替换确定路径。T29 负责真实代理与平台验收。

T28 可在持有真实买方会话锁的服务端组合中复用 `Refunds.requestIn(tx, orderId, buyerId, key, body)`；审批使用 `approveIn`，后续提交/查询仍走同一执行用例。统一锁顺序为 Session → PaymentOrder → Project；调用者不能先持项目锁再反向申请订单锁。`productionFrozen`、`creationState` 与 `firstCopyCancellationRequired` 是独立于不可变销售快照的商业执行事实。

## 持久性与验证

订单行锁下计算「实收 − 已成功 − 审批/未知/处理中/异常预留」，再原子批准。唯一商户退款号、供应商退款号、命令键和 Inbox ID 由 PostgreSQL 约束。请求和已批准金额/政策/负责人/期限不可改写；回调先持久化已验证事实，再与主动查询共用同一入账路径。API 重启后补扫未处理 Inbox，并查询已提交且长期未终态的原退款；扫描不自动批准未提交的请求。

提交前的管理权限预检不替代资金预留。真正首次提交以及查询原单明确不存在后的重试，在同一订单锁内重新核对当前有效状态、对应批准金额和全单成功/处理中资金总额；已驳回或关闭的申请不能重新占用另一笔申请的预留。领取提交资格会先持久化未知状态，此后不能被人工驳回释放资金。入账也复用当前预留核验。

当前合成政策的使用起点取服务端首次建立采访的事实；已投产起点取不可变 `receipt_accepted` 记录，即使后来确认取消也不抹去历史接单。质量情形使用唯一交付事实。真实 D07 的起算、金额和处理责任仍须冻结并用实际账号验收。

原申请时间、核验时间、原资格窗口和处理截止时间分别保留。增量迁移 `20261026141000_refund_application_window` 不改旧迁移，也不为旧批准伪造窗口证据。时钟与调度控制仅在 `environment=test` 的构造选项可用，开发/生产拒绝覆盖；测试不新增产品 HTTP 或替换退款业务实现。

复现先使用独立本地 PostgreSQL/Redis，安装依赖、生成 Prisma client，准备固定字体；不要把云端连接用于测试。随后在仓库根执行前端与浏览器命令，在 `apps/api` 执行 API 命令：

```sh
pnpm exec tsx --test tests/refund-page.test.ts tests/payment-page.test.ts tests/payment-lifecycle.test.ts tests/payment-purchase.test.ts tests/admin-care-correction.test.ts tests/admin-fulfillment.test.ts
pnpm typecheck
pnpm build
pnpm api:openapi
pnpm check:native
pnpm test:admin-browser tests/admin/refunds.spec.mjs
```

```sh
node --env-file=../../.env --test --test-concurrency=1 dist-test/test/refunds.test.js dist-test/test/payments.test.js dist-test/test/fulfillment.test.js dist-test/test/first-copy.test.js
```

API 命令前用 `pnpm --filter @timenook/api exec tsc -p tsconfig.test.json` 编译测试。浏览器使用独立端口 `5197/3470/3473`，真实 Page/Vben/HTTP/PostgreSQL/Redis；供应商协议为显式合成替身。正式商户、真实资金、平台回调/主动查询、iOS/Android、印厂回执和商业政策的验证结果须另留证。

协议依据已核对[退款申请](https://pay.wechatpay.cn/doc/v3/merchant/4012791903)、[查询单笔退款](https://pay.wechatpay.cn/doc/v3/merchant/4012791904)及[退款结果通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791906)。本地通过不证明商户能力或实际退款成功。
