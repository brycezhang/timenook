---
status: accepted
date: 2026-10-25
---

# TimeNook 使用独立 OSS Bucket timenook

用户要求 TimeNook 的 OSS Bucket 使用 `timenook`，停止与 legal-agent/deed 混用 Bucket。此决定覆盖 [ADR 0011](0011-shared-oss-and-deepseek.md) 和 [ADR 0012](0012-cloud-integration-database.md) 中的共用 Bucket 部分；地域继续为上海 `cn-shanghai`，现有服务端 OSS AccessKey、DeepSeek 配置及其余联调拓扑继续沿用。

TimeNook 的私有对象保存至 `timenook`，探针保留 `timenook/probe/` 前缀和限时签名。独立 Bucket 不代表 RAM 身份或密钥已经独立；生命周期、CORS 与权限按本项目单独管理。旧 `lawyer-agents` Bucket 继续由 deed 使用，不能为本项目改名或清空。

Bucket 名参与 `storageScope`，有对象或素材记录时须先迁移并核对元数据，不能直接换配置。此次切换前已核实目标 Bucket、旧项目对象前缀及相关素材记录为空；当前运行验证见 [Bucket 切换记录](../delivery/2026-10-25/oss-bucket.md)。
