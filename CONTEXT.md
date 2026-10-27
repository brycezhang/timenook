# TimeNook 项目上下文

品牌「时光里」，产品「岁月成书」。微信小程序为一位成年讲述者及一位发起人提供分轮语音记录、故事确认及个人故事书制作；999元包含一个项目与一本实体书。

赠礼关系可配置或自定义。产品内置大纲模板，双方可编辑个人章节和问题，讲述者决定回答与入书。核心链路为“录音 → 可靠保存 → 文件转写 → 可选追问 → 故事确认”。

- 产品范围与验收：[MVP PRD](docs/时光里_岁月成书_MVP_PRD.md)。
- 技术方案：[技术架构](docs/architecture/技术架构.md)。原生小程序、Vben Admin、NestJS/Fastify、Prisma/PostgreSQL、BullMQ/ioredis；基础设施为阿里云RDS、Tair、私有OSS与ECS。
- AI服务：文件ASR首选豆包，追问与故事整理首选DeepSeek；模型、服务配置和处理条款经评测与准入核对后锁定。
- 工程基线：[wutong技术栈对齐](docs/architecture/wutong技术栈对齐.md)，参考wutong-admin的工程组织及ECS/Nginx/systemd发布方式。
- 上线参数：[决策与待定项](docs/architecture/决策与待定项.md)。
- 部署入口：与 legal-agent 共用阿里云 ECS 和 `lawyerapi.threeminreading.com`，TimeNook 使用 `/timenook` 前缀；应用、数据及身份独立。目标与已核实状态见 [ADR 0009](docs/adr/0009-shared-ecs-api-path.md)。
- 2026-10-25 配置调整：OSS 使用独立私有 Bucket `timenook`（上海），停止与 deed（legal-agent）混用 Bucket，见 [ADR 0013](docs/adr/0013-dedicated-oss-bucket.md)。OSS AccessKey 与 DeepSeek API key 继续按 [ADR 0011](docs/adr/0011-shared-oss-and-deepseek.md) 沿用 deed 配置；应用、业务数据、队列及微信身份独立。豆包 ASR 配置入口及本地测试边界见[共用服务配置](docs/development-shared-services.md)。
- 当前联调拓扑：API、OSS、数据库在 deed 阿里云环境；数据库复用 deed 连接配置并分库为 `timenook`，网页/小程序在本地运行，见 [ADR 0012](docs/adr/0012-cloud-integration-database.md)。这是受控联调部署，微信登录/支付和正式上线验收仍未执行；实际结果单独见[云端验证记录](docs/delivery/2026-10-25/cloud-integration.md)。
- 业务语言：[GLOSSARY.md](GLOSSARY.md)。
- 2026-10-26 本地工程已推进到 T21：书稿稳定入口可按固定故事版本解析原声，经当前授权网关下载并清理临时播放文件；仍使用隔离合成配置，正式小程序码、双端真机与纸书验收未完成，见[书中原声入口](docs/development-book-audio.md)与[T21证据](docs/delivery/2026-10-22/evidence/T21.md)。
- 2026-10-26 T22 本地实现：双方确认同一书稿/PDF，发起人另确认地址；服务端唯一预留首本权益，审核重验同一条件，到期进入共享人工工单。仅验证隔离合成政策与规格，真实付款、商业参数、真机和实际生产仍待验收，见[首本制作](docs/development-first-copy.md)与[T22证据](docs/delivery/2026-10-22/evidence/T22.md)。
- 2026-10-26 T23 本地实现：固定生产尝试与交接编号，本人限时授权 PDF/地址，未知接单保持待核实，确认接单才消费权益；人工记录取消、物流及唯一交付事实。仅用于隔离合成验证，实际印厂、物流和微信发货管理仍待验收，见[人工交接与物流](docs/development-fulfillment.md)与[T23证据](docs/delivery/2026-10-22/evidence/T23.md)。
- 2026-10-26 T25 本地实现：本人明确选择接收人、共享工单核验受理、完整 ZIP/来源与版本清单、固定下载期限及到期/孤儿包补扫。仅验证隔离合成政策，真实 D03/D06/D08、双端交付与 T24 活动流组合仍待验收，见[完整资料导出](docs/development-complete-export.md)与[T25证据](docs/delivery/2026-10-22/evidence/T25.md)。
- 2026-10-26 T24 本地实现：撤回先提交用途拒绝与可恢复联动记录，终止活动私有下载并联动任务/生产，双方可查询最少处置进度；账号换绑保留主体与历史。仍为隔离合成验证，真实本人核验、印厂取消与双端清理待验，见[撤回与活动访问](docs/development-withdrawal.md)与[T24 证据](docs/delivery/2026-10-22/evidence/T24.md)。
- 2026-10-26 T27 本地实现：买方申请与共享退款工单、原销售 D07 固定金额/权益、订单锁预留、稳定退款单号、通知 Inbox 与原单查询共用入账；未知资金保留预留，生产未知先核实，退款不删除资料。仅验证隔离合成政策与微信协议，真实商户/退款、双端和正式政策待验，见[退款流程](docs/development-refunds.md)与[T27证据](docs/delivery/2026-10-22/evidence/T27.md)。
- 交互原型：[原型说明](design/figma-prototype/README.md)。

当前已有原生小程序演示前端及浏览器预览；demo 模式使用本机数据、父母二选一和静态题库。T08 已接入 live 动态赠礼目录、套餐缺参草稿与不可变本地预览，仍不可购买；真实参数与正式售卖未验收。已实现范围与验证见[前端说明](docs/frontend/README.md)。架构文档不代表后端、云资源或平台审核已完成。

2026-10-22 MVP 实施收敛：采用一份固定首版政策，生产复用受控探针能力，运营采用共享工单与受控人工流程；见 [ADR 0010](docs/adr/0010-mvp-fixed-policy-and-reuse.md)。具体商业值仍须负责人冻结。

2026-10-22 MVP 模板调整：后端内置一套固定大纲，跳过运营模板管理与多模板选择/切换；个人计划仍可编辑，详见 [ADR 0008](docs/adr/0008-single-builtin-template.md)。

T01 已增加 pnpm workspace、NestJS/Fastify 健康 API、Prisma 初始迁移和本地 PostgreSQL/Redis 检查；业务闭环仍未实现。执行命令和验证边界见 [本地开发](docs/development.md)，票据见 [实施清单](docs/delivery/2026-10-22/README.md)。
