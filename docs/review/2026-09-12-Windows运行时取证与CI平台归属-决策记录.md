# Windows 运行时本机取证与 CI 平台归属决策记录

**日期：** 2026-09-12
**范围：** CI 平台归属（`windows` job 改钉 self-hosted）、Windows 真实运行时套件取证、Windows 运行时观察 workflow 的引入
**性质：** 决策记录 + 本机取证（**不是** CI 验收记录；CI 侧证据尚未产生，见 §5）
**状态：** 本机取证完成；CI 变更已落地但**未推送、未在 CI 运行**

---

## 1. 触发问题

用户提问「这个项目是 Windows 的，怎么 CI 在 Linux 上」，并已在 GitHub 添加本机 Windows 11 self-hosted runner（`yomu-win11`）。据此复核了平台策略与实际覆盖，结论是：**目标平台是 Windows + Ubuntu 双目标**（`README.md:3`、`CLAUDE.md:7`），Linux CI 不是配置错误；但**主目标平台 Windows 的运行时行为此前零 CI 覆盖**，这是真实缺口。

缺口由仓库自身记录在案，本记录不重复主张新事实：

- `ci.yml` 的 `windows` job 是**构建级**门禁（C3：不启动 Electron），该取舍为用户拍板（`docs/archive/specs/2026-08-12-phase01-recheck-batchC-design.md:8`）；
- 集成套件标注为 Linux-only（`docs/archive/specs/2026-08-09-phase1-ipc-security-integration-design.md:47` C-8、`tests/integration/README.md:23`）；
- 评审 M-39 / P2-4（`docs/review/2026-09-11-full-frontend-review.md:392,717`）：「Windows 打包路径从未在 CI 验证……而**主目标平台恰恰是 Windows**」——P2-4 只补了**打包**（2026-09-12），运行时仍未补。

## 2. 本机取证（Windows 11 / i5-13600KF 14C20T / 交互式会话）

命令：`pnpm --filter @cyrene/desktop exec electron-vite build --mode test`（3.7s）+ `vitest run --config vitest.integration.config.mts`。

**口径（重要，避免把脏树结果当洁净复现）：** 本次运行发生在**含未提交改动的工作树**上——`HEAD = eecff20`，另有在途的「开发环境隔离」改动参与构建（新增 `src/main/config/dev-ports.ts`；修改 `electron.vite.config.ts`、`src/main/app/lifecycle.ts`、`src/main/index.ts`）。故本记录的数字属于**该工作树状态**，不是 `eecff20` 的洁净复现；其中 `dev-form-renderer.spec.ts`（dev 形态供给通道，正是被该改动触碰的面）在该状态下通过。CI 侧复现时以推送后的提交为准。

**结果：`27 files passed`，`154 passed | 2 skipped (156)`，exit 0，`Duration 350.73s`（tests 337.04s）。**

同一套件在 CI（ubuntu-latest 4 vCPU + xvfb + SwiftShader）为 `27 files`、`155 passed | 1 skipped`、`558.92s`。即**同一套件在本机快 1.6×**，其中 CPU 密集的 Live2D 文件快 2.2×：

| spec | 本机 Windows | CI Linux | 倍率 |
|---|---|---|---|
| `electron-live2d.spec.ts`（28 用例） | 124.7s | 278.8s | 2.24× |
| `electron-voice.spec.ts`（16） | 28.5s | 43.3s | 1.52× |
| `electron-tools.spec.ts`（13） | 21.8s | 31.2s | 1.43× |
| `settings-model-services.spec.ts`（11） | 12.5s | 17.5s | 1.40× |
| `dev-form-renderer.spec.ts`（6） | 11.3s | 16.7s | 1.48× |
| `generation-stall-recovery.spec.ts`（1） | 51.4s | 52.1s | 1.01×（等固定超时，与算力无关） |
| 其余 21 文件合计 | ~102s | ~159s | — |

### 2.1 平台分支差异（这是本记录的核心证据）

套件用「按可用性分支断言并记录实际走的分支」的写法，因此两边都能绿，但**走的是不同分支**：

| 用例 | 本机 Windows | CI Linux |
|---|---|---|
| `ipc-security` 凭据往返（M-32） | `凭据分支 = empty`：**safeStorage 可用 → 真实 OS 加密往返已执行** | `= unavailable`：safeStorage 不可用 → **仅验证降级（OS 加密往返未执行）** |
| `audit-lifecycle` 凭据审计 | `credentialStatus=empty setOk=true clearOk=true` | `credentialStatus=unavailable **setOk=false** clearOk=true` |

⇒ CI 至今**从未执行过**「凭据真正写入 + DPAPI 加密往返」这条产品主路径；Windows 上一次即覆盖。这是本次取证最有价值的发现，也是「Linux 不能替代 Windows」的实证。

### 2.2 平台性覆盖损失（**不得读作通过**）

| 项 | 说明 |
|---|---|
| `protocol-handler.spec.ts` **9 tests \| 2 skipped** | 两条「symlink 逃逸 → 403 / 目录内 index.html symlink 逃逸 → 403」由 `canCreateSymlink()` 运行时探测决定是否 skip。本机以非提权身份实测创建 symlink 失败（`Administrator privilege required`），故**静默跳过**。CI Linux 同文件为 9 tests / 0 skipped。 |
| 结论 | **Linux integration job 必须保留，不得用 Windows 运行时 job 替换**，否则两条真实安全边界失去覆盖。 |

### 2.3 两处已知差异（如实记录，避免误读本机数字）

- `perf-gate.spec.ts` ④（Live2D 折叠后 rAF 停）在本机**运行了**（5 tests / 0 skipped），CI 为 5 tests / **1 skipped**（`LIVE2D_MODELS_EXIST=false`）。本机之所以为 true，是因为开发机 `%APPDATA%\Cyrene\models` 已装模型——**新建的 runner 服务账号 profile 没有这份状态**，故该用例在 self-hosted runner 上预期仍会 skip（与 CI 一致）。本机 154 passed 的数字含这份开发机状态的贡献。
- 本机取证跑在**交互式会话（Session 1，有桌面）**，而 runner 是服务形态（**Session 0，无桌面无 GPU**，见 §3）。故本次取证**不能证明 Session 0 可跑**，那只能由 runner 自己实测；这是 §5 的待办。

