# CI 交付流程调整证据

本次工程调整独立于业务票；T10 的支付修复与真实验收不由本记录替代。范围为取消功能分支 push 重复检查、纯说明文档轻量检查及 PR CI / 双轴审查并行；未加入缓存或复杂测试调度。

## 实现与边界

- PR 和 main push 保留 `Check`；同一 ref 新提交取消旧运行。
- 分类只允许普通说明 Markdown，代码/迁移/依赖/工作流、JSON、资源、可执行位和符号链接变化保守走原完整链路；代码改名同时检查原路径。差异不可读取直接失败，空差异完整检查。
- 文档检查验证差异、仓库内文件链接和当前票据结构，不固定 30 / 45 数量。历史断链单独计数，Git 外证据、个人绝对路径、外部 URL 及标题锚点不作可用性证明。
- 最终同名 `check` 使用 `always()`，只在分类及对应检查成功、未选分支确实跳过时通过；取消/失败/无输出均不变成绿灯。完整检查继续运行原 PostgreSQL/Redis、类型、行为、构建、OpenAPI 和浏览器步骤。
- 本地行为 TDD、相关回归和 Mac 原生验证继续；代码稳定后固定提交，同时启动最终 PR CI 与双轴审查；修复后的最终提交全部通过才合并，再开始下一票。main 检查保留用于集成回归。

## 本地执行证据

Node 22.23.4，以 CLI 驱动真实临时 Git 仓库，未 mock Git/文件系统或复制 workflow 文本作断言。`node --test tests/ci/*.test.mjs` 最终 **6/6**，约 2.1 秒；这只是该组本地测试耗时，不是远端 CI 节省数据。

- 分类：首次缺少 CLI 失败，最小实现后通过；验证 Markdown、混合代码、代码改名/删除、可执行位、符号链接、docs JSON、空差异与无效 ref。
- 文档：新增断链与删除被引用文档先失败，修复后通过；历史未解决链接与 Git 忽略证据分别处理。
- 票据：缺验收章节先失败，补齐后通过；未知依赖失败，不依赖固定图规模。
- gate：缺入口先失败；选中任务 failure/cancelled/skipped、分类失败/缺输出、未选分支意外 failure 都失败；docs/full 的合法成功组合通过。
- 差异错误的初次诊断未显示 Git stdout，测试捕获后修复；尾随空白错误可直接定位。

RED/GREEN 日志位于本机 `/tmp/timenook-ci-01-classification-red.log` 至 `/tmp/timenook-ci-12-final-green.log`，不提交临时仓库或日志。Node 语法、Prettier 与 `git diff --check` 通过；未机械重复本地应用全量。远端 Actions 及独立审查由最终固定提交记录。

## 用户给出的历史 PR 验证

对 PR #42 的实际 50 个 Markdown 变更运行现有 CLI，不修改历史文件：

```bash
node scripts/ci/check.mjs classify 18363fd^ 18363fd
# docs
node scripts/ci/check.mjs docs 18363fd^ 18363fd
# Documentation links and diff passed; 0 pre-existing unresolved links unchanged.
```

两条命令 exit 0。因此该类纯规格变更走轻量路径；实际远端时间仍需以合并后的运行记录衡量。当前工作流/脚本本身的 PR 属于代码调整，仍走完整检查。
