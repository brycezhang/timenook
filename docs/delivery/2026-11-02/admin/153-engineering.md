# B03 生产单人工履约工程记录

范围：[#153](https://github.com/brycezhang/timenook/issues/153)，消费 #151 的真实 Vben 路由和会话以及 #105 的长期服务。本文记录本地工程，未部署，未执行真实印厂、物流或实物验收。

生产单列表在 `/admin/production` 服务端检索生产单、原订单/商户单号、项目、讲述者及书名，按进度、待处理、异常/超期筛选，稳定分页；详情 `/admin/production/:id` 的 id 为 `FirstCopyOrder.id`。保留查询 URL，详情可刷新并通过原订单、用户项目及查询位置连续操作。

复用已锁定、重验当前权限的首本审核、限时授权、确定 PDF/地址读取、人工交接、接单/未知核实、取消及取消失败恢复、实际交付和重印能力。日常表单从已加载的预留书稿建立绑定，不要求输入内部工单 ID 或 hash。下载 PDF 验证 hash 和字节数；地址下载前重新核验本次授权，页面离开、授权到期或拒绝时清除临时地址和文件访问。

新增 `/v1/admin/fulfillment/:id/attempts/:attemptId/printing`，保存 `printedAt`、`printedBy` 与不可改写的 `printing_completed` 记录。接单继续表示 `in_production`；只有独立完成印制事实才显示已生产。发货必须已有完成印制事实并遵守实际时间顺序。各次尝试保留版本、操作人和记录，取消失败沿原尝试及已知实物事实继续。

`/shipping` 只记录实际物流；`/wechat` 独立记录人工核实的 pending/failed/recorded 平台结果，不要求虚构 `implemented_and_verified` 字段。物流和微信结果互不改写。网页及小程序读取同一 `FulfillmentView` 的完成印制、发货及交付事实，长期服务继续独立。

现有 books composition guard 保留：仅显式内部验收或隔离合成配置装配 FirstCopies/Fulfillment，未无条件开放其他能力。内部无支付项目返回明确的不可制作上下文；受控订单 `physicalProduction:false`、候选 PDF、付款金额、D01/D05、印厂 D08 准入及当前授权继续阻止实际制作。没有把 1 分资金验收或候选 PDF 认作实物权益。

迁移 `20261102140000_fulfillment_print_completion` 添加完成印制事实、操作人引用、成对与时间约束及不可改写保护；原版本绑定和删除后的有限实物事实记录规则继续适用。仅在随机隔离的本地测试 schema 执行，未修改现有开发/真实资料库。

定向验证结果在最终交付时补齐。真实飞书、生产权限分配、公开环境迁移、微信平台处理、印厂交接与实体书验收继续单独记录。
