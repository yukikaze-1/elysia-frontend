# Cyrene 前端测试与 Demo 验收方案

**文档状态：** 参考（测试策略基线）
**最后核验：** 2026-08-29
**适用阶段：** 阶段 0～8
**权威范围：** 测试分层与验收方法；当前命令和结果以 package scripts、CI 与验收记录为准
**初始文档日期：** 2026-08-03

> **状态说明：** 正文中的带日期实施/联调注记只代表当时快照；当前阶段、阻塞项和最近验证统一读取 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)。

---

## 1. 测试目标

- 证明聊天、Live2D、后端连接和 Desktop 工具四条主链路可运行；
- 证明断线、失败、拒绝和取消不会破坏用户数据；
- 证明 Renderer 无法绕过安全边界；
- 证明 Windows 和 Ubuntu 的关键平台差异已验证；
- 为后端协议继续演进提供稳定的 Adapter 契约测试。

## 2. 测试分层

```text
少量人工验收与真实系统能力测试
          ↑
端到端测试：用户主流程
          ↑
集成测试：进程、Adapter、Store、工具
          ↑
单元测试：Schema、状态机、纯函数
```

单元测试数量最多；真实系统选择器、Wayland 截图、GPU 和安装过程需要人工或平台专用自动化补充。

## 3. 测试环境矩阵

P0：

| 平台 | 环境 | 重点 |
|---|---|---|
| Windows | Windows 10 x64 | 启动、文件、截图、安装 |
| Windows | Windows 11 x64 | 主验收环境 |
| Ubuntu | 22.04 LTS GNOME X11/默认会话 | 打包、文件、显示 |
| Ubuntu | 22.04 或 24.04 Wayland | 系统截图授权 |

建议覆盖常见 100%、125%、150% 显示缩放，以及最小窗口尺寸。

## 4. 测试替身

建立可配置的 Mock Backend，支持：

- 正常会话和历史；
- 按固定节奏发送流式增量；
- 重复、乱序和缺失序列；
- 中途断线和恢复；
- 认证失败和协议不兼容；
- Backend Runtime 工具状态；
- Desktop Runtime 文件和截图请求；
- 未注册工具和非法参数；
- 超大消息、超时和错误码；
- Live2D 合法及非法指令；
- 同一消息中交错的 Inner Voice 与 Public Reply；
- 同一 `responseId` 的多句分段、分段完成与父回复完成；
- 回复/会话 Token、实际模型和心情；
- 图片、视频、音频、表情包消息，以及统一历史查看器的日期/分类分页和搜索命中；
- LLM、STT、TTS Profile 列表、测试、切换和失败，以及输入法转写专用 STT 选择；
- 三类自定义 LLM/STT/TTS Profile 的新增、编辑、类型化测试、激活和删除；
- 自定义模型 Endpoint 的 HTTPS、本机 Provider、重定向、私网/元数据地址和危险 Header 拒绝样例；
- 点击选择、拖拽、粘贴附件以及非法/超量文件；
- 普通录音输入、实时语音字幕/断句/轮次和麦克风权限；
- 输入法转写的按住/松开/取消、Backend/本机/Local Worker 执行位置、仅写入草稿语义；
- 沙盒、路径/域名黑名单、授权历史和命令模板。

Mock Backend 的事件样例也作为 Adapter 契约测试夹具。

## 5. 单元测试

### 5.1 协议与 Schema

- 事件外壳必填字段；
- 时间、枚举、大小和嵌套深度；
- 未知可选字段兼容；
- 未知事件不触发本地能力；
- 后端原始字段到领域模型的映射；
- 错误结构转换；
- 附件元数据校验。

### 5.2 流式消息

- started → delta → completed；
- 重复增量；
- 乱序后恢复；
- 序列缺失；
- 中断保留文本；
- 取消后迟到增量不继续写入；
- Markdown 刷新节流；
- 同时存在多个会话生成；
- Inner Voice 与 Public Reply 交错到达仍合并为同一条消息；
- 两个通道分别重复、乱序、中断和完成；
- 10 个连续句子分段共享 `responseId` 时只创建一个父消息；
- `segment.completed` 不结束父回复，`generation.completed` 才结束；
- 父完成事件先到但仍有序列缺口时进入待校验，不丢迟到补块且不会伪装完整；
- `segmentIndex` 全局排序，`deltaSequence` 分段内排序；
- 完成事件正确写入消息/会话 Token、实际模型和心情。
- 重复完成事件不会把会话 Token 重复累计，服务端累计与本机累计来源可区分；

### 5.3 Store

