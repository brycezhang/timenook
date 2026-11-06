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

应用提交 `bf10af2`，本地分支 `codex/wechat-phone-login`；未推送远端。后端已部署到 `/data/server/timenook/releases/20261106-phone-bf10af2`，实际 `current` 已切换。发布包 SHA-256 为 `3e7492f6d81bd41372896d3c05ce04653f946bebd675c22be77a93066f870b24`。使用本地编译的 API/contracts 产物，目标机仅生成 Linux Prisma Client 并应用迁移；网页与官网静态文件未重新发布。

- 类型检查覆盖小程序、API、后台、网页与官网，通过；小程序正式包与官方 WXML/WXSS 29 页编译通过，原生发布包测试通过。
- 前端登录、会话、昵称、返回导航、关联及原声相关 61/61；身份与网页账号最终 30/30，关联与普通商户受影响文件 20/20。真实 PostgreSQL/Redis，只有微信外部网络被替代。新增默认昵称、重登保留、并发改名、条款版本、错误/外来 AppID 手机号响应的回归。
- 完整前端首轮 308/309：原声页仍按旧“直接调用登录”断言失败，已更新为统一登录页返回，受影响原声 18/18 通过。完整 API 首轮 461/466：五处仍按旧 `{id}` 响应断言失败，已对齐新增昵称字段并重验受影响文件；修复后未机械重跑整套，不宣称本轮完整 `pnpm check` 或远端 CI 通过。
- Standards / Spec 一次审查均发现同一项并发昵称覆盖风险，已用数据库原子 `COALESCE` 更新修复并加并发回归；不引入额外状态协调框架。
- 云端 API、Worker 均 `active/running`，`NRestarts=0`、`ExecMainStatus=0`，重启后未发现相关错误日志。公网 live/ready/admin 为 200；匿名项目/改名为 401；旧的仅 code 登录为 400。
- 云端真实稳定 token 接口返回 200、凭据可用；未打印或持久化明文 token。开发者工具已读到实际隐私保护指引，弹窗已实际打开并截图，默认未勾选且同意按钮不可点。未替用户点击同意或手机号授权。编译后的首次页面方法自动化曾出现 `No context found for objectId 1`，后续真实元素点击及截图成功；工具错误保留，不记作产品异常或真实授权通过。

### 开发数据清理

按用户授权，先停止本项目 API/Worker，再清空云端 `timenook` 的 104 张业务表与本应用 Redis 前缀下 4 个键；旧用户 42、项目 34、会话 132、订单 3 均归零。只保留迁移历史、schema 标记、后台账号、关系/大纲/商品基础配置及删除字段注册表等运行配置。独立隐私台账同步重新初始化为新源、第 0 代，避免旧事件恢复旧开发数据。未备份或为旧开发账号增加兼容层，未删除其他业务的数据库/Redis键，OSS 文件本身未在本轮批量删除。

本地 `.env` 仍连接回环 PostgreSQL/Redis，同样完成业务清理和当前迁移；没有替换为云端连接。机器证据见[结果记录](wechat-phone-login-result.json)。

### 真实条件与小程序发布

实际微信手机号授权仍待真机用户确认，本机供应商替代测试、稳定 token 200、已有隐私指引与模拟器弹窗均不能替代该验收。手机号能力/额度以当前微信平台实际授权结果为准。

本轮小程序只完成正式构建和开发者工具页面检查，未上传新版本、未提审；原 0.3.2 上传任务独立保留，没有重复发起。新的小程序客户端与本轮后端接口配套，旧客户端仅 code 登录已被新接口拒绝。

## 官方依据

- [手机号获取与独立 code](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber)
- [服务端手机号 API](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-info/phone-number/api_getphonenumber)
- [稳定 access token](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getstableaccesstoken)
- [隐私授权按钮与监听条件](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.onNeedPrivacyAuthorization)
- [昵称填写与表单提交](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile)

官方文档通过 Context7 的微信官方文档索引核对；网页直连受限。梧桐项目仅作交互和调用顺序参考，未修改其文件。
