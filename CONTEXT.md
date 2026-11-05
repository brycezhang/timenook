# TimeNook 项目上下文

2026-11-05 最新产品/设计规则：品牌改为「时光故事」，两个 Tab 为「岁月成书 / 我的」。购买和受邀参与统一为「项目」；微信邀请接受后直接拥有完整项目功能，取消身份审核与同机协助。资料用途、退款/质量售后、资料与服务统一纳入使用条款，登录或接受邀请即接受，后续不重复确认且不设相关菜单。录音结束自动上传，仅向用户显示上传结果；项目成员可直接提交当前书稿印刷，不再要求讲述者本人/双方确认或手写说明。按 [ADR 0018](docs/adr/0018-project-members-and-simple-printing.md) 和 [当前设计规则](designs/timenook-senior-2026-11-05/project/BUSINESS-FLOW.md) 执行，覆盖下文较早记录中的冲突规则。本轮仅完成设计及文档，小程序/API/正式条款尚未重构；实际运行验收另记。

2026-11-02 用户要求评估无必要则删除：原 #85 的自动合并队列/原子串行互斥属于非 MVP 核心流程建设，已删除，不作为后续必做项。沿用现有合并入口、必要 CI 和人工避免同时合并的操作约定；不新增统一合并协调系统，不修改现有 CI/分支权限。当前 open 仅 #1 总规格和 #69 营销官网正式小程序入口。

2026-11-02 MVP 范围收敛：支付无权益、Outbox 滞留、任务费用、错版/访问及工单超时的自动告警，以及跨业务全链路日志串联，不列入 MVP 必需交付，也不作为 #30 的关闭条件。MVP 使用已有健康检查、进程日志、业务状态及必要审计支持人工核查和受控维护；支付幂等/权益一致性、Outbox 恢复、授权检查、确定版本与错版阻止、额度约束和服务时限继续执行。此调整移除运维增强要求，不宣称已实现自动告警或完整追踪。 #30 按功能交付完成关闭；目标环境配置、真人/设备及实物仍按实际结果分别记录。

2026-11-02 issues/分支清理：用户明确逐票区分功能缺失和待实际验收。功能已交付的票据关闭，逐票留言真实设备、内容审校、供应商或实物待验；只因实际验收未完成不再维持 open。功能仍缺失的继续保留；父规格随未交付功能保留。产品网页端暂停后续对齐，原 #95 范围退出当前队列；营销官网 #69 的正式小程序入口缺口另列。处理记录见[本轮清理](docs/delivery/2026-11-02/issue-branch-cleanup.md)。

品牌「时光里」，产品「岁月成书」。微信小程序为一位成年讲述者及一位发起人提供分轮语音记录、故事确认及个人故事书制作；999元包含一个项目与一本实体书。

项目处于开发阶段，方案调整与文档、记忆更新按[工程约定](AGENTS.md)执行。

赠礼关系可配置或自定义。产品内置大纲模板，双方可编辑个人章节和问题，讲述者决定回答与入书。核心链路为“录音 → 可靠保存 → 文件转写 → 可选追问 → 故事确认”。

