# 网页支付宝复用 deed 调研（2026-11-08）

## 判断

**用户已确定网页首版采用 deed 同方式的支付宝 Page/WAP，由 TimeNook 后端调用现有 payment-service。** 当前共享 Payment-Service 已配置 `alipay_page` 与 `alipay_wap`，且实际选用的 EasySDK 客户端实现了渠道查单、关单；deed 已有服务端创建本地订单、调用共享服务、解析支付宝表单、回站后服务端核对并幂等开通的实现。Vue 无须引入 React，也无须把产品账号改为 auth-service 的数字用户 ID。[渠道配置](/Users/bryce/workspace/payment-service/config/payment.php:90)、[实际客户端](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/EasySdkAlipayClient.php:98)、[deed 订单契约](/Users/bryce/projects/legal-agent/docs/spec-account-billing.md:25)

**后续范围已收窄：首版暂不接支付宝系统退款，不修改 payment-service。** 在沿用现有支付宝应用、渠道和内部调用权限的前提下，现有接口足以接入购买、确认和关单，未发现必须修改共享服务的接口阻碍。需要开发的是 TimeNook 后端订单适配与 Vue 页面；内部令牌只留在后端。本轮仍保留计划草案、不发布执行票，已有微信退款及售后业务规则不由本轮改写。[内部认证](/Users/bryce/workspace/payment-service/app/Http/Middleware/AuthJwtMiddleware.php:25)

当前范围粗略估计：账号和 Vue 基础已就绪、现有支付宝应用及渠道可用时，**购买、确认与关单约 2–4 工程日**。不包含短信账号统一、整站 Vue、系统退款、商户审批等待及真实资金验收。此前 4–7 日包含共享服务退款改造，不再作为本轮范围估计。

## 不改 payment-service 的接入方式

调用链为 `Vue → TimeNook API → payment-service → 支付宝`，无需移植支付服务或修改其全局回跳配置：

1. 创建接口接受自定义 `biz_type` 与 `biz_ref_id`，TimeNook 使用自己的业务类型和本地订单 UUID。[请求校验](/Users/bryce/workspace/payment-service/app/Http/Requests/Payment/CreatePaymentOrderRequest.php:22)、[保存逻辑](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/CreatePaymentOrderUseCase.php:38)
2. prepare 将 `extra` 传给渠道客户端，`extra.return_url` 与 `extra.quit_url` 可逐单指定 TimeNook 返回地址，优先于全局默认值。[参数传递](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/PreparePaymentUseCase.php:68)、[覆盖顺序](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/EasySdkAlipayClient.php:39)
3. 不覆盖 `extra.notify_url`，支付宝通知继续进入共享服务现有入口；TimeNook 后端查询其账本、校验本地订单和付款事实后幂等创建项目，无需新增 TimeNook 支付宝通知入口。[通知配置](/Users/bryce/workspace/payment-service/config/payment.php:90)、[账本查询](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/GetPaymentOrderUseCase.php:18)
4. Vue 只接收经 TimeNook 服务端解析的支付宝 action/fields，提交表单并在返回后恢复原订单；浏览器不接触内部令牌。[deed 调用样例](/Users/bryce/projects/legal-agent/apps/api/src/payment-service-client.ts:120)

本轮不调用支付宝退款 API，也不把支付宝订单送入微信退款适配器。商户应用、通知可达性及对账调度实际运行仍待验收；若必须另用支付宝应用，须重新判断现有单套配置是否满足，不能保证免改。

## 当前代码究竟提供什么

