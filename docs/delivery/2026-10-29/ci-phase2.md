# CI 第二阶段：官网 PR 独立验证

日期：2026-10-29。票据 [#76](https://github.com/brycezhang/timenook/issues/76)，配置实现 [PR #78](https://github.com/brycezhang/timenook/pull/78)。

## 执行边界

PR 使用 docs / website / full 三种明确范围；main 每次 push 固定 full，包括纯文档和官网。实际规则与复现入口见[持续集成](../../development.md#持续集成)。最终提交 PR CI、独立 Standards/Spec 审查、合并后 main 全绿再合并下一票的门槛保持。

官网仅普通文件和已声明源码/测试、独立配置、两个当前脚本可分流；公共契约、依赖清单/锁、迁移、根配置、共享输入及未知路径保守 full。官网共享输入包含 miniprogram/domain/model.ts、miniprogram/assets、design/brand、tools/vite-private-artifacts.ts，任一变更均 full。重命名同时看旧路径，权限/链接/空差异保守 full，读取差异错误阻断。

website 任务完整执行文档、类型、生产构建、官方发现的三视口全部测试、独立打包、SHA256及清洁提交清单验证，再重新发现并核对全部 project/case 和阶段报告。该路径仅提供官网预览包；不启动 PG/Redis/API/admin 或生成 API 候选。full 仍执行原全部业务检查、真实 PG/Redis 锁与恢复、OpenAPI/Linux/候选校验。

## 已完成的本地验证与审查

配置固定候选 b419866c406f1aef88c86281340737554076ff5c，审查基线69cf1d0。Standards与Spec独立审查均通过、0项未解决发现；67条CI工具测试、actionlint、文档链接、官网类型/构建及原15条三视口测试通过。

RED→GREEN包含官网声明路径、共享/依赖/迁移/未知拒绝、事件与main强制full、重命名/权限/链接、七个needs结果矩阵，以及真实临时包篡改、SHA/清单和报告/三project遗漏检查。报告只保留白名单元数据，失败也上传已有报告。

## 实际 Actions

| 运行                                                                                         | 端到端  | 累计 job 时间 | 范围/结果    |
| -------------------------------------------------------------------------------------------- | ------- | ------------- | ------------ |
| 基础设施 PR [40811365764](https://github.com/brycezhang/timenook/actions/runs/40811365764)   | 9分58秒 | 48分36秒      | full，成功   |
| 配置合并 main [40812440525](https://github.com/brycezhang/timenook/actions/runs/40812440525) | 待完成  | 待完成        | full，运行中 |

配置 PR 与 main 的完整报告均确认570 API、364 frontend、19 print、6 release、55 admin和15 website，共1029条既有验证用例全部passed；新增CI工具回归67条通过。PR测试的合成merge SHA与main实际提交分别以报告为准，main合并提交为e3ac42f89cb60c1d37cbc870fdd887b4029ac5e0。上游T30准备文档及随后说明修订保持原样，不纳入本票实现范围。

端到端按workflow created_at至最后job completed_at计算；累计job运行时间为非skipped任务的started_at/completed_at之和，不等同账单或p50/p95统计。

## 官网独立验证提交

为验证真实website路径，本提交仅增强官网公开预览的禁止索引/robots回归及说明文档，不修改产品行为。新增用例在三个视口执行，原15条保留，官网总计18条。实际PR分流、发布artifact集合、最终提交双轴审查，以及合并后main完整1032条用例的结果记录于 [#76](https://github.com/brycezhang/timenook/issues/76)，避免为记录自身运行循环产生新提交。

官网快速路径不会放行公共协议、依赖、迁移或未知路径。本文不代表生产部署、微信/资金/实物验收。
