---
status: accepted
date: 2026-10-25
---

# 云端接口、独立 timenook 数据库与本地客户端联调

用户确认 API、OSS 和数据库使用 deed 所在的阿里云环境，小程序及网页在本地运行。数据库复用 deed 的连接主机、账号和密码，新建名为 `timenook` 的数据库；这覆盖早期规格对数据库凭据独立的要求，业务数据仍与 deed 分库，Redis 使用 TimeNook 专属键前缀。

受控联调环境使用独立 Linux 用户和 `timenook-api.service`，仅监听回环端口 `4310`；Nginx 将独立域名下的 `/api/` 剥离一次后转发，完整路径见 [ADR 0015](0015-dedicated-domain-ingress.md)。网页使用本地 Vite 代理，小程序本地构建使用公网 HTTPS API 基址。服务器保存凭据，客户端只配置公开地址。

OSS 使用独立私有 Bucket `timenook`，按 [ADR 0011](0011-shared-oss-and-deepseek.md) 和 [ADR 0013](0013-dedicated-oss-bucket.md) 沿用 deed 的 OSS AccessKey。显式静态凭据模式只在服务端签名，所有探针对象限定于 `timenook/probe/`。STS 是可选模式；静态凭据没有虚构的 STS 到期时间，上传及取源 URL 各自限时。

用户进一步明确 DeepSeek 通过 Packy 中转。显式沿用 deed 的 `https://cf.api.fan/v1` Base URL 和相同 Packy key，以 Chat Completions 调用账号可用 DeepSeek 模型；端点参与配置快照及变更校验，防止换地址后复用旧任务。具体模型及输出预算是本次候选参数，业务准入、质量和费用仍分别验收。

真实微信登录和支付继续暂不执行；正式业务 Worker 的准入门禁保持原状。本轮健康、数据库迁移、真实 OSS 和豆包合成语音结果不能替代 T29 正式发布/恢复或 T30 试点验收，详见[联调说明](../development-shared-services.md)及[云端验证记录](../delivery/2026-10-25/cloud-integration.md)。
