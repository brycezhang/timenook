# TimeNook 项目上下文

2026-10-29 长期服务决定已接受，见 [ADR 0017](docs/adr/0017-lifetime-service-and-retention.md)。制作、回听、导出申请、已完成资料包下载和必要资料长期有效；后台不再配置服务期限或处理暂停、续期和到期例外。D06 人工时限、D07 售后窗口、付款/首本权益、本人授权和主动撤回删除独立适用。#105 的本地实现与验证见[长期服务开发说明](docs/development-lifetime-service.md)；它不代表 OSS 生命周期或正式环境已切换。

品牌「时光里」，产品「岁月成书」。微信小程序为一位成年讲述者及一位发起人提供分轮语音记录、故事确认及个人故事书制作；999元包含一个项目与一本实体书。

2026-10-30 用户确认区分“未识别到语音”与“已转写但暂未形成故事”：前者为 `no_speech`，后者为 `no_content`；网页与小程序共用故事页显示已识别文字和继续补充入口，转写不作为故事确认稿。方案与验证见[转写与成稿状态修复](docs/delivery/2026-10-30/transcription-story-states.md)。

同日用户要求将故事页的原声保存提示改为可直接试听的播放卡片；网页与小程序共用，支持逐段播放、暂停／继续、进度条拖动、已播放／总时长及加载提示，沿用原声授权和临时文件清理规则。

项目处于开发阶段，方案调整与文档、记忆更新按[工程约定](AGENTS.md)执行。

赠礼关系可配置或自定义。产品内置大纲模板，双方可编辑个人章节和问题，讲述者决定回答与入书。核心链路为“录音 → 可靠保存 → 文件转写 → 可选追问 → 故事确认”。

