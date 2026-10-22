# TimeNook · 时光里「岁月成书」

微信小程序帮助一位讲述者把真实讲述、照片和经本人确认的故事制作成个人故事书。目标支持父母、亲友等可配置赠礼关系，以及可修改的大纲与问题。999元套餐包含一个人生项目及一本实体书。

已实现首版原生微信小程序前端（15个页面，当前仍仅妈妈/爸爸、静态题库），附共用页面源码的浏览器预览。当前仍使用本机演示数据，后端、微信登录/支付、云存储、文件转写、AI整理和印刷服务未接入。

```bash
npm install
npm run dev          # 浏览器预览：http://127.0.0.1:5173
npm run check        # 类型检查、行为测试、原生构建
npm run check:native # 使用本机微信开发者工具的 WXML / WXSS 编译器
```

微信开发者工具导入本目录，读取 `project.config.json`，构建目录为 `dist/miniprogram/`。当前使用游客 AppID，真机预览需配置自己的小程序 AppID。

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
| 交互原型说明           | [原型说明](design/figma-prototype/README.md)          |

技术架构采用**TypeScript / NestJS + Fastify**与**Vben Admin**，工程尽量对齐wutong-admin。基础设施使用**阿里云RDS PostgreSQL、Tair、私有OSS和ECS**；文件ASR首选**豆包**，追问与故事整理首选**DeepSeek**。录音可靠保存后异步转写，产品支持动态赠礼关系与个人大纲，详见[技术架构](docs/architecture/技术架构.md)与[工程基线](docs/architecture/wutong技术栈对齐.md)。
