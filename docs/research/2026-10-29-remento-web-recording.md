# Remento 网页录制流程调研

查看日期：2026-10-29（Asia/Shanghai）。用途：为 TimeNook 手机优先网页端的分步录制流程提供一手证据。本文是研究结论与设计建议，不是已接受规格、Remento 登录后实测报告或 TimeNook 验收结果。

## 范围与证据等级

主要参照 Remento 的 **Life Story Book**，不混用 Baby Book、Ornament 的参与者、权限或录制规则。查阅了官方网站、官方帮助中心及当前 TimeNook 源码/ADR；没有注册、购买、发送邮件短信或上传素材。

- 官方营销页可以证明其对外描述，不能证明登录后具体布局或内部状态机。
- 官方帮助中心给出了实际操作步骤，本文据此还原业务流程；仍不等于使用账户完成了一次录制。
- `https://web.remento.co/signin` 的网页文本读取为空；浏览器工具加载超时，因此本轮没有可用登录页截图。帮助文章内嵌官方录制视频 `https://www.youtube.com/embed/-D2vwvRmpSo` 抓取被限流，未将视频画面当作证据。
- 以下“建议页面”是结合 TimeNook 既定业务推导的设计，不声称 Remento 恰有同样页数、路由或组件。

## 可核实的产品行为