| 能力           | 已有实现及复用方式                                                                                                           | 边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PC 网页收银台  | `alipay_page` → EasySDK `page()->pay()`，使用 `FAST_INSTANT_TRADE_PAY`                                                       | 使用支付宝网页收银台，不另做 TimeNook 二维码支付协议。[配置](/Users/bryce/workspace/payment-service/config/payment.php:90)、[网关调用](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/AlipayEasySdkGateway.php:22)                                                                                                                                                                                                                                                                    |
| 手机外部浏览器 | `alipay_wap` → `wap()->pay()`，使用 `QUICK_WAP_WAY`；支持 return/quit URL                                                    | iOS/Android 外部浏览器跳转、唤起与返回仍需实测。[配置](/Users/bryce/workspace/payment-service/config/payment.php:104)、[网关调用](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/AlipayEasySdkGateway.php:36)                                                                                                                                                                                                                                                                         |
| 表单安全边界   | deed API 用 HTML parser 提取唯一 POST form，校验 HTTPS 支付宝域名，只给前端 action 与 hidden fields；前端用 DOM API 创建表单 | Vue 可直接复用此数据契约与逻辑，不能执行原始 HTML/script。需保留弹窗拦截和返回确认体验。[解析器](/Users/bryce/projects/legal-agent/apps/api/src/alipay-redirect.ts:21)、[前端提交](/Users/bryce/projects/legal-agent/apps/web/src/components/settings/billing-purchase.tsx:327)                                                                                                                                                                                                                          |
| 回站确认       | deed 服务端验证远端订单号、本地订单、金额、币种、业务类型、商品和渠道，再事务开通                                            | return URL 仅导航，前端“支付完成”按钮不是付款凭据。[规格](/Users/bryce/projects/legal-agent/docs/spec-account-billing.md:37)、[匹配检查](/Users/bryce/projects/legal-agent/apps/api/src/billing.service.ts:339)                                                                                                                                                                                                                                                                                          |
| 支付回调       | 实际 Alipay 路由调用官方 SDK `verifyNotify`；后续校验交易号、成功状态、金额及币种                                            | 当前相关路径未见将已签名 `app_id` / `seller_id` 与预期应用、收款主体逐项匹配；接入时须补齐或提供已有等价约束证据。不能把验签本身当作商户归属校验。[实际入口](/Users/bryce/workspace/payment-service/app/Http/Controllers/V1/Payment/CallbackController.php:37)、[验签](/Users/bryce/workspace/payment-service/app/Infrastructure/Callbacks/AlipayEasySdkCallbackHandler.php:20)、[业务校验](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/HandlePaymentCallbackUseCase.php:98) |
| 查单与关单     | EasySDK `queryOrder` 将支付宝成功/关闭状态映射为已付/已关；关单结果不明确时再查单，已付款事实优先                            | 能复用现有渠道适配，不必重写整个支付服务。[查单](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/EasySdkAlipayClient.php:122)、[关单协调](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/ClosePaymentOrderUseCase.php:52)                                                                                                                                                                                                                                     |

