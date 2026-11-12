# 书稿快照与完整 PDF

2026-11-12 当前目录与成书路径以 [MP05](delivery/2026-11-11/miniprogram-refactor/MP05-delivery.md)、[MP10](delivery/2026-11-11/miniprogram-refactor/MP10-delivery.md)和[当前业务流程](../designs/timenook-modern-2026-11-10/project/BUSINESS-FLOW.md)为准。长期服务以 [ADR 0017](adr/0017-lifetime-service-and-retention.md) 为准：制作、下载及其必要资料长期有效；长期服务工程调整见 [#105](https://github.com/brycezhang/timenook/issues/105)与[开发说明](development-lifetime-service.md)。历史有限期测试仅为当时结果；现行实现与原生验证分别记录在上述模块交付文档。

本票把 T19 的确定故事版本接入 T04 的固定排版与 T15 的共享任务。接口与小程序页面用于本地合成环境的工程验证；D01 印厂规格与 D08 实际标识准入仍待责任票验收，不能据此提交正式生产。T21 的版本固定回听见[书中原声入口](development-book-audio.md)；成员提交与首本预留见[首本制作](development-first-copy.md)，实际生产交接由 T23 实现。

## 确定版本

生成请求携带最近查询的 `inputHash` 和 `Idempotency-Key`，在项目授权事务中一次保存封面书名、称呼与可选照片、个人大纲、实际入书目录、已保存、允许入书且被章节引用的故事版本、全文、照片及说明、原声清单、来源标识与候选规格。书封使用独立不可变版本；可选照片来自当前项目照片，保存时校验确切资产，撤回来源许可后不能继续使用。二维码入口先分配后渲染；同一故事版本复用稳定入口，片段保持顺序。入口 ID 只是定位符，不能授予回听权限。

书稿与最终输出分别保存不可变快照/hash。后台只读取该快照，使用固定 Chromium、字体与共享分页内核，在受限子进程中渲染并独立检查实际 PDF 的文本、图片、二维码、纸张尺寸和页数。原声入口明确关联讲述者原始录音，人工校对后的文稿保留 AI 整理来源。候选标识版本不代表 D08 法规与供应商准入已核验。

实际目录、书名或入书故事正文/照片/原声改变后，普通书稿失效，普通预览下载拒绝；新版本需重新生成。已经提交制作的原 PDF 仍通过 `/fulfillment/book/pdf` 按制作绑定读取，不因后来改稿被替换。只修改未来采访问题不使已经冻结的内容失效。空章节留在目录编辑数据中，PDF 不为其补写故事。

## HTTP

所有接口使用产品会话 Bearer，重新检查当前项目/讲述者权限及安全授权有效期；响应禁止缓存。

| 接口                                                   | 用途                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `GET /v1/projects/:id/book`                            | 查询输入 token、实际目录、可入书故事及最近书稿                       |
| `POST /v1/projects/:id/book/cover`                     | 携带 `expectedMetadataVersion, expectedVersion, title, salutation, photoAssetId` 原子保存书名与书封；照片可清除 |
| `POST /v1/projects/:id/plan` | 携带 `expectedVersion, content` 保存统一目录、问题与故事引用 |
| `POST /v1/projects/:id/book/versions`                  | 携带 `expectedInputHash` 冻结书稿并进入共享任务，返回 202            |
| `GET /v1/projects/:id/book/versions/:versionId`        | 查询同一版本、处理状态、目录页码及文件摘要                           |
| `POST /v1/projects/:id/book/versions/:versionId/retry` | 在合法权限与有限重试范围内重试当前渲染                               |
| `GET /v1/projects/:id/book/versions/:versionId/pdf`    | 鉴权下载完整 PDF，读取后再次核对权限与版本                           |

所有 POST 均须 `Idempotency-Key`。冲突或未知网络结果按原 key 查询/重放，不把超时当作已失败并另造一次书稿。小程序成书页的封面、节选、目录和页数均读取该版本；完整文稿页另提供完整 PDF。离页、换号及失权清除私有视图和下载临时文件。

封面原图、衍生照片、确认稿、冻结书稿及 PDF 作为支撑长期制作/下载的资料长期保留。`BookVersionView.coverPhotoAccess` 只描述当前访问许可及安全授权有效期，不写入冻结快照或 hash；不再按资料类别服务期限自动清理预览或拒绝 PDF。图片出现意外 403 时重新核对权限，书稿拒绝访问或无法重验时清除私有状态。

冻结书稿的访问有效期只承担当前身份/共享权限的安全边界，不能成为业务服务截止。`draftAccess` 继续描述当前来源授权下的编辑、生成和重试权限；时间推进不因服务到期清空输入或阻止继续制作。当前内容、许可或配置变化仍使普通旧稿失效；制作固定稿另按预留绑定读取，权限拒绝与核验删除继续生效。

固定 PDF 活动流仍执行每块当前授权、版本/hash 和前后完整来源 fence 校验。全项目核验删除、权限拒绝、hold、故事许可否决、epoch 变化或未知/损坏拒绝依据均不得被长期服务绕过；来源 scope 由服务端确定，不能由用户 DTO 扩大。服务期限不再产生类别清理事件，原有期限例外不作为新方案的兼容要求。

## 本地验证

按[本地开发](development.md)准备 PostgreSQL/Redis、固定音频检查工具，按[印刷探针](print-probe.md)安装固定字体与 Chromium。本轮测试使用明确的合成供应商配置及隔离本地数据库。自动测试不加载共用服务的私人 key，不读云端数据库。

```sh
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
# 在 apps/api 目录运行，沿用项目规定的固定 FFmpeg/FFprobe PATH
node --env-file-if-exists=../../.env --test dist-test/test/book-pdf.test.js
```

```sh
# 以下在仓库根目录运行
pnpm exec tsx --test tests/book-page.test.ts
pnpm test:print
pnpm exec playwright test tests/admin/book-pdf.spec.mjs -c playwright.admin.config.mjs
```

运行结果、精确提交、逐页检查与未完成条件记录于 [T20 工程证据](delivery/2026-10-22/evidence/T20.md)，不以本说明代替验收。
