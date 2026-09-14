# Cyrene Electron 前端安全设计

**文档状态：** 维护中
**最后核验：** 2026-08-29
**适用阶段：** 阶段 1～8
**权威范围：** Electron 信任边界、凭据、IPC、内容、工具和发布安全
**初始文档日期：** 2026-08-03

> **状态说明：** 正文中的带日期实施/联调注记只代表当时快照；当前阶段、阻塞项和最近验证统一读取 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)。

---

## 1. 安全目标

Cyrene 会接收远程 AI 内容并能够在用户电脑上执行受控工具，因此安全边界必须从 Demo 开始建立。

目标：

- 后端、模型输出和聊天内容均视为不可信输入；
- Renderer 被攻破后仍不能直接获得 Node.js 和系统能力；
- Desktop Runtime 只能执行注册工具；
- 本地敏感数据只在必要、授权和限定范围内使用；
- 凭据只在用户主动填写时短暂存在于受控表单，不被持久化、读回、展示在普通页面或写入日志；
- 重放、断线和重复事件不导致重复副作用；
- 发布包来源、版本和更新可验证。

边界说明：Renderer 若被攻破，攻击代码仍可能读取当时正在页面中显示或由用户新输入的内容，包括尚未提交的密钥表单。安全目标是阻止它读回已保存凭据、直接调用系统能力或扩大到 Main；因此密钥表单按需打开、提交后立即清空，并依赖本地打包页面、CSP、净化和依赖治理降低 Renderer 被攻破概率。

## 2. 资产与威胁主体

### 2.1 需要保护的资产

- 用户文件和截图；
- 认证 Token、刷新凭据和后端地址；
- 本地工具权限；
- 会话内容和附件；
- 工具执行结果和审计记录；
- 应用更新和模型资源；
- 用户对当前操作的知情与控制。

### 2.2 需要防范的来源

- 恶意或被注入的模型输出；
- 被篡改或行为异常的后端；
- 恶意 Markdown、链接和附件；
- Renderer 中的 XSS；
- IPC 参数伪造；
- 路径遍历、符号链接和竞态；
- 重放的工具调用；
- 本机其他进程尝试连接 Local Worker；
- 被篡改的安装包或更新包。

## 3. 信任边界

```text
不可信区域：后端输入、模型文本、附件元数据、Renderer 内容
                         ↓ 校验/净化
受限区域：Preload 具名桥接、领域模型、权限 UI
                         ↓ 再校验/授权
高信任区域：Main、凭据存储、Desktop 工具执行器
```

不存在“来自自己的后端就可信”的例外。

## 4. Electron 基线

BrowserWindow 至少遵循：

```text
nodeIntegration: false
contextIsolation: true
sandbox: true
webSecurity: true
allowRunningInsecureContent: false
```

同时要求：

- 只加载本地打包的 Renderer；
- Renderer 优先通过权限受限的自定义协议加载，避免依赖具有额外本地文件权限的 `file://`；
- 自定义协议只服务打包资源和经过验证的受控附件，不提供任意磁盘路径映射；
- 限制新窗口创建；
- 禁止任意导航；
- 外部链接校验后由系统浏览器打开；
- 不开启远程调试端口；
- DevTools 在开发构建默认启用；发布构建默认关闭，用户可经设置页显式开启开发者模式（二次确认）后启用——会话态，重启恢复禁用（阶段 7 批次 A D7A-04/05 修订，见 §16/§17）；
- 任何构建都不得开放远程调试端口；
- 权限请求默认拒绝，按功能显式放行。

**已落地基线（阶段 1 块 A，2026-08-09）：**