## 3. self-hosted runner 实测事实（本机查证）

| 项 | 值 | 影响 |
|---|---|---|
| 服务名 / 账号 | `actions.runner.yukikaze-1-elysia-frontend.yomu-win11` / **NT AUTHORITY\NETWORK SERVICE** | 服务账号有**自己的 profile**（`C:\Windows\ServiceProfiles\NetworkService`），**看不到** `C:\Users\<user>` 下的 electron dist / pnpm store / ms-playwright |
| 进程会话 | `Runner.Listener` **SessionId=0**（用户桌面为 Session 1） | 无桌面、无 GPU；无头渲染是既定形态，不是配置错误 |
| 安装目录 | `G:\actions-runner`（`_work` 在此外，G: 余 286.7GB） | `actions/checkout` 默认 `clean: true`（`git clean -ffdx`）**不会**波及开发检出的未跟踪文件 |
| 缓存现状 | 服务账号 profile 下 electron/pnpm/ms-playwright/tool_cache **均不存在**（首次运行前） | **首次运行是冷启动**：Electron 二进制（约 119.5MB）等需现场下载；此后该 profile 跨 run 持久，自动转暖 |
| 标签 | `self-hosted, Windows, X64, **fe-win**`（原为 `elysia-frontend`，2026-09-12 按 OS 改名） | `windows-latest` 与 self-hosted 标签**不匹配**——不显式改 `runs-on` 则一条 job 也不会落到它上面 |

**推论（修正先前口述的收益预期）：** 「本机已有 electron/Playwright 缓存，搬过来就省下载」**对本 runner 不成立**（服务账号 profile 冷）。真正的收益是**计费归零**（私有仓库托管 Windows 按 2× 计费）与**并发档位从 4 vCPU 提到 14 核**。另：**不要**给 self-hosted job 加 `actions/cache` 的 Electron 缓存——本地 profile 已跨 run 持久，走缓存服务反而每个 run 多传约 120MB。

## 4. 本轮落地（未推送）

1. **`ci.yml` 的 `windows` job 改钉 `runs-on: [self-hosted, Windows, X64]` + `timeout-minutes: 45`**（self-hosted 掉线会无限排队）。该 job 全程不启动 Electron GUI，Session 0 形态不影响它；同时保留托管 runner 上的 integration/artifact 两个 Electron 缓存步骤不变。
2. **新增 `.github/workflows/windows-runtime.yml`**（Windows 真实运行时，取证面）：
   - 触发：`workflow_dispatch` + 每周定时；独立文件而非塞进 `ci.yml`——本仓只有**一台** runner 实例，job 会串行排队，塞进主 workflow 会把构建级门禁拖到运行时验证后面；
   - **不设作业级 `continue-on-error`**：那会让失败的 job 不改变 workflow 结论，正是仓库明令禁止的「把未核对伪装成通过」。它该红就红，只是暂不挂 main 的必过检查；
   - 阶梯里 `exit $LASTEXITCODE` 不可省：PowerShell 管道退出码取自最后一条命令（`Tee-Object` 恒为 0），少了它会把失败伪装成通过；
   - Playwright 浏览器走服务账号 profile 的默认路径（`%LOCALAPPDATA%\ms-playwright`，跨 run 持久）。**不是** `PLAYWRIGHT_BROWSERS_PATH=${{ runner.tool_cache }}/...`——该表达式写在 job 级 `env` 会让整份 workflow 被判 invalid，见 §7.2。
3. **新增 `.github/workflows/linux-runtime.yml`**（Linux 真实运行时，取证面）：跑在 2026-09-12 新登记的 Ubuntu self-hosted runner（`yomu-X99`，标签 `fe-linux`）上。用途是取一条**同 OS 家族**的真实基线（为后续 integration 分片定标），并给「integration 搬上多实例」提供实测依据。**不替换**托管 integration job——Linux 是两条 symlink 逃逸断言的唯一覆盖点。与托管 job 的差异均为 self-hosted 硬约束，已写在文件头：不带 `playwright install --with-deps`（apt 需 root，系统库须在 runner 上手工装一次）、不挂 `cache: pnpm`（服务用户 home 下的 store 跨 run 持久，走 Actions 缓存反而每 run 多传约 63MB）。
4. **`ci.yml` 加 `concurrency`（同 ref 只保留最新一次运行，`cancel-in-progress: true`）**：依据是 34 天 143 次 run、**近 3 天 24 次/天**，其中大量为同一批改动的反复推送；这是当前「省计费分钟最多且零风险」的一条。**代价已写进 workflow 注释**：同一分支连续推送时中间提交不留完整 CI 记录，需要逐提交证据时须临时关闭。
5. **标签按 OS 区分（2026-09-12，预防性收口）**：`yomu-win11` → `fe-win`、`yomu-X99` → `fe-linux`。此前两台共用裸仓库名标签 `elysia-frontend`，一旦有人写 `runs-on: elysia-frontend`（很自然的写法）会**同时匹配两台**，把 job 派到错误平台。当前所有 pin 都用 OS 限定标签（`[self-hosted, Windows, X64]` / `[self-hosted, Linux, X64]`），故今日不构成事故。

## 5. 未取证项（**NOT VERIFIED，不得读作通过**）

| 项 | 状态 | 解除条件 |
|---|---|---|
| Session 0（无桌面）下全量集成能否跑 | **未取证**——首个 job 未跑到测试步骤（死在 checkout，见 §7.1） | 修好代理后 dispatch `windows-runtime` |
| 两个 workflow 的 YAML 在 GitHub 侧是否被接受 | **已取证**：`linux-runtime` 被接受；`windows-runtime` **被拒**（invalid workflow file）→ 已修，待推送复核 | 推送后确认不再出现「run 名=文件路径」的失败 run |
| self-hosted `windows` job 的实际耗时与冷启动代价 | **未取证**——首次 run 死在 `actions/checkout`（网络代理，见 §7.1），未能反映耗时 | 修好代理后 `gh run rerun --failed` |
| Windows 运行时能否转必过门禁 | **未取证** | 观察窗口内持续绿 + 已定性地处置 symlink 覆盖缺口 |
| 集成套件分片（Linux 侧墙钟优化） | **未做** | 独立批次；见 §6 |

