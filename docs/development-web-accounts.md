# W01 网页内测账号与会话

对应 [W01 #96](https://github.com/brycezhang/timenook/issues/96)；范围为网页入口所需的账号、一次性登录链接、会话及本人项目列表。共用内部 `User`，不创建虚构微信身份；网页与小程序双端确认关联已由 [W02a](development-wechat-link.md) 实现，正式微信配置及真机结果仍待验；无付款内测项目与内容链路由后续票据接入。

## 配置与运行边界

默认关闭。服务端配置 `WEB_ORIGIN`（HTTPS origin，无路径）、`WEB_SESSION_KEY`（随机 32 字节 base64）、`WEB_LOGIN_TTL_SECONDS`（1–900，默认 900）和 `WEB_SESSION_TTL_SECONDS`（1–43200，默认 43200）。目标 origin 为 `https://sgl.wootoon.cn`。这些字段不打包到浏览器；只有 origin 是公开信息。

2026-10-30 用户确认验证期间账号不要过期。显式 `INTERNAL_ACCEPTANCE_ENABLED=1` 时，新登录链接与网页会话不按时间到期，沿用必填日期契约以 `9999-12-31T23:59:59.999Z` 表示；常规模式仍使用上述有界时效。登录链接仍是一次性凭据，消费或撤销后不能重放。已有未过期网页会话在核对当前账号时自动升级，恢复接口同时刷新持久 Cookie，以适应浏览器自身的 Cookie 保留上限。主动退出、撤销会话及会话密钥轮换继续生效；清除浏览器 Cookie 后需要新的未使用登录链接。此决定只适用于内部验证登录，小程序、后台与私人文件授权继续按各自时效执行。

启用网页账号要求已正确装配、初始化的独立隐私台账。按[独立台账说明](development-deletion-ledger.md)配置，运行不自动建立或重置台账；台账失效时私人入口拒绝访问。

W01 的 web-only 装配不会启动 `Deletions` 旧期限后台扫描，也不开放未装配的产品模块；显式维护命令和原有主动撤回／删除规则保持自己的边界。非 test 环境拒绝把 W01 网页账号与旧产品装配同时启用。真实内容链路必须由 W02/W04 的受控运行装配及已确认长期服务改造接续验证，不能据本票声称真实库的录音、AI、PDF或正式售卖已启用。

## 受控命令

先编译 API。命令入口为 `apps/api/dist/web/web-cli.js`，可在已加载服务端配置的受控终端运行：

```sh
node apps/api/dist/web/web-cli.js create --input-file /absolute/private/create.json --output-file /absolute/private/account.json
node apps/api/dist/web/web-cli.js issue --input-file /absolute/private/issue.json --output-file /absolute/private/link.json
node apps/api/dist/web/web-cli.js revoke --input-file /absolute/private/revoke.json --output-file /absolute/private/receipt.json
```

输入必须是当前操作者所有的普通 JSON 文件、权限 600、至多 4096 字节；输出文件必须尚不存在，父目录由当前操作者所有且权限 700。命令拒绝文件符号链接和覆盖已有输出，凭据只写权限 600 的输出文件，标准输出不打印链接。

| 命令 | 输入 | 输出 |
| --- | --- | --- |
| `create` | `{}` | `{user:{id}}`，预建没有微信身份的产品账号 |
| `issue` | `{userId}` | `{ticket:{id,expiresAt},url}`，签发指定内部用户的登录链接 |
| `revoke` | `{ticketId}` | `{revoked:true}`，撤销尚未消费的链接；不代替已建立会话的退出 |

登录链接形如 `https://sgl.wootoon.cn/app/login#ticket=…`，票据只在签发时写明文，数据库保存摘要。该链接是账号登录凭据，与项目邀请及讲述者本人授权分开；通过私下方式交付给对应内测参与者，不粘贴到公开工单、日志或截图。

## HTTP 契约

下表为服务内部路径；同源公网代理使用 `/api/v1/web/...`。所有响应禁止缓存。

| 方法及路径 | 行为 |
| --- | --- |
| `POST /v1/web/session` | 显式提交 `{ticket}`，要求精确 `Origin` 与 `X-Timenook-Web: 1`；原子消费未过期、未撤销且未使用的票据，并撤销请求 Cookie 所指的原网页会话，返回 201 |
| `GET /v1/web/session` | 从 Cookie 恢复当前账号；匿名、过期、已撤销或密钥已变更时 401 |
| `DELETE /v1/web/session` | 要求同源及 `X-CSRF-Token`，撤销当前会话并清 Cookie，返回 204 |
| `GET /v1/web/projects` | 只返回当前创建人／绑定讲述者获准的项目，检查独立拒绝依据、删除和当前共享授权；空列表为 `{projects:[]}` |

登录和恢复的成功 `data` 为 `{user:{id},session:{id,expiresAt},csrfToken}`，不会返回会话令牌。Cookie 为 `__Secure-timenook_web`，使用 HttpOnly、Secure、SameSite=Strict、Path=/api/v1。登录兑换受独立 Redis 来源限流保护；Redis 不可用时拒绝兑换。

账号切换及同账号链接续登都会替换本浏览器原会话，其他设备会话不受影响。原会话撤销与新票据消费、新会话建立在同一事务内；票据无效时保留原会话。只处理格式正确且归属当前网页密钥的网页会话，伪造 Cookie、微信 Bearer 会话和其他网页密钥的会话不作为撤销目标。

已有用户 API 可从该 Cookie 解析到相同内部用户，状态变更要求精确来源、网页意图头及当前会话 CSRF。Cookie 和显式 Authorization 混用被拒绝；管理员、支付通知、探针和微信 code 登录不使用该桥接。既有小程序 Bearer 会话仍按原规则验证，不共享网页 Cookie。

## 工程验证

测试只使用隔离的真实 PostgreSQL schema、Redis 前缀、临时独立台账和合成数据，不访问云端库或真实微信。公开 CLI／HTTP 回归覆盖 14 项：无效链接、签发兑换及恢复、来源校验、原浏览器会话原子替换与其他设备隔离、失败兑换保留原会话、Cookie 伪造／微信会话／网页密钥边界、Cookie 桥接与退出、链接撤销、并发单次消费及重启、限流、过期、跨账号证明隔离，以及 activeData 删除台账生效即停止暴露书名、web-only 启动不触发旧期限清理但显式维护仍有效。

```sh
pnpm --filter @timenook/api db:generate
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
# 在 apps/api 下执行，.env 必须仍连接可丢弃本地服务
node --env-file-if-exists=../../.env --test dist-test/test/web-account.test.js dist-test/test/identity.test.js dist-test/test/ai-config.test.js dist-test/test/oss-config.test.js
```

W01 首轮含 AI／OSS 配置的相关回归 25 项通过；独立审查发现 activeData 删除后的列表遮罩缺口，补充“拒绝依据已提交但私人书名仍在库中”的 HTTP 回归后，网页账号与既有身份相关回归 22 项通过。跨标签页切换账号复审后，补原会话原子替换及拒绝边界的 HTTP RED→GREEN，最新网页账号与既有身份相关回归 25 项通过。API 类型及生产构建通过。W01 实际 HTTPS 浏览器、最终提交 CI 与双轴审查由本票集成记录接续，不以本说明代替目标环境或微信真机验收。