- 会话规范化和排序；
- 乐观消息确认与回滚；
- 每会话草稿；
- 切换会话保持状态；
- 删除会话清理引用；
- 工具终态不可逆；
- Live2D 高优先级状态恢复；
- 模型 Profile 测试和激活状态；
- 自定义 Profile 表单校验、密钥即时清理和删除当前 Profile 保护；
- 拖拽附件来源、待发送队列、取消和发送后清理；
- 直接语音 partial/final 字幕合并且不会修改文字草稿；
- 输入法转写最终文字插入、取消清理、无语音消息和无自动发送；
- 聊天历史查看器的关键词/日期/分类组合状态和来源跳转；
- Emoji 插入与表情包待发送、历史索引状态；
- 字体、强调色和 Live2D 模型切换状态。
- 历史游标、滚动锚点、会话/消息搜索和资源索引引用；
- 图片、视频、音频播放/失败状态不复制消息实体。
- 支持与不支持的媒体编解码器均有可解释预览/下载状态；

### 5.4 工具和权限

- 工具注册表唯一性；
- 参数 Schema；
- 本地风险覆盖后端风险；
- 权限允许、拒绝、关闭和超时；
- 相同 `callId` 幂等；
- 相同 ID 参数变化被拒绝；
- 取消和超时状态；
- 审计脱敏；
- 沙盒、路径黑名单、域名黑名单和历史授权优先级；
- 已授权命令模板的参数和工作目录约束。
- 受控命令不经 `PATH` 搜索，可执行文件被替换后旧授权失效；

### 5.5 文件安全

- 路径规范化；
- `..` 路径穿越；
- 符号链接或连接点逃逸；
- Windows UNC、设备路径、ADS、大小写变体和重解析点；
- 敏感路径；
- 文件大小、类型和编码；
- UTF-8/UTF-16、BOM、CRLF/LF、末尾换行和无法无损解码；
- 写前哈希冲突；
- 临时文件和原子替换失败；
- 原文件在失败后保持不变。

### 5.6 Live2D

- 状态映射；
- 动作优先级和打断；
- 未知动作/表情；
- 嘴部值范围和平滑；
- 隐藏时暂停；
- 失败降级。

## 6. 集成测试

### 6.1 Main ↔ Preload ↔ Renderer

- 只允许公开接口；
- 非法参数在 Main 被拒绝；
- 事件订阅可正确取消；
- 窗口销毁后无残留监听；
- 错误只返回公开信息；
- Renderer 无法指定任意 IPC 通道。

### 6.2 BackendAdapter ↔ Store

- 连接协商；
- 会话列表和消息映射；
- 流式事件驱动 UI 状态；
- 断线与重连；
- 恢复游标；
- 原始后端字段不进入组件；
- 后端协议错误可定位到 Adapter。

### 6.3 Desktop 工具

- 后端调用进入 Main；
- Main 校验后通知 Renderer；
- Renderer 展示正确摘要；
- 用户决定回到 Main；
- 执行结果回传 Mock Backend；
- 回传失败后保留结果并重试；
- Backend Runtime 状态只展示、不本地执行。
- Backend 服务器审批可以回传决定，但不会创建/复用 Desktop 本地 Grant；

### 6.4 本地存储

- 设置保存和读取；
- 凭据状态不泄漏明文；
- 缓存迁移；
- 缓存损坏恢复；
- 日志轮转；
- 清除缓存与清除凭据相互独立；
- 模型服务 Profile、语音、外观和 Live2D 切换设置；
- 权限审批历史、授权撤销和安全策略持久化；
- 开发者模式和前端日志目录。

### 6.5 测试运行期窗口行为（Silent Test Window Mode）

自动化测试**不得干扰宿主桌面**：窗口不显示、不抢焦点、不置顶、不进任务栏、不弹系统对话框与通知，
但 renderer / preload / IPC / 持久化 / Playwright 自动化能力必须保持原有行为
（判据与边界模块见[决策记录](review/2026-09-12-测试静默窗口模式-决策记录.md)）。

- 默认（`pnpm test:integration`）：静默模式；并由 `tests/integration/silent-window-mode.spec.ts`
  断言窗口不可见、未聚焦、未置顶、窗口数恒为 1，且隐藏窗口下 `document.hidden === false`、
  rAF 帧率未被后台节流压到 ~1 帧/秒、键盘输入与 DOM 焦点正常；
- 显式（`pnpm test:integration:visible`）：同一套件的可视化调试模式，窗口真的显示；
- 窗口行为回归由源码门禁 `tests/unit/window-presentation-guard.spec.ts` 兜底：
  任何新增的建窗、`show()`/`focus()`、`setAlwaysOnTop()`、`dialog.*`、Notification/Tray/DevTools
  调用点都会使单测变红，必须改走统一边界；
- 原生对话框在静默模式下不弹出，而是记录调用并返回确定性的「用户取消」，测试仍可断言
  「是否触发 / 参数是否正确 / 取消是否被正确处理」；需要「用户确实选了某路径」的分支用既有注入缝
  （`pickFile` / `pickDirectory` / `openPath`）。

## 7. 端到端场景

### E2E-01 首次启动

1. 启动应用；
2. 显示服务器配置引导；
3. 填写地址和凭据；
4. 测试连接成功；
5. 进入无会话空状态；
6. 重启后普通设置保留，Token 不出现在页面源码或普通配置中。

