# Windows 运行时在服务形态 runner 上不可用（取证结论）

**日期：** 2026-09-13
**范围：** doc 16 §5 第 12 条①②③（CI 平台归属的后续动作：取首次完整运行时结果 / 记冷启动耗时 / 是否把 `windows-runtime` 提升为必过门禁）
**触发：** 用户 2026-09-13 选定三批，本记录是第 ① 批「立即取两条运行时证据」的产出
**结论：** **两条结果都取到了**——`linux-runtime` 首次完整结果是**绿**；`windows-runtime` 首次完整结果是**红**，且根因**不是被测代码**，而是 **self-hosted Windows runner 跑在服务形态（Session 0、无交互桌面）下，渲染窗口拿不到合成器帧 ⇒ 布局为零 ⇒ 所有 DOM 交互用例的定位器都判「element is not visible」**。**故在当前配置下 `windows-runtime` 无法提供运行时信号，不得提升为必过门禁。**

---

## 1. 结果一：`linux-runtime` 首次完整绿（正面基线）

[run 34742118058](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34742118058)（`db8cc56`，9m24s）：

- **35 files / 169 passed + 1 skipped，套件耗时 510.96s**；`[window-mode] silent` 生效（静默窗口模式在 xvfb 下成立）。
- 这是该 workflow 自建立以来的**第一条完整结果**：此前唯一一次（`34685789785`）红在后来定位并修复的 `/proc/<pid>/exe` OOM 缺陷上（`5261a82`），修后一直没再跑过。
- 顺带产出：`[orphan-apps] 检测到 **241** 个非本套件的 Electron 进程，未做处理` —— 这是 `electronCount` 误报（判据写成 `table.entries.length`）**规模最大的一份现场样本**，也是本批 ②-1 修复的直接依据（修复后该字段只数 Electron 进程）。

## 2. 结果二：`windows-runtime` 红，且根因是**执行环境**（本文的主要结论）

### 2.1 第一次运行：红，但**一个字的日志都没留下**

[run 34742115780](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34742115780)（`db8cc56`，27m36s，含冷启动下载）：集成步骤 `completed/failure`，而证据 artifact **只有 `windows-runtime-sha.txt`、最终 219 字节**——上传步骤自己打印的 `there will be 1 file uploaded` 是铁证。而"红在哪一条"恰恰是这个 job 一半的价值。

根因（本机在 Windows PowerShell 5.1 下复现）：原先的 `pnpm ... test:integration 2>&1 | Tee-Object -FilePath windows-runtime.log` 在**长命令**上不建文件——输出被缓冲到进程结束，结束时的输出走 native stderr 错误记录，`Tee-Object` 从未收到管道输入，也就从未创建文件（同一构造对"会立刻输出"的命令则正常建文件）。已由 `258d564` 修：改为 **cmd 自行重定向**（`cmd /c "pnpm ... > windows-runtime.log 2>&1"`，文件由 cmd 创建、必然存在），退出码经 `$LASTEXITCODE` 原样传出；上传步骤加 `if-no-files-found: error`，**证据缺失必须变红**。本机实测两条：正常输出落盘、`exit /b 7` 以 7 传出。

### 2.2 第二次运行：红，日志这次留下了 —— 失败形态高度一致

[run 34743861720](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34743861720)（`258d564`，29m16s；集成步骤 1534.41s）：

| 指标 | 值 |
|---|---|
| 文件 | **16 failed / 20 passed（36）** |
| 用例 | **43 failed / 124 passed / 5 skipped（172）** |
| 失败信号 | `element is not visible` **378 次**、`Timeout ... exceeded` **84 次**（Playwright 动作超时默认 30s，失败用例几乎都恰好 30.8s） |
| 典型注解 | `TimeoutError: locator.click: Timeout 30000ms exceeded. waiting for locator('.cy-conversation-main').first() - locator resolved to <button class="cy-conversation-main">…</button> - attempting click action - element is not visible`（**定位器解析到了元素，元素就在 DOM 里，但"不可见"**） |

**逐文件形态给出了决定性判据**：

- **需要与渲染 DOM 交互的文件：全红**——`electron-tools` **13/13 全失败**、`message-list-follow-bottom` 4/4、`persist-flush` 2/2、`reduce-motion` 2/2、`persistence-degraded` 2/2、`electron-live2d` 11/28、以及 `chat-drop-zone`／`context-menu`／`font-scale`／`markdown-table-scroll`／`message-actions`／`voice-silence-autostop`／`generation-stall-recovery` 各 1；
- **只走主进程 / IPC / `page.evaluate` 的文件：全绿**——`ipc-security` 18/18、`protocol-handler` 9（+2 skipped）、`persistence-lifecycle` 4/4、`trust-boundary` 2/2、`protocol-media-handler` 6/6、`ipc-voice` 2/2、`renderer-crash-banner` 1/1、`navigation` 2/2、`perf-gate` 5（+1 skipped）等。

