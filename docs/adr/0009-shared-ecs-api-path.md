---
status: accepted
date: 2026-10-22
---

# 与 legal-agent 共用 ECS 和 API 域名，以路径分流

用户决定 TimeNook 使用 legal-agent 所在的阿里云服务器及同一 API 域名，以 path 区分。此决定替代实施规格中“独立 ECS”及交付文档中的首版两台计算节点假设；应用、数据、身份与凭据继续独立。

2026-10-25 补充：[ADR 0011](0011-shared-oss-and-deepseek.md) 确定 OSS 配置和 DeepSeek API key 共用，覆盖本文相应独立要求；本 ADR 的路由、应用进程、数据库、队列及微信身份边界继续适用。

同日后续的 [ADR 0012](0012-cloud-integration-database.md) 确定复用 deed 数据库连接配置、单独建立 `timenook` 库，并将网页/小程序留在本地联调。本轮已部署的受控 API 和正式发布验收分别见[云端记录](../delivery/2026-10-25/cloud-integration.md)。

## 路由与运行边界

公网基址采用 `https://lawyerapi.threeminreading.com/timenook`。业务 API 使用 `/timenook/v1/...`，健康入口使用 `/timenook/health/live` 与 `/timenook/health/ready`。Nginx 只对 `/timenook/` 前缀剥离该前缀后转发至 TimeNook；服务内部对应 `/v1/...` 和 `/health/...`。既有 legal-agent 的 `/v1/...` 与其他路由保持原状。

2026-10-22 规格复核统一接口命名；下表为目标契约，支付/退款通知仍待对应票据实现。现有登录与管理 API 已分别采用内部 `/v1` 与 `/v1/admin`。

| 用途 | 服务内部路径 | 公网路径 |
| --- | --- | --- |
| 用户 API | `/v1/...` | `/timenook/v1/...` |
| 运营 API | `/v1/admin/...` | `/timenook/v1/admin/...` |
| 支付通知 | `/v1/webhooks/wechat-pay/payments` | `/timenook/v1/webhooks/wechat-pay/payments` |
| 退款通知 | `/v1/webhooks/wechat-pay/refunds` | `/timenook/v1/webhooks/wechat-pay/refunds` |
| 健康检查 | `/health/live`、`/health/ready` | `/timenook/health/live`、`/timenook/health/ready` |
| 管理页面 | 静态站点 `/admin/` | `/timenook/admin/` |

API 代理只剥离一次 `/timenook`；管理页面由独立静态站点提供，静态资源及客户端 API 基址均保留公网前缀。T10/T27 验证通知地址，T29 验证代理、静态资源、Cookie Path、OpenAPI 和既有 legal-agent 路由。这份表替代旧接口文档的路径命名，不证明目标路由已部署。

TimeNook 使用独立的 systemd 服务、Linux 用户、release/current/shared 目录、环境文件及仅回环监听的端口。初选 API 端口 `4310`，发布前重新检查占用与配置引用。API、Worker 和渲染任务仍分进程，限制 CPU/内存/并发，避免拖累同机 legal-agent。

共用主机和 TLS 入口不代表共用用户、会话、AppID、商户配置、数据库账号、队列或 Bucket。RDS/Tair/私有 OSS 的隔离及访问要求沿用 ADR 0007；资源实例及配额以实际配置验证为准。小程序合法域名按同一域名配置，客户端基址、回调及受控素材入口必须带 TimeNook 前缀。

## 当前证据与发布门槛

2026-10-22 只读核实：域名解析到 `106.14.11.96`；legal-agent API/Worker/Web 及 Nginx 运行中；公网 `/v1/health` 返回 200 且 TLS 校验通过。当前 Nginx 的该域名入口转发至 `127.0.0.1:4300`，未发现 TimeNook 路由。旧 `lawyer-be.service` 已非当前运行服务，后续操作以实际 `legal-agent-*` 服务为准。

本 ADR 记录目标与只读观察，不表示 TimeNook 已部署、容量已足够或业务联调已通过。T29 发布前检查 Nginx 完整生效配置、端口及服务归属、资源余量和回滚点；变更后分别验证 TimeNook 前缀、legal-agent 既有路径、TLS、鉴权与服务状态。单台 ECS 是共用故障域，容量与恢复结果须实测。
