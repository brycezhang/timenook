# 内测书稿与同版确认

[W05 #100](https://github.com/brycezhang/timenook/issues/100) 复用既有故事版本、书稿快照、共享任务、Chromium 排版、PDF 内容检查和私有下载。`Books` 从项目准入读取书名，内部项目无需付款订单；生成仍只接受本人确认且允许入书的确定故事版本。

启用 `INTERNAL_ACCEPTANCE_ENABLED=1` 且已配置 `TIMENOOK_PRODUCT_OSS_BUCKET` 时，书稿使用 `internal-acceptance` 模式。`TIMENOOK_PRODUCT_STORAGE_ROOT` 是绝对路径；PDF 默认保存在其 `books/` 子目录，可用 `BOOK_STORAGE_ROOT` 指定独立目录。原声入口默认 `WEB_ORIGIN/app/audio/`，可通过 `BOOK_ENTRY_BASE_URL` 指定同一 HTTPS 网页源及相同路径。

内部候选规格固定为 A5，快照标识 `internal-acceptance-candidate`，渲染清单 scope 为 `internal-acceptance-book`，`productionReady` 始终为 false。它生成真实可检查的 PDF，不声称已取得印厂规格或商业标识准入。内部模式不注册首本预留、地址、履约、质量售后及对应后台接口，不创建付款或印刷权益。

两端复用完整书稿页：打开并校验 PDF 后，讲述者和发起人分别勾选、填写当次核对说明并确认。`GET /v1/projects/:id/book/confirmations` 返回当前双方状态；`POST` 同路径绑定 role、bookVersionId、snapshotHash、pdfHash、noticeVersion 和当次 evidenceRef，并要求 `Idempotency-Key`。确认复用既有不可变记录和命令表，服务端按实际绑定和会话记录本人渠道。内容确认不要求收货地址；原付费首本制作仍独立要求付款、权益、地址及同版确认。

书名、正文、目录、照片或许可变化后，旧书稿失效，双方旧确认不沿用；项目当前权限、撤回删除及临时文件清理继续由既有能力执行。

本切片定向验证覆盖真实 PostgreSQL/Redis、Chromium 生成及 PDF 检查、双方内容确认、幂等重放、改稿失效，以及共用手机页面的同版 hash 提交。供应商实际故事、OSS、公网域名及微信真机结果由统一项目的运行验收另记，不能由隔离合成用例推定。

`internal-media.test.ts` 还沿同一无付款 Cookie 项目完成邀请绑定、本人三个用途选择、可靠封存、转写、故事确认、实际 BullMQ Worker 生成 PDF、双方下载并校验同一个文件 hash、双方书稿确认；确认不会生成付款、微信身份、首本权益或制作单。该用例只替换 OSS 与 AI 外部传输边界，数据库、会话、文件校验、Worker、真实 PDF 排版和检查实际执行。内部模式 Worker 仅运行可用能力，完整导出的技术临时产物维护仍由配置了该能力的原有模式处理。
