# 项目列表边距与名称修复

用户反馈：项目卡片文字贴边；列表显示「人生故事书」，没有显示新购时输入的名称。

## 实现

- 原卡片叠加 `s-card` 与 `s-row`，后者的左右零内边距覆盖了卡片留白。现使用页面专用卡片样式，左右 32rpx、上下 30rpx、卡片间距 24rpx；书名与项目状态分层，长书名换行，待付款卡片沿用相同布局，底部留出固定按钮与安全区空间。
- 购买名称保存在订单 `bookTitle`；项目未改名时，项目自身的同名字段为空。详情已有读取购买名称的逻辑，列表却直接返回默认值。成员列表现按当前项目名、购买时输入名称、默认名称的顺序返回；批量查询关联订单，不逐项目发起额外请求。修改当前名称不会改写订单中的购买事实。

## 工程验证

- `pnpm exec tsc -p tsconfig.test.json`（`apps/api`）通过。
- 定向执行 `project-members-simple-flow.test.js` 中 `project lists show` 回归，真实隔离 PostgreSQL/Redis 下通过：购买者与受邀成员读取输入名称；非成员列表为空；成员改名后双方列表更新，原订单名称保留。微信外部请求使用测试替身。
- `pnpm typecheck:frontend`、`pnpm --filter @timenook/api build`、`pnpm build:miniprogram` 通过；`node scripts/check-native.mjs --built` 完成 29 页正式包 WXML/WXSS 编译。

## 实际运行

- 本机编译的后端产物已部署到 `106.14.11.96` 的 `/data/server/timenook/releases/20261106-project-titles-89e5bb4`，`current` 已切换。只替换 `apps/api/dist/identity/participation.js` 及对应 source map；编译 JS 与原运行版本的差异仅本次列表名称读取逻辑。JS SHA-256：`89e5bb49dbb07dc60d4729520546006b7c52f94a9831e250987b0b0d8a341c9f`。
- 首次候选校验发现旧发布清单仍引用已不存在的后台静态资源，在服务切换前停止。随后按当前运行文件重新核对 476 个发布产物，本次两份产物以外逐字节相同，并重建清单；原发布目录未修改。发布清单明确记录基于本地 `9ab2650` 的未提交范围补丁及 SHA-256，不将其记为已提交版本。源补丁 SHA-256：`df7d3895dc27503cb32c4110e8f030858e20dffff1fea297dd29f3359dc41b56`。
- API/Worker 均 `active/running`、`NRestarts=0`、`ExecMainStatus=0`，最近 3 分钟无 error 级日志；公网 live/ready 均 200，匿名项目列表仍为 401。数据库及环境配置没有修改。
- 官方开发者工具使用现有真实会话与 HTTPS API：原项目列表由「人生故事书」改为「妈妈的一生」，同一当前项目可正常显示。卡片边距已通过真实页面截图检查；另外临时使用合成页面数据检查长书名换行和待付款卡片，再重新读取并恢复真实列表，未创建订单或项目。
- 截图保留在 Git 外：`/Users/bryce/.codex/visualizations/2026/11/06/01a1b02e-80c4-7e43-be81-e8948f87b21d/projects-fixed.png`；长名称检查为同目录 `projects-long-title.png`。
- 本轮未提交或推送 Git，未上传小程序新版本或提审。前端样式已在本机正式构建和开发者工具中生效；手机端样式需后续预览或新包，真机显示不记为已验。

## 菜单文案补充

用户随后要求「我的」页面菜单中的「项目」改为「我的项目」。已修改菜单文字并同步流程说明；正式小程序构建、账号页官方 WXML 编译及差异格式检查通过。未上传新版本。
