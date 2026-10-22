# Issue tracker: GitHub

仓库为 brycezhang/timenook。用 gh 读取/修改 GitHub Issues；多行正文写临时 UTF-8 文件，以 --body-file 传入。

规格为父 issue，每票为一个子 issue，使用 GitHub 原生父子与 blocked-by 关系。使用 gh api 返回的 numeric database id 建立关系；如果平台不支持原生关系，在正文保留明确 Parent / Blocked by 引用并报告降级。

每次开始前读取票据正文、评论和依赖，只领取所有阻塞票均完成的工作。ready-for-agent 表示规格可执行，不代表无依赖或外部验收已通过。外部证据未齐的工作标 ready-for-human 或 needs-info，并说明可继续的本地工作。

新功能以 ticket 分支交付，PR 关联对应 issue；PR 合并且票据验收证据齐全才关闭。仅实现/模拟通过时用 Refs，完整验收才用 Closes。父规格 issue 保持打开，全部业务及上线验收完成后再关闭。

PRs as a request surface: no.
