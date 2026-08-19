# 阶段 6（工具、权限与 Desktop P0）批次 B：Main 工具服务/权限/四执行器/UI（F-6-07~18 + F-6-22/24 + 承载项）

**日期：** 2026-08-20（Asia/Shanghai）
**状态：** binding spec（批次 B）
**依据：** 预检拍板（2026-08-20，F-06/F-07/F-09/F-10 四项 AskUserQuestion 拍板 + D-§7-4/§7-5 推荐定案）+ 工具双轨统筹决策记录（2026-08-19）+ 批次 A spec（raw/领域四件套 + `ToolCallRecord` + 归档配对，`docs/superpowers/specs/2026-08-20-phase6-tools-batcha-contract-domain-design.md`）+ doc 04（Desktop 工具与权限交互设计 v0.2）+ doc 07（安全设计 v0.2）

---

## 0. 决策集合（本批定案，预检已拍板；最终报告汇报）

| # | 决策 | 定案 |
|---|---|---|
| **D6B-01** | **批次边界**：批次 B = F-6-07~18（Main 工具注册表/服务/四执行器/状态发送/审计 + Preload IPC 面 + toolStore/卡片/权限窗/聊天接线/Live2D）+ F-6-22（mock 桌面流改接真实 tool-service 入口）+ F-6-24（集成测试）+ 承载项（R-A3 `error:''` 加固、`MessageSchema` 补 `toolCalls`、jsdiff 依赖）。批次 C = 真实 Windows Electron 联调 + allow_scoped/授权管理页/命令模板空态 + `GET /api/tools/calls/{callId}` 状态查询 + action 兼容帧移除评估 + 跨页/跨会话配对复核 | 决策记录 §5 批次划分；F-06/F-07/F-09/F-10 本批拍板落地 |
| **D6B-02** | **F-06 沙盒/黑名单默认值（拍板：仅黑名单、零预授权）**：`sandboxDirectories` 恒空（本批不产出任何预授权目录，`SecurityPolicy` 沙盒段全空）；**路径黑名单默认集**（常量 `PATH_BLACKLIST_DEFAULTS`，规范化前缀匹配，含子目录）：Linux `/etc /usr /bin /sbin /boot /lib /lib64 /proc /sys /dev /root /run /var /lost+found /snap /opt /tmp` 排除（/tmp 与测试 fixture 冲突，**不放黑名单**）、用户敏感目录 `~/.ssh ~/.config ~/.gnupg ~/.password-store ~/.aws ~/.npm ~/.cache ~/.local/state ~/.local/share/keyrings ~/.mozilla ~/.git-credentials`（精确+前缀）；Windows `C:\Windows C:\Program Files C:\Program Files (x86) C:\ProgramData C:\System Volume Information C:\$Recycle.Bin %USERPROFILE%\.ssh` 等、设备路径 `\\.\`、UNC 网络共享默认拒（未经授权）。**域名黑名单** = 上传/连接仅限已连接后端端点（`ConnectionConfig` baseUrl；无其它默认域名）。黑名单永远压过一切（doc 04 §7.4 决策优先级第 2 层） | 预检拍板 F-06；安全默认走常量（对齐附件限额常量先例 `shared/contracts/attachments.ts:68-70`，不进 settings.json——D6B-14） |
| **D6B-03** | **F-07 授权级别（拍板：仅一次/拒绝最小闭环）**：四工具映射 `desktop.file.select`=safe/**automatic**（用户主动选择即授权）、`desktop.file.read`=medium/**每次确认 + 最近选择豁免**、`desktop.file.write`=high/**强确认**、`desktop.screen.capture`=high/**强确认**；`PermissionDecision` 只产出 `allow_once/deny` 两值（`grantScope` 字段类型保留不产出）；**allow_scoped（目录授权+有效期）与设置页授权管理/命令模板空态归批次 C**（F-07 拍板）。「最近选择豁免」= read 的 path 命中 tool-service `selected-set`（D6B-20）→ 免弹窗自动执行（用户刚主动选过该文件，doc 04 §8.2「只读取用户选择或明确授权的文本文件」的授权语义）；未命中 → 每次确认 | 预检拍板 F-07；doc 04 §7.1 风险表 + §7.2 决策结构 |
| **D6B-04** | **F-09 写 Diff（拍板：引成熟 diff 库）**：采用 **jsdiff（npm `diff`，锁定 ^9.0.0，自带 TS 类型，纯算法无 DOM/无 CSP 顾虑，经 vite 打包为 self 资源）**；行级 `diffLines` 主 Diff + 词级 `diffWords` 仅用于「仅内容差异行」标注；Diff 内嵌权限窗，**首 100 行 + 截断提示**（「共 X 行，仅显示前 100 行」）；**编码/BOM/换行风格差异用元信息标注条**（如「将按原文件格式写入：UTF-8 无 BOM / LF」）不渲染复杂转换（D6B-19）；不引任何高亮库（阶段 3 G2 纪律不破） | 预检拍板 F-09；doc 04 §8.3 |
| **D6B-05** | **F-10 截图平台（拍板：Win + X11，Wayland 明确降级）**：主进程 `desktopCapturer`（Windows/Ubuntu X11 可用）枚举 screen/window → Renderer 缩略图 grid 选择 → 预览 → 确认上传（**两步确认**：授权确认 + 上传确认，doc 04 §8.4）；Wayland 检测（`process.env.XDG_SESSION_TYPE === 'wayland'` 或 `WAYLAND_DISPLAY` 存在且非 X11）→ **授权前直接 `CAPTURE_UNAVAILABLE` 错误**（「当前桌面环境不支持屏幕捕获」明确提示，不静默失败）；缩略图/预览经 data URL 下发（生产 CSP `img-src 'self' data:` 已允许，无需媒体代理）；上传字节只存在于 Main | 预检拍板 F-10；本批引入 desktopCapturer（当前全仓零使用） |
| **D6B-06** | **D-§7-4 `file.read` 大结果回传（推荐定案）**：`FILE_READ_MAX_BYTES = 2 MiB` 常量（超限 → `FILE_TOO_LARGE` 错误拒绝，不截断内容）；内容 ≤ `RESULT_INLINE_BYTES = 64 KiB` → 内联 `tool.status.output`（LLM 直接读）；> 64 KiB → **附件上传**（`POST /api/uploads/desktop/{callId}`，`X-Client-Connection: <connectionId>`，real 路径）回填 `attachments[]` + `outputSummary` 前 2000 字符截断 + `truncated=true`；二进制检测（NUL 字节比例）→ `FILE_IS_BINARY` 错误（doc 04 §8.2「只读取文本文件」） | 决策记录 §6 D-§7-4；doc 02 §10.3「超大内容用附件不塞 result」 |
| **D6B-07** | **D-§7-5 `action` 兼容帧保留期（推荐定案）**：**保留至阶段 8 打包前**（现状：批次 A 已建模「已知忽略」不告警；本批不新增处理，不评估移除） | 决策记录 §6 D-§7-5 |
| **D6B-08** | **Desktop 工具状态单一来源 = Main tool-service**：`tool.request` 生命周期（幂等/风险/决策/执行/终态）全由 Main `tool-service` 持有；状态变化经新 IPC 推送通道 `tool:event`（`PublicToolEvent`）→ Renderer toolStore；**Renderer 不再经 chat:event 管线收 desktop `tool.request`**（real 路径 `handleFrame` 加显式 `case 'tool.request'`：FrameMapper 校验+脱敏产出仍存在——mapper 纯函数不变、批次 A 单测保留——但 real-backend 不再把它 emit 给 renderer，改路由 tool-service，raw `arguments/paramHash` 只在 Main）；Backend 展示事件（`tool.started/tool.completed`）仍走既有 `chat:event` 管线（batch A 现状不动）→ bootstrap 旁路 toolStore | F-6-11（handleFrame 显式 case）+ F-6-13（tool:event 通道）；doc 04 §6.3 PublicToolEvent 落地为领域形状 |
| **D6B-09** | **`tool:event` 载荷 = `PublicToolEvent`（领域公开形状）**：`{ id（=sourceCallId）, desktopCallId?, toolName, title, runtime:'desktop', status: ToolCallStatus, reason?, inputSummary?, resultSummary?, error?{code?,message?}, truncated?, durationMs?, startedAt?, finishedAt?, occurredAt }`——**无 arguments/无路径/无 paramHash/无 expiresAt/无安全元数据**（D6-07）；`title`/`dataFlowNote` 来自 Main 注册表（Renderer 无注册表）；`expiresAt` 只存 Main（超时定时器用） | doc 04 §6.3 细化；D6-07 |
| **D6B-10** | **IPC 面（F-6-13/14）**：`IpcChannels` 新增 `tool:event`（Main→Renderer 推送，webContents.send + preload `onToolEvent`）、`tool:decide`、`tool:cancel`、`tool:list`（Renderer→Main invoke）；**zod 双端校验**（`PublicToolEventSchema`/`PermissionDecisionSchema`/`toolCancelSchema`/`toolListResponseSchema`），失败 `SCHEMA_VALIDATION_FAILED` 结构化错误；`registerHandler`/`isTrustedSender` 纪律沿用（registry.ts）；`tool:pick-source`/`tool:confirm-upload` 两条 capture 交互通道并入（D6B-16）；禁止任何 `invoke(channel)` 式通用通道 | F-6-13/14；doc 04 §6 禁止接口清单 |
| **D6B-11** | **重连语义**：tool-service 内存幂等记录跨短时重连保留；重连后——① 未确认**终态**（result/error/rejected/cancelled 已回传但连接断开）→ 重连成功后**重发** `tool.status`（幂等，后端按 callId 去重）；② **非终态**（awaiting_permission/running）→ 保持展示状态不重投执行、不重弹权限窗（权限窗关闭即拒绝，doc 07 §10）；③ 断线时执行中调用 → 安全收尾（写操作原子完成/失败保持原文件；截图取消清理）；④ `GET /api/tools/calls/{callId}` 服务端状态查询**本批不做**（mock 无端点，归批次 C 真实联调） | doc 02 §16.2 + doc 04 §15（记录为本批决策，批次 C 复核） |
| **D6B-12** | **R-A3 承载加固**：`error.message === ''`（空串）统一视为缺省——`pairToolCalls` 与 tool-service 错误归一化处同口径（`undefined` 而非空串），新增单测 | 批次 A Task5 review 挂起项 |
| **D6B-13** | **Live2D `waiting_permission` 接线**（F-6-18）：`live2d/state-source.ts` 增 `toolWaiting` 读值 getter（`useToolStore().waitingForApproval`，对齐 `isGenerating` 形状 live2d.store.ts:145）+ `composeCharacterState` 在 error 判定后插 `waiting_permission` 规则（优先级 3 同 error 级，state-source.ts:90-105）；`isTransient` 补 `waiting_permission`（state-source.ts:83-85）但**不设 N1 超时 timer**——回退由事件驱动（toolStore 授权状态消失 → recompose → 状态机 `returnToBusiness`，state-machine.ts:166-174）；`waiting_permission` 不打断 thinking/speaking（3 级低于 2 级？——**对齐既有优先级表：3 级高于 2 级会打断 speaking**，违反「不打断」；本批裁决：`composeCharacterState` 规则条件 `!isGenerating && !isSpeaking && toolWaiting`（thinking/speaking 优先，与 doc 05「不打断说话」一致） | F-6-18；阶段 5 state-source/state-machine 槽位完备（注释明示阶段 6 驱动） |
| **D6B-14** | **设置面本批不动**：工具安全默认值全部走常量（D6B-02/06），不进 settings.json；「安全与权限」设置子页保持占位（CySettingsView 现有 placeholder，note='阶段6'），授权历史/撤销归批次 C（F-07 拍板） | F-07 最小闭环 |
| **D6B-15** | **mock 改接（F-6-22 批次 B 部分）**：`MockBackendOptions` 增 `toolRequestSink?: (req: DesktopToolRequest) => void`（对齐 `ttsAudioSink` 回调先例 mock-backend.ts:271-273，index.ts:170 接线打破环引用）；mock desktop kind **不再直接 `this.emit(ToolRequestEvent)`**，改构造 `DesktopToolRequest`（arguments 来自 mock 配置——批次 A R-A5 已存配置）经 sink 交 tool-service 统一入口；`submitToolResult` 保持 mock 侧实现（tool-status-sender 经 `BackendAdapter.submitToolResult` 统一发送：real → WS 帧，mock → 记录+终态归档，batch A 已实装）；`BackendAdapter` 增 `uploadToolAttachment`（real → `POST /api/uploads/desktop/{callId}` + `X-Client-Connection`；mock → 返回 `mock://tool-attachment/{callId}` 占位 URL 不上传，集成测试断言附件元数据不渲染预览） | F-6-22；R-A5 承接 |
| **D6B-16** | **截图交互三步**（doc 04 §8.4 每次用户选择+预览+确认上传）：授权确认（权限窗）→ 源选择（缩略图 grid，`tool:event` 携带 `captureSources` 变体或独立推送 → `tool:pick-source` 回传）→ 预览 + 上传确认（`tool:confirm-upload`）；上传由 Main 直接发字节（renderer 只见 data URL 预览）；临时图像完成/取消后清理 | F-6-10/17；doc 04 §8.4 |
| **D6B-17** | **卡片双区渲染**：**实时区** `CyLiveToolCards`（CyChatView 消息列表与输入区之间，数据驱动 toolStore 当前会话记录，上限 3 条，`generation.started` 清空——易失视图，D6-04）；**归档区** 在 `CyMessageBubble` assistant 分支 `.cy-response-cluster` 内按 `message.toolCalls` 渲染只读卡片（历史/回放持久权威）；backend 卡片实时+归档都只读无授权入口；desktop 卡片在 `awaiting_permission` 状态才出权限入口 | 预检决策①完成即出卡片 + ③独立 toolStore；F-6-18 |
| **D6B-18** | **审计（F-6-12）**：走既有 audit 闭包（fail-open，audit.ts:33-56，`AuditEvent` 已预留 `toolId/callId/status/durationMs` 字段）；新事件类型 `tool:request-received` / `tool:decision` / `tool:executing` / `tool:status-sent` / `tool:terminal`（含 rejected/cancelled/timeout/failed）；`runtime` 字段区分 desktop（Main 完整记录）/ backend（仅记收到的公开事件 + summary 注记「客户端公开事件，非后端完整审计」，doc 04 §14 数据完整性范围）；**不落**文件内容/截图/token/未脱敏参数（redactToolArguments 复用） | F-6-12；doc 04 §14；doc 07 §12 |
| **D6B-19** | **写文件格式保留**：写时自动适配旧文件格式——BOM（UTF-8 BOM 保留/移除？→ **原样保留**）、换行（CRLF/LF 按旧文件计数判定）、末尾换行（旧文件以换行结尾 → 补齐）；无法无损解码（二进制/不可用编码）→ 拒绝按文本覆盖（doc 04 §8.3）；新文件 → UTF-8 无 BOM + LF + 内容原样；所有格式决策在确认窗元信息条如实标注（「将按原文件格式写入：UTF-8 / LF / 末尾换行将补齐」），不发生静默转换 | doc 04 §8.3 |
| **D6B-20** | **selected-set 豁免**：`file.select` 成功后把规范化路径记入 tool-service `selected-set`（`Map<path, selectedAt>`）；**TTL 10 分钟 + 本次连接会话**（常量 `SELECT_EXEMPT_TTL_MS = 10*60*1000`）；read 命中 → 免确认执行；`file.select` 取消选择**不是错误**——result `{cancelled:true}`（LLM 可感知，不走 error 态） | doc 04 §8.1/§8.2 |
| **D6B-21** | **desktop/backend 同 id 合并**：desktop 工具执行期间后端 `tool.completed`（`callId=sourceCallId`，D6-03 同值）按 id 到 toolStore——**本地记录存在 → 以本地状态机裁决为准**（D6-06，只读后端确认信息不覆盖本地终态）；本地不存在（纯 backend 工具）→ 新建只读记录 | D6-06 |

