# T06 · 接通微信登录、会话与账号恢复

GitHub：[#7](https://github.com/brycezhang/timenook/issues/7) · 状态以 GitHub 为准。
阶段：S1

## 交付结果

小程序登录后使用服务端身份访问自己的资源，退出或会话失效时正确恢复；演示模式保留明确隔离。

## 验收条件

- [x] 服务端用微信 code 换取身份，按 AppID/openid 唯一建立账号；不接受客户端自报 openid。
- [x] 签发可撤销不透明会话，仅保存 token 摘要；过期、退出和不同账号访问有可观察的 401/403/404 行为。
- [x] 小程序请求层使用统一契约，登录状态与本机演示资料分离，服务失败不自动回退到模拟购买成功。
- [ ] 通过 HTTP 边界测试会话重放、失效、跨账号和无效微信响应；真实双账号登录记录另行验收。
- [ ] 内部登录使用 `/v1/sessions/wechat`，公网使用 `/timenook/v1/sessions/wechat`；会话查询/撤销保持同一前缀，客户端不重复拼接；正式代理与合法域名在 T29 集中验证。

## 实现边界

沿用已有会话与请求层；微信真实身份由本票验证，正式域名/代理归 T29，不扩展通用多平台账号体系。

## 测试决策

- 覆盖模块：IdentityAccess、小程序会话。
- 主入口：登录/注销 HTTP + 页面生命周期。通用约定见[父规格测试决策](../spec.md#测试决策)。
- 现有范例：[identity.test.ts](../../../../apps/api/test/identity.test.ts)、[session.test.ts](../../../../tests/session.test.ts)、[home-session.test.ts](../../../../tests/home-session.test.ts)；仅作测试方式参考。

## 阻塞依赖

- [T01 · 建立可复现工程与服务健康闭环](01-workspace-health.md)

## 工程前提与外部条件

工程前提：T01 的 API、数据库唯一性及 Redis 测试环境。

真实微信联调需正式 AppID/Secret 与合法域名；本地可用明确测试适配器，生产不能启用。

执行[完成规则](../spec.md#依赖完成规则)与[证据复用](../spec.md#验收复用与唯一归属)；本票勾选与真实状态保持原有证据口径。

## 验收映射

R02、R12。依据：[实施规格](../spec.md)及其中链接的已定稿 PRD/架构/ADR。