- 打包/构建产物 Renderer 经 `cyrene://` 受限自定义协议加载（只读服务渲染根，fail-closed），替代 `file://` 路径映射；加载/协议注册统一谓词 `shouldUseViteDevServer = 未打包 && 有合法 ELECTRON_RENDERER_URL`——dev（electron-vite dev，含 `--mode test`）走 Vite http；**打包恒走 `cyrene://`，残留 dev env 无法劫持**；test/production 构建与 `--mode development` 直启同样走 `cyrene://`（协议注册与加载谓词同源，缺 handler 即 404 空白窗）；
- **远程调试门**：`main()` 顶部同步扫 `process.argv` + `commandLine` + `NODE_OPTIONS`，**开发态与打包态统一**命中即 failStart 退出（先于浏览器进程初始化，CDP 端口在 whenReady 前已绑定）——拒绝 `--remote-debugging-port`（显式端口/裸开关）、`--inspect`（显式端口/裸开关）、`--inspect-brk/-node/-brk-node/-wait/-wait-node`、`--remote-debugging-fd`（恒拒）、`--remote-debugging-pipe`（非 harness 拒）；**`--remote-debugging-port=0`/`--inspect=0` 默认也拒**，仅测试 harness env 标记 `CYRENE_TEST_HARNESS=1`（verify:artifact 冒烟注入）放行随机端口；`NODE_OPTIONS=--inspect` 系为纯 env 通道（argv/commandLine 均不含），另查恒拒（`--inspect-brk` 在 Node 引导期暂停、进程内无法拦截，为已知固有限制）；**阶段 7 批次 A 已落地 Fuses 收口**（2026-08-22）：`EnableNodeOptionsEnvironmentVariable=false` 从产物级关闭 `NODE_OPTIONS` 注入面、`EnableNodeCliInspectArguments=false` 关闭 `--inspect` 系参数面（`RunAsNode=false` 另关闭 node 子进程执行面），阶段 8 仅剩产物复核（读回断言见 verify:artifact 与 `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md` 第 19 项）；
- 非打包（dev/preview/`--mode development` 直启）**同样触发该门**：`findForbiddenDebugLaunch()` 刻意不接收 `isPackaged`（`src/main/config/debug-switches.ts:67-79`），把“开发态漏门”显式封死；仅测试 harness env `CYRENE_TEST_HARNESS=1` 放行随机端口（设计期决策 D-5「限生产」/G-7 已被取代，其原文见 `docs/archive/specs/2026-08-09-phase1-loading-env-design.md` §4）。

## 5. 内容安全策略

Renderer 使用严格 CSP，原则上：

- 脚本只来自应用自身；
- 禁止 `unsafe-eval`；
- 样式来源最小化；
- 图片和媒体只允许必要的应用资源与 Main 校验后生成的受控 Blob；远程资源先验证协议、域名、大小、MIME 和鉴权，再交给 Renderer；
- Renderer 不直接连接带凭据的后端或模型 Provider；网络由 Main 的 Transport/Adapter 代理，Renderer 的 `connect-src` 保持最小；
- 禁止对象嵌入和任意 Frame；
- Live2D 资源从已安装本地目录加载。

实际 CSP 需根据打包产物和 SDK 验证，不能为了消除报错直接放宽为通配符。

**已落地（阶段 1 块 A，2026-08-09）：** 严格 CSP 由 `buildRendererCsp()` 纯函数产出——`default-src 'none'`、`script-src 'self'`、`style-src 'self'`、`img-src 'self' data:`、**`media-src 'self'`**（阶段 3 G3：视频/音频经同源 `cyrene://renderer` 放行）、`font-src 'self' data:`（Vite 内联 <4KB 字体为 data: URI）、`connect-src 'self'`、`object-src 'none'`、`base-uri 'none'`、**`frame-src 'none'`**、`form-action 'none'`、`frame-ancestors 'none'`；无 `unsafe-eval`、无 `unsafe-inline`。**交付方式为 AND 取交集**：prod/preview 经 `cyrene://` 协议响应头注入严格版，同时**保留** index.html 的宽松 meta 不剥离——响应头与 meta 取交集、严格头胜出，meta 独有的 `blob:`/`ws:`/内联 `style` 属性在 prod 被剔除；dev（electron-vite dev http 场景）为**两层交集**：Vite dev server 注入的 dev 专用 CSP **响应头**（`buildDevCsp()`，经 `electron.vite.config.ts` 的 `cyrene:dev-csp` 中间件对全部响应 setHeader，含 `ws://<host>:*` 回环源与 meta 不支持的 `frame-ancestors 'none'`）+ index.html 的宽松 meta，**有效策略 = 响应头 ∩ meta**（`pnpm start` preview 不设 `ELECTRON_RENDERER_URL` → 走 cyrene:// 严格头）。`frame-src 'none'` 收口第一块 G-6 缺口（同窗口 iframe 的 `event.sender` 即主 webContents）。AND 耦合（改 dev meta 会静默改变 prod 有效策略）记为已知限制 G-9。

## 6. Preload 与 IPC

### 6.1 白名单接口

- 每个能力使用具名方法；
- 每个方法拥有输入和输出 Schema；
- IPC Handler 验证调用来源窗口；
- Renderer 不能指定通道名；
- 事件订阅返回取消函数；
- 销毁窗口时移除监听器；
- 错误返回公开错误，不发送堆栈和秘密参数。

### 6.2 双重校验

Preload 的校验改善边界和错误提示；Main 的校验才是安全控制。Main 不能因为请求来自 Preload 就省略校验。

### 6.3 序列化

- 只传递普通可序列化对象；
- 不传递函数、类实例、文件句柄对象或原始 Node Buffer；
- 大二进制通过受控临时附件引用；
- 设置单条 IPC 消息大小上限。