### E2E-02 普通聊天

1. 新建会话；
2. 输入中文和换行；
3. 发送；
4. 显示流式 Markdown；
5. 代码块可复制；
6. 完成后 Live2D 回到空闲；
7. 切换会话再返回，内容和滚动位置合理。

### E2E-03 停止生成

1. 开始长回复；
2. 点击停止；
3. 已生成内容保留；
4. 后续迟到增量不继续追加；
5. 可以重新生成。

### E2E-04 断线恢复

1. 流式生成中断开连接；
2. UI 显示重连并保留内容；
3. 网络恢复；
4. Adapter 续传或重新同步；
5. 不出现重复消息。

### E2E-05 文件读取

1. 后端请求读取文本文件；
2. 权限窗口显示原因、目标和上传范围；
3. 用户允许；
4. Main 读取并回传；
5. 工具卡片完成；
6. 日志不含完整内容。

### E2E-06 文件写入与冲突

1. 后端请求修改文件；
2. 显示差异；
3. 用户允许；
4. 执行前外部修改原文件；
5. 客户端检测冲突并停止覆盖；
6. 原文件保持外部修改后的内容。

### E2E-07 权限拒绝

1. 收到截图请求；
2. 用户拒绝或关闭窗口；
3. 不发生截图；
4. 后端收到拒绝；
5. 聊天仍可继续。

### E2E-08 截图

1. 用户允许请求；
2. 选择屏幕或窗口；
3. 预览并确认上传；
4. 返回附件结果；
5. 临时文件按策略清理。

### E2E-09 重复工具事件

1. 完成一次文件写入；
2. 重连后重复发送同一 `callId`；
3. 客户端返回之前状态；
4. 文件不再次写入，权限窗不再次出现。

### E2E-10 Live2D 降级

1. 模拟模型资源损坏或渲染失败；
2. 显示静态头像；
3. 聊天、工具和权限流程仍正常；
4. 设置页可以重新加载或禁用。

### E2E-11 双通道 AI 回复

1. 后端在同一 `responseId/messageId` 中交错发送 Inner Voice 和多个 Public Reply 句子分段；
2. UI 只显示一组头像、时间、模型、心情和消息操作区；
3. 各句保持连续气泡节奏，且全局顺序正确；
4. Inner Voice 可以折叠，Public Reply 可以单独复制和朗读；
5. 消息 Token 与会话 Token 在父回复完成后更新；
6. 重连后父消息和各分段都不重复。

### E2E-12 模型服务和语音

1. 在设置中分别测试 LLM、STT、TTS Profile，并为输入法转写选择一个专用 STT Profile；
2. 分别新增一个自定义 LLM、STT、TTS Profile，执行类型化测试并保存；
3. 切换当前 Profile，确认只影响新请求；
4. 编辑 Profile 时密钥不回填，删除当前 Profile 前要求替代选择；
5. 验证远程 HTTP、云元数据/未授权私网、跨域带密钥重定向和危险 Header 被拒绝，本机 Provider 仅在显式模式下可用；
6. 使用普通录音输入，停止后只生成待发送音频，不自动发送；
7. 使用实时语音会话观察 partial/final 字幕和语音轮次；
8. 确认直接语音字幕始终不写入文字输入框；
9. 模型执行位置失败时安全失败；未经确认不得把本机音频改传后端；
10. 按住“说话转文字”，松开后确认最终文字只进入输入框且可编辑；
11. 取消转写时不改变草稿，不创建语音消息；分别验证 Backend、本机与 Local Worker 的数据去向提示和失败清理。

**阶段 4 批次 B 增补（2026-08-16，对应 spec §8 验收清单，Mock 驱动标「已开发、未联调」）：**

- [ ] 普通录音输入与实时语音会话可**独立启用/停用**（设置开关生效）；
- [ ] 普通录音停止后只生成待发送语音输入（字幕/试听/重录/删除/确认发送），直接语音字幕不写入文字草稿；确认发送 → `voice.commit` → 用户消息 + 流式回复正常；
- [ ] 输入法转写按住→松开 → `dictation.final` 只写草稿，不创建语音消息、不自动发送；上滑取消 → `dictation.cancelled`；
- [ ] 输入法转写可**独立选择 STT Profile**（`dictationSttProfileId` 本地设置生效，`dictation.start.sttProfileId` 正确透传；缺省用全局活动 STT）；
- [ ] 实时语音会话：启动→连续音频→字幕显示→轮次自动提交触发 generation→停止；背压不丢音频；5s 无 ack 不永久暂停；
- [ ] TTS 自动朗读 AI 回复（D3），设置关闭后不再播放；`audio.cancel` 打断生效；播放中断/URL 失效（onerror）播放态回落；
- [ ] **后端 STT 首次操作前一次性同意提示**（含「不再提示」持久化 `voice.consentBackendStt`）；拒绝则中止；
- [ ] **语音错误（如 `STT_UNAVAILABLE`/`VOICE_SESSION_CONFLICT`）显示在语音 UI，不显示全局连接错误横幅**（D-P15）；
- [ ] 语音设置**持久化**（重开保留）；损坏文件 fail-open 回默认；
- [ ] 会话切换守卫：语音会话活跃时禁止切换（提示）；
- [ ] 断线/停止时采集与播放清理（无泄漏、无残留状态）；
- [ ] 删除被转写引用的 STT Profile → 转写回退全局活动 STT + 提示。

