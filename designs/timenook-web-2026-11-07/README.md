# 时光故事网页重设计

本轮交付是独立、可运行的 Vue 3 高保真交互原型，范围为产品网页 `apps/web` 对应的项目、故事、录音、书稿与我的，不包含营销官网。尚未替换产品应用入口，也未接入真实业务 API、上传、邀请、付款或印刷。

## 设计方向

沿用小程序 `miniprogram/styles/tokens.wxss` 的全部 12 个颜色，使用 shadcn 式语义 token、细边框和克制圆角。界面采用系统无衬线字体，故事正文及书封采用中文衬线字体；手机底栏、桌面侧栏共享导航。设计依据是当前 ADR 0018：项目成员共同记录、统一项目入口、取消本人/双方确认与用途选择，收货信息在成书后填写。

- 首页：当前项目、讲述入口、最近故事与可切换话题。
- 故事：筛选、搜索、阅读、编辑及编入/移出书稿。
- 录音：真实浏览器麦克风、暂停、继续、结束及本页回听；不上传或持久保存，最长 5 分钟。
- 书稿：封面编辑、章节及入书故事、示例网页书稿阅读、地址表单。
- 项目与我的：切换/新建示例项目、昵称、邀请入口、条款摘要。

示例项目、文字、时长和书稿均为设计数据。照片取自项目已有资源，继续标记为效果示意。封面示例不会作为生成的真实生产 PDF；邀请入口不签发链接，地址不提交服务器，新增项目不产生订单。真实原声、补充讲述、照片管理、目录调整、完整条款、登录与真实支付仍需业务接入，原型不伪造成功结果。所有编辑状态只在当前页面生命周期有效。

## 未登录与登录状态补全

默认入口现为未登录首页：产品介绍、讲述到成书的流程、样书节选、¥999 套餐及常见问题均可公开浏览。样书使用独立的静态示例，不作为个人项目或已生成书稿。未登录的“我的”展示登录入口；访问故事、书稿或项目会先打开登录弹窗，取消后停在原页。

登录弹窗默认不勾选条款，可阅读摘要并返回；覆盖提交中、取消、失败重试，以及成功后回到原入口。点击新购入口后，登录成功只打开新建页，不自动付款或创建项目。原型按钮仅演示账号状态，不收集账号凭据，也不连接后端认证。正式网页已另行确定手机号验证码登录、同号账号及支付宝支付，见[开发草案](../../docs/delivery/2026-11-07/web-vue-development-plan.md)；本原型的演示控制不进入正式源码或发布包。

顶部“状态预览”可切换未登录、已登录暂无项目、已登录已有项目，并选择登录演示结果。失败模式演示失败一次、重试后成功。无项目的首页、故事、书稿与项目列表均有空态及明确开始入口；退出登录会清空本页的示例项目视图与媒体引用。

直接入口：

- 未登录：`?state=guest#home`（默认）。
- 已登录暂无项目：`?state=empty#home`。
- 已登录已有项目：`?state=member#home`。

`state` 仅是无凭据的原型场景参数，示例编辑和新建内容刷新后不保留。未登录与无项目页面已在 320、390、768、1440px 验证，320×568 登录主要按钮可见；样书、条款、登录取消/提交中取消/失败重试、成功返回、新建首个示例项目与退出清理均已跑通，无运行时错误。现有成员首页及录音准备入口仍可用。仅为设计原型的交互证据，不代表真实认证或业务已验收。

## 运行

在仓库已安装依赖后，使用现有 Vue 和 esbuild 构建，无新增依赖或锁文件变更：

```sh
node designs/timenook-web-2026-11-07/build.mjs
node apps/admin/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p designs/timenook-web-2026-11-07/tsconfig.json
python3 -m http.server 4311 --bind 127.0.0.1 --directory designs
```

打开 http://127.0.0.1:4311/timenook-web-2026-11-07/ 。`index.html`、`app.js`、`style.css`、`tokens.css` 与 `assets/` 可作为独立静态目录分发。无 CDN、远程字体或 API 依赖。

`src/` 保存 Vue SFC、示例数据及复制的 Lucide 图标，`build.mjs` 用 Vue SFC 编译器与 esbuild 打包。`design-system/project/tokens.json` 是设计 token 的唯一编辑来源，构建生成原型 `tokens.css`；网页语义名称映射见该设计系统 README。Vue 与 Lucide 许可在 `licenses/`。

## 设计系统

`design-system/project/` 是 Baoyu Design System 文件格式，含 token、品牌说明与 Button / Input / Status / ProjectCard 示例。用该技能的 `artifact.mjs open` 可打开可编辑的设计系统页面。它是本轮网页的样式来源，不使用 React 组件包。

## 本轮验证

Vue SFC 类型检查与构建通过。Chromium 检查了 320、390、768、1440px 的五个主页面，均无横向溢出或无名称按钮/链接；320×568 录音主要操作位于底栏上方。故事筛选/搜索/编辑/入书、示例书稿生成与阅读、昵称、项目创建/切换、弹窗及 Escape 关闭均通过。浏览器合成麦克风验证了开始、暂停、继续、结束、回听与重新录制，无运行时错误及 API 请求。未声称真机 Safari、真实麦克风硬件或服务器业务已验收。

未提供 Browser 插件，使用现有 Playwright 工具与仓库 Chromium 验证；设计最终预览在 Codex 内置浏览器展示。

## 参考

- 小程序：`miniprogram/styles/tokens.wxss`、`miniprogram/app.wxss`、`miniprogram/assets/`。
- 业务：`docs/adr/0018-project-members-and-simple-printing.md`。
- Vue：[TypeScript + SFC](https://vuejs.org/guide/typescript/overview.html)。
- 组件视觉：[shadcn-vue Theming](https://shadcn-vue.com/docs/theming)。
