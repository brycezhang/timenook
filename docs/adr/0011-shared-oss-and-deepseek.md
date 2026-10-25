---
status: accepted
date: 2026-10-25
---

# 与 deed 共用 OSS 配置和 DeepSeek API key

用户确认真实环境继续使用 deed（legal-agent）所在 ECS，OSS 使用同一套配置，DeepSeek 使用同一个 API key。此决定补充 ADR 0009，并覆盖 ADR 0007、0009 及早期规格对 OSS 资源/凭据、DeepSeek 账号/凭据必须独立的要求；TimeNook 的进程、数据库、队列、微信身份和授权记录继续独立。

共用 OSS Bucket 时，TimeNook 对象使用专属前缀，清理只作用于本项目对象；共用配置不允许修改 deed 的对象或生命周期规则。现有云端探针仍要求短期 STS，不能把长期 AccessKey 当作 STS 或伪造过期时间。前缀适配、STS 获取及权限验证仍需工程和真实环境证据，不能由本决策追认完成。

共用资源使配额、费用、密钥轮换和故障相互关联。配置分别保存于服务端私有环境文件，源码只记录变量名和来源；更换共享密钥时须核对两个应用。2026-10-25 仅只读核实服务器并准备本地配置，没有发布 TimeNook 或修改 deed。

当前配置来源与限制见[共用服务配置](../development-shared-services.md)。本轮先做阶段性本地测试；真实微信登录、支付、设备采集及供应商调用暂不执行。

后续同日用户确认云端接口/数据库联调，见 [ADR 0012](0012-cloud-integration-database.md)。共享 OSS 前缀及显式静态凭据模式已实现，并以合成样本验证真实上传/封存/读取；旧段落中的 STS 待项描述的是调整前状态。静态模式不会伪造 STS，有效窗口仍由短期签名限制，最新运行结果见[云端验证记录](../delivery/2026-10-25/cloud-integration.md)。
