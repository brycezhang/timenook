# MP02 统一购买与自购交付

GitHub：[#168](https://github.com/brycezhang/timenook/issues/168)。当前为工程契约里程碑，六张画板的原生截图仍待开发者工具串行窗口；不据此关闭票据。

已实现同一送礼入口的爸爸、妈妈、爷爷、奶奶、自己、自定义关系与必填书名。选择自己会给出「我的故事」草稿，用户修改后不因切换关系覆盖；未登录时使用共用登录弹窗并保留草稿。

订单请求新增必填 `purchaseKind: self | gift` 与 `bookTitle`。自购明确提交 `recipient: { typeCode: 'self', relationshipLabel: '自己' }`；自定义文字「自己」不推导自购身份。`payment_orders.purchase_kind` 与原订单快照一起冻结。微信和支付宝均通过 `deliverVerifiedPayment` 在原有事务内初始化一次项目、首本权益、通用大纲与服务条款，同时保存项目书名。自购绑定 `project_subjects.bound_user_id = buyer_id`、`binding_version = 1`，赠礼保持未绑定，供 MP03 指定领取。

原生路由为 `new-book`（NewGift/SelfGift）、`purchase`（Checkout）、`order`（PaymentPending/PaymentUnknown/GiftReady）。付款后自购进入服务端返回的同一项目；赠礼成功入口约定为 `/pages/gift-recipient/index?projectId=…`，由 MP03 提供实际页面。当前套餐金额读取公开套餐，已建订单使用冻结金额；不在页面硬编码设计稿价格。

未确认建单保留同一账号下的请求与幂等键；重进后重放原命令，查询原单后再由待付款页面继续支付。获得订单编号即清除待建单缓存，因此新购不会复用上一单或修改当前书的选择。微信查询增加 `paymentStatus: pending | unknown | paid | closed`；无法确认外部查询时显示未知结果，只有服务端确认已付款才进入成功路径。取消、失败与微信回调均继续核验原订单。

现有网页增加明确的自购选项，传递同一契约；原有支付宝渠道、Cookie/CSRF 与价格展示仍按服务端结果。后台既有查询不需要新字段才能继续工作，类型检查已通过。新增字段是不可变购买事实；关系、书名和讲述者名称继续由现有资料删除登记覆盖，没有新增私人文本载荷。

已执行验证：真实 PostgreSQL/Redis 的微信、支付宝与固定套餐支付回归；小程序页面／支付生命周期／入口回归；Contracts/API、小程序和 Web 类型检查，Admin 类型检查；正式小程序 wcc/wcsc 编译；Chromium/WebKit 现有支付宝购买、返回原单、重复查询与一次建项目路径。支付传输均为隔离替身，没有真实扣款、部署或上传。

待完成：六张画板在 390px/320px 开发者工具的真实入口与交互截图；MP03 领取入口的联合走通。微信真机手机号授权、微信收银台实付、设备与供应商实际结果另验。