**范围外（本批明确不做）**：allow_scoped 授权 UI/有效期/设置页授权管理/命令模板空态（F-07 拍板归批次 C）；`GET /api/tools/calls/{callId}` 状态查询；真实 Windows Electron 联调；`desktop.command.run` 注册（全阶段不注册）；local_worker 工具注册（无 Worker）；设置页「安全与权限」子页落地；`action` 移除评估；跨页/跨会话归档配对（批次 C 查看器按上下文重配对）。

---

## 1. 目标

批次 B（Main 工具服务/权限/四执行器/UI）目标（一个验收句）：**四个 Desktop P0 工具（`desktop.file.select/read/write` + `desktop.screen.capture`）经静态注册表 → Main tool-service 全生命周期（幂等/本地风险重算/黑名单优先/授权决策/状态机/审计）→ 四执行器安全执行（路径黑名单/符号链接/大小上限/写前哈希+Diff+原子替换/截图两步确认）→ tool-status-sender 经 `tool.status` 六态回传（附件走 `POST /api/uploads/desktop/{callId}`）；Renderer 经 `tool:event` 推送 + 既有 chat:event 管线归一化到 `toolStore`（`ToolCallRecord` 权威键 `sourceCallId`），CyToolCard/CyToolApproval 权限窗（拒绝按钮对等、无倒计时、四问）+ 聊天实时区/归档区双区渲染 + Live2D `waiting_permission` 真实驱动；mock desktop 流改接真实 tool-service 入口；全部门禁（单测/集成/typecheck/lint/build/check:contract）绿。**

拆解为可验证子目标：

