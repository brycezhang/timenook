# 网页微信支付复用可行性：deed / wutong

调研日期：2026-11-07。范围：只读源码与微信支付官方文档；没有读取密钥或 `.env`、查询生产订单、实际下单、支付、退款或修改共享服务。本文件是开发方案依据，不是商户开通或实收验收记录。

## 结论

**可以较快做网页微信支付，但不是把已有按钮接上就完成。建议首版优先复用已有商户、证书配置来源及 TimeNook 自己已有的微信 API v3 订单能力，补电脑 Native 扫码与手机外部浏览器 H5。** 与把 TimeNook 改接远程 Payment-Service 相比，这条路径保持现有订单、通知、退款、项目及首本权益流程，改动更集中。该推荐是基于下面代码缺口的工程判断；实际开通仍取决于商户产品权限、域名和 AppID 绑定。[TimeNook 当前支付适配器](/Users/bryce/projects/timenook/apps/api/src/payments/wechat-pay.ts:119)、[既有支付入账](/Users/bryce/projects/timenook/apps/api/src/payments/orders.ts:570)

wutong Payment-Service 已实现 H5 下单，适合复用设计和参数规则；但当前没有注册的 Native 渠道，微信适配器也未实现其权威查单/关单接口。deed 当前网页支付客户端仅支持支付宝 Page/Wap，不能当成现成微信网页收银台。[渠道配置](/Users/bryce/workspace/payment-service/config/payment.php:46)、[微信适配器](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/YansongdaWechatPayClient.php:19)、[deed 渠道类型](/Users/bryce/projects/legal-agent/packages/domain/src/billing.ts:4)

## 三种浏览器场景

| 场景                                | 支付方式                                          | 对手机号登录的影响                                                   | 本轮判断                                                                |
| ----------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 电脑网页                            | Native，服务端下单取得 `code_url`，前端显示二维码 | 下单无需用户 OpenID；购买项目归发起该订单的 TimeNook 账号            | 可作为首版电脑路径，需核实 Native 权限                                  |
| 手机 Safari / Chrome 等微信外浏览器 | H5，服务端取得 `h5_url` 后跳转微信                | 下单无需用户 OpenID；需正确终端 IP 与 H5 场景信息                    | wutong 有代码先例，需核实 H5 权限与 TimeNook 域名                       |
| 微信内置浏览器中的网页              | 公众号 JSAPI                                      | 需要相应公众号的 OpenID；手机号登录不能替代付款参数中的公众号 OpenID | 另核实公众号、授权域名和支付目录；不能把小程序 OpenID直接用于公众号支付 |

Native 官方下单允许已绑定商户号的小程序、公众号或移动应用 AppID。H5 官方准备流程也支持已认证小程序类型 AppID。因此，前两条路径不必为了网页先建立公众号 OAuth 登录；但现有 TimeNook 小程序 AppID 是否已获对应支付权限，仍未核实。[Native 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)、[H5 接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015614193)