### E2E-13 拖拽附件

1. 将图片、视频、音频和普通文件一起拖入聊天区域；
2. 拖入时显示投放层，离开时投放层消失；
3. 松开后生成待发送附件条目，但不上传、不发送；
4. 移除一个附件，补充文字后发送；
5. 验证剩余附件经过统一校验和上传流程；
6. 拖入目录、超量或不支持文件时逐项显示错误，现有草稿不丢失。

### E2E-14 安全策略与历史授权

1. 添加沙盒目录；
2. 添加路径和域名黑名单；
3. 建立范围目录授权；
4. 验证黑名单覆盖授权；
5. 查看审批历史并撤销授权；
6. 查看并撤销已授权命令模板；若本版启用 `desktop.command.run`，再执行模板并验证参数不能突破约束。

### E2E-15 外观、Live2D 和诊断

1. 切换两个已安装 Live2D 模型；
2. 调整字体和强调色；
3. 打开前端日志目录；
4. 开启开发者模式；
5. 确认应用日志、内置调试面板和导出包不包含凭据、完整消息、Inner Voice 或录音；开启 DevTools 前有当前页面可见性警告，且不能读回已保存凭据。

### E2E-16 聊天历史查看器

1. 向上懒加载三页历史，当前可视消息不跳动；
2. 搜索会话标题和摘要并切换会话；
3. 打开聊天历史查看器，组合关键词和日期查询并跳转到目标回复组/分段；
4. 使用本地时区午夜前后的消息验证自然日归类，并切换当前会话/全部会话范围；
5. 分别筛选全部、图片/视频、表情、文件、音频、链接，确认会话媒体与搜索结果均在此处；
6. 预览图片、播放视频与音频，并从资源或表情跳回来源消息；
7. 插入 Emoji、选择表情包，确认不会自动发送；发送后表情出现在历史查看器；
8. 模拟资源失效和分页失败，聊天仍可继续且错误状态可解释。

## 8. 安全测试

- Markdown 中脚本、事件属性和危险协议；
- 外部导航和新窗口拦截；
- Renderer 尝试访问 Node.js；
- 非白名单 IPC；
- 超大 IPC 和网络消息；
- 未注册工具；
- 任意命令参数；
- 敏感文件路径；
- 权限后参数篡改；
- 重放和乱序工具事件；
- 认证 Token 在配置、Store、日志和错误中的泄漏扫描；
- 更改后端 Origin 或跨域重定向时旧 Token 不被转发；
- 自定义模型 Endpoint 的 SSRF、DNS Rebinding、重定向和敏感 Header 泄漏；
- Inner Voice、Public Reply、转写和录音的日志泄漏扫描；
- 历史授权、命令模板和黑名单绕过；
- 开发者模式下的脱敏；
- 生产构建开发者模式/DevTools 默认关闭、显式开启门槛和远程调试端口始终关闭检查。

**阶段 7 批次 A 矩阵补充（2026-08-22，对应 spec §8 核对表，Mock 驱动标「已开发、未联调」）：**

