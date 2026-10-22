# T08 独立双轴审查

范围为 #9 允许的本地目录、套餐草稿/不可变预览、真实管理端与小程序公开 HTTP 联动。正式 D01–D08、D10、发布/销售授权与外部验收仍待完成，#9 保持 OPEN / ready-for-human，原生 blocked-by 不变。详见 [T08证据](T08.md)。

初审基线 `f85358a0ed5b552a949def5a561497b821293845`，固定实现提交 `5f34dc1b65dd027bb53c2ab7f60ac6082f67a159`。命令：`git diff f85358a0ed5b552a949def5a561497b821293845...5f34dc1b65dd027bb53c2ab7f60ac6082f67a159`；提交列表仅 `5f34dc1 feat(catalog): add local relationship and package previews (#9)`，38文件。主 Agent 确认引用有效、差异非空、工作树干净后委派两名独立只读审查者。

Standards 来源包括 AGENTS、CONTEXT、GLOSSARY、docs/agents、开发说明、工程对齐和 ADR 0001/0002/0008/0009，仓库自有代码无 CODING_STANDARDS 或 CONTRIBUTING；另使用完整12项 Fowler smell 基线，均为判断性建议，仓库明文规则优先。Spec 读取 live #9 正文/评论、票据、实施规格、PRD A01/X01/R01/D10 与相关架构/ADR；没有把已明确保留的外部验收当作本轮隐藏缺陷。

## Standards

初审：明确规范违规 **0**，判断性建议 **1**，最高 **P3**。

- 可能的 Duplicated Code：初始 `package-terms.ts` 第89–111行复制 `admission.ts` 第52–77行的审核引用与 UTC 日期校验。规则后续变化需要同步两处，建议提取 `isRecordReference` 与 `isUtcReviewTime`，各调用方保留问题路径及文案。此为维护性判断，未发现当前运行行为错误。

其余本地/生产隔离、审计事务、公开白名单 DTO、demo/live 及提交范围符合明文约定。初审未改文件或重复全量测试。

## Spec

初审：遗漏/部分实现 **0**、越界行为 **0**、实现错误 **0**，最高严重度无。

动态关系、自定义称呼、缺参草稿、不可变本地预览及管理端/小程序联动符合本轮范围。审查者额外交叉检查145个合法期限/退款规则变体，完整性均通过，消费者条款无未映射值。正式发布、真实参数与销售授权仍有明确未完成记录；生产拒绝预览冻结、公开套餐不可购买。

主 Agent 在固定 `5f34dc1` 上独立运行完整 `pnpm test:admin-browser`，退出0、3/3通过；日志 `output/pdf/t08-logs/review-browser-all.log`。这项新增结果不覆盖早先预期422分类失败的历史记录。

## 修复与复审

修复提交 `6c727f4ba9f863ffe0a4dbacd1d87e4be1f22a9f`；增量命令 `git diff 5f34dc1b65dd027bb53c2ab7f60ac6082f67a159...6c727f4ba9f863ffe0a4dbacd1d87e4be1f22a9f`，提交仅 `6c727f4 refactor(catalog): share review metadata validation (#9)`。

新增内部 `commerce/review-values.ts` 两个纯函数，保留原正则、短路顺序、日期有效性及接受/拒绝条件。T05 与 D01 调用者仍分别生成原错误路径/码/文案。新增一条 D01 公开 HTTP 行为保留回归，覆盖5类异常引用/日期；没有内部helper镜像测试或虚构 RED。

- 重构前相关套件33/33；新增回归在原实现上34/34；重构后同套件34/34（T05 17 + T08 17），API类型检查与构建通过。完整日志与命令见 T08证据。
- Standards 复审：原P3闭合1，剩余明确违规0/判断性建议0，新增0，最高严重度无。
- Spec 复审：新增0，最高严重度无；规则行为、问题路径/文案与销售边界未漂移。

两位审查者均只读复审，无重复全量测试。主 Agent 核对增量、真实日志、截图及7个旧迁移字节一致；最终含审查记录的 HEAD 仍须通过远端完整 CI 后合并。审查通过不替代供应商、微信双端真机、实际商业参数或正式销售授权。

最终轴内结论：Standards 剩余0，最高严重度无；Spec 剩余0，最高严重度无。