1. tool-registry 静态注册表（四工具 name/version/runtime/title/description/localRisk/permissionMode/inputSchema/outputSchema/executorRef + dataFlowNote）+ `PATH_BLACKLIST_DEFAULTS` 路径黑名单 + 域名黑名单（仅已连接端点）落地；未知名称/版本/运行时拒绝；
2. tool-service：`DesktopToolRequest` 入口 → 注册表 → 参数 schema → callId 幂等 → paramHash 校验（real 有值才验）→ 路径规范化+黑名单 → 本地风险重算 → selected-set 豁免/授权决策 → 执行/拒绝/取消/超时；状态机 8 态单向前进；expiresAt 超时 → timeout 展示 + wire cancelled；终态不重回执行；断线重连重发未确认终态；
3. 四执行器：select（系统文件选择器 + 白名单过滤器 + 取消非错误 + selected-set 记录）、read（2 MiB 上限/64 KiB 内联/附件上传/二进制拒/TOCTOU 复核/返回字符集+大小+哈希）、write（Diff + 新建/覆盖 + 写前哈希冲突 → `FILE_CONFLICT` + 原子替换 + 格式保留）、capture（Win/X11 desktopCapturer + Wayland 降级 + 选择/预览/上传三步）；
4. tool-status-sender：Main 缓存 `toolName/toolVersion/runtime/paramHash`（D6-07）→ 组装 `ToolStatusCommand` → `adapter.submitToolResult`（real WS / mock 记录+归档）；附件经 `adapter.uploadToolAttachment`（real `POST /api/uploads/desktop/{callId}` + `X-Client-Connection`；mock 占位 URL）回填 `attachments`；
5. IPC 面（F-6-13/14）：`tool:event` 推送 + `tool:decide/cancel/list` invoke + capture 两条通道，zod 双端 + `SCHEMA_VALIDATION_FAILED` + `isTrustedSender`；preload `onToolEvent/toolDecide/toolCancel/toolList`；`PublicToolEvent` 无任何原始 arguments/路径/安全元数据；
6. toolStore 三来路归一化（`tool:event` desktop / chat:event backend / `Message.toolCalls` 归档）+ 终态单向 + 同 id 合并规则 + `waitingForApproval`；bootstrap 旁路 + store 内订阅；`MessageSchema` 补 `ToolCallRecordSchema`（修复 preload 剥字段缺陷）；R-A3 `error:''` 加固；
7. CyToolCard（运行时徽标/状态文案/时间/摘要/授权入口）+ CyToolApproval（四问/允许一次与拒绝对等/无倒计时/关闭=拒绝/写 Diff+格式元信息/截图三步/焦点陷阱与回焦）+ CyLiveToolCards 实时区 + CyMessageBubble 归档卡片；Live2D `waiting_permission` 接线（不打断 speaking/thinking）；
8. mock 改接：`toolRequestSink` → tool-service 统一入口（不再直发 chat:event）；`CYRENE_MOCK_TOOL_FLOW` desktop kind 全链路可测（权限窗 → 允许/拒绝 → 执行 fixture → 终态卡片）；集成测试 F-6-24 落地；
9. 门禁全绿：单测（policy/registry/service/executors/status-sender/audit/schema/store/state-source 增补/R-A3）+ 集成（electron-tools.spec.ts 新文件）+ typecheck/lint/build + check:contract（WS 32/32 + 8 未纳 warn + REST 15/15，批次 B 不动 raw wire → **manifest 不刷新**）；
10. 三态 = **已开发、未联调**（真实 Windows Electron 联调归批次 C/开发者事后）。

## 2. 分层架构

```text
后端 v2 WS（ServerMessage）                          Main（受信边界）                            Renderer（非受信）
├─ tool.request ──► handleFrame case 'tool.request' ──► FrameMapper（校验+脱敏，mapper 单测保留）
│                      │                                  └─► tool-service.handleRequest(DesktopToolRequest)
│                      └─►（不再 emit 给 renderer，D6B-08；arguments/paramHash 只在 Main）
├─ tool.started ──► handleFrame default ──► FrameMapper ──► ToolStartedEvent ──► chat:event ──► bootstrap ──► toolStore（backend 只读）
├─ tool.completed─► handleFrame default ──► FrameMapper ──► ToolCompletedEvent─► chat:event ──► 同上
REST/回放（持久权威）: Message.toolCalls ──► CyMessageBubble 归档卡片（只读）

Mock（CYRENE_MOCK_TOOL_FLOW desktop kind）: 构造 DesktopToolRequest ──► toolRequestSink ──► tool-service（同 real 入口）

Main tool-service（桌面工具全生命周期）
  注册表/黑名单/selected-set ─► 决策链 ─► 执行器（select/read/write/capture）
      │                            │
      ▼                            ▼
  tool:event（PublicToolEvent）    tool-status-sender ──► adapter.submitToolResult（real WS / mock 记录+归档）
  推送 Renderer                    ├─► adapter.uploadToolAttachment（real POST /api/uploads/desktop/{callId} / mock 占位）
  toolStore（归一化 + 状态机）      └─► tool-audit（append-only，脱敏）
      ├─► CyLiveToolCards（实时区）+ CyToolCard/CyToolApproval（权限窗）
      ├─► Live2D waiting_permission（state-source 读值）
      └─► CyMessageBubble（归档卡片）
```

## 3. 详细设计（按 F-6 编号）

### 3.1 F-6-07 tool-registry（新建 `apps/desktop/src/main/tools/tool-registry.ts`）+ tool-policy（新建 `apps/desktop/src/main/tools/tool-policy.ts`）

**tool-policy.ts（纯函数，可单测）**：

```typescript
/** 路径黑名单默认集（D6B-02；规范化前缀匹配，含子目录；精确文件项以 trailing 区分） */
export const PATH_BLACKLIST_DEFAULTS: ReadonlyArray<{ root: string; exactFile?: boolean }> = [
  // POSIX 系统目录（前缀）
  { root: '/etc' }, { root: '/usr' }, { root: '/bin' }, { root: '/sbin' }, { root: '/boot' },
  { root: '/lib' }, { root: '/lib64' }, { root: '/proc' }, { root: '/sys' }, { root: '/dev' },
  { root: '/root' }, { root: '/run' }, { root: '/var' }, { root: '/lost+found' }, { root: '/snap' },
  // 用户敏感目录（前缀，基于 os.homedir() 解析）
  // ~/.ssh ~/.config ~/.gnupg ~/.password-store ~/.aws ~/.npm ~/.cache
  // ~/.local/state ~/.local/share/keyrings ~/.mozilla ~/.git-credentials
  // Windows（前缀；大小写不敏感）
  // C:\Windows C:\Program Files C:\Program Files (x86) C:\ProgramData
  // C:\System Volume Information C:\$Recycle.Bin %USERPROFILE%\.ssh
  // 设备路径（精确）：\\.\ 前缀一律拒
]

/** 黑名单匹配：规范化路径（resolve + 去 trailing slash）后前缀匹配；exactFile 项精确匹配文件名 */
export function isPathBlacklisted(normalizedPath: string, blacklist = PATH_BLACKLIST_DEFAULTS): boolean

/** 路径规范化 + 符号链接复核（复用 SafeOpenPlatform 语义：preOpenLstat 拒 symlink / O_NOFOLLOW）；
 * 返回 { normalized, exists }；解析失败/逃逸 → 抛 PolicyError(PATH_UNSAFE) */
export function normalizeToolPath(rawPath: string, opts: { platform: 'posix' | 'windows' }): { normalized: string; exists: boolean }

/** 域名黑名单：仅允许已连接后端端点（ConnectionConfig baseUrl origin）；
 * 上传目标 URL 校验 = same origin with endpoint */
export function isDomainAllowed(url: string, allowedOrigin: string): boolean
```

**tool-registry.ts**：

```typescript
export type ToolPermissionMode = 'automatic' | 'scoped_or_prompt' | 'always_prompt' | 'prohibited'

export interface RegisteredTool {
  name: string; version: string; runtime: 'desktop'
  title: string; description: string
  dataFlowNote: string                // 权限窗「哪些数据发后端」文案（registry 静态文案）
  localRisk: 'safe' | 'medium' | 'high'   // 本地风险等级（本地定义，D6-08 决策链用）
  permissionMode: ToolPermissionMode
  supportedPlatforms: Array<'windows' | 'linux'>
  inputSchema: z.ZodType<unknown>     // 工具专属参数 schema（strict）
  outputSchema: z.ZodType<unknown>
  executeRef: ToolExecutorName        // 'file.select' | 'file.read' | 'file.write' | 'screen.capture'
  defaultTimeoutMs: number            // 执行超时
  isPathTool: boolean                 // 参数含 path（黑名单/规范化检查适用）
}

export function createToolRegistry(): ToolRegistry   // 静态四工具
export const TOOL_NAMES = ['desktop.file.select', 'desktop.file.read', 'desktop.file.write', 'desktop.screen.capture'] as const
```

四工具注册元数据（常量）：

| name | localRisk | permissionMode | inputSchema（strict） | dataFlowNote |
|---|---|---|---|---|
| `desktop.file.select` | safe | automatic | `{ title?: string }`（不接受 filters——客户端白名单生成） | 「选择的文件路径摘要将发送到已连接的后端服务器；文件内容不会自动上传」 |
| `desktop.file.read` | medium | scoped_or_prompt（本批按「每次确认 + selected-set 豁免」实现，D6B-03） | `{ path: z.string().min(1) }` strict | 「读取的文件内容（≤64 KiB 内联 / 更大经附件上传）将发送到已连接的后端服务器」 |
| `desktop.file.write` | high | always_prompt | `{ path: z.string().min(1), content: z.string() }` strict | 「写入内容将覆盖/创建目标文件，文件内容将发送到已连接的后端服务器」 |
| `desktop.screen.capture` | high | always_prompt | `{}` strict | 「所选屏幕/窗口截图将发送到已连接的后端服务器」 |

### 3.2 F-6-08 tool-service（新建 `apps/desktop/src/main/tools/tool-service.ts`）