| 主题 | 一手证据所述行为 | 对 TimeNook 的意义 |
| --- | --- | --- |
| 无需安装 | 官网宣传可通过手机直接使用，无需安装应用；录制帮助明确支持浏览器入口。 | 借鉴低门槛入口；不能把宣传中的“无需登录”解释成任何访客均有项目权限。来源：[官网](https://www.remento.co/)、[按需录制](https://help.remento.co/en/articles/8865517-how-do-i-send-a-prompt-or-record-a-story-right-now)。 |
| 登录与直接录制入口 | 录制可从最近邮件/短信中的专属链接进入，也可登录账户后选择问题。账户登录本身是邮件链接或 8 位验证码；链接应在发起登录的设备使用。 | 录制入口和完整账户登录是两个不同场景；邮件模式不能直接替代 TimeNook 网页与微信的账号绑定设计。来源：[录制说明](https://help.remento.co/en/articles/8365951-how-do-i-record-a-memory)、[登录说明](https://help.remento.co/en/articles/11732077-how-do-i-log-in-to-my-remento-account)。 |
| 选择问题 | Life Story 的 Prompts 页区分已发送和待发送问题；手机先打开某条问题，再选 Record now。已发送问题不能再编辑，未发送问题可编辑。 | 单个实际问题作为一次讲述的起点；将未来计划与实际提问分开。来源：[录制说明](https://help.remento.co/en/articles/8365951-how-do-i-record-a-memory)、[管理问题](https://help.remento.co/en/articles/8365920-how-to-add-and-manage-prompts)。 |
| 照片起点 | 可上传照片形成问题并补写提问；每张照片分别成为一个 prompt。也可在既有故事完成后补图，不需要重新录音。 | 对应 TimeNook 的看照片讲述和事后补图，但不引入“一张照片必然一个故事”的约束。来源：[管理问题](https://help.remento.co/en/articles/8365920-how-to-add-and-manage-prompts)、[照片说明](https://help.remento.co/en/articles/13523522-how-to-scan-and-add-photos-to-remento)。 |
| 录前准备 | 进入录制后选择音频或视频、授予麦克风/摄像头权限；权限帮助说明界面可用音量指示检查麦克风。 | 可借鉴独立准备步骤与输入反馈；TimeNook 首版是否新增视频是范围决定，不能由参考网站自动引入。来源：[录制说明](https://help.remento.co/en/articles/8365951-how-do-i-record-a-memory)、[权限说明](https://help.remento.co/en/articles/8751840-what-do-i-do-if-i-decline-camera-microphone-permissions)。 |
| 录制与回听 | 显示问题和明显的开始按钮；支持暂停/继续；Stop 后进入 Review and Submit。回听时可返回录制界面继续追加，再停止并提交。 | 录制、回听、提交可分步呈现，避免把所有状态和操作堆在一屏。来源：[暂停和继续](https://help.remento.co/en/articles/9358385-can-i-pause-and-resume-recording)。 |
| 可选追问 | 上传完成后产生一条可选追问，可回应或跳过；回应会回到录制页，补充同一故事。官方录制说明限定一次录制可回答一条追问。 | 与 TimeNook 的“一条可选追问”方向接近，但 TimeNook 仍须满足已封存且转写完成的输入条件。来源：[录制说明](https://help.remento.co/en/articles/8365951-how-do-i-record-a-memory)、[补充故事](https://help.remento.co/en/articles/12080296-how-to-add-more-to-a-story)。 |
| 处理等待 | 有独立 processing 状态；处理过程中仍可记录另一篇故事，原始录制被保留。官方给出的分钟数是其服务说明，不是 TimeNook 时延指标。 | 上传成功与文字完成分开，等待不应锁住全部使用路径。来源：[处理等待](https://help.remento.co/en/articles/8865641-what-do-i-do-if-i-see-a-story-processing-screen)。 |
| 下一篇故事 | 最后一步提供 Record Another Story；用户可从未答、热门和待发送问题中选择，也能跳过、编辑、自己写问题或上传照片。 | 下一篇是一条独立选择路径，不是强制逐题完成的问卷。TimeNook 不必复制热门榜或自动发送队列。来源：[连续记录](https://help.remento.co/en/articles/9508318-can-i-record-more-than-one-prompt-at-a-time)。 |
| 中断恢复 | 官方表示尽力保存意外中断的录制，存在限制；重新选择同一问题后可能出现重新开始、继续录制、提交此前录制的恢复选择。恢复弹窗阶段可能无法预听，提交后才在 Stories 访问。 | 可借鉴按同一问题找回待处理录音；不能宣称后台、断电或断网必然不丢。来源：[恢复录制](https://help.remento.co/en/articles/13468241-can-i-recover-my-recording)。 |
| 手工补录 | 可向同一故事追加录制；文稿不会自动更新，需要主动生成预览并保存；追加的声音与原故事一起访问。 | 原声追加与文稿变更是两个动作，适合保留明确版本确认。来源：[补充故事](https://help.remento.co/en/articles/12080296-how-to-add-more-to-a-story)。 |
| 重录 | 已提交故事支持重录，原录制与新录制并存，用户决定保留哪个；原声音频本身不能局部编辑。 | 重录不应立即破坏旧原声或悄悄替换已确认版本。来源：[重录说明](https://help.remento.co/en/articles/8365963-can-i-re-record-or-add-more-content-to-a-submitted-recording)。 |
| 编辑和归档 | Stories 是查看录制和文稿的入口；文稿可直接编辑，也可选整理风格后预览并保存。原声音频保持不变。 | 借鉴“生成建议稿 → 主动编辑/保存”，继续遵守 TimeNook 本人确认和入书许可。来源：[文稿编辑](https://help.remento.co/en/articles/10198884-how-remento-turns-recorded-memories-into-written-stories)。 |

## 建议的分步录制页

下面是 **TimeNook 设计建议**，不是对 Remento 页面逐像素复制。沿用品牌视觉、中文文案、一位讲述者和一位发起人的业务范围。

1. **这一段想讲什么**：显示当前问题和可选照片，提供换题、自己说一段、稍后回答；进入录制时固定本轮实际提问。可从邀请、问题计划或项目主页直接进入已选问题。
2. **准备开讲**：简短说明录音用途、当前讲述者与操作人，麦克风授权及音量反馈；已经授权的正常回访减少重复步骤。本人参与授权仍由服务端检查。
3. **录制**：一屏一个问题、明显计时和主要停止按钮；若采用暂停，明确暂停期间不采集声音。离开或中断时处理当前录音，不把导航动作等同于保存成功。
4. **回听与保存**：播放刚录内容；支持继续补充、明确放弃本次、保存。放弃或重录需要避免误删既有已保存素材。文案分别说明当前只在本机还是已传到服务器。
5. **保存后的下一步**：展示上传/封存与转写状态；允许离开后恢复、继续补录或结束本篇。转写具备后显示可选追问；跳过追问不会阻止整理。只有已选片段转写齐全才可整理故事。
6. **故事阅读与确认**：阅读建议稿、听原声、改错、补照片，讲述者分别确认内容与入书许可；修改相关内容使旧确认失效。返回项目或选择下一篇。

其中第 5 步的选择取决于已存在的后端任务状态，不能固定成“下一页就有故事”。同一采访可以有多段声音，后退/重进不得新建重复采访或重复外呼。

## 和当前 TimeNook 的差异

本地依据：[词汇表](../../GLOSSARY.md)、[个人采访计划 ADR](../adr/0005-personal-interview-plan.md)、[保存后文件转写 ADR](../adr/0006-file-asr-after-save.md)、[当前采访页面](../../miniprogram/pages/interview/index.wxml)、[本机录音生命周期](../../miniprogram/services/local-audio-recorder.ts)、[浏览器媒体适配](../../preview/media.ts)。

| 项目 | 当前情况 | 移植时应处理 |
| --- | --- | --- |
| 页面结构 | live 采访页同时呈现录音、本机片段、上传、转写、追问等多个区块。 | 将呈现拆成步骤，但继续复用公开接口与保存状态；页面拆分不是新建多个业务采访。 |
| 暂停/继续 | 当前 `LocalAudioRecorder` 公开生命周期主要是开始、停止、保存/重试；浏览器适配没有导出 pause/resume，切后台会发中断事件。 | Remento 的暂停体验需要新实现与验证；可评估原生暂停或分段保存后补录，不能只改按钮文案。 |
| 自动保存 | 浏览器当前录制 chunks 保存在内存，停止后生成 Blob，再保存到 IndexedDB。 | 现状不能证明强杀/崩溃前的进行中片段可恢复。若要求该能力，需要设计可验证的分段持久化与恢复，不从 Remento 营销推导已有保证。 |
| 音频与视频 | TimeNook 既定主流程为语音录制。 | 首版建议保持音频；视频会新增存储、权限、带宽、处理与书中回放范围。 |
| 身份与参与 | TimeNook 当前小程序身份、同机协助、讲述者本人授权相互区分。 | 网页入口可以减少登录摩擦，但链接持有不能自动成为讲述者或授予全部项目权限。 |
| 追问 | TimeNook 由可靠封存、正式转录和明确输入版本驱动按需追问。 | 不因参考自动追问就改成录制中实时字幕或聊天；继续允许跳过、继续补录、离开恢复。 |
| 文稿与出版 | TimeNook 固定故事版本，并要求本人确认及入书许可；书稿另有双方确认。 | Remento 编辑/再生成可能覆盖文稿的方式不直接照搬；当前本地版本和授权要求继续生效。 |
| 时间政策 | TimeNook 已决定长期制作、回听、下载。 | 不引入 Remento 的年度录制订阅规则。 |

## 不可据现有证据断言的事项

- Remento 使用哪套前端框架、后台队列、存储、分片协议、数据库，以及“自动保存”的精确频率、事务边界或最长可恢复时长。
- 手机微信内置浏览器中的实际兼容性、系统来电/锁屏/杀进程的完整行为，以及录制是否可离线完成后续传。
- 其录制链接的有效期、签名方式、是否一次性、权限范围及与账户的精确绑定机制。
- 登录后各步的精确像素布局、实际路由、转场动画及页数；本轮没有登录后 UI 操作证据。
- Remento 提供的音频上限、处理分钟数和上传成功提示，不构成 TimeNook 的性能或可靠性验收结论。

官方说明中也存在需谨慎解释的口径：按需录制文章说一场录制应一次完成、不提供离线录制后上传；恢复文章又说明意外中断可能找回。两者可分别理解为常规使用要求与尽力恢复机制，不能合并成“支持离线且可随时跨设备续录”。引用：[按需录制](https://help.remento.co/en/articles/8865517-how-do-i-send-a-prompt-or-record-a-story-right-now)、[恢复录制](https://help.remento.co/en/articles/13468241-can-i-recover-my-recording)。

## 应进入规格的决定

- 将“分页”定义为上述分步任务界面，而不是一条问题列表每页若干项；用户仍可自由选择问题，不强制依序答完。
- 建议首版保持音频录制，采用录制 → 回听/保存 → 处理/可选追问 → 故事确认；是否需要像 Remento 一样在同一录制中暂停并继续，应写成明确验收行为。
- 登录方式与跨端账号绑定单独决定；Remento 的邮件免密只是一个参考，不代表国内讲述者最适合的方式。
- 区分正常恢复保证与尽力恢复；先明确哪些时点必须可恢复，再决定是否需要进行中的周期持久化。建议至少保证已提示“本机已保存”及“云端已保存”的素材与文字状态相符。

上述属于待规格化建议，未在本轮改写业务代码、授权规则或产品承诺。
