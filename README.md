# Cyrene 前端仓库

Cyrene —— Electron 桌面 AI 助手客户端(Windows + Ubuntu)的前端工程。包含 Live2D 角色、流式 AI 回复、语音输入,以及桌面工具/授权系统。

> **当前状态:阶段 0 工程基线(带已知豁免提前开发)+ 阶段 1 第一块(安全骨架地基)、块 A(安全加载与环境基线)与块 B(主进程受信服务)已落地(v0.2)。** `docs/` 设计文档 + `ref/` UI 原型 + `apps/desktop/` 可运行的 Electron 壳。阶段 1 第一块已实现:9 子目录主进程结构、应用身份(`Cyrene` → `~/.config/Cyrene`)、userData 七目录(0700 + symlink 逃逸防护)、具名 Schema 校验 IPC 骨架(`app:get-info`)、主窗口导航/单实例/外部链接加固。**块 A 已实现**:`cyrene://` 受限自定义协议替代 `file://`、严格 CSP(响应头 AND 保留 meta)、dev/test/prod 环境(`__APP_MODE__` 烘焙)、生产安全默认(DevTools 恒关 + 远程调试门)、electron-builder 未分发包 + `verify:artifact`。**块 B 已实现**:凭据存储(`safeStorage` 加密 `config/credentials.json` + `credentialStatus` 4 值 IPC + key 白名单单一来源)+ 日志/审计(手写 JSONL logger 无 msg 参数/落盘双净化、append-only 审计按日 + 30 天清理)。**阶段 2 三块 + 真实联调整改·批次 A/B/C + 阶段 0/1 整改·批次 A/B/C/D 已落地**(526 单测(47 files)+ 23 集成(6 files)+ typecheck/lint/build + check:contract(13/13) + package + verify:artifact --smoke 全绿):真实联调整改·批次 A = 真实模式装配策略、连接面板 Endpoint/Token 设置、rejected ACK 结构化;批次 B = 连接后会话自动初始化、切会话不串台(conversation/epoch 守卫)、可见错误链与脱敏日志、握手/REST 超时与操作门控;批次 C = IPC 成功响应/replay 运行时 Schema(Main/Preload 双层校验 + 单条丢弃告警)、夹具场景补全 + manifest schemaHash 门禁 + 跨仓库契约脚本(`check:contract`)、文档漂移同步。**阶段 0/1 整改·批次 A = 跨平台文件与退出地基**:FE-S1-P0-01 Windows 安全文件首建/ENOENT 保留(safe-open 平台层可注入,`SafeOpenPlatform` posix/windows)、FE-S1-P1-02 非普通文件全拒(FIFO/socket/目录/device,POSIX `O_NONBLOCK` 防阻塞)、FE-S1-P2-02 `EMPTY_FILE` 工厂化(多 key 损坏重建不污染)、FE-S1-P1-03 CredentialStore `close()`/drain + 有序退出(凭据→adapter→diagnostics + 超时标记经同步审计落盘 + 统一 fatal 路径)。**阶段 0/1 整改·批次 B = Renderer 信任边界**:FE-S1-P0-02 dev Renderer URL 回环白名单(localhost/127.0.0.0/8/[::1] + `CYRENE_DEV_RENDERER_ORIGINS` 附加 allowlist,非法 URL **启动报错退出**;「受信 Renderer URL」收敛为 Main 单一策略函数,窗口加载/导航/IPC 来源共用)+ 开发 CSP(`frame-ancestors 'none'` 经 Vite 中间件注入响应头 + meta 收紧 `frame-src/form-action 'none'` + `connect-src` 去裸 ws:/wss:)、FE-S1-P2-01 IPC 来源纵深(`senderFrame===mainFrame` + 发送 frame 当前 URL 受信校验);**P0-02 关闭**(首次真实联调前最后 P0)。**阶段 0/1 整改·批次 C = 审计与持续门禁**:FE-S1-P1-01 审计接线(凭据生命周期 `credential:set/clear/status-change` + 连接生命周期 `connection:connect/disconnect/error` 接入 append-only audit;fail-open 语义 C1——审计失败不改变操作结果;真实应用装配集成测试:经 IPC set/clear 后 audit/ JSONL 出现预期行)+ FE-S1-P1-04 CI 持续门禁(新增 `artifact` job:clean + package + `verify:artifact --smoke` + SHA 证据;新增 `windows` job:构建级 typecheck/lint/unit/build,C3 不启动 Electron;POSIX 专属单测加平台守卫)。**阶段 0/1 整改·批次 D = 阶段 0 真实性**:FE-S0-P1-01 首次联调口径冻结(Linux 本机文本聊天最小闭环 13 项用例 + 三态状态(已开发/已验证/已真实联调)+ 阶段 0「带已知豁免提前开发」+ Windows「阶段 1 未通过项」+ 外部依赖清单 + README 真实联调启动说明)、FE-S0-P1-03 MockBackend 隔离与真实性(每实例会话状态 + 一致 CRUD + 每次 send 唯一 ID + 可注入 clock/ID + 单 generation 取消 + 并发/多实例测试)、FE-S0-P2-01 Node engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出、FE-S0-P2-02 占位命令非零退出 + credentials/diagnostics 子 README 真实化 + 主 README preload 修正。**首次真实联调整改(state/typing 兼容帧 + 单写者口径)已落地**:FE-INT-P1-01 后端合法 state/typing 帧建模为「已知但有意忽略的兼容帧」(RawState/RawTyping 入 RawFrame + strict schema + handleFrame 显式 no-op + check:contract 白名单 11→13 + state-typing fixture 组(handoff trace 真实帧,verified:false) + manifest schemaHash 同步,未知帧仍 fail-closed RAW_FRAME_INVALID)+ FE-INT-RISK-01 单写者约束文档化(单活动桌面客户端/单写者,多客户端不支持,含否决理由,不纳入 B-01 阻断门禁)。**二次真实联调整改(Renderer 水合 + replay 身份防御 + 取消码统一)已落地:FE-INT2-P0-01 Renderer 启动 snapshot 水合编排(统一 applyChatState + 启动代次守卫,reload 自动恢复连接/活动会话/历史,无需手工断开重连)、FE-INT2-P1-01 replay 身份契约防御(RawSessionMessageItem 要求非空 message_id/timestamp + 移除共享 `${conversationId}:replay` fallback + 无身份帧按协议错误处理由 REST 首屏恢复)、FE-INT2-P1-02 取消码统一(GENERATION_CANCELLED 正式码 + legacy CANCELLED 兼容 + 取消终态 interrupted 无失败横幅 + fixture 更新)。**Windows 联调仍阻塞**(真 Windows 上启动 Electron + Token 冒烟仍留 B-01/后续,C3 明确构建级)。后端协议契约已由交接包确认(doc 02 §19 对齐表已填写),正式 B-01 验收未通过(首次真实联调已执行 2026-08-13 确认 P1/RISK;二次真实联调已执行 2026-08-13 确认 P0/P1/RISK 问题并修复中),相关能力标注“已开发、未联调”。

