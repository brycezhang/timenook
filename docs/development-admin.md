# 飞书白名单与独立管理入口

管理员点击“飞书登录”，经飞书授权后直接返回后台。按 [ADR 0016](adr/0016-feishu-admin-login.md)，不再使用时光里密码、TOTP、身份验证器或 MFA；飞书登录也不被描述为已完成 MFA。管理身份、权限、会话和审计独立于小程序及 wutong。

## 管理员及权限

只有已批准并通过受控 CLI 绑定的飞书身份可以登录。服务端检查当前配置的飞书应用、企业及应用内 open_id；同企业、相同姓名、手机号或飞书授权成功均不自动授予权限。不提供自动注册或申请审批后台。

| 权限                  | 允许的业务范围                     |
| --------------------- | ---------------------------------- |
| `ops:read`            | 运行信息及处理任务查看             |
| `audit:read`          | 最近 100 条审计                    |
| `catalog:read`        | 读取运营关系目录和套餐             |
| `catalog:write`       | 编辑关系目录和套餐草稿             |
| `catalog:freeze`      | 受准入约束的套餐冻结操作           |
| `care:write`          | 共享工单、本人权利、校对和退款处理 |
| `fulfillment:write`   | 首本审核、生产尝试、交接与物流     |
| `service-terms:write` | 已购项目服务期限的受控操作         |
| `tasks:retry`         | 在原预算及授权条件内重试任务       |

权限以[共享契约](../packages/contracts/src/admin.ts)为准。零业务权限账号可以登录，但不能执行受限操作。私人内容仍需适用工单、本人限时授权和版本核验；管理员登录或付款不代替本人授权。

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

## 登录与会话

1. `GET /v1/admin/session` 建立或读取匿名/完整会话，并返回登录是否可用和会话绑定 CSRF。
2. `POST /v1/admin/feishu/login` 要求同源 Origin、匿名 Cookie 与 CSRF，返回飞书授权 URL；页面随后导航过去。
3. 服务端回调交换授权码并获取身份，核对企业、应用和白名单，原子消费浏览器绑定的短期 state；采用 PKCE S256。只有该 GET 回调允许跨站顶层导航，其他管理请求保持跨站拒绝。
4. 完整会话与成功审计在同一 PostgreSQL 事务提交后才签发 Cookie，回调仅跳转固定 `/admin/`；错误仅显示固定安全提示。授权码、飞书访问令牌、Cookie 和 CSRF 不写入日志、浏览器存储或后台跳转 URL，不申请/保存飞书 refresh token。

主会话 Cookie 为 `__Secure-timenook_admin`：Secure、HttpOnly、SameSite=Strict、host-only、Path=`/api/v1/admin`。OAuth 回调用独立五分钟 SameSite=Lax Cookie 绑定发起浏览器，防止主 Cookie 因跨站回调未发送而错误放宽整套 Cookie。过期、重放、错浏览器或并发重复回调拒绝。

完整会话最长八小时，不静默续期。匿名/OAuth 流程最长五分钟，配置只能缩短期限。每次访问重验账号、身份绑定、权限及会话；停用、绑定改变、到期或退出后拒绝，页面清理旧身份及私人内容。会话存于数据库，API 重启不自动注销未到期会话。退出需要当前 Origin 和 CSRF；若并发登录已消费旧会话，旧退出不能清除新 Cookie 或宣称新会话已经退出。

Nginx 模板对准确的 OAuth 回调路径关闭含请求行的访问/错误日志，避免记录授权码和 state；服务端审计仍保留固定动作及结果。部署须使用本轮代理配置，不能只更新前端页面。

Redis 提供限流和一次性 OAuth 状态；依赖不可用时不继续登录。成功审计不可用时回滚身份创建；失败审计尽力记录固定动作和安全结果，不影响原有安全响应。审计只记录操作者、动作、服务端 requestId、结果和时间。

## 验证及部署边界

沿用管理 HTTP、真实 PostgreSQL/Redis 和 HTTPS 浏览器验证边界。仅 `environment=test` 的构造入口可替换飞书外部 HTTP；生产及开发不接受替身，也没有环境变量模拟登录。浏览器测试使用实际 CLI、隔离 schema/Redis 前缀和临时 HTTPS，经外部身份替身走完整跳转与真实 Cookie；不读取实际飞书凭据。失败快照、trace 和录屏保持关闭，主动保存的无凭据页面仅位于 `/tmp`。

`pnpm test:admin-browser`、管理端类型/构建及 API 回归提供工程证据；[本轮实施记录](delivery/2026-10-29/admin-feishu-login.md)记录实际结果。真实飞书应用、回调登记、管理员绑定、登录/拒绝/退出、密钥保管、目标环境和进程重启由 T29 留证。已部署的旧版页面及先前 MFA 测试不代表新方案已部署或验收。

官方接口：[获取授权码](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/authorize/get)、[获取 user_access_token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)、[获取用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)。使用当前 v3 token endpoint，供应商访问令牌只用于本次服务端核对身份。
