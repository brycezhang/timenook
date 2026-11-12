# MP12 集成清理与原生验收

范围：[#178](https://github.com/brycezhang/timenook/issues/178)。本票的代码清理与开发者工具原生验收已完成：70 个应用状态均有实际 390／320 截图与对应交互，另 1 个 PdfDocument 状态验证系统调用及实际 PDF 内容。逐项范围见 [design-map.json](design-map.json)，真机、资金、供应商及实物结果另验。

## 本轮清理

- 当前原生页面直接使用 navigation 的跳转方法，不再因通用 `go` 引入演示资料库。正式构建从注册页面、全局组件、TabBar 和真实 CommonJS 依赖收集文件，移除未引用的页面、组件和服务；真实录音、音频编码、照片、会话、PDF 与制作模块继续保留。
- 正式包不包含 `services/store.js`、本机演示 `domain/model.js` 或旧题库，`mode.js` 不包含读取缓存后选择 demo 的分支；旧登录、手动账号配对及旧开发页面不在发布路由及包内。历史浏览器预览的演示库仍在独立源码中供旧测试使用，不进入上传包。
- 故事页移除已经没有界面入口的本机演示故事、旧照片编辑、本人确认、单独入书许可与人工校对菜单。现行故事正文、图片、原声、归章、文字编辑和同故事补录保留；服务端资料授权、撤回和删除规则不变。
- 当前项目标题回退、分享回退及支付宝商品标题统一为「时光故事／时光故事书」，实际用户书名优先级不变。
- `scripts/test-native-design.cjs` 删除旧 `/book/directory` 和写死的 `wx.request` 替身，复用 MP05 官方 CLI 封装，从已选择的隔离真实项目执行家人提问、故事编辑与封面取消保存路径。每次采集写明原生窗口尺寸、页面、进入方式及已观察交互；截图默认待视觉对照，不自动追认通过。
- 现有原生 SDK 等待器同时等待 `pageLoading=false`，避免把仍显示骨架的页面当成业务页就绪。

## 已执行检查

- 75 项定向回归通过：真实页面控制器中的故事、入口、礼物、家人问题、章节归属；正式包依赖闭包、旧入口排除、真实 Tab；原生等待器。HTTP／硬件替身只证明各自控制器边界，不代表平台实测。
- `pnpm typecheck:frontend` 通过。
- `pnpm build:miniprogram` 通过，37 个正式路由；包内所有路由在上传目录内加载，无演示模型及上传目录外模块。
- `node scripts/check-native.mjs --built` 通过，官方 wcc/wcsc 均编译全部 37 个正式页面；分批原生截图已记录在各票交付记录与 design-map。

## 复用原生走查

先使用 MP06 的 [API fixture](evidence/MP06/harness/api.cjs) 启动独立本地 PostgreSQL schema／Redis prefix，并以当前代码构建临时小程序项目。真实业务数据通过 API 命令创建，微信身份、支付、音频与 AI 供应商是明确隔离的 fixture。正式包不写入 fixture 账号或场景开关。

在官方开发者工具已打开该临时包、登录并通过「我的礼物」选择相应隔离项目后：

```sh
TIMENOOK_NATIVE_PROJECT=/absolute/path/to/isolated-project \
TIMENOOK_NATIVE_PROJECT_ID=<isolated-project-id> \
TIMENOOK_NATIVE_EVIDENCE=/absolute/path/outside-git/evidence \
node scripts/test-native-design.cjs family
```

`stories` 复用已保存故事，`cover` 复用当前书稿；`capture <board> <actual-entry> <observed-interaction>` 只采集当前原生画面。实际操作时分别将 DevTools 内容宽度切到 390 与 320，脚本读取并校验 `wx.getWindowInfo()`，不通过改页面数据伪造尺寸或状态。失败/录音/PDF 查看器/制作状态继续使用各模块既有 provider fixture 和真实状态流进入，不能直接设置业务页面数据。

当前已完成录音 320 真实上传／丢响应重试、书稿 320 实际 PDF 打开、长原声拖动／退出清理、地址保存／提交／生产状态读取，以及真实取消订单重提的未知响应查询恢复；详见各票记录及[本轮书稿制作检查点](evidence/MP12/native-book-print-320.json)。原生发现的 sort-list 异步查询／touchend 竞态已修复，实际 320 CUA 拖动章节后，界面与 API 均保存为「求学与成长、我的童年」顺序。封面照片返回的多余离开提示也已修复并通过真实选图／草稿保存复验。

最终补齐 390 应用状态，并完成故事拖动／移出与 API 顺序回读、故事长音频原生 slider 跳转、地址 picker 首项确认、暂停录音照片页头返回、失败故事重试和首次制作未知响应查询。正式包 `f257c62` 删除了设计中没有的原始转写展示，StoryFailed／StoryProcessing 用真实 API 状态再次双宽采集；其余不受影响的通过证据保留。[最终脱敏记录](evidence/MP12/native-final-acceptance.json)记录环境、交互结果与边界。最后正式构建及官方 wcc/wcsc 均通过 37 页，制作页引用模板实际存在于包内。

PDF 系统外壳不伪装为应用 390/320 截图，按系统调用与实际内容单独记录。真机手机号授权、实际录音和供应商、支付资金、微信分享、扫码、印厂与实物验收各自独立待验。集成分支与 [PR #179](https://github.com/brycezhang/timenook/pull/179) 已由集成负责人推送；本轮未部署或上传。
