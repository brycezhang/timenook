# T04 本地照片、PDF 与纸面原声探针

本探针只接收合成样本，用于 S0 技术验证。它不创建产品相册、书稿版本、授权或生产单。票据 [#5](https://github.com/brycezhang/timenook/issues/5) 的真实印厂、实物和双端验收仍须另行完成；运行结果见 [T04 证据](delivery/2026-10-22/evidence/T04.md)。

## 准备与复现

在仓库根目录使用 `.node-version` 与 `packageManager` 指定的工具链。已有 PostgreSQL/Redis 和 FFmpeg 准备方法沿用 [本地开发](development.md) 与 [原声探针](development-audio-probe.md)。

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm exec playwright install chromium
pnpm setup:print-font
pnpm test:print
```

字体获取脚本下载固定上游 commit 的 OTF，验证 SHA-256 后保存于 Git 忽略的 `.cache/print-probe/`。下载失败或 hash 不同均终止；渲染前再次校验，缺字直接拒绝，不能依赖宿主字体补字。CI 在 `pnpm check` 前安装固定 Playwright 对应的 Chromium 和字体。

照片入口的两个数值是本次试验放置框宽、高（毫米），必须显式给出。输出目录必须尚不存在：

```sh
PRINT_PROBE_ENABLED=synthetic-local pnpm probe:print photo \
  "$PWD/tests/print-probe/fixtures/synthetic.heic" \
  "$PWD/output/pdf/example-photo" 96 64
```

生成 `original.bin`、`preview.jpg`、`print.png` 与 `photo.json`，文件为 mode 600、目录为 mode 700。原图按原字节保留，衍生图从已定向像素重新编码，剥离 EXIF/定位数据。预览与印刷衍生图均将透明像素合成到候选模板的白底（`#ffffff`），避免 JPEG 与白底 PDF 显示不一致；此候选背景记录在 `photo.json`，不替代印厂纸张/色彩决定。后续重新生成使用新目录，不覆盖旧结果。

书稿输入为本地 JSON，结构如下；`photoDirectory` 为上一步绝对路径，`entryId` 来自受控 HTTP 入口。省略这两个字段可只验证文字分页。

```json
{
  "scope": "synthetic-local-probe",
  "title": "合成试验样书",
  "entryBaseUrl": "http://127.0.0.1:4310/timenook/v1/probes/print/entries/",
  "chapters": [
    {
      "title": "合成章节",
      "paragraphs": ["仅供验证的合成中文段落。"],
      "photoDirectory": "/absolute/private/path/example-photo",
      "entryId": "bN3Qw2ft4X8sML7R9jA0ZQ"
    }
  ]
}
```

示例入口 ID 是占位值，必须用 API 返回的随机 ID 替换。`entryBaseUrl` 只接受 localhost/127.0.0.1 HTTP 和上面的 `/timenook` 路径，参数不含身份令牌。当前 API 内部仍使用 `/v1/...`；本地测试显式模拟 [ADR 0009](adr/0009-shared-ecs-api-path.md) 的前缀剥离，没有部署该公网路由。

```sh
PRINT_PROBE_ENABLED=synthetic-local pnpm probe:print book \
  /absolute/private/path/book.json "$PWD/output/pdf/example-book"
PRINT_PROBE_ENABLED=synthetic-local pnpm probe:print inspect \
  "$PWD/output/pdf/example-book/book.pdf" "$PWD/output/pdf/example-pages"
```

`book` 生成一次固定文件及 `manifest.json`；`inspect` 用独立 PDF.js 渲染每一页 PNG、提取文字、从像素解码二维码并生成 `inspection.json`。所有页面均应人工看图。CLI 成功不代表已通过视觉或印厂验收。输出只放 `output/pdf/` 或系统私有临时目录；Vite 预览与管理端禁止读取探针产物、缓存和身份文件，Git 忽略本身不承担访问控制。

## 受控纸面入口

HTTP 探针复用 T02 `AUDIO_PROBE_ENABLED` 开关和独立短时测试身份，默认不存在，production 配置拒绝启动。文件 CLI 另须 `PRINT_PROBE_ENABLED=synthetic-local`，同样拒绝 production；两者均不授予产品账号权限。

- `POST /v1/probes/print/entries`，请求 `{ "clipId": "sealed-clip-uuid" }`。需 T02 Bearer 测试身份，且原声属于该身份、当前存储范围、已经封存。返回仅 `{ id }`，同一原声并发/重试返回同一随机 128-bit、22 字符入口。
- `GET /v1/probes/print/entries/:id` 再检查身份有效期、原声归属、封存状态与存储范围，成功返回 `{ clipId }`；随后沿用 T02 鉴权媒体网关 `/v1/probes/audio/clips/:clipId/content`。
- PostgreSQL `probe_print_entries` 通过唯一 `clip_id` 与外键保存映射。T02 operator cleanup 删除原声时映射级联删除。Redis 中只存短时身份，入口 ID 不是访问凭证。

可复现的端到端测试包含独立 schema、短时身份、上传/封存合成 MP3、预留入口、生成带码 PDF、逐页像素解码、受控 HTTP 解析及原声 hash 比对。它运行在 `pnpm --filter @timenook/api test` 内，不替换内部仓储。若要保留本轮合成样书，在编译测试后运行：

```sh
# 从 apps/api 运行；目录必须为一个新的私有目录
T04_ARTIFACT_DIR="$PWD/../../output/pdf/new-synthetic-proof" \
  node --env-file=../../.env --test dist-test/test/print-probe.test.js
```

测试结束删除独立 schema、Redis keys 和临时身份。保留的样书不含身份凭证；其中测试映射已清理，不能再扫码回听。授权、到期和未知入口返回真实 HTTP 拒绝；生产小程序码、微信登录与手机扫码尚未接入。

## 试验参数与资源边界

照片支持 JPEG、PNG 和当前验证过的单图 8-bit HEVC HEIC 候选。Sharp 预编译包本身不支持 HEVC，候选 HEIC 使用 `libheif-js/wasm-bundle` 解码，再由 Sharp 生成衍生图。真实 96×64 HEIC 合成文件的尺寸、HEVC 标识、输出像素颜色均已验证。含额外 EXIF 方位、ICC/HDR/非 8-bit、多图的 HEIC 保守拒绝；iPhone 各变体仍需独立样本验证。JPEG 的八种 EXIF 方位按独立象限颜色检查，原图不改写。

局部上限是 16 MiB 输入、1600 万像素、15 秒照片处理、128 MiB Node heap 与 384 MiB RSS 监控；PDF/检查进程为 60 秒、256 MiB heap 和 2048 MiB 进程树 RSS 监控。启动时检查 `ps` 可用性，每 50ms 采样；监测异常立即拒绝，超限杀死工作进程及已知子进程并删除 partial 目录。Sharp cache 已关闭，但这不是内存硬隔离。RSS 可在采样间隙超过阈值；生产 Worker 仍必须置于 OS/cgroup CPU/内存/进程限制内，本 CLI 不作为生产沙箱。`PRINT_PROBE_RSS_MIB` 与 `PRINT_PROBE_TIMEOUT_MS` 只允许降低上限，用于验证拒绝与清理。

固定候选模板为 148×210mm、0mm 出血、Noto Sans CJK SC Regular 2.004、Chromium 145.0.7632.6。照片使用 contain 放置，DPI 按实际占据的矩形计算，不按留白框计算；300 DPI 仅是合成试验提示阈值。装帧、纸张、页数范围、正式分辨率阈值与印厂色彩/格式要求留空。目录根据实际分页迭代，至多 8 次，不收敛失败；`book` 可选最后参数 `1` 用于复现不收敛拒绝。无法容纳的独立标题/图片块拒绝，不截断。

## 固定依赖与来源

| 用途 | 固定版本 / 许可 | 一手来源 |
| --- | --- | --- |
| 渲染 | Playwright 1.58.2 / Apache-2.0；对应 Chromium 145.0.7632.6 | [page.pdf](https://playwright.dev/docs/api/class-page#page-pdf) |
| 图像 | Sharp 0.34.5 / Apache-2.0 | [资源与安全](https://sharp.pixelplumbing.com/security/)、[HEIC 限制](https://sharp.pixelplumbing.com/install/) |
| HEVC 候选 | libheif-js 1.23.5 / LGPL-3.0 | [官方包与用法](https://github.com/catdad-experiments/libheif-js)；只在本地探针进程使用 |
| QR 生成 / 解码 | qrcode 1.5.4 / MIT；jsQR 1.4.0 / Apache-2.0 | [qrcode](https://github.com/soldair/node-qrcode)、[jsQR](https://github.com/cozmo/jsQR) |
| PDF 独立解析/逐页渲染 | pdfjs-dist 5.4.624 / Apache-2.0；@napi-rs/canvas 0.1.100 / MIT | [PDF.js 示例](https://mozilla.github.io/pdf.js/examples/)、[canvas](https://github.com/Brooooooklyn/canvas) |
| 字体 cmap 检查 | fontkit 2.0.4 / MIT | [fontkit](https://github.com/foliojs/fontkit) |
| 字体 | Noto Sans CJK SC Regular 2.004 / SIL OFL-1.1 | [固定上游字体](https://github.com/notofonts/noto-cjk/blob/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)、[保留许可](../scripts/print-probe/OFL.txt) |

字体 SHA-256 为 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`。完整依赖及平台二进制由 `pnpm-lock.yaml` 锁定。pdfjs-dist 与显式 canvas 必须解析为同一版本，避免不同 native Path2D 类型混用。
