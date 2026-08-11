# Cyrene 前端实施任务清单与进度跟踪

**文档版本：** v0.1
**文档状态：** 随实施持续更新 / 阶段 0 基线 + 阶段 1 三块（安全加载/凭据·日志/集成测试）已落地并全量验证（182 单测 + 18 集成）；阶段 2 三块（A 领域契约+raw wire / B RealBackend / C Store+IPC+UI）全部落地并全量验证（312 单测 + typecheck/lint/build 全绿，**已开发、未联调**）；阶段 2 真实联调整改·批次 A（连接凭据安全 / 真实模式装配 / rejected ACK 结构化）三块落地并全量验证（360 单测 + 20 集成 + typecheck/lint/build 全绿，**已开发、未联调**）；阶段 2 真实联调整改·批次 B（真实连接编排：连接后会话初始化 / conversation·epoch 守卫 / 可见错误链与脱敏日志 / 超时·取消·门控）落地并全量验证（**399 单测 + 22 集成** + typecheck/lint/build 全绿，**已开发、未联调**）；阶段 3 待推进；真实联调待外部输入（B-01/H-01/G-01/G-02）
**文档日期：** 2026-08-06
**依据文档：** [10-Cyrene-前端实施路线与任务拆分-v0.2.md](10-Cyrene-前端实施路线与任务拆分-v0.2.md)、[12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md](12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md)

---

## 0. 本文定位与使用方式

本文是**逐阶段执行的活清单**，把文档 10 的技术任务和文档 12 的进入条件/验收门槛拆成可勾选项，用于跟踪推进进度。它**不替代** 10/12：两份依据文档仍是阶段编号、进入条件和验收门槛的权威来源；发现差异时以 12 为准，并同步修订 10 与本文。

**状态标记（沿用文档 12 约定）：**

- `[ ]` 待办 / 尚未提供；
- `[~]` 进行中 / 部分完成；
- `[x]` 已完成并通过验证；
- 仅由 Mock 驱动完成的任务必须标注 **“已开发、未联调”**，真实后端通过前不得标为“已完成”。

**更新规则：** 每个任务完成时在括号后补记日期与方式；新增需求进入变更清单，不直接插入当前阶段。

---

## 1. 总体阶段视图

```text
阶段 0 资料与协议基线 ──▶ 阶段 1 Electron 安全骨架 ──▶ 阶段 2 核心聊天纵向闭环
                                                            ├─▶ 阶段 3 完整聊天、历史与多媒体
                                                            ├─▶ 阶段 4 模型服务与语音
                                                            └─▶ 阶段 5 Live2D
                             阶段 1/2 ──▶ 阶段 6 工具、权限与 Desktop P0 能力
  阶段 3/4/5/6 ──▶ 阶段 7 安全、稳定性与性能收敛 ──▶ 阶段 8 打包、跨平台与 Demo 验收
```

**当前所处阶段：阶段 1 三块（安全加载 / 凭据·日志 / IPC 集成测试）全部落地并全量验证；阶段 2 三块（A 领域契约+raw wire、B RealBackend REST/WS Adapter、C Store+IPC+聊天 UI 纵向闭环）全部落地并全量验证（312 单测 + typecheck/lint/build 全绿），标记「已开发、未联调」——「发送 → 流式 → 渲染」完整链路已打通（Mock 驱动）；阶段 2 真实联调整改·批次 A（FE-P0-01 Token 与 Endpoint Origin 绑定 / FE-P1-02 Real/Mock 装配策略与最小连接设置 / FE-P1-01 rejected ACK 即时结构化传递）落地并全量验证（360 单测 + 20 集成），仍标记「已开发、未联调」——连接面板（Endpoint/Token 设置）+ 装配策略已就绪；阶段 2 真实联调整改·批次 B（FE-P1-03 连接后会话初始化 / FE-P1-04 conversation·epoch 守卫 / FE-P1-05 可见错误链与脱敏日志 / FE-P2-01 超时·取消·门控）落地并全量验证（399 单测 + 22 集成 + typecheck/lint/build 全绿），仍标记「已开发、未联调」——连接后会话自动就绪、切会话不串台、错误可见、超时/门控完整，真实后端环境（B-01）到位即可进入联调；下一块为阶段 3 完整聊天/历史/多媒体（含历史查看器、附件、代码复制）。**

- 仓库与 git：已完成（初始化、分支 main、远程 origin、上游跟踪）
- 开发环境：已完成（fnm + Node 22.23.0 + pnpm 11.20.0，`.nvmrc` / `.npmrc` / README）
- 工程脚手架：已完成（阶段 0 基线：脚手架/契约/Adapter+Mock/token+四区 UI/单测/CI，见 §3）
- 后端输入（B/C/D/E/F 契约）：**已由后端批次 0-8c 全部实现并交付**（frontend-handoff-v2），doc 02 §19 对齐表已填写；真实环境实测/联调待进行（详见 §2 说明）
- 仍缺输入（外部资源/产品决策）：主验收平台（H-01）、Live2D SDK 与模型资源（G-01/G-02）、签名证书（H-04）、测试环境地址（B-01）；其余 `[ ]` 为前端本地授权/沙盒/审计设计与产品决策（非后端缺口）

---

## 2. 待补齐的外部输入（来自文档 12，P0 阻塞项优先）

> 这些输入决定 Adapter 契约与联调排期；未到位时对应任务只能以 Mock 推进并标注“已开发、未联调”。

> **2026-08-08：** 后端**批次 0-8c 全部完成**（协议契约 + 审计修复闭合，2798 tests），交接包 frontend-handoff-v2 提供全部协议契约；doc 02 §19/§19.1 已填写（27 项对齐 + D-1~D-10 桥接差异）。符号约定：**`[~]` = 契约已由后端提供/确认、待真实环境实测/联调**（后端只读核对，未改后端）；**`[ ]` = 前端产品/安全决策或外部资源，非后端未实现**。已标 `[~]`：B-02~B-06/B-08、C-01~C-09、**D-01~D-08**、E-01~E-06/E-08、F-01~F-05/**F-06（沙盒目录已定）**/**F-08**、G-04、**H-03/H-06/H-09（日志/开发者模式策略已定默认）**。仍缺 `[ ]`：B-01/B-07、C-10/C-11、E-07（转写专用 STT 字段，待决策）、E-09（Local Worker 接口）、F-07/F-09~F-11（**前端本地授权/审计设计**）、G-01~G-03/G-05/G-06（**Live2D SDK 许可 + 模型资源，外部输入**）、H-01/H-02/H-04/H-05/H-07/H-08（**产品决策/签名证书**）。阶段 1 进入条件 E-03 凭据所有权契约已确认（后端 Secret Store + desktop/local 归 Electron），前端侧落地 = `safeStorage` 不可用即拒存（§4.0）。

