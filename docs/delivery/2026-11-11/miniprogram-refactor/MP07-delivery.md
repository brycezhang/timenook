# MP07 项目照片交付记录

范围：[#172](https://github.com/brycezhang/timenook/issues/172)，消费 MP01 的公共样式、登录和 `tn-navigation` 契约（集成基线 `cac00f8`）。本票实现与运行验收分别记录，不代表已部署或真机验收。

## 当前接口

- `ProjectPhoto` 归项目；`PhotoIntent` 删除 `interviewId/actualQuestionId`，SQL 同步删除旧复合外键，`PhotoReference(projectId, photoId)` 只接受同项目素材。采访仍有不可变 `PhotoMaterials`，保留历史故事/书稿快照。
- `GET/POST /projects/:id/photos` 列表/预约；`/:photoId/status|upload|seal|release` 复用可靠上传与封存。封存只计一次素材额度，不自动建立采访；release 仅取消未完成上传。
- `GET /projects/:id/photos/:photoId/assets/:assetId/content` 通过项目授权、内容 hash 校验和活动流权限检查下载。`PhotoFiles.open(projectId)` 按账号/项目保留本机待上传原图；`privatePhotoPreview(projectId, photoId, asset, current)` 不再接收采访 ID。
- `GET/POST /projects/:id/interviews/:interviewId/photo-materials` 读取/替换本次照片选择，`/:snapshotId` 读取固定版本；`/:photoId/crop` 为本次关联生成派生快照。重复引用不产生新素材或额外额度，去关联不删除旧引用。
- 封面候选直接读取项目印刷素材，零故事也可选封面。`BookPhoto` 删除不再成立的采访归属字段。
- 原生 `/pages/photos/index?projectId=...` 展示项目空态/两列照片、添加、预览、选择开讲。带 `interviewId` 或 `storyId` 时选择项目素材并明确保存到该次讲述/故事；照片起讲先建采访并追加选图快照，再进入实际录音准备。
- 网页照片页、故事照片、录音展示与封面消费者同步新接口；素材仍通过 Cookie/CSRF 或小程序 Bearer 进行当前权限核验。
- erasure-registry 及 SQL 注册现有 `photo_assets` 和 `photo_references.caption` 均以 project_id 定位。本次只移除 PhotoIntent 的旧外键列，没有新增私有载荷或独立清理路径；当前原图/派生图/冻结快照删除约束沿用。

## 工程验证

- 真实 PostgreSQL/Redis：零采访创建/列表、跨采访复用、一次配额、跨项目拒绝、并发封存与恢复、原图/派生图完整性、裁切和不可变关联、首次故事冻结照片均已执行。
- 零故事封面候选/保存与已有封面冻结 PDF 测试通过。首次 PDF 测试因新工作树缺少固定字体失败；复用已校验的本机字体缓存后通过，未改渲染实现。
- 132 项照片/采访/故事/会话定向页面回归通过；原生与网页类型检查、29 页正式原生编译通过。
- Chromium 与 WebKit 对真实 API/数据库的照片上传中断重试、故事补图/说明、移除关联、项目选图起讲及录音照片显示均通过。测试图片、登录/存储与麦克风输入为隔离夹具，不能据此声明真实微信/OSS/设备采集通过。
- 集成 `dbc58f4` 上补验真实 PostgreSQL/Redis 的历史载荷与文件删除回归通过：`deletion.test.ts` 的 `all historical payloads and owned files disappear while minimum version and financial shells reject restoration`。覆盖当前项目素材与冻结快照清理，未使用线上资料。

## 原生设计与外部验收

主责画板为 `Photos`。已在真实 DevTools iPhone 12/13(Pro) 配置确认 `wx.getWindowInfo().windowWidth=390`，以实际 API/PostgreSQL/Redis 完成空相册→添加三张图片→选图→从照片开始讲述；[持久化结果](evidence/MP07/photo-recording-result.json)核对项目含三张照片，新采访只关联选中的一张。未启动麦克风。登录、相册选择和图片输入为明确测试夹具，图片实际经过微信本机保存、HTTP 上传、后端处理、下载与 hash 校验。

- [390px 项目照片](evidence/MP07/native/Photos-390.png)：两列、150px 高照片、22px 页面内边距、添加卡片与设计对照无溢出。测试素材来自仓库公共示例，照片标题显示真实默认名称。
- [空相册](evidence/MP07/native/PhotosEmpty-390.png)、[选中照片](evidence/MP07/native/PhotoSelected-390.png)、[照片进入讲述](evidence/MP07/native/PhotoToRecording-390.png)。最后一张仅证明采访与照片传递，录音页的最终视觉由 MP09 更新。

早期自动化选择使用缓存文件作为临时文件，微信 `saveFile` 返回 permission denied；改用真实 `wx.downloadFile` 产生的临时文件后完整上传成功，未修改产品逻辑绕过。原 MP05 fixture 进程已结束，本次重建隔离服务后运行；连接失败不计作业务失败或通过。

仍待 320px、最终首页照片数入口和系统图片查看器验证；Mac 锁屏尚未解除，不将 390px 局部结果计为整票完成。真实手机相册/相机、微信账号、OSS 和麦克风验收仍另记；本票未部署、未上传体验包、未提审。

2026-11-12 集成补齐 [Photos 320px](evidence/MP07/native/Photos-320.png)：37 页 release 包，真实 MP06 项目照片列表/受保护图片读取，1 个合成照片已加载，与原 390px 图共同对照；没有页面数据注入。照片数量和颜色来自声明的上传素材。
