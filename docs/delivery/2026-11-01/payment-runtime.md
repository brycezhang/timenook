# 普通商户业务与通知运行验证

2026-11-01（Asia/Shanghai），关联 [#129](https://github.com/brycezhang/timenook/issues/129)、[PR #131](https://github.com/brycezhang/timenook/pull/131)。本轮启用订单查询与支付/退款通知业务模块，保留内部验收能力。没有创建真实销售、调起付款或发起退款。

## 源码、验证与产物

- PR 最终提交：`a3b8fdda27137b31abaed928ec0d5ecf462ff7dc`；main 合并：`e392d2361983b3d613f50a4fb4a0d05363bcc00e`。
- [最终 PR CI 41290442242](https://github.com/brycezhang/timenook/actions/runs/41290442242) 全绿。使用该运行验证的 Linux 候选包，manifest commit `543edfea5dba7c0dc5defce5a6c9ea32e90f59a5`；候选包 SHA-256：`6f9498a027507da2c3e8de678ce43655a1cfa828c1c9da37e4a6241133e26c19`。候选与 main 合并提交的 Git tree 均为 `c735a4ed21f7e5dbe8e0a8bf4b449571d17e0b13`；没有在 ECS 编译应用。
- 本地相关配置、启动、订单、通知、主动查询和会话隔离共 63 项通过；完整 `refunds.test.js` 20 项通过，包括原先缺少锁定 Chromium 导致不能执行的 PDF 用例。API 类型检查、构建通过。使用真实隔离 PostgreSQL/Redis；外部微信网络替身只在显式测试入口使用。
- 新增普通商户公开 HTTP 用例覆盖签名准备、支付/退款通知验签与解密、金额/身份错配、通知与主动查询共用入账、重复和重启，以及网页关联主体不能准备微信支付。审查发现的网页会话绕过已修复并补回归。

## 实际部署

- ECS：`106.14.11.96`。服务为 `timenook-api.service` 和 `timenook-worker.service`，运行用户 timenook，API 监听 `127.0.0.1:4310`。
- 当前链接：`/data/server/timenook/current` → `/data/server/timenook/releases/20261101-wechat-543edfe`。原 release 为 `20261030-ui-294f2b6`。
- 环境：`/data/server/timenook/shared/.env`，后加载 `.env.internal-acceptance`。受限商户材料保存在 `shared/wechat-pay/`；只写入待启用材料的 `TIMENOOK_WECHAT_PAY_*` 项，保留既有小程序身份和内部验收配置。密钥文件 root:timenook、640，不进入 Git。
- 唯一新增数据库迁移 `20261101090000_ordinary_merchant_orders` 允许 `payment_orders.mode='wechat'`，不改写业务行；目标 Linux 上生成 Prisma Client 并验证原生 `fs-ext` 可加载。
- 17:14:33 重启两个 systemd 服务，均为 active/running、`NRestarts=0`、`ExecMainStatus=0`。启动后日志未观察到 fatal、未捕获错误或服务不可用。

部署审计位于服务器受限文件 `shared/wechat-pay/deployment-20261101.json`，包含 CI、提交、包摘要、release、迁移和变更配置键名，不含密钥值。

## 公网验证

17:18:22 经实际 HTTPS 入口检查：

| 请求                                                    | 结果                                    |
| ------------------------------------------------------- | --------------------------------------- |
| `/api/health/live`、`/api/health/ready`                 | 均 200                                  |
| 无会话 `/api/v1/users/me`、`/api/v1/orders`             | 均 401；订单模块已注册，先前为 404      |
| 无签名 JSON POST `/api/v1/webhooks/wechat-pay/payments` | 400；已进入通知校验，先前未启用时为 503 |
| 无签名 JSON POST `/api/v1/webhooks/wechat-pay/refunds`  | 400；已进入通知校验                     |
| `/admin/`、官网 `/`、网页产品 `/app/`                   | 均 200                                  |
| `/api/v1/web/experience`                                | 200，`mockEnabled=true`                 |

17:31 另经同源 `/api/v1/web` 验证网页内测登录 201、当前会话与本人项目查询 200、退出 204、旧 Cookie 再请求 401。沿用实际网页标记头、Origin 和 CSRF，不输出 Cookie 或账号，不创建项目。结果为 `/tmp/timenook-web-payment-coexistence-20261101.json`。

无资金公网结果保存在操作者本机受限文件 `/tmp/timenook-payment-public-smoke-20261101.json`。通知正确验签、入账与幂等由本轮隔离公开 HTTP 测试验证；公网无效通知拒绝不等同于微信实际到账/退款通知。真实登录下本人订单检查已由严格 `--orders-required` 运行 VSplEt 通过：真实微信登录、当前账号、会话恢复、退出旧会话拒绝、同账号重登、参与及本人订单 200（`available=true`、`required=true`），全部会话撤销、本机清除、SDK 断开与项目关闭通过。证据为 `/var/folders/7t/xgv_t04j7k74jfdhdh1p41tr0000gn/T/timenook-native-live-VSplEt/evidence/result.json`，已复制到主工作区受限的 `.probe-local/wechat-engineering-20261101/`。后续原生冷启动失败仍由 [#130](https://github.com/brycezhang/timenook/issues/130) 处理，不将单次成功泛化为工具稳定性通过。

[#129](https://github.com/brycezhang/timenook/issues/129) 的工程验收已齐并关闭；实际资金条件仍归原责任票。

## 待验收

仍未发生实际资金，不能声明付款、到账、实际支付/退款通知、退款对账或实体权益全链路通过。正式商品准入和 D04–D08 等未知商业参数仍待原责任人决定；普通商户新销售创建继续拒绝。双账号与 iOS/Android 真机、真实采集、目标用户及实物仍按 T06/T10/T27/T29/T30 分别验收。