即：**主进程与 IPC 在这个环境里完全正常，缺的只是"窗口被合成/布局"这件事**。`perf-gate` 能过也印证同一结论——它用 `querySelectorAll` 数 DOM 节点，**DOM 存在**；而**几何为零**（Playwright 判定不可见 = 空 bounding box）。

### 2.3 决定性对照：**同一台机器、同一份代码、静默窗口模式，交互式会话下基本全绿**

本机（Windows 交互式用户会话）跑同一套件（同样默认静默窗口）：**2 failed / 167 passed / 3 skipped**；两条红是 `electron-live2d`「恢复默认设置」与 `renderer-crash`（**恰好 60006ms = 60s 超时**，非断言失败），**单独重跑这两个文件 30/30 全绿**。当时 CI 的 `windows build-level` job 正在同一台机器上跑（我在 CI 占用本机时又起了一份全量套件——**实验设计错误，由我自己造成**），故定性为**机器争用导致的超时**。

**把三组数据并排就得到根因**：

| 环境 | 有无交互桌面 | 静默窗口模式 | 结果 |
|---|---|---|---|
| self-hosted runner（服务形态，`NT AUTHORITY\NETWORK SERVICE`，Session 0） | **无** | 开 | **43 用例红，全是 "not visible"** |
| 本机交互式用户会话 | 有 | 开 | **167/172 通过**（两条红是争用超时，单跑即绿） |
| Linux + xvfb | 有（虚拟显示） | 开 | 169/172 通过 |

⇒ **变量是"有没有可合成的显示会话"，不是静默窗口模式本身、也不是被测代码**。

## 3. 结论与选项（**决定权在用户**，本记录只给事实与代价）

1. **不得把 `windows-runtime` 提升为必过门禁**（第 12 条③的答案）：它现在不是"还没稳定"，而是**结构性地跑不出运行时信号**——在它转绿之前谈不上观察窗口。
2. **三种可选处置**（尚未选，本轮不做）：
   - **A. 把 Windows runner 改成交互式会话运行**（例如以登录用户身份常驻，而不是 Windows 服务）：这是唯一能让该 job 真正产出运行时信号的路子，代价是改动这台机器的运维形态（需要用户决定）。
   - **B. 明确定位为人工取证面**：保留 workflow，但把**每周定时触发去掉**（否则每周稳定产出一条红 run，噪声会训练人忽略它），只在需要时手动 dispatch。
   - **C. 维持现状**：每周一条红 run，作为"Windows 运行时仍未自动化"的提醒。代价同上：**长期红会稀释告警可信度**（这正是本批 ②-1 修 `electronCount` 误报的同一条理由）。
3. **Windows 运行时证据当前只能来自人工在本机会话里跑**——本轮已取得一条（167/172，见 §2.3），并且**这是本仓库第一次有 Windows 全量集成套件的完整结果**（此前 doc 16 反复记的"Windows 联调仍阻塞"从未落到"跑完一整套并给出数字"）。
4. **两条附带产出**：① `windows-runtime` 的证据捕获缺陷已修（`258d564`），否则下一次 run 同样留不下日志；② 本批新增的 `persistence-degraded` 用例在 Linux CI（`shard 3/3`，文件 symlink 形态）与 Windows 本机（junction 形态）**都跑通**，在服务形态 runner 上则如预期地红在"不可见"——**它没有引入新的平台假设**。

## 4. 未做与残余

- **未改 Windows runner 的运维形态**（选项 A）：那是对用户机器的改动，须由用户决定。
- **未去掉 `windows-runtime` 的定时触发**（选项 B）：同上，属决定而非实现。
- 冷启动耗时（第 12 条②）本轮只取到"第一次含下载的整 job 27m36s / 第二次 29m16s"两个**整 job** 数字；**未**把下载步骤耗时与套件耗时拆开记录（第二次的集成步骤本身是 1534.41s，可作套件耗时；下载步骤的耗时本轮未单独取）。
- ④（`message-list-follow-bottom`）在本批又现一次（`integration (shard 2/3)`，`median=449px`、`within < 15/25`），处置与证据见 doc 16 §3.1；**本轮仍未解释其缺陷量级数值**，也未放宽判据。
