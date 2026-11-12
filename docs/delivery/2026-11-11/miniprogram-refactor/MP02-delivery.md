# MP02 统一购买与自购交付

GitHub：[#168](https://github.com/brycezhang/timenook/issues/168)。功能与六张画板的 390px / 320px 原生链路已完成；平台实付另验。

已实现同一送礼入口的爸爸、妈妈、爷爷、奶奶、自己、自定义关系与必填书名。选择自己会给出「我的故事」草稿，用户修改后不因切换关系覆盖；未登录时使用共用登录弹窗并保留草稿。

订单请求新增必填 `purchaseKind: self | gift` 与 `bookTitle`。自购明确提交 `recipient: { typeCode: 'self', relationshipLabel: '自己' }`；自定义文字「自己」不推导自购身份。`payment_orders.purchase_kind` 与原订单快照一起冻结。微信和支付宝均通过 `deliverVerifiedPayment` 在原有事务内初始化一次项目、首本权益、通用大纲与服务条款，同时保存项目书名。自购绑定 `project_subjects.bound_user_id = buyer_id`、`binding_version = 1`，赠礼保持未绑定，供 MP03 指定领取。

原生路由为 `new-book`（NewGift/SelfGift）、`purchase`（Checkout）、`order`（PaymentPending/PaymentUnknown/GiftReady）。付款后自购进入服务端返回的同一项目；赠礼成功入口约定为 `/pages/gift-recipient/index?projectId=…`，由 MP03 提供实际页面。当前套餐金额读取公开套餐，已建订单使用冻结金额；不在页面硬编码设计稿价格。

未确认建单保留同一账号下的请求与幂等键；重进后重放原命令，查询原单后再由待付款页面继续支付。获得订单编号即清除待建单缓存，因此新购不会复用上一单或修改当前书的选择。微信查询增加 `paymentStatus: pending | unknown | paid | closed`；无法确认外部查询时显示未知结果，只有服务端确认已付款才进入成功路径。取消、失败与微信回调均继续核验原订单。

现有网页增加明确的自购选项，传递同一契约；原有支付宝渠道、Cookie/CSRF 与价格展示仍按服务端结果。后台既有查询不需要新字段才能继续工作，类型检查已通过。新增字段是不可变购买事实；关系、书名和讲述者名称继续由现有资料删除登记覆盖，没有新增私人文本载荷。

已执行验证：真实 PostgreSQL/Redis 的微信、支付宝与固定套餐支付回归；小程序页面／支付生命周期／入口回归；Contracts/API、小程序和 Web 类型检查，Admin 类型检查；正式小程序 wcc/wcsc 编译；Chromium/WebKit 现有支付宝购买、返回原单、重复查询与一次建项目路径。支付传输均为隔离替身，没有真实扣款、部署或上传。

## 2026-11-12 原生集成记录

- 使用 37 页 release 构建的隔离副本，仅替换 API 地址。真实 loopback API、PostgreSQL／Redis、套餐及订单命令；微信身份、支付签名与传输、`wx.requestPayment` 设备结果为声明的 fixture，无真实扣款。六张画板的 [390px / 320px 原生图](evidence/MP02/native) 已与参考对照。
- 从「我的 → 送出一份礼物」进入关系表单；选择自己显示「我的故事」，选择爸爸并输入书名后进入真实 ¥999.00 套餐确认。设备取消后读取原订单为 pending；查询 USERPAYING 的原单保持 unknown，不误报付款成功。
- 新赠礼订单收到 fixture 的签名支付回调后，原生查询确认为 paid，再进入收礼人表单，完成 MP03 发卡与领取。另一次自购确认付款后直接进入服务端项目并允许讲述；用户手动输入的书名在关系切换后保留。
- 原生发现的价格小数字号、付款按钮整数格式、关系字色及旧图标颜色/形状已按原设计修正；相关 10 项支付与 5 项礼物测试、前端类型检查及 release 构建通过。修复后的确认购买及支付状态已复采。
- 320px 重跑取消付款、查询未知订单、签名回调后的赠礼与自购闭环。长书名由真实输入框进入确认购买，完整标题保留；滚动时操作区保持可达。修正短屏现有紧凑间距规则被页面样式覆盖的问题，以及原生 input 垂直 padding 导致文字偏下的问题，保留高度、水平内边距和安全区。
- 微信真机手机号授权、微信收银台实付、设备与供应商实际结果另验。

输入框垂直对齐修复后的 320px 已确认；390px 的 NewGift / SelfGift / GiftRecipient 复采因 Mac 再次锁定而待设备切换。旧图与已完成的两宽业务链路分别保留，design-map 未把待复采项标为通过。