> **落实状态与边界（2026-09-11~12，全量评审 P1-1 处置）——本条此前只有"应当有上限"，没有说清上限在哪、由谁执行、以及"是否真的强制"：**
>
> - **上限值**：单条 IPC 消息 ≤ **4 MiB**（`MAX_IPC_MESSAGE_BYTES`，`@shared/contracts`）。另有 `voice:audio-chunk` 的 **1 MiB/块**（单向二进制通道）与工具写路径的 **2 MiB**（`MAX_WRITE_CONTENT_BYTES`）等更紧的局部上限。
> - **执行点**：各 handler 自行执行（`session-store` 的整批/出参预算、`voice-handlers` 的分块 `byteLength`、工具写路径等）。**`ipc/registry.ts` 的路由点在 arity 之外不查大小**——即"收口点是路由点，但不是策略点"。
> - **声明表**：`src/main/ipc/channel-budgets.ts` 枚举全部通道的规模上界，分三类（`bytes` 带执行点说明与真实常量引用／`schema` 字段级上界依据／`none` 无载荷），并有 `tests/unit/ipc-budget-declaration.spec.ts` **枚举实际注册通道逐个核对**。
> - **这层门禁的准确语义**：它让"**遗漏可见**"（新通道未声明即红，上线首次运行即抓到一处），**不等于"已在运行时强制"**。二者不可混为一谈。
> - **运行时收口经实测后撤回**（理由见 `registry.ts` 头注，四条）：① 它会**遮蔽更具体的诊断**——`chat:cache-messages` 超限时 handler 抛可操作的 `IPC_MESSAGE_TOO_LARGE`，路由点的通用拒绝会把它换成 `SCHEMA_VALIDATION_FAILED`（既有集成用例当场变红）；② **不可能统一**：二进制载荷不能度量，实测 1 MiB `Uint8Array` 经 `JSON.stringify` 需 **114 ms** 且膨胀 **10.9×**，故单向音频通道无论如何只能由 handler 判断；③ **方向不匹配**：部分通道的预算描述的是**响应**大小（出参装箱降级），而路由点只能度量**入参**；④ 边际价值有限——这些 handler 本就在执行预算。**若将来要把它强制到路由点，正确做法是由契约生成声明并保留各通道原有错误码，而不是手抄第二份平行实现。**

## 7. 网络安全

- 默认只允许 HTTPS/WSS；
- 验证 TLS 证书，不提供“忽略证书错误”普通设置；
- 服务器地址解析后检查协议和主机；
- Token 放在安全请求头或受控握手字段；
- Token 与规范化后端 Origin、账号/项目标识绑定；修改服务器地址后不得自动把旧 Token 发往新 Origin；
- 认证请求重定向到不同 Origin 时不转发凭据；
- Token 不进入 URL、Renderer、普通日志和错误弹窗；
- 出站域名先规范化并匹配域名黑名单，黑名单覆盖历史授权；
- 认证失败停止无限重试；
- 协议版本不兼容时禁用 Desktop 工具；
- 设置事件大小、速率、JSON 深度和心跳超时限制；
- 未识别事件默认忽略或拒绝，不执行本地能力。

LLM、STT、TTS Profile 在 Renderer 中只显示 Provider、模型、模型执行位置和凭据状态。输入法转写只保存专用 STT Profile 引用，不创建第四套模型凭据。已经保存的密钥不通过普通 API 回显；测试连接由 Main、Backend、受信 Local Worker 或受控本机模型适配层发起。输入法转写选择后端 STT 时必须在首次录音前说明音频会离开设备；临时音频完成、取消或失败后按策略清理，不进入消息缓存和日志。

自定义模型 Endpoint 视为不可信出站目标：

- 默认只允许 HTTPS；仅“本机 Provider”模式可在明确提示后使用环回地址的 HTTP；
- 解析并规范化协议、主机、端口、Unicode/Punycode 和尾随点；
- 默认拒绝云元数据、链路本地、组播、未明确允许的私网和其他特殊地址；
- DNS 解析结果与实际连接目标都检查，防止 DNS Rebinding；
- 每次重定向重新校验目标，跨域重定向不携带 Authorization、API Key 或自定义敏感 Header；
- 自定义 Header 使用允许名单，禁止 `Host`、`Cookie`、代理认证和会改变路由/内容长度的危险 Header；
- 连接测试使用固定最小样例，不发送聊天历史、真实录音或用户文件；
- 域名黑名单和本地 Provider 的显式范围始终优先于 Profile 历史可用状态。

若开发环境必须支持自签名证书，应使用独立开发配置和明确的证书信任方式，不能进入生产构建。

## 8. Markdown、链接和媒体

