# 时光故事 0.4.0 发布记录

2026-11-12（北京时间）。[PR #179](https://github.com/brycezhang/timenook/pull/179) 已合入 `main`，[#166](https://github.com/brycezhang/timenook/issues/166) 及 #167–#178 已关闭。发布源码 `3f54a93d7e774d77d53f2baa2b27809bc77fa22a`，[main CI](https://github.com/brycezhang/timenook/actions/runs/43241671712) 通过。

- **小程序：** 0.4.0，正式包 37 页，官方 wcc/wcsc 通过。开发者确认后原上传任务返回 `success`，包大小 871,943 字节。微信管理后台的体验版标记尚未核实，未提审。
- **服务：** `106.14.11.96` 上的 `timenook-api.service` 与 `timenook-worker.service` 指向 `/data/server/timenook/releases/20261112-refactor-3f54a93`，产品网页指向 `/data/server/timenook-web/releases/20261112-refactor-3f54a93`，管理后台随 API 发布目录切换。官网营销页与其他应用沿用原发布。
- **产物：** Linux CI 候选归档 SHA-256 `f0015101ca54f3a15f8484bb3f7888cc2e4dac1fac54be0412e420d8d14c256b`，本地和服务器均验证 456 文件清单。复用相同锁文件的 Linux 依赖文件，独立生成新版 Prisma Client，未在目标机编译应用。
- **开发环境重建：** 新库 `timenook_refactor_3f54a93` 应用全部 66 条迁移，不导入旧用户、项目或订单。API/Worker 增加独立 `.env.refactor-3f54a93` 绑定，队列前缀 `timenook-cloud-refactor-3f54a93`、私有 OSS 前缀 `timenook/product/refactor-3f54a93`，本机业务目录与独立隐私日志均与旧版分开。沿用已确认的 ¥999 展示、¥0.01 受控收款配置，通过既有发布入口初始化新库套餐。

公网 [live](https://timenookapi.threeminreading.com/api/health/live) 与 [ready](https://timenookapi.threeminreading.com/api/health/ready) 均为 200；[后台](https://timenookapi.threeminreading.com/admin/) 与[产品网页](https://sgl.wootoon.cn/app/) 返回的首页与发布包逐字节一致。家人提问、相册及固定书稿路由对匿名请求正确返回 401。API/Worker 运行正常、最终观察无自动重启；真实 OSS 私有测试对象已写入、读回核对并删除。未执行实际付款、手机授权、录音或生产交接。

切换预检使用临时本机端口。早期切换因主机日志时间格式不兼容触发回退；旧隐私日志随后因新版目录误置于旧日志根下拒绝启动。已将新版日志移到独立同级目录，恢复旧版 readiness，重新完成预检与正式切换。旧库、旧队列、旧对象及 `20261110-input-limits-7e2cc95` 发布目录保留；若需回退，先停止新写入并核对新库交易，再一并恢复旧 API/Worker 环境及 API、网页链接，避免将新旧数据混用。

真机操作：在微信公众平台将 0.4.0 选为体验版，使用已具备体验权限的微信扫码。因使用新库，旧会话和旧故事书不会出现在新版；从微信手机号登录和新购开始验收。支付会发生真实 ¥0.01 扣款；只有在确认要验证实际支付时操作。
