# 后台身份、权限与管理入口

## 2026-11-14 渠道录单与第三方账号

有效飞书白名单身份作为超级管理员，新增第三方账号管理。超级管理员可生成、撤销或删除用户名密码账号，第三方登录后唯一业务入口为「录入订单」，服务端授权录入及本人录入记录的查看、更正和作废。手机号是唯一必填业务字段，原订单号、实付金额、付款时间均可选；固定套餐、内部编号、来源账号及录入时间自动记录，界面无店铺字段。

超级管理员查询并处理全量渠道记录，第三方在「录入订单」页查询并处理本人录入记录。手机号更正与录入错误作废均限于建书前，保留操作原因及记录。第三方密码使用带盐的 scrypt 哈希进行登录校验，新生成或重置的密码另用由 `ADMIN_SESSION_KEY` 派生的密钥加密。仅超级管理员可在弹窗查看。旧账号或密钥更换导致无法解密时，可重置后查看新密码，旧密码及会话随即失效。撤销终止访问。删除同时移出账号列表并清除凭据，已录入的有效礼物与历史操作人保留。复用下述会话及请求保护机制，飞书白名单校验继续用于超级管理员身份。

增量依据见 [ADR 0021](adr/0021-channel-gifts-and-partner-admin.md)与[实施规格](delivery/2026-11-14/channel-gifts/spec.md)。功能已本地实现，工程验证见 [CG02](delivery/2026-11-14/channel-gifts/CG02-delivery.md) 和 [CG04](delivery/2026-11-14/channel-gifts/CG04-delivery.md)。目标环境部署与实际飞书、第三方登录分别验收。

## 飞书超级管理员登录

内部管理员点击“飞书登录”，经飞书授权后直接返回后台，使用 [ADR 0016](adr/0016-feishu-admin-login.md) 的白名单身份认证。管理身份、权限、会话和审计独立于小程序及 wutong。

## 管理员及权限

内部人员通过受控 CLI 批准并绑定飞书身份后可以登录。服务端检查当前配置的飞书应用、企业及应用内 open_id；同企业、相同姓名、手机号或飞书授权成功均不自动授予权限。不提供自动注册或申请审批后台。

| 权限                | 允许的业务范围                                        |
| ------------------- | ----------------------------------------------------- |
| `channel-gifts:read` | 超级管理员查询全量渠道记录，第三方查询本人记录 |
| `channel-gifts:write` | 录入渠道记录及权限范围内的建书前更正、作废 |
| `partners:manage` | 超级管理员生成、查看密码、重置、撤销及删除第三方账号 |
| `orders:read`       | 全量订单查询及关联事实                                |
| `orders:write`      | 追加订单内部备注                                      |
| `ops:read`          | 运行信息及处理任务查看                                |
| `audit:read`        | 最近 100 条审计                                       |
| `catalog:read`      | 读取运营关系目录和套餐                                |
| `catalog:write`     | 编辑关系目录和套餐草稿                                |
| `catalog:freeze`    | 受准入约束的套餐冻结操作                              |
| `care:write`        | 用户查询/备注、关联项目服务、本人权利、校对和退款处理 |
| `fulfillment:write` | 首本审核、生产尝试、交接与物流                        |
| `tasks:retry`       | 在原预算及授权条件内重试任务                          |

超级管理员显示订单、用户、生产单及第三方账号菜单。第三方仅显示录入订单，在该页查看和处理本人记录。运行信息、任务、目录和全局审计保留受保护的维护 API。服务端按固定角色解析权限，第三方记录同时按原录入人校验。