- 禁止原始 HTML 或使用严格净化；
- 禁止脚本、事件属性、危险 URL Scheme；
- 链接只允许 `https:` 等白名单协议；
- 打开外部链接前显示目标域名或使用明确操作；
- 图片限制来源、尺寸和解码资源；
- 代码块只展示和复制，不提供一键本地执行；
- Mermaid、数学公式或自定义组件如后续加入，应分别建立安全策略；
- 流式未闭合 Markdown 不能绕过最终净化。

## 9. Desktop 工具安全

### 9.1 注册和路由

- 静态工具注册表；
- 名称、版本、Runtime 和平台匹配；
- 参数和输出使用专属 Schema；
- 本地重新计算风险；
- 未注册工具默认拒绝；
- 禁止通用命令或脚本工具。

### 9.2 文件

- 路径规范化；
- 检查符号链接、连接点和路径逃逸；
- Windows 额外处理大小写、UNC、设备命名空间、重解析点、保留名和 NTFS Alternate Data Streams；未经明确授权不接受网络共享路径；
- Linux 以实际解析后的 inode/路径范围复核符号链接，并在执行前重新校验；
- 使用用户选择或授权句柄；
- 敏感路径规则；
- 大小和类型限制；
- 写前哈希检查；
- 临时文件和原子替换；
- 不支持无确认批量删除；
- TOCTOU 风险通过执行前再次校验降低。

沙盒目录不是全局放行：路径黑名单始终优先。长期目录授权绑定规范化路径、工具范围、后端身份和有效期，并可以从设置页撤销。

### 9.3 截图

- 每次用户选择；
- 明确显示上传目的；
- 不静默、不周期、不录屏；
- 临时图像按任务清理；
- 审计只记录元数据，不保存图像内容。

### 9.4 幂等

副作用工具按 `callId` 去重。相同 ID 参数变化视为协议错误。终态调用不得被重放恢复执行。

### 9.5 已授权命令

- 只允许本地注册的命令模板；
- 模板固定可执行文件、参数 Schema、工作目录范围、超时和输出上限；
- 禁止后端传入完整 Shell 字符串；
- 禁止管道、重定向、命令替换和隐式 Shell 解析；
- 使用已注册绝对可执行路径，不经 `PATH` 搜索；执行前验证文件哈希或平台签名，目标变化后撤销旧授权；
- 设置页显示模板、目录、来源、有效期和撤销操作；
- 路径与域名黑名单继续生效；
- 非只读命令原则上逐次确认。

