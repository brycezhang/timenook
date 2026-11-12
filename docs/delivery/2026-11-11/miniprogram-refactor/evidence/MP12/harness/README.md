# MP12 原生验收 API 夹具

该入口只监听 `127.0.0.1:3428`，拒绝非 loopback 的 PostgreSQL／Redis。复用 `book-fixture` 的随机独立 schema、Redis 前缀与私有临时文件，退出时删除本夹具数据；不操作 3424／3426 或线上服务。

```sh
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
node --env-file-if-exists=.env docs/delivery/2026-11-11/miniprogram-refactor/evidence/MP12/harness/api.cjs
```

在仓库根目录执行。`.env` 必须指向本机开发 PostgreSQL／Redis。需要已有书稿测试所需的 Chromium、字体和音频工具。可通过 `TIMENOOK_REPO` 指定本仓库绝对路径；`TIMENOOK_MP12_PORT` 仅改变 loopback 监听端口。启动前检查端口冲突，不停止其他服务。

运行后，Git 忽略目录 `test-results/mp12-native/fixture.json`（目录 0700，文件 0600）保存场景路径、合成身份定位码和业务 ID，不保存会话令牌。原生端通过真正的登录 API 建立会话；只替换微信供应商返回的 `wx.login` code／手机号授权 code。不要打印 manifest，也不要替换业务 `wx.request` 或写入页面业务状态。

| Manifest | 状态与可验证操作 |
| --- | --- |
| `empty` | 无故事、无 PDF 的项目 |
| `stories.ready` | 已归章故事、项目照片、真实封存录音、正文编辑 |
| `stories.unassigned` | 自由讲述产生未归章故事，可归章和移动 |
| `stories.processing` | 真实任务等待整理；刻意不执行该任务，保持截图状态 |
| `stories.failed` | AI fixture 输出非法来源，真实任务处理为失败；可重试 |
| `books.ready` | 已生成真实 PDF、照片封面、固定版本原声入口 |
| `books.stale` | 已生成后真实修改封面，旧稿状态 obsolete |
| `books.failed` | 书稿任务真实读取照片时遭遇外部存储失败；可重试 |
| `print.awaiting` | 已提交首本制作，尚未创建生产尝试 |
| `print.production` | 真实运营命令已接单；随后修改封面，测试制作稿固定 |
| `print.shipped` | 接单→完成印制→登记承运与物流 |
| `print.delivered` | 已发货后登记签收 |
| `print.cancelled` | 运营确认取消，可修改并重新提交 |

每个项目提供 `actorCode`（成员）及 `buyerCode`（购买者）；登录 code 使用该值加冒号及新的随机 UUID，授权手机号 code 使用新的合成值。`paths` 为真实原生路由；故事另有 `path`／`editPath`／`assignPath`，就绪书稿有 `readerPath`／`originalAudioPath`。固定制作稿使用 `frozenReaderPath`，依赖 MP12 的 `fulfillment/book` 与 `fulfillment/book/pdf` 修复。

所有订单、成员、采访、录音上传封存、故事、照片、封面、PDF 和制作状态均走真实应用命令；没有数据库写入业务状态。底层测试 helper 只直接配置合成套餐／目录，独立数据库迁移正常执行。生产任务由真实 `ProductionTasks.run` 处理；后台循环继续处理用户新建／重试任务，唯一保留项是 `stories.processing`。

身份、支付、ASR／AI 的外部传输为 fixture，PDF 内容实际渲染；失败仅在供应商／对象读取边界产生。印厂／物流回执标明 synthetic，经真实管理命令登记。本夹具不证明真实付款、供应商、真机、印厂或实物交付。原生截图和交互结果须由 MP12 另行记录。

2026-11-12 已完成：contracts／API 测试编译；启动及真实 HTTP 登录；四种故事状态、三种 PDF 状态、真实 PDF 字节与 SHA256、五种履约状态、manifest 权限检查。尚未以此记录原生 UI 验收。

结束验收后向 manifest 的 `pid` 发 `SIGTERM`（或在启动终端 Ctrl-C）。退出会停止任务循环，等待进行中的任务，调用原 helper 关闭应用、删除自身 schema／Redis 前缀／临时文件，并移除 manifest。每次重新启动生成新的身份及 ID；需要重新登录和进入新 manifest 路由。