用户查询与项目服务的路由、备注和无订单完整导出边界见 [#152 工程记录](delivery/2026-11-02/admin/152-engineering.md)。

用户列表在现有 `care:write` 权限下展示产品账号昵称、账号手机号和编号。没有昵称的账号使用编号作为详情入口，没有手机号时显示「未绑定手机号」。无账号讲述者行展示讲述者姓名和编号。

订单已有退款与质量申请在 `/admin/orders/:id?case=:caseId` 内处理，`caseId` 是共享申请编号，保留原列表查询及生产单返回位置。订单查询使用 `orders:read`，处理使用 `care:write`，原单重印另需 `fulfillment:write`。缺少原销售质量政策时明确不可批准；金额和资金结果仍由原退款用例处理，见 [#154 工程记录](delivery/2026-11-02/admin/154-engineering.md)。

权限以[共享契约](../packages/contracts/src/admin.ts)为准。超级管理员拥有固定平台权限，第三方拥有渠道记录读写权限。私人内容仍需适用工单、本人限时授权和版本核验；管理员登录或付款不代替本人授权。

## 配置与绑定

先执行 `pnpm db:generate`、`pnpm db:migrate`、`pnpm --filter @timenook/api build`。本地使用 Git 忽略且权限 600 的 `.env.admin-local`；实际服务端使用受限部署环境文件。必需配置如下：

| 配置                      | 要求                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `ADMIN_ORIGIN`            | 不带路径的 HTTPS origin；线上为 `https://timenookapi.threeminreading.com` |
| `ADMIN_SESSION_KEY`       | 独立密码学随机 32 字节的 base64 字符串，仅服务端保管                      |
| `ADMIN_FEISHU_APP_ID`     | 复用 wutong 现有飞书应用的 App ID                                         |
| `ADMIN_FEISHU_APP_SECRET` | 对应 App Secret，仅服务端保管                                             |
| `ADMIN_FEISHU_TENANT_KEY` | 获准访问的企业唯一标识                                                    |

2026-10-29 用户选择复用 wutong 已有飞书应用。在同一应用的安全设置中额外登记回调地址 `https://timenookapi.threeminreading.com/api/v1/admin/feishu/callback`，保留 wutong 原地址；每个系统在授权请求中携带自己的 redirect_uri。返回后只进入时光里固定 `/admin/`，不接受任意下一跳。共享应用不共享后台白名单、角色、会话或用户资料；因应用相同可绑定同一 open_id，但仍须单独批准 TimeNook 权限。

仅使用登录所需身份能力，不为登录增加通讯录、手机号、消息或离线访问权限。开发缺少飞书配置时页面显示登录暂不可用；部分配置、非法配置和生产缺失拒绝启动。正式应用回调和实际人员授权不以填入环境变量代替验收。

以安全编辑器在受限目录创建 mode-600 JSON 文件，字段为 `username`、`realm`、`permissions`、`feishuAppId`、`feishuOpenId`、`tenantKey`。`username` 是后台显示标识，3–64 位小写字母/数字/点/下划线/连字符；`realm` 本地为 `local`，生产为 `production`；身份必须与选定飞书应用及企业一致，权限只接受上表白名单。不同应用的 open_id 不能直接互换，不按姓名或手机号匹配。

```sh
pnpm admin:create --input-file /absolute/private/admin-binding.json
```

CLI 拒绝符号链接、错误所有者、组/其他用户可读、超过 8KiB 的文件及重复绑定；只输出建号结果，不输出服务端凭据。禁用管理员使用同一受控 CLI 的 `disable` 命令及仅含 `username`、`realm` 的受限输入文件，撤销其活动会话。生产从已发布 API 目录显式加载生产环境运行命令，不读取本地环境文件。生产身份和测试替身不得混用。

旧经办主体的生产、售后及审计引用不自动建立飞书绑定。使用后台必须单独批准当前飞书身份；数据库约束分别校验超级管理员的完整飞书绑定及第三方的密码哈希。按后续接受的 [ADR0017](adr/0017-lifetime-service-and-retention.md)，开发阶段不提供旧版本兼容、旧库升级或旧备份恢复；固定历史版本恢复用例及专用 `otplib` 开发依赖已退役，当前飞书身份、会话及权限验证继续适用。

## 登录与会话

1. `GET /v1/admin/session` 建立或读取匿名/完整会话，并返回登录是否可用和会话绑定 CSRF。
2. `POST /v1/admin/feishu/login` 要求同源 Origin、匿名 Cookie 与 CSRF，返回飞书授权 URL；页面随后导航过去。
3. 服务端原子消费浏览器绑定的短期 state，使用 App Secret、授权码及与授权请求完全相同的固定 HTTPS 回调在 v3 接口交换令牌，再获取身份，核对企业、应用和白名单。采用最新文档支持的保密客户端授权码模式，授权 URL 与 token 请求都不发送 PKCE 参数，不设协议回退或兼容开关。只有该 GET 回调允许跨站顶层导航，其他管理请求保持跨站拒绝。
4. 完整会话与成功审计在同一 PostgreSQL 事务提交后才签发 Cookie，回调仅跳转固定 `/admin/`；错误仅显示固定安全提示。授权码、飞书访问令牌、Cookie 和 CSRF 不写入日志、浏览器存储或后台跳转 URL，不申请/保存飞书 refresh token。

主会话 Cookie 为 `__Secure-timenook_admin`：Secure、HttpOnly、SameSite=Strict、host-only、Path=`/api/v1/admin`。OAuth 回调用独立五分钟 SameSite=Lax Cookie 绑定发起浏览器，防止主 Cookie 因跨站回调未发送而错误放宽整套 Cookie。过期、重放、错浏览器或并发重复回调拒绝。

完整会话最长八小时，不静默续期。匿名/OAuth 流程最长五分钟，配置只能缩短期限。每次访问重验账号、身份绑定、权限及会话；停用、绑定改变、到期或退出后拒绝，页面清理旧身份及私人内容。会话存于数据库，API 重启不自动注销未到期会话。退出需要当前 Origin 和 CSRF；若并发登录已消费旧会话，旧退出不能清除新 Cookie 或宣称新会话已经退出。

Nginx 模板对准确的 OAuth 回调路径关闭含请求行的访问/错误日志，避免记录授权码和 state；服务端审计仍保留固定动作及结果。部署须使用本轮代理配置，不能只更新前端页面。

Redis 提供限流和一次性 OAuth 状态；依赖不可用时不继续登录。成功审计不可用时回滚身份创建；失败审计尽力记录固定动作和安全结果，不影响原有安全响应。审计只记录操作者、动作、服务端 requestId、结果、时间及适用资源类型/编号；备注正文独立保存，不写入审计。

## 验证及部署边界

沿用管理 HTTP、真实 PostgreSQL/Redis 和 HTTPS 浏览器验证边界。仅 `environment=test` 的构造入口可替换飞书外部 HTTP；生产及开发不接受替身，也没有环境变量模拟登录。浏览器测试使用实际 CLI、隔离 schema/Redis 前缀和临时 HTTPS，经外部身份替身走完整跳转与真实 Cookie；不读取实际飞书凭据。失败快照、trace 和录屏保持关闭，主动保存的无凭据页面仅位于 `/tmp`。

`pnpm test:admin-browser`、管理端类型/构建及 API 回归提供工程证据；[本轮实施记录](delivery/2026-10-29/admin-feishu-login.md)记录实际结果。真实飞书应用、回调登记、管理员绑定、登录/拒绝/退出、密钥保管、目标环境和进程重启由 T29 留证。已部署的旧版页面及先前 MFA 测试不代表新方案已部署或验收。

官方接口：[获取授权码](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/authorize/get)、[获取 user_access_token（v3）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)、[获取用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)。供应商访问令牌只用于本次服务端核对身份。该服务器模式不提供 PKCE 的授权码与 verifier 绑定；浏览器绑定 state、服务端密钥、固定回调、回调禁请求行日志及 no-referrer 均为必须保留的边界。

## 第三方登录与录入接口

`POST /v1/admin/partner/login` 接收用户名密码，沿用匿名会话、同源与 CSRF 校验。超级管理员通过 `GET/POST /v1/admin/partners` 管理账号，`POST /v1/admin/partners/:id/password` 查看密码，`POST /v1/admin/partners/:id/reset-password` 重置密码，`POST /v1/admin/partners/:id/revoke` 撤销账号，`DELETE /v1/admin/partners/:id` 删除账号。凭据响应使用 `Cache-Control: no-store`，查看和修改均校验 Origin 与 CSRF 并记录不含密码的审计。

`GET/POST /v1/admin/channel-gifts` 查询和录入渠道记录，`GET /v1/admin/channel-gifts/:id` 读取权限范围内详情。`POST /v1/admin/channel-gifts/:id/correct` 与 `/void` 分别更正手机号和因录入错误作废，要求操作原因及未建书状态，历史记录按身份脱敏显示。