- 产品范围与验收：[MVP PRD](docs/时光里_岁月成书_MVP_PRD.md)。
- 双端 UI：2026-10-30 用户批准[最新原型](docs/frontend/ui-review-2026-10-30.md)并授权网页版、小程序版实施和线上部署。[工程交付](docs/delivery/2026-10-30/ui-refresh-delivery.md)已统一移动/桌面布局、项目与分步录音、真实保存转写状态、成书及辅助页面。用途开始一次确认既有三项；故事仅「确认」，不新增第四类用途记录或独立入书说明。本人、版本、原拒绝、撤回和协助校验保留。网页已发布，小程序停在 `0.2.1` 体验版；用户最新要求「先不提审」，本轮不更改主营类目或进入正式提审。实际发布和平台限制以 [#124](https://github.com/brycezhang/timenook/issues/124) 为唯一运行证据，微信真机结果分别记录。
- 内部验收登录：2026-10-30 用户要求验证阶段账号不要过期；显式内部验收模式下，验收登录链接可反复使用，不因打开、登录或退出而失效，直到手动撤销；会话持续有效，已有有效会话恢复时升级；主动退出终止当前会话，再次登录可使用原链接，见[网页账号](docs/development-web-accounts.md)。
- 2026-10-30 同机协助简化：用户确认三项用途改为复选项，首次默认勾选，可单独取消，一键保存后进入讲述；已有拒绝、撤销或过期状态按实际回显。仍逐项保存独立证据，故事/书稿确认单独进行；小程序与网页继续共用原生页面，见[体验交付](docs/delivery/2026-10-30/web-experience.md#同机协助复选项与一键继续)。
- 2026-10-30 界面收敛：用户要求网页直接复刻小程序，业务页只维护同一份 WXML / WXSS / Page，不另写网页界面；录音首屏直接显示问题与大麦克风，按录制、回听提交、自动保存处理、可选追问分阶段呈现。新讲述使用独立草稿标识，不误恢复上一段；照片、改写和原声放次级入口。见[最新体验交付](docs/delivery/2026-10-30/web-experience.md#同日界面收敛)。
- 网页完整体验：2026-10-30 用户确认网页 UI/UX 沿用小程序与效果图，保留正常登录、套餐、支付及创建项目流程；内测点击直接登录独立账号、模拟支付后创建真实内测项目，无真实扣款或生产权益。共用页面同步调整并修复网页输入失焦、邀请返回与分享；方案、验证与部署见[体验交付](docs/delivery/2026-10-30/web-experience.md)。
- 两端分步讲述：2026-10-29 用户确认手机网页端与小程序统一选题、录制（暂停继续）、回听提交、保存处理／可选追问及故事确认流程，保留既有授权和版本规则；网页与落地页同域 `sgl.wootoon.cn`，首版用于内部验收、账号简化、无网页真实收款。规格与工程进度见[统一流程规格](docs/delivery/2026-10-29/mobile-web-spec.md)和[实施票据](docs/delivery/2026-10-29/mobile-web-tickets.md)，网页已部署同域内测入口，并用双账号同一项目完成真实OSS/ASR/DeepSeek、故事确认、5页PDF同版确认和书中原声回听，见[运行验收](docs/delivery/2026-10-29/mobile-web-online.md)；语音是明确虚构的模拟设备输入，微信真机与人工目标用户仍待验。
- 后台整体重构：用户确认参考 wutong 完整采用 Vben 登录/主布局、路由菜单、搜索筛选分页、详情/弹窗/抽屉及多标签页；保留飞书白名单登录和现有业务权限。菜单按商品配置、客户服务、生产履约、系统运维组织，客户服务只保留实际工单事项，见[重构规格草案](docs/delivery/2026-10-29/admin-vben-refactor-spec.md)。
- 营销官网：[首版需求](docs/frontend/marketing-requirements.md)已确认；以 Monorepo 内独立应用 `apps/website` 开发、构建与打包，见[官网说明](apps/website/README.md)，规格/实现票为 #69/#70。单页以成年子女为父母制作人生书为主线，微信分享后的手机访问优先并适配电脑；展示样书节选、讲述与故事示例及 999 元套餐，引导直达微信小程序套餐页。沿用小程序视觉和用户提供的「时光里」Logo，公司版权沿用 deed-fe 的「千言一语文化传媒有限公司」；首版使用明确标注的现有效果图与示例，不设咨询入口。官网展示预览已部署至 `https://sgl.wootoon.cn`，公网15项浏览器检查通过，见[发布记录](docs/delivery/2026-10-28/website-online.md)；小程序下单仍未开放，正式跳转及购买验证通过后再对外推广；微信具体接入方式仍待核实。
- 后台登录：2026-10-29 用户确认采用飞书白名单登录，授权后直接进入后台，无本地密码或 MFA；保留独立管理员权限、受保护会话、CSRF、限流与审计。实施与真实配置分别见 [ADR 0016](docs/adr/0016-feishu-admin-login.md)、[登录说明](docs/development-admin.md)及 [#81](https://github.com/brycezhang/timenook/issues/81)。
- 技术方案：[技术架构](docs/architecture/技术架构.md)。原生小程序、Vben Admin、NestJS/Fastify、Prisma/PostgreSQL、BullMQ/ioredis；基础设施为阿里云RDS、Tair、私有OSS与ECS。
- AI服务：文件ASR首选豆包，追问与故事整理首选DeepSeek；模型、服务配置和处理条款经评测与准入核对后锁定。
- 工程基线：[wutong技术栈对齐](docs/architecture/wutong技术栈对齐.md)，参考wutong-admin的工程组织及ECS/Nginx/systemd发布方式。
- 上线参数：[决策与待定项](docs/architecture/决策与待定项.md)。
- 部署入口：与 legal-agent 共用阿里云 ECS，TimeNook API 为 `https://timenookapi.threeminreading.com/api/v1`；管理页面为同域 `/admin/`，官网为 `https://sgl.wootoon.cn`。配置与验收边界见 [ADR 0015](docs/adr/0015-dedicated-domain-ingress.md) 和 [域名配置记录](docs/delivery/2026-10-28/domain-ingress.md)。应用、数据及身份独立。
- 支付方案：普通商户直连，复用 wutong/payment-service 的商户配置，TimeNook 使用独立 AppID/OpenID 和本项目通知接口；参数来源与未完成项见[配置清单](docs/delivery/2026-10-26/manual-inputs.md#2026-10-28-普通商户配置决定)。普通商户正式配置读取与验签装配由 T29 接入。2026-10-30 小程序项目已绑定用户提供的独立 AppID `wxa54f81265fba2439`；核实线上服务端 AppID/Secret 仍成对留空，微信登录和真实收退款未启用。工程与实际发布边界见 [T29 记录](docs/delivery/2026-10-28/t29-release.md)。
- 2026-10-25 配置调整：OSS 使用独立私有 Bucket `timenook`（上海），停止与 deed（legal-agent）混用 Bucket，见 [ADR 0013](docs/adr/0013-dedicated-oss-bucket.md)。OSS AccessKey 与 DeepSeek API key 继续按 [ADR 0011](docs/adr/0011-shared-oss-and-deepseek.md) 沿用 deed 配置；应用、业务数据、队列及微信身份独立。豆包 ASR 配置入口及本地测试边界见[共用服务配置](docs/development-shared-services.md)。
- 当前联调拓扑：API、OSS、数据库在 deed 阿里云环境；数据库复用 deed 连接配置并分库为 `timenook`，网页/小程序在本地运行，见 [ADR 0012](docs/adr/0012-cloud-integration-database.md)。这是受控联调部署，微信登录/支付和正式上线验收仍未执行；实际结果单独见[云端验证记录](docs/delivery/2026-10-25/cloud-integration.md)。
- 业务语言：[GLOSSARY.md](GLOSSARY.md)。
- CI：2026-10-29 第二阶段允许 PR 的官网独立变更走专用验证，公共契约、依赖、迁移、共享输入及未知路径仍整仓；main 每次 push 完整回归，合并按仓库必要 CI 执行；功能优先、定向验证与并行推进以最新 [AGENTS.md](AGENTS.md) 为准，不额外强制双轴/多轮审查或等待 main CI 后再开发下一票。CI 配置见[持续集成](docs/development.md#持续集成)，第一阶段实测见[记录](docs/delivery/2026-10-29/ci-phase1.md)，第二阶段实际验收见[记录](docs/delivery/2026-10-29/ci-phase2.md)与 [#76](https://github.com/brycezhang/timenook/issues/76)。
- T30：2026-10-29 已整理不依赖微信小程序/支付配置的[验收清单与证据缺口](docs/delivery/2026-10-29/t30-acceptance-preparation.md)、[负责人确认事项](docs/delivery/2026-10-29/t30-owner-confirmations.md)及[执行记录模板](docs/delivery/2026-10-29/t30-run-record-template.md)。本轮仅完成准备；目标用户、同一真实内部项目、实物与付费试点未执行，T29 正式环境及前序真实条件继续保留。
- 成书与线下履约：系统自动产物止于生产 PDF，由运营人工导出并线下对接印厂；主流程为“PDF 书稿完成 → 已生产 → 已发货/物流”，后两项人工核实登记。已生产指完成印制，当前 `in_production` 仅为确认接单，主状态及物流/微信字段仍有[待对齐的实现差异](docs/delivery/2026-10-29/t30-acceptance-preparation.md#系统边界与设计核实)；本轮仅核实并明确设计，未改业务代码。无需印厂/物流自动接口，线下实物验收与系统功能分别记录。
- 2026-10-26 本地工程已推进到 T21：书稿稳定入口可按固定故事版本解析原声，经当前授权网关下载并清理临时播放文件；仍使用隔离合成配置，正式小程序码、双端真机与纸书验收未完成，见[书中原声入口](docs/development-book-audio.md)与[T21证据](docs/delivery/2026-10-22/evidence/T21.md)。
- 2026-10-26 T22 本地实现：双方确认同一书稿/PDF，发起人另确认地址；服务端唯一预留首本权益，审核重验同一条件，制作资格不按日期到期。仅验证隔离合成政策与规格，真实付款、商业参数、真机和实际生产仍待验收，见[首本制作](docs/development-first-copy.md)与[T22证据](docs/delivery/2026-10-22/evidence/T22.md)。
- 2026-10-26 T23 本地实现：固定生产尝试与交接编号，本人限时授权 PDF/地址，未知接单保持待核实，确认接单才消费权益；人工记录取消、物流及唯一交付事实。仅用于隔离合成验证，实际印厂、物流和微信发货管理仍待验收，见[人工交接与物流](docs/development-fulfillment.md)与[T23证据](docs/delivery/2026-10-22/evidence/T23.md)。
- 2026-10-27 T25 本地实现：本人明确选择接收人、共享工单核验受理、完整 ZIP/来源与版本清单、长期下载及技术孤儿包清理；用户与替代交付接入 T24 当前授权活动流重验。仅验证隔离合成政策，真实 D03/D06/D08与双端交付仍待验收，见[完整资料导出](docs/development-complete-export.md)与[T25证据](docs/delivery/2026-10-22/evidence/T25.md)。
- 2026-10-26 T24 本地实现：撤回先提交用途拒绝与可恢复联动记录，终止活动私有下载并联动任务/生产，双方可查询最少处置进度；账号换绑保留主体与历史。仍为隔离合成验证，真实本人核验、印厂取消与双端清理待验，见[撤回与活动访问](docs/development-withdrawal.md)与[T24 证据](docs/delivery/2026-10-22/evidence/T24.md)。
- 2026-10-26 T27 本地实现：买方申请与共享退款工单、原销售 D07 固定金额/权益、订单锁预留、稳定退款单号、通知 Inbox 与原单查询共用入账；未知资金保留预留，生产未知先核实，退款不删除资料。仅验证隔离合成政策与微信协议，真实商户/退款、双端和正式政策待验，见[退款流程](docs/development-refunds.md)与[T27证据](docs/delivery/2026-10-22/evidence/T27.md)。
- 2026-10-27 T28 本地实现：质量申请关联原单、已交付尝试和确定 PDF；本人限时授权客服核对，原文件或重确认新稿在原单新增尝试，退款复用 T27，不新增首本权益，资料服务长期有效。仍为隔离合成工程，真实政策、资金、印厂与设备待验，见[质量售后](docs/development-quality-care.md)与[T28 证据](docs/delivery/2026-10-22/evidence/T28.md)。
- 2026-10-27 T26 本地实现：独立撤回/删除台账先于业务投影持久化，核验删除形成永久墓碑并执行逐层清理；仅按核验删除范围执行清理，资料不因业务期限自动清理；进程重启沿独立源核验拒绝。真实政策、介质防回滚、备份轮换、供应商回执及设备仍待验，见[资料删除与恢复](docs/development-deletion-ledger.md)与[T26 证据](docs/delivery/2026-10-22/evidence/T26.md)。
- 交互原型：[原型说明](design/figma-prototype/README.md)。

当前已有原生小程序演示前端及浏览器预览；demo 模式使用本机数据、父母二选一和静态题库。T08 已接入 live 动态赠礼目录、套餐缺参草稿与不可变本地预览，仍不可购买；真实参数与正式售卖未验收。已实现范围与验证见[前端说明](docs/frontend/README.md)。架构文档不代表后端、云资源或平台审核已完成。

2026-10-22 MVP 实施收敛：采用一份固定首版政策，生产复用受控探针能力，运营采用共享工单与受控人工流程；见 [ADR 0010](docs/adr/0010-mvp-fixed-policy-and-reuse.md)。具体商业值仍须负责人冻结。

2026-10-22 MVP 模板调整：后端内置一套固定大纲，跳过运营模板管理与多模板选择/切换；个人计划仍可编辑，详见 [ADR 0008](docs/adr/0008-single-builtin-template.md)。

T01 已增加 pnpm workspace、NestJS/Fastify 健康 API、Prisma 初始迁移和本地 PostgreSQL/Redis 检查；业务闭环仍未实现。执行命令和验证边界见 [本地开发](docs/development.md)，票据见 [实施清单](docs/delivery/2026-10-22/README.md)。
