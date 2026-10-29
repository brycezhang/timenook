# 官网线上展示版本发布

日期：2026-10-28（上海时间）。用户在官网代码合并后明确要求部署到线上；本次将展示预览发布到 [sgl.wootoon.cn](https://sgl.wootoon.cn/)，保留小程序尚未开放下单及不索引的状态。

## 发布来源与路径

| 项目           | 实际值                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| 源码           | main 合并提交 `1b9a4741ce0ddd4f14c76bc98aa8f14781fcc58f`（PR #71）                     |
| 已审查官网版本 | `006652a`，官网应用、演示故事、图片及 Logo 与 main 对应文件无差异；其最终 PR CI 已通过 |
| 目标服务器     | `106.14.11.96`，SSH 使用既有 `root` 访问                                               |
| 运行方式       | Nginx 直接提供静态文件，无官网 Node 进程                                               |
| 发布目录       | `/data/server/timenook-website/releases/20261028144705Z-website-1b9a474/site`          |
| 当前链接       | `/data/server/timenook-website/current` 指向上述 site                                  |
| Nginx 配置     | `/etc/nginx/conf.d/timenook-website.conf`                                              |
| 原配置备份     | `/data/server/timenook-website/backups/20261028144705Z-website-1b9a474.conf`           |
| 版本清单       | 发布目录上一级的 `website-release.json`，不在公开 Web 根目录                           |
| 压缩包 SHA-256 | `8aa718cc7ed128664e543cf0a1ce98c87a7fea5177fa32fb2cb29ea6fc61e9e1`                     |

本地从该 main 提交构建、完成官网类型检查与15项浏览器测试后打包。清单记录 `workingTreeDirty: false` 和 `previewOnly: true`。上传到独立 incoming 目录，远端核对压缩包 hash、提交与预览标记，再解压到新 release。服务器未编译代码。

先备份旧官网配置，原子切换 current 软链接，安装静态 root 配置，`nginx -t` 后 `systemctl reload nginx`。域名的 DNS、TLS 证书路径、HTTP ACME 入口与续期任务沿用原配置。未修改应用环境、API/Admin 发布包、数据库或用户文件。

## 切换与回滚

首次即时探测遇到旧 worker 返回503，脚本已自动恢复原配置。核对 systemd 的实际 ExecReload 为向 Nginx master 发 HUP 后，改为最多10次、每次间隔1秒的有界就绪检查；必须同时通过 HTTPS GET 与新首页字节比较才算成功，否则自动恢复。第二次切换的第2次探测通过，Nginx master PID 893 保持不变。

第一次上线前没有旧官网静态版本；恢复上述备份会恢复原来的503预留入口。紧急恢复旧配置的命令为：

```bash
cp /data/server/timenook-website/backups/20261028144705Z-website-1b9a474.conf /etc/nginx/conf.d/timenook-website.conf
nginx -t && systemctl reload nginx
```

后续已有官网 release 时，先记录 previous-current，再原子切换回对应 site，并通过公网确认内容。配置 reload 后等待新 worker 实际接管，不以 reload 命令退出0作为可用性证明。

## 公网与共享主机验证

- 公网 HTTPS 首页200，证书校验通过；HTTP入口308到HTTPS。
- 首页与本地 `dist/index.html` 的 SHA-256 相同：`01ceda96b0a6a78564ab8e6a4a1769679b9ff62c12a2395cecef43f8cd4ef6fb`。
- 公网JS、CSS和3张图片均成功读取，内容hash分别与本地构建一致。
- `/robots.txt` 为200；`/.env`、不存在页面及 `/website-release.json` 为404。
- 针对公网域名运行既有官网浏览器测试，15/15通过：320×760、390×664和1440×960的翻页、文字对照、问答、下单提示/键盘焦点、48px点击区域、图片、控制台和横向溢出。测试只操作展示界面，没有真实付款或采集。
- 内置浏览器自动化读取超时，使用已获授权的Playwright公网回归及截图验证；线上标签页通过 Codex 页面入口展示。
- `nginx -t` 通过，Nginx及 `timenook-api`、`legal-agent-api`、`legal-agent-worker`、`legal-agent-web`、`deed-fe` 均 active。
- TimeNook `/api/health/ready`、Legal Agent `/v1/health`、DeeD首页均200。此次仅reload Nginx，没有重启这些应用。

本次发布时，[合并后的 main CI](https://github.com/brycezhang/timenook/actions/runs/40707495160)仍在执行。官网代码与已通过完整PR CI的版本一致，本记录仅确认该独立静态产物和实际公网结果，不提前宣告整仓main CI成功。

## 保留的商业验收边界

当前可公开查看产品介绍和示例，下单按钮仍明确提示尚未开放。正式小程序进入、电脑扫码、真实套餐与购买验收仍在父规格 [#69](https://github.com/brycezhang/timenook/issues/69)；本次部署不将这些条件标为完成。
