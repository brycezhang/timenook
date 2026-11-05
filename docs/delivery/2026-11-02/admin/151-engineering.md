# #151 Vben 入口与订单查询备注（本地工程）

2026-11-02：实际接入上游 Vben BasicLayout/AuthPageLayout、Vue Router、权限菜单、面包屑、多标签和 Page，只有订单、用户、生产单三个入口。保留飞书 Cookie/CSRF/白名单/审计，无密码或 MFA。用户与生产入口现明确显示暂未开放，后续 #152/#153 接入操作；已有售后事实显示在订单内，#154 接入处理。

## 查询与备注契约

- `GET /v1/admin/orders`：`orders:read`；`q`（最多 200 字，订单号/订单 ID/购买账号/项目/讲述者主体或绑定账号/姓名/书名）、`state=pending|paid|closed`、`pending=true|false`、`page`（1 起）、`pageSize`（默认 20，最多 100）。返回 `{items,total,page,pageSize}`，按创建时间、ID 倒序，全数据库查询。
- `GET /v1/admin/orders/:id`：`:id` 是 PaymentOrder.id；标价、应付和 PaymentTransaction 实收、成功退款金额均为分。包括各退款/质量申请、首本权益、生产单 ID、购买人/讲述者/项目、备注和最近 100 条本单后台操作记录。退款成功状态消费已有 `succeeded`，不覆盖原付款事实。
- `POST /v1/admin/orders/:id/notes`：`orders:write`、Origin、CSRF 和 `Idempotency-Key`；`{content}` 为 1–2000 字。相同经办人/订单/key/正文只追加一次，不同正文复用 key 返回 409。正文不进入审计；操作人、时间和关联由服务端生成，备注及审计同事务提交。
- `admin_audit` 增加可选 resourceType/resourceId；订单动作按 `order`/PaymentOrder.id 记录。后续订单售后命令可设置同一请求上下文以纳入本单操作历史。
- 路由：`/admin/orders`、`/orders/:id`；`/users/:id` 是产品账号，`/users/projects/:projectId` 是项目，`/production/:id` 使用 FirstCopyOrder.id。详情 `from` 查询只接受本应用已允许的业务路径，返回列表恢复原查询/分页。

新增数据库变更为 `20261102120000_admin_order_queries`。实际角色需显式授予 `orders:read`/`orders:write`；用户/生产菜单分别沿用 `care:write`/`fulfillment:write`。不包含角色编辑页或旧权限映射。

## 本地证据与边界

- HTTP + 随机隔离真实 PostgreSQL schema/Redis 前缀：121 条订单搜索翻页；999 元标价/1 分收款/1 分成功退款；项目与讲述者关联搜索；并发备注唯一、重复 key 冲突、CSRF/越权拒绝、API 重启、权限撤销和退出拒绝。
- HTTPS Chromium 实际管理 API：登录与回跳、七页历史订单、搜索/详情/备注、独立 URL 刷新、关联跳转、返回查询、404、受限账号 403、真实会话停用清理、Secure/HttpOnly/Strict Cookie 及 390px 窄屏。
- `access.spec.mjs` + `orders.spec.mjs` 12/12 通过；导航/窄屏修正后 `orders.spec.mjs` 2/2 再通过。API 订单与现有登录定向回归 20/20；admin/API 类型与 admin build 通过。仅替换外部飞书身份网络，不读取真实管理员凭据。截图在 Git 外 `/tmp/timenook-admin-implementation/151-{login,desktop,mobile}.png`。
- vendored 11 个上游源码依赖包来自只读 wutong-admin `191d4388690ba2298d3b93fb5c929a5adcc761a2`，无应用业务或私有配置复制，MIT 与适配记录保留。

本记录为本地工程结果，不表示真实飞书、生产角色配置、线上深链路、真实资金或实物完成本票验收；实际部署与组合验收由协调线程另记。
