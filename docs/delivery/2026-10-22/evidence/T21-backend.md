# T21 后端工程证据

## 范围与固定关系

消费 T20 PR #56 / `f7afd8c` 的 `BookAudioEntry`、书稿故事引用和已冻结的有序原声清单，以及 T10 的旧销售政策快照、T11 的当前身份/用途/epoch 和 T14 的 Media 鉴权读取。沿用 T20 的 `books` 合成配置门禁，不新增生产准入或数据库迁移。

- `GET /v1/book-audio/:entryId`：先验证产品会话，再在当前项目/主体授权事务内解析随机稳定标识。只返回固定故事修订的标题、版本与原声清单；不读取在线最新稿。未知/未授权响应不含私人标题、缩略图或清单。
- `GET /v1/book-audio/:entryId/clips/:clipId/content?epoch=N`：要求解析结果的当前 epoch 和确切片段成员，复用 `Recordings.content` 与 `sendAudio`；返回鉴权二进制或 Range，不返回或跳转 OSS URL。
- 每次解析及下载前后重查当前身份/绑定/共享用途、独立 `playback`、`originalAudio` 保留期限、确切修订的最新本人决定、资产和配置范围。临时存储读取期间发生撤权、会话撤销、恰好到期或配置漂移，均不交付文件。
- 历史入口不要求当前书稿仍可生产，也不绑定在线当前故事版本、制作期限、确认稿或 PDF 的独立保留期限。已冻结的同一修订保持原关联；本人对确切修订撤回许可时仍拒绝。

公开 `BookAudioEntryView.clips[].sequence` 是 T20 书稿内固定的零起始位置；它与录音表中的一开始计数不同。`accessExpiresAt` 取当前受限授权、旧销售回听期限和原声保留期限中的最早值。

## HTTP 与真实依赖验证

测试经实际 HTTP、真实本地 PostgreSQL/Redis，微信、支付、ASR/文本与对象存储属于明确合成边界。断言读取公开响应和实际二进制；历史交付、资料移除及慢存储读取使用受控夹具，不当作真实履约或 T26 删除验收。

| 检查                   | 结果及日志                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首个入口解析切片       | 新 HTTP 行为先 404（应 200），实现后通过；`/tmp/timenook-t21-backend-resolve-{red,green}.log`                                                        |
| 私有下载与 Range 切片  | 新下载先 404（应 200），复用 Media 后通过；`/tmp/timenook-t21-backend-download-{red,green}.log`                                                      |
| 响应 envelope 联调修复 | 浏览器发现成功响应漏掉 `meta.requestId`，新增 HTTP 同请求 ID 断言先 RED 后 GREEN；定向 **1/1**，`/tmp/timenook-t21-backend-envelope-{red,green}.log` |
| T21 最终 HTTP 回归     | **13/13**（9 个顶层场景及 4 个慢存储子场景）；`/tmp/timenook-t21-backend-final.log`                                                                  |
| 受影响原有行为         | Book PDF **21**、录音 **20**、身份/参与 **17**，连同新增 13 项合计 **71/71**；`/tmp/timenook-t21-backend-regression.log`                             |
| 最终静态验证           | API typecheck 与测试 TypeScript 编译通过；`/tmp/timenook-t21-backend-{typecheck,compile}-final.log`                                                  |

13 项包括：讲述者及已授权发起人读取；未知/未授权者不泄露；完整文件/SHA 与 Range、无 OSS 跳转、非成员和过时 epoch；在线改稿/新书稿/API 重启保留历史入口；共享撤回/重新授权/采集撤回；确切修订许可撤回；缺失对象/移除入口；旧销售快照与制作/PDF/确认稿独立期限；回听到期前一毫秒、恰好到期与到期后一毫秒（含 Range）；原声先到期；换绑后旧账号/旧 epoch 失效及新账号重新授权后的固定历史关联；慢读取期间共享撤回、会话撤销、期限到达与配置漂移。

浏览器联调另发现 resolver 成功响应缺少公共 envelope 的 `meta.requestId`，客户端因此拒绝读取。已在同一公开 HTTP 边界加入请求 ID 与响应头一致性断言，旧实现稳定失败，补齐 controller envelope 后通过；该修复不改变固定关系、权限或文件读取。上述 71 项及 13 项保留在各自适用实现范围，envelope 最终增量使用定向 1/1 及重新测试编译验证，不合写成一次新全量。

测试夹具最初尝试直接删除仍有外键引用的资产，PostgreSQL 按约束拒绝。已改为实际移除对象及入口元数据；该夹具故障不计业务 RED，不放松数据库约束。

复现（仓库规定的 Node 22、pnpm 10、本地 `.env` 与 FFmpeg/FFprobe 8.1.1）：

```sh
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
cd apps/api
node --env-file-if-exists=../../.env --test dist-test/test/book-audio.test.js
node --env-file-if-exists=../../.env --test dist-test/test/book-audio.test.js dist-test/test/book-pdf.test.js dist-test/test/interview-recording.test.js dist-test/test/participation.test.js
```

## 尚未验收

真实微信/双端扫码、登录恢复与账号切换、实际录音回听、已印实物版本与服务到期仍须真实参数/账号/设备。T20 的候选 `.invalid` 入口不代表正式可扫码码生成，T22/T23 的确认/生产/交付尚未实现。T26 负责完整删除流程；本票只在既有授权及可用数据边界拒绝访问，不把到期或拒绝响应说成资料已删除。没有部署云端、采集私人素材或接通真实资金；工程交付、票据验收及上线分别记录。
