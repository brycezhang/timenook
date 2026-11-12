# MP11 制作、收货地址与寄送状态

范围：[#177](https://github.com/brycezhang/timenook/issues/177)。消费 MP10 的当前书稿、固定版本读取和系统 PDF 入口；沿用已付款套餐首本权益与运营人工履约。功能及七张画板的 390／320 原生验收已完成，包括未知响应查询、取消后重提及固定版本读取；真机与实际生产交付另验。

实现提交 `5e5c799`；随后已合入集成 `662711c`（包含 `5733d92` 的 MP09/MP10 最终交付），合并提交 `a7148b6`，无冲突。合并后相关 17 项控制器、Frontend typecheck、正式构建与 37 页官方编译再次通过。

## 可操作路径

- 当前就绪书稿 → 收货地址 → 确认制作 → 制作进度。已有地址可在确认页修改并返回；填写地址使用购买时固定的配送范围、版本和服务端手机号校验。键盘高度驱动底部操作区位置，保留未保存编辑提示。
- 确认页读取真实书名、封面、版本、页数、收货信息和首本权益。没有恢复双方确认、逐页勾选或手写门槛；当前就绪 PDF、权限、实体权益和地址仍由服务端验证。
- 提交前按 API、账号与项目存储原幂等键、确定书稿/PDF/地址 hash 和展示摘要。响应未知先查原状态；重新打开页面仍可继续查询。未查到生产记录时仅重试原提交，即使后来书稿或地址变化，仍展示原摘要并使用同一键与绑定；确定冲突后重新读取并让用户确认。
- 制作页按当前预留版本读取确定书稿，不使用后来生成的新稿。待运营安排、印厂接单、完成印制、寄出、送达、取消核实中与确认取消分别读取真实服务端事实；印厂接单不冒充完成印制。
- 物流展示本次固定地址与实际承运商、单号，可复制单号；系统不自动查询物流。书稿、录音和新故事入口仍指向真实项目，已交付书稿保持固定。
- 取消继续由既有运营入口处理，设计的成员制作页没有取消按钮。未确认取消仍锁定制作；确认取消后从当前书稿修改地址或内容并重提。重提保留同一首本订单，旧尝试及旧地址/PDF 不被覆盖。

## 共享接口变化

`FulfillmentView.current` 现在仅返回当前 `reservationRevision` 的最新尝试；新预留尚未创建尝试时为 `null`，旧尝试仍在 `attempts`。修复“取消后重提仍显示旧取消状态”。网页制作页已直接消费新语义，删除旧前端状态修补。

新增 `deliveryAddress`，来自当前尝试或当前预留的固定地址快照及购买时地区名称，仅当前项目成员且资料仍可访问时返回；运营进度列表不借此暴露地址，仍使用既有材料访问入口。无数据库结构变更或兼容接口。

## 七张画板与原生待验

实现依据为原 `.dc.html` 与 [390px/320px 参考图](design-reference/manifest.json)。以下为初始验收清单；当前七张画板均有双宽开发者工具截图和交互证据，详见文末。

| 画板 | 真实入口与状态 | 尚待集成轮验证 |
| --- | --- | --- |
| BookAddress | 就绪书稿制作入口 → `/pages/address/index?projectId=…` | 390/320、地区选择、输入键盘、安全区、保存返回 |
| BookPrintConfirm | 地址保存 → `/pages/print/index?projectId=…` | 真实封面/页数、改地址返回、提交 |
| BookProduction | 已提交 → `/pages/production/index?projectId=…` | 等待安排/制作中/已印好、固定版本 PDF |
| BookShipped | 同一制作页读取已寄出尝试 | 固定地址、真实登记物流、复制单号 |
| BookDelivered | 同一制作页读取已送达尝试 | 已交付固定稿、继续录音入口 |
| BookCancelled | 运营确认取消后同一制作页 | 回当前书稿、修改后重提 |
| PrintUnknown | 提交响应未知后保留原操作 | 重进页面、先查询后重试、返回故事书 |

## 已执行验证

- 页面/管理端相关控制器共 17 项通过：`tests/print-pages.test.ts`、`tests/senior-flow.test.ts`、`tests/admin-fulfillment.test.ts`。覆盖地址连续路径、未知提交持久恢复、原键/原绑定重试、固定稿读取、预留不冒充制作、实际寄出状态，以及既有取消/运营行为。
- 真实本地 PostgreSQL/Redis：`first-copy.test.ts` 与 `fulfillment.test.ts` 共 24 项覆盖。首次 23 项通过，最后一项旧封面请求缺少 MP10 新字段；补齐 `coverMetadata` 后该项定向通过。新增固定地址快照断言后的取消重提场景再次定向通过。随机隔离 schema 与 Redis prefix 在测试结束后清理；支付、印厂等外部结果为明确合成夹具。
- API 测试编译、Contracts build、API typecheck/build、Frontend typecheck/build、Web typecheck/build、Admin typecheck 通过。
- `pnpm build:miniprogram` 生成 37 个正式页面；官方 `wcc`/`wcsc` 源模板与 `node scripts/check-native.mjs --built` 正式产物均通过。发现并修复 WXML 模板中转义换行不能编译的问题。

数据库执行（在 `apps/api` 目录）：`node --env-file=../../.env --test --test-concurrency=2 --test-timeout=120000 dist-test/test/first-copy.test.js dist-test/test/fulfillment.test.js`。失败修正后按上述用例名称定向执行，未重复无影响的整套检查。

真机键盘/PDF、实际印厂交接、生产、物流或实物交付仍待外部验收；未上传体验版、提审、部署或操作资金。

## MP12 集成原生检查点（2026-11-12）

正式 release 包 `74d7185` 的实际 320×568 窗口，真实本地 API／PostgreSQL／Redis，身份、支付、生产与物流状态均为明确合成夹具。[脱敏记录](evidence/MP12/native-book-print-320.json)和 [MP11/native 截图](evidence/MP11/native)记录以下结果：

- 当前就绪 PDF → 去制作 → 地址：真实填写姓名、手机号、详细地址；用原生配送 picker 选择第一地区后保存。确认页从 API 读回新地址、V2 与 `canSubmit=true`。发现 picker 未选择时传入 `-1` 使原生滚轮先出现空项，已改为视觉默认第一项，页面未选占位和校验保留；修复后的首次确认待原生复验。
- 实际点击提交后真实事务成功，进入制作页。首次单次响应丢失被开发者工具透明重试恢复，因此没有把该次记为 PrintUnknown。后续在真实已取消订单执行当前书稿→确认→重新提交，代理丢弃三次真实 201 响应，原生进入 unknown 并保留 intent；采集 [PrintUnknown-320](evidence/MP11/native/PrintUnknown-320.png) 后解除丢响应，实际点击查询恢复同一原订单的预留。当前尝试为 null，旧取消尝试没有被当作新制作结果。
- BookProduction／BookShipped／BookDelivered／BookCancelled 均从真实 API 状态采集。制作页实际点击「查看制作书稿」打开 `fixedProduction=true` 的预留 V1，即使可编辑版本已 obsolete，仍读取预留 PDF hash。寄出页实际复制物流单号成功；取消页实际点击查看当前书稿，回到当前概览。
- 七张 320 画板均已采集。390、地址 picker 初始项修复复验和手机键盘继续待验；固定生产稿的 PDF 路径、取消后重提和未知提交查询均已在原生验证。

上表保留初始验收清单；逐画板最新状态见 design-map。

## MP12 最终原生收尾（2026-11-12）

七张画板已补齐 390。地址未选时打开原生 picker，未滚动直接确认首项，得到 regionIndex=0／CN-110000；真实保存后确认页 canSubmit=true。首次提交经真实 201 响应持续丢失进入 unknown，解除丢包后实际查询恢复原订单和预留。320 取消后重提、固定生产稿与物流复制的通过结果保留；实体生产与物流仍为外部待验。 详见[最终脱敏记录](evidence/MP12/native-final-acceptance.json)及 [design-map](design-map.json)；前文时间点的待验项以本段和映射为准。
