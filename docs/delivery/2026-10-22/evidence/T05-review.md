# T05 独立双轴审查

范围为 #6 的本地销售参数完整性校验器、只读 CLI、pending/null 决策模板和填表说明。实际商业值、平台与供应商证据未冻结或核验；本票保持 OPEN / ready-for-human，任何完整性结果均不授权销售。

初审基线 `fc3abbb132fe3fd9458af702ba7d7e659f0cf4fc`，固定提交 `e7ec8837f25fc877a17aa0d8e329c36997353f8b`。命令：`git diff fc3abbb132fe3fd9458af702ba7d7e659f0cf4fc...e7ec8837f25fc877a17aa0d8e329c36997353f8b`。提交列表仅 `e7ec883 feat(commerce): validate local admission decision completeness (#6)`，7 个文件；主 Agent 确认引用有效、差异非空并冻结实现后，分别委派两名独立审查者。

规范来源为 AGENTS、CONTEXT、GLOSSARY、docs/agents 的流程约定、工程对齐、本地开发及 ADR 0002/0003/0008/0009；仓库自有代码中未发现 CODING_STANDARDS 或 CONTRIBUTING。Standards 另按完整的 12 种 Fowler smell 基线作判断，仓库规则优先，不重复工具已强制的检查。Spec 另读取 live #6、票据、实施规格、PRD 与相关架构文档。

## Standards

初审 **0 项明确规范违规，1 项判断性建议，最高 P3**。

- 可能的 Duplicated Code：`admission.ts` 初审第 330–339 行维护九种退款情形及起算点，第 669–679 行又单独维护字段白名单的 `refundCases`。新增情形需要同步两处，遗漏可能拒绝有效配置或漏检。建议用单一元组声明同时驱动规则和结构检查。此项为维护性判断，不是明确规范违规，也没有现存运行故障证据。

其余变更保留领域语言、未验收及未授权销售边界。初审只读覆盖全部 7 文件，未重复全量测试。

## Spec

初审 **1 项，最高 P3**。

- 公开纯函数的地区校验使用 `some()` 跳过空位；把完整合成夹具的 `d05.includedRegionCodes` 改为 `new Array(1)`，`Set.size` 又等于 `length`，导致返回 `complete`。这不满足填写说明要求的“非空明确地区代码”。直接纯函数调用受影响；JSON CLI 会把空位转成 null 并正确拒绝。审查者独立完成最小复现，建议逐槽检查。

其余本地范围未发现遗漏或越界。交付模板仍有 423 个缺口、7 项未冻结，报告始终未授权销售。外部材料未完成没有被当作本轮代码缺陷或已通过项。

## 修复与复审

修复提交 `7da37ef6a285f345c44a93d11fd84a8c342932e9`。增量命令：`git diff e7ec8837f25fc877a17aa0d8e329c36997353f8b...7da37ef6a285f345c44a93d11fd84a8c342932e9`，提交为 `7da37ef fix(commerce): reject sparse regions and centralize refund rules (#6)`。

稀疏地区数组新增公开边界测试，实际 RED 为 16 通过 / 1 失败；改为 `Array.from(value).some()` 后 17/17 通过，覆盖支持和不支持地区两份清单。退款九种情形改为一个元组声明，值校验、白名单和结构检查共用，保留原顺序。两项修改没有改变决策模板或原始红绿记录。

- Standards 复审：原 P3 闭合，明确规范违规 0、判断性建议 0，无最高严重项；只读复审，没有重复全量。
- Spec 复审：原 P3 闭合，新增及剩余 0，无最高严重项；独立运行新定向测试 1/1 通过，退款九种情形、起算事件及校验顺序保持一致。

实现者修复后最终 `pnpm check` 退出 0：frontend 49 / API 96 / print 13，共 **158/158**，类型和所有构建通过。主 Agent 核对原始 `review-final-pnpm-check.log`、窄范围差异和干净工作区。完整记录见 [T05](T05.md)。最终提交另须通过 GitHub CI；远端 PR 链接回填在 issue #6，较早提交的成功不替代最终提交验证。

最终汇总：Standards 剩余 0，最高严重度无；Spec 剩余 0，最高严重度无。审查通过不冻结商业参数，不核验私人材料真实性，也不替代平台、供应商或真实设备验收。
