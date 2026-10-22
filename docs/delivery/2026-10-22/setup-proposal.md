# 工程流程配置草稿

状态：待确认后应用；这些段落目前不会作为仓库规则加载。

建议：使用已指定 GitHub 仓库作为 tracker，保留五个默认 triage 标签，创建根 AGENTS.md；现有 GLOSSARY.md 和 docs/adr 保持单一业务上下文。以下是待写入各文件的完整文本。

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

每次开始前读取票据正文、评论和依赖，只领取所有阻塞票均完成的工作。ready-for-agent 表示规格可执行，不代表无依赖或外部验收已通过。外部证据未齐的工作标 ready-for-human 或 needs-info，并说明可继续的本地工作。

新功能以 ticket 分支交付，PR 关联对应 issue；PR 合并且票据验收证据齐全才关闭。仅实现/模拟通过时用 Refs，完整验收才用 Closes。父规格 issue 保持打开，全部业务及上线验收完成后再关闭。

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

由 to-tickets 生成的票据不重复 triage。标签不替代依赖、验收记录或完成状态。
```

## docs/agents/domain.md

```markdown
# Domain docs

项目采用单一业务上下文。业务探索前读取根 GLOSSARY.md，进入版本、授权、录音、大纲、工程或发布主题时读取 docs/adr 下对应已接受 ADR。

使用词汇表术语描述票据、接口和测试。新的不易逆转决策记录 ADR；与已有 ADR 冲突时先指出冲突及证据，不静默覆盖。目标能力与实际运行结果分开描述。
```

选择 AGENTS.md 是本次建议；仓库此前没有 AGENTS.md 或 CLAUDE.md，确认后才创建。测试边界见 [实施规格](spec.md)。
