# 微信身份配置、真实登录与商户关联验证

2026-11-01（Asia/Shanghai）。用户通过私密文件交接 AppSecret，授权同步及微信登录测试，随后确认已关联商户并要求验证。关联 T06 #7、T10 #11、T27 #28、T29 #30；本轮为配置与运行验证，未关闭票据。

## 配置与运行环境

- 小程序 AppID：`wxa54f81265fba2439`。本机交接文件为根目录 `.env.wechat-local`，权限 600，受 `.gitignore` 排除；密钥、登录 code、OpenID、会话 token 与预支付标识均不进入本文或 Git。
- 目标 ECS：`106.14.11.96`。本机 SSH 别名 `ali-prod-01` 当前指向另一主机，本轮使用明确的目标 IP 连接。
- 服务端环境：`/data/server/timenook/shared/.env`，root:timenook、640。只原子更新 `TIMENOOK_WECHAT_APP_ID` 和 `TIMENOOK_WECHAT_APP_SECRET`；后加载的 `.env.internal-acceptance` 没有覆盖这两项。
- 活动 API：`timenook-api.service`，用户 timenook，回环 `127.0.0.1:4310`。实际 release 为 `/data/server/timenook/releases/20261030-ui-294f2b6`，manifest commit 为 `294f2b679beeb771cc49c5285ed356208d0a1b50`。
- 在当前 release 上预先执行 `readConfig`，成对身份配置通过。微信 `stable_token` 校验成功，返回有效凭据及 7200 秒有效期；只记录成功与时长，不输出或保存返回的 access token。
- 15:50:32 重启 `timenook-api.service`，API 为 active，`NRestarts=0`；本机 readiness 为 200/ready。Worker 保持 active，本轮未重启 Worker，未替换代码、数据库或 Nginx。

## 公网检查

基址：`https://timenookapi.threeminreading.com`。

| 检查                                     | 实际结果                                                       |
| ---------------------------------------- | -------------------------------------------------------------- |
| `/api/health/live`                       | 200，ok                                                        |
| `/api/health/ready`                      | 200，ready                                                     |
| 无会话访问 `/api/v1/users/me`            | 401，UNAUTHENTICATED                                           |
| 无效 code 调用 `/api/v1/sessions/wechat` | 401，UNAUTHENTICATED；身份模块已接入微信，不再因缺配置返回 503 |
| `/api/v1/recipient-types`                | 200                                                            |
| `/api/v1/packages/current`               | 200                                                            |
| `/admin/`                                | 200                                                            |
| 未启用支付时调用支付、退款通知入口       | 均为 503，SERVICE_UNAVAILABLE                                  |

## 原生开发者工具与真实微信身份

使用官方微信开发者工具 2.01.2510290 及 `miniprogram-automator` 0.13.0。测试源码为现有 `codex/miniprogram-e2e-blank` 工作树 commit `a2ac809`；以公开 HTTPS API 基址重新构建 26 个原生页面，复制到独立临时项目，`urlCheck=true`。没有注入 `wx.login` 或 HTTP 替身，也没有打开麦克风或调起支付。测试调用真实页面登录/退出方法及真实 `wx.request`；已通过原生界面确认“已连接服务端账号”。

| 行为                               | 实际结果                                                                |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `wx.login` → 公网会话交换          | 成功，页面为 live、登录完成、busy=false                                 |
| 使用签发会话访问 `/users/me`       | 200，返回当前登录账号                                                   |
| 使用签发会话访问 `/participations` | 200，当前测试账号项目列表为空                                           |
| 无会话访问 `/users/me`             | 401                                                                     |
| 重新进入首页恢复会话               | 恢复同一服务端账号，busy=false                                          |
| 页面退出登录                       | 本机会话清除，页面显示已退出登录                                        |
| 使用已撤销会话再次请求 `/users/me` | 401                                                                     |
| 再次真实微信登录                   | 回到同一账号，签发不同会话                                              |
| 订单列表 HTTP/页面                 | `/orders` 为 404；原生页面结束 loading 并显示“服务暂不可用，请稍后重试” |