> **阶段 6 批次 B 注记（2026-08-20）**：Desktop 工具安全已落地（Main 工具服务/四执行器/审计，F-6-07~12/14）——**黑名单默认集** `PATH_BLACKLIST_DEFAULTS` 落地为常量（不进 settings.json，D6B-14）：POSIX 17 项系统目录（**含 `/tmp`**——测试 fixture 经 `CYRENE_MOCK_TOOL_ALLOW_ROOT` 显式注入 allowlist 放宽，生产默认不注入）+ 14 项用户敏感目录（~/.ssh、~/.config、~/.gnupg、~/.password-store、~/.aws、~/.npm、~/.cache、~/.local 整树、~/.mozilla、~/.netrc、~/.bash_history、~/.Xauthority、~/.pki、~/.git-credentials + dot-secret 精确项 `.env/.pypirc/.dockercfg` + `.kube/config` 路径段精确项）+ `/home/*` 排除当前用户 + Windows **8 项**（`C:\Windows`、`C:\Program Files`、`C:\Program Files (x86)`、`C:\ProgramData`、`C:\System Volume Information`、`C:\$Recycle.Bin` 六项系统目录 + `~\AppData`、`~\AppData\Local\Temp` 两项用户面，`tool-policy.ts:23-25`）+ `\\.\`/`\\?\`/ADS/保留名（CON/NUL/PRN/AUX/COM1-9/LPT1-9）/UNC 默认拒；**匹配时机 = full realpath（含父链，防中间组件 symlink 逃逸）之后按路径段边界**（等于 root 或 root+分隔符开头，防 `/var2` 误伤）；域名黑名单 = 仅已连接后端端点。**执行器安全**：四执行器全部只读 Main 编译后注册的 `executeRef`（无命令/脚本/Worker/`child_process`），`desktop.command.run` 确认不注册；写操作原子替换（随机后缀临时文件 + rename + fsync）+ 写前哈希冲突保护（`FILE_CONFLICT`）+ 失败保持原文件；read/write 均 TOCTOU 复核（**size 口径**：读前 `statSync` + 读后 `buf.byteLength !== st.size` → `FILE_CONFLICT`；设计期「open 后 fstat inode」未落地，`tool-executors.ts:46-50`）；**截图平台**：Win + X11 `desktopCapturer`（仅 Main 调用），**Wayland 授权前降级** `CAPTURE_UNAVAILABLE`（不静默失败），每次用户选择 + 预览 + 上传确认（两步确认），临时图完成/取消/超时清理，审计只记元数据。详见 `docs/review/2026-08-20-阶段6批次B-决策记录.md`。

> **阶段 6 批次 C 注记（2026-08-21，目录授权安全）**：**后端身份绑定（F-2）**——`PermissionGrant.backendIdentity` = 授权时连接指纹（`new URL(serverUrl).origin`，对齐 real-backend mapper 身份先例语义）：**切换端点（origin 变化）→ grant 不再匹配**（fail-safe 落 prompt）；token 变更不改变 origin → grant 保持匹配（已知语义，契约 F-4）；`backendIdentity()` 返回 undefined（未连接/目标未定）→ 不匹配任何 grant（无「无身份宽松匹配」）。**黑名单优先**：grant 匹配发生在决策链 **step 8**（黑名单 step 5 已先拒，命中不弹窗不受 grant 影响）；命中黑名单的目录**不可授权**（`GrantStore.add` 复核 → `PATH_BLOCKLISTED`）。**目录段边界**：`matches` 要求 `realPath === dir || realPath.startsWith(dir + '/')`（防 `/granted2` 误配；Windows 大小写不敏感）。**有效期强制**：`ttlMs` 白名单（`GRANT_TTL_OPTIONS_MS` 1h/24h/7d/30d）在 schema union + Main 侧双校验——「**无永久 grant**」由 Main 校验保证（非 UI 软约束），`expiresAt` 必填且派生自白名单 ttl；过期惰性清除（`matches`/`list` 触发 + `grant:expired` 审计）。**历史脱敏**：`grant:created` 审计 summary **不含目录绝对路径**（`「目录授权（工具 X，有效期至 ISO）」`——目录仅存 settings.tools.grants 与 `tool:grants`，不进审计/诊断导出，doc 07 §12 纪律，F-5）；审批历史只读 audit 产物（summary 已 `redactSensitiveValues`，不落文件内容/截图/token/未脱敏参数）。**`tool:grants` 全路径暴露面（F-7 记录）**：向 renderer 下发授权目录全路径为授权管理功能必需（设置页展示/撤销）——授权目录非秘密、TTL 有限、撤销即时生效，不额外脱敏（展示形态与权限窗 pathSummary 差异留档）。**backendIdentity（origin）进入 audit JSONL/tool:history 暴露注记（V-4）**：origin 为**用户已知配置数据**（连接设置可见），可接受；诊断导出随审计携带时同口径。**settings.json 篡改即全量失守注记（N-8）**：settings.json 属本机受信面，被篡改（形状合法）可注入非黑名单敏感目录 grant——防护 = 黑名单 step 5 恒先拒（`/etc` 注入无效）+ schema strict 只允 read/write + 装载期逐条校验剔除畸形条目 + 形状失败 corrupt 隔离回默认（grant 全清 fail-safe）；「无永久 grant」保证仅在创建流成立（装载期不复查 expiresAt 上限）为接受风险。**renderer 可撤销 grant 接受档（F-8）**：被攻破 renderer 可对任意 grant id 调 `tool:grant-revoke`（id 可枚举自 `tool:grants`）——仅骚扰级（撤销合法授权 → 恢复逐次弹窗）、**无权限提升**（renderer 本可对 pending 自动 allow_once，M-8 同档），不设额外校验，阶段 7 安全收敛再评估。

## 10. 权限 UI 安全

- 使用本地模板，不渲染后端 HTML；
- 工具名称来自本地注册表；
- 后端原因作为纯文本展示；
- 明确目标资源、行为和上传范围；
- 允许与拒绝按钮视觉权重不过度失衡；
- 关闭窗口按拒绝或取消；
- 不自动允许；
- 授权与 `callId`、工具、参数摘要绑定；
- 参数在授权后变化必须重新授权。

> **阶段 6 批次 B 注记（2026-08-20）**：权限 UI 已落地为 `CyToolApproval`——**初始焦点在拒绝按钮（安全默认）** + Tab 陷阱 + Esc=拒绝 + 回焦 triggerElement（CyHistoryViewer 先例）；允许一次与拒绝对等权重、无倒计时自动允许、**关闭窗口 = 拒绝**（tool-service 未决授权按拒绝处理并审计）；授权绑定 `callId` + zod 校验 + `isTrustedSender`（`tool:decide` 只校验这些——被攻破 renderer 可对 pending 调用自动 allow_once/deny 为**已记录残余风险（M-8）**，缓解层：raw `.strict()` + Main 侧黑名单/风险重算（renderer 无法授权黑名单路径）+ capture 子状态机（无法跳过预览/上传确认）仍有效；批次 C 评估 write/capture 的 Main 侧原生确认对话框）；参数在授权后变化 → 重新授权（paramHash 重算 + 幂等参数一致性校验）；权限窗只出现在聊天流（CyChatView 单宿主，CySettingsView 不挂）。详见 `docs/review/2026-08-20-阶段6批次B-决策记录.md`。

## 11. 凭据和本地数据

- 优先使用系统安全存储；
- Renderer 只获得凭据状态；
- 清除凭据需要明确操作；
- 普通设置文件不得出现 Token；
- 崩溃报告和日志在写入前脱敏；
- 会话缓存和附件临时文件限制容量与生命周期；
- 配置、日志、审计和临时目录由 Main 在系统用户数据目录下创建，验证不是符号链接/连接点逃逸，并尽可能使用仅当前用户可读写权限；
- 用户可以清除缓存、日志和授权记录；
- 导出诊断包前再次执行脱敏。

模型服务密钥和后端 Token 使用相同级别的安全存储原则。切换 Profile 不把旧凭据复制到普通设置或 Store。

### 11.1 麦克风和语音

- 第一次录音前请求系统麦克风权限；
- UI 持续显示正在监听或转写状态；
- 停止录音不自动发送消息；
- 普通录音输入、实时语音会话和输入法转写使用独立会话 ID；
- 直接语音的 STT 字幕不得写入文字草稿；只有输入法转写最终结果可以修改当前会话草稿；
- 原始音频只发送到用户选择的模型执行位置；
- Local Worker 失败时不得未经确认回退到远程 STT；
- 临时音频按任务生命周期清理；
- 原始音频和完整转写默认不进入日志。

**阶段 4 批次 B 落地（2026-08-16）：**

- **Main 麦克风权限处理器（D-P7）**：`decideMicrophoneAllow`/`registerMicrophonePermission`（`main/windows/mic-permission.ts`，纯 Node 可单测）——`setPermissionCheckHandler` + `setPermissionRequestHandler` 仅放行 `media` 权限且仅音频（deny camera/video，含 `mediaTypes` 数组判别）、且 requesting origin/URL 为受信 renderer（prod `cyrene://renderer` / dev 回环或白名单 http，复用 `isAppRendererUrl`，不新建谓词）；非受信 origin 一律 deny。
- **单向语音 IPC 守卫（D-P18）**：`voice:audio-chunk` 走 `ipcMain.on`（fire-and-forget，不 invoke），经 IPC registry 新增 `registerOneWayHandler`（`main/ipc/registry.ts`）——回调内复用 `isTrustedSender`（`senderFrame===mainFrame` + 发送 frame 当前 URL 受信校验，FE-S1-P2-01）+ zod 校验载荷 `{ bytes: Uint8Array }`，`bytes.byteLength ≤ MAX_AUDIO_CHUNK_BYTES`（1 MiB = 后端 BINARY 上限，常量在 `main/voice/voice-handlers.ts:22`，超限丢弃 + warn）；**仓库零裸 `ipcMain.on`，单向通道不得绕过可信发送者纵深**（`ipc-security.spec.ts` desktopApi 白名单同步）。
- **Renderer 采集安全**：`PcmCapture`（`renderer/src/voice/`）只在本端 Renderer 内 getUserMedia + AudioWorklet；音频样本仅经 `voice:audio-chunk` 送 Main→后端，内存态，不触达文件系统/凭据/后端路径；`voiceSendAudio` 显式构造 `Uint8Array` 拷贝（防 DataCloneError，P4-A 教训）；TTS 二进制仅 Main 内存 + MediaService `tts-live` 短期缓存（TTL 5min），Renderer 只持有 `cyrene://` URL。
- **后端 STT 一次性同意（D-P16）**：首个 backend-STT 语音操作（record/realtime/dictation）前弹「音频将发送至后端识别（本机不保留）」确认；接受后持久化 `voice.consentBackendStt` 不再提示，拒绝则中止。