### 2.1 工程、仓库与协作（A 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [x] | A-01 | 前端仓库（已建并推送 `elysia-frontend`，main 分支） | 0 |
| [~] | A-02 | 分支/提交/Review 约定（已定：本地提交、手动 push；Review 方式待定） | 0 |
| [x] | A-03 | Node 版本、包管理器与工具链（fnm + Node 22.23.0 + pnpm） | 0 |
| [x] | A-04 | 代码规范/格式化/Lint/测试约定（eslint flat config + vitest + tsconfig 已落地） | 0 |
| [ ] | A-05 | CI 环境与 Runner（Windows/Ubuntu Runner 是否可用） | 1 |
| [~] | A-06 | Issue/变更/版本记录方式（暂用本文档与 git 记录） | 0 |

### 2.2 后端环境、认证与基础通信（B 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [ ] | B-01 | 测试环境地址/端口/协议/网络访问 | 0 |
| [~] | B-02 | 认证方式、测试账号、Token 获取/刷新/注销（契约已确认：静态 Bearer + `AGENT_ACCESS_TOKEN`，无 refresh/注销；测试账号待环境） | 0 |
| [~] | B-03 | REST / WebSocket / SSE 真实连接样例（WS v2 + REST，无 SSE） | 0 |
| [~] | B-04 | 协议版本、客户端版本协商与不兼容错误（`X-Protocol-Version` + `server_info.protocol_version`） | 0 |
| [~] | B-05 | 心跳、超时、断线、重连与续传规则（无断点续传；session 回放 + pending/generations 查询） | 2 |
| [~] | B-06 | 统一错误结构、错误码与 traceId 规则（40 码 + `ProtocolError`，WS 侧 `requestId`） | 2 |
| [ ] | B-07 | 测试环境上传/清理规则 | 3 |
| [~] | B-08 | 后端日志查询 / 联调 Trace 协作方式（`requestId` 关联） | 2 |

### 2.3 会话、消息与流式回复契约（C 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | C-01 | 会话列表/新建/重命名/删除/详情接口（`/api/sessions` + WS `activate_session`） | 2 |
| [~] | C-02 | 历史消息分页、稳定排序键、游标失效规则（`before`/`after` keyset + `has_more`） | 2 |
| [~] | C-03 | 发送/确认/重试与 `clientRequestId` 幂等规则 | 2 |
| [~] | C-04 | 完整回复的开始/增量/分段完成/父完成/失败事件记录（`traces/ws-v2-*.jsonl`） | 0 |
| [~] | C-05 | `messageId/generationId/segmentId/segmentIndex` 真实字段（`responseId` 弃用，别名 `generationId`） | 0 |
| [~] | C-06 | Inner Voice 与 Public Reply 字段、交错顺序与完成语义 | 0 |
| [~] | C-07 | 回复级/会话级 Token 字段（`usage{turn_total,rounds}` + `conversationUsage{total,byModel}`） | 2 |
| [~] | C-08 | 实际模型、心情代码、显示名、强度与来源字段（`generation.completed.model/mood`） | 2 |
| [~] | C-09 | 停止生成、取消成功与迟到增量规则（WS `interrupt` → `generation.failed{CANCELLED}`） | 2 |
| [ ] | C-10 | Markdown/引用/链接/代码块格式样例（后端 content 为纯文本，渲染由前端处理） | 2 |
| [ ] | C-11 | 撤回/编辑/重新生成/分支是否进入 Demo | 3 |

### 2.4 附件、多媒体、搜索与聊天历史（D 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | D-01 | 附件上传流程（`POST /api/uploads`：multipart `files[]`+`kind`、魔数校验、≤10 文件、10/50/20/20MB、聚合 64MB、sha256、取消/丢弃） | 3 |
| [~] | D-02 | 附件下载/播放鉴权、URL 有效期与刷新（签名下载 `/api/attachments/{id}?sig=&exp=` 24h + 签发 `/sign` 端点 + Range/206） | 3 |
| [~] | D-03 | 图片/视频/音频元数据、MIME/编解码矩阵、缩略图（MIME/编码矩阵已确认；**缩略图后端未提供**，阶段 3 前端处理） | 3 |
| [~] | D-04 | 拖拽/粘贴允许类型、数量与最大尺寸（后端校验权威：类型/MIME/数量/尺寸上限已确认） | 3 |
| [~] | D-05 | 历史查看器关键词/日期/分类/游标查询接口（`/api/search/messages` + `/api/sessions/{id}/messages` before/after） | 3 |
| [~] | D-06 | 搜索命中/资源项跳回来源消息所需 ID（`SearchMessageItem.messageId/responseId` + `ResourceItem.messageId`） | 3 |
| [~] | D-07 | 表情包来源、稳定 ID、版本、收藏与同步范围（内置 sticker 稳定 `st_` ID + `/api/stickers`；收藏/同步为产品决策） | 3 |
| [~] | D-08 | 资源保存/下载/缓存/过期清理策略（GC 四规则：软删 24h / 未引用 7 天 / 孤儿清理 / 磁盘缺失软删） | 7 |

