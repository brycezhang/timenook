# 手机网页与小程序统一流程：运行验收

日期：2026-10-29 至 2026-10-30。入口为 [手机网页](https://sgl.wootoon.cn/app/)；根路径营销站保留。当前是受控内部功能验收，无公开注册、真实网页收款或实体书生产。

## 已发布的运行配置

- ECS `106.14.11.96`：`timenook-api` 与 `timenook-worker` 实际运行，公开同域 `/api/health/ready` 返回200。
- API/Worker 源候选为 `2b9f8f6d693ad936dbe21f3968b1da11e0a3c6fb`，发布目录 `/data/server/timenook/releases/20261029-unified-2b9f8f6b`。类型、API与网页构建在本地完成；服务器复用既有Linux运行依赖并生成Prisma客户端，执行必要数据库迁移。
- 网页独立发布到 `/data/server/timenook-web/releases/`，`current` 原子切换；`/app/` 深链、邀请、书中原声与同源 `/api/` 已接入现有 HTTPS 域名。网页初次实际试跑修复邀请告知尚未加载时的空对象渲染，静态候选 `971e639` 已发布。
- 原服务器 `.env` 保留；新增受保护的 `.env.internal-acceptance`，systemd drop-in 为API/Worker加载两份文件。独立隐私台账沿用既有源和密钥并显式激活，checkpoint为0；密钥、Cookie、登录链接与私有证据不进入Git。
- 产品私有OSS Bucket为 `timenook`，前缀 `timenook/product/internal`，与探针隔离；CORS仅追加 `https://sgl.wootoon.cn` 的POST，保留原规则。实际读取Bucket生命周期为空，没有定期删除规则。ASR复用豆包，故事整理复用既有DeepSeek适配及已配置中转服务。
- 独立微信AppID/Secret和支付仍为空；关联入口如实显示暂不可用。legal-agent原三项服务运行正常。

## 同一项目的实际网页链路

在两个独立手机尺寸浏览器上下文中使用预建产品账号，通过一次性链接明确登录；项目为 `f1682bd4-a75b-40ba-8c41-b91d89ef366b`，来源 `internal-acceptance`。

1. 发起人从共享项目页准备并复制网页邀请；讲述者申请，发起人核对批准。
2. 讲述者在网页分别同意采集、AI和共享；服务端记录实际 `self_web` 渠道。
3. 共享采访页选题、准备、真实浏览器采集、暂停/继续、回听及明确提交。设备输入是明确标注的中文合成WAV，没有替换网页录音器或供应商网络。
4. 原件实际编码为 `audio/mpeg`，35,892 ms、215,352 bytes；私有OSS回取与封存SHA256均为 `93937c8ab5dde48a58cee32f2c69ed56bfe3bffddb99ef55a7fa0d96497b758c`。
5. 真实ASR成功，正式转录任务 `2ff916f5-5212-464e-84bd-3403628735bb`；初次及补充后的两个整理请求均保留为人工核查，没有改成已知失败或重发相同输入。

## 实际连接故障与后续故事

普通进程与真实Worker服务环境有不同连接结果。使用同一DeepSeek适配器和独立的极小虚构诊断输入，在相同timenook用户及systemd约束下复现：fetch在取得HTTP响应前以ETIMEDOUT结束；仅将网络族连接尝试改为1500ms后，HTTP200、合法JSON及适配器输出校验成功。目标环境加载 `NODE_OPTIONS="--network-family-autoselection-attempt-timeout=1500"` 并重启API/Worker，公开ready200。

不确定请求没有改为失败或绕过守卫。修复后，讲述者在同一项目以正常自拟新问题记录另一段有实质新内容的虚构讲述，真实ASR和DeepSeek整理成功。新采访 `fb9c6e46-0993-4a41-aeba-c266b86183b3`，故事 `e5af98c9-5514-4789-a170-6cad1602ab8e`，标题“和妈妈去菜市场的星期天”。本人逐项说明两项核对内容后形成第2版，并分别确认正文和允许入书。原两段录音、转录及不确定请求仍保留。

实际PDF渲染被完整性校验拦下。对照实际frozen snapshot逐字定位仅“青菜”的青（U+9752）被固定字体的ToUnicode提取成⻘（U+2ED8）；其他正文完整匹配。仅补这一已证实的字符别名，保留全文检查。该句真实PDF回归修前失败、修后通过；实际snapshot在本地修复后生成5页PDF并通过全文/图片/二维码检查。云端将按既有renderer源码hash规则生成新的书稿版本，保留原失败版本和确定故事第2版；实际结果待补录。

## 证据范围

真实浏览器HTTPS/Cookie、实际Page、AudioWorklet/MP3、本机保存、OSS及文件转写已执行。合成WAV在暂停时仍推进且结尾循环，实际转录保留这些输入差异；不把它作为完整转录质量或真机体验结论。确定PDF与最终合并CI在完成后补充。

小程序复用同一WXML/WXSS/Page与业务客户端，官方26页编译通过；微信真实身份互通、真机录音/锁屏、人工目标用户及纸书印制仍未验，不由网页自动化替代。原生与网页保留可靠保存先于转写、可选追问、本人确认/入书许可和双方同版PDF规则。
