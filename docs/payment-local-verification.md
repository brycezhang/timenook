# T10 本地付款与期限验证

T10 当前只交付隔离合成验证。正式销售仍关闭：T05 的真实准入与商业值、独立小程序 AppID/OpenID、T08 可售套餐和 T09 内容审校未验收。合成 RSA/AES 报文、测试登录、期限天数和浏览器截图均不能作为真实收款证据。

## 运行入口

使用仓库锁定的 Node 22 / pnpm 10，先按本地开发约定准备 Git 忽略的 `.env`，只配置本机 PostgreSQL/Redis。不要在命令输出或证据中打印连接凭据。

```sh
pnpm db:generate
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api test
pnpm test:frontend
pnpm test:admin-browser
```

API 测试及浏览器测试自行创建随机 PostgreSQL schema、执行迁移，并在退出时清理 schema 与自己的 Redis 前缀；不迁移 public。浏览器测试 `tests/admin/payment.spec.mjs` 是可执行的完整本地演示夹具：启动真实 API、HTTPS 管理后台和小程序预览，使用合成供应商网络验证付款、项目恢复及客服暂停/恢复。先运行 API 测试以编译它消费的测试夹具。

后端没有可通过环境变量打开的收款开关。`createApplication` 仅在 `environment: test`、显式 `payments.mode: local-verification`、AppID 与身份模块一致、配置合格且注入非全局 fetch 的测试传输时启用。生产环境拒绝这类配置；默认关闭时历史合成订单也不能通过订单、客服、通知或 Inbox 扫描继续处理。不要将测试传输包装真实网络，也不要填入真实商户私钥。

小程序可选验证入口须同时满足 `TIMENOOK_PAYMENT_VERIFICATION=local-verification` 和 `TIMENOOK_API_BASE_URL` 为 `http://127.0.0.1[:port]/v1` 或 `http://localhost[:port]/timenook/v1` 等本机地址。该入口清楚标注“本地合成付款验证”；页面只执行合成订单流程，不把假签名传给 `wx.requestPayment`。默认构建保留“暂未开放购买”。浏览器夹具已设置这些变量，无需改源码。

## 公开接口与恢复

- `POST /v1/orders`：认证买家创建固定 99900 分/CNY 订单。金额、AppID、openid 来自服务器；套餐、关系与模板快照被冻结。需要 `Idempotency-Key`，同载荷重放原单，冲突返回 `IDEMPOTENCY_CONFLICT`。
- `GET /v1/orders`、`GET /v1/orders/:id`：只读当前买家、当前 AppID/商户/本地 realm 的订单；按原商户号查询恢复，付款结果与通知共用入账事务。付款不代表讲述者同意。
- `POST /v1/orders/:id/payment`：准备支付参数；未知结果先查原单。缓存参数过期后，只有查到原单未付才按原参数与原单号重新准备。一次 `ORDER_NOT_EXIST` 不生成替代订单。
- `POST /v1/orders/:id/close`：关单并核验供应商结果；付款与关单竞态保留已核验付款事实。
- 通知内部路径 `/v1/webhooks/wechat-pay/payments`，普通商户正式部署目标为 `https://timenookapi.threeminreading.com/api/v1/webhooks/wechat-pay/payments`，见 [ADR 0015](adr/0015-dedicated-domain-ingress.md)。本地合成夹具的地址只用于复现当前测试；正式参数读取、通知地址配置和真实公网/商户回调尚待实现与验收。

验签使用原始 HTTP body，按受信 `Wechatpay-Serial` 选公钥；供应商 204 空体也验签。回调先验签、解密、核对应用/商户/订单/总金额/币种/成功事实，持久化 Inbox 后才返回 204。业务激活由有限批次扫描恢复；Inbox 内只保留核验所需事实，恢复不重新套用 HTTP 五分钟签名时窗。单次激活事务按订单→项目→权益锁定，一次提交付款、项目、subject、冻结默认计划、首本权益和服务期限。网络不在事务中。

首页“查看订单与恢复项目”进入实际订单页，可恢复多个订单和各自的项目/首本权益；退出重进继续同一订单。购买意图在请求前按账户/接口保存，未知创建结果仍重放同一键。账号和页面切换丢弃旧响应。native 成功、取消、失败、超时均查询服务端的行为由 `wx` 公开边界测试验证；本票没有真实微信调起记录。

## 冻结期限和人工运营

`ProjectServiceTerms` 是供下游调用的可信服务端模块，不能直接接受用户申报事实：

- `activate(transaction, projectId, packageVersionId, snapshot, paidAt)` 在入账事务里冻结 D02/D03。
- `recordFact({ projectId, eventId, kind, occurredAt }, transaction?)` 仅消费所选首版规则需要的 `subject_participation` 与 `delivery_completed`。调用方必须完成真实授权/交付核验，事件时间、唯一事实、重放冲突由本模块约束。
- `read(projectId)` 给出制作、回听、导出申请、各类保留期和未开始处理的共同判定；事件未发生不开始计时。`export_ready`、`processing_completed` 对应保留期保持未起算，等待下游实际交付这些功能，不能据此宣称自动删除已实现。

当前只识别一份合成固定政策形状：本人参与开始制作，暂停停止制作时钟且有累计上限，上限后恢复计时；交付开始回听与导出申请期限。天数取冻结测试套餐，并非 T05 商业决定。未支持或未决定的政策返回 `pending`，不能当作真实期限；付款或后续套餐更新不会延长原快照期限。制作到期、未参与需联系/核验退款选项均只给共同判定，不执行退款或删除。

后台“服务期限”是必要的最小操作表单：查询项目，填写现有共享工单 `record:...` 引用，暂停/恢复。接口复用 AdminAccess 会话、`service-terms:write` 权限、CSRF、Idempotency-Key、同事务审计，不新建工单系统。引用的业务依据由现有共享工单人工核验，系统不虚构跨系统证明。桌面/手机断点沿用既有 Vben 重建布局，切换后重新输入项目并查询服务器状态即可恢复；已提交命令仍受服务端幂等及状态约束。

## 待真实验收

独立 AppID、微信合法域名/身份与商户绑定、正式商品/政策/模板、真实支付通知与主动查单、真实微信取消/超时、反向代理公网路由及真机均未验收。不得据本地通过开启正式销售或关闭原生依赖。下一票本地实施须在固定提交、独立审查和工程交付完成后按依赖规则推进；真实收款和上线仍待外部验收。固定版本提交及独立双轴审查由交付主 Agent 完成。