## 6. 相关但未纳入本轮的结论（来自同轮 CI 时长分析）

同轮分析还定位到三处与平台归属无关的 CI 时长事实，记录在此以免丢失，**均未实施**：

1. **integration job 是墙钟唯一瓶颈**（10.4 分钟中的 10.4 分钟；27 文件严格串行，103 次 Electron 冷启动）。
2. **`unit` 与 `windows` 两个 job 每次都在重新下载 Electron 二进制**：`tests/unit/tool-service.spec.ts` 经 `src/main/tools/tool-executors.ts:5` 的 `import { dialog } from 'electron'` 触发懒下载（`electron@43.3.0` 无 postinstall），而这两个 job 没有 `~/.cache/electron` 缓存（评审 M-40/P2-4 早已记「应一并加」，未落地）；Windows 侧日志显示下载后约 96 秒空档。
3. `tests/integration/helpers/orphan-apps.ts:239` 的 `electronCount` 取自**全部 `/proc` 条目**而非 Electron 进程，故 Linux CI 每轮打印「检测到 N 个非本套件的 Electron 进程」（实测 43）是**误报**；Windows 侧因 CIM 查询按进程名过滤而正确。无行为影响，但会稀释真实孤儿场景的可信度。

## 7. 首次推送后的实测（run `34684926682` @ `0f3b1c3`）

5 个 job 的实际结果：`check` / `unit` / `artifact` 绿；**`windows` 红**、**`integration` 红**。两条红根因各自独立，均已定位。

### 7.1 `windows` job：self-hosted runner 没有代理，`actions/checkout` 连不上 github.com

- 症状：首个 self-hosted job 死在 `actions/checkout@v4`，job 内其余步骤全部 skipped。
- 证据（runner 本机 `G:\actions-runner\_diag\Worker_20260912-090528-utc.log`）：
  `unable to access 'https://github.com/yukikaze-1/elysia-frontend/': Recv failure: Connection was reset`、
  `Failed to connect to github.com port 443 after 21132 ms`。
- 根因是**网络路径差异，不是 runner 配置错误**：实测本机直连 `https://github.com` 20 秒超时（只传了约 314KB 即卡死），经 `http://127.0.0.1:7897`（`verge-mihomo`）返回 200。开发者会话能正常 push，是因为 `C:\Users\yomu\.gitconfig` 与 `%USERPROFILE%\.npmrc` 都设了该代理；runner 服务跑在 `NT AUTHORITY\NETWORK SERVICE` 下**看不到这两份配置**，系统代理又是 `Direct access`。runner 自身能收到 job，是因为它连的是 `pipelines.actions.githubusercontent.com` 一类端点、恰好可达 —— 所以现象是「能收到 job，却死在 checkout」。
- 修法：写 `G:\actions-runner\.env`（runner 的环境注入点，**仅在启动时读取，故需以管理员重启服务**）：`http(s)_proxy` 与 `HTTP(S)_PROXY` = `http://127.0.0.1:7897`；`no_proxy`/`NO_PROXY` = `localhost,127.0.0.1`（**集成套件会起本地 HTTP 服务——Vite dev server 5373、`serveRenderer` 静态服务等——绝不能被送进代理**）。
  另加 `ELECTRON_GET_USE_PROXY=true`：Electron 二进制（约 120MB，来自 github.com releases）走**另一套**代理机制——`@electron/get` v5 只在 `ELECTRON_GET_USE_PROXY` 存在时才启用 undici 的 `EnvHttpProxyAgent`，而它读**大写** `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（依据：`node_modules/@electron/get/dist/index.js:17` 与 `dist/proxy.js` 文档注释）。
- **长期运维前置**：本机 Clash Verge（`verge-mihomo`，7897）必须在运行，否则 self-hosted job 会停在 checkout。这是自建 runner 的固有代价（托管 runner 无此问题）。

### 7.2 `windows-runtime.yml`：整份 workflow 被判 invalid

- 症状：push 时它自动产生一次失败 run，**run 名显示为 `.github/workflows/windows-runtime.yml` 而非 workflow 的 `name:`** —— 这是 GitHub 解析失败的标志。
- 根因：`PLAYWRIGHT_BROWSERS_PATH: ${{ runner.tool_cache }}/ms-playwright` 被我写在 `jobs.<id>.env`。**`runner` 上下文在 job 级 `env` 不可用**（可用性表：job 级 `env` 仅 github/inputs/matrix/needs/secrets/strategy/vars；`runner` 要到 step 级才可用）。
- 用工具而非记忆确认：`actionlint` v1.7.12 对该写法报 `context "runner" is not allowed here. available contexts are ...`（最小复现 `tmp/repro-invalid-context.yml`；同一表达式放 step 级 `env` 则 exit 0）。三个 workflow 现在 actionlint 全绿。
- **教训（建议进 CI）**：本地 `js-yaml` 通过**只证明「是合法 YAML」**，不证明「是合法 workflow」——这次两条红线都是从「YAML 绿」下面漏过去的。建议后续把 actionlint 加进 `check` job（本次未做）。
- 修法：去掉该表达式，改依赖服务账号 profile 的默认路径（跨 run 持久，无需 `actions/cache`）。

### 7.3 `integration` job：`electron-live2d.spec.ts` B6 单例失败（疑似环境性 flake，待重跑判别）

- 结果：`1 failed | 155 passed | 1 skipped (157)`，`Duration 548.58s`；失败点 `electron-live2d.spec.ts:794:88`，`AssertionError: expected 0 to be greater than 0`。
- 位置判读：794 行是 B6 里**切模型之前**的第一个像素断言（默认 haru 画布）。`countNonTransparentPx` 的 `-1` 是「采样失败」、`0` 是「画布真空白」，报 `0` ⇒ 画布存在但没画出来。B6 与 test 2 / C2.x 不同，**不对「静态回退」分支做处理**，故该次启动若 WebGL 失败即必红。
- **倾向 flake 而非回归**的四条依据：① 隔壁批次只改「模型装配到哪个目录」并要求显式 `--user-data default`，而 CI 里 **test 1（`list-models` 含 haru 且 `available: true`）通过** ⇒ 模型在 app 会读的位置；② 同批其它同类像素断言（B3 / F-1 / B7）在同一 run 中通过 ⇒ 渲染在别的实例里正常；③ 同一用例在前一次 run（`34680938308`，07:31）与开发者本机（其提交信息记「集成 27 文件 153 通过 + 2 skipped」）均通过；④ 仓库既有记录把这类现象定性为 xvfb/SwiftShader 环境性 flake（V-08/V-12：「先复现并采集证据，不能直接归因业务代码」）。
- **判别动作**：`gh run rerun 34684926682 --failed`（与 7.1 的代理验证共用同一次重跑）。重跑绿 ⇒ 记为环境性 flake；再红于同一点 ⇒ 转确定性缺陷，须按「B6 缺回退分支」单独处理。

## 8. 自建 Linux runner（`yomu-X99`）首次可用：一个仓库级 OOM 缺陷的定位与修复

### 8.1 现象：自建 runner 上必然 OOM，托管 runner 完全正常

首次 dispatch `linux-runtime`（run `34685789785`，job 仅 1m39s）在 `Integration tests (xvfb)` 步骤以 **exit 134（SIGABRT）** 结束：

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
[459875] 19355 ms: Mark-Compact (reduce) 4237.3 (4271.9) -> 4237.3 (4239.4) MB   ← 释放不掉 ⇒ 存活对象打满堆
```

