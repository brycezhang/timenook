# T20 书稿快照与完整 PDF

本票把 T19 的确定故事版本接入 T04 的固定排版与 T15 的共享任务。接口与小程序页面用于本地合成环境的工程验证；D01 印厂规格与 D08 实际标识准入仍待责任票验收，不能据此提交正式生产。T21 的版本固定回听见[书中原声入口](development-book-audio.md)；T22 双方确认与首本预留见[首本制作](development-first-copy.md)，实际生产交接由 T23 实现。

## 确定版本

生成请求携带最近查询的 `inputHash` 和 `Idempotency-Key`，在项目授权事务中一次保存封面书名、称呼与可选照片、个人大纲、实际入书目录、本人已确认且允许入书的故事版本、全文、照片及说明、原声清单、来源标识与候选规格。书封使用独立不可变版本；可选照片来自当前已确认且允许入书的故事素材，保存时校验确切资产，撤回来源许可后不能继续使用。二维码入口先分配后渲染；同一故事版本复用稳定入口，片段保持顺序。入口 ID 只是定位符，不能授予回听权限。

书稿与最终输出分别保存不可变快照/hash。后台只读取该快照，使用固定 Chromium、字体与共享分页内核，在受限子进程中渲染并独立检查实际 PDF 的文本、图片、二维码、纸张尺寸和页数。原声入口明确关联讲述者原始录音，人工校对后的文稿保留 AI 整理来源。候选标识版本不代表 D08 法规与供应商准入已核验。

实际目录、书名、入书故事正文/照片/原声或本人决定改变后，原待生产书稿失效，下载拒绝；新版本需重新生成。只修改未来采访问题不使已经冻结的内容失效。空章节留在目录编辑数据中，PDF 不为其补写故事。

## HTTP

所有接口使用产品会话 Bearer，重新检查当前项目/讲述者权限及期限；响应禁止缓存。

| 接口                                                   | 用途                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `GET /v1/projects/:id/book`                            | 查询输入 token、实际目录、可入书故事及最近书稿                       |
| `POST /v1/projects/:id/book/cover`                     | 携带书封 `expectedVersion` 保存称呼及可选 `photoAssetId`；照片可清除 |
| `POST /v1/projects/:id/book/directory`                 | 携带目录 `expectedVersion` 保存章节、顺序和故事归属                  |
| `POST /v1/projects/:id/book/versions`                  | 携带 `expectedInputHash` 冻结书稿并进入共享任务，返回 202            |
| `GET /v1/projects/:id/book/versions/:versionId`        | 查询同一版本、处理状态、目录页码及文件摘要                           |
| `POST /v1/projects/:id/book/versions/:versionId/retry` | 在合法权限与有限重试范围内重试当前渲染                               |
| `GET /v1/projects/:id/book/versions/:versionId/pdf`    | 鉴权下载完整 PDF，读取后再次核对权限与版本                           |

所有 POST 均须 `Idempotency-Key`。冲突或未知网络结果按原 key 查询/重放，不把超时当作已失败并另造一次书稿。小程序成书页的封面、节选、目录和页数均读取该版本；完整文稿页另提供完整 PDF。离页、换号及失权清除私有视图和下载临时文件。

`BookVersionView.coverPhotoAccess` 单独返回当前封面原图的许可与期限，不写入冻结快照或 hash。原图 `derivedPhotos` 到期只清理该预览；仍在 `bookPdf` 期限内且获当前授权的完整 PDF 保持可读。图片出现意外 403 时重新查询该书稿的权限，书稿拒绝访问或无法重新核验时清除私有状态。

冻结书稿的 `accessExpiresAt` 使用 `bookPdf` 与当前身份/共享权限的期限。`draftAccess` 另描述确认故事来源的编辑、生成和重试权限；`confirmedStories` 到期后，现有 PDF 仍按自身期限读取，但禁止新稿操作及继续渲染。此时总览 `inputHash` 为 null，可入书故事及封面素材选项为空，目录/书封只返回当前冻结快照或空默认值；当前内容、许可或配置变化仍会使旧稿失效。

## 本地验证

按[本地开发](development.md)准备 PostgreSQL/Redis、固定音频检查工具，按[印刷探针](print-probe.md)安装固定字体与 Chromium。`ApiConfig.books` 仅接受明确的合成测试配置，默认不注册这些路由，production 不允许启用。自动测试不加载共用服务的私人 key，不读云端数据库。

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
