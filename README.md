# Cyrene 前端仓库

Cyrene —— Electron 桌面 AI 助手客户端(Windows + Ubuntu)的前端工程。包含 Live2D 角色、流式 AI 回复、语音输入,以及桌面工具/授权系统。

> **最新状态（2026-08-15）：阶段 4 批次 A（模型服务 Profile 管理 + TTS 试听）已落地并全量验证。** 契约（`ModelProfile` / `UpsertModelProfileCommand` / `ModelProfileTestCommand` / `ActivateModelProfileCommand` / `TtsVoice` / `TtsPreviewCommand` / `SetTtsVoiceCommand` / `ActiveModelSelection`）→ Schema → real/mock backend → MediaService 一次性 `tts-preview` 媒体路由 → IPC → preload → store → 设置 UI → 集成测试全链路落地；决策 D1（阶段 4 分两块，P4-A = Profile 管理 + TTS 试听 / P4-B = 语音）/ D3（TTS 自动朗读归 P4-B）/ D4（backend 为主，desktop/local_worker 展示不可用态）已由用户敲定；当前激活来源 `server_info.services` + `switch_model_result`/`set_tts_voice_result`（无 `model.profile.changed` wire 事件）、`credentialStatus` 两态一次性提交、切换只影响新请求；**D-8 关闭**（后端 `556117a` 为 `dictation.start` 增加 `sttProfileId`，输入法转写可独立选择兼容 STT Profile）。门禁：**994 单测（88 files）/ 55 集成（13 files）** + typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）。阶段 4 新功能仍标「已开发、未联调」（Mock 驱动），真实 Windows Electron（REAL）联调为验收方（下一轮）；阶段 3 保持「已真实联调」，阶段 2 主链保持「已真实联调」（B-01 封口）。决策见 [阶段 4 批次 A 决策记录](docs/review/2026-08-15-阶段4批次A-决策记录.md)。

> **最新状态（2026-08-15）：阶段 3 已真实联调通过。** 真实 Windows Electron（REAL 模式，经 SSH 本地转发连接 Ubuntu backend `0.1.0+556117a` / protocol `2.0`）完成历史查看器 50+50 短回归：普通点击「加载更多」可加载第二页，100 条顺序/去重/来源跳转正常，面板完整在窗口内内部滚动（FE-S3-RUN2-P1-01 闭环）。阶段 3 四组（G1 布局响应式 / G2 历史聊天体验 / G3 附件多媒体 / G4 历史查看器+表情+无障碍）及 2026-08-15 三批整改（联调前 / 复验 / 第二轮布局）全部由「已开发、未联调」升「已真实联调」。门禁：944 单测（83 files）/ 42 集成（11 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）。阶段 2 主链保持「已真实联调」（B-01 封口）。下一块阶段 4/5（模型服务与语音 / Live2D）可推进。详见 [阶段 3 真实联调通过-验收记录](docs/review/2026-08-15-阶段3真实联调通过-验收记录.md)。

> **阶段 2 联调状态（2026-08-14）：B-01 已真实联调通过。** Windows Electron `43.3.0` / Chrome `150.0.7871.212` 使用前端 `6b27e2e1ebf4e6ba3e335352379892e7c2679da2` 与后端 `73ac7a32415aa96bbec7687ae0c9e674ab675438`、schemaHash `e5d4dd2b9296b727` 完成 B-01 十项复跑。修复后两轮 `76s` 空闲文本/reload、取消、replay/REST/Store 身份与诊断全绿；单测 `527/527`、Electron 集成 `23/23`、contract `13/13` / `63` 帧、typecheck/lint/build 通过。阶段 3 可转为主线。详见 [第三次真实联调前端闭环报告](docs/review/2026-08-14-Windows-Electron-第三次真实联调前端阻断.md)。

> **阶段 3 已落地（2026-08-14）并完成联调前整改、真实联调复验整改与真实联调第二轮整改（2026-08-15）：** G1 布局响应式 / G2 历史聊天体验 / G3 附件多媒体 / G4 历史查看器+表情+无障碍 四组全部落地并全量验证。阶段 3 真实联调前整改 5 项（日期自然日 P0-01 / webm kind hint D1 / REST 跨仓门禁 D2 / 贴图真实契约 D3 / 删死代码 D4 + B-02 验收口径）已落地，B-02/B-03 进入条件达成。阶段 3 真实联调复验整改 4 项（P0-01 相对签名 URL 基于 endpoint 解析 / P0-02 ContentPart 可空数字 null 归一化（+ REST/WS replay wire 边界放行 duration_ms null）/ P0-03 StickerPart 恢复（用户 `Message.stickerId` + assistant sticker 分段）/ P1-01 历史搜索统一 `sortKey` 升序）已落地并全量验证。阶段 3 真实联调第二轮前端整改（FE-S3-RUN2-P1-01 历史查看器布局/加载更多不可达）已修复并补真实 Electron 布局/点击集成测试（**944 单测（83 files）+ 42 集成（11 files）** + typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿）：纯 CSS 容器约束（面板定高 + 结果区 `overflow-y:auto` 内部滚动 + `overflow-anchor:none`）+ loadMore 锚点补偿 + mock 大 seed（`CYRENE_MOCK_HISTORY_LARGE`）分页语义对齐 real。新功能（附件上传/媒体、历史查看器 search/context/stickers、草稿/离线缓存）已真实联调通过（2026-08-15，真实 Windows Electron 历史查看器 50+50 短回归：普通点击加载第二页 100 条顺序/去重/来源跳转正常，后端 `556117a`），阶段 3 整体升「已真实联调」；阶段 2 主链保持「已真实联调」（B-01 封口）；下一块阶段 4/5（模型服务与语音 / Live2D）可推进。决策要点见 [阶段 3 决策记录](docs/review/2026-08-14-阶段3-决策记录.md)、[联调前整改决策记录](docs/review/2026-08-15-阶段3-联调前整改-决策记录.md)、[真实联调复验整改决策记录](docs/review/2026-08-15-阶段3-真实联调复验整改-决策记录.md) 与 [真实联调第二轮前端整改决策记录](docs/review/2026-08-15-阶段3真实联调第二轮前端整改-决策记录.md)。

