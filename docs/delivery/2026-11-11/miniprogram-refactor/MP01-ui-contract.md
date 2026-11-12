# MP01 公共界面与登录契约

后续模块可以直接使用本契约。原生运行和外部待验见 [MP01 交付记录](MP01-evidence.md)。

## 页面与控件

- 页面 JSON 设置 `navigationStyle: "custom"`，最前放 `<tn-navigation title="章节内容"/>`。Tab 页用 `brand="{{true}}"`，标题为当前功能（公开首页为「首页」）；`back` 默认 true。组件在 app.json 全局注册。正文不重复同名标题。
- `tn-navigation` 可选 `interceptBack=true` 时触发 `back` 事件，由页面处理保存/离开；默认仍按真实页面栈返回。MP09 录音页使用此入口，原生系统返回另由页面开启返回提醒及生命周期保存。
- 导航保留 68px 应用页头，读取真实状态栏高度和胶囊区域。左侧品牌／返回与功能标题对齐设计；320px 长于八字的标题使用15px，避免胶囊遮挡和孤字换行。返回走实际页面栈，无上一页时回首页。
- `styles/modern.wxss` 由 app.wxss 导入。`tn-page` 白底、22px 边距、15px 正文；短屏高度不超过740px时上边距18px、间距16px。`tn-card`、`tn-heading`、`tn-muted`、`tn-row`、`tn-icon-tile`、`tn-grow`、`tn-field`、`tn-input` 可复用。
- `tn-button` 至少52px；追加 `tn-secondary` 为次操作。轻操作 `tn-link`；图标按钮 `tn-icon-button` 至少44px；图标 `tn-icon`。
- 固定操作用 `tn-dock`，页面加 `with-dock` 并按自身内容预留空间。Tab 页操作追加 `above-tabs`。自定义两 Tab 为图标文字横排、70px加真实安全区；使用 navigation.ts 的 switchProjectTab/showProjectTab，不能 navigateTo Tab 页。
- Main 和 Sample 使用公开、明确标注的样书素材。它们不是账号项目数据。Main 当前套餐价由 MP02 接真实 offer 后替换。

## 登录与账号

```xml
<quick-login id="quick-login" visible="{{loginVisible}}"
  bindsuccess="loginSucceeded" bindclose="closeLogin"/>
```

属性为 `visible`、可选 `expectedUserId`；`success` 的 detail.user 是 API 返回账号；`close` 只取消。发起页保存待继续操作，只有 success 才继续导航／刷新。登录本身不建单、不付款、不接受邀请或领取礼物。稳定 id 同时用于官方原生自动化选择组件。

未勾选时普通登录按钮打开「继续登录表示同意协议」，其中「继续」是自带 `getPhoneNumber|agreePrivacyAuthorization` 的原生 button；其回调确认同意并直接提交登录。取消不提交同意。已勾选直接用同一授权接口。条款使用 navigateTo，返回保留组件和发起页。

首页、样书、我的、新购、付款、邀请、原声入口使用这一组件。新购保留表单；付款登录后重新读取订单且不自动付款；邀请登录后须明确接受。发布包移除独立 login 页面，开发 account-link 等调试入口不进入发布包。

sessionClient 的真实登录／恢复／昵称更新／退出接口保持原路径。共享 `Account` 新增 `maskedPhone?: string | null`；微信和网页账号响应均由同一映射返回，例如 `131****1234`，不暴露原始号码。`sessionClient.maskedPhone()` 读取真实账号缓存；退出及恢复失败立即清空显示。无数据库模型变更。