开发者工具冷启动时曾停留在欢迎画面，重新编译后业务界面正常。订单页后的参与页面 UI 跳转检查未完成：固定延迟曾读取到旧页面，改为等待实际路由后，后续独立项目冷启动又出现模拟器无响应提示。因此只将表中已观察到的单项计为通过，不将整套原生 E2E 计为通过。已完成轮次的清理步骤撤销仍缓存的测试会话；最后停止无响应轮次并关闭临时项目。脱敏单项结果保存在 Git 忽略且权限 700 的 `.probe-local/wechat-verification-20261101/` 中（文件 600）。开发者工具单账号测试不代替双账号、iOS/Android 微信真机、录音/上传/回听及真实采集验收。

## 普通商户关联及不扣款验证

在同一 ECS 上，读取 TimeNook 独立受限目录 `/data/server/timenook/shared/wechat-pay/` 的待启用材料，单独调用已发布的 `readOrdinaryMerchantConfig` 和 `WechatPay`；不启动另一业务应用或改变活动支付模式。使用的是普通商户，商户号尾号 `2255`；小程序身份取自本轮真实微信登录在数据库中建立的唯一身份记录，OpenID 只在服务器内存中处理。

| 检查                                           | 实际结果                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| 商户私钥、证书与平台验签材料                   | 当前配置校验通过，商户私钥与证书匹配                                     |
| 签名查询不存在的诊断订单                       | 微信返回 404/ORDER_NOT_EXIST，响应验签通过                               |
| TimeNook AppID + 商户 + 本次真实登录身份预下单 | `POST /v3/pay/transactions/jsapi` 返回 200，取得预支付标识，响应验签通过 |
| 诊断金额                                       | 1 分人民币，仅生成未支付订单；未调用 `wx.requestPayment`，未付款         |
| 查询诊断订单                                   | 200，NOTPAY；AppID、商户和金额匹配，响应验签通过                         |
| 关闭诊断订单                                   | 204，响应验签通过                                                        |
| 再次查询                                       | 200，CLOSED，响应验签通过                                                |

这组实际结果证明当前小程序、普通商户与登录身份可用于微信 JSAPI 预下单。未支付查单不要求返回 payer，故不把返回值中缺失的付款人字段误记为付款人匹配通过；微信[查询订单文档](https://pay.wechatpay.cn/doc/v3/merchant/4012791900)说明该字段在支付成功后返回。预下单与关闭接口依据微信[小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)、[关闭订单](https://pay.wechatpay.cn/doc/v3/merchant/4012791901)文档。

诊断单号与脱敏结果保存在服务器受限文件 `shared/wechat-pay/verification-20261101.json`；未在 TimeNook 业务库创建销售订单或发放权益。预支付标识与支付参数未交给客户端，诊断订单已关闭。

## 配置阶段的装配观察与验收边界

本记录最初验证时 API 后加载 `.env.internal-acceptance`，使用内部验收装配；当时已发布代码要求 `config.acceptance` 存在时不能同时启用 `config.payments`，仅在支付配置启用时注册 `OrdersController`，故观察到订单列表 404 和支付/退款通知 503。同日后续 [PR #131 与部署](payment-runtime.md) 已解决该装配问题，普通商户订单和通知现已启用；本节保留配置阶段的历史观察，当前状态以新运行记录为准。

本轮已验证身份配置、单账号真实登录/恢复/退出/重登，以及微信端签名预下单、查单和关单。尚未执行实际付款、到账、支付/退款通知入账、真实退款、正式商品准入或双端真机验收。后续真实付款必须使用支持普通商户支付的业务装配和适用准入参数，不能把本次诊断预下单当成完整收退款验收。
