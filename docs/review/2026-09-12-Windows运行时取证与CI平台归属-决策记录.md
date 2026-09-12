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
