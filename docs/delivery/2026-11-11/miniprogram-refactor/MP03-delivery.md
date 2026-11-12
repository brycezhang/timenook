# MP03 指定手机号发卡与领取

范围：[#169](https://github.com/brycezhang/timenook/issues/169)，消费 MP02 的明确 `purchaseKind`、原订单单次交付与 MP01 登录、导航、白底样式。API 契约提交 `201befa` 已供 MP04 消费。本票功能已实现；390px/320px 官方开发者工具逐画板已验收，双手机实际领取尚待验收，未部署、上传、提审、发送微信消息或操作真实资金。

## 可操作路径与契约

- 送礼订单购买成功 → `/pages/gift-recipient/index?projectId=…`，填写收礼称呼与微信绑定手机号 → `/pages/gift-share/index?projectId=…`。真实 `onShareAppMessage` 返回 `/pages/gift-claim/index?token=…`；分享前不把收礼人加入项目。
- 领取页先展示书名、收礼称呼与脱敏号码。未登录时原地验证，使用共用 `quick-login` 的内嵌展示；未勾选点击后仍按 MP01 的同意提示直接继续授权。已验证错误账号显示不匹配，可退出该会话并切换号码。匹配账号仍须独立点击“确认领取”。
- 确认后停在“礼物已领取”，点击“进入项目”打开原故事书。原领取人再次打开有效卡进入同一本书。其他账号看不到 projectId，也不能借已领取状态进入项目。
- 一个项目最多一个 `ProjectGift`：规范手机号、称呼、当前版本、token 摘要、私有当前 token、领取账号和时间。购买者专属 `GET /projects/:id/gift` 可在新会话/另一设备恢复同一当前卡片，不依赖客户端缓存。匿名接口只返回状态、书名、称呼和号码掩码。
- 购买者 `POST /projects/:id/gift` 明确生成/重发；项目锁内递增版本并更换 token，旧卡即失效。已领取后拒绝修改。自购项目不接受发卡，普通成员不能设置收礼人。
- `GET /gifts/:token/verification` 与 `POST /gifts/:token/claim` 只比较服务端账号已验证的规范手机号，客户端不能传入“已匹配”或替代号码。领取事务持有项目锁，重复/并发请求复用同一领取事实和成员，不新建项目、订单或权益。
- 领取只写主讲人 `boundUserId` 与项目成员，不增加 `bindingVersion` 或 `accessEpoch`，不改变购买者和原付款事实。购买者领取前准备的原声、照片和固定 PDF 保持可用。
- 新隐私字段已加入 TypeScript 与 SQL 的现有删除登记，使用现有数据库写入/删除保护；没有增加独立删除机制。卡片 secret 与摘要同样可被核验删除清除。

## 检查结果

- 真实 PostgreSQL/Redis：`apps/api/test/designated-gifts.test.ts` 四项通过。覆盖服务器号码比较、验证不自动加入、六个并发领取、重复进入、非购买者/自购拒绝、改号/重发失效、新购买者会话恢复当前卡片、原项目/首本权益唯一。
- 同一真实隔离项目由购买者先生成两段原声、项目照片和实际 PDF；领取前后，两名成员从正式受保护 HTTP 路径读回完全相同的字节，授权版本保持不变。
- 正式 care 核验删除路径清除了称呼、手机号、token、tokenHash、领取账号；旧卡不可打开，数据库拒绝重写已删除字段。支付与项目壳保留。
- 页面控制器/共用登录：`tests/gifts-page.test.ts` 与 `tests/quick-login.test.ts` 共 13 项通过，覆盖生成与分享路径、关闭登录、同意提示、错误账号切换、明确领取、原书重开、账号切换后迟到响应及条款返回刷新期间完成授权。后者曾被旧刷新中的 loading 状态挡住，现由新登录独立发起验证。
- `pnpm typecheck:frontend`、API typecheck/build、`pnpm build:miniprogram`、`pnpm check:native` 通过。wcc/wcsc 编译了 37 个源码页面；正式包包含 34 个发布页面。新页面没有状态选择器或样例业务数据。
- API 测试使用随机 schema/Redis prefix，结束后清理；外部微信、支付、ASR/整理与本地对象存储为现有隔离提供方夹具，不代表供应商、手机号授权、实付或真机验收。PDF 使用项目固定字体并核验 hash；首次工作树未带字体缓存，补齐后实际 PDF 测试通过。
- 合入集成 `f248eb9`（含 MP04 成员关系与三分类契约）后，重新生成本工作树 Prisma；四项礼物 API、13 项前端/登录、前端类型检查及正式包构建通过。

复现：先在仓库根执行 `pnpm db:generate && pnpm --filter @timenook/contracts build && pnpm --filter @timenook/api exec tsc -p tsconfig.test.json`；然后在 `apps/api` 中执行 `node --env-file=../../.env --test --test-timeout=120000 dist-test/test/designated-gifts.test.js`。`.env` 必须只指向获授权的隔离 PostgreSQL/Redis。字体准备使用 `pnpm setup:print-font`。

## 原生逐画板续跑

下表保留原续跑入口；2026-11-12 已解除窗口限制并完成 390px 实际链路，最新结果见下文。两个宽度的最新实际结果见下文，不能用构建、控制器测试或设计 PNG 代替。

| 画板 | 真实进入路径/前提 | 390px / 320px |
| --- | --- | --- |
| GiftRecipient | 已付款他赠订单 → “填写收礼人” | 原生两宽通过 |
| GiftShare | 填号保存 → 当前卡；重开仍恢复同一 token | 原生两宽通过 |
| GiftOpen | 打开实际分享 handler 返回的当前卡路径，匿名 | 原生两宽通过 |
| GiftVerify | 卡片 → 验证手机号，内嵌共用登录；条款返回 | 原生两宽通过 |
| GiftMismatch | 用非指定号码的真实夹具账号登录 | 原生两宽通过 |
| GiftAccept | 匹配账号验证完成；返回仍未领取 | 原生两宽通过 |
| GiftInvalid | 打开明确重发前的旧卡 | 原生两宽通过 |
| GiftClaimed | 明确确认后/原领取人重开；进入原项目 | 原生两宽通过 |

已备好[官方原生自动化续跑脚本](evidence/MP03/harness/native.cjs)：复用仓库 `createRun`、真实 API 和两个隔离提供方账号，不设置页面业务数据。脚本在一次性正式包副本中仅替换 API base 与外部 `wx.login` 授权证明；截图用 `wechatide simulator_screenshot`，每张记录真实 `wx.getWindowInfo().windowWidth`，未覆盖全部 16 张不会报通过。

解锁并取得窗口后，按 wechatide/automator skill 检查运行状态；先执行上述 API 编译及 `pnpm build:miniprogram`，再在仓库根启动 `node --env-file=.env docs/delivery/2026-11-11/miniprogram-refactor/evidence/MP03/harness/native.cjs`。API 为 loopback 3423；终端 `paths` 查看一次性项目与证据目录。设备选择“iPhone 12/13 Pro”（390）或“录音布局320×568”（320），每个宽度输入 `capture`，两次完成后 `quit` 会断开官方工具并清理 API/schema/Redis。随后人工检查截图、字体、键盘、安全区和返回路径，把结果写回本记录；真实微信好友分享与手机号码授权仍单列待验。

## 2026-11-12 原生集成记录

- 使用 MP12 的 [购买／领礼 API fixture](evidence/MP12/harness/purchase-README.md)，复用 MP05 官方 CLI 操作器与 37 页 release 副本；八张画板的 [390px / 320px 原生图](evidence/MP03/native) 已采集并对照。截图中的输入手机号是本地供应商生成的合成号码，不是私人样本。
- 从新赠礼订单成功页进入收礼表单，填称呼及合成手机号，实际生成卡片；点更正后再次生成，读取真实 share handler 路径并确认 token 已变。旧路径匿名打开显示失效，当前路径显示收礼书名和脱敏号码。
- 匿名点击验证进入内嵌登录画板；换为真实 API 建立的错误身份后，验证返回不匹配，点击更换账号回到验证页。fixture 的不同完整号码恰好具有相同掩码，接口仍按完整号码拒绝，未改页面数据制造不同号码。
- 指定身份验证后停在确认领取，单独点击领取才进入已领取状态；点击进入项目打开同一本书。账号、令牌与卡片路径仅保存在 Git 外受限文件，没有发送微信分享消息。
- 320px 重跑生成、重发、失效卡、错误账号、指定账号明确领取与进入同一项目；原生点击条款再返回保留验证画板。紧凑间距修复后八张已复采，收礼输入框文字保持居中。
- 真机手机号授权、手机键盘、双手机分享与收礼仍待验；本轮不把 fixture 身份或签名支付回调当成平台实付证据。

输入框垂直对齐修复后的 320px 已确认；390px 的 NewGift / SelfGift / GiftRecipient 复采因 Mac 再次锁定而待设备切换。旧图与已完成的两宽业务链路分别保留，design-map 未把待复采项标为通过。