### 2.5 模型服务、语音与输入法转写（E 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | E-01 | LLM/STT/TTS Profile 查询、创建、测试、激活、禁用、删除（`/api/providers` + WS `switch_model`） | 4 |
| [~] | E-02 | 内置/自定义 Profile 字段、Provider、能力、执行位置枚举（`runtime/credentialConfigured/capabilities`） | 4 |
| [~] | E-03 | 凭据所有权（后端/Main/Local Worker）与一次性提交规则（后端 Secret Store `data/secrets/`；desktop/local 归 Electron） | 1 |
| [~] | E-04 | 自定义 Endpoint 安全规则（后端 SSRF 校验已落地 `SSRF_BLOCKED`；前端 Header/重定向白名单细节阶段 4） | 4 |
| [~] | E-05 | 录音/实时语音音频格式、采样率、字幕、VAD、断句、轮次事件（三种语音 v2-only 契约已确认） | 4 |
| [~] | E-06 | TTS 整段/流式、音频格式、声音、取消与播放完成事件（`audio_*` 流式；声音 `GET /api/tts/voices`） | 4 |
| [ ] | E-07 | 输入法转写专用 STT 选择与执行位置（后端 `dictation.start` 无独立 STT 字段，用活动 STT——**待决策**，doc 02 §19 D-8） | 4 |
| [~] | E-08 | 输入法转写按下/松开/取消/最终文字/临时音频清理规则（`dictation.*` 契约已确认，零消息副作用） | 4 |
| [ ] | E-09 | Local Worker 启动、发现、版本、模型下载与资源占用接口 | 4 |

### 2.6 工具系统、Desktop Runtime 与权限策略（F 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | F-01 | 工具注册表、名称/描述/Runtime/风险/输入输出 Schema（`GET /api/tools` → `ToolMetadata[16]`） | 6 |
| [~] | F-02 | Backend/Desktop/Local Worker 真实标识与路由规则（`runtime` + `X-Client-Platform: electron`） | 6 |
| [~] | F-03 | 工具请求/状态/进度/结果/失败/取消/超时事件（`tool.request` / `tool.status` 六态） | 6 |
| [~] | F-04 | `callId` 幂等、重连查询与结果重传规则（`paramHash` 篡改拒绝 + `GET /api/tools/calls/{callId}`） | 6 |
| [~] | F-05 | Demo P0 Desktop 工具最终清单（确认四工具：文件选/读/写 + 截图；`desktop.command.run` 不注册） | 6 |
| [~] | F-06 | 沙盒目录已定（`userData/sandbox`）；**路径/域名黑名单默认值与授权级别阶段 6 细化**（后端 security §3.2 明确属 Electron 本地职责，前端需自行设计） | 6 |
| [ ] | F-07 | 授权级别（一次/目录范围/命令模板/有效期/撤销）（前端本地授权设计，待产品决策） | 6 |
| [~] | F-08 | 受控命令模板是否进入 Demo（后端确认 `desktop.command.run` 不注册 → **命令模板不进入 Demo**，已闭环） | 6 |
| [ ] | F-09 | 文件写入 Diff、覆盖、写前哈希、冲突与回滚要求（前端工具 UX 设计，待产品决策） | 6 |
| [ ] | F-10 | 截图在 Windows/X11/Wayland 的选择与授权要求 | 6 |
| [ ] | F-11 | 审批历史/工具日志保留、容量、清理与导出策略 | 7 |

### 2.7 Live2D 资源与表现规则（G 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [ ] | G-01 | 可用的 Live2D SDK 版本、许可分类（AI/Chatbot/Expandable）（**外部输入**：SDK 许可需采购/确认；后端 `character/` 为性格配置非 Live2D 模型） | 5 |
| [ ] | G-02 | 至少两个合法模型配置及 Manifest（**外部输入**：需合法 Live2D 模型资源，代码无法提供） | 5 |
| [ ] | G-03 | 模型表情/动作/参数名称安全白名单 | 5 |
| [~] | G-04 | 后端情绪/状态 → idle/listening/thinking/speaking 映射表（`expression`/`generation.completed.mood` 源字段已确认；映射表待设计产出） | 5 |
| [ ] | G-05 | TTS 口型驱动方式（音量/音素/后端参数） | 5 |
| [ ] | G-06 | 默认模型、切换规则、目标帧率与低性能降级策略 | 7 |

### 2.8 平台、测试、发布与产品边界（H 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [ ] | H-01 | 首个主验收平台（建议 Windows 11 x64） | 0 |
| [ ] | H-02 | Windows 10 / Ubuntu 目标版本、X11/Wayland 范围 | 1 |
| [~] | H-03 | 应用名称、App ID、图标、版本号与版权（名称 Cyrene / 版本 0.1.0 已定于 `package.json`；App ID/图标/版权待定） | 1 |
| [ ] | H-04 | Windows 签名证书、Linux 包格式与发布渠道（**外部输入**：签名证书需采购） | 8 |
| [ ] | H-05 | 自动更新是否进入 Demo；更新源与回滚策略（产品决策） | 8 |
| [~] | H-06 | 测试账号/会话/文件/可公开截图数据（交接包 `traces/` 提供脱敏测试会话/消息；测试账号/Token 待真实环境） | 2 |
| [ ] | H-07 | Demo 演示脚本、P0/P1 范围与成功标准 | 0 |
| [ ] | H-08 | 性能基线机器与 CPU/内存/GPU 允许范围 | 7 |
| [~] | H-09 | 日志/开发者模式策略已定默认（轮转 5MB×3、审计 30 天、开发者模式恒关、诊断导出 = 阶段 7 安全收敛/Demo P0 范围）；正式确认待产品 | 7 |

---

## 3. 阶段 0：资料、协议与工程基线（进行中）

**进入条件：** 最低开工条件已基本满足（仓库、环境、README 就绪）；后端 B/C 组 P0 输入未到位，不影响本阶段脚手架与 Mock 推进。

### 任务清单

- [x] 建立前端仓库（git init、分支 main、远程 origin、上游跟踪）——2026-08-06
- [x] 固定 Node、包管理器与工具链（fnm + Node 22.23.0 + pnpm + `.nvmrc` + `.npmrc` + pnpm-workspace.yaml）——2026-08-06
- [x] 编写 README（环境信息、命令、协作约定）——2026-08-06
- [x] 填写通信文档 02 §19 的后端对齐表（依据后端交接包 frontend-handoff-v2 批次 7：protocol-v2.md v0.6 + frontend_contract 单源包 + traces/）——2026-08-08
- [x] 初始化 `apps/desktop/` 工程（electron-vite + Vue 3 + TS + pnpm；Electron Forge 留待阶段 8）——2026-08-08
- [x] 建立前端领域类型、运行时 Schema 与公开错误模型（`shared/contracts`、`shared/schemas`、`shared/domain`、`shared/errors`）——2026-08-08
- [~] 把真实流式事件整理为可重复播放的脱敏夹具（已建 Mock 夹具 JSONL；后端真实轨迹现位于 `elysia-agent/frontend-handoff-v2/traces/ws-v2-*.jsonl`，待移植为正式夹具）
- [x] 建立 Main 中 `BackendAdapter` 接口骨架与 Mock Backend（已开发、未联调）——2026-08-08
- [x] 移植 `ref/cyrene-ui-preview-v5.html` 的设计 token 与四区布局为 Vue 组件（纯 UI 壳）——2026-08-08
- [x] 建立 `typecheck` / `lint` / `test` / `test:integration` 命令（Vitest）与最小 CI——2026-08-08
- [ ] 确认主验收平台、Live2D 资源与许可（H-01、G-01/G-02）