**入口与请求形状**：

```typescript
/** 桌面工具请求（Main 内统一形状；real 由 RawToolRequest 提炼，mock 由配置构造） */
export interface DesktopToolRequest {
  callId: string                    // 桥 callId（call_ 前缀）
  sourceCallId: string              // LLM tool_call_id（权威键）
  toolName: string
  toolVersion: string
  runtime: 'desktop'
  arguments: Record<string, unknown>
  reason?: string
  expiresAt: number                 // epoch ms
  paramHash?: string                // real 有（raw 帧）；mock 无（跳过校验）
}

export interface ToolServiceDeps {
  registry: ToolRegistry
  platform: 'posix' | 'windows'
  audit: (event: AuditEvent) => void          // 既有 audit 闭包
  pickFile?: (opts: FilePickerOptions) => Promise<{ canceled: boolean; path?: string }>   // 注入（集成测试替换）
  enumerateSources?: () => Promise<CaptureSourceInfo[]>   // 注入（集成测试替换）
  submitStatus: (cmd: ToolStatusCommand) => Promise<void> // adapter.submitToolResult
  uploadAttachment: (callId: string, bytes: Uint8Array, mime: string, label?: string) => Promise<ToolAttachment>
  pushEvent: (ev: PublicToolEvent) => void    // tool:event 推送（webContents.send）
  selectedExemptTtlMs?: number                // 默认 10*60*1000
}
```

**决策链（doc 04 §5 请求处理顺序 + §7.4 优先级；任一步失败返回结构化错误不再继续）**：

1. **注册表**：未知 name/版本不匹配 → `rejected` + `CAPABILITY_UNAVAILABLE`（不弹窗）；
2. **参数 schema**：`inputSchema.parse` 失败 → `rejected` + `INVALID_ARGUMENTS`（不弹窗）；
3. **callId 幂等**（doc 04 §13）：已存在记录——等待授权/运行中 → 返回当前状态不重复弹窗；已完成 → 返回既有结果；已拒绝 → 保持拒绝；**参数与相同 callId 不一致 → `rejected` + 协议错误**（`PARAM_MISMATCH`）；
4. **paramHash**（仅 real，`paramHash` 存在时）：规范化 arguments 重算 SHA-256 对比 → 不一致 → `rejected` + `PARAM_HASH_MISMATCH`（不弹窗）；
5. **路径规范化 + 黑名单**（`isPathTool`）：`normalizeToolPath` 失败（逃逸/设备路径）→ `rejected` + `PATH_UNSAFE`；黑名单命中 → `rejected` + `PATH_BLOCKLISTED`（**黑名单永远压过一切，不弹窗**，doc 04 §7.4）；UNC/设备路径（Windows）→ `PATH_UNSAFE`；
6. **本地风险重算 + 授权判定**（D6B-03）：
   - `file.select`（safe/automatic）→ 直接 `running` → 执行；
   - `file.read`：path ∈ selected-set（D6B-20）→ 直接 `running`；否则 → `awaiting_permission`；
   - `file.write` / `screen.capture`（high/always_prompt）→ 恒 `awaiting_permission`；
   - 强制逐次确认：本批所有 medium+ 恒逐次（无 grant 链，doc 04 §7.1「Demo 策略每次确认」）；
7. **等待授权**：`expiresAt` 超时（Main 定时器）→ 展示 `timeout` + wire `cancelled`（请求未接受即失效，D6B-11 注记）；`tool:cancel` → 展示 `cancelled` + wire `cancelled`；
8. **决定**（`tool:decide`）：`allow_once` → `running` → 执行（审计 `tool:decision` allow_once）；`deny` → `rejected`（wire `rejected`，审计；**拒绝保持拒绝**，重连后不重弹）；
9. **执行**（executorRef）：超时（defaultTimeoutMs）→ 展示 `timeout` + wire `error{TIMEOUT}`；成功 → `completed` + wire `result`；执行失败 → `failed` + wire `error`；执行中取消（工具取消/断线收尾）→ 展示 `cancelled` + wire `cancelled`；
10. **状态机**：展示态 8 值（doc 04 §4）单向前进；wire 六态映射（D6A-05：accepted/running→running、result→completed、error→failed、rejected/cancelled 同名；requested/awaiting_permission/timeout 本地态）；每次状态变化 → `pushEvent(PublicToolEvent)` + 审计；
11. **断线重连**（D6B-11）：`reconnect()`——终态且 `statusSent=false` 的记录重发 `submitStatus`；非终态保持不动。

**selected-set**（D6B-20）：`select` 成功 → `set(normalizedPath, Date.now())`；读取时 `now - selectedAt <= TTL && 同连接会话` 豁免；`write/capture` 不豁免（恒强确认）。

**超时与取消并发纪律**（doc 04 §12）：写操作临界区内取消 → 安全完成或回滚（原子写保证）；同一路径写操作串行（tool-service 内 per-path 锁）；截图选择器同一时间只允许一个。

### 3.3 F-6-09 tool-executors（新建 `apps/desktop/src/main/tools/tool-executors.ts`）+ text-diff（新建 `apps/desktop/src/main/tools/text-diff.ts`）

**依赖注入**：`createToolExecutors(deps)` 构造四执行器，`deps = { platform, openDialog（注入）, enumerateSources（注入）, uploadToolAttachment, readSafe（SafeOpenPlatform 语义封装）, ... }`——全部可注入以支撑单测（对齐 SafeOpenPlatform 平台层可注入先例）。

**text-diff.ts（jsdiff 包装纯函数）**：

```typescript
import { diffLines, diffWords } from 'diff'   // jsdiff ^9.0.0（自带类型）

export interface DiffLine { kind: 'added' | 'removed' | 'unchanged'; text: string }
export interface TextDiffResult {
  lines: DiffLine[]                 // diffLines 行级结果
  added: number; removed: number
  truncated: boolean                // 超过 MAX_DIFF_LINES 截断
}
export const MAX_DIFF_LINES = 100
export function computeTextDiff(oldText: string, newText: string): TextDiffResult
export function detectTextFormat(text: string): { hasBom: boolean; eol: 'crlf' | 'lf' | 'mixed'; endsWithNewline: boolean }
export function normalizeToFormat(content: string, fmt: { hasBom: boolean; eol: 'crlf' | 'lf'; endsWithNewline: boolean }): string
```

**desktop.file.select**：
- 执行：`openDialog({ title: 注册表 title, filters: TEXT_FILE_FILTERS（客户端白名单扩展名）, properties: ['openFile'] })`；
- 结果：`{ cancelled: true }`（用户取消，**非错误**，D6B-20）或 `{ path, name, size, mtimeMs, hash: sha256 }`；selected-set 记录；`tool.status result` output = 结果 JSON（`cancelled` 也走 result 态）；
- 过滤器白名单（文本为主，对齐 read 能力）：`txt md markdown json log csv tsv js ts jsx tsx py rb go rs c h cpp hpp java kt swift css scss html htm yaml yml toml ini cfg conf xml svg sh bash env`。

**desktop.file.read**：
- 校验：`normalizeToolPath` + 黑名单（tool-service 已做，执行器复核——TOCTOU：open 前 stat + open 后 fstat 复核，SafeOpenPlatform 先例）；
- `size > FILE_READ_MAX_BYTES(2 MiB)` → 抛 `FILE_TOO_LARGE`（Code 由 tool-service 映射 wire error）；NUL 字节比例检测（≥ 0.1% 或首个 8 KiB 含 NUL）→ `FILE_IS_BINARY`；BOM 检测（UTF-8/UTF-16LE/BE，UTF-16 视为非文本 → `FILE_IS_BINARY`，P0 只支持 UTF-8 文本，doc 04 §8.2「文本文件」）；无 BOM → 严格 UTF-8 解码（`TextDecoder('utf-8', {fatal:true})`，失败 → `FILE_IS_BINARY`）；
- 结果：`{ path, name, size, hash: sha256, charset: 'utf-8' }` + content（≤ `RESULT_INLINE_BYTES(64 KiB)` → `output` 内联；> 64 KiB → `uploadToolAttachment` → `attachments` 回填 + `outputSummary` 前 2000 字符 + `truncated=true`）。

**desktop.file.write**：
- 校验同 read（黑名单/规范化/文本检测——旧文件存在时）；目标不存在 → 新建类型；存在 → 覆盖类型；
- 覆盖路径：读旧文件（文本校验）→ `computeTextDiff(oldText, newText)` + `detectTextFormat(oldText)`（新文件：UTF-8 无 BOM + LF + 内容原样）；
- **写前哈希检查**：旧文件读取时已算 hash → 原子替换前重读对比 → 不一致 → `FILE_CONFLICT`（「冲突时停止并返回 FILE_CONFLICT」，doc 04 §8.3）；
- **原子替换**：同目录临时文件 + rename（复用 `credentials/atomic-write.ts` 先例或等价 safe 实现）；失败保持原文件不变；
- 格式适配：`normalizeToFormat(newText, detectTextFormat(oldText))`（D6B-19）；确认窗展示 Diff（D6B-04）+ 格式元信息条 + 新建/覆盖类型；
- 结果：`{ path, size, hash, bytesWritten }`。