| 面 | 门禁层 | 证据 |
|---|---|---|
| Markdown/XSS 与危险链接 | **真实 Chromium 集成**（markdown-xss.spec.ts）= 安全门禁层（单元层 happy-dom 仅行为记录——DOMPurify 官方 README 明确 happy-dom 非可信消毒 oracle，用例保留/断言不弱化/`it.fails` canary） | 载荷集：`<img src=x onerror>` / `[x](javascript:alert(1))` / `[x]( data:text/html,…)` / `[x](java\tscript:…)`（TAB 内嵌）/ `<svg onload>` / `<style>body{display:none}</style>` / `<iframe srcdoc>` / `<div style=url(javascript:…)>`——`window.__xssFired` 哨兵未置位、无 `on*`/`style=` 属性、`a[href^="javascript:"]`/`a[href^="data:"]` 计数 0（含前导空白变体）、无 iframe/object/embed/svg/style 元素、页面 URL 不变（点击不导航） |
| 导航/窗口/CSP/媒体 | 集成负方向扩展（navigation 正方向为基线） | `will-navigate` 对 `javascript:`/`data:` deny、`setWindowOpenHandler` 非 http(s) 拒绝、media 无签名/错签名拒绝（protocol-media-handler 既有补断言面）、dev meta 与 prod 响应头关键指令对照（均为补断言无实现变更预期） |
| IPC 非法通道/超大参数/类型混淆 | 集成（ipc-security 扩展）+ 单测（ipc-limit 核对表） | 桌面 API 暴露面白名单（表**刻意硬编码**、不从 `IpcChannels` 派生）；**2026-09-11 后为 95 键**（本行原写的「67→73」是 2026-08-22 快照，已过期，现值与逐次增量依据见 `ipc-security.spec.ts:24-27`）、未知通道 invoke reject、>4MiB 结构拒、类型混淆抽样；无界字段 maxLength 补全核对表（title 200/搜索 512/消息 content 64KiB/语音 commit 10KiB/attachment 路径 1024/rename 200——D7A-13）+ 既有 4MiB/1MiB/2048/4097 引用断言（含 openExternal>2048 拒） |
| 路径/重放/授权后参数 | 核对表式断言（引用既有实现 + 无回退哨兵） | safe-open Windows 变体/UNC/ADS、paramHash canonical、callId 幂等、queryStatus 三分支（阶段 0/1 与 6 既有实现证据） |
| 敏感信息泄漏扫描 | **verify:sensitive 常驻门禁**（`pnpm -F @cyrene/desktop verify:sensitive`；CI 与 typecheck/lint 同 job） | `git ls-files` 全树、黑名单 8 规则、排除 third_party/+vendored live2d 两树 + 扫描器自排除、行级 allowlist fail-loud 锚定；导出二次脱敏由 buildExportPayload 单测钉住（黑名单零命中 + 关键值 `[REDACTED]`） |
| Fuses | verify:artifact 静态阶段（不启动 Electron）| `getCurrentFuseWire` 读回 RunAsNode/EnableNodeOptionsEnvironmentVariable/EnableNodeCliInspectArguments 三项 = DISABLE（48 字节枚举），失败 exit 1（fail-closed）；`--smoke` 经 flip-back 临时副本启动（产物本体保持 flipped）；OnlyLoadAppFromAsar/EmbeddedAsarIntegrityValidation 保持现状（阶段 8 评估） |
| 开发者模式 | 集成（diagnostics-ipc.spec.ts）+ 单测（diagnostics-service/cy-diagnostics-pane） | `dev-mode-set(true)` → **判据按运行模式分叉**（2026-09-14 更正，`:84-95`）：`test:integration:visible`（可见）下轮询 `webContents.isDevToolsOpened()` 为 true（恢复断言而非静默降级）；默认**静默**下**不得创建第二个窗口** ⇒ `isDevToolsOpened()` 必须为 false 且窗口数恒 1。set(false) → false；二次确认文案；会话态（重启恢复禁用，无持久化断言）；诊断展示零正文（preview 白名单/Store 摘要仅计数） |

**全量评审批次新增/变更的门禁（2026-09-11 ~ 09-13，P1-1/P1-11/P2-3/P2-6/P2-7/P2-9/P2-10 + 09-13 的 lint 全集与 ④ 收口）**

下表只列**新加或改过判据**的门禁——它们的存在方式是"会红"，因此需要知道各自守什么、怎么让它红：