### 验收门槛

- [~] 全新环境按 README 能安装依赖并启动（沙箱内 dev 冒烟通过；窗口需在本机确认）
- [x] 类型检查、格式检查与最小测试命令通过（typecheck/lint/test 19 项通过）——2026-08-08
- [~] 真实事件不经 UI 组件即可映射为前端领域事件（Mock 事件经 Schema 后由 Adapter 消费；真实事件待后端提供）
- [x] Mock 能重放 Inner Voice / Public Reply 多句流（mock-replay 单测覆盖）——2026-08-08
- [x] 未确认字段集中登记在 02 对齐表（§19 + §19.1 字段差异表），无散落代码猜测——2026-08-08
- [x] 仓库中不存在明文凭据——2026-08-08

---

## 4. 阶段 1：Electron 安全骨架

**进入条件：** 阶段 0 通过；E-03 凭据所有权已确认。

### 4.0 前置决策（2026-08-08 已拍板）

| 决策 | 结论 | 依据 |
|---|---|---|
| App 身份 / userData | `app.setName('Cyrene')` → userData=`~/.config/Cyrene`；App ID 保持 `com.cyrene.desktop` | doc 12 H-03（App ID/图标/版权仍待正式确认） |
| 沙盒目录（F-06） | `userData/sandbox`，随应用数据走、0700、卸载即清理；黑名单默认值与授权级别阶段 6 细化 | 后端 security §3.2 明确路径校验属 Electron 职责 |
| 开发者模式（H-09） | **不进 P0 Demo**：生产构建恒关 DevTools、远程调试恒关、无开启路径；日志/审计脱敏仍做 | doc 07 §12、验收门槛第 6 条 |
| 凭据存储（E-03 前端落地） | Electron 侧 `safeStorage`；**不可用即拒存**（`credentialStatus=unavailable` + 提示解锁钥匙串），绝不静默明文降级 | doc 07 §11「优先使用系统安全存储」 |
| 日志/审计/诊断 | 运行日志轮转 5MB×3 份；审计保留 30 天；诊断导出 = 阶段 7 安全收敛（Demo P0 范围，导出前二次脱敏；阶段 1 块 B 只立 JSONL 机制） | doc 07 §11/§12、doc 11 设置中心 |

### 任务清单

- [x] 落地 Main / Preload / Renderer 进程边界与推荐目录结构（文档 01 §5）
- [x] 开启 Context Isolation、Renderer Sandbox、导航与新窗口限制
- [~] 让 Main 持有后端 Transport、认证凭据与原始协议解析（**凭据存储已落地**：`safeStorage` 加密 `config/credentials.json` + `credentialStatus` 4 值 IPC，Renderer 只经 IPC 见状态；真实 Token 供给/Transport 连接属阶段 2）
- [~] 建立具名、可校验的 IPC API（Preload `DesktopApi`）与公开事件订阅（取消函数）（具名 Schema 校验 IPC 与 Preload DesktopApi 已落地；公开事件订阅/取消函数属阶段 2，待后续块）
- [x] 实现窗口、单实例、外部链接拦截与应用生命周期
- [x] 建立普通设置、系统安全凭据、日志、诊断与临时目录（config/app-cache/logs/audit/temp/models/sandbox；**app-cache 避开 Chromium 的 Cache**，决策见 spec P-8）
- [x] 建立开发/测试/生产配置与最小打包流程（`__APP_MODE__` 烘焙 + `resolveAppConfig` 三 mode、生产安全默认恒关；electron-builder `dir` 未分发包 + `verify:artifact` 静态/冒烟）——2026-08-09
- [x] 落地 CSP（无 `unsafe-eval`）、受限自定义协议替代 `file://`（严格 CSP 响应头 + 保留 meta AND 取交集、`frame-src 'none'`；`cyrene://` 只读服务渲染根，打包恒走受限协议）——2026-08-09
- [x] 建立 IPC Schema 校验与非法通道/超大输入拒绝测试（zod Schema 校验机制与 executor 拒绝单测 + 块 C 集成测试：API 面白名单/4097/空串→SCHEMA_VALIDATION_FAILED/来源校验隐藏窗被拒）——2026-08-10

### 验收门槛

- [~] Renderer 无 Node、任意 IPC、系统凭据或带凭据后端直连（结构保证 sandbox/contextIsolation/不暴露 ipcRenderer + 冒烟确认普通浏览器 `window.desktopApi` 为 undefined；完整安全测试套件后续块）
- [x] 非白名单通道、非法参数与超大输入被 Main 拒绝（块 C 集成测试：desktopApi 面恰为白名单 + setBackendToken 4097/空串 → SCHEMA_VALIDATION_FAILED + 隐藏窗来源校验被拒）——2026-08-10
- [x] Token/密钥只显示状态，不能从 Renderer 读回（块 B 凭据 IPC：`credentials:get-status/set/clear` 统一返回 `{status,key}`，preload 只解包 `.status`、无明文读取通道；key 白名单单一来源 `shared/contracts/credentials.ts`）——2026-08-10
- [x] 外部链接通过受控接口打开（块 C 集成测试：window.open/location 外部 → shell.openExternal + deny 不导航）——2026-08-10
- [~] Windows 与目标 Ubuntu 开发环境各启动一次（**Ubuntu(Wayland)已冒烟通过**：Playwright `_electron` 启动构建产物，`getAppInfo` 返回 `{Cyrene, 0.1.0, linux}`、七目录 0700、四栏 UI 渲染；Windows 待验证）
- [x] 生产配置默认关闭开发者模式与 DevTools，远程调试端口始终关闭（`devToolsAllowed = !isPackaged` 恒关 + `Menu.setApplicationMenu(null)` 无加速键路径；远程调试门 main() 顶部同步拒绝显式端口/裸开关/pipe，`=0` 仅测试 harness 放行；verify:artifact 负路径冒烟验证拒绝生效）——2026-08-09