`Mark-Compact` 一个字节都没释放 + 栈顶是 `v8::String::NewFromUtf8` ⇒ 是**存活的大字符串**，不是垃圾堆积。且崩溃发生在**任何用例跑完之前**（收集阶段）。

### 8.2 定位过程（每步都在服务器上实测，非推断）

| 步骤 | 做法 | 结果 |
|---|---|---|
| 排除 spec 相关 | 分别只跑 `markdown-xss`（2 用例）与 `electron-live2d` | **两者都 OOM** ⇒ 与 spec 无关 |
| 排除并发度 | `--maxWorkers=1`、`taskset -c 0-3`（模拟 4 核托管机） | **都 OOM** ⇒ 与 CPU 数/并发度无关 |
| 排除「需要更大堆」 | `NODE_OPTIONS=--max-old-space-size=8192` | 堆涨到 **9058MB 仍 OOM** ⇒ **无界增长**，不是容量不足 |
| 二分配置 | 最小 vitest 配置（无 alias/无 globalSetup/单文件） | 正常（158MB） |
| 二分配置 | 仓库 alias+超时，**去掉 `globalSetup`** | 正常（158MB，用例真跑了） |
| 二分配置 | 加回 `globalSetup`（仓库原文件） | **OOM**（4651MB） |
| 换空 `globalSetup` | 指向一个 `console.log` 的空文件 | 正常 ⇒ 不是 vitest 的 globalSetup 机制 |
| 单独跑嫌疑函数 | `readProcessTable()` + `scanOrphanTestApps()`（脱离 vitest） | **同样 OOM** ⇒ 锁定在 `helpers/orphan-apps.ts` |
| 读源码 | `orphan-apps.ts:159`：`readFileSync(join('/proc', name, 'exe'), 'utf8')` | **根因** |

### 8.3 根因：`/proc/<pid>/exe` 是符号链接，`readFileSync` 读的是**被链接文件的内容**

`/proc/<pid>/exe` 指向可执行文件本体；`readFileSync` 会跟着链接把**整个二进制**当 UTF-8 读进来（该行紧接着还有 `split('\0')` 展开）。本机实测规模：

```
/opt/google/chrome/chrome   281,881,848 字节（269MB） × 每个 Chrome 进程
全机各进程 exe 体量合计     8.7 GB
```

服务器上跑着多个 Google Chrome（本项目之外的用途），于是「读一个 exe = 读 269MB 二进制」× 多个进程，字符串瞬间吃满 4GB，再 `split('\0')` 展开成上千万片段 → 无界增长。

**为什么此前从未暴露**：它只在「Linux + 存在大体积可执行文件进程」时发作。托管 runner 上只有 `node`/`git`/`xvfb` 这类小二进制；Windows 宿主走的是 CIM/PowerShell 查询路径（`Win32_Process`），根本不读 `/proc`。**换句话说：这个缺陷恰好只在自建 runner 与"开着 Chrome/Electron 的 Linux 开发者桌面"上生效** —— 而这两者正是本仓库集成套件的目标运行环境。

### 8.4 修复与判别力验证

- 修法：`readFileSync(...)` → **`readlinkSync(...)`**（读链接目标路径，即本就想要的"可执行文件路径"）；已删除的可执行文件其 readlink 结果为 `<path> (deleted)`，不匹配 electron 签名——与修复前行为一致。`cmdline`/`stat` 两行保持不变（它们是普通 proc 文件，不是符号链接）。
- 回归用例：`tests/unit/orphan-apps.spec.ts` 新增（Linux-only，Windows 上 skip）——断言当前进程的 `executable` 与 `readlinkSync('/proc/<pid>/exe')` **逐字一致**、长度 < PATH_MAX、不含 NUL。
- **判别力实测**（在跑着 Chrome 的那台机器上）：修复后 21 tests 全绿；把该行**回退**成 `readFileSync(..., 'utf8')` 后，该用例**直接以 `FATAL ERROR: Reached heap limit` 收场**（连断言都执行不到）⇒ 缺陷不会静默通过。
- 修复后同机实测：进程表扫描 `executable` 字段最长 **116 字符**（路径）、峰值 **73MB**、exit 0；全量集成 **27 files 全过**。

### 8.5 自建 Linux runner 的基线（修复后实测，2026-09-12）

同一套件三处对照（测试耗时口径）：