| 门禁 | 位置 | 守什么 / 如何变红 |
|---|---|---|
| IPC 通道预算声明 | `tests/unit/ipc-budget-declaration.spec.ts` | 枚举**实际注册**的通道（经 electron mock 捕获），逐个核对是否在 `IPC_CHANNEL_BUDGETS` 声明规模上界；新增通道未登记即红。**上线首次运行即抓到 `credentials:get-status` 未登记**。注意：本门禁让"遗漏可见"，**不等于**"已在运行时强制"——运行时收口经实测后撤回，理由见 `main/ipc/registry.ts` 头注 |
| 依赖归类 | `tests/unit/dependency-classification.spec.ts` | 双向：`dependencies` 里每个包必须被 main/preload 用到（防死重）；main/preload 用到的必须在 `dependencies` 里（防打包缺模块）。加 `vue` 回 dependencies / main import devDependency 均即红 |
| 临时目录防漂移 | `tests/unit/temp-dirs.spec.ts` | 扫描全部测试源码的 `mkdtemp` 前缀，未登记到允许表即红并点名；反向查"已无人使用"的条目。**实际已抓到两次**：P2-10 新 spec 的 `cyvs-`（见 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md) §P2-10），以及变异验证时从允许表移除 `cy-atomic-out-` ⇒ 红并点名 `atomic-write.spec.ts`。**更正（2026-09-14 评审报告 §10.3 D8-7）**：本行原举的「`credentials:get-status` 类的漏登记」归错门禁——那是**上一行 IPC 通道预算声明**门禁的战果，与本门禁的 `mkdtemp` 前缀扫描无关 |
| 契约镜像（键集合相等） | `tests/unit/contract-mirror.spec.ts` | `SameKeys<z.infer<schema>, 契约类型>` 双向比较，`keyof` 含可选成员——比 `z.ZodType<T>` 锚点强（后者**协变**，抓不到"漏可选成员"）。删 `ToolCallRecordSchema.diff` 即 `tsc` 红 |
| 布局断点不可达 | `tests/unit/layout-breakpoints.spec.ts` | 任何 `@media (max-width: N)` 且 `N < MIN_WINDOW_WIDTH` 即红（比较真实常量）；带退化哨兵（内联夹具证明提取器仍可用） |
| 渲染缓存有界 / 估算器记忆化 | `tests/unit/h08-perf-bounds.spec.ts` | 用**可数**信号（真实计算次数、缓存条目数）而非计时断言；移除记忆化 → `expected 100 to be 20` |
| renderer 错误进诊断日志 | `tests/integration/renderer-error-diagnostics.spec.ts` | 真机读 Main 日志：`console.error(marker)` 与未捕获异常都必须落盘；移除 `console-message` 转发即红 |
| 流式贴底"不累积" | `tests/integration/message-list-follow-bottom.spec.ts` ④ + `tests/unit/cy-message-list-follow-intent.spec.ts`（**2026-09-13 新增，确定性**） | 集成侧：稳健统计（中位数 ≤200px + ≥60% 采样在容差内）+ 收敛断言（终值 ≤40px）。**刻意不用 `max(samples)`**：那会把瞬时抖动误判成缺陷。单测侧：happy-dom 不做布局，故**三个几何量由用例直接给定**，把"贴底写入后浏览器回退 31px"变成可重复输入（判据＝跟随意图只被"累计上移 ≥64px"清掉）。**变异**：门限改 1（＝修复前行为）⇒ 5 条里 3 条红；集成侧判据一字未改 |
| 扫描器端到端 | `tests/unit/verify-sensitive-e2e.spec.ts` | **真 spawn** `verify-sensitive.mjs`：干净树 → 退出码 0（且扫描面来自 `git ls-files` 外调）／植入秘密 → 退出码 1 且 stderr 指名文件与规则；allowlist 宽锚集合被钉死（**2026-09-14 起该集合为「空集相等」**：原「现存 4 条为已记录欠账」已被取代，4 条纯通配锚全部收窄到具体字面量，用例名与断言见 `verify-sensitive-e2e.spec.ts:305`/`:320`；再加通配锚即红） |
| 审计断言可判别性 | `tests/integration/audit-lifecycle.spec.ts` | 解析 JSONL 断言 `type` **与** `status`，并与 page 侧观察到的 API 结果对齐。**旧写法 `.toContain('credential:set')` 同时匹配 success/failed**，把"成功路径写成 failed"放行；改后该变异即红 |
| Windows 打包与产物 | CI job `windows build-level` | 2026-09-12 起该 job 除 typecheck/lint/test/build 外**还跑 `package` + 静态 `verify:artifact`**（含 `dist/win-unpacked/Cyrene.exe` 的 fuse wire 读回）。此前主目标平台的打包路径**从未被 CI 验证**。同日该 job 改钉 self-hosted（`[self-hosted, Windows, X64]` + `timeout-minutes`），所验证内容不变 |
| **Windows 真实运行时** | workflow `windows-runtime`（self-hosted，**取证面，非必过门禁**） | 全量集成套件在 Windows 上跑（无 xvfb）。2026-09-12 本机取证：`27 files / 154 passed + 2 skipped`，350.7s（CI Linux 同套件 `155 passed + 1 skipped`，558.9s）。**覆盖增益**：`ipc-security` 凭据分支 = `empty`（safeStorage 可用 ⇒ **真实 DPAPI 加密往返**，而 CI Linux 恒为 `unavailable`、只走降级）；`audit-lifecycle` `setOk=true`（Linux 为 `false`）。**覆盖缺口**：`protocol-handler` 两条 symlink 逃逸用例因无 symlink 权限而**静默跳过**（9 tests \| 2 skipped，Linux 为 0 skipped）⇒ **Linux integration job 不得被本 surface 替换**。**已被 2026-09-13 实测取代**：该 runner 是**服务形态（Session 0、无交互桌面）⇒ 结构性跑不出运行时信号**（实测 `16 files / 43 tests` 红、378 次 not-visible；同机交互式 167/172、Linux+xvfb 169/172 通过），触发已改为**仅 `workflow_dispatch`**（见 `.github/workflows/windows-runtime.yml:25-26`/`:50-56` 与[决策记录](review/2026-09-13-Windows运行时在服务形态runner上不可用-决策记录.md)）。原「Session 0 可行性…未取证」措辞已过期 |
| **Linux 真实运行时（自建）** | workflow `linux-runtime`（self-hosted Ubuntu `yomu-X99`，**取证面，非必过门禁**） | 全量集成套件跑在自建 Ubuntu（xvfb）上，用于取**同 OS 家族**基线并为 integration 分片定标。**不替换**托管 integration job——Linux 是两条 symlink 逃逸断言的唯一覆盖点。self-hosted 差异（不带 `--with-deps`、不挂 `cache: pnpm`）与一次性系统依赖（xvfb、`playwright install-deps`）见[决策记录](review/2026-09-12-Windows运行时取证与CI平台归属-决策记录.md) |
| **集成套件分片** | CI：`integration`（3 分片，`--exclude '**/electron-live2d*.spec.ts'`）+ `integration-live2d`（**3 项 matrix，一文件一 job**）；**2026-09-12 起均在自建 Linux runner 上** | **已被 `72b9117`／2026-09-15 取代，原读数如下**：拆为原 `electron-live2d.spec.ts`（当时实测定标 182.3s）独占一个 job、其余 `--shard=N/3`。**按文件特性切而非均匀切**：`--shard` 只按路径哈希 + 文件数均分、不看耗时，重文件混进随机分片必然成为新瓶颈。分片数取 3 与回退路径见[决策记录 §9.3／§10](review/2026-09-12-Windows运行时取证与CI平台归属-决策记录.md)；现行分片与文件数见 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md) |
| 退出路径资源收口 | `tools` 单测 | `toolSvc.shutdown()` 必须清 `timers` **与** `captureTimers`（后者由 M1 引入的第二张表） |
| 「减少动态」覆盖完整性 | `tests/unit/reduce-motion.spec.ts` | 扫描 `src/renderer/src` 下**每一处** `animation: … infinite`，要求全部被 `reduced-motion.css` 覆盖，**反向**也查（覆盖规则指向已不存在的动画即红），并带退化哨兵（已知 ≥6 处）。注释剥离按「字符换空格、保留换行」处理，故报出的行号是原文行号。变异验证：删一条覆盖 → 红并点名 `CyChatInput.vue` 的规则行；加一条不存在的选择器 → 反向红 |
| **type-aware lint（生产代码全集）** | `eslint.config.mjs` + CI `typecheck + lint` job（2026-09-13） | `src/**`、`**/*.vue`、`scripts/**` 接入 `recommendedTypeChecked` 全集（实测 1238 条命中，其中生产代码 `src/**` 约 150 条已全部清零，其余在测试代码；口径见 `eslint.config.mjs:48-50`）。**判据来源可复核**：`.vue` 块的 `parser` 与 `parserOptions` 必须同块（拆开会整体覆盖 ⇒ 59 个 `.vue` 退回按 JS 解析，实测踩到过）；`scripts/**/*.ts` 已纳入 `tsconfig.node.json`（此前不在任何 project 里，接入当轮暴露并修掉 20 个类型错误）。**一条记录在案的例外**：`require-await` 经实测判定与本仓"实现 `Promise<T>` 契约"的写法不匹配（64 处无一是"忘了 await"），缺陷类由 `no-floating-promises`／`no-misused-promises`／`await-thenable` 把关；理由与计数写在配置注释里 |
| **type-aware lint（测试目录，全集）** | 同上（2026-09-13） | `tests/**` 接入 `recommendedTypeChecked` **全集**，只豁免两条经实测判定"在测试替身上前提不成立"的规则：`require-await`（474 条＝`async` 测试替身）与 `unbound-method`（73 条＝vitest 的 `expect(obj.method)` 惯例 + `window.confirm` 这类原生 this 无关函数）。其余实测 455 条 / 74 文件全部清偿（208 条自动修 + 逐条判语义）。**修法口径**：优先给值标注真实类型（`vi.fn((input: CharacterListQuery) => …)`），使契约漂移时测试**编译失败**；其次 `unknown` + 判型。禁止 `any`/`as any`/`@ts-ignore`/`eslint-disable`（复核时按这三个模式扫 diff）。理由与计数见[决策记录 §3](review/2026-09-13-右键菜单锚点与一族flaky根因-决策记录.md) |
| **帧类型清单「文档 ↔ 代码」（2026-09-14 新建）** | `tests/unit/contract-doc-frame-inventory.spec.ts` + doc 02 §19.2 机器校验锚点 | 补的是 **"文档 ↔ 代码"这段此前没有任何门禁的缝**：既有 `check:contract` 比的是"代码 ↔ 后端"，于是代码认了、文档没记的漂移会静默累积——`typing`／`character.state.changed`／`character.catalog.changed` 三型就曾长期如此（`git show HEAD` 全文 0 命中）。做法是**集合相等**（非"提到过"）：脚本 `WS_V2_FRAME_TYPES` ⇔ doc 02 §19.2 清单行，**双向 + 顺序 + 声明条数**都校验，另查每个白名单类型都真有 `type: z.literal`（防"文档与白名单一起漂"）。**变异三次均红且点名**：从文档清单删 `typing` → "白名单里有、doc 没有: `typing`"；文档加 `made.up.frame` → 反向红；改白名单顺序 → 顺序断言红。带两道退化哨兵（抽取 <30 型即报"解析器失效"而非静默通过） |

