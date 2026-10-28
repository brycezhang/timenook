---
status: accepted
date: 2026-10-22
updated: 2026-10-28
---

# 与 legal-agent 共用 ECS，独立部署 TimeNook

TimeNook 使用 legal-agent 所在的阿里云 ECS，应用、数据和身份独立。TimeNook API 使用独立域名，完整入口约定见 [ADR 0015](0015-dedicated-domain-ingress.md)。开发阶段直接按当前配置实施。

[ADR 0011](0011-shared-oss-and-deepseek.md) 确定 OSS AccessKey 和 DeepSeek API key 共用；[ADR 0013](0013-dedicated-oss-bucket.md) 确定 OSS Bucket 独立为 `timenook`。配置分别保存于服务端私有环境文件。

[ADR 0012](0012-cloud-integration-database.md) 确定复用 deed 数据库连接配置、单独建立 `timenook` 库，并将网页/小程序留在本地联调。已部署的受控 API 和正式发布验收分别见[云端记录](../delivery/2026-10-25/cloud-integration.md)与[当前域名记录](../delivery/2026-10-28/domain-ingress.md)。

## 路由与运行边界

API 入口为 `https://timenookapi.threeminreading.com/api/v1`。Nginx 剥离 `/api` 一次后转发 TimeNook 内部 `/v1`；管理页面、通知、Cookie 与健康入口统一按 ADR 0015 配置。T10/T27 验证通知，T29 验证代理、静态资源、Cookie Path、云资源与同机 legal-agent 服务。

TimeNook 使用独立的 systemd 服务、Linux 用户、release/current/shared 目录、环境文件及仅回环监听的端口。初选 API 端口 `4310`，发布前重新检查占用与配置引用。API、Worker 和渲染任务仍分进程，限制 CPU/内存/并发，避免拖累同机 legal-agent。

TimeNook 使用独立用户、会话、AppID、业务库、队列前缀及 Bucket。数据库连接凭据和 OSS/DeepSeek 配置按 ADR 0011–0013 复用；普通商户支付参数来源见[配置清单](../delivery/2026-10-26/manual-inputs.md#2026-10-28-普通商户配置决定)。资源实例、配额与访问权限以实际配置验证为准。小程序合法域名、客户端基址、回调及受控素材入口统一使用 TimeNook 独立域名。

## 当前证据与发布门槛

运行观察见上述带日期的交付记录。T29 发布前检查 Nginx 完整生效配置、端口及服务归属、资源余量和回滚点；发布后分别验证 TimeNook 当前入口、legal-agent 服务、TLS 与鉴权。单台 ECS 是共用故障域，容量与恢复结果须实测。
