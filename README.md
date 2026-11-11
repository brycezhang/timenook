# TimeNook · 时光故事

以语音记录为主，将故事、照片与原声整理为个人故事书，可送给家人或自己。999 元套餐包含一个项目及一本实体书。已确认的新流程包括共用六章大纲、家人提问和礼物三分类，详见[产品流程](designs/timenook-modern-2026-11-10/project/BUSINESS-FLOW.md)。

工程包含原生微信小程序、Vue 网页、NestJS/Fastify API、Worker 与后台。当前实现与新版设计的差异见[小程序重构调整清单](docs/delivery/2026-11-11/miniprogram-design-gap.md)；设计确认、工程实现与真实验收分别记录，最新状态见 [CONTEXT.md](CONTEXT.md)。

```bash
pnpm install --frozen-lockfile # Node 22.23.4 / pnpm 10.34.7
# 首次启动、环境配置、容器和迁移见下方开发说明
pnpm dev             # 浏览器预览：http://127.0.0.1:5173
pnpm dev:api         # API：http://127.0.0.1:3417
pnpm check           # 类型、前后端行为、原生及预览构建
pnpm check:native    # Mac 微信开发者工具 WXML / WXSS 编译器
```

首次开发请按[本地开发与验证](docs/development.md)启动独立 PostgreSQL/Redis、生成 Prisma Client 并执行迁移。

微信开发者工具导入本目录，读取已配置项目 AppID 的 `project.config.json`，构建目录为 `dist/miniprogram/`。正式构建、手机号登录及环境配置见[本地开发与验证](docs/development.md)。

实现范围、页面清单及验证边界见[前端说明](docs/frontend/README.md)，参考效果图与实现对照见[视觉验收](docs/frontend/visual-review.md)。

| 阅读目的               | 文档                                                  |
| ---------------------- | ----------------------------------------------------- |
| 需求、范围和验收       | [MVP PRD V1.0](docs/时光里_岁月成书_MVP_PRD.md)       |
| 技术方案               | [技术架构](docs/architecture/技术架构.md)             |
| 实体、版本及约束       | [数据模型](docs/architecture/数据模型.md)             |
| 核心流程和接口         | [流程与接口](docs/architecture/流程与接口.md)         |
| 部署、验收及分阶段交付 | [交付与运维](docs/architecture/交付与运维.md)         |
| 个人大纲与追问         | [大纲与追问设计](docs/architecture/大纲与追问设计.md) |
| 尚未冻结的参数         | [决策与待定项](docs/architecture/决策与待定项.md)     |
| 业务语言               | [GLOSSARY.md](GLOSSARY.md)                            |
| 交互原型说明           | [新版画布与设计说明](designs/timenook-modern-2026-11-10/project/README.md) |
| 小程序重构范围         | [18 项功能调整清单](docs/delivery/2026-11-11/miniprogram-design-gap.md) |

技术架构采用**TypeScript / NestJS + Fastify**与**Vben Admin**，工程尽量对齐wutong-admin。基础设施使用**阿里云RDS PostgreSQL、Tair、私有OSS和ECS**；文件ASR首选**豆包**，追问与故事整理首选**DeepSeek**。录音可靠保存后异步转写，产品支持动态赠礼关系与个人大纲，详见[技术架构](docs/architecture/技术架构.md)与[工程基线](docs/architecture/wutong技术栈对齐.md)。

GitHub 仓库：[brycezhang/timenook](https://github.com/brycezhang/timenook)。分步实施见 [2026-10-22 ticket 实施清单](docs/delivery/2026-10-22/README.md)：1 个规格及 30 张 tickets，包含依赖、验收与外部条件；已发布为 [GitHub 规格及子票据](https://github.com/brycezhang/timenook/issues/1)，按依赖实施。

2026-10-22 MVP 模板调整：后端内置一套固定大纲，跳过运营模板管理与多模板选择/切换；个人计划仍可编辑，详见 [ADR 0008](docs/adr/0008-single-builtin-template.md)。
