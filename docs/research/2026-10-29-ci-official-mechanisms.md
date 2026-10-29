# CI 提速机制：官方资料核对

核对日期：2026-10-29。本文只记录机制及适用边界，不代表已修改 CI，也不承诺提速倍数。仓库观察基于当前工作区的 `.github/workflows/check.yml`、`package.json`、`apps/api/package.json` 和 `playwright.admin.config.mjs`。资料经 Context7 与官方网页交叉核对。

## 1. 按变更选择检查与汇总门禁

- GitHub 在**整个 workflow** 因 `paths`、分支或提交消息过滤而跳过时，相关 required check 可能保持 Pending，阻止合并；job 因 `if` 条件跳过则按 Success 处理。依赖失败的 job 可能被连带跳过，所以最终门禁应显式检查预期 job 的结果。
- 当前已有 `changes → docs/full → check`，最终 `check` 使用 `always()` 并调用自有 gate；继续扩展选择粒度时应保留这个汇总模式，校验“预期执行集合”，避免误把取消、失败或异常跳过视为成功。
- 选测规则无法识别路径、无法取得 diff、公共协议或构建配置发生变化时，回退全量属于本项目应明确实现的策略，并非 GitHub 自动保证。

来源：[GitHub required checks 排障](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)、[状态检查语义](https://docs.github.com/en/pull-requests/reference/status-checks)。

## 2. 并发与矩阵

- `concurrency` 配合 `cancel-in-progress: true` 可以取消同一分组的旧运行；不同 workflow 应使用不同分组名。当前仓库已配置，不能把它计为新的提速收益。
- matrix 可把分片分散到多个 runner，`max-parallel` 控制同时运行数；`fail-fast` 默认 true，某个矩阵项失败会取消其他运行中或排队项。需要收集完整审计结果的全量运行可评估 false。
- 分片缩短的是墙钟等待；重复安装、服务启动、编译和排队可能增加总 runner 用量，实际收益必须测量。

来源：[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[矩阵任务](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)。

## 3. Node 测试分片与耗时报告

- Node 22 已支持 `--test-shard=1/3` 等参数；原生分片按**测试文件**等分，不按历史耗时均衡，也不自动判断哪些变更影响哪些测试。
- `--test-concurrency` 限制同时执行的测试文件数，通常默认 `os.availableParallelism() - 1`。它没有数据库、Redis、临时目录或端口的隔离语义。
- 可用内置 JUnit/TAP reporter 或 `TestsStream` 自定义 reporter 收集测试名、状态和耗时；官方提醒文本 reporter 的精确格式可能变化，持续自动分析宜使用结构化事件。报告只保留必要元数据，避免收集业务输入和凭据。
- 本项目涉及真实 PostgreSQL/Redis 的锁、唯一性和恢复测试，分片需独立数据库/命名空间等隔离；不能通过提高并发参数替代。

来源：[Node 22 CLI：分片与并发](https://nodejs.org/download/release/v22.20.0/docs/api/cli.html#--test-shard)、[Node 22 test reporters](https://nodejs.org/download/release/v22.20.0/docs/api/test.html#test-reporters)。

## 4. Playwright 分片与记录边界

- 官方 CI 指南建议默认 `workers: 1` 优先保证稳定性，更广的并行可使用多个 CI job 分片。单 runner 盲目增加 worker 可能加剧资源和共享状态冲突。
- `--shard=1/3` 支持跨 runner 分片；`fullyParallel: false` 时按文件分片，较大的文件会造成拖尾；true 可细分至测试级，但应先确保每条测试独立。
- 当前项目 `workers: 1`、`fullyParallel: false`，且因密码输入/MFA seed 泄露风险关闭 trace、screenshot、video。提速和耗时分析保持这些设置，使用不包含页面或请求内容的受限 reporter 元数据。
- 官方不推荐默认缓存浏览器二进制：缓存恢复可能与下载耗时相近，而且 Linux 系统依赖不能随该缓存复用。若引入预装镜像，应固定 Playwright/浏览器版本并单独评估拉取成本。

来源：[Playwright CI workers 与缓存](https://playwright.dev/docs/ci)、[分片与均衡](https://playwright.dev/docs/test-sharding)。

## 5. 缓存与构建产物

- `actions/setup-node` 支持 pnpm 等包管理器的全局包数据缓存；`cache-dependency-path` 可指定锁文件，**不会缓存 `node_modules`**。即使命中也仍需安装和执行必要生成步骤。
- 缓存用于可重新生成的依赖/中间结果；artifact 用于保存和跨 job 传递测试结果、构建产物，两者职责不同。缓存丢失时 workflow 必须仍能完成。
- `upload-artifact@v4` 产物不可变，各 matrix 项需唯一名字。官方下载动作会计算并比较 digest，但不匹配时仅发出警告，不能把这个自动校验单独当作发布阻断门禁。
- **项目推导**：若将候选打包或全量回归移到发布阶段，应绑定不可变 commit SHA、run/artifact ID 与候选包校验和；只有同一候选通过完整验证后才可提升至部署。继续显式验证现有 `.sha256`，不应下载“最新一次成功”的任意产物。PR 合成 merge SHA 与真正进入 main 的 SHA 也应明确区分。

来源：[setup-node 缓存说明](https://github.com/actions/setup-node#caching-global-packages-data)、[缓存与 artifact 的区别](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)、[artifact 不可变性](https://github.com/actions/upload-artifact#not-uploading-to-the-same-artifact)、[artifact digest 校验](https://docs.github.com/en/actions/tutorials/store-and-share-data#validating-artifacts)。

## 使用限制

这些机制不证明本项目可以安全删减某组测试。需结合运行耗时、业务依赖、测试 fixture 隔离和公共入口决定。真实资金、供应商、微信真机和实物验收继续单独记录；CI/CD 自动检查不能替代这些结果。
