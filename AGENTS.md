# TimeNook 工程约定

先读 CONTEXT.md。实现业务票据前读 GLOSSARY.md、对应 ADR 和票据引用的规格；已定方案与运行验收分别记录。

当前为开发阶段。方案或配置调整时直接更新相关文档和项目记忆，以最新方案为准；无需为开发版本保留兼容层或迁移要求。

## Agent skills

### Issue tracker

规格和 tickets 使用 brycezhang/timenook 的 GitHub Issues；读取、依赖、状态与交付约定见 docs/agents/issue-tracker.md。

### Triage labels

采用五个默认 triage 角色；ready-for-agent 仍须检查阻塞依赖。映射见 docs/agents/triage-labels.md。

### Domain docs

单一业务上下文，使用根 GLOSSARY.md 和 docs/adr；消费规则见 docs/agents/domain.md。

## 验证与交付

按当前 ticket 的公开边界逐条实现并验证。数据库唯一性、锁和恢复使用真实 PostgreSQL/Redis；真机、供应商与实物结果分别记录。只提交本票范围的变更与必需锁文件，保持凭据和私人样本在 Git 外。