## 12. 日志与隐私

允许记录：

- 时间、版本、错误码；
- 事件类型和脱敏 ID；
- 工具名、Runtime、状态、耗时；
- 文件大小、类型和脱敏路径摘要；
- 连接状态和重试次数。

禁止记录：

- Token、Cookie、密钥；
- 完整用户消息和 AI 回复；
- Inner Voice 和 Public Reply 的正文；
- 完整文件或截图内容；
- 未脱敏的敏感路径；
- 工具原始参数；
- 后端返回的内部堆栈。

日志轮转并设置保留期限。默认不自动上传诊断信息。

## 13. Local Worker

- 只绑定本机通道；
- 使用随机会话凭据并定期更新；
- 验证 Worker 可执行文件来源和版本；
- Renderer 不直接连接；
- 工具清单固定；
- 每个请求设置超时和大小限制；
- Worker 输出仍做 Schema 校验；
- Worker 退出后不自动将敏感输入转交后端。

## 14. 构建与供应链

- 锁定依赖版本并提交锁文件；
- CI 使用干净环境安装；
- 发布前运行依赖风险检查；
- 生产构建默认关闭 DevTools，永远关闭远程调试端口；若提供用户开发者模式，必须显式开启、二次确认并保持脱敏；
- 安装包和更新包使用校验或签名；
- 更新来源固定并通过 TLS；
- 不从聊天消息加载插件、模型或更新；
- Live2D SDK 和模型资源分别记录许可与哈希；
- 构建日志不得输出秘密环境变量。

