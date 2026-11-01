# 官方微信开发者工具自动化

关联 [#130](https://github.com/brycezhang/timenook/issues/130)。演示闭环与真实服务登录使用独立命令和全新临时项目，运行结果分别见[2026-11-01 记录](delivery/2026-11-01/native-automation.md)。

## 执行

当前工具链已更新为官方 Stable `2.02.2609240`（2026-10-26 发布）。新版 Electron 使用独立登录与 CLI 服务配置；首次升级后须在可观察的桌面正常登录，并确认原有 CLI/HTTP 调用能力已启用，再运行下列命令。`cli islogin` 返回 246 表示服务端口未启用，运行会停在官方 CLI 启动阶段，尚未进入小程序登录步骤。当前新版两套原生运行尚待这项准备后验证，具体状态见运行记录。

要求 Mac 官方微信开发者工具已登录、允许命令行服务，并在「详情 → 本地设置」安装基础库 `3.17.5`。脚本默认使用这一本机已安装的稳定版本；只修改临时项目的版本，不修改根 `project.config.json` 或上传包。可用 `TIMENOOK_NATIVE_LIBRARY=x.y.z` 显式选择另一个已安装版本；实际解析版本必须与请求一致，否则以 `startup:library-version` / `NativeLibraryMismatch` 失败。结果同时记录源配置、测试请求与实际解析版本。

```bash
TIMENOOK_API_BASE_URL=https://timenookapi.threeminreading.com/api/v1 pnpm build:frontend
pnpm test:native-automation
pnpm test:native-e2e
pnpm test:native-login
```

`test:native-login -- --orders-required` 要求已启用订单模块、`GET /orders` 为 200 且符合订单数组契约；可直接运行 `node scripts/test-native-login.cjs --orders-required`。默认模式记录订单可用性，允许旧内部验收装配的 404，核心登录检查不因此跳过。真实服务的装配、部署和付款验收仍单独记录。

可用 `WECHAT_DEVTOOLS_CLI` 显式指定官方 CLI 路径，默认 `/Applications/wechatwebdevtools.app/Contents/MacOS/cli`；自动化端口默认分配空闲端口，可用 `TIMENOOK_NATIVE_E2E_PORT` 指定。脚本不会上传、预览发布或提审。

## 启动与页面就绪

`Tool.getInfo` 只报告配置的基础库版本；SDK 端口可连接不等于小程序已经渲染。启动通过官方 `auto`，先等待 SDK，再检查实际版本。页面等待使用 SDK 公开 CDP 通道的 `MPPage.getStack` 和 `MPPage.waitForReady`，在真实页面 `onReady` 后读取业务数据及原生布局。

SDK 探测连接失败时继续有界轮询；收到无法解析的 JSON，或顶层为 `null`、基本值或数组的响应，则立即以 `startup:sdk` / `NativeProtocolError` 失败，沿用脱敏结果保存和临时项目清理，不输出原始消息或解析错误。

`onReady` 早于路由动画结束。测试副本的 `app.js` 追加被动 `wx.onAppRoute` / `wx.onAppRouteDone` 监听，只保存当前已完成路由，不改业务处理、登录或网络。下一步还须满足实际路由完成、页面非 busy/loading、原生类选择器存在可见内容及该步骤的业务完成条件。这样不在上一页仍切换时发出新的 reLaunch。原生选择器使用类名；通用 `view` 标签选择器在此工具中返回空集合。

直接导航调用 CDP 原生路由完成接口，避免 SDK 路由快捷方法内置的三秒等待；没有固定八百毫秒等待、整套自动重跑、自动清除缓存或多重重启兜底。

## 两种边界

- **演示**：只在临时项目中替换 RecorderManager 工厂为静音 MP3 输入；通过本机 HTTP 下载得到原生临时文件，再由真实 FileSystem 持久保存，并断言文件非空。仅该副本允许本机下载。购买和故事是明确标注的本机演示，包含同一购买项目、故事确认与修改失效、原生 Tab Page/筛选保留、重复购买及项目保留；不打开麦克风或真实支付。
- **真实登录**：临时项目 `urlCheck=true`；实际请求未配置域名须被原生运行时拒绝，再通过真实 `wx.login`、公网 API 和页面登录/退出方法验证当前账号、持久会话恢复、无会话拒绝、退出后旧会话拒绝、重新登录同一账号并签发不同会话，以及参与/订单页面。没有登录、网络替身，不调用付款或录音 API。

每个原生命令、路由等待和清理阶段都有上限。每个步骤立即持久保存脱敏结果，失败记录准确阶段及路由/加载布尔值，不保存原始错误文本、请求头、登录 code、会话 token 或用户内容。截图仅用于全新合成演示；真实模式不截图账号界面。截图单独有界，SDK 截图不可用时仍以页面/业务断言判断，并记录截图缺失。

运行目录打印为系统临时目录下 `timenook-native-demo-*` 或 `timenook-native-live-*`；目录权限 700，机器结果 `evidence/result.json` 为 600，均不进入 Git。无论成功失败都撤销真实模式缓存的测试会话并清除本机会话，断开 SDK，关闭本次临时项目；清理失败会使整次结果失败。不会清除用户原项目或其他项目缓存。

单账号开发者工具结果不替代 iOS/Android 微信真机、真实麦克风/采集、实际资金或实物验收。