## 文档入口

- **[docs/00-Cyrene-前端文档索引与阅读顺序.md](docs/00-Cyrene-前端文档索引与阅读顺序.md)** —— 一切从这里开始,含按角色的阅读路线与文档优先级
- 核心文档:`01` 总体架构 / `02` 前后端通信协议 / `07` 安全设计 / `12` 启动清单与分阶段计划 / `13` 交叉 Review 统一口径
- **`ref/cyrene-ui-preview-v5.html`** —— UI 原型(静态稿,含完整设计变量 token,是 Vue 界面的直接参考)

## 技术栈(已定案,版本锁定见下)

Electron + Vue 3 + TypeScript + Vite · Electron Forge · **pnpm** · Vitest · Playwright

## 环境信息

| 项 | 值 |
|---|---|
| 系统 | Ubuntu 22.04.5 LTS x86_64 |
| Node 版本管理器 | **fnm 1.39.0**(钩子已写入 `~/.bashrc`,路径 `~/.local/share/fnm`) |
| Node.js | **v22.23.0**(经 fnm 管理,`.nvmrc` 固定) |
| pnpm | **11.20.0**(全局,`~/.local/bin/pnpm`) |
| npm | 10.9.8(Node 自带) |
| Electron 系统依赖(libnss3 / libatk / libgtk-3 / libasound) | 均已存在 |

