# TimeNook 项目上下文

品牌「时光里」，产品「岁月成书」。微信小程序为一位成年讲述者及一位发起人提供分轮语音记录、故事确认及个人故事书制作；999元包含一个项目与一本实体书。

赠礼关系可配置或自定义。产品内置大纲模板，双方可编辑个人章节和问题，讲述者决定回答与入书。核心链路为“录音 → 可靠保存 → 文件转写 → 可选追问 → 故事确认”。

- 产品范围与验收：[MVP PRD](docs/时光里_岁月成书_MVP_PRD.md)。
- 技术方案：[技术架构](docs/architecture/技术架构.md)。原生小程序、Vben Admin、NestJS/Fastify、Prisma/PostgreSQL、BullMQ/ioredis；基础设施为阿里云RDS、Tair、私有OSS与ECS。
- AI服务：文件ASR首选豆包，追问与故事整理首选DeepSeek；模型、服务配置和处理条款经评测与准入核对后锁定。
- 工程基线：[wutong技术栈对齐](docs/architecture/wutong技术栈对齐.md)，参考wutong-admin的工程组织及ECS/Nginx/systemd发布方式。
- 上线参数：[决策与待定项](docs/architecture/决策与待定项.md)。
- 部署入口：与 legal-agent 共用阿里云 ECS 和 `lawyerapi.threeminreading.com`，TimeNook 使用 `/timenook` 前缀；应用、数据及身份独立。目标与已核实状态见 [ADR 0009](docs/adr/0009-shared-ecs-api-path.md)。
- 2026-10-25 配置调整：与 deed（legal-agent）共用 OSS 配置和 DeepSeek API key；应用、数据库、队列及微信身份仍独立。此项覆盖旧文档对这两项凭据独立的要求，见 [ADR 0011](docs/adr/0011-shared-oss-and-deepseek.md)。豆包 ASR 配置入口及本地测试边界见[共用服务配置](docs/development-shared-services.md)。
- 当前联调拓扑：API、OSS、数据库在 deed 阿里云环境；数据库复用 deed 连接配置并分库为 `timenook`，网页/小程序在本地运行，见 [ADR 0012](docs/adr/0012-cloud-integration-database.md)。这是受控联调部署，微信登录/支付和正式上线验收仍未执行；实际结果单独见[云端验证记录](docs/delivery/2026-10-25/cloud-integration.md)。
- 业务语言：[GLOSSARY.md](GLOSSARY.md)。
- 交互原型：[原型说明](design/figma-prototype/README.md)。

当前已有原生小程序演示前端及浏览器预览；demo 模式使用本机数据、父母二选一和静态题库。T08 已接入 live 动态赠礼目录、套餐缺参草稿与不可变本地预览，仍不可购买；真实参数与正式售卖未验收。已实现范围与验证见[前端说明](docs/frontend/README.md)。架构文档不代表后端、云资源或平台审核已完成。

2026-10-22 MVP 实施收敛：采用一份固定首版政策，生产复用受控探针能力，运营采用共享工单与受控人工流程；见 [ADR 0010](docs/adr/0010-mvp-fixed-policy-and-reuse.md)。具体商业值仍须负责人冻结。

2026-10-22 MVP 模板调整：后端内置一套固定大纲，跳过运营模板管理与多模板选择/切换；个人计划仍可编辑，详见 [ADR 0008](docs/adr/0008-single-builtin-template.md)。

T01 已增加 pnpm workspace、NestJS/Fastify 健康 API、Prisma 初始迁移和本地 PostgreSQL/Redis 检查；业务闭环仍未实现。执行命令和验证边界见 [本地开发](docs/development.md)，票据见 [实施清单](docs/delivery/2026-10-22/README.md)。
