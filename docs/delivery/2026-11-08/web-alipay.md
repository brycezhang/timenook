# WV07 网页支付宝购买

2026-11-08 本地实现。TimeNook 后端调用现有 payment-service；未修改共享服务、商户应用或其他产品，不接系统退款。Vue 购买、支付宝 POST 表单、返回查询和真实项目交付已实现。部署、商户配置、支付宝资金与真机验收由后续运行记录单列。

## 当前可操作路径

登录后 `/app/purchase` 输入书名、主人公及关系，桌面使用 `alipay_page`、移动外部浏览器使用 `alipay_wap`。服务器先保存当前账号的本地订单与冻结套餐，再准备远端订单；只返回已解析的 HTTPS 支付宝 action 和 hidden fields，浏览器用 DOM 创建 POST 表单，不执行原始 HTML/script。回跳地址固定使用服务端网页 origin 的 `/app/purchase/return/:orderId`。

返回页查询本人订单；共享支付账本确认已付且核对业务类型、本地 UUID、商品版本、远端单号、渠道、金额、币种和结算时间后，复用既有订单锁、付款事实、项目成员及唯一首本权益交付。回跳参数和“我已完成付款”按钮不证明已付。重复或并发确认返回同一项目。未付可继续付款或关单，未知结果保留待确认；支付与关单竞态以核实付款为准。微信内显示在外部浏览器打开的引导，保留当前购买/订单链接。

## 服务端配置

- `TIMENOOK_ALIPAY_ENABLED=1`：启用网页订单接口。
- `PAYMENT_SERVICE_BASE_URL`：现有共享支付服务 HTTPS 基址。
- `PAYMENT_SERVICE_INTERNAL_TOKEN`：共享服务内部调用令牌；仅后端使用。
- `TIMENOOK_ALIPAY_E2E_AMOUNT_FEN`：留空时实际收款固定为 99900 分，并只接受当前正式套餐。用户另行授权的验收可设 `1`，同时须 `INTERNAL_ACCEPTANCE_ENABLED=1`，只接受现有 e2e 套餐并沿用 `physicalProduction:false`。页面仍显示标价 999 元。小程序 `TIMENOOK_CHECKOUT_E2E_ENABLED` 不改变支付宝实收。
- `WEB_ORIGIN`：沿用网页会话配置，作为逐单回跳的固定 origin；不得由浏览器提供任意回跳 URL。

新增迁移 `20261108090000_web_alipay`：支付渠道与 provider 明确保存，支付宝不伪造微信 OpenID，远端单号在付款提交记录唯一保存。微信退款通过原有 provider/scope 检查拒绝支付宝订单，微信通知/恢复扫描按原微信 AppID、商户和 mode 隔离。

## 验证与运行边界

定向 HTTP 测试使用独立真实 PostgreSQL schema、Redis 和仅支付服务网络替身，覆盖网页无微信身份买家、规范金额、CSRF、所有权、PC/WAP、字段关联拒绝、安全表单、并发单次项目/首本交付、未知结果与关单竞态、丢失远端创建响应不重复下单，以及独立 1 分验收配置。既有小程序支付回归、API 编译/构建和 Vue 类型检查/构建同时验证。

共享服务 GET 读取其账本，实际状态收敛依赖原有验签通知与 scheduler reconciliation。已有服务没有按业务关联幂等创建/查找接口；若远端创建响应丢失，本地保留原提交为未知，不盲目创建第二远端单，需运行侧核对共享账本。当前解析和账本核对不补造共享服务尚未实现的应用/收款主体回调校验；商户应用适用、通知、scheduler 和 Page/WAP 真机路径仍须运行验收。此记录没有声称实际付款、退款或实体书权益验收。
