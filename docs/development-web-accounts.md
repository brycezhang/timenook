# 网页手机号账号与会话

产品网页使用手机号验证码，与小程序按已验证的规范手机号复用同一个 TimeNook User。当前决定见 [ADR 0019](adr/0019-phone-unified-product-account.md)，完整能力与运行证据见[网页 MVP 交付](delivery/2026-11-08/web-mvp-integration.md)。

服务端配置 `WEB_ORIGIN`（HTTPS origin，无路径）、`WEB_SESSION_KEY`（32 字节 base64）、`WEB_SESSION_TTL_SECONDS`（最多 43200，默认 12 小时）及 `ALIYUN_SMS_ACCESS_KEY_ID` / `ALIYUN_SMS_ACCESS_KEY_SECRET` / `ALIYUN_SMS_SIGN_NAME` / `ALIYUN_SMS_TEMPLATE_CODE`。密钥只在 Git 外的服务端环境文件，不使用 `VITE_` 前缀。默认目标源为 `https://sgl.wootoon.cn`，产品入口 `/app/`。

公开 HTTP 路径：

- `POST /api/v1/web/sms-codes`：手机号、当前条款版本；供应商成功才返回挑战 ID，不返回验证码、不建立账号或订单。
- `POST /api/v1/web/session`：挑战 ID、六位码、当前条款版本；一次性消费后签发 Secure/HttpOnly/SameSite Cookie。
- `GET /api/v1/web/session`：恢复当前会话与 CSRF，不重写 Cookie。
- `DELETE /api/v1/web/session`：同源、`X-Timenook-Web: 1` 和有效 CSRF；只撤销对应网页会话。

验证码 5 分钟有效、60 秒重发等待、最多 5 次错误；手机号/IP 限流由 Redis 原子执行，存储 HMAC。小程序先验证微信身份与手机号证明，再使用同一账号解析事务。手机号唯一性、并发建号、归属冲突及昵称保留在真实 PostgreSQL 验证；登录不自动增加项目成员关系。

受保护业务请求沿用 Cookie 网关、当前成员权限、CSRF、版本和幂等约束。前端重验会话，退出/换号使在途结果失效并清理私人媒体；项目失权不转移资料到其他账号。

旧公开内测票据登录、模拟登录/购买及手动微信配对已退出正式运行入口。受限运维夹具保留在隔离测试/内部操作中，不作为用户登录方式，不给正式应用增加绕过验证码的 HTTP 接口。

网页邀请留在网页，微信聊天打开也通过手机号登录后回到邀请并明确接受；小程序分享留在小程序。收到链接或仅登录不自动加入。跨端统一的是产品账号及其成员项目，不是 deed/wutong 的账号或 token。
