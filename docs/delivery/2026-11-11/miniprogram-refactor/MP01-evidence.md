# MP01 · 原生入口、登录与账号交付

2026-11-11。工程实现与开发者工具验证完成；真实微信手机号成功授权及 iPhone/Android 真机验收仍待执行。未部署、上传、付款或提审。

公开首页进入样书、送礼前原地登录、我的账号修改昵称与退出均已有实际原生页面。所有发布入口共用登录组件；新购草稿、原声入口和邀请页面保留原操作。已登录邀请须再次明确接受，登录不会领取或付款。共享用法见 [UI 契约](MP01-ui-contract.md)。

## 六张画板对照

每张均检查页头、正文和底部区域。下表链接为原始 DevTools PNG；对应设计图片位于 `design-reference/{390,320}/`。完整路径、真实窗口尺寸、PNG尺寸和 SHA-256 在 [截图清单](evidence/MP01/screenshots.json)。PNG尺寸受 DevTools 显示缩放影响，不能代替 runtime 的 windowWidth。

| 画板／角色 | 实际入口及结果 | 390 | 320 |
| --- | --- | --- | --- |
| Main／所有人 | 原生首页；品牌加「首页」、样书、样书图、三项利益与固定送礼按钮；窄屏标题30px无孤字 | [原生](evidence/MP01/native/Main-390.png) / [设计](design-reference/390/Main.png) | [原生](evidence/MP01/native/Main-320.png) / [设计](design-reference/320/Main.png) |
| Sample／所有人 | 首页真实点击「看看样书」；同一公开书图、节选卡和固定CTA；正文可滚动 | [原生](evidence/MP01/native/Sample-390.png) / [设计](design-reference/390/Sample.png) | [原生](evidence/MP01/native/Sample-320.png) / [设计](design-reference/320/Sample.png) |
| Login／未登录 | 首页送礼、我的登录触发同一底部组件；保留发起页，登录不跳独立页面 | [原生](evidence/MP01/native/Login-390.png) / [设计](design-reference/390/Login.png) | [原生](evidence/MP01/native/Login-320.png) / [设计](design-reference/320/Login.png) |
| MyGuest／未登录 | 原生 switchTab 进入我的；登录、送礼、条款和两Tab | [原生](evidence/MP01/native/MyGuest-390.png) / [设计](design-reference/390/MyGuest.png) | [原生](evidence/MP01/native/MyGuest-320.png) / [设计](design-reference/320/MyGuest.png) |
| MyAccount／已登录 | 同一账号真实HTTP登录后显示昵称和脱敏号码，昵称更新后重登仍保留 | [原生](evidence/MP01/native/MyAccount-390.png) / [设计](design-reference/390/MyAccount.png) | [原生](evidence/MP01/native/MyAccount-320.png) / [设计](design-reference/320/MyAccount.png) |
| Terms／所有人 | 我的和登录弹窗真实navigateTo；完整八节条款，返回保留原页面／同意状态 | [原生](evidence/MP01/native/Terms-390.png) / [设计](design-reference/390/Terms.png) | [原生](evidence/MP01/native/Terms-320.png) / [设计](design-reference/320/Terms.png) |

对照中修复了旧居中页头、上下排列Tab、缺失图标、320px首页孤字、条款标题被胶囊挤压、协议文字横向溢出和账户卡片排版。额外的 [320首页滚动状态](evidence/MP01/native/MainScrolled-320.png) 证明利益说明可见且不被固定CTA永久遮住。

系统状态栏、胶囊和底部安全区由微信绘制，会减少正文可视高度，原生保留滚动；设计参考不包含这些系统区域。320px完整条款标题用15px让开真实胶囊，其余普通页头17px。账户头像使用用户图标，昵称／脱敏号来自合成供应商身份经过真实API的结果，不使用设计中的家庭合影和示例号码。Login截图来自实际「我的」发起页，背景与设计独立Login画板的首页示意不同，组件及原地返回行为一致。

## 运行交互与证据边界