---

## 5. 阶段 2：核心聊天纵向闭环

**进入条件：** 阶段 1 通过；C-01～C-10 的 P0 项可用（暂缺则以 Mock 推进并标注“已开发、未联调”）。

### 任务清单

- [x] 连接、认证、心跳、重连与公开错误状态——2026-08-11（2B RealBackend：WS `/ws` 握手 `X-Protocol-Version:"2"`/`X-Client-Platform:electron`/Bearer、`server_info` 版本 fail-closed、心跳(pong)、断线指数退避重连 + `unexpected-response` fail-fast、`ConnectionState` 公开；**已开发、未联调**）
- [x] 会话列表、当前会话、历史第一页与基本管理——2026-08-11（2B RealBackend REST：list/get/create/rename/delete + `activateConversation`、`getConversationMessages` `_id` cursor 分页、`session` 回放缓冲归属；**已开发、未联调**）
- [x] 用户发送、乐观状态、确认与 `clientRequestId` 幂等重试——2026-08-11（2B `sendMessage` + ack 关联；2C messageStore 乐观发送 pending→acknowledged/failed + `clientMessageId` key 迁移；**已开发、未联调**）
- [x] 合并 `generation.started/segment.started/delta/segment.completed/completed/failed`——2026-08-11（2A 逻辑层：领域契约 + raw wire schema + frame-mapper + Accumulator；2C messageStore 经 `StreamAccumulator` 应用流式事件；**已开发、未联调**）
- [x] 按 `responseId` 归并有序 `AssistantSegment[]`——2026-08-11（2A Accumulator 权威 content 规则 + segmentIndex 排序；2C 渲染；**已开发、未联调**）
- [x] Inner Voice / Public Reply 全局分段顺序与独立展示（可折叠）——2026-08-11（2C CyMessageBubble 双通道渲染：inner_voice 折叠 + public_reply markdown，segmentIndex 全局排序；**已开发、未联调**）
- [x] 回复级/会话级 Token、实际模型与心情落位——2026-08-11（2A 逻辑层映射 + Accumulator 写入；2C UI chips 落位（completed 后显示）；**已开发、未联调**）
- [~] Markdown、代码块、复制、停止生成与基础断线恢复——2026-08-11（2C 已落地 Markdown 渲染（marked+消毒）、停止生成（乐观 interrupted + `generation.failed{CANCELLED}` 幂等）、断线提示（chat:state 推送 + in-flight interrupted）；**代码块复制/语法高亮与基础断线恢复 UX 属阶段 3**）
- [x] Adapter、流式累加器与 Store 的契约测试——2026-08-11（2A mapper/Accumulator/wire-fixtures 两层校验 + 2C 三 store 单测（mock desktopApi）+ IPC 链路；**已开发、未联调**）

### 验收门槛

- [ ] 使用真实后端完成“新建会话 → 发送 → 流式回复”（真实后端未通过时标“已开发、未联调”）
- [ ] 同一回复只显示一组头像、时间与操作区
- [ ] 分段完成不提前结束父回复（只有 `generation.completed` 结束）
- [ ] 重复、乱序与迟到增量不产生重复或污染
- [ ] 停止与断线保留已生成内容
- [ ] Inner Voice 缺失时不显示空区域
- [ ] UI 组件不引用后端原始字段

---

## 6. 阶段 3：完整聊天、历史与多媒体

**进入条件：** 阶段 2 通过；D-01～D-07 可用或有明确 Mock/联调日期。

### 任务清单

- [ ] 四区主布局、会话栏折叠与 Live2D 右栏预留
- [ ] 历史游标懒加载、虚拟列表与滚动锚点
- [ ] 每会话草稿、离线缓存与损坏恢复
- [ ] 点击/拖拽/粘贴共用的附件校验与待发送队列（拖拽不自动上传/发送）
- [ ] 图片、视频、音频、文件、链接与错误/过期状态
- [ ] 统一聊天历史查看器：关键词/日期/分类/分页/来源跳转
- [ ] 把原消息搜索、绘画资源与会话媒体统一到历史查看器
- [ ] Emoji、表情包清单、最近使用、发送引用与历史分类
- [ ] 键盘、焦点、中文输入法与基础可访问性
- [ ] 落地 1200 / 736 / 520 / 320 响应式规则

### 验收门槛

- [ ] 1100×700 可用，窄窗口无 Live2D 覆盖聊天
- [ ] 历史懒加载不改变当前可视锚点
- [ ] 切换会话不丢草稿与合理滚动位置
- [ ] 拖拽附件只进入待发送队列，不自动上传或发送
- [ ] 图片/视频/音频可预览/播放，失败状态可解释
- [ ] 历史查看器可组合查询并跳回来源消息/分段
- [ ] Emoji 与表情包不自动发送
- [ ] 主要操作可通过键盘完成

---

## 7. 阶段 4：模型服务与语音

**进入条件：** 阶段 2 通过；E-01～E-08 已确认。

### 任务清单

- [ ] LLM/STT/TTS 三类内置与自定义 Profile
- [ ] Profile 新增、编辑、复制、删除保护、类型化测试与切换
- [ ] 后端/Main/Local Worker 凭据所有权与一次性提交（密钥不回显）
- [ ] 普通录音输入、待发送音频、试听与删除
- [ ] 实时语音会话、字幕、VAD、断句、语音轮次与停止
- [ ] TTS 试听、播放、取消与完成状态
- [ ] 输入法转写专用 STT Profile、按住/松开/取消与草稿插入
- [ ] Backend/本机/Local Worker 模型执行位置与数据去向提示

### 验收门槛

- [ ] 三类 Profile 可读取、测试与切换；输入法转写可独立选择兼容 STT Profile
- [ ] 三类自定义 Profile 可安全创建/编辑/删除，密钥不回显
- [ ] 普通录音停止后只生成待发送语音输入，不自动发送
- [ ] 实时语音字幕不写入文字草稿
- [ ] 输入法转写只把最终文字插入草稿，不创建语音消息、不自动发送
- [ ] 未经确认不会把本机音频回退上传到后端
- [ ] 切换 Profile 只影响新请求，不破坏当前生成/转写/播放

