# Triage labels

| 角色 | 标签 | 意义 |
| --- | --- | --- |
| needs-triage | needs-triage | 外部输入待评估 |
| needs-info | needs-info | 待补充事实或证据 |
| ready-for-agent | ready-for-agent | 已规格化，实施前仍检查依赖 |
| ready-for-human | ready-for-human | 需要人类决策或实际操作 |
| wontfix | wontfix | 明确不实施 |

由 to-tickets 生成的票据不重复 triage。标签不替代依赖、验收记录或完成状态。按 [Issue tracker](issue-tracker.md) 分别判断工程前提与真实验收；ready-for-human / needs-info 的票仍可推进已获授权、上游工程前提已满足的本地范围，并保留未完成的外部条件。
