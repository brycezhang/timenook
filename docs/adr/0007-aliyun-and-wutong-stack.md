---
status: accepted
date: 2026-10-20
---

# 使用阿里云基础服务，以wutong-admin对齐工程栈

基础设施采用阿里云ECS、RDS PostgreSQL、Tair（兼容Redis）和私有OSS。工程参考wutong-admin的TypeScript / NestJS、Fastify、Prisma、BullMQ/ioredis与Vben，采用ECS/Nginx/systemd及release包交付。

TimeNook使用独立数据、身份与凭据，保留自身授权、版本确认、可靠任务和私有媒体规则。参考工程的版本声明与部署模板作为实施依据，兼容性及运行状态单独验收。

2026-10-22 的 [ADR 0009](0009-shared-ecs-api-path.md) 确定 ECS 与 API 域名复用 legal-agent，通过 `/timenook` 路径分流；独立数据、身份及凭据要求继续适用。

2026-10-25 的 [ADR 0011](0011-shared-oss-and-deepseek.md) 进一步确定共用 deed 的 OSS 配置及 DeepSeek API key，覆盖上述对应资源/凭据的独立要求；其余隔离要求继续适用。配置准备与实际联调分别记录。

同日后续的 [ADR 0012](0012-cloud-integration-database.md) 确定数据库复用 deed 的连接配置并新建 `timenook` 库，客户端保留本地运行，DeepSeek 显式经 Packy 中转。业务分库及应用/队列命名空间隔离继续适用，真实联调与正式验收分别记录。

文件ASR首选豆包（火山引擎），文本模型首选DeepSeek官方API。外部AI经服务端适配器接入；配置、模型版本、处理条款和时延在实施阶段评测锁定，不自动改用未经准入的供应商。

详见[工程基线](../architecture/wutong技术栈对齐.md)和[技术架构](../architecture/技术架构.md)。
