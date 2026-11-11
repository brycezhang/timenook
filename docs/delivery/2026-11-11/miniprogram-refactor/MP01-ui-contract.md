# MP01 公共界面与登录契约

当前工程接口已可供后续模块使用；MP01 全部画板、真实微信手机号及真机结果分别验收，不以此文档视为完成。

- 页面继续使用原生导航栏。全局导航和两 Tab 已采用白底／橄榄绿；普通页面在页面 JSON 声明功能标题。
- `miniprogram/styles/modern.wxss` 由 app.wxss 导入。页面以 `tn-page` 选择新版样式；白底、22px 边距和正文 15px。容器 `tn-card`、标题 `tn-heading`、次文 `tn-muted`、列表 `tn-row`／`tn-icon-tile`／`tn-grow`，表单 `tn-field`／`tn-input`。
- 原生按钮使用 `tn-button`，次按钮追加 `tn-secondary`；轻操作 `tn-link`，图标按钮 `tn-icon-button`，图标 `tn-icon`。按钮高度至少 52px，图标点击至少 44px。
- 固定操作区 `tn-dock` 配合 `tn-page with-dock`；Tab 页底部操作追加 `above-tabs`，正文预留自身操作区空间；底部安全区由样式保留。已有原生 Tab 路由仍使用 navigation.ts 的 switchProjectTab/showProjectTab。
- `quick-login` 属性继续为 `visible`、可选 `expectedUserId`；事件 `success` 携带真实 `user`，`close` 仅取消。发起页保存待继续操作，只有 success 后再导航／执行；登录本身不建单、不付款、不接受邀请／礼物。
- 未勾选时普通登录按钮打开“继续登录表示同意协议”，其中“继续”原生 button 自带 `getPhoneNumber|agreePrivacyAuthorization`。该授权回调确认同意并直接提交登录；取消不提交同意。勾选后直接使用同一原生授权按钮。查看条款使用 navigateTo，返回保留组件及发起操作。
- 现有 sessionClient 的微信登录、账号恢复、昵称更新和退出接口不变；不新增会话模型、模拟账号或兼容接口。

此里程碑：登录／首页账号／支付页面定向测试 20 项、前端类型检查通过。支付测试 Array.at 已改为 ES2020 可用的末项下标访问。原生运行、设计对照与完整票据证据继续在 MP01 后续记录补齐。