| spec | 托管 ubuntu-latest（4 vCPU） | **`yomu-X99`（E5-2690v3，24 线程）** | 本机 i5-13600KF（Windows） |
|---|---|---|---|
| `electron-live2d`（28） | 278.8s | **182.3s** | 124.7s |
| `electron-generation-stall`（1） | 52.1s | 52.7s | 51.4s |
| `electron-voice`（16） | 43.3s | **51.8s** | 28.5s |
| `electron-tools`（13） | 31.2s | **38.3s** | 21.8s |
| `perf-gate`（5） | 18.5s | **26.2s** | 18.2s |
| `settings-model-services`（11） | 17.5s | **21.7s** | 12.5s |
| **全量 Duration** | 558.9s | **509.7s** | 350.7s |

**结论（决定了下一步该做什么）**：单实例在这台服务器上只比托管快 **9%**——Live2D 那类吃多线程软渲染的文件更快（182 vs 279），但其余文件因 **单核性能弱于现代托管机**而更慢（voice 51.8 vs 43.3、tools 38.3 vs 31.2）。**单实例搬家买不到墙钟**；真正的收益来自「按文件特性分片 + 把最吃多线程的那个文件放到这台机器上」——该方案已于同轮落地，见 §9.3（本机峰值 RSS 仅 823MB、残留 electron 进程 0，资源余量充足）。

### 8.6 运维现状（**未持久化，需人工补一步**）

- 该 runner 目前是**用 `nohup ./run.sh` 拉起的前台实例**（pid 440458），**没有 systemd 单元**——因为服务器上 **sudo 需要密码**，我无法执行 `svc.sh install`。重启机器后会掉。
- 要转成常驻服务（需用户本人 `sudo`）：
  ```bash
  # 先停掉我起的临时实例，避免同一注册上出现两个 listener
  pkill -f 'actions-runner-fe/bin/Runner.Listener'
  cd ~/actions-runner-fe && sudo ./svc.sh install yomu && sudo ./svc.sh start
  ```
- 与 Windows 侧相反的运维事实：**这台服务器直连 github.com 返回 200**（无需代理），`~/.cache/electron`（120M）、`~/.cache/ms-playwright`（967M，含 `chromium-1234`）、pnpm store（4.1G）均已就位，16 个 Electron/Chromium 系统库齐全，`xvfb-run` 已装 —— 故 `linux-runtime.yml` 里不带 `--with-deps` 的写法成立。

## 9. 第二次推送（run `34687156254` @ `5261a82`）：又两条红，一条是自建机的 shell 坑，一条是环境性 flake

代理修好、服务重启后重推，5 个 job：`check` ✓、`unit` ✓、`artifact` ✓、**`windows` 红**、**`integration` 红**。

### 9.1 `windows` job：自建机没装 PowerShell 7，`&&` 在 5.1 下是语法错误