### 环境搭建(新机器/新环境)

```bash
# 1. 安装 fnm(Node 版本管理,装完重开终端或 source ~/.bashrc)
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc

# 2. 按仓库固定版本安装 Node(自动读取 .nvmrc)
fnm install && fnm default 22.23.0

# 3. 安装 pnpm
npm install -g pnpm
```

### 版本固定机制

- `.nvmrc` —— 固定 Node 版本,`fnm install` 自动读取
- `pnpm-workspace.yaml` —— `nodeLinker: hoisted`(保证 Electron Forge / 原生模块兼容)、`engineStrict: true`、`allowBuilds`(electron/esbuild/vue-demi 构建脚本白名单)
  - 注意:pnpm 11 的非认证设置(如 `node-linker`)放在 `.npmrc` 会**失效**,必须写在 workspace yaml
- 依赖锁文件 —— `pnpm-lock.yaml` 已提交进仓库
- Node 版本以 **22 系 LTS** 为准;升级需同步更新 `.nvmrc`、workspace yaml 校验与 CI
- **CI 版本同源**：CI 各 job 用 `actions/setup-node` 的 `node-version-file: .nvmrc`（22.23.0）+ pnpm-workspace.yaml `engineStrict: true`，与 engines `>=22.23.0 <23` 一致（单一版本来源：`.nvmrc`）

## 目录结构

```text
docs/                设计文档(18 份,中文,工程契约)
ref/                 UI 原型与预览图
apps/desktop/        Electron 工程(electron-vite:main / preload / renderer / shared)
  ├── src/main/      主进程:入口、transport(BackendAdapter + MockBackend)、夹具
  ├── src/preload/   具名窄 desktopApi(contextBridge, schema 校验)
  ├── src/shared/    领域契约 / 运行时 Schema(zod) / 纯逻辑 / 错误模型(跨进程共享)
  ├── src/renderer/  Vue 3 界面:设计 token、四区布局壳、双通道消息示意
  ├── tests/         unit / integration(Vitest)
  └── assets/live2d/ 占位(阶段 5 使用)
.github/workflows/ci.yml   CI(check/unit/integration + 批次 C 新增 artifact/windows job)
```

## 开发命令

> 命令语义见 [docs/09 §5](docs/09-Cyrene-前端构建打包与发布设计-v0.2.md)。阶段 0 已实现 dev / build / typecheck / lint / test / test:integration;阶段 1 块 A 已实现 `package`(electron-builder `dir` 未分发包)与 `verify:artifact`(产物检查,`--smoke` 启动冒烟);阶段 2 真实联调整改·批次 C 新增 `check:contract`(跨仓库契约脚本);`test:e2e`(Playwright)、`make`(Forge 打包)为占位命令，未实现，非零退出防假绿。

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动开发环境(Electron + Vite) |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | 静态检查 |
| `pnpm test` | 单元测试(Vitest) |
| `pnpm test:integration` | 集成测试 |
| `pnpm test:e2e` | 占位命令，未实现，非零退出防假绿 |
| `pnpm package` / `pnpm make` | 打包(electron-builder `dir` 未分发包,产物在 `dist/linux-unpacked/`) / 占位命令，未实现，非零退出防假绿 |
| `pnpm verify:artifact` | 校验产物内容与安全配置(静态检查;`-- --smoke` 追加 Playwright 启动冒烟) |
| `pnpm -F @cyrene/desktop check:contract` | 跨仓库 wire 契约检查(读 `elysia-agent/frontend_contract`,后端仓库未挂载时自动跳过) |

## 真实模式联调

> 装配策略（spec 决策 7）：**打包恒 Real**；未打包默认 Real，仅 `CYRENE_BACKEND=mock` 显式进入 Mock 演示模式（免 token）。真实联调时连接凭据的 Endpoint/Token 在**连接面板**内设置，渲染进程不传任意 URL（`connect` 无参；Token 与 Endpoint Origin 绑定，origin 变化自动清 token，详见 plan `docs/superpowers/plans/2026-08-11-phase2-realconn-preparation.md`）。

