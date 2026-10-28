---
status: accepted
date: 2026-10-28
---

# TimeNook 独立域名入口

TimeNook 与 deed 共用 ECS，API 使用独立域名 `https://timenookapi.threeminreading.com/api/v1`，官网预留 `https://sgl.wootoon.cn`。主机与应用隔离要求见 [ADR 0009](0009-shared-ecs-api-path.md)。项目处于开发阶段，方案直接更新为当前配置，无旧域名、旧路径或开发版本的兼容与迁移要求。

Nginx 将 `/api/` 剥离一次，转发回环端口 4310。以下是统一目标配置，运行结果单独见[域名配置记录](../delivery/2026-10-28/domain-ingress.md)。

| 用途 | 服务内部路径 | 独立域名下的公网路径 |
| --- | --- | --- |
| 用户 API | `/v1/...` | `/api/v1/...` |
| 运营 API | `/v1/admin/...` | `/api/v1/admin/...` |
| 支付通知 | `/v1/webhooks/wechat-pay/payments` | `/api/v1/webhooks/wechat-pay/payments` |
| 退款通知 | `/v1/webhooks/wechat-pay/refunds` | `/api/v1/webhooks/wechat-pay/refunds` |
| 健康检查 | `/health/live`、`/health/ready` | `/api/health/live`、`/api/health/ready` |
| 管理页面 | 静态站点 `/admin/` | `/admin/` |

管理端 `ADMIN_ORIGIN` 为 `https://timenookapi.threeminreading.com`，API 和 Cookie Path 为 `/api/v1/admin`。支付采用普通商户直连，支付与退款通知分别使用上表地址。微信合法域名、用户客户端和受控素材入口按同一 API 域名配置。

公开文档入口拒绝访问。官网尚未开发，当前只预留 DNS/TLS 入口并返回 503。当前云端 release 仍是受控联调版本；管理静态页、同源 API/Cookie、支付通知及书中原声/打印探针入口须按上表完成实现与验证。T29 验收目标部署配置，T30 验收真实项目与实物；域名健康检查只证明对应入口可达。
