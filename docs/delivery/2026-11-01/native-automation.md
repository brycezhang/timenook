# 原生自动化启动、路由与真实登录

2026-11-01，关联 [#130](https://github.com/brycezhang/timenook/issues/130)。工程基线为 `81fb6a4`（已合并 #127）。命令、前提和安全边界见[原生自动化说明](../../development-native-automation.md)。

## 已定位的问题与修复

1. 官方 CLI `auto` 返回后，`Tool.getInfo` 只有配置版本信息，不能证明实际页面已经渲染。曾实测 SDK 可响应而 `App.getCurrentPage` 五秒无响应，模拟器欢迎页与空页面路径仍在；原实现随后可能卡住截图或命令。
2. 源配置的 `3.10.0` 不在本机已安装/可选基础库中，工具曾无声采用 `3.17.6` 灰度版本（本机官方注册表 status=0）。该版本出现 `frame loaded without instanceInfo`、`unexpected current frame status timedout`，一次清理退出后还出现夏季编译器遗漏 `custom-tab-bar/index` 配置。自动编译偏好原本已开启，不能把问题归因于用户关闭自动编译。单次干净重启未单独解决。
3. 仅测试副本明确采用本机已安装的稳定库 `3.17.5`（status=1），并核对实际解析版本；根上传配置保持原状。初期文件追加触发编译、仅凭 SDK 或 Page.onReady 等待的方案均未计为成功，也未保留为自动重试/编译兜底。
4. 已复现的邀请页卡死还涉及路由完成边界：上一页虽有数据并可见，原生路由动画尚未结束，立刻调用业务方法再次 reLaunch 会使工具活动 AppService 帧失效。现在通过公开 SDK CDP 的 `MPPage.waitForReady` 和被动 `wx.onAppRouteDone` 监听等待真实渲染及动画结束，然后检查原生可见布局与业务状态。移除固定延迟，不拦截 Page 定义，不替换登录/网络。

## 本次验证

8 项确定性回归覆盖 SDK-only 欢迎状态不能放行、路由不匹配、原生 onReady 等待、路由动画尚未完成、可见布局与业务加载状态、成书页实际 `book-page` 根节点，以及有界失败后停止轮询和仅保存安全观察字段。已纳入 `test:frontend`，可单独运行 `pnpm test:native-automation`。相关前端类型检查及脚本格式/语法检查通过；没有重复运行全仓回归。

审查补充修复：SDK 探测对无法解析的 JSON 和合法 JSON `null` 以前会从 WebSocket 消息回调抛出未捕获异常，绕过失败保存及项目清理。新增真实本机 WebSocket 的确定性回归，分别先复现这两种异常，再验证固定文本的 `NativeProtocolError` 经 `startup:sdk` 拒绝并关闭探测连接，后续合法响应不能覆盖失败；顶层响应要求为非数组的非空对象。现有 8 项与新增 2 项共 10 项 helper 测试、相关脚本语法和格式检查通过；连接失败继续轮询及整套不盲重试的行为保留。本次仅改错误路径，未重跑原生 GUI，下面完整运行证据沿用既有结果。

官方 Mac 开发者工具 `2.01.2510290`，测试请求和实际解析基础库均为 `3.17.5`。下面两次运行均从全新临时项目自动启动，无人工重新编译或运行内整套重试。

| 独立运行                 | 结果与范围                                                                                                                                                                                                                                              | 完整机器证据                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:native-e2e`   | 全部通过：妈妈模拟购买/邀请、参与及换题、合成 MP3 输入与非空原生持久文件、同一购买项目故事确认/书稿确认/地址阻断/演示订单、Tab Page/筛选保留、修改失效与重确认、爸爸重复购买及原项目保留；音频服务、SDK、临时窗口清理通过                               | `/var/folders/7t/xgv_t04j7k74jfdhdh1p41tr0000gn/T/timenook-native-demo-Hbm1yX/evidence/result.json`；同目录 8 张合成演示截图 |
| `pnpm test:native-login` | 核心真实登录检查全部通过：`urlCheck=true` 且未配置域名实际被拒绝；真实 `wx.login`、`/users/me` 当前账号、无会话 401、首页持久会话恢复、退出后旧会话 401、重登同一账号/不同会话、参与 HTTP/页面；本次缓存及旧测试会话撤销、本机清除、SDK及窗口关闭均通过 | `/var/folders/7t/xgv_t04j7k74jfdhdh1p41tr0000gn/T/timenook-native-live-N9Xj3x/evidence/result.json`                          |

上述部署前运行的内部验收装配 `/orders` 为 404，订单页面已结束 loading 并显示服务不可用。机器结果明确记录 `orders.available=false`、`required=false`；该项只是装配可用性观察，**不计作订单模块 200 或真实收付款通过**。#129 部署后的本人订单 200 由其运行记录补验，也可用 `--orders-required` 强制要求。真实模式没有替换 `wx.login` / `wx.request`，未调用支付或麦克风，未保存账号界面截图。

## 支付部署后复测与启动诊断

17:18 起以 `3719910`（含协议错误处理修复）执行 `node scripts/test-native-login.cjs --orders-required`，结果为失败，保存在 `timenook-native-live-QGfHql/evidence/result.json`。请求与解析基础库均为 3.17.5，但 `page:home:render` 在 `route:null`、`rendered:false` 阶段超时，尚未调用真实登录；缓存会话清理因运行时不可访问而超时，SDK 断开与临时项目关闭成功。不能将此前真实登录成功记录复用为本次部署后订单 200。

随后仅诊断启动，不重跑完整登录或演示：

- `timenook-native-live-bsGRfs` 与 `timenook-native-live-2rAaVj` 启动通过；后者还验证第二个公开 SDK 连接在第一个连接断开后仍能读取真实页面。两次均完成断开及项目关闭。
- `timenook-native-live-vPjnCA` 在项目内持续写入合成证据 JSON 时复现相同渲染超时；仅将这些写入移到项目外的对照 `timenook-native-live-Qq9OcC` 也失败，故不能将失败归因于证据写入，未据此修改目录结构。
- 移除 SDK 就绪探测的单连接试验分别在 CLI 返回后遇到连接拒绝、仅等待 TCP 监听后遇到未初始化的 SDK 响应。两者只证明 CLI/TCP 就绪不足，未据此替换现有协议就绪检查。

只记录 SDK 方法名与完成时间的启动探针保存在 `/tmp/timenook-native-startup-probe.json`，未记录协议参数或响应内容。诊断期间 CUA 报告 Mac 已锁定且无法自动解锁，系统只读锁定标志也为真；其中一次启动仍成功，因此锁定与本次间歇性渲染失败的因果关系尚未确定。需要可观察的开发者工具桌面继续核实，当前不新增猜测性等待、重试或预检。此前完整演示及真实登录证据保留原范围，部署后严格订单检查继续待验。

## 失败证据

所有路径均为操作者本机系统临时目录下，结果不进入 Git。

- `timenook-native-e2e-codY4B/evidence/cold-start-repro.json`：原始脚本 SDK-ready/欢迎页与五秒无响应的脱敏诊断；一次外部文件变更后可继续，但这不足以证明可靠编译触发。
- `timenook-native-demo-hXboP8/evidence/result.json`、`timenook-native-demo-tKjA34/evidence/result.json`：初期编译/就绪探针失败及有界清理。
- `timenook-native-demo-Hj4Gx3/evidence/result.json`：单次官方退出/重启后的失败，实际灰度库为 3.17.6。
- `timenook-native-demo-459Tc1/evidence/result.json`：稳定库 + 原生 onReady 已通过启动，但未等待路由动画完成，邀请页阶段超时；清理完成。

这些目录的共同父目录为 `/var/folders/7t/xgv_t04j7k74jfdhdh1p41tr0000gn/T/`。它们只说明相应轮次的观察，不能与当前最终运行拼接为完整通过。

## 验收边界

演示使用合成静音输入和示例故事，不代表 ASR/AI 或真人采集。真实登录模式只验证开发者工具当前登录的一个真实微信账号；不替代双账号、双端真机、真实录音/上传/回听、中断、付款/退款、印制或实物结果。本轮不上传、切换体验版或提审。