> **开发者提示（批次 B）**：未打包 dev 态的 `ELECTRON_RENDERER_URL` 只接受回环地址（`localhost` / `127.0.0.0/8` / `[::1]`）；如需指向局域网/自定义 host，用 `CYRENE_DEV_RENDERER_ORIGINS`（逗号分隔的 `http` origin）附加白名单——仅对开发者有用，普通用户无需设置（此设置只影响 dev Renderer 加载 URL 白名单，与后端 Endpoint 无关）。

| 场景 | 命令 |
|---|---|
| 显式 Mock（演示/联调前自测） | `CYRENE_BACKEND=mock pnpm dev` |
| 真实模式（默认，需设置 Endpoint + Token） | `pnpm dev`（或显式 `CYRENE_BACKEND=real pnpm dev`） |
| 打包产物 | 恒为 Real（无需 env；须在连接面板设置后端地址与 Token） |

启动后在连接面板操作：

1. **设置 Endpoint**：填 `https://…`（远程任意 host）或回环 `http://127.0.0.1:8765`（`localhost` / `127.0.0.0/8` / `[::1]`）；`http:` 非回环被拒；userinfo / query / fragment 被拒；pathname 保留、尾斜杠去除。
2. **设置 Token**：先设 Endpoint 才能设 Token（否则 `CREDENTIAL_UNAVAILABLE`）；Token 与当前 Endpoint origin 绑定，`setEndpoint` 改 origin 自动清旧 Token 与绑定，防跨域复用；提交后明文立即清空。
3. **连接**：`connect()` 无参，Main 校验绑定 origin 与 Token 存在后经 `BackendAdapter` 建立会话。

联调前置链路均已就绪（`chat-service` connect 无参 + `setEndpoint/getEndpoint/getRuntimeInfo`、desktopApi 三新方法、rejected ACK 结构化 `BACKEND_REJECTED`/`backendCode`/`retryable`），真实后端环境（B-01）到位即可进入联调；此前相关能力标注“已开发、未联调”。

**B-01 联调门禁（批次 C 定，spec §4.2.3）：** 真实后端环境（B-01）到位后，联调首日从真实后端抓取 **≥3 条真实 raw frame 样例**（覆盖 `server_info` / session / `user_message.ack` / generation 流），过前端 `parseRawFrame` + frame/rest mapper + `parseBackendEvent` 断言**全部通过**，作为 B-01 联调验收门禁；随后按后端实际 SHA 更新夹具 manifest（替换新增 8 组的 `verified:false` 占位）。此门禁与跨仓库契约脚本（`pnpm -F @cyrene/desktop check:contract`，读 `elysia-agent/frontend_contract`）共同构成「双方各自单测都绿但 wire 不兼容」的显式防线。

> **replay 身份契约（FE-INT2-P1-01 过渡期）**：前端已要求 session replay 消息非空 `message_id/timestamp`（缺身份帧按协议错误处理，由 REST 首屏恢复）。后端配套清单落地前，**过渡期首次连接**的活动会话需用户点击激活（重连/已激活场景不受影响）；B-01 复跑的 reload 恢复与 replay-REST 同 ID 项依赖后端修复先落地。

> **单活动桌面客户端/单写者约束（FE-INT-RISK-01，首次联调确认）：** 同会话由多个客户端同时写入不在当前产品范围。其他客户端对当前活动会话的写入（本端无本地 optimistic user 消息的 generation）保留现状到达序渲染，不保证跨客户端因果顺序。多客户端支持需前后端共同设计因果链（后端 generation.started 前广播 user committed / generation 携带 user 引用 / 会话级单调 sequence），当前不做；「低级别诊断」与「提示来自其他客户端」两选项均否决（单写者下跨客户端 generation 属罕见异常，额外诊断/提示引入 renderer 逻辑与文案成本，且不改变「不保证因果顺序」的事实）；本项不纳入首次单客户端 B-01 阻断门禁。

