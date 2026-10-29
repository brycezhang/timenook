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

| 运行                                                                                         | 端到端   | 累计 job 时间 | 范围/结果     |
| -------------------------------------------------------------------------------------------- | -------- | ------------- | ------------- |
| 基础设施 PR [40811365764](https://github.com/brycezhang/timenook/actions/runs/40811365764)   | 9分58秒  | 48分36秒      | full，成功    |
| 配置合并 main [40812440525](https://github.com/brycezhang/timenook/actions/runs/40812440525) | 11分28秒 | 54分28秒      | full，成功    |
| 官网独立 PR [40813725722](https://github.com/brycezhang/timenook/actions/runs/40813725722)   | 1分44秒  | 1分37秒       | website，成功 |

配置 PR 与 main 的完整报告均确认570 API、364 frontend、19 print、6 release、55 admin和15 website，共1029条既有验证用例全部passed；新增CI工具回归67条通过。PR测试的合成merge SHA与main实际提交分别以报告为准，main合并提交为e3ac42f89cb60c1d37cbc870fdd887b4029ac5e0。上游T30准备文档及随后说明修订保持原样，不纳入本票实现范围。

端到端按workflow created_at至最后job completed_at计算；累计job运行时间为非skipped任务的started_at/completed_at之和，不等同账单或p50/p95统计。

## 官网独立验证提交

为验证真实website路径，[PR #80](https://github.com/brycezhang/timenook/pull/80)仅增强官网公开预览的禁止索引/robots回归及说明文档，不修改产品行为。最终提交b567ca0的Standards/Spec独立审查均0项发现；官网18条三视口用例通过，原15条保留。实际运行只执行changes、website、check，其余任务全部skipped；9个官网阶段及官方测试发现/报告核对通过，只产生官网预览包和报告，没有API候选。相对本次full PR样本，端到端等待减少82.6%，累计job运行时间减少96.7%；这是单次实测对比，不代表p50/p95。

官网合并后的main [40813954529](https://github.com/brycezhang/timenook/actions/runs/40813954529)仍执行full，并正确阻断了API第4片的书中原声删除失败：共享擦除守卫把合法短码ID转换为UUID，触发22P02，删除回执保持pending。该缺陷在前期全量运行也出现过，不由官网改动引入；独立修复与真实PG回归归 [#83](https://github.com/brycezhang/timenook/issues/83)，不以重试、跳过或放松汇总替代修复。修复的最终PR及main完整回归结果、完整计数补充于 [#76](https://github.com/brycezhang/timenook/issues/76)，避免为记录自身运行循环产生新提交。

顺序复验还捕获了期限测试的准备竞态：全局Date推进时，真实后台维护会发布已经到期的bookPdf事件；在其PG回执提交前，无scope音频流按ADR0014的原恢复门闩拒绝，流错误表现为500。受控暂停真实append返回后重现了原始503原因。期限测试改为先等待真实sweep完成，并确认PDF/故事已擦除而原声清单和文件仍在，再原样验证截止前/恰好截止/截止后及full/Range。该调整强化独立期限的前提，不扩大生产scope或绕过未知台账后缀。

修复PR #84的完整Actions确认1038条业务/浏览器用例及67条CI工具回归通过。合并时PR #82先于#84两秒进入main，组合提交8384062另行完整回归，不能复用旧base的总数；较早main的取消不计成功。此次并发未形成逐笔main验绿，属于已发生的流程偏差，后续绿灯不追认该条件；原规则保留，原子串行保护缺口单独归 [#85](https://github.com/brycezhang/timenook/issues/85)。

组合main [40819006406](https://github.com/brycezhang/timenook/actions/runs/40819006406)的API第二片连续三次在FFmpeg源包下载阶段失败（连接重置/120秒超时），均未开始应用测试；其他分片通过也不能据此宣称完整main绿色。停止手工重复后，按 [#86](https://github.com/brycezhang/timenook/issues/86)仅为传输失败增加固定官方镜像回退；版本8.1.1、独立摘要验证及全部原编译/测试范围保留。当前发布签名标签n8.1.1已验证，对应239f2c733de417201d7ad3b3b8b0d9b63285b2b1，固定归档实际获取的SHA256为ec0aa20fb9f6fd3692ffc04dc12ffa43cfffc4a479e388ccd7910ec6cfe188a2，RELEASE确认8.1.1。最终修复PR、main的准确SHA/完整计数及含补跑耗时记录于 [#76](https://github.com/brycezhang/timenook/issues/76)，不将故障补跑混作健康性能样本。

官网快速路径不会放行公共协议、依赖、迁移或未知路径。本文不代表生产部署、微信/资金/实物验收。