---

## 8. 阶段 5：Live2D

**进入条件：** 阶段 2 通过；G-01～G-05 已确认并取得合法资源。

### 任务清单

- [ ] `Live2DController`、SDK Adapter 与资源 Manifest
- [ ] 至少两个合法模型配置的加载、卸载与原子切换
- [ ] 聊天右侧布局列、缩放、偏移与响应式折叠（不覆盖聊天）
- [ ] idle/listening/thinking/speaking/waiting_permission 状态映射
- [ ] 待机、眨眼、呼吸、鼠标跟随、动作与表情优先级
- [ ] TTS 实际音频的音量口型
- [ ] 暂停、降帧、GPU 上下文恢复与静态头像降级
- [ ] 设置持久化与许可/资源完整性检查（`integrity.json` SHA-256）

### 验收门槛

- [ ] 两个已安装模型可加载与切换；切换失败保留当前模型与聊天状态
- [ ] 角色栏作为右侧布局列展开，不覆盖消息或输入区
- [ ] 非白名单动作、参数与资源路径被拒绝
- [ ] 隐藏后停止高频渲染
- [ ] GPU/资源异常不影响聊天与权限操作

---

## 9. 阶段 6：工具、权限与 Desktop P0 能力

**进入条件：** 阶段 1 与阶段 2 通过；F-01～F-10 已确认。

### 任务清单

- [ ] Tool Store、工具卡片、统一状态机与公开错误
- [ ] Backend / Desktop / Local Worker Runtime 区分
- [ ] Desktop 静态注册表、版本、Schema 与本地风险重算
- [ ] `callId` 幂等、取消、超时与结果重传
- [ ] 权限窗口、沙盒、路径/域名黑名单、范围授权与撤销
- [ ] 审批历史、已授权命令模板/目录与空状态
- [ ] `desktop.file.select` 与受控资源句柄
- [ ] `desktop.file.read` 的类型、大小、路径与内容返回
- [ ] `desktop.file.write` 的 Diff、写前哈希、原子替换与冲突保护
- [ ] `desktop.screen.capture` 的系统选择、预览、上传确认与清理
- [ ] 可选 `desktop.command.run` 仅在范围明确确认后注册（当前不注册）

### 验收门槛

- [ ] Backend 工具只展示，不会在客户端误执行
- [ ] Desktop 工具只通过 Main 与本地注册表执行
- [ ] 四个 Desktop P0 工具 ID 完成真实后端闭环（Mock 阶段标“已开发、未联调”）
- [ ] 未注册、未知 Runtime、版本不兼容与非法参数均安全失败
- [ ] 黑名单优先于沙盒与历史授权
- [ ] 相同 `callId` 不重复弹窗或产生副作用
- [ ] 用户拒绝/关闭/超时后不执行；文件冲突不覆盖；截图不静默采集或上传
- [ ] 命令执行未确认时不注册；启用时也不能接收任意 Shell 字符串
- [ ] 审计与日志不含完整敏感内容

---

## 10. 阶段 7：安全、稳定性与性能收敛

**进入条件：** 阶段 3～6 的 Demo 范围功能完成。

### 任务清单

- [ ] Markdown/XSS、危险链接、CSP、导航与媒体来源测试
- [ ] IPC 攻击面、超大输入与来源窗口校验
- [ ] 路径穿越、符号链接、重放与授权后参数变化测试
- [ ] Token、模型密钥、聊天正文、Inner Voice、录音与本地数据泄漏扫描
- [ ] 直接语音字幕与文字草稿隔离测试
- [ ] 网络中断、Renderer 崩溃、缓存损坏与 GPU 上下文恢复
- [ ] 长会话、长流式、历史资源列表与 Live2D 性能测试
- [ ] 日志轮转、缓存上限、临时附件与录音清理
- [ ] 集中修复 Blocker、Critical 与主要回归问题

### 验收门槛

- [ ] Blocker / Critical 为 0；安全发布清单通过
- [ ] 200 条混合消息、100 个多分段回复、500 项历史资源操作正常
- [ ] 长时间运行无明显持续内存增长
- [ ] Live2D 关闭后 CPU/GPU 使用明显下降
- [ ] 日志与诊断导出通过敏感信息扫描
- [ ] 主链路异常可恢复或安全失败

---

## 11. 阶段 8：打包、跨平台与 Demo 验收

**进入条件：** 阶段 7 通过；H-03～H-09 发布相关项已确认。

### 任务清单

- [ ] Windows 安装包与 Ubuntu 主安装产物（Electron Forge）
- [ ] 安装、首次启动、升级、卸载与重装测试
- [ ] 产物秘密、开发配置、Source Map 与未授权资源扫描
- [ ] Windows/Ubuntu 实机链路与 Wayland 范围测试
- [ ] 完整 Demo 演示脚本
- [ ] 版本、提交、依赖、协议与资源清单
- [ ] 发布说明、校验和、已知问题与回滚/重装方案

### 验收门槛

- [ ] Windows 主验收环境完整通过
- [ ] Ubuntu 目标环境至少完成一次全链路
- [ ] 生产包默认关闭开发者模式与 DevTools，远程调试端口始终关闭
- [ ] 安装包不包含测试密钥、敏感事件样例或未授权模型
- [ ] Demo 脚本连续执行两次结果一致
- [ ] 版本、提交、协议与资源哈希可追溯
- [ ] 已知问题与回滚/重装方式已记录

---

## 12. 全阶段统一完成定义（Definition of Done）

任何任务只有在同时满足以下条件时才可标记完成：

- 代码实现并通过类型检查与格式检查；
- 外部数据具有运行时 Schema；
- 正常、失败、取消、拒绝与超时路径按适用范围处理；
- 核心纯逻辑具有单元测试；
- 跨 Main/Preload/Renderer 或 BackendAdapter 的功能具有集成测试；
- 用户可见主流程具有 E2E 或人工验收记录；
- 不包含明文凭据、未脱敏日志或未授权资源；
- 相关文档与协议对齐表同步更新；
- 已知限制与剩余风险被显式记录；
- 真实后端未联调时，状态只能标记为“已开发、未联调”。

