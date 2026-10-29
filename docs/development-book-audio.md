# T21 书中原声入口

T21 读取 T20 已冻结的稳定随机入口和有序原声清单。入口只定位一个故事版本，不能授予访问权，也不会随在线文字、目录或新书稿更新而指向最新版本。当前仍使用 T20 隔离合成配置，不代表正式小程序码、实物或生产准入已验收。

## 访问与版本

`GET /v1/book-audio/:entryId` 使用产品会话，返回固定故事版本、标题、有序录音摘要、当前 `accessEpoch` 和访问期限，沿用 `data` / `meta.requestId` 响应格式。`clips.sequence` 从 0 起保留书稿中的顺序，页面显示第 1 段、第 2 段。未登录、未授权或未知入口的响应不包含私密标题、正文或缩略图。

`GET /v1/book-audio/:entryId/clips/:clipId/content?epoch=N` 经同一 API 下载私有 MP3，支持 Range；客户端使用刚查询的 epoch。服务器复用 Media 文件读取与 Range 响应，读文件前后重验当前会话、讲述者绑定、共享范围、用途授权、epoch、资产状态与期限，不重定向到 OSS 地址。epoch 变化后必须重新解析入口，不能续用旧下载上下文。

回听和必要原声按 [ADR0017](adr/0017-lifetime-service-and-retention.md) 长期有效，不随制作、交付或日期到期。访问期限仅来源于当次安全授权。在线文字更正不会改写原声，明确撤回对应版本许可、撤权、解绑或移除录音仍会停止相应访问。访问拒绝仅说明当前无法回听，不推断资料已删除。纸书及用户已自行保存的历史导出副本不会被在线修改或远程回收。

## 小程序入口

原声页为 `pages/original-audio/index`，支持 `entryId=<随机标识>`、小程序码 `scene=<随机标识>`，以及普通链接扫码传入的 `q=<URL编码的HTTPS原声入口>`。浏览器预览路径为 `/#/original-audio?entryId=<随机标识>`。扫码定位符只含随机标识，不能包含会话或用户姓名。

原声页进入真实服务模式，未登录时只展示通用登录提示；登录或恢复后继续解析同一入口。获得授权后按固定顺序列出各段真实录音，通过鉴权网关下载临时文件，核对 SHA256 和字节数后本地播放。播放结束、离页、退出、换号、到期或失权时停止播放并清理临时文件；迟到结果不能恢复旧账号的内容。

正式使用还需要独立小程序 AppID、合法 request/download 域名、普通链接二维码规则或正式小程序码及双端扫码验证。合成 `.invalid` 链接和浏览器路由仅用于工程验证，不能当作正式纸书入口。

## 验证

沿用[本地开发](development.md)的 PostgreSQL/Redis、固定音频工具及[书稿](development-books.md)的字体/Chromium要求。测试使用独立可丢弃 schema 和 Redis 前缀，外部微信/支付/AI使用明确的合成替身，不加载私人云端凭据。

```sh
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
pnpm exec playwright test tests/admin/book-audio.spec.mjs -c playwright.admin.config.mjs
```

最终命令、精确提交、RED/GREEN 和真实待项见 [T21 工程证据](delivery/2026-10-22/evidence/T21.md)。