**desktop.screen.capture**：
- Wayland 检测（D6B-05）→ 授权前 `CAPTURE_UNAVAILABLE`；
- 授权通过 → `enumerateSources({ types: ['screen','window'], thumbnailSize: {width: 320, height: 240} })`（desktopCapturer）→ 缩略图 data URL 列表经 tool:event（`PublicToolEvent.status='running'` + `captureSources` 扩展字段）下发 → Renderer grid 选择 → `tool:pick-source` → Main 重新 `getSources`（全尺寸）→ 预览 data URL 下发（`capturePreview` 扩展字段）→ `tool:confirm-upload` → PNG bytes 上传（`uploadToolAttachment`，mime `image/png`）→ attachments 回填 + result `{ sourceId, sourceName, size, mimeType, attachmentId }`；临时图清理（完成/取消/超时）；
- 注入 `enumerateSources` 默认实现 = desktopCapturer 封装（单测注入 fake）。

**PublicToolEvent 扩展字段**（capture 交互，D6B-16）：

```typescript
export interface PublicToolEvent {
  id: string; desktopCallId?: string; toolName: string; title: string
  runtime: 'desktop'; status: ToolCallStatus
  reason?: string; inputSummary?: string; resultSummary?: string
  error?: { code?: string; message?: string }; truncated?: boolean
  durationMs?: number; startedAt?: string; finishedAt?: string
  occurredAt: string
  captureSources?: Array<{ sourceId: string; sourceName: string; thumbnailDataUrl: string }>  // 仅 capture 运行态
  capturePreview?: { sourceId: string; previewDataUrl: string }                                // 仅 pick 后预览
}
```

### 3.4 F-6-10 tool-status-sender（新建 `apps/desktop/src/main/tools/tool-status-sender.ts`）

```typescript
export function createToolStatusSender(deps: {
  adapter: Pick<BackendAdapter, 'submitToolResult' | 'uploadToolAttachment'>
  audit: (ev: AuditEvent) => void
}): {
  send(command: ToolStatusCommand): Promise<void>   // 组装已由调用方完成；此处发送 + 审计 tool:status-sent
  uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment>
}
```

- **Main 缓存**（D6-07）：tool-service 在 request 到达时缓存 `{ callId → { toolName, toolVersion, runtime, paramHash, expiresAt } }`；`ToolStatusCommand` 组装时从缓存取值（`tool.status` 一致性不受领域记录影响）；
- 六态映射 + `runtime` 保持 str（D-status-runtime）；`output` 只放 ≤64 KiB 内联内容；`error` `{code, message}`；
- 附件：先 `uploadToolAttachment` 后回填 `attachments`（文档 doc 02 §10.3 顺序）；real 路径带 `X-Client-Connection: <connectionId>`（`RealBackend` 内部实现，connectionId 取自 server_info，real-backend.ts:317）；
- 发送失败（WS 断开）→ 记录 `statusSent=false` → 重连后重发（D6B-11）。

**BackendAdapter 扩展**（`apps/desktop/src/main/transport/backend-adapter.ts`）：

```typescript
abstract uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment>
```
- `RealBackend`：`POST ${serverUrl}/api/uploads/desktop/${callId}`，`Content-Type: multipart/form-data`（字段 `file` + `mime` + `label`），header `Authorization: Bearer <token>` + **`X-Client-Connection: <connectionId>`**；返回 `{ url, mimeType, label? }`（契约 ToolAttachment）；
- `MockBackend`：返回 `{ url: 'mock://tool-attachment/' + callId, mimeType, label? }`（不上传，D6B-15）。

### 3.5 F-6-11 real-backend 接线（修改 `apps/desktop/src/main/transport/real-backend.ts`）

- `handleFrame` 增显式 `case 'tool.request'`（当前落 default 分支直接 emit）：`this.mapper.mapToolRequest(frame)`（校验+脱敏，mapper 单测语义保留）→ 提炼 `DesktopToolRequest`（arguments/paramHash 自 raw 帧）→ `this.onToolRequest?.(req)`（**不 emit 给 renderer**，D6B-08）；`onToolRequest` 为可空 setter（index.ts 装配时注入，避免构造环引用）；
- `tool.started` / `tool.completed` 保持 default 分支（mapper → emit chat:event，批次 A 现状不变）；
- `submitToolResult` 实装：`ws.send(JSON.stringify(frame))`（`RawToolStatus` 序列化，复用既有 JSON 发送模式 + `requireWs()` 守卫）；断线时抛 `NOT_CONNECTED` → tool-status-sender 置 `statusSent=false`（重连重发）；
- `uploadToolAttachment` 实装（3.4 形状）；连接断开时清 activeVoice 的既有行为不变；重连恢复时若有未确认工具终态 → 触发 tool-service `reconnect()`（D6B-11）。

### 3.6 F-6-12 tool-audit（新建 `apps/desktop/src/main/tools/tool-audit.ts`）

```typescript
/** 脱敏工具审计（D6B-18）：走既有 audit 闭包；输入摘要复用 redactToolArguments；不落文件内容/截图/token */
export function auditToolEvent(
  audit: (ev: AuditEvent) => void,
  ev: { type: 'tool:request-received' | 'tool:decision' | 'tool:executing' | 'tool:status-sent' | 'tool:terminal'
        callId: string; sourceCallId?: string; toolName?: string; runtime?: 'desktop' | 'backend'
        status?: string; durationMs?: number; summary?: string }
): void
```
- `AuditEvent` 既有字段映射：`toolId=sourceCallId`、`callId`、`status`、`durationMs`、`summary=脱敏摘要`、`runtime`；
- backend 来源记录（tool.started/completed 公开事件）→ `runtime:'backend'` + summary 注记「客户端公开事件，非后端完整审计」（doc 04 §14 完整性范围）；
- 审计失败不改变操作结果（fail-open 既有语义）。

### 3.7 F-6-13/14 Preload / IPC 面

**`shared/contracts/ipc.ts`** 增：

```typescript
export const IpcChannels = {
  ...,
  toolEvent: 'tool:event',       // Main→Renderer 推送（PublicToolEvent）
  toolDecide: 'tool:decide',     // Renderer→Main invoke（PermissionDecision）
  toolCancel: 'tool:cancel',     // Renderer→Main invoke（{callId}）
  toolList: 'tool:list',         // Renderer→Main invoke（→ PublicToolEvent[]）
  toolPickSource: 'tool:pick-source',       // capture 选择（{callId, sourceId}）
  toolConfirmUpload: 'tool:confirm-upload', // capture 上传确认（{callId}）
} as const
```

**schemas（`shared/schemas/ipc-response.ts` / `shared/schemas/ipc-request.ts` 或 handlers 侧）**：
- `PublicToolEventSchema`（zod，`status` 8 态枚举、`captureSources`/`capturePreview` 可选、无额外键放行——`.strict()`）；`ToolCallRecordSchema`（**新增**，镜像 `ToolCallRecord`，挂到 `MessageSchema.toolCalls`——修复 preload `MessageSchema.safeParse` 剥字段缺陷，ipc-response.ts:87-102）；
- `PermissionDecisionSchema`：`{ callId: string, decision: 'allow_once' | 'deny' }`（本批无 grantScope，D6B-03；**`decidedAt` 由 Main 落审计时打戳，不入 Renderer 请求 schema**——Renderer 时钟不可信）；
- `toolCancelSchema`：`{ callId: string }`；`toolListResponseSchema`：`PublicToolEventSchema.array()`；`toolPickSourceSchema`：`{ callId, sourceId }`；`toolConfirmUploadSchema`：`{ callId }`。

**Main handlers（新建 `apps/desktop/src/main/ipc/tool-handlers.ts`）**：`registerToolHandlers(deps)`——`tool:decide`（调用 tool-service.decide）、`tool:cancel`、`tool:list`（tool-service 最近 20 条公开记录）、`tool:pick-source`/`tool:confirm-upload`（capture 状态机推进）；全部 `registerHandler` + `isTrustedSender` + zod（`SCHEMA_VALIDATION_FAILED`）；`tool:event` 推送 = tool-service `pushEvent` 闭包 → `webContents.send(IpcChannels.toolEvent, ev)`（Main 组装、Renderer 不可见 → 反方向只有 preload 订阅）。

**preload（`apps/desktop/src/preload/desktop-api.ts`）**：`onToolEvent(handler)`（返回退订；`PublicToolEventSchema.safeParse` 非法丢弃 + warn，对齐 `onChatEvent` 模式）、`toolDecide(input)`、`toolCancel(callId)`、`toolList()`、`toolPickSource(callId, sourceId)`、`toolConfirmUpload(callId)`——全部具名窄 API，无通用通道。

### 3.8 F-6-15 toolStore（新建 `apps/desktop/src/renderer/src/stores/tool.store.ts`）

