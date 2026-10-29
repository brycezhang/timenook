# TimeNook CI 提速建议

日期：2026-10-29。第一阶段的完整回归并行及耗时报告已交付，实际结果见 [#73](https://github.com/brycezhang/timenook/issues/73)。第二阶段已实现 PR 官网独立分流，main 每次 push 完整回归；执行规则见[持续集成](../development.md#持续集成)，实际验收见[第二阶段记录](../delivery/2026-10-29/ci-phase2.md)及 [#76](https://github.com/brycezhang/timenook/issues/76)。下文保留调研时的基线；API/admin/小程序选测、fixture 语义简化、缓存及 CD 门槛迁移尚未采纳。最终 PR CI/独立审查和合并后 main 全绿门槛保持。

## 判断与证据

优先做分流修正、测试隔离和分片，再做按影响范围选测；建立可阻断发布的完整验证后，再调整 CI/CD 分工。当前主要瓶颈是 API 集成测试和串行浏览器测试，编译与依赖安装占比较小。

远端 main 为 `1b9a4741ce0ddd4f14c76bc98aa8f14781fcc58f`，本地当前 HEAD 为 `799274e6674087f1a4976624cf298e12ccd37d44`。以下现状以远端 main 和 Actions 日志为准；没有同步或覆盖本地修改。

最新一次成功 main 运行 [40707495160](https://github.com/brycezhang/timenook/actions/runs/40707495160) 的端到端时间为 43 分 16 秒，full job 为 41 分 20 秒。各阶段如下，子阶段不能与父阶段重复相加：

| 阶段 | 耗时 | 含义 |
| --- | --- | --- |
| `pnpm check` | 29 分 52 秒 | 包括下列类型检查、测试与构建 |
| API 编译及测试 | 27 分 57 秒 | 570 条通过；纯测试 runner 约 27 分 42 秒 |
| 前端单测 | 约 7 秒 | 364 条通过，适合继续普遍运行 |
| 类型检查及生产构建 | 合计约 1 分钟 | 单纯优化 TypeScript/Vite 不是主要收益来源 |
| print 测试 | 44 秒 | 19 条通过 |
| release 单测 | 约 1 秒 | 6 条通过 |
| admin 浏览器测试 | 8 分 40 秒 | 排在 `pnpm check`、OpenAPI 之后 |
| 官网测试 | 15 秒 | 仍被放进整个 full job |
| 编译固定 FFmpeg 工具 | 1 分 7 秒 | 可缓存，但不足以解释四十多分钟 |
| pnpm 安装 | 19 秒 | 缓存属于后续优化 |

同日两次成功 PR 运行中，`pnpm check` 分别用 27 分 32 秒、29 分 22 秒，admin 浏览器测试用 8 分 16 秒、8 分 35 秒，说明主要耗时不只存在于一次 main 运行。来源：[T29 PR](https://github.com/brycezhang/timenook/actions/runs/40697882136)、[官网 PR](https://github.com/brycezhang/timenook/actions/runs/40699054210)。

把日志中的静态测试名匹配回文件后，`complete-export.test.ts` 的 25 条可匹配用例耗时合计约 806 秒，单条最长约 124 秒。这是用例耗时之和，不是整个文件的完整墙钟时间，也不等于可以直接减掉的时间；参数化名称和 hook 未完整计入。它足以说明：单纯按文件数量分四片会有长尾，应先拆独立场景和检查准备成本。

[PR #72](https://github.com/brycezhang/timenook/pull/72/files) 只有六个 Markdown 文件变化，但 `apps/website/README.md` 不符合现有 `docsPath` 白名单，因而触发 full。其 [运行 40710658194](https://github.com/brycezhang/timenook/actions/runs/40710658194) 用了 26 分 46 秒，并在 `book-audio` 测试中遇到 `pending` / `completed` 断言失败。失败根因未经复现，不能直接宣布为 flaky；这既是分流缺口的实例，也说明需要记录首次失败时间与最终结束时间，避免只观察总耗时。

配置来源：[当前 Check](https://github.com/brycezhang/timenook/blob/1b9a4741ce0ddd4f14c76bc98aa8f14781fcc58f/.github/workflows/check.yml)、[根 scripts](https://github.com/brycezhang/timenook/blob/1b9a4741ce0ddd4f14c76bc98aa8f14781fcc58f/package.json)、[分流器](https://github.com/brycezhang/timenook/blob/1b9a4741ce0ddd4f14c76bc98aa8f14781fcc58f/scripts/ci/check.mjs)。官方机制另见 [核对记录](2026-10-29-ci-official-mechanisms.md)。

## 第一批：保持现有完整验证范围，先缩短等待

1. 将 `apps/*/README.md` 等明确为说明用途的普通文件纳入轻量白名单。不要直接放行所有 Markdown；被运行时消费的模板、资源、可执行位、符号链接及重命名旧路径继续判断。补分流器的边界验证，保留最终 `check`。
2. 拆开 `pnpm check` 的阶段，分别输出耗时与结果；记录测试文件、用例名称、状态、setup/teardown 和实际执行清单。默认仅保存这些元数据，保留现有浏览器 trace/screenshot/video 关闭设置。
3. API 尝试四个独立 runner，admin E2E 尝试两个独立 runner，类型检查、前端单测、print、官网放到合适的并行任务。浏览器任务只依赖必要编译与 fixture 准备，解除对“API 全量测试已跑完”的串行依赖。
4. 每个 shard 独立 PostgreSQL/Redis 服务、schema/key prefix、隐私台账目录、临时文件及进程端口。先保留单 runner 的 `workers: 1`，不通过盲目提高单机并发来抢资源。
5. 按历史文件耗时做稳定分组；先把 `complete-export.test.ts` 拆成相互独立的授权、ZIP 内容、流中撤回/过期、替代交付等场景。跨进程锁、崩溃恢复、数据库唯一性和授权竞态继续使用真实依赖。
6. 计时 `readyFirstCopyBook` 等昂贵准备、每次迁移和 PDF/照片生成。保持少量贯穿完整前序链路的消费者集成，其余用例可评估建立真实持久化的最小前置状态，保留当前断言所针对的真实业务执行。需要重新验证其合法状态与事务边界，不能用 fixture 绕过本测试的被测规则。
7. `startBookFixture` 每次执行 fresh/replay 两次迁移；恢复测试还在 beforeEach 重建。可评估在每个 runner 验证一次当前迁移及重放，再从同版本干净模板克隆业务 schema/数据库。迁移、备份恢复和升级测试本身仍执行真实流程；不复用带业务数据的跨用例快照。
8. 固定工具缓存按 OS、架构、工具版本和构建脚本 hash 命名，并验证内容；pnpm store 按锁文件缓存。每个 job 仍执行必要安装与生成。FFmpeg 缓存优先于浏览器缓存，但排在测试调度之后。contracts/API 的重复编译也可以顺便收敛，收益预计较小。

第一批以 full CI 进入 10–15 分钟作为实验目标，必须经过实测校准。分片会增加总 runner 用量，需同时记录墙钟时间、runner 分钟、排队和失败率；现有样本不能支持 15 倍或 20 倍收益承诺。

## 第二批：沿已有边界做按影响范围选测

已有 `apps/website`、`apps/admin`、`apps/api`、`miniprogram` 和 `packages/contracts`，无需先拆微服务或引入 Nx/Turborepo。第一版用受版本控制的显式影响清单，API 内部先保守全量。

| 变更范围 | 建议 PR 必跑范围 |
| --- | --- |
| 纯说明文档 | 文档链接、diff 和票据结构检查 |
| 官网内部代码/素材 | 官网类型、构建、三个视口测试与官网打包；不启动业务数据库 |
| 小程序页面、preview | 便宜的完整前端单测、类型与构建，加受影响流程浏览器测试 |
| admin 页面/Vben | admin 类型与构建、受影响浏览器流程、必要前端单测 |
| API 单一业务模块 | 初期仍 API 全量；依赖清单成熟后再跑模块及反向依赖、跨入口链路 |
| contracts | API、admin、小程序消费者及相关浏览器链路；第一版保守全量 |
| Prisma/迁移、公共鉴权、privacy-journal、应用装配/公共配置、共享 fixture | 第一版全量 |
| 锁文件、CI/测试配置、底层 runtime 或未识别路径 | 第一版全量；后续只有证据充分再细分 |

这些是建议选择规则，不是现有实现。官网会消费自身目录外的品牌资源和发布脚本，必须显式把这些路径映射进去。小程序直接引用 `packages/contracts/src`，浏览器测试还会动态载入编译后的 API test fixture；仅使用 pnpm workspace 图或静态 import 图不足以描述影响范围。

业务模块的反向依赖按行为维护。例如支付变动可能影响权益、投产、退款；授权或台账变动可能影响音频、故事、书稿、导出和生产。除了同名测试，还需运行 HTTP、Worker、管理端、下载和恢复入口中实际受影响的组合。

选择器输出本次 changed paths、基准 SHA/候选 SHA、触发规则、预期 suite、实际执行 suite。未知路径回退全量；读取 diff 或规则出错时不得通过门禁，可尝试可靠全量执行，否则阻断。删除与重命名同时考虑原路径。

保留 `always()` 汇总 gate，并根据预期清单检查实际结果；缺失 shard、取消、失败、错误跳过、空测试集都不能冒充成功。全局类型检查和约 7 秒的前端单测没有必要一开始就做复杂的细粒度选择。

## 第三批：建立发布验证后，调整 CI/CD 分工

远端目前只有 Check workflow；已有候选打包和人工受控部署记录，不等于已存在能承接所有回归的自动化 CD 门禁。

建议先保持“最终 PR CI 成功、合并后 main CI 成功”的现有约定，用第一批减少等待。影响选择经过验证后再采用：

- PR：完整类型/构建、变更涉及的行为与集成、受影响 E2E；公共基础变动仍全量。
- main：快速集成验证；全量可按 main 候选或夜间执行，作为独立的回归与选测审计。
- release verify：对准备发布的明确 main SHA 执行完整回归、迁移/恢复和 Linux 原生依赖验证，绑定同一构建候选；部署前校验包完整性，部署后做环境健康、入口、配置及必要回滚检查。
- 微信真机、真实资金、供应商、实物结果继续按现有责任记录，不能由自动化绿灯推定通过。

移到发布门槛的适合对象是环境专属检查、完整恢复演练及与本次变更无关的长链路矩阵。涉及迁移、锁、台账或授权的变更，在 PR 就触发相关完整检查；不能把所有高价值集成仅留给夜间。

候选提升记录 commit SHA、workflow run ID、artifact ID、校验和和完整验证结果。PR 合成 merge SHA 与实际 main SHA 需分别记录；不得用“最近一次成功”替代同一候选的结果，完整验证失败的候选不得发布。GitHub artifact 下载的自动 digest 校验不匹配仅产生警告，需继续显式 fail 校验现有 `.sha256`。

当前 issue tracker 要求代码/迁移/依赖/工作流等完整 CI，且下一票合并前等待 main 全绿。改变这些门槛需要同时修订 `docs/agents/issue-tracker.md` 和 `docs/development.md`，不能只改 YAML。读取 branches API 时 main 的 `protected` 为 false；若将 gate 作为平台强制门槛，还需另行核对和配置适用的 ruleset/分支规则，不能从 job 名称推断已强制执行。

## 用全量结果审计选择器

先做影子模式：选择器预测要跑哪些 suite，但仍运行全量。保存同一个候选 SHA 的预测/全量结果，核查是否存在“预测会跳过且全量失败”的 suite；先调查其根因与变更关联，再修依赖映射。

进入实际选测后，保留夜间全量和适当抽样全量；当失败需要回溯 PR 时，在保留的准确候选 SHA 上复跑完整测试。main 夜间失败也可能来自多次提交交互或测试不稳定，不能直接归因于某一个 PR 的选择器。

夜间代理可提出映射修订与补测 PR，不宜自动弱化高风险触发规则，也不应自动接受失败快照或靠无限 retry 抹平错误。累计样本覆盖不同变更类型，比单纯连续几次绿色更有说服力。

验收观察：PR p50/p95 首次反馈与最终通过时间、full p50/p95、最长 shard、shard 不均衡、runner 分钟、首次失败可见时间、非确定性失败、影子模式遗漏及发布前新发现回归。发现遗漏即扩大对应依赖闭包；数据库/锁/恢复测试必须持续保留真实依赖。