## 9. 性能与稳定性

建议建立基线，不将数值视为尚未实测的承诺：

- 200 条混合消息滚动；
- 100 个回复组、每组 1～12 个句子分段的渲染和搜索；
- 统一聊天历史查看器 500 个资源条目的分页、缩略图回收和音视频停止策略；
- 统一历史查看器跨分类 500 个条目的分页、日期切换、关键词过滤和来源跳转；
- 长 Markdown 和大型代码块；
- 连续流式输出至少 10 分钟；
- Live2D 30/60 FPS 下 CPU、GPU 和内存；
- 窗口隐藏后资源下降；
- 连续切换 100 次会话；
- 重复加载/卸载 Live2D；
- 连续执行 100 次无副作用 Mock 工具；
- 应用待机数小时后内存趋势；
- Renderer 崩溃后的窗口恢复。

发现持续增长时应保留可复现脚本和快照，不只记录“内存较高”。

## 10. 人工平台验收

### Windows

- 安装、启动、卸载；
- 高 DPI；
- 文件选择和覆盖确认；
- 多显示器截图；
- 凭据保存；
- 系统浏览器打开外部链接。

### Ubuntu

- 安装包运行；
- GNOME 桌面；
- X11 和 Wayland 截图；
- Secret Service；
- 多显示器；
- GPU 不同环境下 Live2D；
- 外部链接和文件对话框。

