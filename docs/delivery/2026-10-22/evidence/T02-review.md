# T02 独立双轴审查

范围为 #3 的本地受控录音、封存及回听实现；真实微信、OSS/RAM 和双端验收尚未具备条件，保持票据打开。用户已明确本轮先完成本地开发与测试。

初审固定基线 `b3e19533d99f4a0fe3b829782210b15db318419a`，提交 `14c3faeba5d2e3e259f6e54c606d73970f647753`。命令：`git diff b3e19533d99f4a0fe3b829782210b15db318419a...14c3faeba5d2e3e259f6e54c606d73970f647753`。提交列表仅 `14c3fae feat(probe): add controlled audio save and private seal flow (#3)`。

规范来源为 AGENTS.md、CONTEXT.md、GLOSSARY.md、docs/agents 下的 tracker/domain/triage 约定、工程对齐、本地开发与音频 probe 说明，以及 ADR 0006/0009。仓库没有 CODING_STANDARDS.md 或 CONTRIBUTING.md。两名独立审查者分别检查规范与 live #3/实施规格/流程与接口/PRD，未互相代替验收。

## Standards

初审明确规范违约 **0**；判断性异味 **1，最高 P3**。

- 可能的 Duplicated Code：`AudioProbe.storageScope` 与操作员清理 CLI 重复存储配置指纹算法。该指纹同时控制 API 隔离和清理筛选；建议提取共享函数，避免未来只改一处导致漏清样本。当前没有运行故障证据，不属于合并阻断项。

规范来源优先于 Fowler smell baseline；上述为维护性判断，不将工具已强制的格式要求算作问题。

## Spec

初审 **1 项，最高 P2**；属于已实现但行为错误。未发现本轮范围内的独立缺失或范围扩张。

- 已有本机片段时开始新录音，再上传旧片段，会把共享 `stage` 改成 `uploading`；`stop()` 仅在 `stage === recording` 调原生停止，页面也隐藏停止按钮。随后 `onHide()` 无法停止并保存。独立审查者使用实际服务与微信边界替身复现 `recording → uploading → onHide`，原生停止调用为 0，预期为 1。违反 T02 的后台/中断覆盖及《流程与接口》第 84 行录音生命周期要求。须分离麦克风状态，或明确禁止上传/录音并发，并覆盖双向顺序。

## 修复与复审

修复提交 `963bd27714dea82922cf5fadf900f707eebc9bdb`，增量为 `git diff 14c3faeba5d2e3e259f6e54c606d73970f647753...963bd27714dea82922cf5fadf900f707eebc9bdb`。

- Standards 复审：API 与清理 CLI 统一调用 `probeStorageScope`，旧重复算法已删除，指纹语义未变。原项关闭 1，新增 0，剩余 0，无剩余严重项。
- Spec 复审：录音、请求权限和保存期间禁止上传；上传与封存期间禁止开始录音，页面按钮同步限制。原触发顺序重跑结果为上传请求 0、原生停止 1、最终本机片段 2；原 P2 关闭。新增 0，剩余 0，无剩余严重项。

两名审查者分别独立运行真实页面与服务测试 `pnpm exec tsx --test tests/audio-probe-page.test.ts`，各自 4/4 通过，包括双向互斥、离开保存与 release 禁用；没有重复全量测试或连接真实服务。

修复后最终 `pnpm check` 前端 47/API 76，共 123 项通过；16 页 native 编译通过。未改锁文件、公开接口或迁移。主 Agent 核对原始日志 `/tmp/t02-review-final-check.log`、`/tmp/t02-review-native.log`。最终提交的 Linux CI 结果以 [PR #37](https://github.com/brycezhang/timenook/pull/37) 为准；合并门禁要求该提交全部检查通过。

主 Agent 在初审提交独立读取验证：前端 45/API 76 项测试全通过；6 条数据库迁移 checksum 全部一致；t02 schema、Redis keys 和 public probe rows 均为 0；根环境文件权限为 600。初审没有改动共享服务器或真实供应商资源。

最终汇总：Standards 剩余 0，最高严重度无；Spec 剩余 0，最高严重度无。代码审查通过不能替代 #3 的真实云端和双端验收。
