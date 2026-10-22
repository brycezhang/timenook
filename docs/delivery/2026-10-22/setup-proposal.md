# 工程流程配置草稿

状态：2026-10-22 已确认并应用；同日按规格检查结论同步修订依赖完成规则。下方保留本次审阅的配置文本，实际规则以根 AGENTS.md 和 docs/agents 为准。

建议：使用已指定 GitHub 仓库作为 tracker，保留五个默认 triage 标签，创建根 AGENTS.md；现有 GLOSSARY.md 和 docs/adr 保持单一业务上下文。以下是本次确认写入的文本。

## AGENTS.md

```markdown
# TimeNook 工程约定

先读 CONTEXT.md。实现业务票据前读 GLOSSARY.md、对应 ADR 和票据引用的规格；已定方案与运行验收分别记录。

## Agent skills

### Issue tracker

规格和 tickets 使用 brycezhang/timenook 的 GitHub Issues；读取、依赖、状态与交付约定见 docs/agents/issue-tracker.md。

### Triage labels

采用五个默认 triage 角色；ready-for-agent 仍须检查阻塞依赖。映射见 docs/agents/triage-labels.md。

### Domain docs

单一业务上下文，使用根 GLOSSARY.md 和 docs/adr；消费规则见 docs/agents/domain.md。

## 验证与交付

按当前 ticket 的公开边界逐条实现并验证。数据库唯一性、锁和恢复使用真实 PostgreSQL/Redis；真机、供应商与实物结果分别记录。只提交本票范围的变更与必需锁文件，保持凭据和私人样本在 Git 外。
```

## docs/agents/issue-tracker.md

```markdown
# Issue tracker: GitHub

仓库为 brycezhang/timenook。用 gh 读取/修改 GitHub Issues；多行正文写临时 UTF-8 文件，以 --body-file 传入。

规格为父 issue，每票为一个子 issue，使用 GitHub 原生父子与 blocked-by 关系。使用 gh api 返回的 numeric database id 建立关系；如果平台不支持原生关系，在正文保留明确 Parent / Blocked by 引用并报告降级。

## 领取与依赖

每次开始前读取票据正文、评论、依赖及上游交付证据，区分本地工程、真实联调和上线验收。现有 blocked-by 保留完整交付依赖，不以删除依赖或提前关闭上游来放行本地工作。

用户已授权先完成本地开发与测试。下游本地实施可以在上游 issue 仍 OPEN 时开始，但须逐项记录：本票所需的上游接口/数据契约已有合并 PR，相关 TDD、测试及审查有证据；剩余阻塞仅为真实账号、设备、供应商、商业参数或环境验收。参数未冻结时只能使用明确隔离的合成配置验证既定契约，未知业务规则保持待定。上游所需代码或契约未交付时，继续等待。

开始本地工作时在本票记录所消费的 PR/提交、验证结果、未满足的真实条件和允许范围。ready-for-agent 表示规格可执行；ready-for-human / needs-info 表示仍有人工或信息条件，均不能单独证明可领取、可关闭或可上线。

验收证据按[父规格的唯一归属](../delivery/2026-10-22/spec.md#验收复用与唯一归属)复用：引用适用提交、配置与环境的责任票记录，消费者补新增集成。缺失或受影响部分仍须验证，不以链接代替不适用的证据。

## 完成与关闭

- 工程交付：本票范围的 PR 合并，相关测试与审查完成，附可复现证据；据此判断下游工程前提是否满足。
- 本票验收：本票明确负责的真实平台、设备、内容审校或实物证据齐全；缺失项保持未勾选，issue 保持 OPEN。验收须使用适用的真实上游参数与服务。
- 环境与上线：T29 集中验收正式部署、实际管理员 MFA、云资源与恢复；T30 汇总全链路、目标用户、实物与售卖门槛。T01–T28 的本票关闭不反向等待 T29/T30；需公网联调时使用获授权的隔离联调环境，其证据不替代 T29。

新功能以 ticket 分支交付，PR 关联对应 issue。仅工程交付或模拟通过时用 Refs；本票全部验收完成且 PR 合并后才用 Closes 或关闭。T07 的正式环境项归 T29，不再作为 T07 的重复关闭条件。本次规则修订不自动关闭任何 issue，也不追认新增验收项通过。父规格 issue 在全部业务及上线验收完成后关闭；真实资金、生产交接、采集和售卖继续遵守相应授权及准入条件。

PRs as a request surface: no.
```

## docs/agents/triage-labels.md

```markdown
# Triage labels

| 角色 | 标签 | 意义 |
| --- | --- | --- |
| needs-triage | needs-triage | 外部输入待评估 |
| needs-info | needs-info | 待补充事实或证据 |
| ready-for-agent | ready-for-agent | 已规格化，实施前仍检查依赖 |
| ready-for-human | ready-for-human | 需要人类决策或实际操作 |
| wontfix | wontfix | 明确不实施 |

由 to-tickets 生成的票据不重复 triage。标签不替代依赖、验收记录或完成状态。按 [Issue tracker](issue-tracker.md) 分别判断工程前提与真实验收；ready-for-human / needs-info 的票仍可推进已获授权、上游工程前提已满足的本地范围，并保留未完成的外部条件。
```

## docs/agents/domain.md

```markdown
# Domain docs

项目采用单一业务上下文。业务探索前读取根 GLOSSARY.md，进入版本、授权、录音、大纲、工程或发布主题时读取 docs/adr 下对应已接受 ADR。

使用词汇表术语描述票据、接口和测试。新的不易逆转决策记录 ADR；与已有 ADR 冲突时先指出冲突及证据，不静默覆盖。目标能力与实际运行结果分开描述。
```

已采用 AGENTS.md；仓库此前没有 AGENTS.md 或 CLAUDE.md。测试边界见 [实施规格](spec.md)。
