# 微信手机号登录与用户昵称

2026-11-06 用户最终要求：直接获取手机号，首次昵称为「用户 + 手机号后 4 位」，登录后可修改；登录时弹窗明确同意协议，参考 `/Users/bryce/workspace/wutong_miniapp` 的登录流程。前一轮“登录时采集微信昵称”的设想已替换。用户授权清空开发数据库，不做兼容或旧账号补全。

## 当前行为

- 首页、我的、新购、受邀加入、书中原声和开发用关联入口统一进入手机号登录页；返回购买或原页面时保留原有上下文。
- 点击登录出现协议弹窗。默认未勾选，提供《使用条款》和微信原生《隐私保护指引》入口；明确勾选并点击 `open-type="agreePrivacyAuthorization"` 的“同意并继续”后，才显示手机号授权按钮。不同意、取消和授权失败不发送登录请求。
- 微信官方说明：在隐私接口之前确保用户已点击隐私同意按钮，可以不注册 `onNeedPrivacyAuthorization`。因此本实现使用直接按钮流程，不增加全局监听/弹窗状态协调器。
- `POST /v1/sessions/wechat` 必须有新鲜 `wx.login.code`、独立的手机号授权 `phoneCode` 及 `termsVersion=shiguang-story-2026-11-06`。服务端使用稳定 access token 换取手机号，附服务端取得的 OpenID 校验归属，并校验响应 AppID；不接收客户端传入的手机号或登录昵称。
- 微信身份继续唯一关联产品账号，不按昵称或手机号尾号合并账号。服务端首次生成如「用户1234」，后续授权更新号码但保留用户已有昵称。
- `GET /v1/users/me` 和登录响应返回账号 ID 与昵称，不返回手机号；`POST /v1/users/me/profile` 仅允许本人修改 1–32 字昵称。“我的”立即展示并可通过微信昵称输入框和表单提交修改。
- 新字段允许为空，仅用于仍保留的网页内部账号/显式关联；微信手机号登录始终写入手机号与昵称，不增加旧账号兼容、跳过授权或合成身份路径。
- 条款版本与接受事实沿用原有 `terms_acceptances`，登录和购买继续分别操作。

## 验证与执行记录

定向 API 与前端登录/昵称/协议回归、类型检查、正式构建及原生编译已完成初轮验证。完整 API 回归正在执行；数据清理与实际服务切换尚待本轮完成后补记。不得将本段视为云端已更新或真实手机号授权已经通过。

微信真实手机号授权与隐私指引需要小程序账号具备相应能力、额度和平台声明，并由实际微信用户确认；本机替代外部供应商的测试不构成真机授权验收。原 0.3.2 上传任务状态独立保留，本轮不重复发起该上传、不提审。

## 官方依据

- [手机号获取与独立 code](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber)
- [服务端手机号 API](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-info/phone-number/api_getphonenumber)
- [稳定 access token](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getstableaccesstoken)
- [隐私授权按钮与监听条件](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.onNeedPrivacyAuthorization)
- [昵称填写与表单提交](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile)

官方文档通过 Context7 的微信官方文档索引核对；网页直连受限。梧桐项目仅作交互和调用顺序参考，未修改其文件。