- 设备菜单实际选择 iPhone 12/13 (Pro)（390×844，DPR3）和既有「录音布局320×568」（320×568，DPR2）；分别通过 wx.getWindowInfo() 读取窗口宽高，未mock宽度或CSS缩放。DevTools 2.02.2609250，基础库3.17.5。
- 实际点击 Main→Sample、首页送礼→登录、我的→登录／条款、条款返回、昵称编辑与保存、退出。关闭／取消留在原页；320窄屏正文可滚动。原生 nickname 输入填入测试名「小树」，真实API保存后重新登录保留该值。
- 未勾选登录打开继续即同意提示；[390确认](evidence/MP01/native/LoginConsent-390.png)、[320确认](evidence/MP01/native/LoginConsent-320.png)。真实点击原生「继续」打开微信手机号授权面板，随后选择拒绝，没有提交真实手机号；私人授权面板和昵称建议没有保存到交付截图。
- 对外部微信code／phoneCode采用合成供应商边界；通过组件公开回调注入拒绝和成功结果。拒绝保留弹窗和错误反馈，重试成功后只继续原操作。页面未用setData伪造登录或账号结果。
- 昵称、登录会话、恢复与退出通过实际 wx.request→本地API→真实PostgreSQL/Redis。所有账户和电话号码均为隔离fixture。最后退出后 loggedIn=false、maskedPhone为空且busy=false，专用schema和Redis前缀已清理。
- 原生专用API只注册身份模块；它的 /participations 返回404是fixture配置边界，因此未以此宣称登录后项目首页或购买链路通过。该链路由MP02/MP06集成验收。发布包保留真实服务地址，测试地址和外部code注入只在临时构建项目。

## 工程检查

- 登录、账户、入口、原声、支付和发布构建定向测试通过；[首轮57条日志](evidence/MP01/frontend-tests.txt)，随后新增邀请显式接受回归，16条入口测试通过（含此前15条）。仅公共组件／页面／API边界，未增加内部实现镜像测试。
- 前端类型检查、29页发布构建、官方wcc/wcsc原生编译通过。支付测试Array.at已改为ES2020支持的索引访问。
- 身份15条与网页账号9条API测试通过，使用真实本地PostgreSQL/Redis、隔离schema；微信和短信供应商为外部边界fixture。验证脱敏返回、原号不泄露、昵称保存与同手机号账号一致。
- 原canvas全部71份共享runtime同步可点击的未勾选登录、继续即同意、完整Terms及窄屏Main；canvas结构检查0问题。设计参考为root统一采集的142张图片，单独的浏览器原型状态不冒充原生结果。

## 可复用原生验证工具

[身份API fixture](evidence/MP01/harness/api.cjs) 与 [官方CLI驱动](evidence/MP01/harness/native.cjs) 均已保存；从仓库根运行。先构建contracts和API测试产物，使用只含本地DATABASE_URL/REDIS_URL的环境启动API（脚本拒绝非loopback）；API监听3419，停止会删除自己的隔离schema和Redis前缀。它只覆盖身份，其他模块须启用自己的真实模块配置。

`TIMENOOK_NATIVE_PROJECT` 指向独立临时项目，把发布构建复制到其中的miniprogram/，在临时config.js将API地址换为 `http://127.0.0.1:3419/v1`，关闭该临时项目URL检查。`TIMENOOK_NATIVE_EVIDENCE` 可指定新的输出目录。使用 `wechatide -c Codex` 打开临时项目，调用driver.install仅对外部wx.login供应code；所有业务HTTP真实发送。组件用 `#quick-login` 选择；标签选择器不能稳定命中原生自定义组件。

实际宽度通过 DevTools 底部设备文字→机型菜单切换，切换后等待runtime就绪并重新读取windowWidth；截图保留工具返回的PNG宽高。必要时通过CUA app `com.github.Electron` 操作该菜单。不得用改CSS或mock getWindowInfo冒充另一宽度。

## 外部待验

微信真实手机号成功授权、真实用户账号恢复与两种真机系统，微信隐私指引／客服的线上配置仍需外部条件。工程与模拟器结果不代替这些结果。没有部署、上传体验版、真实付款或正式提交审核。