发布前 Review Electron Fuses：在不破坏已确认 Worker/启动方式的前提下，关闭不需要的 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable` 和 `EnableNodeCliInspectArguments`；评估启用 ASAR 完整性校验及只从 ASAR 加载应用。Fuse 必须在打包、签名和实机测试后验证，不能只依赖源代码配置。

生产构建默认关闭开发者模式。若产品允许用户开启，应用自身生成的日志、协议面板、Store 摘要和诊断导出仍不得包含明文凭据、未脱敏路径、完整消息、Inner Voice、录音或工具原始参数。Renderer DevTools 天然可检查当前 DOM、内存和临时表单，开启前必须说明这一不可消除的本地可见性风险；已保存凭据仍不可读回，远程调试端口始终关闭。

## 15. 典型威胁与控制

| 威胁 | 控制 |
|---|---|
| AI 文本携带脚本 | Markdown 净化、CSP、无 Node |
| 后端诱导读取密钥 | 本地敏感路径策略、逐次授权 |
| 重放写文件 | `callId` 幂等、终态记录 |
| XSS 后调用 IPC | Preload 白名单、Main 再校验 |
| 路径穿越 | 规范化、授权范围、符号链接检查 |
| 静默截图 | 系统选择器、每次确认、无后台 API |
| Token 泄漏 | 系统安全存储、日志脱敏、Renderer 不可见 |
| Inner Voice 被误记入日志 | 消息内容默认不日志化、诊断导出脱敏 |
| 麦克风后台持续录音 | 系统授权、持续状态提示、会话生命周期 |
| 历史目录授权越权 | 绑定范围/身份/有效期、黑名单优先、可撤销 |
| 任意命令字符串执行 | 默认不注册命令工具；如启用则使用受控模板、无 Shell 解析和参数 Schema |
| 恶意更新 | 固定来源、签名/校验、版本策略 |
| Worker 被冒充 | 本地通道、会话凭据、可执行文件校验 |

## 16. 安全测试

- XSS 和危险链接用例；
- IPC 非法通道、超大参数和类型混淆；
- 路径遍历、符号链接和竞态；
- Windows UNC/设备路径/连接点/ADS/大小写变体和 Linux 符号链接逃逸；
- 重复 `callId` 和参数篡改；
- 未注册工具和未知 Runtime；
- 权限窗口关闭、超时和参数变化；
- Token 是否进入日志、Store、错误和崩溃报告；
- Inner Voice、Public Reply 和语音转写是否进入普通日志；
- 沙盒、路径黑名单、域名黑名单和历史授权的优先级；
- 已授权命令是否可以通过参数绕过模板；
- 麦克风授权、停止、取消、直接语音字幕与草稿隔离，以及模型执行位置回退；
- 生产构建 DevTools 默认状态、显式启用门槛和远程调试端口关闭；
- TLS 错误和认证失败；
- 自定义模型 Endpoint 的 SSRF、DNS Rebinding、重定向、私网/元数据地址和敏感 Header 转发；
- 恶意或损坏附件；
- Local Worker 冒充、断开和超大结果。

> **阶段 7 批次 A（2026-08-22）已核对：** 本表各面于本批逐一对应核对（结论见 `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`）——XSS/危险链接（DOMPurify + 真实 Chromium markdown-xss 集成，第 6 项）、IPC 非法通道/超大参数/类型混淆（ipc-security 集成扩展 + ipc-limit 单测核对表，第 5 项）、路径遍历/符号链接/UNC/重放/参数篡改（阶段 6 既有实现 + 本批引用式断言，第 8/16 项）、Token/与敏感内容泄漏（verify:sensitive 常驻门禁 + 导出二次脱敏，第 9 项）、生产 DevTools 默认态/显式开启门槛/远程调试恒关（本批修订，第 15/17 项）、Fuses（构建产物读回，第 19 项）。**自定义模型 Endpoint 的 SSRF/DNS/重定向/私网面为后端职责**（出站请求由后端执行，前端无实现面——第 11 项「证据缺口」，见核对文档）。

## 17. 发布安全门槛

- [ ] Renderer 无 Node.js 直接能力；
- [ ] Context Isolation 和 Sandbox 已启用；
- [ ] CSP 不包含无理由的通配符或 `unsafe-eval`；
- [ ] Renderer 使用受限自定义协议，不存在任意 `file://` 本地文件映射；
- [ ] 所有 IPC Handler 验证来源和 Schema；
- [ ] Markdown/XSS 测试通过；
- [ ] Desktop 工具无通用命令入口；
- [ ] 文件和截图权限测试通过；
- [ ] Token 未出现在普通存储和日志；
- [ ] 模型服务密钥不回显到 Renderer；输入法转写只引用兼容 STT Profile；
- [ ] 自定义模型 Endpoint 通过协议、地址、DNS、重定向和 Header 安全测试；
- [ ] 沙盒、黑名单和历史授权遵循明确优先级；
- [ ] 已授权命令不能变成任意 Shell；
- [ ] 麦克风和实时语音具备持续可见状态及安全清理，直接语音字幕不会污染文字草稿；
- [ ] 开发者模式中的应用诊断保持脱敏；DevTools 的当前页面可见性风险已告知且不能读回已保存凭据；
- [ ] 重放不会重复产生副作用；
- [ ] 生产包默认关闭开发者模式和 DevTools，远程调试端口始终关闭；显式启用（设置页二次确认）时应用诊断仍脱敏，重启恢复禁用；
- [ ] 发布包来源和完整性可验证；
- [ ] Electron Fuses 已按实际功能 Review，并从打包产物验证；
- [ ] 高风险已知问题已记录并获得明确接受。

