# 网页账号与小程序双端确认关联

对应 [W02a #107](https://github.com/brycezhang/timenook/issues/107)，消费 [W01 #102](https://github.com/brycezhang/timenook/pull/102) 的统一 User、网页 Cookie 与会话契约，以及 T06 微信 code 一次性兑换。工程基线 `3f5b0266b2d28726bb8f49a7ee32002e809d009d`、main CI `40875234212` 已通过；#96 继续保留目标环境验收，#97 其他内测项目／参与工作另交付。

本地协议、网页与原生页面已实现；独立小程序尚未申请，正式 `TIMENOOK_WECHAT_APP_ID` / `TIMENOOK_WECHAT_APP_SECRET` 继续留空，真实微信及真机互通未验收。没有生产部署、付款或讲述者用途授权变更。

## 用户流程与安全边界

1. 网页会话持有人从“我的故事书 → 关联微信小程序”主动生成 8 位关联码，有效期 5 分钟；同一网页会话新建挑战会取消其旧挑战。
2. 小程序首页在微信登录前提供“关联已有网页账号”。输入短码后仅调用新的 `wx.login` 并由服务端向微信证明身份，领取本次挑战。该步不创建 User、不签发 Session，也不读取演示资料。
3. 两端显示同一个目标网页 User 和独立随机的 6 位核对码。原生用户明确确认，网页用户输入小程序的核对码并明确确认，两者顺序均可。原生确认再次使用新的 `wx.login`，换成其他微信身份时取消本次挑战。
4. 只有双方确认完成，事务才把经验证微信身份附加到原 User。微信身份已属于另一个 User 时返回 409；不合并账号、复制项目或改变任何本人授权。完成后新的正常微信登录仍分别签发 Bearer 会话，网页 Cookie 不共享给小程序。
5. 关联页完成后的微信登录带 `expectedUserId`，只接受微信身份已经归属的目标 User；若微信又被切换则 409，并且不创建其他 User。原有独立微信首次登录仍按 T06 规则运行，但活跃待关联身份不能提前创建竞争账号。

挑战绑定发起时的网页 Session 和 User；其他网页会话（包括同 User 的另一会话）不能操作。取消、期限届满、网页退出、撤销、续登或换号使旧挑战无法再完成。网页提交前后恢复核对当前会话，旧响应不能把关联状态显示到新账号。原生页离开后丢弃私人状态，迟到领取尽力取消，迟到登录由现有会话代际规则拒绝并撤销。

短码、微信 code 和原生 proof 只在请求体传输；不放 URL、日志或 localStorage。短码和 proof 服务端仅存 SHA-256 摘要，proof 是本挑战专用能力，不可兑换普通会话。6 位码仅在有权读取该配对的两端展示。原生 proof 不持久化到设备；离开后从网页重新发起。

Redis 分别限制短码领取（每来源 20 次/分钟，配置的登录上限更低时沿用较低值）、网页新建（每会话 5 次/分钟）、状态及后续动作（每会话／原生来源 120 次/分钟）。5 次错误核对取消挑战，Redis 故障时拒绝继续。微信 code 与正常登录共用 AppID+code 摘要一次性预占，微信调用超时或未知结果不允许重用同一 code。

PostgreSQL 按“网页会话 → 挑战行 → 微信身份 advisory lock”顺序串行化；同一挑战只允许一次领取，不覆盖已领取身份。最终提交重新检查会话和期限，与普通微信账号创建共用身份锁及唯一归属。不同目标账号竞争同一个微信身份时只有一个成功。

## HTTP 契约

内部路径如下；网页通过同源 `/api/v1/...`，原生使用自己的 API 基址。成功为 `{data,meta:{requestId}}`，所有响应 `Cache-Control: no-store`。网页写操作保留 W01 来源头、Cookie、CSRF 校验；原生关联不使用 Cookie 桥接或普通 Bearer。

| 方法／路径                             | 请求与结果                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/web/wechat-link`              | 当前网页会话查询 `{available}`                                          |
| `POST /v1/web/wechat-link`             | 主动创建，返回 `{challenge:{...状态,code}}`；8 位 code 只在本次响应出现 |
| `GET /v1/web/wechat-link/:id`          | 仅发起会话查询 `{challenge}`                                            |
| `POST /v1/web/wechat-link/:id/confirm` | `{verificationCode}`，确认网页侧                                        |
| `DELETE /v1/web/wechat-link/:id`       | 取消，返回终态 `{challenge}`                                            |
| `GET /v1/wechat-links`                 | 原生查询 `{available}`，不触发 `wx.login`                               |
| `POST /v1/wechat-links/claim`          | `{linkCode,code}`，返回 `{proof,challenge}`；禁止客户端传 OpenID/AppID  |
| `POST /v1/wechat-links/status`         | `{proof}` 查询，受原网页会话持续有效约束                                |
| `POST /v1/wechat-links/confirm`        | `{proof,verificationCode,code}`，原生用新的微信 code 确认               |
| `POST /v1/wechat-links/cancel`         | `{proof}` 取消                                                          |
| `POST /v1/sessions/wechat`             | 原正常登录新增可选 `{expectedUserId}`；存在时身份必须已归该 User        |

`challenge` 为 `{id,targetUser:{id},expiresAt,state,verificationCode,webConfirmed,nativeConfirmed}`。状态为 `waiting → paired → linked`，活动态可转 `cancelled` 或根据期限显示 `expired`；失效会话 401、外人网页挑战 404、状态／归属冲突及确认重放 409、未配置 503。未配置时两端明确不可关联，不设置占位凭据。协议测试只替换外部微信网络。

## 工程证据与剩余验收

公开 CLI／HTTP 使用真实隔离 PostgreSQL schema、Redis 前缀和临时独立隐私台账；原生行为测试只替换微信注册、存储、login 和网络。浏览器从受控 CLI 链接经实际 HTTPS/Cookie 操作。

- 主链 RED：空创建响应导致关联状态无法读取；实现后 CLI→网页登录→证明→双确认→新微信登录同 User 通过。原有项目列表在关联前后保持同一项目 ID。
- 关联后换微信 RED：`expectedUserId` 最初 400；实现后明确 409 且禁止账号创建。
- 原生缺配置页 RED：页面不存在；实现后不调用微信登录、不保存会话。双确认 RED：缺领取操作；实现后两次证明与最后正常登录明确分开。
- 浏览器换号回归发现新 fragment 在会话恢复中到达可能被地址替换抹掉；恢复响应保留新票据交给 hashchange 处理后通过。
- 相关 HTTP（身份、网页账号和本票）、真实 HTTPS 浏览器、原生身份行为、类型、构建与官方 wcc/wcsc 结果见 [W02a 交付记录](delivery/2026-10-29/web-w02a.md)。

正式 AppID/Secret、合法域名、真实双端账号、真机生命周期与目标部署均未完成，#107 和 #96 保持 OPEN。关联不等于采集、AI、共享或入书授权。
