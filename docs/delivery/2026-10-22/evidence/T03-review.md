# T03 独立双轴审查

范围为 #4 已授权的本地 ASR / 生成候选探针；真实账号、样本、质量、时延、费用与供应商准入仍待验收。#4 保持 OPEN / ready-for-human，原生 blocked-by 保留，详见 [T03证据](T03.md)。

初审基线 `36843770204f642b0827e1c9f18c84aab9c17428`，固定实现提交 `6c41f37584f5d0ad579f6d0c9f761dd6490c3ee4`。命令：`git diff 36843770204f642b0827e1c9f18c84aab9c17428...6c41f37584f5d0ad579f6d0c9f761dd6490c3ee4`；提交列表仅 `6c41f37 feat(probe): add durable ASR and generation candidate validation (#4)`，17文件。主 Agent 确认引用有效、差异非空、工作树干净后委派两名独立只读审查者。

Standards 来源包括 AGENTS、CONTEXT、GLOSSARY、docs/agents、开发说明、技术架构、数据模型、流程与接口、工程对齐及 ADR 0001/0003/0006/0007/0009；仓库自有代码无 CODING_STANDARDS 或 CONTRIBUTING。完整12项 Fowler smell 基线均作为判断性建议，仓库明文规则优先。Spec 读取 live #4、对应票据、实施规格、PRD 与相关架构，不把已明确保留的外部验收当成本轮隐藏缺陷。

## Standards

初审：明确规范违规 **0**，判断性建议 **1**，最高 **P3**。

- 可能的 Duplicated Code：初始 `ai-probe.ts` 第264–271与281–288行重复 ASR claim 失效更新，第475–478与499–502行重复生成失效更新。建议分别提取小型私有方法，保留条件、等待顺序及原异常。这是维护性建议，没有宣称当前运行行为错误。

## Spec

初审：实现错误 **2**，越界行为 **0**，最高 **P2**。

- 签名后等待数据库锁可能耗尽源 URL 的5秒余量。外发前检查抛错时 run 已记录 submitting，后续只能查询从未提交的 UUID。独立审查者用真实 PostgreSQL / Redis / OSS SDK 及时间前移复现 HTTP500、随后 unknown、仅 query 外呼、attempts=1；违反票据取源窗口及未知提交恢复边界。
- 生成结构未遵循既定契约。`流程与接口.md` 要求稿件 `title/paragraphs[{text,sourceRefs}]/theme/reviewItems`；`技术架构.md` 要求追问 `action/question/intent/sourceRefs/reasonCode`，`大纲与追问设计.md` 规定字符串来源引用。初始结构及终态处理与这些规格不一致。

## 修复与复审

修复提交 `e7cc64ed1b455298319afb28724e3df7ad84dd07`；增量命令 `git diff 6c41f37584f5d0ad579f6d0c9f761dd6490c3ee4...e7cc64ed1b455298319afb28724e3df7ad84dd07`，提交仅 `e7cc64e fix(probe): recover unsent ASR claims and align output contracts (#4)`，6文件。

- 确定未进入传输的源窗口错误使用专用类型；通过 owner、封存、storageScope、id、fence、submitting 条件更新回 ready，撤销提交计数与时间。下一次显式命令用同 UUID 重签。进入传输后的错误仍为 unknown，只查原任务；旧 fence 不能重置接管者。
- 使用既定追问/稿件字段及本次 sourceRefs 允许清单，拒绝旧结构、缺字段和未知引用。finish、拒答、不适用均为已知且不可用的终态；提示词/契约升级 t03-v2 并绑定配置摘要。旧结果可原样读取，旧 UUID 不能继续新契约。
- 提取 `invalidateAsrClaim` 与 `invalidateGeneration` 两个私有方法，保持条件、fence、lease 与异常行为。

Standards 复审：原 P3 闭合1，剩余明确违规 **0**、判断性建议 **0**、新增 **0**，最高严重度无。Spec 复审：原 P2 闭合2，剩余 **0**、新增 **0**，最高严重度无。两名审查者分别阅读固定增量、测试及 RED/GREEN 日志，只读复审，没有重复全量测试。

初始提交一次完整 `pnpm check` 为 **197/197**，全部类型检查与构建通过；源 URL、两类输出、终态和版本绑定的修复均有实际 RED → GREEN。去重前后定向套件各 **22/22**，修复后 API 类型检查、构建、diff 检查通过，清理核验为0个 T03 schema / Redis key。修复后测试库存为200项，本地没有把初始197项称为最终200项全绿；详细命令与失败历史见 T03证据。

最终含审查记录的 HEAD 必须通过 push 与 PR 两组完整 CI 后才可合并；实际远端结果及合并提交记录在 #4 交付评论。审查与本地测试均不替代真实模型、OSS、授权样本、微信真机或生产验收。
