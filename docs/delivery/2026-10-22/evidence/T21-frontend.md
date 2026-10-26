# T21 小程序原声入口工程证据

本票沿用已确认的 Page/服务公开行为与微信平台边界。新增 `pages/original-audio/index`，接受直接 `entryId`、小程序码 `scene` 内的随机标识或微信扫码规则传入的 HTTPS `/audio/<id>` 链接。入口仅保留 22 位随机定位符，登录过程中不读取演示项目，不展示私密标题，也不在客户端替代真实微信身份。

## 已实现

- 冷启动扫码保留定位符并进入 live 模式；使用已有产品会话查询，缺少身份时停在登录说明。微信登录返回前的前台事件不覆盖进行中的登录；成功后查询同一个定位符。
- 原声清单保留 T20 冻结的故事修订及从 0 开始的片段顺序；界面按第 1、2…段显示，只下载用户选中的片段。
- 播放前查询当前清单，以该次 `accessEpoch` 经既有 Bearer 下载边界取得私有临时文件。复用故事回听的临时文件登记、SHA256/大小校验及清理；校验后再次解析同一入口，epoch、资产与摘要变化均拒绝播放，不直接播放 OSS 地址。
- 结束、停止、离页、退出登录、会话失效、账号变化及在线访问恰好到期时销毁播放器并清理临时文件。失败清理保留登记以供下次重试；清理失败不阻止本机退出身份，设备未能移除会话时如实显示退出未完成。迟到响应与旧计时器不能恢复或清除较新的页面状态。
- 正文以 40rpx（390px 容器约 20.8px）呈现；主按钮至少 100rpx（约 52px）。页面说明固定原声、在线期限和已交付纸书/导出副本的边界，拒绝访问不声称资料已删除。
- 浏览器预览只增加本票的解析及临时文件下载通道；Vite 精确匹配入口和含 `epoch` 查询的内容地址，按现有规则移除本地 `/timenook` 前缀，支持目标本身带该前缀。

## RED → GREEN 与回归

原声页按匿名入口、授权解析、真实下载边界、微信登录恢复逐条增加测试；初始不存在页面的失败仅证明缺少入口，后续公开行为失败/通过另有日志。退出时清理失败阻断身份清除、旧到期回调清除较新查询、设备会话移除失败误报退出，以及 T20 零基顺序的契约差异均各自先出现失败，再补相应实现。

| 检查 | 结果/日志 |
| --- | --- |
| T21 Page | 15/15；`/tmp/timenook-t21-page-frozen-order-green.log`，后续格式化后包含于下行回归 |
| 相关 Page/Session/Vite/私有文件回归 | 93/93；`/tmp/timenook-t21-frontend-related-final.log` |
| 前端及 preview 类型 | 成功；`/tmp/timenook-t21-frontend-types-final.log` |
| 小程序及 preview 构建 | 成功；`/tmp/timenook-t21-frontend-build-final.log` |
| Mac 微信原生编译 | wcc / wcsc 20 页成功；`/tmp/timenook-t21-frontend-native-final.log` |
| Vite 查询参数路由 | 添加公开路径用例先 RED、修复后 GREEN；`/tmp/timenook-t21-proxy-{red,green}.log` |
| 下载/登录/清理/到期增量 | `/tmp/timenook-t21-page-{play,login,logout,stale-timer,logout-storage,frozen-order}-{red,green}.log` |

相关回归命令：

```sh
pnpm exec tsx --test tests/book-audio-page.test.ts tests/story-confirmation-page.test.ts tests/story-page.test.ts tests/session.test.ts tests/cloud-preview.test.ts tests/private-artifacts.test.ts
pnpm typecheck:frontend
pnpm build:frontend
pnpm check:native
```

Page 测试在微信平台边界提供 request/downloadFile/login/文件系统/播放器/时钟替身，实际运行页面、产品会话和私有音频服务；没有模拟内部模块。浏览器实际 Page/HTTP/PG/Redis 与真实文件验证由 [T21 汇总](T21.md)单列，不用这些平台替身结果替代。

## 浏览器联调后的 HTTP 修正

实际浏览器经真实 Fastify 的退出登录暴露空 JSON 请求：共享会话传输为无请求体的 DELETE 也设置了 `application/json`，服务端按实际请求返回 400。补充 SessionClient → 微信 request 传输 → 真实 Fastify JSON parser 的公开行为测试，先稳定失败，再修正无体请求的类型。

微信官方随安装类型提供的 `miniprogram-api-typings` 对 `wx.request` 明确记录默认 `content-type` 为 `application/json`，因此仅删除客户端显式头不充分。无体 GET/DELETE 显式发送 `text/plain`，有实际数据的 POST 保持 JSON；不伪造空对象，也不修改服务端 JSON 验证。测试在微信边界补齐这个原生默认值后，省略头的中间版本再次 RED，最终明确类型后 GREEN。日志为 `/tmp/timenook-t21-session-bodyless-{red,green}.log` 及 `/tmp/timenook-t21-session-native-default-{red,green}.log`。最终相关 93 项包含这项真实 parser 回归；真实浏览器退出 204 验证由 T21 汇总单列。

原声 WXML 的 `wx:else` 改为显式空值，兼容浏览器现有 XML 解析器；Mac 原生两种写法均可编译，浏览器实际渲染另由端到端流程验证。

## 外部条件

未执行正式二维码规则或小程序码准入配置、真实微信登录、iOS/Android 真机扫码及播放、真实已印纸书或目标讲述者验收。原生编译和浏览器模拟入口不构成这些证据。正式回听期限和 D08 参数仍由责任票冻结，本票沿用隔离合成测试门禁。