官方 Alipay EasySDK 的 [Page 源码](https://github.com/alipay/alipay-easysdk/blob/v2.2.3/php/src/Payment/Page/Client.php#L24)、[Wap 源码](https://github.com/alipay/alipay-easysdk/blob/v2.2.3/php/src/Payment/Wap/Client.php#L24)分别调用 `alipay.trade.page.pay`、`alipay.trade.wap.pay` 并生成 POST 表单。共享服务锁定的正是官方 `alipaysdk/easysdk` 2.2.3，而非仅存在但未配置选用的另一套支付宝客户端。[锁文件](/Users/bryce/workspace/payment-service/composer.lock:172)

### “查询支付状态”的准确含义

deed 的 `getOrder()` 请求 `/internal/0/orders/:orderNo`；这个 GET **读取 Payment-Service 的本地支付账本，不会每次直达支付宝**。账本由验签回调、权威 reconciliation 和关单结果更新。共享服务已有每分钟 reconciliation 的代码调度，调用渠道 `queryOrder`，但本轮未验证部署环境的 Laravel scheduler 实际运行及积压情况。[deed GET](/Users/bryce/projects/legal-agent/apps/api/src/payment-service-client.ts:186)、[GET 用例](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/GetPaymentOrderUseCase.php:18)、[权威核对](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/ReconcilePaymentOrderUseCase.php:35)、[调度定义](/Users/bryce/workspace/payment-service/routes/console.php:19)

因此 TimeNook 的确认页可查询共享账本；若回调漏送，实际收敛取决于权威核对执行，不能把轮询成功 HTTP 响应视为已验证支付宝实时查单。关单不确定时继续保持待确认，不能仅按前端倒计时把仍可付款的订单终结。[关单结果处理](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/ClosePaymentOrderUseCase.php:58)、[deed 过期规则](/Users/bryce/projects/legal-agent/docs/spec-account-billing.md:54)

### 后续接入退款时的缺口（不属本轮）

当前配置中的 `EasySdkAlipayClient::refund` 只传订单号和金额；网关没有传 TimeNook 的 `outRefundNo` 或 `out_request_no`。共享服务每次创建新的随机退款号，在同步调用返回成功后直接标记 succeeded；GET 退款仅查本地记录。已存在的退款接口不能直接证明“超时后不重复退、渠道已退后可恢复本地状态”。[客户端](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/EasySdkAlipayClient.php:83)、[网关](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/AlipayEasySdkGateway.php:43)、[退款用例](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/CreateRefundUseCase.php:58)、[退款读取](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/GetRefundUseCase.php:18)

将来接入系统退款时，需透传 TimeNook 稳定退款请求号并幂等保存，未知结果使用同一请求号查询渠道，再入账并处理权益。官方 SDK 已提供相关能力，但当前适配器未连接；这是后续独立范围，不作为本轮购买接入的前置改造。[TimeNook 退款记录](/Users/bryce/projects/timenook/apps/api/prisma/schema.prisma:447)、[官方退款查询](https://github.com/alipay/alipay-easysdk/blob/v2.2.3/php/src/Payment/Common/Client.php#L490)

## TimeNook 的最小接入边界

1. **保留产品用户 UUID 和手机号验证码会话。** 共享服务的内部令牌认证建立 `user_id=0` 的服务身份；无需给 TimeNook 用户签发 auth-service JWT，也不用让支付宝付款手机号等于登录手机号。购买归属始终由 TimeNook 当前会话的用户 UUID 决定。[内部认证](/Users/bryce/workspace/payment-service/app/Http/Middleware/AuthJwtMiddleware.php:25)、[本地买家](/Users/bryce/projects/timenook/apps/api/prisma/schema.prisma:413)
2. **服务端调用共享支付，产品订单继续归 TimeNook。** 使用自身业务类型、场景、套餐版本和本地订单 UUID 映射远端；不能沿用 deed 的 `deed_entitlement` 或订阅权益规则。金额仍由 TimeNook 的套餐与当前实收规则决定，服务端从分精确转成元字符串。deed 的 internal token 及调用结构可参考，秘密只能留在服务端。[deed 创建映射](/Users/bryce/projects/legal-agent/apps/api/src/payment-service-client.ts:94)、[内部请求](/Users/bryce/projects/legal-agent/apps/api/src/payment-service-client.ts:201)、[TimeNook 金额与套餐快照](/Users/bryce/projects/timenook/apps/api/prisma/schema.prisma:421)
3. **先校验本地所有权，再访问远端。** 内部请求共用用户 `0`，`service_name` 只被记录，当前 GET 依赖远端订单号和 user ID；该服务头不是租户隔离。TimeNook 每次确认、关闭、退款都须校验自己的订单及买家，再核对远端业务类型、订单映射、商品、金额、币种和渠道，不能仅凭远端订单号操作。[内部身份](/Users/bryce/workspace/payment-service/app/Http/Middleware/AuthJwtMiddleware.php:30)、[GET 所有权](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/GetPaymentOrderUseCase.php:18)、[deed 匹配样例](/Users/bryce/projects/legal-agent/apps/api/src/billing.service.ts:339)
4. **给现有订单增加真实渠道差异，复用现有入账与权益流程。** 当前买家读取要求 WeChatIdentity，`self_web` 被 prepare 拒绝，数据库 `appId/openId/merchantId` 仍必填。支付宝需明确 provider/channel 和对应字段，不能伪造 OpenID 绕过；复用 `PaymentTransaction`、`PaymentInbox`、项目与 `FirstCopyEntitlement` 的既有唯一性及退款规则，不另建一套 deed 订阅权益。[当前买家要求](/Users/bryce/projects/timenook/apps/api/src/payments/orders.ts:136)、[网页 prepare 限制](/Users/bryce/projects/timenook/apps/api/src/payments/orders.ts:258)、[订单字段](/Users/bryce/projects/timenook/apps/api/prisma/schema.prisma:415)、[入账与权益](/Users/bryce/projects/timenook/apps/api/prisma/schema.prisma:506)

## 商户、浏览器与实际验收

- **当前是单套支付宝应用配置。** Payment-Service 全局 Factory 从一组 appId、商户私钥和支付宝公钥初始化。若 TimeNook 使用同一收款主体及应用，仍须确认 TimeNook 业务、PC/WAP 产品权限、网站及回跳/通知配置适用；若须独立支付宝应用，现有代码不能通过新增一个业务类型就完成凭据与回调隔离，需要显式按应用选择配置。未查看商户后台，因此不判断已签约或已获准复用。[初始化](/Users/bryce/workspace/payment-service/app/Providers/AlipayEasySdkServiceProvider.php:17)、[PC/WAP 通知与回跳配置](/Users/bryce/workspace/payment-service/config/payment.php:90)
- **微信内置浏览器不列为已支持的原地支付路径。** 现有 deed 仅按移动端选择 WAP，没有本次验证过的微信内支付宝收银台兼容性证据。候选 UX 应明确引导到外部浏览器，保持订单与登录后的恢复入口；不要承诺微信内可直接唤起支付宝。PC、Safari/Chrome/Android 的返回与付款后恢复也需真实设备验收。[deed 渠道选择](/Users/bryce/projects/legal-agent/apps/web/src/components/settings/billing-purchase.tsx:33)
- **已有工程记录不等于真实支付验收。** deed 的 [#251](https://github.com/brycezhang/legal-agents/issues/251) 与共享服务 [#2](https://github.com/threeminread/payment-service/issues/2) 已关闭；本轮当前源码能看到相关实现。但 deed 文档是验收 runbook，要求独立记录 sandbox page/WAP 及 single-grant，不是已经执行的支付凭证。本轮未取得对应已完成的运行记录，未检查线上版本、商户后台、通知可达性、scheduler 进程或真实资金。[证据层次](/Users/bryce/projects/legal-agent/docs/operations-account-paid-release.md:12)、[启用条件](/Users/bryce/projects/legal-agent/docs/operations-account-paid-release.md:289)

## 工作量依据与待决条件

| 范围                     | 粗估          | 依据与验收产物                                                                                                                                                |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 购买、确认与关单         | 2–4 工程日    | 复用现有共享渠道、表单解析与查询/关单；新增 TimeNook provider/远端映射、Vue 购买返回与恢复、接入既有付款入账；定向验证所有权、金额、重复确认及支付/关单竞态。 |

当前不修改 payment-service、暂不接系统退款。接入仍依赖现有支付宝应用/收款主体适用、Page/WAP 渠道和内部调用权限可用，以及通知与对账任务正常运行。商户/应用归属的既有校验边界见上文，本轮未修改或声称已补齐。微信内浏览器单独处理外部打开。商户配置、沙箱与受控付款分别验收；真实退款不属于本轮。

## 调研记录

本轮仅只读检查代码、规格、官方 SDK 和既有 GitHub Issue，未读取 `.env`/秘密值、未创建支付单、未支付退款、未部署、未修改其他应用。源码基线：TimeNook `3535edc72fb706618d9703d1fb5a94d4a77bf3b9`，legal-agent `373df45568816ed072c725748394578a718fabf9`，Payment-Service `0278f4833c5bd17814e75976fb7275ea3bcc0a47`；仓库当前未提交的其他工作不属于本报告。支付宝 SDK 官方源码用于核实 API 能力，不作为商户准入和浏览器兼容承诺。
