# #105 最终 CI 失败诊断与测试范围修正

2026-10-29，PR #108；诊断起点 `5fd2aee143c2f687d0f1039c70487487a6d24ee6`。本轮不改生产业务代码，不合入尚未通过主干验证的后续代码，不操作云端。

## 实际失败

[Actions 40888229153](https://github.com/brycezhang/timenook/actions/runs/40888229153) 的 `api (3)`、job `123499105349` 唯一失败为 `privacy-upgrade.test.ts` 的 `a real pre-T26 upgrade imports actual historical refusals before an older readable backup can reopen access`。日志报告在 `explicit source and incremental upgrade` 阶段返回 `ok:false`，父测试断言 `false !== true`；不是制作资格的 `startsAt` 断言，也不是客服 grant 或安全 TTL 失败。

该测试从固定提交 `321f0e15a0687f458df6d60ad88bff793cd3c8d4` 执行旧代码、生成隔离的旧 Prisma client、建立实际 pre-T26 schema，随后要求增量迁移、旧密码/MFA 经办身份转换，以及旧数据库/文件备份恢复。CI 的公开日志没有底层私有诊断内容，本报告不臆测具体 SQL 错误。

## 决策依据与修正

用户已接受的 [ADR0017](../docs/adr/0017-lifetime-service-and-retention.md) 明确要求：

> 本次开发重构直接按新模型硬更新，必要时重建相关开发数据和测试夹具；不做旧数据迁移、历史有限期兼容、旧备份/旧台账恢复、备份准备或回滚演练，也不为这些旧开发场景保留测试。

据此退役整个固定历史版本升级/旧备份恢复测试，移除它专用的 `otplib` 开发依赖及无引用传递依赖、CI 调度权重，并更新当前测试/登录说明。没有增加旧 schema 兼容、数据迁移或日期占位回退；历史实际交付记录保留原日期和适用范围。删除过时测试本身不证明长期服务或任何权限行为通过。

## 同类范围核查

| 核查项 | 结果与处理 |
| --- | --- |
| 固定旧 Git 提交提取、pre-T26 schema、增量升级、旧版本备份恢复 | 测试代码只在已退役的 `privacy-upgrade.test.ts` 存在，无第二套同类执行器 |
| 制作资格 `startsAt`、旧参与起算名称 | 剩余断言比较同一激活事实在重放/换绑前后保持不变，没有未参与即未激活或业务到期要求；两个测试名称改为保留长期服务激活事实 |
| `expired`、暂停/恢复及有界时间 | 现有安全会话、上传/下载能力、客服授权、任务 lease、D06/D07 和供应商临时副本各自时限继续保留；不按关键词删除有效约束 |
| 当前独立台账、撤回/删除、当前进程重启和持久恢复 | 保留 `deletion-recovery`、`deletion`、授权/活动流与相关测试；当前二进制/当前 schema 的持久恢复不属于固定旧版本兼容测试 |
| AI 探针的冻结版本输入 | 固定技术配置/UUID 不可提交另一版协议的安全用例与本票业务服务期限无关，保留 |
| CI 测试发现 | 仍动态纳入全部现行 API 文件；本地核查55个文件分入4片且各执行一次，退役文件不再被选择 |

## 增量验证

公开边界沿用真实回环 PostgreSQL/Redis、HTTP/进程维护入口。先编译 `dist-test`，再以 `--test-concurrency=1` 精准运行当前模型的必要保留行为：跨2099维护/重启保留资料，质量授权与核验删除，独立拒绝发布后进程 SIGKILL/重启与 HTTP 重试，两项换绑/协助激活事实稳定性，安全授权精确到期，以及授权/会话事务回滚。7条全部通过，日志 `/tmp/timenook-105-final-ci-fix-current.log`；这些保留行为的实际结果与退役旧用例分别记录。

CI 分片调度4条测试通过（`/tmp/timenook-105-final-ci-fix-shards.log`）；实际文件发现为55个API文件、4片分别14/13/14/14，各纳入一次。不重跑已适用的243条或52条全集，也不将先前51通过/1失败的运行追认为全绿。最终提交仍须新的 PR CI 与双轴增量审查通过。