- 产品范围与验收：[MVP PRD](docs/时光里_岁月成书_MVP_PRD.md)。
- 两端分步讲述：2026-10-29 用户确认手机网页端与小程序统一选题、录制（暂停继续）、回听提交、保存处理／可选追问及故事确认流程，保留既有授权和版本规则；网页与落地页同域 `sgl.wootoon.cn`，首版用于内部验收、账号简化、无网页真实收款。规格与工程进度见[统一流程规格](docs/delivery/2026-10-29/mobile-web-spec.md)和[实施票据](docs/delivery/2026-10-29/mobile-web-tickets.md)，尚未完成实际运行验收。
- UI 梳理：2026-10-30 用户确认本轮交付可点击高保真方案与实施清单，延续纸张、宋体、橄榄绿；[设计提案](docs/frontend/ui-review-2026-10-30.md)和[原型说明](designs/timenook-ui-2026-10-30/README.md)覆盖网页与小程序核心流程及 25 条原生路由清单。第二轮按用户反馈将故事确认改为单按钮、选题操作分行、保存／文字处理改为代码支持的状态卡（无百分比或按时完成）；第三轮将资料用途入口简化为一句说明与「确认并开始」，详情折叠，点击后一次确认四项用途并进入录音准备。正式前端与操作证据适配待实施。方案尚待其余页面评审；本轮没有修改业务前端或部署，不作为真实录音、微信设备、授权、付款或实物验收。
- 长期服务：2026-10-29 用户确认制作、回听、下载及必要资料保留长期有效，移除服务期限配置/计时/到期审核及按服务期限自动清理；必填日期仅用 `2099-12-31` 占位，用户端不显示倒计时。主动撤回/删除、安全授权有效期、D06 人工时限和 D07 售后窗口分别保留，见 [ADR 0017](docs/adr/0017-lifetime-service-and-retention.md)。这是已定方案，现有期限与清理实现仍待替换验证。本次开发重构直接硬更新，可重建相关开发数据/夹具，不做旧数据迁移、历史期限兼容、备份/旧库恢复或回滚方案。
- 后台精简：2026-11-02 用户确认精简后台，仅设订单、用户、生产单三个一级菜单，实际客服事项嵌入关联详情。当前规格为 #150；订单/Vben #151、用户服务 #152、生产履约 #153、订单售后 #154；长期服务共用 #105。 详见[正式规格](docs/delivery/2026-10-29/admin-vben-refactor-spec.md)和[实施清单](docs/delivery/2026-10-29/admin-vben-refactor-tickets.md)。订单先处理已有订单/售后，用户先做查询、备注及核验服务；人工开单/改价/标记付款、代客新建退款/质量申请、封禁/合并暂不纳入。长期服务与直接硬更新决定继续有效；本轮只完成规格和票据更新，尚未实施。
- 营销官网：[首版需求](docs/frontend/marketing-requirements.md)已确认；以 Monorepo 内独立应用 `apps/website` 开发、构建与打包，见[官网说明](apps/website/README.md)，规格/实现票为 #69/#70。单页以成年子女为父母制作人生书为主线，微信分享后的手机访问优先并适配电脑；展示样书节选、讲述与故事示例及 999 元套餐，引导直达微信小程序套餐页。沿用小程序视觉和用户提供的「时光里」Logo，公司版权沿用 deed-fe 的「千言一语文化传媒有限公司」；首版使用明确标注的现有效果图与示例，不设咨询入口。官网展示预览已部署至 `https://sgl.wootoon.cn`，公网15项浏览器检查通过，见[发布记录](docs/delivery/2026-10-28/website-online.md)；小程序下单仍未开放，正式跳转及购买验证通过后再对外推广；微信具体接入方式仍待核实。
- 后台登录：2026-10-29 用户确认采用飞书白名单登录，授权后直接进入后台，无本地密码或 MFA；保留独立管理员权限、受保护会话、CSRF、限流与审计。实施与真实配置分别见 [ADR 0016](docs/adr/0016-feishu-admin-login.md)、[登录说明](docs/development-admin.md)及 [#81](https://github.com/brycezhang/timenook/issues/81)。
- 技术方案：[技术架构](docs/architecture/技术架构.md)。原生小程序、Vben Admin、NestJS/Fastify、Prisma/PostgreSQL、BullMQ/ioredis；基础设施为阿里云RDS、Tair、私有OSS与ECS。
- AI服务：文件ASR首选豆包，追问与故事整理首选DeepSeek；模型、服务配置和处理条款经评测与准入核对后锁定。
- 工程基线：[wutong技术栈对齐](docs/architecture/wutong技术栈对齐.md)，参考wutong-admin的工程组织及ECS/Nginx/systemd发布方式。
- 上线参数：[决策与待定项](docs/architecture/决策与待定项.md)。
- 部署入口：与 legal-agent 共用阿里云 ECS，TimeNook API 为 `https://timenookapi.threeminreading.com/api/v1`；管理页面为同域 `/admin/`，官网为 `https://sgl.wootoon.cn`。配置与验收边界见 [ADR 0015](docs/adr/0015-dedicated-domain-ingress.md) 和 [域名配置记录](docs/delivery/2026-10-28/domain-ingress.md)。应用、数据及身份独立。
- 微信与支付：独立小程序 AppID `wxa54f81265fba2439` 已绑定根目录 `project.config.json`。2026-11-01 用户通过本机受限文件交接 AppSecret；已通过微信接口校验，并将 AppID/Secret 成对同步至服务端受限环境，重启 API 后本机与公网健康检查通过。官方开发者工具的单账号真实登录、会话恢复、退出撤销与同账号重登通过；双账号与双端真机仍待验，见[本轮记录](docs/delivery/2026-11-01/wechat-login.md)。支付采用普通商户直连，复用 wutong/payment-service 的商户配置，TimeNook 使用独立 AppID/OpenID 和本项目通知接口；本轮商户关联的 1 分诊断预下单、验签、查单及关单通过，未付款。活动 API 为内部验收装配，与支付配置互斥，支付模式仍关闭；正式商品准入、实际付款/回调/退款待验。输入与绑定边界见[配置清单](docs/delivery/2026-10-26/manual-inputs.md)，正式装配的历史发布结果见 [T29 记录](docs/delivery/2026-10-28/t29-release.md)。
- 2026-10-25 配置调整：OSS 使用独立私有 Bucket `timenook`（上海），停止与 deed（legal-agent）混用 Bucket，见 [ADR 0013](docs/adr/0013-dedicated-oss-bucket.md)。OSS AccessKey 与 DeepSeek API key 继续按 [ADR 0011](docs/adr/0011-shared-oss-and-deepseek.md) 沿用 deed 配置；应用、业务数据、队列及微信身份独立。豆包 ASR 配置入口及本地测试边界见[共用服务配置](docs/development-shared-services.md)。
- 当前联调拓扑：API、OSS、数据库在 deed 阿里云环境；数据库复用 deed 连接配置并分库为 `timenook`，网页/小程序在本地运行，见 [ADR 0012](docs/adr/0012-cloud-integration-database.md)。这是受控联调部署，微信登录/支付和正式上线验收仍未执行；实际结果单独见[云端验证记录](docs/delivery/2026-10-25/cloud-integration.md)。
- 业务语言：[GLOSSARY.md](GLOSSARY.md)。
- CI：2026-10-29 第二阶段允许 PR 的官网独立变更走专用验证，公共契约、依赖、迁移、共享输入及未知路径仍整仓；main 每次 push 完整回归，保留最终 PR CI/独立双轴审查及 main 全绿后下一票的门槛。执行规则见[持续集成](docs/development.md#持续集成)，第一阶段实测见[记录](docs/delivery/2026-10-29/ci-phase1.md)，第二阶段实际验收见[记录](docs/delivery/2026-10-29/ci-phase2.md)与 [#76](https://github.com/brycezhang/timenook/issues/76)。
- T30：2026-10-29 已整理不依赖微信小程序/支付配置的[验收清单与证据缺口](docs/delivery/2026-10-29/t30-acceptance-preparation.md)、[负责人确认事项](docs/delivery/2026-10-29/t30-owner-confirmations.md)及[执行记录模板](docs/delivery/2026-10-29/t30-run-record-template.md)。本轮仅完成准备；目标用户、同一真实内部项目、实物与付费试点未执行，T29 正式环境及前序真实条件继续保留。
- 成书与线下履约：系统自动产物止于生产 PDF，由运营人工导出并线下对接印厂；主流程为“PDF 书稿完成 → 已生产 → 已发货/物流”，后两项人工核实登记。已生产指完成印制，当前 `in_production` 仅为确认接单，主状态及物流/微信字段仍有[待对齐的实现差异](docs/delivery/2026-10-29/t30-acceptance-preparation.md#系统边界与设计核实)；本轮仅核实并明确设计，未改业务代码。无需印厂/物流自动接口，线下实物验收与系统功能分别记录。
- 2026-10-26 本地工程已推进到 T21：书稿稳定入口可按固定故事版本解析原声，经当前授权网关下载并清理临时播放文件；仍使用隔离合成配置，正式小程序码、双端真机与纸书验收未完成，见[书中原声入口](docs/development-book-audio.md)与[T21证据](docs/delivery/2026-10-22/evidence/T21.md)。
- 2026-10-26 T22 本地实现：双方确认同一书稿/PDF，发起人另确认地址；服务端唯一预留首本权益，审核重验同一条件，到期进入共享人工工单。仅验证隔离合成政策与规格，真实付款、商业参数、真机和实际生产仍待验收，见[首本制作](docs/development-first-copy.md)与[T22证据](docs/delivery/2026-10-22/evidence/T22.md)。
- 2026-10-26 T23 本地实现：固定生产尝试与交接编号，本人限时授权 PDF/地址，未知接单保持待核实，确认接单才消费权益；人工记录取消、物流及唯一交付事实。仅用于隔离合成验证，实际印厂、物流和微信发货管理仍待验收，见[人工交接与物流](docs/development-fulfillment.md)与[T23证据](docs/delivery/2026-10-22/evidence/T23.md)。
- 2026-10-27 T25 本地实现：本人明确选择接收人、共享工单核验受理、完整 ZIP/来源与版本清单、固定下载期限及到期/孤儿包补扫；用户与替代交付接入 T24 当前授权活动流重验。仅验证隔离合成政策，真实 D03/D06/D08与双端交付仍待验收，见[完整资料导出](docs/development-complete-export.md)与[T25证据](docs/delivery/2026-10-22/evidence/T25.md)。
- 2026-10-26 T24 本地实现：撤回先提交用途拒绝与可恢复联动记录，终止活动私有下载并联动任务/生产，双方可查询最少处置进度；账号换绑保留主体与历史。仍为隔离合成验证，真实本人核验、印厂取消与双端清理待验，见[撤回与活动访问](docs/development-withdrawal.md)与[T24 证据](docs/delivery/2026-10-22/evidence/T24.md)。
- 2026-10-26 T27 本地实现：买方申请与共享退款工单、原销售 D07 固定金额/权益、订单锁预留、稳定退款单号、通知 Inbox 与原单查询共用入账；未知资金保留预留，生产未知先核实，退款不删除资料。仅验证隔离合成政策与微信协议，真实商户/退款、双端和正式政策待验，见[退款流程](docs/development-refunds.md)与[T27证据](docs/delivery/2026-10-22/evidence/T27.md)。
- 2026-10-27 T28 本地实现：质量申请关联原单、已交付尝试和确定 PDF；本人限时授权客服核对，原文件或重确认新稿在原单新增尝试，退款复用 T27，不新增首本权益或重起 D03。仍为隔离合成工程，真实政策、资金、印厂与设备待验，见[质量售后](docs/development-quality-care.md)与[T28 证据](docs/delivery/2026-10-22/evidence/T28.md)。
- 2026-10-27 T26 本地实现：独立撤回/删除台账先于业务投影持久化，核验删除形成永久墓碑并执行逐层清理；按类及逐包原期限补扫，旧备份恢复须显式重放和切换 authority。真实政策、介质防回滚、备份轮换、供应商回执及设备仍待验，见[资料删除与恢复](docs/development-deletion-ledger.md)与[T26 证据](docs/delivery/2026-10-22/evidence/T26.md)。
- 交互原型：[原型说明](design/figma-prototype/README.md)。

当前已有原生小程序演示前端及浏览器预览；demo 模式使用本机数据、父母二选一和静态题库。T08 已接入 live 动态赠礼目录、套餐缺参草稿与不可变本地预览，仍不可购买；真实参数与正式售卖未验收。已实现范围与验证见[前端说明](docs/frontend/README.md)。架构文档不代表后端、云资源或平台审核已完成。

2026-10-22 MVP 实施收敛：采用一份固定首版政策，生产复用受控探针能力，运营采用共享工单与受控人工流程；见 [ADR 0010](docs/adr/0010-mvp-fixed-policy-and-reuse.md)。具体商业值仍须负责人冻结。

2026-10-22 MVP 模板调整：后端内置一套固定大纲，跳过运营模板管理与多模板选择/切换；个人计划仍可编辑，详见 [ADR 0008](docs/adr/0008-single-builtin-template.md)。

T01 已增加 pnpm workspace、NestJS/Fastify 健康 API、Prisma 初始迁移和本地 PostgreSQL/Redis 检查；业务闭环仍未实现。执行命令和验证边界见 [本地开发](docs/development.md)，票据见 [实施清单](docs/delivery/2026-10-22/README.md)。