```typescript
export const useToolStore = defineStore('tool', () => {
  const records = ref<Record<string, ToolCallRecord>>({})     // key = id（sourceCallId）
  const liveOrder = ref<string[]>([])                          // 当前会话实时记录顺序（上限 3）
  const waitingForApproval = computed(() => liveOrder.some(id => records[id]?.status === 'awaiting_permission'))
  const captureState = ref<{ callId: string; sources?: PublicToolEvent['captureSources']; preview?: PublicToolEvent['capturePreview'] } | null>(null)

  function init(): void        // 订阅 api.onToolEvent（voiceStore.init 先例）；app 启动时调用
  function applyBackendEvent(ev: ToolRequestEvent | ToolStartedEvent | ToolCompletedEvent): void  // bootstrap 旁路
  function upsertLocal(ev: PublicToolEvent): void              // tool:event 推送
  function hydrateFromMessage(toolCalls: ToolCallRecord[]): void  // 归档（只读卡片；不清 live）
  function clearForGeneration(): void                          // generation.started 清 live（D6B-17）
  function decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void>
  function cancel(callId: string): Promise<void>
  function pickSource(callId: string, sourceId: string): Promise<void>
  function confirmUpload(callId: string): Promise<void>
  // 归档卡片数据源 = message.toolCalls 本体（rest-mapper 配对产物），toolStore 不复制（D6B-17）
  // 终态单向守卫：同 id 终态后忽略非终态更新（D6A-05）
  // 合并规则（D6B-21）：desktop 记录已存在 → 后端 started/completed 不覆盖（本地裁决）；不存在 → 新建 backend 只读记录
})
```

- 三来路归一化（doc 06 §3.5）：`tool:event`（desktop 本地状态机，权威）、`chat:event` tool.started/completed（backend 展示）、`Message.toolCalls`（归档持久）；
- `ToolRequestEvent`（tool.request）——批次 B 起 desktop 请求不再经 chat:event（D6B-08），`applyBackendEvent` 中 tool.request 分支仅防御性处理（mock 旧配置兼容可忽略）；
- `init()` 在 bootstrap 装配（app 启动）时调用一次；`waitingForApproval` 供 Live2D（D6B-13）与权限窗宿主（CyChatView/CySettingsView 双宿主不双渲染，CyVoiceConsentDialog 先例）使用。

### 3.9 F-6-16 CyToolCard（新建 `apps/desktop/src/renderer/src/components/CyToolCard.vue`）

- props：`record: ToolCallRecord`；runtime 徽标（backend →「后端」灰底；desktop →「此电脑」蓝底，doc 03 §9）；
- 展示：title（友好名）/ toolName（次要）、状态文案（doc 03 §9 七态：等待授权/用户已拒绝/正在执行/执行完成/执行失败/已取消/已超时）、reason 或回退（「请求原因」以工具说明 + inputSummary + 数据流向替代，doc 03 §9 注记）、inputSummary（脱敏）、resultSummary/error、起止时间、durationMs、truncated 提示、附件数（「含 N 个附件」不渲染内容预览——mock 占位 URL 无真实内容）；
- 授权入口：仅 `runtime==='desktop' && status==='awaiting_permission'` 显示「允许此电脑操作」按钮（打开 CyToolApproval）+ 拒绝按钮（先做拒绝按钮，预检②）——**按钮对等权重**（doc 03 §10 禁止唯一显眼）；
- desktop 卡片非终态显示「取消任务」按钮（doc 03 §10 P0 操作）；backend 卡片零按钮零授权入口（只读，doc 04 §11）；
- 原始 JSON 仅开发模式脱敏展示（doc 03 §9；`import.meta.env.DEV` 守卫）；
- capture 卡片：`status==='running' && captureState` → 内嵌选择/预览/上传面板（3.10 子面板）；
- 数据驱动（store 传入），无组件内 zod（项目纪律）。

### 3.10 F-6-17 CyToolApproval（新建 `apps/desktop/src/renderer/src/components/CyToolApproval.vue`）

- 宿主：CyChatView 尾部挂载 + CySettingsView 不挂（权限窗只出现在聊天流）——定案：挂 CyChatView（chat 模板内），`v-if="toolStore.waitingForApproval"` 显示当前等待记录（单一等待，tool-service 串行弹窗保证一次一个）；
- 结构：fixed inset-0 遮罩 + 居中盒（CyVoiceConsentDialog 先例，z-index 80）+ `role="dialog" aria-modal` + **初始焦点拒绝按钮（安全默认）+ Tab 陷阱 + Esc=拒绝 + 回焦 triggerElement**（CyHistoryViewer 先例）；
- 四问（doc 03 §10）：① 做什么（title + description + inputSummary）；② 操作哪个资源（inputSummary 含路径参数展示）；③ 为什么（reason 或回退文案）；④ 哪些数据发后端（registry `dataFlowNote` 静态文案——**定案：`PublicToolEvent` 增可选 `dataFlowNote?: string`**，由 Main 在 request 时并入事件（非敏感静态文案）；回退方案见 §7 R6）；
- 按钮：**允许一次**（对等权重）+ **拒绝**（同权重）；写文件时附加「取消任务」；无倒计时自动允许；关闭窗口 = 拒绝（doc 07 §10）；`tool:decide` 提交后关闭；
- 写文件（record.toolName==='desktop.file.write'）：Diff 面板（`text-diff` 产物——**Diff 由 Main 计算后随 PublicToolEvent 下发**：`tool:event` 增 `diff?: TextDiffResult + formatNote`，renderer 不引 jsdiff（渲染无关，体积纪律）——定案：Main 计算 Diff 序列化到事件；renderer 只渲染）+ 新建/覆盖标注 + 格式元信息条（D6B-19）+ 首 100 行截断提示；
- capture：授权后卡片内展开选择器（缩略图 grid）→ 预览 → 「确认上传」（D6B-16）。

**PublicToolEvent 最终形状**（含 capture/diff 扩展）：

```typescript
export interface PublicToolEvent {
  id: string; desktopCallId?: string; toolName: string; title: string
  runtime: 'desktop'; status: ToolCallStatus
  reason?: string; inputSummary?: string; resultSummary?: string
  error?: { code?: string; message?: string }; truncated?: boolean
  durationMs?: number; startedAt?: string; finishedAt?: string
  dataFlowNote?: string
  diff?: { lines: DiffLine[]; added: number; removed: number; truncated: boolean; formatNote: string; isNewFile: boolean }
  captureSources?: Array<{ sourceId: string; sourceName: string; thumbnailDataUrl: string }>
  capturePreview?: { sourceId: string; previewDataUrl: string }
  occurredAt: string
}
```

### 3.11 F-6-18 聊天视图接线 + Live2D

- **CyLiveToolCards**（CyChatView 内，`CyMessageList` 与 `CyChatInput` 之间，`v-if="liveOrder.length > 0"`）：渲染当前会话实时记录（≤3 条，`records[id]` 查表）→ `<CyToolCard :record="...">`；`generation.started` 清空（D6B-17）；
- **归档卡片**：`CyMessageBubble.vue` assistant 分支 `.cy-response-cluster`（response-head 之后、segments 循环之前）→ `message.toolCalls?.length` 时渲染 `<CyToolCard :record="r" readonly>`（只读；tool 角色消息继续按现有 MessageToolInfo 归一化，不渲染为普通气泡——本批补：`CyMessageBubble` 的 `v-else` 非 user 分支加 `role==='tool'` 判定 → 不渲染空气泡（现状缺陷，批次 A 记录「tool 角色消息不再作为普通气泡渲染」归批次 B）；
- **Live2D**（D6B-13）：`state-source.ts` 增 `toolWaiting` getter + `composeCharacterState` 规则（`!isGenerating && !isSpeaking && toolWaiting → waiting_permission`）+ `isTransient` 补 `waiting_permission`；`live2d.store.ts setupStateSource` 注入 getter（`useToolStore().waitingForApproval`）。

### 3.12 F-6-22 mock 改接（修改 `apps/desktop/src/main/transport/mock-backend.ts` + `apps/desktop/src/main/index.ts`）

- `MockBackendOptions` 增 `toolRequestSink?: (req: DesktopToolRequest) => void`（ttsAudioSink 先例 mock-backend.ts:271-273）；
- desktop kind 发射改：构造 `DesktopToolRequest`（`callId:'call_mock_1'`、`sourceCallId:'tc_mock_desktop_1'`、`toolName`、`toolVersion:'1.0'`、`runtime:'desktop'`、`arguments: r.arguments`（配置原样，D6B-15）、`reason`、`expiresAt: now+30s`、`paramHash: 省略`）→ `sink(req)`（**不再 `this.emit`**）；`CYRENE_MOCK_TOOL_FLOW` 解析与 backend kind 发射不变；
- `submitToolResult` 保持（记录 `lastToolStatus` + 终态归档——tool-status-sender 经 adapter 统一调用）；
- `index.ts`：装配顺序——adapter 构造后（169-193）、`createToolService`（新，依赖 registry/policy/executors/status-sender/audit/pushEvent=webContents.send 闭包）→ `mock.toolRequestSink = (req) => toolSvc.handleRequest(req)`；`realBackend.onToolRequest = (req) => toolSvc.handleRequest(req)`；`registerHandlers` deps 增 `tools`（handlers.ts:29-51 展开）；`RuntimeInfo` 不扩展（renderer 无需感知 mock 注入——探针经 `__cyreneTest`，见 3.13）；**capture 枚举器注入**：`parseMockCaptureSourcesEnv(process.env.CYRENE_MOCK_CAPTURE_SOURCES)`（对齐 `parseMockToolFlowEnv` 先例，非法 JSON → undefined）→ mock 模式有值时注入 fake enumerateSources（集成测试用，见 3.13）；
- 环引用：tool-service 需 adapter（submitToolResult/uploadToolAttachment）→ 用 chatBridge 模式（const 容器后注）或 `createToolService` 在 adapter 之后调用、把 adapter 传入（index.ts 装配顺序 169-245 之后自然满足——tool-service 构造在 adapter 之后，无环）。

