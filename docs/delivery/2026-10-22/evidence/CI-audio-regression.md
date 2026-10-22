# main CI 音频探针清理回归

日期：2026-10-22。修复基线 `fd9ed2fb72519c54e8702793bb5ffe2b2c9202e9`，分支 `codex/ci-audio-probe-regression`。责任规格为 [T02](../tickets/02-audio-storage-probe.md)，既有工程证据见 [T02 验证记录](T02.md)。本轮只修测试夹具时序及失败诊断，不修改生产代码、支付、CI 工作流、迁移或下一票范围；T02 的 AppID/真机/OSS 外部验收仍未完成。

## 真实失败与复现

main 合并后 CI run `39804185632` / job `119913935179` 的 API 为 147/148，支付相关全部通过。失败的是 `audio-probe.test.ts` 中“operator cleanup removes only the selected probe identity and its objects, including after expiry”：用时 1215.85614ms，`formUpload` 读取 `form.fields` 时 form 为 undefined。原始日志保留在 `/tmp/timenook-t10-main-failed.log`，脱敏相关片段为 Git 忽略的 `output/pdf/ci-audio-logs/00-main-failure-excerpt.log`。

原夹具先以 `provision(1)` 生成只有一秒有效期的身份，再生成另一身份、启动 API、创建片段并申请上传表单；这些准备步骤也消耗该一秒。辅助函数未检查申请表单的 HTTP 状态，直接取 `.json().data`，所以实际错误被后续 TypeError 遮盖。原用例最后的固定1100ms等待也没有在清理之前验证身份确已过期，清理后的401还可能只是CLI撤销身份的结果。

先补申请表单的公开 HTTP 状态/错误码断言，再临时在“创建片段201”和“申请表单”两个真实 HTTP 请求之间加入1100ms慢客户端延迟。确定性 RED 为 **401 UNAUTHENTICATED**，阶段为 `issue upload form`，不是对象存储、数据库或表单结构错误。该延迟是诊断用的公开请求时序，不修改生产时钟、内部方法或鉴权结果；最终测试中已移除。

按可证伪预测，若一秒身份过期是原因，则正常准备有效期在相同延迟下应恢复表单201，而之后由真实Redis明确使身份到期仍应返回401；若是上传 capability 问题，应先成功拿到表单，再在对象上传出现403，和实际失败阶段不符。生产实现无需改变。

## 最小修复与 RED → GREEN

清理用例改为用既有正常有效期建立合成身份、完成片段上传，先通过 HTTP 确认目标片段200。随后只对本次随机 Redis 前缀内该身份的会话键执行 `PEXPIREAT` 到已过去的时间，等真实Redis完成过期，再通过同一公开HTTP确认 **401 UNAUTHENTICATED**。这样过期发生在准备完成之后，不依赖CLI进程或API启动耗时；Redis只用于隔离夹具准备，业务断言仍走HTTP、操作员CLI和对象存储。

继续执行现有操作员清理 CLI，验证退出码0、目标对象被移除、外来身份的片段仍可访问。删除原清理前固定sleep。上传辅助函数保留创建片段和申请表单的状态/错误码断言，未来失败会指向真实阶段，不再被 `data undefined` 掩盖。没有增加重试、延长生产TTL或引入生产时钟框架。

在保留同样1100ms诊断延迟的条件下，修改后的用例 GREEN 1/1；之后移除诊断延迟，完整音频HTTP回归10/10。RED与GREEN均使用真实 PostgreSQL/Redis、真实操作员CLI及本地对象adapter，未模拟内部鉴权或数据库。

## 验证结果

工具链：Node 22.23.4 / pnpm 10.34.7；`export PATH=/tmp/timenook-toolchain/node_modules/.bin:$PATH`。命令工作目录为 `apps/api`；日志目录为仓库下 Git 忽略的 `output/pdf/ci-audio-logs/`。

```sh
pnpm exec tsc -p tsconfig.test.json
node --env-file-if-exists=../../.env --test --test-name-pattern='operator cleanup removes' dist-test/test/audio-probe.test.js
node --env-file-if-exists=../../.env --test dist-test/test/audio-probe.test.js
pnpm run typecheck
pnpm run build
```

| 检查                                 | 结果                                                     | 日志                                       |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------ |
| 原一秒身份 + 控制请求延迟            | exit 1；申请上传表单401 UNAUTHENTICATED，确定性RED       | `01-cleanup-controlled-red.log`            |
| 正常准备TTL + 控制过期，保留相同延迟 | exit 0；1/1，过期前200、过期后401、CLI清理与外来隔离通过 | `02-cleanup-controlled-green.log`          |
| 移除诊断延迟后的音频HTTP文件         | exit 0；10/10；清理用例约341ms                           | `04-audio-regression.log`                  |
| API类型检查与构建                    | 均exit 0；测试TypeScript亦已编译                         | `05-api-typecheck.log`、`05-api-build.log` |
| 隔离资源、临时诊断与 whitespace      | exit 0                                                   | `06-cleanup.log`                           |

本轮没有更改前端、协议、锁文件或迁移，未机械重跑整仓、浏览器、原生编译或供应商契约。原检查证据按适用范围复用；最终提交由PR CI执行整仓回归，并与独立Standards/Spec审查并行，通过后才合并，main保留合入后检查。该文档不提前声明最终CI或复审通过。

所有测试使用随机t02 schema、Redis前缀、临时目录与合成音频/身份；结束后清理，不迁移public、不停止共享服务、不打印或提交token、连接凭据或私人样本。最终源码与本文的 SHA-256 清单见 `07-frozen-manifest.txt`；实现Agent不提交或推送，交付主Agent固定版本后继续质量门槛。