---

## 13. 变更记录

| 日期 | 变更 | 状态 |
|---|---|---|
| 2026-08-06 | 创建本文；标记阶段 0 已完成项（仓库、环境、README）与待办项 | 进行中 |
| 2026-08-08 | 阶段 0 工程推进：`apps/desktop/` 脚手架、领域契约、BackendAdapter 骨架 + Mock、设计 token 与四区 UI 壳、Vitest 单测与 CI 全部落地并通过验证；标注“已开发、未联调” | 进行中 |
| 2026-08-08 | 依据后端交接包 frontend-handoff-v2 批次 7 填写 doc 02 §19 对齐表 + §19.1 字段差异桥接表；勾选阶段 0 对齐表相关项 | 进行中 |
| 2026-08-08 | §2 输入清单逐行标注：契约已确认项标 `[~]`（B-02~B-06/B-08、C-01~C-09、E-01~E-06/E-08、F-01~F-05、G-04），A-01/A-04 勾 `[x]`；仍缺项列表补全；头部状态更新 | 进行中 |
| 2026-08-08 | 深读后端批次 0-8c 全部进度/审计文档后复核：**D-01~D-08、F-08、H-03/H-06 升级为 `[~]`**（后端批次 3/7 契约已覆盖）；剩余 `[ ]` 明确标注性质——前端本地授权/沙盒/审计设计（F-06 后端 security §3.2 明确属 Electron 职责）与外部资源/产品决策（G-01/G-02 Live2D、H-01/H-04 平台/签名） | 进行中 |
| 2026-08-08 | **阶段 1 前置决策拍板**（§4.0）：App 身份 Cyrene/com.cyrene.desktop、沙盒 `userData/sandbox`、开发者模式不进 P0 恒关、凭据 safeStorage 不可用即拒存、日志 5MB×3/审计 30 天/诊断导出进 P0；F-06/H-09 升级 `[~]` | 进行中 |
| 2026-08-09 | 阶段 1 第一块落地：9 子目录、installAppIdentity + userData 七目录、IPC 骨架（app:get-info） | 已开发、未联调 |
| 2026-08-09 | **GUI 冒烟自动验证通过**（Playwright `_electron` + vision MCP）：Ubuntu(Wayland) 启动构建产物，七目录 0700、`getAppInfo`→`{Cyrene,0.1.0,linux}`、四栏 UI 渲染正常、普通浏览器 `desktopApi` undefined（信任边界）；验收门槛 2 项升 `[~]` | 已开发、未联调 |
| 2026-08-09 | **阶段 1 块 A（安全加载与环境基线）落地并全量验证**：`cyrene://` 受限协议替代 `file://`、严格 CSP（响应头 AND 保留 meta、`frame-src 'none'`）、dev/test/prod 环境（`__APP_MODE__` 烘焙）与生产安全默认（DevTools 恒关 + 远程调试门）、electron-builder 未分发包 + `verify:artifact`（静态 + 冒烟 16/17 项，负路径验证调试门）；勾选 §4 任务 ③④ 与验收门槛「生产恒关/远程调试恒关」 | 进行中 |
| 2026-08-10 | **阶段 1 块 B（主进程受信服务）落地并全量验证**：凭据存储（`safeStorage` 封装 + 版本化 `config/credentials.json` 0600/原子写/每 key 加密块 + `credentialStatus` 4 值 IPC + key 白名单单一来源）+ 日志/审计（手写 JSONL logger 无 msg 参数/落盘双净化、append-only 审计按日 + 30 天清理、共享 file-writer rotate 5MB×3）+ 装配（before-quit allowQuit 防挂死 flush、生命周期日志）；182 单测全绿 + typecheck/lint/build 通过；勾选验收门槛「Token/密钥只显示状态」；诊断导出措辞同步为「阶段 7 安全收敛（Demo P0 范围）」（B-1） | 已开发、未联调 |
| 2026-08-10 | **阶段 1 块 C（IPC/协议安全集成测试）落地**：Playwright _electron 集成套件（协议 handler F1 403/404/逃逸/200+CSP、IPC API 面/超大输入/来源校验、外部链接受控、普通浏览器信任边界）+ test:integration(--mode test 构建) + CI xvfb-run | 已开发、未联调 |
| 2026-08-11 | **阶段 2 块 A（领域契约修复 + raw wire 层）落地**：领域事件扩展（`GenerationSegmentStartedEvent`、`SegmentCompleted.kind/content`、Token 结构 `usage.rounds`/`ConversationTokenUsage`、`ProtocolWarning`）+ raw-types/raw-schemas（判别 `type` + strict，zod 4.4.3 双参 record）+ frame-mapper（status 过滤/fail-closed/告警）+ StreamAccumulator 权威 content 规则（docs/18 §4.3 七条）+ fixture 分离（`domain/` 领域 + `wire-v2/` raw wire + manifest 锚定 `beeba577`）+ wire-fixtures 两层校验；231 单测全绿 + typecheck/lint/build；spec/plan 见 superpowers 目录 | 已开发、未联调 |
| 2026-08-11 | **阶段 2 块 B（RealBackend REST/WS v2 Adapter）落地**：`ws` 依赖 + REST wire 层（rest-types/rest-schemas 混合命名 + strict）+ rest-mapper（`Message.tool?` 元数据、`_id` cursor 分页、回放项 mood→emotion）+ raw 层扩展 `user_message.ack`/`error` + `BackendAdapter` 接口扩展（`getConversationMessages`/`activateConversation`/`renameConversation`）+ `RealBackend`（握手 header 精确/`server_info` 版本 fail-closed/session 回放缓冲/ack 关联 15s 超时/重连退避 + unexpected-response fail-fast/REST 会话·历史·激活 + Bearer + 错误映射）；告警码收编 `ProtocolWarningCode`；265 单测全绿 + typecheck/lint/build；spec/plan 见 superpowers 目录 | 已开发、未联调 |
| 2026-08-11 | **阶段 2 块 C（Store + IPC 事件推送 + 聊天 UI 纵向闭环）落地**：`chat-service` + `chat:event/state/replay` 推送通道 + chat 命令（IpcResult 信封 + schema）+ `desktopApi` chat 面（unwrap + 订阅守卫 + 取消函数）+ Pinia 三 store（connection/conversation/message，messageStore 经 `StreamAccumulator` 流式应用 + 乐观发送 + 断线 interrupted）+ UI 动态化（`CyMarkdown`（marked+消毒 entity 加固）/`CyMessageBubble` 双通道折叠/chips/`CyChatInput` IME 守卫/`CyChatView` 空态·断线横幅·连接控件/`CyConversationList` 列表操作）；对 2B 加性修改（`ConnectionState` 迁 shared、`getConnectionState`、`onConnectionStateChange`、`MessageStatus.completing`）；312 单测全绿 + typecheck/lint/build；「发送 → 流式 → 渲染」链路打通（Mock 驱动）；spec/plan 见 superpowers 目录 | 已开发、未联调 |
| 2026-08-11 | **阶段 2 批次收尾（最终 review 修复闭环 + 批次报告）**：2B F1-F7、2C P1-1~3+P2 全部修复；315 单测 + typecheck/lint/build 全绿；批次最终报告见 `docs/superpowers/2026-08-11-phase2-batch-final-report.md`；阶段 2 三块全部完成，下一步阶段 3（或先 B-01 联调） | 已开发、未联调 |
| 2026-08-11 | **CI 首次跑修复（阶段 2 后第一推）**：`.github/workflows/ci.yml` 集成测试全红，两个独立根因——① electron 43 无 postinstall + 集成测试 helper 硬编码 `dist` 路径（不走 `require('electron')` 懒下载）→ CI 全新环境二进制缺失（`spawn electron ENOENT`），修复 `ensure:electron` 脚本 + CI install 后步骤；② `sandbox: true` preload 被 electron-vite 外部化 zod → 产物 `require("zod")` 沙箱运行时报错 → contextBridge 中断 `window.desktopApi` undefined，修复 `externalizeDepsPlugin({ exclude: ['zod'] })`；本地 18 集成测试全绿复验；坑与排查要点见 doc 17 §4/§10 P-12/P-13/§16 | 已开发、未联调 |
| 2026-08-11 | **CI 修复 v2（ensure 脚本布局 + 缓存 + job 拆分）**：① `ensure:electron` 由 `node node_modules/electron/install.js` 改为 `node -e "require('electron')"`——pnpm hoisted 干净 install 不创建 workspace 子包 `node_modules`（本地该目录是历史残留），相对路径脚本在 CI 报 `MODULE_NOT_FOUND`（P-14）；② CI 拆 3 个独立 job（check=typecheck+lint / unit / integration），integration 加 `actions/cache` 缓存 `~/.cache/electron`（key 锚定 `pnpm-lock.yaml`）；本地复验 18 集成 + 315 单测 + typecheck + lint 全绿 | 已开发、未联调 |
| 2026-08-11 | **CI 修复 v3（helper electron 路径定位）**：v2 后 ensure 用对路径（`require('electron')` 解析到根 hoisted 区下载成功），但 launch 仍 ENOENT——测试 helper（`tests/integration/helpers/app.ts`）硬编码 `join(ROOT,'node_modules/electron/dist/…')`，干净布局下 `apps/desktop/node_modules` 整个不存在；改为 `require.resolve('electron')` + `dirname` 定位包再拼 `dist/<exe>`；本地模拟 CI 布局（mv 子包 node_modules）18 集成全绿复验 | 已开发、未联调 |
| 2026-08-12 | **阶段 2 真实联调整改·批次 A（连接凭据安全 / 真实模式装配 / rejected ACK）落地**：FE-P0-01 Main 规范化 Endpoint + Token-Origin 绑定（`connection-config` 纯逻辑 + 注入 CredentialStore 端口；URL 规范化 https/回环 http/拒绝 userinfo·query·fragment/path 前缀；origin 变化自动清 token 绑定；`connect` 无参三步校验）+ FE-P1-02 装配策略（`resolveBackendMode`：打包恒 Real、未打包默认 Real + `CYRENE_BACKEND=mock` 显式 Mock）+ `CyConnectionPanel` 连接设置 UI（REAL/MOCK 标识、Endpoint/Token 设置、token 密码框提交清空）+ FE-P1-01 rejected ACK 即时结构化（`RawUserAckSchema` superRefine + `handleAck` `BACKEND_REJECTED`/backendCode/retryable + 错误 message 前缀跨桥 + `parsePublicError` 反解）；集成测试（白名单 18→21 键、凭据先设 endpoint、attacker 不泄漏 token、`getRuntimeInfo`、`launchApp` 固定 mock）；**360 单测 + 20 集成 + typecheck/lint/build 全绿**；仍标「已开发、未联调」；spec/plan 见 `docs/superpowers/specs|plans/2026-08-11-phase2-realconn-preparation-*` | 已开发、未联调 |
| 2026-08-12 | **阶段 2 真实联调整改·批次 B（真实连接编排：连接后会话初始化 / 会话守卫 / 错误链 / 超时门控）落地**：FE-P1-03 连接后会话初始化（renderer 编排 `onConnected` 幂等 + 首次/重连分支 + `pendingReplay` 纯缓冲 + `onActiveConversationAppeared` 活动会话晚到补激活 + `ready` 就绪门控）+ FE-P1-04 conversation/epoch 守卫（`generationByConversation` 归属表（仅 started 带 conversationId、中间事件查表）+ `activate` epoch 大者胜 + `migrateKey` 竞态守卫 + 断线清理 local-* 乐观消息）+ FE-P1-05 错误链（`onProtocolWarning`→脱敏日志（固定 code+sanitize+mode+build）+ `onError`→logger+`chat:error` 推送 + `connectionStore.error` 结构化展示（连接失败保持 error 态）+ 429 走重连退避不新增领域码）+ FE-P2-01 超时/门控（握手 10s/REST 10s（可注入）+ disconnect abort→`NOT_CONNECTED` + `setEndpoint` 联动断开 + `canSend`/会话管理 `connected&&ready` 门控 + `busy` 防重复）；门控 computed 为组件逻辑无单测，验收以集成断言/人工兜底（M5）；**399 单测 + 22 集成 + typecheck/lint/build 全绿**；仍标「已开发、未联调」；spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase2-realconn-batchB-*` | 已开发、未联调 |
