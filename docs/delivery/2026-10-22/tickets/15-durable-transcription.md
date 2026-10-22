# T15 · 持久化文件转写、重试与异常接管

GitHub：[#16](https://github.com/brycezhang/timenook/issues/16) · 状态以 GitHub 为准。
阶段：S2

## 交付结果

每段封存录音自动转写，离开后可查状态；Worker/Redis 故障后能从原声恢复，不重复扣用户额度。

## 验收条件

- [ ] 业务任务、输入 hash/授权 epoch、额度意图和 Outbox 同事务写入；BullMQ 只调度，数据库是事实来源。
- [ ] 租约/fence 领取、结果前二次核验及唯一约束，阻止旧 Worker、撤回或删除后的结果生效。
- [ ] 固定供应商请求 UUID/配置，先持久化再提交，未知结果查原任务；异步等待释放 Worker，保存不可变正式转录。
- [ ] 通过真实 PostgreSQL/Redis 故障注入覆盖投递后崩溃、响应后落库前崩溃、Redis 清空和租约超时；逻辑重试不重复扣额。
- [ ] 小程序区分转写中/可离开/无有效语音/可重试，后台暂停轮询；管理端能看脱敏错误并按同一用例重试、审计。
- [ ] 保存提交整理、全部输入云端保存、排队、依赖转录完成及结果完成的关联时间；Worker/Redis 恢复不能重置端到端计时，失败与人工接管独立记录。

## 实现边界

复用 T03 供应商 adapter、请求号/状态映射和恢复规则；集中建立一套生产任务/Outbox/Worker与有限重试，供 T17/T18/T20/T25/T26 按需复用。异常由运营通过同一用例接管，不建工作流编排平台。

## 测试决策

- 覆盖模块：Story、任务/Outbox、供应商调度。
- 主入口：生产任务查询/重试 HTTP + 实际 Worker 与 PostgreSQL/Redis。通用约定见[父规格测试决策](../spec.md#测试决策)。
- 现有范例：[ai-probe.test.ts](../../../../apps/api/test/ai-probe.test.ts)、[audio-probe.test.ts](../../../../apps/api/test/audio-probe.test.ts)；仅作测试方式参考。

## 阻塞依赖

- [T03 · 验证豆包文件转写与 DeepSeek 生成质量](03-ai-provider-probe.md)
- [T14 · 接通分轮录音、本地恢复与云端封存](14-interview-recording.md)

## 工程前提与外部条件

工程前提：T03 ASR 状态/请求契约、T14 已封存片段与任务输入；真实供应商/Tair 单独验收。

真实豆包协议证据引用适用的 T03 记录并补生产集成；目标 Tair 环境兼容性归 T29，本地 Redis 结果不替代它。

执行[完成规则](../spec.md#依赖完成规则)与[证据复用](../spec.md#验收复用与唯一归属)；本票勾选与真实状态保持原有证据口径。

## 验收映射

A09、A10、X02、X03、R13。依据：[实施规格](../spec.md)及其中链接的已定稿 PRD/架构/ADR。