- 现象：job 在**第一步**就红，报 `The token '&&' is not a valid statement separator in this version.`；日志里的 shell 是 `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.EXE`。
- 根因：原 step 是 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`。托管 `windows-latest` **预装 PowerShell 7**，`&&` 可用；本机**没有** pwsh 7（实测 `C:\Program Files\PowerShell\7\pwsh.exe` 不存在），GitHub 回退到 **Windows PowerShell 5.1**，而 5.1 **不支持 `&&`**。
- **与 §7.1 的 git/代理问题无关**：那轮红在 `actions/checkout`（网络，已修）；这轮 checkout 已过（它自己完成了「无法 clean/reset → 重建仓库」的兜底），红在 `&&`。
- 修法：拆成**四个独立 step**（`Typecheck` / `Lint` / `Unit tests` / `Build`）——不依赖任何 pwsh 特性、天然 fail-fast、失败定位更准。
- 顺带修 `windows-runtime.yml`：去掉 `shell: pwsh`（本机没有 pwsh，写了反而更脆），并把 `exit $LASTEXITCODE` 改成 5.1 可解析的 `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`——否则 PowerShell 管道的退出码取自 `Tee-Object`（恒 0），失败会被伪装成通过。

### 9.2 `integration` job：连续两轮红，但**红的不是同一个用例** ⇒ 环境性 flake（非回归）

| 轮次 | 失败用例 | 失败形态 |
|---|---|---|
| `0f3b1c3` | `electron-live2d.spec.ts` B6.布局 | `expected 0 to be greater than 0`（画布 6s 内无非透明像素） |
| `5261a82` | `persist-flush.spec.ts` 关窗前 flush【判别用例】 | `locator.click: Timeout 30000ms`，等的是 `getByRole('button', { name: /REAL\|MOCK/ })`——**渲染进程没在预算内起来** |

- 两轮都是 `1 failed | 155 passed | 1 skipped`，失败点不同、同属「渲染/启动没赶上预算」这一族；且**第二轮里 B6 本身通过**（同一用例前一红后绿 ⇒ 非确定性）。
- 与隔壁 dev-env 批次无关的三条依据：① 该批次只改「模型装配目录 / userData 风味」，而 `list-models` 与 live2d 其余 27 个用例都过；② `persist-flush` 的失败发生在**点连接按钮**之前，与 flush 语义无关；③ 仓库既有记录把这类现象定性为 xvfb/SwiftShader 环境性 flake（V-08/V-12：「先复现并采集证据，不能直接归因业务代码」），并有放宽 `SLOW_POLL` 的先例。
- **待办（未实施）**：连续两轮各 1 例，flake 率偏高。建议按仓库既有做法处置——把这类「首次交互/首帧」预算从默认 POLL（8s）提到 `SLOW_POLL`（15s），或给 CI 加一次自动重试。**本轮不动测试预算**：改预算会削弱判别力，属独立批次且须单独论证。

### 9.3 集成套件分片（本轮实施）

原状：单个 `integration` job 串行跑 27 个文件 = 10.4 分钟，**就是整条 CI 的墙钟**。

分片**不是均匀切，而是按文件特性切**（依据 §8.5 的三处实测）：

| 归属 | 内容 | 实测定标 |
|---|---|---|
| `integration-live2d`（**self-hosted Linux**） | 只跑 `electron-live2d.spec.ts` | 182.3s + 装载 ≈ **247s** |
| `integration`（托管，**3 分片**） | 其余 26 个文件，`--shard=N/3` | 最慢片 158s + 装载 ≈ **223s** |

- 机制提醒（决定了 live2d 为何必须独占）：vitest 的 `--shard=N/M` 只按「路径 SHA-1 排序 + **文件数**」均分，**不看耗时**。重文件混进随机分片必然把该片变成新瓶颈。
- 分片数为什么取 3（本地复刻 vitest 的 `BaseSequencer.shard()` 算出逐片耗时；排序键是 root 之后的路径，**与机器无关**）：

| 分片数 | 各片测试耗时 | 最慢片墙钟 | CI 墙钟 |
|---|---|---|---|
| 1 | 290s | 355s | 5.9 分钟 |
| 2 | 213 / 78s | 278s | 4.6 分钟 |
| **3** | **158 / 106 / 26s** | **223s** | **4.1 分钟** |
| 4–5 | ≤181s | ≤181s | 4.1 分钟（无收益：被 live2d job 卡住） |

- 墙钟 = max(247, 223) ≈ **4.1 分钟**（原 10.4）。**再往下压必须拆 `electron-live2d.spec.ts`**（它独占一个 job 的 182s 就是当前地板；拆成 2–3 个文件可到约 3.3–2.8 分钟），属独立批次。
- 实现细节：排除 live2d 用 CLI `--exclude` 而**不新增 vitest 配置**（免两处配置漂移；且「排除哪些文件」属分片关注点）。注意 CLI `--exclude` 会**替换** vitest 默认 exclude 列表——本套件 `include` 仅 `tests/integration/**/*.spec.ts`，默认列表中唯一可能相关的 `node_modules` 不可能命中，替换安全。
- 分片正确性：以复刻算法验证「并集 26 / 交集 0 / 每片 13 个文件」；`--exclude` 亦实测（带它 26 个文件、不带 27 个）。**最终确认以首次分片 CI run 的日志为准**——vitest 的 `list` 子命令不套用 `--shard`，无法用它验证运行期划分（本轮踩过这个坑）。
- 计费影响：托管 job 从 1 个（10.4 分钟）变为 3 个（合计约 11 分钟）——**墙钟减半、计费基本持平**；live2d 那部分因落到自建机而免费。
- **已知代价（如实记录）**：`integration-live2d` 依赖自建 runner 在线，服务器掉线时它最坏排队到 `timeout-minutes: 45`。要临时回退，把该 job 的 `runs-on` 改回 `ubuntu-latest` 即可（墙钟回到约 5.7 分钟）。

## 10. 第三次推送（run `34688140376` @ `d8e1a2a`）：**GitHub Actions 额度耗尽 → 全部 job 迁到自建**

### 10.1 现象：6 个托管 job「未能启动」，自建的 2 个正常

那次推送的 8 个 job 里：`integration (live2d, self-hosted)` ✓ 3m37s、`windows build-level` ✓ 2m37s，其余 6 个
（`check` / `unit` / `artifact` / 三个分片）**0～3 秒即失败**，注解原文：

```
The job was not started because recent account payments have failed or
your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings
```

即**账号额度/账单被卡**，托管 runner 上的 job 根本不会被分发（自建 runner 不受影响）。用量侧的佐证：run 历史里
**2026-09-12 当天 40 次 run**、09-11 26 次、09-10 11 次 —— 按迁移前的 ~28.6 计费分钟/run，单日即上千分钟。
（账单明细 API 需 `user` scope，本轮取不到；具体数字以 `Settings → Billing and plans` 为准。）

**这一条把「自建」从优化变成了唯一可行路径**，也顺带证实了 §9 那轮的成本判断。

### 10.2 决定与做法：Linux 侧全部迁到 X99（三个 runner 实例）

- **实例数**：一个 runner 实例同时只能跑一个 job，而 Linux 侧现在有 7 个 job（check / unit / artifact /
  3 个分片 / live2d）。单实例会串行成 20 分钟以上——**比迁移前更慢**。故在 X99 上起**三个实例**
  （`yomu-X99` / `-2` / `-3`，同一标签 `fe-linux`，job 自动分配到空闲实例）。
  新建实例用的是「复制已有 runner 目录 → 删 `.runner`/`.credentials` → 重新 config」的省流量做法，
  没有重复下载 200MB 包。
- **三个机械改动**（每个都有理由，不是顺手改）：① 去掉 `cache: pnpm`（服务用户 home 下的 store 跨 run 持久，
  走 Actions 缓存反而每 run 多传约 63MB）；② 去掉 electron 的 `actions/cache`（同理，`~/.cache/electron` 已持久）；
  ③ `playwright install` 去掉 `--with-deps`（apt 需 root；16 个系统库与 `xvfb-run` 已在服务器上装好并核对过）。
  每个 self-hosted job 都补了 `timeout-minutes`（掉线时 job 会一直排队）。
- **回退路径**：账单恢复后把各 job 的 `runs-on` 改回 `ubuntu-latest` 并恢复上面三处即可，差异都集中在这些行
  （文件头有说明）。

### 10.3 已知风险（**未解决，如实记录**）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **单机依赖** | 全部 Linux job 依赖 X99 在线；机器重启/掉线则 Linux 侧 CI 停摆 | 用户声明 24 小时开机；job 有 `timeout-minutes` 兜底；回退路径一行可切 |
| **并发争抢** | 3 个实例 = 最多 3 个 Electron+SwiftShader 任务同时跑在 24 线程上（单任务实测负载约 8） | 若 flake 率上升，减到 2 个实例即可（`git rm` 一个实例的注册即可）——这需要观察数据，不能凭猜 |
| **实例未持久化** | 三个实例目前都是 `nohup ./run.sh` 起来的，**机器重启即失效**（服务器 sudo 需要密码，我无法执行 `svc.sh install`） | 见 §8.6：需要用户 `sudo ./svc.sh install yomu && sudo ./svc.sh start`，三个实例各一次 |
| **首次冷启动** | 两个新实例的 profile 是空的，首次 job 会有 Electron 二进制等冷下载 | 一次性代价，之后跨 run 持久 |

### 10.4 迁移后的墙钟预期（含各 job 在 X99 上的定标）

| job | X99 估算/实测 |
|---|---|
| `check`（typecheck+lint+docs+sensitive+contract） | ~2.5 分钟（估） |
| `unit`（2927 用例） | ~1.5–2 分钟（估，无 70s 冷下载后比托管快） |
| `integration` 三分片 | 158 / 106 / 26s + 装载 ≈ 3.4 / 2.5 / 1.2 分钟 |
| `integration-live2d` | **实测 3m37s** |
| `artifact` | ~1.8 分钟（估） |
| `windows`（Windows 本机） | **实测 2m37s** |

7 个 job 总工作量约 17 job-分钟，3 实例下理论下限 ≈ 6 分钟；实际墙钟取决于调度（矩阵 job 同时入队，
谁先拿到实例不由我控制）。**这些数字是估算，不是实测结论**——首次全自建 run 的实测值以下一轮记录为准。

### 10.5 首次全自建 run（`34691783602` @ `6e6265d`）：8/8 绿，但 **951s** —— 分片参数根本没传到 vitest

- 结果：**8 个 job 全部 success**（本项目第一次在不依赖托管 runner 的情况下拿到全绿），但**墙钟 951s
  （15.9 分钟）**，比托管的 10.4 分钟**更慢**。
- 根因（实测）：三个 `integration (shard N/3)` 的日志里都是 **`Test Files 27 passed (27)`**、
  Duration 507～557s —— 分片参数没生效，**每一片都把整套 27 个文件跑了一遍**。
- 机制：`pnpm --filter @cyrene/desktop test:integration -- --exclude … --shard=3/3` 里的 `--` 参数
  **不会**被追加到脚本内最后那条 `vitest` 上（`test:integration` 是 `ensure && build && vitest run …`
  的复合命令）。对照实验：`pnpm exec vitest run --config … --shard=1/3` 直连则正确切分
  （unit 套件 239 文件 → 80 / 80 / 79）。
- 修法：`electron-vite build` 拆为独立 step，测试步骤改为 `exec vitest run` 直传
  `--config` / `--exclude` / `--shard`。
- **live2d 那个 job 不受影响**（过滤条件写在脚本内部）：实测 `Test Files 1 passed (1)`、
  Duration **211.56s** ✓。
- **教训（与 §7.2 的 invalid workflow 同类）**：「参数是否真的到位」不能用「YAML 能解析 / 命令能跑通」
  来证明——判据必须是**运行日志里的 `Test Files N passed` 等于预期的片内文件数**。本轮三片各自跑满
  27 个文件却**全程绿灯**，正是「绿，但没在测该测的东西」的又一例；仓库此前为 `check:contract` 吃过
  同样的亏。
- 该轮各 job 实测耗时（含上述错误）：`check` 2m57s／`unit` 1m23s／`artifact` 1m1s／`live2d` 4m46s／
  三片 10m12s·9m56s·9m21s／`windows` 3m3s。**修复后的预期**：三片约 3.4 / 2.4 / 1.2 分钟，墙钟由调度
  决定（估 6～7 分钟）——**以下一轮实测为准，不作为结论**。

### 10.6 分片修好后的第二轮（`34692644842` @ `e89d08a`）：**墙钟降到 346s**，但两条红暴露了三实例方案的两处代价

墙钟 **346s（5.8 分钟）**（上一轮 951s、托管基线 10.4 分钟），8 个 job 里 6 绿 2 红，两条红根因不同：

**① `integration (shard 1/3)`：三个实例共用同一个 pnpm store，并发 install 把它弄坏**

```
[Error: ENOTEMPTY: directory not empty, rmdir '/home/yomu/setup-pnpm/node_modules/.bin/store/v11/files/74']
```

- 机制：三个实例跑在同一个用户下、`pnpm/action-setup` 给每个 job 设的是**同一个 `PNPM_HOME`**，而 pnpm 11
  的默认 store 是 `$PNPM_HOME/store/v11` —— 于是三个 job 的 `pnpm install` 同时写同一个 store。实测复现了这一点。
- 修法：`pnpm install --store-dir "$HOME/.pnpm-store-${{ runner.name }}"`（按实例分开）。**环境变量改不动它**：
  `npm_config_store_dir` / `NPM_CONFIG_STORE_DIR` / `PNPM_STORE_DIR` / `XDG_DATA_HOME` 实测**全部被忽略**，
  PNPM_HOME 优先；只有 CLI `--store-dir` 有效。三个新 store 已从旧 store **硬链接预热**（各 272MB，不重复下载）。

**② `integration (shard 2/3)`：三个 Electron+SwiftShader 任务并发 → 渲染饥饿，用例真的红了**

```
FAIL message-list-follow-bottom.spec.ts ④ 流式回复持续增长时缺口不累积且能收敛
AssertionError: 流式期间距底缺口中位数 2506px（max 5011px）: expected 2506 to be less than or equal to 200
```

- 这正是 §10.3 里列的风险变成了事实：三片同时跑（各自一个 Electron + SwiftShader），24 线程被摊薄，
  rAF 驱动的「跟随底部」跑不动，列表持续落后。
- 修法：**按 job 轻重分标签**，让重型侧最多 2 并发——
  `fe-linux`（实例 1、2）只接 `integration` 三分片 + `integration-live2d`；
  `fe-light`（实例 3）只接 `check` / `unit` / `artifact`。
  工作量上两侧正好匹配（重型约 10.7 分钟 / 2 实例 ≈ 5.4 分钟；轻型约 5.5 分钟 / 1 实例）。
- **注意这不等于问题已消失**：并发争抢只是被限制到 2 个重型任务，仍需观察后续 run 的 flake 率。若再现同类
  失败，下一步是减到「1 个重型实例 + 其余轻型」，代价是墙钟回到 ~10 分钟。

### 10.7 第三处共享状态竞争：`~/setup-pnpm`（pnpm 自安装目录）

修完 store 之后的下一次 run（`34693129447`）又出现同类红：

```
X Something went wrong, self-installer exits with code 1     ← integration (shard 1/3)
```

- 机制：`pnpm/action-setup@v4` 的默认安装目录是 **`~/setup-pnpm`**，而三个实例跑在**同一个用户**下 →
  并发 job 的自安装器同时写同一目录。这与 §10.6 的 store 竞争是**同一类问题的两个实例**：
  **多实例共用 `$HOME` ⇒ `$HOME` 下的任何共享写路径都是竞争点。**
- 修法：给所有 job 的 `pnpm/action-setup` 加 `dest: ${{ runner.temp }}/setup-pnpm`（`runner.temp` 是各
  runner 自己的 `_work/_temp`，天然隔离）。**但 store 不能放进 `_work/_temp`**：runner 每个 job 开始时会
  清空该目录（日志 `Cleaning runner temp folder`），store 放那里等于每次重下——故 store 仍用
  `--store-dir "$HOME/.pnpm-store-${{ runner.name }}"`（稳定且按实例分开）。
- **教训（可推广）**：自建多实例 = 共享 `$HOME`；凡是写进 `$HOME` 的工具（包管理器安装目录、包缓存、
  各种 store）都要么按实例分开、要么确认其并发安全。目前已识别并处理三处：pnpm store、pnpm 自安装目录、
  （electron/playwright 缓存为只读性质且已预热，风险低但未逐一验证）。

### 10.8 第四轮（`34693414832` @ `53d733e`）：分片修复已验证，墙钟 429s，但仍有 1 例 flake ⇒ 用 **CPU 亲和**收口

- 结果：**7/8 绿，墙钟 429s（7.2 分钟）**。分片修复**已被日志证实**：失败那片报
  `Test Files 1 failed | 8 passed (9)` —— 片内 **9 个文件**（不再是把 27 个都跑一遍）。
  store 竞争与自安装器竞争两类红均未再出现。
- 剩下的唯一一红是 `electron-tools.spec.ts > 写冲突 → FILE_CONFLICT`。**注意这是第三轮里第三次不同用例的红**：

| 轮次 | 失败用例 | 形态 |
|---|---|---|
| `0f3b1c3` | `electron-live2d` B6 | 画布 6s 内无非透明像素 |
| `5261a82` | `persist-flush` 关窗前 flush | 点连接按钮 30s 超时 |
| `34692644842` | `message-list-follow-bottom ④` | 距底缺口中位数 2506px |
| `34693414832` | `electron-tools` 写冲突 | FILE_CONFLICT 断言未达 |

  四次红的**用例各不相同**、且每次都只有 1 例 ⇒ 进一步支持「环境性争抢」而非「产品回归」的判定
  （若是回归，红的会固定在同一点）。
- 修法（这一处**不在 workflow 里**，而在实例启动方式上）：**给每个 runner 实例固定 CPU 亲和**——
  `setsid nohup taskset -c <区间> ./run.sh`。24 线程切成互不重叠的三份：
  实例 1 → `4-13`（重型）、实例 2 → `14-23`（重型）、实例 3 → `0-3`（轻型）。
  亲和由 fork/exec **继承**，故该实例跑的所有 job（含 Electron 与 SwiftShader 的线程）都被限制在自己的核上，
  两个重型 job 不再互相抢核。实测已核对每个 `Runner.Listener` 的亲和列表。
- **这仍是缓解而非根治**：每个重型 job 现在拿到固定的 10 个线程（托管 runner 是 4 个 vCPU，所以不亏），
  但 Haswell 单核更慢这一条改不了。若仍出现 1 例级 flake，下一步按仓库既有做法处置
  （V-08/V-12 的先例：把「首次交互/首帧」的 POLL 预算从 8s 提到 `SLOW_POLL` 15s，或加一次 CI retry）——
  那属于改测试判据，须单独论证，不在本轮范围。

### 10.9 实例转常驻服务 + 首次全绿（run `34693817053` attempt 2）

用户以 `sudo` 完成三件事后（本轮由用户执行、我核对）：

1. **三个实例装成 systemd 服务**（`svc.sh install yomu`；实例 1 的 unit 早已存在、无需重装，`enable --now` 启用即可）。
2. **CPU 亲和写进服务**：用**非交互**方式写 drop-in（`systemctl edit` 需要编辑器，用户连续三次在"临时文件为空"
   时被取消 —— 这是本轮踩到的坑，正确做法是直接写
   `/etc/systemd/system/<unit>.d/override.conf`）：
   ```ini
   [Service]
   CPUAffinity=4-13        # 实例 2 用 14-23，实例 3（fe-light）用 0-3
   ```
   随后 `systemctl daemon-reload` + `restart`。实测三个 listener 的亲和列表分别为 `4-13`／`14-23`／`0-3` ✓。
3. **清掉一个孤儿 listener**：实例 1 重启后出现**两个 listener**（旧的无限重试
   `TaskAgentSessionConflictException: A session for this runner already exists`）。根因是 runner 的 unit 用
   **`KillMode=process`**（只杀主进程 `runsvc.sh`），重启时子 listener 会残留成孤儿。本轮直接 `kill` 掉孤儿即恢复。
   **建议的加固（可选）**：在同一 drop-in 里加 `KillMode=control-group`，让停止/重启连整棵进程树一起收掉。

**验证结果（attempt 2，`gh run rerun` 全量重跑，未改任何提交）：8/8 全绿，墙钟 412s（6.9 分钟）。**

| job | 耗时 | 落点 |
|---|---|---|
| `unit` / `check` / `artifact` | 1m37s / 2m37s / 1m19s | `yomu-X99-3`（fe-light，三者串行共用） |
| `integration shard 1/3` / `2/3` / `3/3` | 3m36s / 2m58s / 1m30s | `yomu-X99`、`yomu-X99`、`yomu-X99-2` |
| `integration-live2d` | 4m4s | `yomu-X99-2` |
| `windows build-level` | 3m41s | `yomu-win11` |

关键路径 = 重型侧最长链（实例 1 串行跑 shard2 + shard1 ≈ 6m34s）⇒ 与实测墙钟 6.9 分钟吻合。
**对比：托管 10.4 分钟且计费；现在 6.9 分钟、0 计费分钟。**

**结论的边界（不得过度解读）**：这一轮绿**不能证明 flake 已被消除** —— 前四轮各红 1 例、且每次是不同用例
（§10.8 表），本轮只是其中一次观测。**判据是后续若干轮的 flake 率**；若再现，按 §10.8 末尾的既有做法处理。