**阶段 0 门禁口径（批次 D 冻结，spec §4.4）：** 状态源为三态 **已开发**（代码落地、Mock 驱动）/ **已验证**（typecheck/lint/test/build/package/verify:artifact 全绿、未真实联调）/ **已真实联调**（真实后端 B-01 验收通过）；阶段 0 因外部输入未到位标「**带已知豁免提前开发**」（非「已验证」）。**首次联调 = Linux 本机文本聊天最小闭环**，13 项用例：启动 / 设置 Token / 连接 / 列会话 / 激活新建 / 发送 / ACK / 双通道流式 / completed / 取消 / 断线重连 / 错误展示 / 日志定位；后端 SHA / URL / 认证方式 / `SERVE_CHAT`（保持 0，`/` 404 ≠ Electron API 不可用）留 B-01 填。**Windows 为阶段 1 未通过项**（真 Windows 运行证据未到；构建级 CI 已有但不替代真机冒烟）。**外部依赖清单**（阶段通过门禁输入）：B-01 / H-01 / H-07 / G-01 / G-02 / H-04。

## 协作约定

- **Git push 由开发者手动执行。** 本环境(Claude 沙箱)无 GitHub 凭据,HTTPS 推送会失败;在 VS Code 集成终端里推送可复用 VS Code 的 GitHub 登录,免输入凭据。
- 文档修改保持**中文**,与 `docs/` 一致。
- 文档冲突时的优先级见 [docs/00 §5](docs/00-Cyrene-前端文档索引与阅读顺序.md)。

## 当前状态与下一步

