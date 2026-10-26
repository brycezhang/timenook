# T23 前端工程证据

## 范围

基线 `ec606dd37c67b91756bef152697082a63eacf8c2`，消费 T22 PR #58 的双方确认、固定 PDF/地址 hash 和唯一首本生产单。前端使用后端新增的 `FulfillmentView`；数据库事务、限时授权和权限重验归后端，真实印厂、物流、微信发货及纸书另行验收。本轮没有发送文件给印厂或创建真实外部物流。

- 新增小程序 `production` 页面，已提交首本页和已付款订单可进入；讲述者和发起人查询实际交接、制作、物流、交付或取消状态，不从演示 store 读取资料，不把待核实显示为接单成功。
- 讲述者本人，或持当前 `book_confirmation` 协助会话的发起人，明确选择后为当前生产尝试的确定 PDF 与配送地址授予限时交接权限；负责人、工单、版本/hash 均来自服务端。上限来自服务端的技术授权时限，未把该时限当作商业资料保留政策。未知网络结果保留原幂等键和原到期时间。
- 小程序离页、账号变化、会话失效和资料访问到期均清空私人进度与当次证据；迟到响应不能恢复。无有效固定绑定的响应不启用授权。协助入口仅按固定 `returnTo=production` 返回当前生产页，不接受任意返回 URL。
- Vben 在既有运营 shell 增加“生产与物流”，沿用独立管理员、MFA、CSRF 和服务端权限。表单覆盖审核、生产尝试、有限资料下载、人工交接、未知/接单/取消回执、物流/微信发货结果及交付。印厂引用固定为原订单 `approvedSupplierRef`，不能另选未准入供应商；本次期限由运营按约定日历明确填写。
- 运营取得最少 PDF/地址前后检查本次授权到期；浏览器校验下载字节数和 SHA256，再交付文件。到期或卸载清空地址与 Blob URL。下载副本和实体生产的边界明确显示。列表与详情共用返回的实际阶段；交付后仍可补录微信处理结果，不能改变首次物流时间或回退交付状态。
- 共享客服工单识别 `production_handoff` 为“生产交接核验”，隐藏无关的 D08 本人核验/换绑操作；完成状态描述交付或取消回执，不误述为账号换绑完成。

## 公开边界与 RED → GREEN

沿 ticket/父规格已约定的 Page/微信平台接口、实际 SFC 点击处理器和 HTTP 代理边界；不测试私有服务协作者。新增行为逐片执行，日志在仓库外。

| 行为                                        | RED / GREEN 日志                                       |
| ------------------------------------------- | ------------------------------------------------------ |
| 服务端待核实阶段、不虚构物流                | `/tmp/timenook-t23-frontend-progress-{red,green}.log`  |
| 资料访问到期与离页迟到响应                  | `/tmp/timenook-t23-frontend-expiry-{red,green}.log`    |
| 本人限时授权、固定版本及未知重试保留时限/键 | `/tmp/timenook-t23-frontend-grant-{red,green}.log`     |
| 公开前缀代理仅剥离一次                      | `/tmp/timenook-t23-frontend-proxy-{red,green}.log`     |
| 当前协助会话返回生产授权页                  | `/tmp/timenook-t23-frontend-assisted-{red,green}.log`  |
| 管理端建立固定版本尝试并保持重试意图        | `/tmp/timenook-t23-frontend-admin-{red,green}.log`     |
| 管理端地址按时清理及卸载迟到响应            | `/tmp/timenook-t23-frontend-materials-{red,green}.log` |
| 未知回执维持当前尝试、相同重试标识          | `/tmp/timenook-t23-frontend-receipt-{red,green}.log`   |
| 坏 PDF hash 不启用资料授权                  | `/tmp/timenook-t23-frontend-invalid-{red,green}.log`   |
| 交付后补平台结果保留原物流秒/毫秒           | `/tmp/timenook-t23-frontend-wechat-{red,green}.log`    |
| 生产列表与详情同步当前实际阶段              | `/tmp/timenook-t23-frontend-list-{red,green}.log`      |

最终相关回归 **82/82**：`production-page`、`admin-fulfillment`、`participation-page`、`first-copy-page`、`cloud-preview`、`session`、`navigation` 和 `admin-care-correction`。日志 `/tmp/timenook-t23-frontend-regression-final.log`。其中新增生产 Page 4，运营处理器 4；未将多轮增量相加冒充整仓全量。

小程序与预览类型检查、Vue 类型检查成功，日志 `/tmp/timenook-t23-frontend-typecheck-delivery.log` 和 `/tmp/timenook-t23-admin-typecheck-delivery.log`。小程序/预览构建成功（`/tmp/timenook-t23-frontend-build.log`）；最终 Vben 构建成功（`/tmp/timenook-t23-admin-build-delivery.log`），既有较大 chunk 提示仍在。Mac 官方微信 `wcc` / `wcsc` 编译 **21 页**成功，日志 `/tmp/timenook-t23-frontend-native.log`；后续只修改运营端或 TypeScript 校验，不改变该原生模板范围。

## 实际浏览器与待验

Browser plugin not available。主 Agent 使用仓库 Playwright 连接实际 API、PostgreSQL/Redis、PDF 渲染器及运营 HTTPS/小程序预览完成浏览器集成，最终结果及截图以 [T23 汇总](T23.md) 为准；本记录不将处理器测试当作渲染验证。

真实微信账号与双端设备、实际 D01/D02/D03/D05/D06/D08、供应商回执/文件接收与取消、物流、微信发货平台及纸书均未因本地合成测试通过而验收。限时授权只限制后续在线获取，不能回收已下载或发给印厂的副本，不承诺自动取消实物。最终固定提交、独立 Standards/Spec 审查及 PR/main CI 由 GitHub 交付记录确定。

## 末轮浏览器回归修复

整合 T22 与 T23 浏览器流程时，既有公开 T22 用例发现新“查看生产与物流”按钮位于 `context` 的父级保护外；私人数据清空后访问 `context.production` 导致预览渲染失败。RED 记录为 `/tmp/timenook-t23-browser-final.log`，拒绝页调试记录 `/tmp/timenook-t22-browser-debug.txt`。已改为 `context && context.production`，并检查所有新增生产页的 nullable `view/current` 引用：授权区及协助入口明确检查当前尝试，限时截止展示已检查 `view && view.current`。交付时间输入增设毫秒精度，与已有物流时间保持一致，不改变政策。

修复后 Mac `wcc/wcsc` **21 页**再次通过，日志 `/tmp/timenook-t23-frontend-null-guard-native.log`；首本/生产 Page 及运营点击处理器相关 **20/20** 通过，日志 `/tmp/timenook-t23-frontend-null-guard-related.log`。原 82 项回归的未变范围按适用范围复用，最终浏览器复跑结果由主 Agent 在汇总中记录，不据处理器通过追认渲染成功。
