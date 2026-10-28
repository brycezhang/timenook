---
status: accepted
date: 2026-10-25
updated: 2026-10-28
---

# 与 deed 共用 OSS AccessKey 和 DeepSeek 配置

TimeNook 使用 deed（legal-agent）所在 ECS，共用其服务端 OSS AccessKey 和 DeepSeek 配置。OSS 使用独立私有 Bucket `timenook`，见 [ADR 0013](0013-dedicated-oss-bucket.md)；进程、业务库、队列、微信身份和授权记录独立，联调拓扑见 [ADR 0012](0012-cloud-integration-database.md)。

DeepSeek 通过 Packy 的 `https://cf.api.fan/v1` Chat Completions 接口调用，沿用 deed 的同一 API key；模型、预算、处理条款及业务准入分别确认。配置来源与真实联调结果见[共用服务配置](../development-shared-services.md)。

TimeNook 探针对象使用 `timenook/probe/` 前缀，清理限定于本项目 Bucket 和相应身份。显式静态凭据模式只在服务端签名，上传与取源 URL 分别限时；STS 为可选模式，静态凭据不伪造 STS 到期时间。权限、CORS 和生命周期按 TimeNook 实际环境验证。

共用资源使配额、费用、密钥轮换和故障相互关联。配置分别保存于服务端私有环境文件，源码只记录变量名和来源；更换共享密钥时核对两个应用。

已执行的合成样本真实 OSS 上传、封存、读取与供应商调用见[云端验证记录](../delivery/2026-10-25/cloud-integration.md)；微信登录、支付、真机、业务准入和正式部署仍分别验收。