## 11. 缺陷分级

| 等级 | 定义 | Demo 门槛 |
|---|---|---|
| Blocker | 无法启动、数据破坏、权限绕过、凭据泄漏 | 必须为 0 |
| Critical | 主链路不可用、重复副作用、安全边界失效 | 必须为 0 |
| Major | 重要功能失败但有规避方式 | 明确评估，原则上修复 |
| Minor | 非关键视觉或体验问题 | 可记录已知问题 |

## 12. Demo 演示脚本

1. 启动并连接现有后端；
2. 新建会话并完成流式聊天；
3. 展示 Markdown、代码块和停止生成；
4. 展示一条回复中的 Inner Voice、多句 Public Reply、Token、模型和心情；
5. 展示图片/视频/音频/表情消息、历史懒加载，以及按日期和分类筛选的聊天历史查看器；
6. 展示普通录音输入/实时语音字幕与按住说话转文字：直接语音字幕不进入输入框，输入法转写文字进入草稿且不会自动发送；
7. 展示 Live2D thinking、speaking 和口型，并确认角色栏在右侧扩展而非覆盖聊天；
8. 后端执行一个 Backend Runtime 工具，前端展示状态；
9. AI 请求 Desktop 文件读取，用户允许并回传；
10. AI 请求写文件，展示 Diff 后完成；
11. AI 请求截图，用户选择并确认上传；
12. 重复发送同一工具调用，证明不重复执行；
13. 断开网络并恢复；
14. 禁用 Live2D，证明纯聊天仍可使用；
15. 查看脱敏工具记录。

## 13. 发布门槛

- [ ] 单元和集成测试通过；
- [ ] 主 E2E 场景通过；
- [ ] 双通道回复、模型切换、语音输入和安全策略 E2E 通过；
- [ ] 直接语音字幕与文字草稿隔离，输入法转写只写入草稿；
- [ ] 自定义 LLM/STT/TTS、输入法转写专用 STT 选择与拖拽附件 E2E 通过；
- [ ] 回复分段归组、Token/模型/心情、多媒体、表情包和统一历史查看器 E2E 通过；
- [ ] Live2D 右侧扩展布局与按住说话转文字 E2E 通过；
- [ ] Blocker 和 Critical 为 0；
- [ ] Windows 主验收通过；
- [ ] Ubuntu 至少一次完整链路通过；
- [ ] Wayland 截图权限流程有实机记录；
- [ ] 安全发布门槛通过；
- [ ] 安装包来自可复现的发布构建；
- [ ] 已知问题、环境和版本已记录；
- [ ] Demo 演示脚本可重复执行。

## 2026-09-16 落地注记（门禁机制与新增用例）

- **零断言即红**：vitest 全局 `expect.requireAssertions`（unit + integration）。跳过必须用 `ctx.skip()`（计 skipped），裸 `return` 会红。开关一开即照出 4 处既有零断言用例并逐条处置。
- 新增：`tool-execution-abort.spec.ts`(15)、`redact-gate-parity.spec.ts`(5)、集成 `window-load-failure.spec.ts`(1)。
- `docs-check` 补 review/archive 断链**计数守护**（基线 43/26，超过即红并要求显式抬高）。
- 已知 flake：`renderer-crash-banner.spec.ts`（CDP 在崩溃窗口内附着失败）——失败形态已从 60s 挂死改为可读超时，poll 预算 30s；**残余偶发仍在**。
- 详见 [A/B/C 三批决策与变异记录](review/2026-09-16-审计剩余项ABC三批落地-决策与变异记录.md)。