- 阶段 0(工程基线)带已知豁免提前开发（非「已验证」）:`pnpm dev` 可启动 Electron 壳,typecheck / lint / test / build 通过
- 阶段 1 第一块(安全骨架地基)已落地:9 子目录、App 身份 + userData 七目录、具名 Schema IPC 骨架、主窗口加固(导航/单实例/外部链接);`docs/superpowers/specs|plans/2026-08-08-phase1-foundation-*` 为设计与实施文档
- **阶段 1 块 A(安全加载与环境基线)已落地并全量验证**:`cyrene://` 受限协议替代 `file://`、严格 CSP(`frame-src 'none'`、响应头 AND 保留 meta)、dev/test/prod 环境(`__APP_MODE__` 烘焙 + `resolveAppConfig`)、生产安全默认(DevTools 恒关 + 远程调试门)、electron-builder `dir` 未分发包 + `verify:artifact`(静态 + 冒烟 16/17 项);`docs/superpowers/specs|plans/2026-08-09-phase1-loading-env-*` 为设计与实施文档
- **阶段 1 块 B(主进程受信服务)已落地并全量验证**:凭据存储(`safeStorage` 封装 + 版本化 `config/credentials.json` 0600/原子写/每 key 加密块 + `credentialStatus` 4 值 IPC + key 白名单单一来源 `shared/contracts/credentials.ts`)+ 日志/审计(手写 JSONL logger `(code, fields?)` 无 msg 参数/落盘双净化、共享 file-writer rotate 5MB×3、append-only 审计按日 + 30 天清理)+ 装配(before-quit allowQuit 防挂死 flush);177 单测 + typecheck/lint/build 全绿;`docs/superpowers/specs|plans/2026-08-09-phase1-trusted-services-*` 为设计与实施文档
- **阶段 0/1 整改·批次 A(跨平台文件与退出地基)已落地并全量验证**:FE-S1-P0-01 Windows 安全文件首建/ENOENT 保留(`SafeOpenPlatform` posix/windows 平台层可注入,`existing+ENOENT` 原样抛原始 errno)、FE-S1-P1-02 非普通文件全拒(FIFO/socket/目录/device,POSIX 打开追加 `O_NONBLOCK` 防阻塞 + 统一 `fd.stat().isFile()` 不变量)、FE-S1-P2-02 `EMPTY_FILE` 工厂化(损坏重建互不污染)、FE-S1-P1-03 CredentialStore `close()`/drain + 有序退出(凭据→adapter→diagnostics、超时标记经同步审计落盘 + 统一 fatal 路径);**501 单测(46 files)+ 23 集成(6 files)** + typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿;仍标「已开发、未联调」;**Windows 联调仍阻塞**(P0-01 已修;真 Windows 上启动 Electron + Token 冒烟仍留 B-01/后续,批次 C 的 windows job 为构建级)
- **阶段 0/1 整改·批次 B(Renderer 信任边界)已落地并全量验证**:FE-S1-P0-02 dev Renderer URL 回环白名单(`ELECTRON_RENDERER_URL` 只接受回环 localhost/127.0.0.0/8/[::1] + `CYRENE_DEV_RENDERER_ORIGINS` 附加 allowlist http origin,非法 URL **启动报错退出**;「受信 Renderer URL」收敛为 Main 单一策略函数 `trusted-renderer-origin.ts`,窗口加载/导航/IPC 来源共用)+ 开发 CSP(`frame-ancestors 'none'` 经 Vite 中间件注入响应头 + meta 收紧 `frame-src/form-action 'none'` + `connect-src` 去裸 ws:/wss: 只放行回环/allowlist ws)、FE-S1-P2-01 IPC 来源纵深(`senderFrame===mainFrame` + 发送 frame 当前 URL 受信校验);**P0-02 关闭**(首次真实联调前最后 P0);**501 单测(46 files)+ 23 集成(6 files)** + typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿;仍标「已开发、未联调」(dev 回环启动冒烟 + HMR 放行 headless 不可做,记为 B-01 联调首日或本机冒烟验证项);**Windows 联调仍阻塞**(真 Windows 上启动 Electron + Token 冒烟仍留 B-01/后续,批次 C 的 windows job 为构建级)
- **阶段 0/1 整改·批次 C(审计与持续门禁)已落地并全量验证**:FE-S1-P1-01 审计接线(凭据生命周期 `credential:set/clear/status-change` + 连接生命周期 `connection:connect/disconnect/error` 接入 append-only audit;fail-open 语义 C1——审计失败不改变操作结果;真实应用装配集成测试:经 IPC set/clear 后 audit/ JSONL 出现预期行)+ FE-S1-P1-04 CI 持续门禁(新增 `artifact` job:clean + package + `verify:artifact --smoke` + SHA 证据;新增 `windows` job:构建级 typecheck/lint/unit/build,C3 不启动 Electron;POSIX 专属单测加平台守卫);**501 单测(46 files)+ 23 集成(6 files)** + typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿;仍标「已开发、未联调」(真实后端联调未进行);CI 两个新 job 需 push 触发 GHA 验证(本机沙箱无 GHA);**Windows 联调仍阻塞**(真 Windows 上启动 Electron + Token 冒烟仍留 B-01/后续,C3 明确构建级);spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchC-*`
- **阶段 0/1 整改·批次 D(阶段 0 真实性)已落地并全量验证**:FE-S0-P1-01 首次联调口径冻结(Linux 本机文本聊天最小闭环 13 项用例 + 三态状态(已开发/已验证/已真实联调)+ 阶段 0「带已知豁免提前开发」+ Windows「阶段 1 未通过项」+ 外部依赖清单 + README 真实联调启动说明)、FE-S0-P1-03 MockBackend 隔离与真实性(每实例会话状态 + 一致 CRUD + 每次 send 唯一 ID + 可注入 clock/ID + 单 generation 取消 + 并发/多实例测试)、FE-S0-P2-01 Node engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出、FE-S0-P2-02 占位命令非零退出 + credentials/diagnostics 子 README 真实化 + 主 README preload 修正;**501 单测(46 files)+ 23 集成(6 files)** + typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿;仍标「已开发、未联调」;真实后端 B-01 联调 + 真 Windows Token 冒烟 + H-01/H-07 拍板为唯一剩余外部依赖;spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchD-*`
- 后端协议契约已由交接包确认(doc 02 §19/§19.1 对齐表,40 错误码,WS v2);真实后端环境待联调
- 待外部输入(阻塞后续阶段):真实后端测试环境地址(B-01)、主验收平台(H-01)、Live2D SDK 许可与模型(G-01/G-02)、签名证书(H-04)
- **下一步:真实后端联调(B-01 到位后,见「真实模式联调」小节,含 B-01 联调门禁)或阶段 3 完整聊天/历史/多媒体** —— 阶段 2 真实联调整改·批次 A/B/C 已把装配策略、连接面板(Endpoint/Token)、真实连接编排与联调门禁就绪
