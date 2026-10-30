# wutong 技术栈对齐与阿里云映射

源码基线：2026年10月20日，本地`/Users/bryce/workspace/wutong-admin`，HEAD `191d438`。以下为源码、依赖声明及部署模板依据，线上版本和运行能力需独立验证。

## 1. 采用哪个参考项目

TimeNook以`wutong-admin`的TypeScript / NestJS、Fastify和Vben为工程基线，采用模块化单体。参考范围包含依赖、目录、公共契约与部署组织。

| 方面         | wutong源码依据                                                                                                                                                                                                                  | TimeNook对齐方式                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 工程与运行时 | [根package.json](/Users/bryce/workspace/wutong-admin/package.json)声明Node≥22.12、pnpm 10.25，使用workspace/turbo                                                                                                               | 后端初始化对齐Node 22系、pnpm 10与workspace约定；补丁版本/维护期/锁文件在开工时核验                      |
| HTTP与校验   | [API依赖](/Users/bryce/workspace/wutong-admin/apps/api/package.json)声明NestJS 11、Fastify 5；[入口](/Users/bryce/workspace/wutong-admin/apps/api/src/main.ts)实际使用FastifyAdapter、ValidationPipe、Swagger、cookie/multipart | 采用NestJS + Fastify、DTO校验、OpenAPI；用户端与管理端各自鉴权，保留TimeNook契约                         |
| ORM与数据库  | API声明Prisma 6；[schema](/Users/bryce/workspace/wutong-admin/apps/api/prisma/schema.prisma)为postgresql；本地compose用PostgreSQL 16                                                                                            | Prisma + 阿里云RDS PostgreSQL，优先评估16系支持规格；迁移/锁/事务语义保持PostgreSQL                      |
| 后台任务     | API声明BullMQ 5、ioredis 5；[书籍导入队列](/Users/bryce/workspace/wutong-admin/apps/api/src/modules/books/books-import-queue.service.ts)实际使用Queue和IORedis；字幕任务另有DB轮询实现                                          | 使用BullMQ/ioredis与阿里云Tair（兼容Redis）；数据库业务任务/Outbox仍是TimeNook事实来源                   |
| 进程         | [worker入口](/Users/bryce/workspace/wutong-admin/apps/api/src/worker.ts)创建Nest应用上下文，并注册停止处理                                                                                                                      | API与Worker同代码库、不同进程；PDF渲染隔离资源                                                           |
| 管理端       | [web-antd依赖](/Users/bryce/workspace/wutong-admin/apps/web-antd/package.json)使用Vben workspace包及antdv-next                                                                                                                  | 采用完整Vben web-antd应用布局、认证页、路由菜单、面包屑、表单、表格、权限与请求层；本项目按用户决定启用多标签页                                   |
| 契约         | [contracts](/Users/bryce/workspace/wutong-admin/packages/contracts/package.json)独立包                                                                                                                                          | 公开DTO/枚举/权限码与OpenAPI客户端契约集中；不共享Prisma实体、云密钥或服务器实现                         |
| 对象存储     | [books.service](/Users/bryce/workspace/wutong-admin/apps/api/src/modules/books/books.service.ts)读取ALIYUN_OSS配置并生成上传授权                                                                                                | 使用阿里云OSS；新小程序按PostObject V4/受限STS设计，不照搬现有后台PUT签名和CDN读取假设                   |
| 交付         | [部署说明](/Users/bryce/workspace/wutong-admin/docs/deployment.md)与templates提供CI构建、SSH release包、releases/current/shared、Nginx、systemd；Dockerfile/compose用于本地开发                                                 | 阿里云ECS + Nginx + systemd管理API/Worker，release包切换/回滚；PDF可用固定容器镜像；不默认建设Kubernetes |

以上版本是参考项目的声明/本地开发配置，不代表本项目已安装、压测或生产部署。Prisma二进制目标、OpenSSL和Chromium/字体必须按TimeNook目标Linux验证，不能直接复制参考项目的运行产物。

2026-10-29 只读复核：wutong 使用应用层 `AuthPageLayout` / `BasicLayout`、路由权限与通用页面，当前关闭多标签页；TimeNook 原实现只保留底层布局等依赖闭包，以按钮变量切页。整体补齐方案与长期服务调整见[重构规格草案](../delivery/2026-10-29/admin-vben-refactor-spec.md)，尚不代表新后台已实现。

## 2. 基础设施与外部服务

| 能力       | TimeNook方案                                             | 需要冻结的参数                                                 |
| ---------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| 计算与网络 | ECS、VPC、安全组；Nginx HTTPS入口；多副本时增加ALB       | 区域、规格、可用区、域名/证书与可用性目标                      |
| 关系数据   | RDS PostgreSQL，Prisma访问，支持日志备份/PITR的规格      | 大版本、规格、连接预算、备份/保留及恢复演练                    |
| 调度与缓存 | 云数据库Tair（兼容Redis），优先评估Redis 7兼容的标准架构 | Lua/阻塞命令/锁续租、noeviction、持久化及故障切换验证          |
| 文件       | 私有OSS，RAM角色/STS，暂存与最终前缀分权                 | Bucket/区域、V4授权、SDK版本、生命周期、版本清理、图片处理费用 |
| 语音转写   | 豆包录音文件识别（火山引擎）                             | 服务资源、模型/API配置、鉴权、口音/采样率、时延/费用与账号开通 |
| 追问与整理 | DeepSeek官方文本API                                      | 具体模型、上下文/输出预算、结构化输出评测与数据处理条款        |
| 观测与凭据 | 云监控/SLS，RAM最小权限与服务端凭据管理                  | 日志脱敏、保存期、告警；密钥或角色凭据只在服务端               |

阿里云承载基础设施，豆包与DeepSeek提供外部AI服务；服务地域、规格、模型和接口配置在实施时冻结。微信登录和支付使用微信官方渠道。

## 3. 对齐的边界

采用相同技术与工程组织，不共享wutong业务数据、用户库、数据库账号、Bucket、队列或密钥。是否共用物理实例必须另做权限、配额、费用与隔离评估；默认使用TimeNook独立资源/身份，生产与测试分离。

保留TimeNook的数据库任务、Outbox、版本确认、授权epoch和删除台账。wutong部分队列用Redis保存短期任务记录，不能原样用来证明原声、支付或生产事实持久化。保留私有素材鉴权网关，不能因参考项目有CDN字段而公开原声或照片。后台登录、飞书集成、业务路由、权限码和支付商户也不直接复制。

## 4. 验证边界

待验收项包括ECS/RDS/Tair/OSS账号配置、内网连通、实际账单、BullMQ兼容性，豆包和DeepSeek联调，真机上传、发布/回滚及打印。外部接入依据见[云服务、AI与微信支付](微信媒体与支付核验.md)，实施顺序见[交付与运维](交付与运维.md)。
