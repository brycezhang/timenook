# B03 生产单人工履约工程记录

范围：[#153](https://github.com/brycezhang/timenook/issues/153)，消费 #151 的真实 Vben 路由和会话以及 #105 的长期服务。本文记录本地工程，未部署，未执行真实印厂、物流或实物验收。

生产单列表在 `/admin/production` 服务端检索生产单、原订单/商户单号、项目、讲述者及书名，按进度、待处理、异常/超期筛选，稳定分页；详情 `/admin/production/:id` 的 id 为 `FirstCopyOrder.id`。保留查询 URL，详情可刷新并通过原订单、用户项目及查询位置连续操作。

复用已锁定、重验当前权限的首本审核、限时授权、确定 PDF/地址读取、人工交接、接单/未知核实、取消及取消失败恢复、实际交付和重印能力。日常表单从已加载的预留书稿建立绑定，不要求输入内部工单 ID 或 hash。下载 PDF 验证 hash 和字节数；地址下载前重新核验本次授权，页面离开、授权到期或拒绝时清除临时地址和文件访问。

新增 `/v1/admin/fulfillment/:id/attempts/:attemptId/printing`，保存 `printedAt`、`printedBy` 与不可改写的 `printing_completed` 记录。接单继续表示 `in_production`；只有独立完成印制事实才显示已生产。发货必须已有完成印制事实并遵守实际时间顺序。各次尝试保留版本、操作人和记录，取消失败沿原尝试及已知实物事实继续。

`/shipping` 只记录实际物流；`/wechat` 独立记录人工核实的 pending/failed/recorded 平台结果，不要求虚构 `implemented_and_verified` 字段。物流和微信结果互不改写。网页及小程序读取同一 `FulfillmentView` 的完成印制、发货及交付事实，长期服务继续独立。

现有 books composition guard 保留：仅显式内部验收或隔离合成配置装配 FirstCopies/Fulfillment，未无条件开放其他能力。内部无支付项目返回明确的不可制作上下文；受控订单 `physicalProduction:false`、候选 PDF、付款金额、D01/D05、印厂 D08 准入及当前授权继续阻止实际制作。没有把 1 分资金验收或候选 PDF 认作实物权益。

迁移 `20261102140000_fulfillment_print_completion` 添加完成印制事实、操作人引用、成对与时间约束及不可改写保护；原版本绑定和删除后的有限实物事实记录规则继续适用。仅在随机隔离的本地测试 schema 执行，未修改现有开发/真实资料库。

本地定向验证：真实 PostgreSQL/Redis 的 fulfillment、first-copy、quality-care HTTP 回归 42/42；新增完成印制、检索分页、仅内容套餐拒绝实物制作的定向验证 3/3；后台交互及共用生产/首本页面 28/28。合约/API 测试编译、网页/小程序类型检查、后台类型检查和生产构建通过。测试只替换外部供应商网络；随机隔离 schema 和 Redis 前缀均按原夹具清理。构建仅有既存的大包非阻塞提示。

最终 HTTPS Chromium 生产浏览器 5/5 通过（35.6 秒），已合入集成分支 `c8e836a` 的 #151/#152 与共用菜单修复：授权 PDF 字节/hash、再次鉴权的地址下载、接单与完成印制区分、实际发货与独立失败的微信结果、取消失败恢复、唯一交付与双方同事实、详情刷新/前后退、列表查询位置返回、窄屏及用户项目内撤回核验均通过；浏览器控制台无错误或警告，未屏蔽菜单告警。

公开装配消费 #152 的[受控组合证据](152-engineering.md)：非测试内部验收组合实际启动，管理/用户履约路由匿名返回 401；同一内部项目的首本条件返回实收 0、不可提交及明确无实物/权益原因，履约返回无生产单。相关断言在 `internal-media.test.ts`，与导出回归合计 9/9。此结果证明当前受控能力装配及业务拒绝，不表示候选 PDF、1 分订单或未冻结供应商取得了实物制作资格。

可复现：仓库根目录执行 `pnpm --filter @timenook/contracts build`、`pnpm --filter @timenook/api exec tsc -p tsconfig.test.json`、`pnpm exec tsx --test tests/production-page.test.ts tests/admin-fulfillment.test.ts tests/first-copy-page.test.ts`、`pnpm run typecheck:frontend` 及后台 typecheck/build；生产浏览器以 `NODE_ENV=test node --env-file=.env.example node_modules/@playwright/test/cli.js test tests/admin/production-shipping.spec.mjs -c playwright.admin.config.mjs` 运行；API 目录下以根 `.env.example` 的 loopback 配置执行 `NODE_ENV=test node --env-file=../../.env.example --test dist-test/test/fulfillment.test.js dist-test/test/first-copy.test.js dist-test/test/quality-care.test.js`。

真实飞书、生产权限分配、公开环境迁移、微信平台处理、印厂交接与实体书验收继续单独记录。