> 下方长段“当前状态”保留了各批次的历史实施摘要；其中“Windows 联调仍阻塞”等旧措辞已被上述 2026-08-15 最新状态取代。

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

联调前置链路与 B-01 真实 Windows Electron 十项验收均已完成；阶段 2 主链标注为“已真实联调”。

**B-01 联调门禁（批次 C 定，spec §4.2.3）：** 真实后端环境（B-01）到位后，联调首日从真实后端抓取 **≥3 条真实 raw frame 样例**（覆盖 `server_info` / session / `user_message.ack` / generation 流），过前端 `parseRawFrame` + frame/rest mapper + `parseBackendEvent` 断言**全部通过**，作为 B-01 联调验收门禁；随后按后端实际 SHA 更新夹具 manifest（替换新增 8 组的 `verified:false` 占位）。此门禁与跨仓库契约脚本（`pnpm -F @cyrene/desktop check:contract`，读 `elysia-agent/frontend_contract`）共同构成「双方各自单测都绿但 wire 不兼容」的显式防线。

> **replay 身份契约（FE-INT2-P1-01）**：前后端配套修复已落地并经 B-01 验证；session replay 的 `message_id/timestamp/tool_call_id` 与 REST/Store 一致，reload 与断开重连均无重复消息。

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
- **阶段 3(完整聊天/历史/多媒体)四组已落地并全量验证(2026-08-14)**:G1 布局响应式(断点 1200/736/520/320、会话栏 260 可折叠/Live2D 右栏 340 可调、最小窗口 1100×700、布局记忆 localStorage `cyrene.layout.v1`)、G2 历史聊天体验(CyMessageList 自研虚拟列表 + 锚点捕获/恢复/补偿 + 回到底部、草稿 50 会话×100KB 超限提示、离线缓存最近 20 会话、草稿/滚动锚点归 Main 持久化)、G3 附件多媒体(附件内嵌 Message + ContentPart、通用媒体代理 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`、原生预览+图标卡、拖拽不自动上传发送)、G4 历史查看器+表情+无障碍(CyHistoryViewer 全窗覆盖式查看器、只内置 `st_` 表情包、IME/焦点/键盘无障碍);**904 单测(82 files)+ 39 集成(10 files)** + typecheck/lint/build + check:contract(WS 13/13 + REST 段 8/8) 全绿;2026-08-15 联调前整改(日期自然日/webm kind hint/REST 跨仓门禁/贴图真实契约/删死代码 + B-02 验收口径)落地,B-02/B-03 进入条件达成;2026-08-15 真实联调复验整改(P0-01 相对签名 URL / P0-02 ContentPart null / P0-03 StickerPart 恢复 / P1-01 搜索排序升序)落地并全量验证(936 单测（82 files）+ 39 集成（10 files）+ check:contract WS 13/13 + REST 段 8/8),新增真实相对签名 URL/ContentPart null/StickerPart replay/两页排序 fixture;2026-08-15 真实联调第二轮前端整改(FE-S3-RUN2-P1-01 历史查看器布局/加载更多不可达)修复并全量验证(944 单测（83 files）+ 42 集成（11 files）+ check:contract WS 13/13 + REST 段 8/8):纯 CSS 容器约束(面板定高 + 结果区内部滚动 + overflow-anchor:none)+ loadMore 锚点补偿 + mock 大 seed(CYRENE_MOCK_HISTORY_LARGE)分页语义对齐 real + 真实 Electron 布局/点击集成测试三用例;阶段 3 已真实联调通过(2026-08-15,真实 Windows Electron 历史查看器 50+50 短回归:普通点击加载第二页 100 条顺序/去重/跳转正常),阶段 3 整体升「已真实联调」,阶段 2 主链保持「已真实联调」(B-01 封口);spec/plan 见 `docs/superpowers/specs|plans/2026-08-14-phase3-*`、`docs/superpowers/specs/2026-08-15-phase3-integration-fixes-*`、`docs/superpowers/specs/2026-08-15-phase3-reverify-fixes-*` 与 `docs/superpowers/specs|plans/2026-08-15-phase3-rerun2-layout-*`,决策见 `docs/review/2026-08-14-阶段3-决策记录.md`、`docs/review/2026-08-15-阶段3-联调前整改-决策记录.md`、`docs/review/2026-08-15-阶段3-真实联调复验整改-决策记录.md` 与 `docs/review/2026-08-15-阶段3真实联调第二轮前端整改-决策记录.md`
- 待外部输入（不再含已关闭的 B-01）：主验收平台(H-01)、Live2D SDK 许可与模型(G-01/G-02)、签名证书(H-04)
- **阶段 4 批次 A（模型服务 Profile 管理 + TTS 试听）已落地并全量验证（2026-08-15）**：**994 单测（88 files）+ 55 集成（13 files）** + typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿；仍标「已开发、未联调」（Mock 驱动），真实 Windows Electron（REAL）联调为验收方（下一轮）；D-8 关闭（后端 `556117a` 为 `dictation.start` 增加 `sttProfileId`，E-07 契约已确认）；决策见 `docs/review/2026-08-15-阶段4批次A-决策记录.md`
- **下一步：阶段 4 批 B（语音：普通录音/实时语音/转写）转为主线**；B-01 报告与实际 SHA 已回填