> **阶段 7 批次 A（2026-08-22）核对/修订注记：** 第 6/15/19/20 项由本批补齐（DOMPurify + markdown-xss 集成、开发者模式设置页开关与脱敏诊断、Fuses 三项关闭 + 产物读回断言、本批已知限制见 spec §10 与决策记录 §8）；第 17 项口径随 D7A-04/05 修订（生产默认关保持、增加二次确认开启路径与重启恢复禁用；远程调试恒关不变）；第 11 项（自定义 Endpoint SSRF 面）为后端职责——前端无实现面，记为「证据缺口」；**第 18 项（来源/完整性）为阶段 8 签名联动缺口（verify:artifact app-sha 已有、签名/校验和/ASAR 校验缺）**，详见 `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`（20 项逐条证据与状态）。 **勾选框阅读说明：** 上文 20 项的 `- [ ]` 仅为清单枚举、**未勾选不代表未达成**（逐项状态见本条与下方 7D 收口注记；现状一律以 doc 16 为准），避免与「其余 18 项通过」的注记读起来互相矛盾。

> **阶段 7 批次 B（2026-08-25）崩溃/损坏安全面注记（Mock 驱动，标「已开发、未联调」）：** ⑦⑥ 项（崩溃或断线不会破坏已确认消息和用户文件 / 本地数据损坏可恢复）由本批补齐——**崩溃零正文**：`RendererCrashEvent{reason, exitCode}` 仅元数据，`.corrupt-*` 隔离副本（message-cache-v1.json 留存聊天正文）经 `pruneCorrupt` 有界保留、**不纳入任何导出与传输**（`collectLogFiles`/`collectAuditLines` 只扫 logs/audit 目录，export 不涉及 appCache/config 持久化目录）；**凭据 fail-closed 不拉平**：credentials 不纳入统一层（隔离+重建默认 = fail-open 与凭据 fail-closed 冲突，见决策记录 §4）；**崩溃审计 type 解耦**：`renderer:crash`（Renderer 崩溃）/ `gpu:crash`（GPU 崩溃）分开记录，不共用字符串。`.corrupt-*` 备份正文不入日志/审计/诊断导出纪律维持（doc 01/06 同步）。

> **阶段 7 批次 D（2026-08-28）收口确认注记（真机联调通过，标「已真实联调」）：** 本批收口**安全发布清单**——7A 核对表 20 项：第 11 项（自定义 Endpoint SSRF 面）**后端职责**（前端无实现面，登记非前端缺陷）；第 18 项（发布包来源/完整性）**阶段 8 签名联动**（来源可追溯已有 commit SHA + 可重跑构建，密码学完整性缺——H-04 签名证书外部依赖）；**其余 18 项通过**。`Blocker/Critical 为 0` 确认（阶段 7 全程（7A/7B/7C 真机验收通过）+ 7D 无新 Blocker/Critical，历史遗留 `message_id=""`/`Failed to fetch`/`.corrupt-*` 登记但不算）。详见 `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md` 与 `docs/review/2026-08-27-阶段7批次D-决策记录.md`。
