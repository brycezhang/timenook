# MP02／MP03 原生购买与领礼夹具

在仓库根目录运行，复用同目录主 README 的 contracts／API 编译准备：

```sh
node --env-file-if-exists=.env docs/delivery/2026-11-11/miniprogram-refactor/evidence/MP12/harness/purchase-api.cjs
```

默认监听 `127.0.0.1:3429`；可用 `TIMENOOK_MP12_PURCHASE_PORT` 改变端口。启动检查占用且仅接受 loopback PostgreSQL／Redis，使用 `book-fixture` 独立随机 schema／Redis 前缀。不会重启 3428、3424、3426。

API 部分复用 MP03 原生 harness 的真实建单、付款回调、发卡、更正与领取流程。通过真实 admin API 发布本地合成套餐；`ordinary-merchant` 模式用于实际原生支付协议及套餐可购门槛，商户签名、支付传输、准入参数和微信身份仍全部为 fixture，不表示真实收费／商户准入。

`test-results/mp12-purchase-native/fixture.json`（目录 0700，文件 0600）提供 `scenes[390]` 和 `scenes[320]` 两套独立业务记录。禁止输出 manifest、手机号、会话令牌或签名。

| 路径 | 用途 |
| --- | --- |
| `purchase.actorCode` | 普通购买账号，支付供应商保持 NOTPAY，可验证取消与待付款 |
| `purchase.interactiveActorCode` | 新订单预支付后约 500ms 自动收到合成签名付款回调，可验证自购直入／赠礼成功 |
| `purchase.newGiftPath`、`selfGiftPath` | 共用真实新购页，必须通过选择关系／输入触发页面状态 |
| `purchase.checkoutPath`、`selfCheckoutPath` | 真实套餐确认页 |
| `purchase.pending`／`unknown`／`ready` | 分别为 NOTPAY、USERPAYING、SUCCESS 的真实查询结果及订单路由 |
| `gift.recipientPath` | 尚未发卡的已付款项目，输入私有 manifest 中的合成收礼手机号 |
| `gift.sharePath`／`openPath` | 已更正重发的第二版卡，可分享／公开打开／验证／明确领取 |
| `gift.invalidPath` | 经真实更正发卡而作废的旧卡 |
| `gift.claimedPath` | 已经真实领取并重复验证仍指向同一项目的卡 |

身份使用 `buyerCode`、`recipientCode`、`wrongCode`，依照主夹具说明让外部 `wx.login` fixture 返回身份码加冒号及随机值。未登录打开 `openPath` 可走 GiftOpen→GiftVerify；错误身份验证得到 GiftMismatch，指定身份得到 GiftAccept，再明确点击领取。`claimedPath` 用指定身份打开得到 GiftClaimed。

允许在设备边界替换 `wx.requestPayment`；使用自动付款身份时将成功回调延迟约一秒，供供应商签名回调到达。所有业务 `wx.request`、登录、查询、发卡和领取继续连接真实 API，不设置页面业务状态。普通身份的设备取消不会产生付款事实。

需要恢复某个未知／待付款订单时，可向 manifest 的 `providerCommandFile` 写入权限 0600 的 `{ "action": "settle", "outTradeNo": "从对应订单场景读取" }`。进程只接受自身供应商已存在的单号，调用现有签名通知 helper，向真实支付 webhook 提交并删除命令文件；客户端仍须查询原单。不直接修改数据库。

2026-11-12 已通过真实 HTTP 校验：可购套餐；两套待付款／未知／成功订单；未领取／不匹配／可领取／失效／已领取礼物；自动签名付款后自购绑定当前账号且重复查询项目不变；私有命令签名回调赠礼入账；manifest 0600。390 的自动付款身份已有一笔协议自检自购订单，后续新购须产生新订单。原生 UI、真实支付与平台／真机结果另验。

结束后向 manifest 的 `pid` 发送 SIGTERM 或启动终端 Ctrl-C，停止供应商循环、等待回调并清理本夹具 schema、Redis、临时文件和 manifest。