H5 适用手机外部浏览器，不适用微信内置浏览器；使用网站必须配置 H5 支付域名。微信内网页 JSAPI 则要求适用的已认证公众号 AppID、商户绑定和支付授权目录。[H5 产品介绍](https://pay.wechatpay.cn/doc/v3/merchant/4012791832)、[配置 H5 域名](https://pay.wechatpay.cn/doc/v3/merchant/4013287193)、[JSAPI 接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015423216)

## 实际可复用内容与缺口

### wutong Payment-Service

- 已有 `wechat_h5` 注册及 `trade_type=h5`，适配器调用 Yansongda H5 下单，检查终端 IP，并构造 `scene_info.h5_info`。[配置](/Users/bryce/workspace/payment-service/config/payment.php:70)、[实现](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/YansongdaWechatPayClient.php:90)
- **名称不能当能力证明**：名为 `wechat_jsapi` 的现有配置实际指定 `trade_type=app`，调用微信 App 支付；不能拿它直接接微信内网页 JSAPI。[配置](/Users/bryce/workspace/payment-service/config/payment.php:47)
- 没有注册 `wechat_native`。已安装 SDK 的 `ScanShortcut` 引用 Native Pay 插件，因此新增 Native 渠道具有 SDK 基础，但不是服务已有可用入口。[SDK 源码](/Users/bryce/workspace/payment-service/vendor/yansongda/pay/src/Shortcut/Wechat/ScanShortcut.php:14)
- 微信客户端目前只实现“准备支付、退款”的基础接口。通用权威查单和关单要求额外接口，现有微信客户端不满足，会返回渠道暂不支持。因此，直接复用服务仍需补齐这两项以及定向验证。[基础契约](/Users/bryce/workspace/payment-service/app/Domain/Contracts/PaymentChannelClientInterface.php:11)、[权威契约](/Users/bryce/workspace/payment-service/app/Domain/Contracts/AuthoritativePaymentChannelClientInterface.php:10)、[查单要求](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/ReconcilePaymentOrderUseCase.php:35)、[关单要求](/Users/bryce/workspace/payment-service/app/Application/Services/Payment/ClosePaymentOrderUseCase.php:52)
- 现有微信配置只有默认与 miniapp 选择；H5 使用默认配置。TimeNook 若走共享服务，须明确自己 AppID、回调与产品配置的选择，避免把 wutong App 身份或通知地址带入。[配置](/Users/bryce/workspace/payment-service/config/pay.php:62)、[选择规则](/Users/bryce/workspace/payment-service/app/Infrastructure/Clients/YansongdaWechatPayClient.php:224)

### 已有网页调用方

- deed/legal-agent 提供了可参考的 BFF 模式：服务端创建远程支付单、准备支付、按远程单号查询与关闭；内部凭据仅在服务端发送，用户浏览器不接触共享服务凭据。[客户端](/Users/bryce/projects/legal-agent/apps/api/src/payment-service-client.ts:94)、[内部请求](/Users/bryce/projects/legal-agent/apps/api/src/payment-service-client.ts:201)
- deed 在采纳支付结果前核验金额、币种、业务类型、本地订单、产品、渠道与远程订单号。这种绑定校验应保留为 TimeNook 自己的规则，不能仅凭浏览器回跳或远程 `paid` 字段创建项目。[绑定校验](/Users/bryce/projects/legal-agent/apps/api/src/billing.service.ts:340)
- Vue/Nuxt 课程站已写 H5 参数及跳转处理，可参考 `scene_info` 和收银台返回后的状态查询。**该站当前微信入口明确置灰**；旧实现摘要中的 H5 结果来自本地/mock 和 payload 验证，真实商户、收银台及公网通知仍列为待验。因此不能据此声称微信网页支付已经在线成功。[H5 参数](/Users/bryce/workspace/codex-agent-course-fe/apps/web/server/utils/payment-prepare.ts:21)、[入口状态](/Users/bryce/workspace/codex-agent-course-fe/apps/web/pages/checkout.vue:59)、[历史证据边界](/Users/bryce/workspace/codex-agent-course-fe/docs/mvp-implementation-summary.md:26)

### TimeNook 自身

- 已有 API v3 签名/验签、JSAPI 下单、权威查单/关单、退款及退款查询，以及确定金额和项目权益的入账流程，可直接扩展渠道。[支付适配器](/Users/bryce/projects/timenook/apps/api/src/payments/wechat-pay.ts:119)、[查单/退款](/Users/bryce/projects/timenook/apps/api/src/payments/wechat-pay.ts:152)、[通知解密](/Users/bryce/projects/timenook/apps/api/src/payments/wechat-pay.ts:187)
- 目前买方必须拥有本小程序微信身份；网页会话准备真实支付被明确拒绝。新增 H5/Native 需要按真实网页产品账号建立订单，并移除该路径对小程序 OpenID 的硬依赖。[买方识别](/Users/bryce/projects/timenook/apps/api/src/payments/orders.ts:136)、[网页限制](/Users/bryce/projects/timenook/apps/api/src/payments/orders.ts:258)
- 现有回调校验会将返回的付款人 OpenID 与订单内 OpenID 比较。网页 H5/Native 的订单归属应绑定创建订单的产品账号；二维码付款身份不应用于重新决定项目归属。应按渠道调整付款人校验，继续核验商户、AppID、订单号、金额、币种及唯一交易。[绑定规则](/Users/bryce/projects/timenook/apps/api/src/payments/orders.ts:533)

## 两条可执行路线

| 路线                                | 必需工程                                                                                                           | 取舍与粗估                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| A：扩展 TimeNook 直连（推荐先落地） | 新增 H5/Native 下单响应；网页账号订单归属；Vue 手机跳转/电脑二维码；沿用现有查单、关单、通知、退款和唯一权益       | 约 2–4 个开发工作日；不含整站 Vue 重建、商户审核、真实资金验收；保留 TimeNook 单一财务事实源 |
| B：直接调用共享 Payment-Service     | 上述网页 UI；TimeNook 本地订单与远程单映射；补共享服务 Native 注册、微信权威查单/关单与配置隔离；本地确认/退款适配 | 约 4–7 个开发工作日；共享渠道更集中，但跨服务变更和财务映射更多                              |

这些是依据代码范围给出的估算，不是交期承诺。若首次接入公众号网页 JSAPI，还要增加公众号 OpenID 授权与支付目录流程，约增加 1–2 个开发工作日；公众号/商户审核时间单独计算。

走路线 B 时，Payment-Service 已有服务间凭据，可在服务端使用内部调用身份；不需要让 TimeNook 账号变成 auth-service 的全局 JWT 用户。其内部身份目前为 user id 0，TimeNook 必须保留自己的 UUID 账号、订单所有权与业务标识校验，不直接把共享服务用户编号当项目归属。[内部身份](/Users/bryce/workspace/payment-service/app/Http/Middleware/AuthJwtMiddleware.php:25)、[内部订单接口](/Users/bryce/workspace/payment-service/app/Http/Controllers/V1/Payment/PaymentOrderController.php:103)

## 上线前需要核实的实际条件

1. 同一商户下，TimeNook 自有 AppID 的 Native / H5 权限与绑定状态；不能从“小程序能支付”推定另外两个产品已开通。
2. `sgl.wootoon.cn` 的 H5 域名登记、实际经营内容及备案/主体条件；不拿其他站点已经配置的域名代替。[官方域名要求](https://pay.wechatpay.cn/doc/v3/merchant/4013287193)
3. 手机真实终端 IP、H5 跳转、电脑扫码及 iPhone/Android 返回页面行为。前端成功/取消事件只决定展示，最终付款以服务端权威结果为准。
4. 继续使用服务端确定的应付金额和既有上线前金额开关，浏览器不得自选金额。真实资金试单与退款需另行授权执行，本调研未操作。
5. 真实通知与主动查询均只落一次付款事实、一个项目及首本权益；未知结果先查询原单，不能靠重建订单假装成功。
6. 微信内网页是否首版必须原地支付。若必须，则单独完成公众号 JSAPI 条件；H5 不应在微信内强行拉起。此条件未决定，不把未开通渠道伪装为可用。

## 来源快照

本机工作区读取时的 HEAD：TimeNook `3535edc72fb706618d9703d1fb5a94d4a77bf3b9`；payment-service `0278f4833c5bd17814e75976fb7275ea3bcc0a47`；legal-agent `373df45568816ed072c725748394578a718fabf9`；codex-agent-course-fe `ef085d010dc6462f806eb62a3c6445771bdb00e9`。源码可能有未提交改动，以上是定位锚点，不等于运行版本。官方文档按本次浏览日期核对，商户后台实际配置未读取。

## 补充：现有小程序支付能否用于网页

针对用户追问，必须区分“复用商户/订单后端”与“在网页直接调用小程序收银台”：

- **可以复用后端**：商户配置、订单归属、通知验签、查单/关单、退款与付款后创建项目/首本权益继续使用同一套能力。
- **不能直接复用前端调用**：小程序的 `wx.requestPayment` 在小程序原生环境调用，预支付参数要与实际 AppID 和调起场景匹配。微信内置浏览器中的网页是另一种运行环境，不能把小程序参数直接交给网页就完成 JSAPI 支付。[小程序调起支付](https://pay.wechatpay.cn/doc/v3/merchant/4012791898)、[场景匹配说明](https://pay.wechatpay.cn/doc/v3/merchant/4012791910)
- **可把网页作为进入小程序购买的入口**：用户进入小程序后完成原生选购、下单和支付，再回网页查同手机号账号下的项目。这是“在小程序购买、网页继续使用”，不宣称网页已支持原地付款。入口跳转/小程序码、同号账号解析与返回查询仍须实际接通和真机验证。
- **如要求在微信内网页直接付款**：仍须满足公众号 JSAPI 的 AppID、OpenID、支付目录及商户绑定条件。现有小程序已能付款不能证明这些网页条件已经具备。[网页 JSAPI 准备](https://pay.wechatpay.cn/doc/v3/merchant/4015423216)、[JSAPI 下单的 OpenID 要求](https://pay.wechatpay.cn/doc/v3/merchant/4012791856)

当前原生购买页只读取书名/称呼等购买入口信息，并从本机支付意图恢复订单；它没有现成“接收网页订单号继续付款”的外部入口。因此，若选择最小复用路径，网页进入小程序之前不创建另一笔待付订单，由小程序完整下单；若要求从网页已创建的订单继续，则另设计受保护的交接并校验两端账号一致，不能任意把网页订单号放进 URL。[购买入口](/Users/bryce/projects/timenook/miniprogram/pages/purchase/index.ts:48)、[本机支付意图恢复](/Users/bryce/projects/timenook/miniprogram/pages/purchase/index.ts:183)

对微信内来的用户，这条“到小程序购买”路径可作为首版候选；手机外部浏览器若要原地发起网页交易，仍按 H5 场景实现，电脑网页直接扫码则按 Native 场景实现。具体网页跳转小程序方式需另核对官方开放能力与当前账号资格，不能承诺所有浏览器都能无条件一键跳转。

用户要求先保留开发计划草案，暂不发布执行票；本轮没有选定最终支付入口组合，也没有创建订单或变更任何支付配置。
