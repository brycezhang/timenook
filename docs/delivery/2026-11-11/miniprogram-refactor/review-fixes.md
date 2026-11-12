# 集成审查修复

2026-11-12，基线 `13eba8b`。本记录只说明新增修复和对应工程验证，原生逐画板结果继续见 MP12 的实际证据。

- 正式包依赖遍历补齐 WXML `import/include`，保留地址、制作确认和生产进度使用的 `templates/print-book.wxml` 及传递引用；继续移除未引用的旧实现。回归先复现 `ENOENT`，修复后 5 项正式包测试通过。
- 恢复故事详情的「添加照片／照片与说明」处理器，进入当前项目、采访和故事的照片编辑页。点击边界回归先复现处理器缺失，修复后故事页 31 项测试通过。
- `pnpm typecheck:frontend`、`pnpm build:miniprogram` 和 `node scripts/check-native.mjs --built` 通过；官方 wcc/wcsc 编译 37 个正式路由。

## 已提交制作的固定稿

制作进度和固定稿预览改用成员接口 `GET /projects/:id/fulfillment/book`、`GET /projects/:id/fulfillment/book/pdf`。服务端按当前预留或制作尝试解析绑定，校验冻结快照、PDF 摘要和当前成员权限；下载复用 `ProjectStreams.userFence/guard`，读取和流式输出期间继续重验权限与制作绑定。普通书稿入口仍要求当前 `ready` 版本，新接口不开放任意旧书稿。

后台批准和交接使用提交时的固定书稿、地址及规格，继续重验当前权益、付款、生产冻结和资料权限。后续修改正文、封面或草稿地址不改变已提交制作；修改重提仍须先确认取消。原生 `manuscript?production=1` 和网页的「查看本次提交的书稿」已同步，固定稿页不能发起新的制作。

- 真实 PostgreSQL/Redis 的首本与履约共 25 项定向用例均已通过：整组先通过 24 项，新增用例修正 fixture 后单独补验通过；验证改稿后固定 PDF 摘要不变、普通旧稿下载仍 409、非成员和正式核验删除后访问均 403、原稿交接及取消后重提。未放宽既有资料访问语义。
- `book-page`、`print-pages`、`senior-flow`、`native-build`、`story-page` 共 64 项通过；前端及网页类型检查、API 构建、网页构建、37 页正式包及官方 wcc/wcsc 编译通过。
- Chromium 使用真实本地 API、PostgreSQL/Redis 走通提交制作、修改封面、从制作页打开固定 PDF；身份／支付／AI 仍为明确的 fixture，不作为微信或供应商验收。

这些结果不替代 DevTools 点击、真机、供应商或实物验收；未推送、部署或上传。