### 3.13 F-6-24 测试（单测 + 集成）

**单测（`tests/unit/`，node 环境；组件/状态相关文件头 `// @vitest-environment happy-dom`）**：

| 文件 | 用例 |
|---|---|
| `tool-policy.spec.ts`（新） | 黑名单匹配（/etc 前缀含子目录、~/.ssh 解析后、exactFile、Windows 大小写不敏感、\\.\ 拒）；normalizeToolPath（相对路径解析、symlink 拒——平台注入、逃逸拒）；域名白名单（同源放行/异源拒） |
| `tool-registry.spec.ts`（新） | 四工具注册齐全；未知名/版本/运行时拒绝；inputSchema strict 拒未知字段；permissionMode/risk 映射闭合 |
| `tool-service.spec.ts`（新） | 决策链全分支（注册表拒/schema 拒/幂等重复与参数不一致/paramHash 不匹配/黑名单命中不弹窗/read 豁免与未命中/select 自动/capture 授权前 Wayland 拒）；状态机单向前进（awaiting→running→completed 等合法序列、终态后更新忽略）；expiresAt 超时 → timeout+cancelled；cancel；decide allow/deny；断线重连重发终态/非终态不动；写路径串行锁；审计调用计数 |
| `tool-executors.spec.ts`（新） | select（picker 注入 fake、取消 cancelled:true、selected-set 记录、过滤器白名单）；read（2 MiB 超限 FILE_TOO_LARGE、二进制 NUL 检测、BOM/UTF-8 严格、64 KiB 内联/附件、TOCTOU fstat 复核）；write（Diff 计算、新建/覆盖、写前哈希冲突 FILE_CONFLICT、原子替换（tmp+rename 产物断言）、格式保留（BOM/CRLF/末尾换行 normalize）、失败保持原文件）；capture（enumerateSources 注入 fake、Wayland 环境拒、上传调用与 attachments 回填、临时清理） |
| `text-diff.spec.ts`（新） | diffLines 行级结构、added/removed 计数、100 行截断、detectTextFormat（BOM/EOL/末尾换行）、normalizeToFormat 往返 |
| `tool-status-sender.spec.ts`（新） | 六态组装（缓存 toolName/toolVersion/runtime/paramHash 取值）、附件先上传后回填、发送失败 statusSent=false、重连重发、审计 tool:status-sent |
| `tool-audit.spec.ts`（新） | 字段映射（toolId/callId/status/durationMs/summary 脱敏）、backend 来源完整性注记、fail-open |
| `tool-public-events.spec.ts`（新） | `PublicToolEventSchema` 全字段合法/非法拒（status 8 态枚举、capture/diff 扩展、strict 未知键拒）；`ToolCallRecordSchema` + `MessageSchema.toolCalls` 补字段生效（`safeParse` 保留 toolCalls） |
| `ipc-tool-handlers.spec.ts`（新） | 四通道 handler 接线（createIpcHandler 直调先例）、SCHEMA_VALIDATION_FAILED、isTrustedSender 拒、decide/cancel/list/pick/confirm 转发 tool-service |
| `tool.store.spec.ts`（新，happy-dom） | 三来路归一化；终态单向；D6B-21 合并（desktop 优先）；generation 清空；waitingForApproval computed；decide/cancel 调 api |
| `live2d-state-source.spec.ts` 增 | toolWaiting → waiting_permission 规则（isGenerating/isSpeaking 时不打断）；isTransient 含 waiting_permission |
| `mock-backend-tools.spec.ts` 增 | desktop kind 改走 sink（不再 emit 事件）；sink 收到 DesktopToolRequest 形状；backend kind 发射不变；submitToolResult 不变 |
| `rest-mapper-tools.spec.ts` 增 | **R-A3**：`error.message === ''` → 视为缺省（completed + 无摘要 vs failed 边界） |
| `contracts-tool.spec.ts` 增 | `PublicToolEvent` 形状闭合断言（无 arguments/无安全元数据字段） |

**集成（`tests/integration/electron-tools.spec.ts` 新文件，xvfb-run）**——参照 `electron-voice.spec.ts` consent 三连先例（360-389）+ `history-viewer-layout.spec.ts` 真点击 + `__cyreneTest` 探针（`renderer/src/main.ts:45-78` 同块新增 `getToolState()`/`getPermissionPending()` 探针）：

| 用例 | 路径 |
|---|---|
| desktop 工具流闭环 | `CYRENE_MOCK_TOOL_FLOW={"kind":"desktop",...}`（read fixture 文件）→ 发送消息 → tool:event → 卡片「等待授权」→ 点击「拒绝」→ 卡片「用户已拒绝」+ mock `lastToolStatus` 断言 rejected；再次 → 点击「允许一次」→ 执行 fixture → 卡片「执行完成」+ result 摘要 + 归档消息 |
| 写冲突 | desktop kind write fixture → 允许 → 执行前外部修改文件（test 内写）→ `FILE_CONFLICT` 卡片「执行失败」+ 原文件内容不变断言 |
| Backend 只读卡片 | `CYRENE_MOCK_TOOL_FLOW={"kind":"backend",...}` → 卡片出现「执行完成」无授权入口无按钮 |
| capture 流程（软断言） | desktop kind capture → 允许 → 源选择（**mock env 桥 `CYRENE_MOCK_CAPTURE_SOURCES`**（JSON `[{sourceId,sourceName}]`，Main 解析后注入 fake enumerateSources——mock 模式不调真实 desktopCapturer）→ 预览 → 确认上传 → 卡片终态；若无该桥环境 desktopCapturer 不可用（阶段 5 C1 SwiftShader 先例）→ **跳过并记录取舍**（单测已全覆盖） |
| Live2D waiting_permission（可选） | 允许 → Live2D 徽标「等待授权」→ 拒绝 → 回 idle；SwiftShader 风险同 capture 降级条款 |
| 重连幂等（可选） | mock 无断线——重连语义单测覆盖，集成不做（记录取舍） |

**门禁（F-6-25）**：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `xvfb-run -a pnpm test:integration` / `pnpm build` / `pnpm -F @cyrene/desktop check:contract`（WS 32/32 + 8 未纳 warn；REST 15/15——批次 B 不改 raw wire，`rawSchemasFingerprint()` 不变，**13 组 manifest 不刷新**；唯一例外：若实现期必须修改 `RawFrameSchema`/`RawClientFrameSchema` 中服务端帧 shape → 跑 `refresh-wire-manifests.mjs`）。

### 3.14 承载项

- **R-A3**（D6B-12）：`rest-mapper.ts` `pairToolCalls` 中 `error.message === ''` → `undefined`（+ `tool-service` 错误归一化同口径）；
- **MessageSchema 补 toolCalls**（D6B-08 配套）：`shared/schemas/ipc-response.ts` 新增 `ToolCallRecordSchema`（zod 镜像 `ToolCallRecord`：id/toolName/runtime/status/desktopCallId?/generationId?/conversationId?/reason?/inputSummary?/outputSummary?/error?{code?,message?}/errorType?/truncated?/durationMs?/startedAt?/finishedAt?）挂到 `MessageSchema`（当前缺字段 → preload `safeParse` 剥掉 → 归档卡片永远空，批次 A 潜在缺陷）；
- **sessionBuffer 留意**（批次 A Task5 review 遗留）：`real-backend.ts` sessionBuffer 缓冲的 tool 帧在回放路径的一致性在接线时复核（`handleSession` 组装 → `pairToolCalls` 已有批次 A 接线，本批验证不回归）；
- **jsdiff 依赖**：`apps/desktop/package.json` dependencies 增 `"diff": "^9.0.0"`（自带 TS 类型，无 @types/diff）；pnpm-lock 更新；无 CSP/沙箱影响（vite 打包为 self 资源）。

## 4. 安全设计

- **信任边界**（doc 07 三层）：全部工具执行/权限决策/审计在 **Main**；Renderer 只收 `PublicToolEvent`（无 arguments/路径/paramHash/expiresAt，D6B-09）+ 经 `tool:decide/cancel/pick/confirm` 具名通道回传决定；零通用 IPC（`invoke(channel)` 禁用纪律延续）；
- **执行面**：四执行器全部只读 Main 编译后注册的 `executeRef`（无命令/脚本/Worker）；`desktop.command.run` 不注册；无 `child_process`；
- **黑名单优先**（D6B-02）：路径/域名黑名单在决策链第 5 步、永远压过 selected-set 豁免与任何授权（doc 04 §7.4 决策优先级）；黑名单命中不弹窗（用户无法授权黑名单路径）；symlink 逃逸/设备路径/UNC（Windows）→ `PATH_UNSAFE` 拒绝（SafeOpenPlatform 复用 + O_NOFOLLOW 先例）；
- **路径安全**：`normalizeToolPath` 规范化 + 符号链接复核 + TOCTOU 复核（open 前 stat + open 后 fstat）；写操作原子替换（临时文件 + rename）+ 写前哈希冲突保护；失败保持原文件；
- **授权纪律**：允许一次/拒绝两值（本批无 scope）；关闭权限窗 = 拒绝；无倒计时自动允许；允许与拒绝按钮对等权重；参数在授权后变化 → 重新授权（paramHash + 幂等参数一致性校验）；
- **脱敏**：审计与 PublicToolEvent 均不落文件内容/截图/token/未脱敏参数（`redactToolArguments` 复用）；`output`/`outputSummary` 只进 store/WS（用户可见结果），不进日志/审计（doc 07 §12 约束对象是日志/审计/诊断）；
- **截图**：每次用户选择 + 预览 + 上传确认两步；Wayland 明确降级不静默；临时图完成/取消清理；审计只记元数据；
- **CSP/沙箱**：无新放宽（jsdiff 打包为 self 资源；data URL 预览在生产 `img-src 'self' data:` 已允许）；desktopCapturer 只在 Main 调用（sandbox renderer 无权）；
- **fail-closed**：所有 IPC 入站 zod 双端 + `SCHEMA_VALIDATION_FAILED` + `isTrustedSender`；`tool.status` 只能 Main 组装（缓存 D6-07）；未知 callId 的 decide/cancel → 结构化拒绝。

