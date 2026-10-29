---
status: accepted
date: 2026-10-29
---

# 后台使用飞书白名单登录，不另设密码或 MFA

用户决定让时光里内部运营通过飞书授权后直接进入后台，不再维护本地密码、TOTP 或身份验证器初始化。用户选择复用 wutong 已有飞书应用，额外登记 TimeNook 回调并保留原回调；参考其飞书身份绑定方式，TimeNook 自行管理管理员白名单、权限、会话和审计；飞书应用的使用不共享 wutong 的后台权限。此决定直接替代现行文档中的密码和 MFA 要求，不保留开发版本兼容入口。

飞书仅证明本次登录身份，不证明完成了 MFA。服务端核对所配置的应用、企业和已授权的应用内用户标识，未知或停用身份拒绝登录。按照用户要求参考 wutong 的服务器授权方式，并使用[最新 v3 文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)支持的保密客户端授权码模式：App Secret 只由服务端持有，固定调用 `https://accounts.feishu.cn/oauth/v3/token`。浏览器授权和服务端交换均不使用 PKCE 参数，不保留旧版本端点、模式开关或自动回退。

授权使用浏览器绑定、短期且一次性的 state，固定 HTTPS 回调；授权码与供应商令牌仅在服务端处理，不申请离线权限或保存 refresh token。此模式由服务端 App Secret 认证客户端，不提供 PKCE 的授权码与 verifier 绑定，不能宣称两种模式具有相同的防护。回调禁止记录含授权码的请求行，并使用 no-referrer。主会话继续使用 Secure/HttpOnly、host-only、SameSite=Strict Cookie，回调使用独立短期 SameSite=Lax Cookie；保留 CSRF、权限重验、退出撤销、限流及事务审计。访问私人内容仍需要适用工单与本人授权。

本次实际联调中，初版 PKCE 请求在 state 有效且浏览器 challenge 与 Redis verifier 的 S256 一致时，v3 token 仍返回 HTTP400/20049；显式声明已授权的身份 scope 后仍复现。该结果不证明飞书内部失败原因。采用上述文档明确支持、与服务器持有密钥相符的保密客户端模式；真实授权成功、拒绝和退出仍须独立留证，不能由协议选择或替身测试代替。

旧管理员只保留为禁用且未绑定的历史经办主体，以保存生产、售后及审计事实；旧凭据和会话失效。新登录通过当前 CLI 单独批准完整飞书身份，数据库拒绝启用缺少绑定的账号。历史恢复测试单独固定所需开发依赖，不能据此恢复旧登录入口或权限。

正式验收改为实际管理员飞书登录、未授权身份拒绝、权限撤销、重启与退出验证；不再要求管理员 MFA。工程验证和实际飞书应用配置、授权范围、管理员绑定及线上验证分别记录，见[实施与验收](../delivery/2026-10-29/admin-feishu-login.md)。