## 5. 文档同步（代码批落地时一并更新）

| 文档 | 更新点 |
|---|---|
| `docs/02` §10 | 领域模型补 `PublicToolEvent` + desktop 工具 Main 生命周期描述（tool.request 不再进 renderer 事件管线）；`tool.status` 发送方 = Main tool-service（F-6-10 落地） |
| `docs/03` §9/§10 | 工具卡片双区渲染（实时区/归档区）+ 权限窗落地注记（拒绝按钮对等/关闭=拒绝/写 Diff+格式元信息/截图三步） |
| `docs/04` | §2 注册表落地（四工具元数据）；§6 IPC 面落地（tool:event/decide/cancel/list/pick/confirm）；§7.4 决策链落地 + F-06/F-07 拍板值；§8 四工具实现要求落地（上限/编码/原子写/截图平台）；§13 幂等落地；§14 审计落地（tool:* 事件类型） |
| `docs/06` §3.5 | toolStore 三来路归一化 + 双区渲染 + 合并规则落地注记 |
| `docs/07` | §9 Desktop 工具安全落地注记（黑名单默认集/执行器安全/截图平台）；§10 权限 UI 落地 |
| `docs/12` | F-06/F-07/F-09/F-10 拍板关闭（外部输入清单更新）；§9.7 批次 B 状态 |
| `docs/16` §9 | F-6-07~18/22/24 落地状态 + changelog 行 |
| `docs/13` | 本批决策（预检拍板四项 + 推荐定案两项 + Rulings）交叉 review 结论 |
| `README` / `CLAUDE.md` | 阶段 6 批次 B 状态与测试计数（三态 = 已开发、未联调） |
| `docs/review/2026-08-20-阶段6批次B-决策记录.md`（新） | 本批决策记录（D6B-01~21 + 预检拍板 + Rulings + 执行偏离 + 门禁 + 验收结论） |

## 6. 范围外（明确不做）

- allow_scoped 授权（目录+有效期）、设置页授权历史/撤销、命令模板空态（F-07 拍板归批次 C）；
- `GET /api/tools/calls/{callId}` 服务端状态查询（D6B-11，批次 C）；
- 真实 Windows Electron 联调（批次 C/开发者事后，三态升「已真实联调」）；
- `desktop.command.run`（确认不注册）；local_worker 工具（无 Worker 接口 E-09）；
- 设置页「安全与权限」子页落地（D6B-14）；
- `action` 兼容帧移除评估（阶段 8）；
- 跨页/跨会话归档配对（批次 C 查看器按上下文重配对）；
- 写文件编码转换能力（仅格式保留，不做编码转换 UI）；
- capture 平台扩展（Wayland portal / 录屏 / 定时捕获——明确禁止）。

## 7. 前置动作与风险

- **前置**：后端 `03a6e882` 未 push（纪律：永不代 push）；本批不依赖后端新端点才可开发——`POST /api/uploads/desktop/{callId}` 契约来自 doc 02 §10.3 已确认映射，real 路径实现先行、mock 占位，真实联调批次 C 复核；jsdiff 依赖新增走 feature 提交（无门禁额外要求）。
- **R1（集成测试稳定性）**：xvfb + SwiftShader 观察成本（阶段 5 批次 C C1 集成 CI 失败先例 `docs/review/2026-08-19-阶段5批次C-C1集成测试CI失败-待办.md`）→ capture 与 Live2D 集成用例**软断言 + 降级条款**（不可用则跳过并记录取舍，单测已全覆盖）；核心闭环（read/write 决策链/拒绝/冲突）不做降级。
- **R2（mock 附件上传不可用）**：mock `uploadToolAttachment` 返回占位 URL（D6B-15），集成测试只断言附件元数据/卡片「含 N 个附件」，不渲染预览；真实上传归批次 C。
- **R3（事件流重复）**：desktop `tool.request` 不再 emit chat:event（D6B-08）——批次 A 集成/Renderer 无该事件消费者（batch A R-A2 已跳过），无回归面；mapper 纯函数与单测不变。
- **R4（平台差异）**：Windows 路径（大小写/UNC/ADS/重解析点）与 Linux inode 复核差异——SafeOpenPlatform 注入复用 + win 专属单测平台守卫（FE-S1-P0-01 先例）；本机 Linux 无法真跑 Windows 分支（平台守卫单测 + 批次 C 真机）。
- **R5（重连语义 mock 不可测）**：重连重发逻辑单测覆盖（tool-service 注入 fake submitStatus 失败/重连）；集成不做（mock 无断线），记录取舍。
- **R6（dataFlowNote 传输）**：`PublicToolEvent.dataFlowNote` 为 registry 静态文案（非敏感），经 tool:event 下发安全；若 review 认为不必要可退回「卡片用 title+description 静态文案」（描述性，不引注册表）。
- **R7（selected-set 语义）**：10 分钟 TTL + 连接会话（D6B-20）；若真实联调发现后端 read 请求与 select 间隔超 TTL → 批次 C 调参（常量可改）。

## 8. 验收清单与执行纪律

- [ ] tool-registry 四工具 + tool-policy 黑名单默认集（D6B-02）落地；未知名称/版本/运行时拒绝
- [ ] tool-service 决策链全分支（注册表/schema/幂等/paramHash/黑名单不弹窗/风险重算/selected-set 豁免/授权/执行/超时/取消）+ 8 态单向前进 + 终态不重回执行
- [ ] 四执行器：select（取消非错误+selected-set）/ read（2 MiB 上限 + 64 KiB 内联 + 附件上传 + 二进制拒 + TOCTOU）/ write（Diff + 写前哈希 FILE_CONFLICT + 原子替换 + 格式保留）/ capture（Win+X11 + Wayland 降级 + 三步确认）
- [ ] tool-status-sender 组装 + `adapter.submitToolResult`（real WS / mock 记录+归档）+ `adapter.uploadToolAttachment`（real `POST /api/uploads/desktop/{callId}` + `X-Client-Connection` / mock 占位）+ 断线重发
- [ ] IPC：`tool:event/decide/cancel/list/pick-source/confirm-upload` 六通道 zod 双端 + `SCHEMA_VALIDATION_FAILED` + `isTrustedSender`；preload 具名窄 API；`PublicToolEvent` 无原始参数/安全元数据
- [ ] toolStore 三来路归一化 + 终态单向 + D6B-21 合并 + waitingForApproval + 双区渲染（CyLiveToolCards 实时区 ≤3 条 + CyMessageBubble 归档只读卡片）；`MessageSchema.toolCalls` 补字段（preload 剥字段修复）
- [ ] CyToolCard + CyToolApproval（四问/拒绝按钮对等/无倒计时/关闭=拒绝/写 Diff+格式元信息/截图三步/焦点陷阱回焦）；backend 卡片只读；tool 角色消息不渲染空气泡
- [ ] Live2D `waiting_permission` 接线（不打断 speaking/thinking）；mock 改接 `toolRequestSink` → tool-service 统一入口（desktop kind 不再直发 chat:event）
- [ ] R-A3 `error:''` 加固 + jsdiff 依赖（^9.0.0）+ 承载项完成
- [ ] 门禁全绿：typecheck / lint / test（新增单测全绿）/ xvfb-run test:integration（electron-tools.spec.ts）/ build / check:contract（WS 32/32 + 8 未纳 warn；REST 15/15；**manifest 不刷新**——除非 raw wire 变更）
- [ ] 文档同步（§5 表）+ 决策记录 `docs/review/2026-08-20-阶段6批次B-决策记录.md` + doc13 交叉 review 结论
- [ ] 三态 = 已开发、未联调（真实 Windows Electron 联调归批次 C/开发者事后）

**执行纪律**：执行中若出现对 §0 决策的偏离，按既定流程处理——按推荐执行 → 记入决策记录（`docs/review/2026-08-20-阶段6批次B-决策记录.md`）→ 最终报告汇报。**最终报告必报项**：预检拍板 F-06/F-07/F-09/F-10（AskUserQuestion 四项落点）、推荐定案 D-§7-4（read 上限/附件回传）与 D-§7-5（action 保留期）、本 spec 全部 review 修复记录、执行期 Rulings、门禁结果、三态结论与批次 C 前置。
