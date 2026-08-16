# 阶段 5（Live2D）批次 A：地基——SDK 集成 + 模型供给 + 首帧渲染

**设计 spec（binding authority）**
**日期：** 2026-08-17
**批次：** 阶段 5 · 批次 A（共 A/B/C 三批次，本 spec 只论证批次 A：一个模型经「注册表→校验→协议→Adapter→canvas」全链路真实渲染首帧）
**依据：** [05-Cyrene-Live2D前端接入设计-v0.2.md](../../05-Cyrene-Live2D前端接入设计-v0.2.md)（Live2D 专项设计，binding）+ [10/doc 12 §9.6/doc 16 §8（阶段 5 任务与验收）] + 本会话决策集合（见 §0）

---

## 0. 决策集合（本批定案，用户批准或按推荐拍板）

资源与许可：

| # | 决策 | 理由 |
|---|---|---|
| D5A-01 | **SDK 选型 = Cubism SDK for Web 5-r.5**（已入仓库 `third_party/CubismSdkForWeb-5-r.5/`，commit `22993e5`） | renderer 沙箱无法执行原生；doc 05 §2 明示 Web SDK 或兼容封装；Web 是正确变体 |
| D5A-02 | **Framework 以源码 vendored 进 renderer**，`@framework/*` tsconfig+resolve alias 指向 vendored `Framework/src`（**构建期零 npm 外部依赖**）；Core（`live2dcubismcore.min.js`）作**全局 script** 经 index.html 加载，先于 Framework module 执行；**运行期附带一次同源 shader fetch 面**（见 D5A-02b） | Framework package.json 为 `private` 未发布；官方 Demo 同款 alias 接线；Core 暴露 `Live2DCubismCore` 全局 |
| D5A-02b | **vendor 范围包含 `Framework/Shaders/WebGL/`（13 个 shader 文件）** → `renderer/public/live2d/shaders/`；Adapter 在**首次 draw 前**对 renderer 调 `loadShaders('/live2d/shaders/')`（官方 Demo `lappmodel.ts:524/895` 同款；该方法内部对 `CubismShader_WebGL` 实例 `setShaderPath`，`cubismrenderer_webgl.ts:767/783`） | `cubismshader_webgl.ts` 运行时 `fetch(url)` 加载 shader（默认相对路径 `../../Framework/Shaders/WebGL/` 解析到 404），不 vendor 则首帧渲染必败；**时序关键**：须先于首次 `generateShaders/drawModel`，否则已用错误默认路径编译 |
| D5A-03 | **CSP 不做放宽**：Cubism Core 5-r.5 为 **asm.js 构建（非 wasm）**——实证：`live2dcubismcore.min.js`（228KB）全文件无 `new WebAssembly`/`WebAssembly.instantiate/Module/Instance`（仅 1 处 `instantiateStreaming(` 于死分支），**SDK 全树无 `.wasm` 文件**，内嵌 base64 累计仅 ~7KB | 运行时不产生 wasm 编译，`script-src 'self'` 即充分；保持 doc 07「无 unsafe-eval」纪律；**若未来换 wasm Core 再评估**。A1 spike 以运行时探针（headless 页面 + 检查 `typeof Live2DCubismCore` + 加载栈无 `WebAssembly.compile/instantiate`）复核确认 |
| D5A-04 | 模型 ID = 目录名（`userData/models/<id>/`），装配工具以 ASCII slug 命名；**保留模型内部中文文件名**（model3.json 内部引用），cyrene:// URL 中 modelId 不编码、relPath 按段 percent-decode + Unicode containment 处理 | 不改写 model3.json 内部引用；URL 编码由协议层透明处理；modelId 保持 ASCII slug（`^[A-Za-z0-9._-]+$` 且不等于 `.`/`..`） |
| D5A-05 | 首批装配验证模型 = **Haru**（官方示例 `Samples/Resources/Haru/`，2048 纹理、带动作、**来源已入仓库 → CI 可装配**；**无 `icon.png`** → preview 省略、UI 占位，可选补预览图）+ **修女莉尔免费版**（`tmp/live2d/`，用户模型最小 65M，覆盖中文文件名/大纹理/无动作真实路径 → **仅本机装配，CI skip-when-absent**；**有 `icon.png`**，A5 用作 `preview` 来源） | 一次覆盖「带动作官方格式」与「用户无动作大纹理」两条路径；批次 A 验收也满足「两模型可切换」 |
| D5A-06 | **3 个用户模型许可记录**：免费版「个人开发验证」用途（仓库不入 git，`tmp/live2d/` 待装配）；装配工具注入 `LICENSE.txt`（免费版+来源+个人开发验证注记），manifest `licenseRef` 指向之；validation 要求 licenseRef 存在；落 doc 05 §15 + 决策记录 | doc 05 §15「模型不因打包进客户端即具备分发权」；SDK/Core 官方许可（Proprietary + Release License）与模型授权**分开记录**，发布前按 AI/Chatbot/Expandable 流程复核 |

架构与范围：

| # | 决策 | 理由 |
|---|---|---|
| D5A-07 | **模型注册表（Main）**：扫 `userData/models/*/manifest.json`；**manifestSchema 必填字段 = `{id, displayName, modelFile, licenseRef, integrityManifest}`**，可选带缺省 = `{preview?, expressions?, motions?, version?}`（A5 装配时从 model3.json 读 Version/Motions/Expressions 写入、缺失省略；`preview` 由 icon.png 拷贝生成、缺失亦省略）；**两级可用性**——① manifestSchema 校验失败（含 licenseRef 缺失）→ **整目录跳过**不列出；② 合法但 **integrity.json 覆盖的模型文件**缺失/尺寸不符 → **列出且 `available=false`**（`preview` 条目豁免：缺失/尺寸不符不置可用性为假，UI 缺 preview 用占位）；`list` = 结构校验（zod manifest + integrity.json 模型文件条目存在 + 尺寸 + licenseRef 存在），**全量 SHA-256 复核在模型首次 load/switch 时**（会话内每模型一次，缓存 verified 态）；IPC `live2d:list-models`（invoke，preload zod 校验 + ipc-security 白名单同步，遵循 P4-B 纪律） | doc 05 §4「安装、切换和打包时复核」；`available` 门禁只锚定 integrity 清单的模型文件（装配产物全量覆盖），preview 等展示元数据不干扰可用性；list 不因 267M 逐文件 hash 拖慢；`available` 语义与「列表」语义解耦 |
| D5A-08 | **cyrene:// live2d 专用分支**：`cyrene://renderer/__cyrene-live2d/{modelId}/{relPath}`，仅放行 registered+valid 模型；路径 containment（realpath + prefix）+ **integrity 白名单**（只服务 integrity.json 列出的相对路径，尺寸匹配）；**首个命中请求 fail-closed 等待该模型 `verifyIntegrity` 完成**（同模型请求复用同一 pending promise），失败 → 熔断该模型 + 4xx；`isDocumentRequest` → 403；模型文件全量 hash 在 load 时一次（路由不做逐请求 hash） | 多文件目录级供给（moc3/纹理/动作）与单 blob 的 tts 不同；白名单=文件清单防任意文件/路径逃逸；fail-closed 防「校验前已服务被篡改文件」；性能与安全平衡 |
| D5A-09 | **装配工具 = dev CLI**（`pnpm -F @cyrene/desktop live2d:install --model-dir <dir> --id <slug> --display-name <name> [--license-note <file>] [--force]`）：校验必需文件 → 生成 `manifest.json` + `integrity.json`（递归 SHA-256 + size）→ 注入 license note → **拷贝**（非 symlink）进 `userData/models/<id>/`；`--force` 非交互覆盖已存在同 id | 不进 P0 导入 UI（管理范围保持 doc 05 原样）；symlink 违反 doc 05 §4 安全约束；`--force` 供 CI/测试非交互路径 |
| D5A-10 | **批次 A 无完整设置 UI**：改造既有 `CyLive2DPanel.vue`（保留 G1 的 resizer/折叠/状态栏，把 stage 内容替换为 canvas + 模型下拉），`modelId`/`enabled` 走 settingsStore 持久化；完整 Live2D 设置子页（缩放/帧率/口型/性能模式等 doc 11 §7.1 全项）归批次 B（B5） | 批次 A 聚焦「首帧真实渲染」；最小闭环足够验证切换持久化；不新建组件避免与 G1 占位双占右栏 |
| D5A-11 | **8192/4096 大纹理在批次 A 处理为「纹理加载失败 → 优雅失败 → 静态头像回退」路径**（不 crash、聊天不受影响）；完整多级纹理/降质策略归批次 C（C2） | 低端 GPU/SwiftShader 的 `MAX_TEXTURE_SIZE` 风险真实存在；批次 A 先保证失败路径干净 |
| D5A-12 | **GL 抽象层保证可测性**：Adapter 依赖薄 `CubismGL`/canvas 接口（createTexture/deleteTexture/bindTexture/getParameter(MAX_TEXTURE_SIZE)/getError/drawArrays/viewport 等渲染路径实际用到的最小集），WebGL 具体实现注于 Electron 集成层；Controller/Store 状态机以 fake GL 单测（含 GPU-lost 注入） | Cubism 渲染依赖 WebGL 无法单测；doc 05 §16 测试清单包含 GPU 丢失等需可注入 |
| D5A-13 | **WebGL1 baseline**（Cubism 5 同时支持 WebGL2，取 WebGL1 兼容面更稳）；CI 集成测试走 **SwiftShader 软渲染**，断言「store 状态 + canvas 非空像素」，真机视觉复验留真实联调（C6） | doc 05 §12 性能模式 P0 需稳定基线；CI headless 无 GPU |

**对 doc 05 的显式范围偏离（批次 A → 批 C/B）**：折叠暂停/GPU 上下文重建策略（doc 05 §12.2 P0 中的「折叠暂停更新」「上下文丢失重建一次」）本批只做「右栏不可见即不创建/暂停渲染循环 + `device_lost`→failed→fallback」失败路径，重建/降帧/低功耗策略归 C2；完整动作/表情/状态映射归 B；TTS 口型归 C1。

范围外（本批**不做**，归批次 B/C）：动作/表情播放系统与白名单、待机眨眼呼吸、后端 Live2DDirective、状态映射（idle/listening/thinking…）、TTS 口型、性能降级策略（含折叠降帧/重建）、完整设置 UI、`live2d` 段以外的设置项。

---

## 1. 目标

批次 A 目标（一个验收句）：**已装配且通过完整性校验的 Live2D 模型，能经 Main 注册表 + cyrene:// 协议供给到 renderer，由 Cubism Web SDK 5-r.5（asm.js Core + Framework）渲染出首帧，且切换/失败路径干净（聊天全程不受影响）。**

拆解为可验证子目标：

1. SDK 运行时进入 renderer 构建（Core 全局 script + Framework 源码 + shaders alias），CSP 维持 `script-src 'self'` 不放宽；
2. Main 能列出并校验 `userData/models` 下的已装配模型（两级可用性）；
3. cyrene:// live2d 分支安全地供给模型文件（containment + integrity 白名单 + fail-closed hash），并兼容 dev 跨源 fetch（connect-src/ACAO）；
4. renderer 能加载并渲染至少一个模型的首帧（state=ready + canvas 非空像素）；
5. 两个已装配模型可切换；切换失败/纹理失败/GPU-lost 保留当前模型与聊天状态；
6. 装配工具能把原始模型目录转成合规安装包（manifest + integrity + license note）。

## 2. 分层架构

```text
Vue CyLive2DPanel (改造既有 G1 组件：canvas + 模型下拉)   ← 右栏占位，App.vue 已 v-show 挂载
       ↓
Live2DController (状态机：unloaded→loading→ready|failed→fallback；device_lost→failed)
       ↓
Live2DAdapter ──CubismGL 抽象──  Cubism Web SDK 5-r.5 (Framework module + Core 全局 asm.js)
       ↓                                                    │ shader fetch('/live2d/shaders/…')
renderer store: live2dStore                                │
       ↓                                                    │
IPC live2d:list-models (preload zod + ipc-security)         │
       ↓                               fetch cyrene://renderer/__cyrene-live2d/{modelId}/{path}
Main: Live2DModelRegistry (scan+validate) ──► main/protocol/handler.ts 新增 live2d 分支
       ↓
userData/models/<id>/ (manifest.json + integrity.json + <files>)  ← 装配工具产出
```

信任边界不变：**Main 拥有文件系统与校验**；Renderer（沙箱）只经 cyrene:// 消费已校验资源；装配工具是 dev CLI，写 `userData/models`（Main 持久化边界）。后端服务器不参与（doc 05 §4）。

## 3. 组件设计

### 3.1 A1 — SDK vendoring 与构建（renderer）

- **Framework**：从 `third_party/CubismSdkForWeb-5-r.5/CubismSdkForWeb-5-r.5/Framework/src` **拷贝**到 `apps/desktop/src/renderer/src/live2d/framework/`（原样保留，官方样例禁改 Framework 本体）；electron.vite.config.ts `resolve.alias` 增 `@framework` → 该目录；renderer tsconfig `paths` 同步；SDK 许可落 `src/renderer/src/live2d/THIRD_PARTY_NOTICES.md`（含 Core/Open Software License/示例模型许可）。未来升级按 SDK 版本整体替换并重验（doc 05 §15）。
- **Shaders**：`Framework/Shaders/WebGL/`（13 文件）拷到 `apps/desktop/src/renderer/public/live2d/shaders/`（Vite `publicDir` 原样复制，dev/prod 均以 `/live2d/shaders/<file>` 提供，同源 fetch）。
- **Core**：`live2dcubismcore.min.js` 拷到 `apps/desktop/src/renderer/public/live2d/`；index.html `<script src="/live2d/live2dcubismcore.min.js" defer>` 放置于 module 入口标签**之前**（defer 经典脚本与 module 脚本均按 document order 执行，Core 标签须先出现，保证 `Live2DCubismCore` 全局在 Framework module 初始化前就绪）；`env.d.ts` 声明全局 `Live2DCubismCore`。
- **CSP**：`script-src 'self'` 三处（`protocol/csp.ts`、`config/dev-csp.ts`、index.html meta）一律**不放开**（Core 为 asm.js，见 D5A-03）。唯一变化是 dev 侧 `connect-src` 增 `cyrene:`——**两处同改**：`buildDevCsp`（Vite middleware header）**且** index.html meta 的 `connect-src`（meta 在 dev/prod 均生效，Header 与 meta 取交集，只改 header 而漏 meta 会让 dev fetch 仍被 meta 策略拦截；prod 页面同源 cyrene://renderer，`connect-src 'self'` 已放行，增 `cyrene:` 无害）。
- **A1 spike 确认项**（实现期验证，登记 Ruling）：① 运行时探针确认 Core 为 asm.js（headless 页面 `typeof Live2DCubismCore` + 加载栈无 `WebAssembly.compile/instantiate`）；② shader `loadShaders('/live2d/shaders/')` 后渲染器实际 fetch 路径解析正确（renderer 无公开 `setShaderPath`，须走 `loadShaders`）；③ dev 页 fetch `cyrene://renderer/__cyrene-live2d/…` 在 connect-src `cyrene:` + ACAO（见 §3.4）下可读。

### 3.2 A2 — Live2DAdapter + CubismGL 抽象

- **`CubismGL` 接口（最小面，可注入）**：`createTexture/deleteTexture`、`bindTexture`、`getContextAttributes`（isWebGL2）、`getParameter(MAX_TEXTURE_SIZE)`、`getError`、`drawArrays`、`viewport`、`createShader/compileShader/linkProgram/useProgram`（覆盖 Framework 渲染器实际调用）。实现对 = 封装真实 WebGL context；测试对 = fake 记录调用 + 可按需注入 `getError` 非零/抛错模拟 GPU-lost。
- **`Live2DAdapter`**：
  - `initialize(canvas)`：`CubismFramework.startUp(cubismOption)` → `CubismFramework.initialize()`（**官方真实序列**，Demo lappdelegate 同款；r.5 无 `getInstance().reinitialize`，不调用）；release 用 `CubismFramework.dispose()`。
  - `createModel(modelUrlBase, modelId)`：先经 `registry`（Main）校验可用 → fetch `cyrene://renderer/__cyrene-live2d/{modelId}/{model3Path}` 解析 `model3.json`；**所有 FileReferences 以 model3.json 所在目录为 base 解析**（moc3/纹理/物理/动作的相对路径），逐一经协议按需 fetch；渲染器装配后、**首次 draw 前**调 `renderer.loadShaders('/live2d/shaders/')`（官方 Demo 同款；内部对 `CubismShader_WebGL` 实例 `setShaderPath`，见 D5A-02b）。
  - `update()`（`CubismModel.update()` + 物理 + draw）；`destroy()` 释放全部 Cubism 内存与 GL 资源（无残留 timer/事件/音频分析器）。
  - WebGL1 context `canvas.getContext('webgl', { alpha:true, antialias:false, depth:false })`；context 丢失 → 抛 `Live2DGpuLostError` 供上层回退。
  - **纹理超限**（`getParameter(MAX_TEXTURE_SIZE)` < 纹理边长 或 创建失败）→ 抛 `Live2DTextureError`，上层走静态头像回退（D5A-11）。

### 3.3 A3 — Main 模型注册表

- `src/main/live2d/model-registry.ts`：
  - `listInstalledModels(): Promise<Live2DModelSummary[]>`：扫 `dirs.models/*/manifest.json`，`manifestSchema`（zod，必填字段与可选缺省遵循 D5A-07：`id/displayName/modelFile/licenseRef/integrityManifest` 必填，`preview/expressions/motions/version` 可选带缺省）逐模型校验；**两级可用性**（与 D5A-07 对齐）：manifest 校验失败（含 licenseRef 缺失）→ 整目录跳过；合法但 **integrity.json 覆盖的模型文件**缺失/尺寸不符 → 列出且 `available=false`（`preview.png` 条目属豁免：缺失/尺寸不符不置可用性为假，UI 占位）；汇总 `{ id, displayName, preview, version, available, licenseRef, integrityState }`（`available=false` 附原因，脱敏）。
  - `resolveModelFile(modelId, relPath): Promise<string | null>`：registered+`available` 模型、路径 containment（realpath + prefix 逐段）、白名单（relPath ∈ integrity.json entries，尺寸复核）；未命中返回 null（协议层映射 4xx）。
  - `verifyIntegrity(modelId): Promise<void>`：全量 SHA-256 复核；**pending 语义**（同模型并发命中共享同一 promise）；失败熔断该模型 `available=false` 并记录；会话内 verified 缓存。
  - 一律只读安全路径（复用 `safe-open`/`user-data-dirs` 纪律，拒绝 symlink/FIFO/设备）。
- **IPC**：`src/main/ipc/live2d-handlers.ts` 经既有 `registerHandlers` 登记 `live2d:list-models`（invoke，返回摘要数组，错误脱敏）。preload `desktop-api.ts` 增 `listLive2dModels()`（zod-validate 结果）；`ipc-security.spec.ts` / IPC 方法白名单同步；preload `index.d.ts` 类型同步。**不新增单向通道**。
- **Registry 摘要为 doc 05 §3 `Live2DModelSummary` 的扩展超集**（多出 `licenseRef`/`integrityState`/两级 available）——按文档同步纪律回写 doc 05 §3 接口注释。

### 3.4 A4 — cyrene:// live2d 供给分支

- `protocol/handler.ts` 增分支（在 media 分支之后、renderer-root 分支之前）：
  - 路径 `cyrene://renderer/__cyrene-live2d/{modelId}/{relPath}`；`modelId` 用 ASCII slug **不编码**（正则 `^[A-Za-z0-9._-]+$` 且 `id !== '.' && id !== '..'`）；`relPath` 按 `/` 分段 percent-decode，**逐段拒绝**：空段、`.`、`..`、解码后含 `/`、`\`、NUL 的段、以绝对路径起始。
  - 校验顺序：`isDocumentRequest` → 403；modelId 未 registered/`!available` → 404；`registry.resolveModelFile`（containment + 白名单 + 尺寸）→ 命中返回文件（`mimeOf` + `Cache-Control: no-store`），未命中 403。
  - **首次服务某模型 fail-closed**：首个命中请求 await `verifyIntegrity`（同模型共享同一 pending promise）；失败 → 熔断 4xx。
  - **CORS（dev）**：对请求 `Origin` 头用既有 `isTrustedDevUrl(new URL(origin), getTrustedDevOrigins())`（回环 hostname 恒放任意端口 + allowlist 精确 origin 两条路径，`trusted-renderer-origin.ts:38`）判定；命中 → 成功**与错误响应均**回补 `Access-Control-Allow-Origin: <origin>` + `Vary: Origin`（错误响应回补否则 dev 读不到 4xx 原因只剩 CORS 拒绝）；prod 页面同源不需 ACAO。
  - 常量/`parseLive2dPath` 放独立模块 `protocol/live2d-path.ts`（镜像 media-service parse 纪律）。
- **已知限制（写死）**：verify 通过后同一会话按白名单+尺寸服务——「同尺寸不同内容」的替换可被服务（本地模型目录信任边界=用户本人，可接受）；记录于 §4。

### 3.5 A5 — 装配工具（dev CLI）

- `apps/desktop/scripts/live2d-install.mjs`（Node，Main 侧脚本，不依赖 Electron runtime；integrity 计算器与 Main `verifyIntegrity` 共用校验器）；经 package.json 暴露 `pnpm -F @cyrene/desktop live2d:install`。
- 入参：`--model-dir`（原始模型目录）、`--id`（ASCII slug，校验 `^[A-Za-z0-9._-]+$` 且非 `.`/`..`）、`--display-name`、`--license-note`（可选）、`--force`（非交互覆盖已存在同 id）。
- 步骤：(1) 校验必需文件（model3.json/moc3/至少一纹理）；(2) **userData 解析镜像 Main `expectedUserDataBase()`**（`appData/Cyrene`：Linux `XDG_CONFIG_HOME`/`$HOME`、Windows `APPDATA`、macOS 各自的跨平台解析，脚本无 Electron runtime 需自行实现；配**多平台 env 单测** + **一次与 Electron 真实 `app.getPath('appData')` 的 harness 对比**防漂移），目标 `userData/models/<id>/`；同 id 已存在且无 `--force` → 非零退出；(3) **拷贝**（非 symlink）；(4) **注入 license note → `LICENSE.txt`**（`--license-note` 内容，缺省写「免费版·个人开发验证」注记 + 来源占位）——**先于 manifest/integrity 生成**（step 5/6 引用的 `licenseRef`/`LICENSE.txt` 须已落地）；(5) 生成 `manifest.json`（`id`/`displayName`/`modelFile`/`licenseRef`(=LICENSE.txt)/`integrityManifest` + 可选 `preview`/`version`/`expressions`/`motions`——`preview` 由目录内 `icon.png` 拷贝为 `preview.png`、无 icon 则省略；`version`/`expressions`/`motions` 从 model3.json 读 Version/Motions/Expressions，缺失省略）；(6) 生成 `integrity.json`（**文件集 = 模型文件**：model3.json 及其 FileReferences（moc3/纹理/physics/motions/expressions/pose/sounds）+ LICENSE.txt + `preview.png`；**排除 manifest.json/integrity.json 自身**；每条相对路径 + size + sha256，空目录/隐藏文件跳过并 warn——preview.png 列入受服务与可用性豁免，见 D5A-07；**在所有文件（含 LICENSE.txt/preview.png）落地后生成，避免顺序循环**）。
- **输出**装配报告（文件数/总字节/hash 数）。该工具生成布局即 doc 05 §4 资源包（`assets/live2d/<id>/` → `userData/models/<id>/`）。

### 3.6 A6 — Live2DController + live2dStore + 最小面

- **`Live2DController`（doc 05 §3 接口子集）**：`listInstalledModels/load/switchModel/unload/setVisibility/setPerformanceMode/reset` 首批落地；`setState/setExpression/playMotion/setMouthLevel/setLookTarget` 留接口签名、批次 A 内为 no-op 占位（批次 B 落地），避免过度实现（YAGNI）。
- 状态机 `unloaded → loading → ready | failed → fallback`；**`device_lost` 事件**（Adapter 抛 `Live2DGpuLostError`）→ failed → fallback（重建策略注明归批 C）。`loading→ready` 校验 registry `available` + Adapter 创建成功 + 首帧 `update()+draw()` 无错。
- **`live2dStore`（Pinia）**：`models: Summary[]`、`status`、`modelId`、`error`；`init()`（list → 选 enabled+available 模型 → 已 ready 不重复加载）；`switchModel(next)`（停当前→load→原子替换→失败保留原 modelId）；`dispose()`。
- **最小持久化（契约改动面，D5A-10）**：`SettingsState` 增 `live2d: { enabled: boolean; modelId: string | null }`。**向后兼容机制必须显式落地，否则会毁掉既有设置**：`SettingsStateSchema`（`z.object` 全字段必填）对 `live2d` 用 **`.default(DEFAULT_LIVE2D)`（`DEFAULT_LIVE2D = { enabled: true, modelId: null }`）**（input 可缺省 → 旧 `settings.json` 无 `live2d` 段也能通过 parse；**不得**做成必填，否则老文件走 corrupt+全量重置，清掉 voice/dictation）；`DEFAULT_SETTINGS` 的 `live2d` 引用 `DEFAULT_LIVE2D`；`SettingsService.save()` 增第三 merge 行 `live2d: { ...this.state.live2d, ...patch.live2d }`（否则部分 patch 如 `{enabled:false}` 会丢 `modelId`）；`SettingsPatch`/`SettingsPatchSchema` 增嵌套 `live2d: Partial<Live2DSettings>` 段。preload `settings:load/save` 的 zod 栈自动覆盖。
- **`enabled` 语义**：缺省 `true`；与 G1 布局折叠标志 `live2dShown`（`App.vue:73` `v-show` 驱动右栏可见）**正交**——`live2dShown=false` 是布局级隐藏（不创建渲染循环）；`enabled=false` 时面板渲染为「Live2D 已关闭」静态态（不创建渲染循环；批次 B 设置页统一开关）。
- **`CyLive2DPanel.vue`（改造既有，非新建）**：保留 resizer/折叠/状态栏与网格 `grid-area: live`（`App.vue:73` 已 `v-show` 挂载，不动挂载点）；把内部 stage 替换为 `<canvas>`（尺寸随栏宽，resize 重设自缓冲；右栏不可见即不创建渲染循环）+ 模型下拉（`init`/`switchModel` 驱动）+ 加载/失败/静态头像态展示。完整设置 UI 归 B5。
- 聊天/权限不受影响：`CyLive2DPanel` 异常 → 组件内错误态，App 其余区块不动。

## 4. 安全设计

- **信任边界**：文件系统 / 校验 / 持久化只在 Main；renderer 不解析本地路径，只 fetch `cyrene://` 已校验 URL。
- **CSP**：`script-src 'self'` 三处维持不放宽（Core=asm.js，见 D5A-03）；唯一变化是 **dev** `connect-src` 加 `cyrene:`（fetch 模型文件）。
- **协议供给**：containment（realpath+prefix）+ integrity 白名单（文件清单）+ 尺寸复核 + 文档请求拒绝 + modelId/relPath 逐段校验（拒绝 `.`/`..`/解码后 `/`、`\`、NUL）+ 未知模型/越权文件一律 4xx；**fail-closed hash**。
- **装配/注册表**：只读目录；`safe-open` 纪律（非普通文件全拒）；symlink 拒绝（装配用拷贝非链接）；integrity 全量复核在 load 时强制。
- **CORS**：仅 dev 受信 origin 回补 ACAO；prod 同源不加。
- **已知限制**：verify 通过后同会话按白名单+尺寸服务，「同尺寸不同内容」替换可过（本地模型信任边界＝用户本人）；列表/校验错误只记 modelId + 状态，不记路径/内容/hash。

## 5. 测试策略

单测（fake GL / 内存目录 / 装配产物夹具 / fake registry）：

| 面 | 用例 |
|---|---|
| 构建/CSP | `buildRendererCsp`/`buildDevCsp` **不含** `'wasm-unsafe-eval'`/`'unsafe-eval'`；dev `connect-src` 含 `cyrene:`（**`buildDevCsp` 与 index.html meta 两处**，prod 不含）；`parseLive2dPath` 合法/非法矩阵 |
| 注册表 | 两级可用性：manifest/schema 非法（**含 licenseRef 缺失**）→ 整目录跳过；合法但 integrity 覆盖的模型文件缺失/尺寸不符 → available=false；**preview 缺失不置可用性为假**；`resolveModelFile` containment（`..`/绝对路径/symlink/跨模型目录/解码走私段）全拒；`verifyIntegrity` pending 共享 + hash 匹配/不匹配熔断 |
| 协议 live2d 分支 | `isDocumentRequest` 403；未知 modelId/`!available` 404；白名单外文件 403；白名单内文件 200 + mime + no-store；fail-closed 时序（verify 完成前不响应，哈希失败→4xx）；dev Origin ACAO 回补 |
| Controller/Store | 状态机 unloaded→loading→ready/failed/fallback；`device_lost`→failed（fake GL 抛 `Live2DGpuLostError`）；切换失败保留原 modelId（fake adapter 抛错注入）；list 来自 fake registry；dispose 释放无残留（spy destroy） |
| 装配工具 | 夹具目录 → manifest/integrity 生成正确（递归相对路径/hash/尺寸）；非法输入（缺纹理/缺入口、非目录、非法 id）报错非零退出；`--force` 覆盖、无 `--force` 幂等拒；userData 解析镜像 `expectedUserDataBase`（各平台 + env 覆写） |

集成（Playwright `_electron` + xvfb-run / SwiftShader；prod out/，页面即 cyrene://renderer 同源）：

| 面 | 用例 |
|---|---|
| 真实装配 | 用 A5 装配 **Haru**（`third_party` 已入库，CI 可复现）→ 启动 app → `live2d:list-models` 返回且 available；**修女莉尔**（`tmp/live2d/` 未入库）→ 本机 harness，代码 skip-when-absent |
| 首帧渲染 | 右栏加载 Haru → store `status=ready` + `canvas` 非空像素（`getImageData` 采样非全透明）+ 无 console error |
| 切换 | Haru 与第二模型间切换 → 新模型 ready（或按 D5A-11 静态头像回退且不 crash）；**损坏注入**（装配后手工改文件使 integrity hash 不匹配）→ failed 保留原模型 + 聊天按钮可用 |
| 协议安全 | 直接 fetch 白名单外路径 → 4xx；document 请求 → 403；**dev 端口 Origin**（如 `http://localhost:5173`）→ ACAO 回补含该 origin + `Vary: Origin` |
| 设备丢失 | 注入 GPU-lost（释放/替换渲染上下文）→ 静态头像回退 + 聊天按钮可用 |
| 折叠隐藏 | 右栏 `live2dShown=false` 后 → 渲染循环停止（无新帧更新，canvas 停止增长） |
| 持久化 | 切换后重启 app → modelId 恢复（settingsStore 读回）；旧版 settings.json 无 live2d 段 → 默认加载不崩 |

## 6. 验收清单（批次 A）

- [ ] 至少一个已装配、通过完整性校验的模型经全链路渲染出首帧（state=ready + canvas 非空像素）；
- [ ] `userData/models` 下列出已装配模型：非法目录跳过，损坏/越权文件不进 available 列表；
- [ ] cyrene:// live2d 分支只服务 integrity 白名单内文件，containment/文档请求/未知模型/解码走私段全拒，首个请求 fail-closed hash；
- [ ] 两个已装配模型可切换；切换失败/纹理失败/GPU-lost 保留当前模型与聊天状态（静态头像回退）；
- [ ] CSP 三处无 `'wasm-unsafe-eval'`；dev `connect-src` 含 `cyrene:`（header 与 meta 两处；prod 页面同源 `connect-src 'self'` 已放行，meta 增 `cyrene:` 经交集不扩面），dev 页可 fetch cyrene:// 模型（`isTrustedDevUrl` 判定 ACAO 回补 + `Vary: Origin`）；
- [ ] 隐藏/折叠右栏后不创建/暂停渲染循环（不渲染空白画布）；
- [ ] `device_lost`→静态头像，不破坏聊天与权限操作（集成用例覆盖）；
- [ ] 装配工具产物符合 doc 05 §4 布局，licenseRef 存在；许可记录落 doc 05 §15 + 决策记录；
- [ ] 全文档计数/状态同步（doc 05/10/12/16 + README + 决策记录 + CLAUDE.md 措辞，按既定纪律）。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Core 加载路径与 CSP 判断（asm.js 误判为 wasm） | D5A-03 已实证 asm.js + A1 spike 运行时探针复核；若探针推翻则 spec 修订 + 复审 |
| dev 模式 fetch cyrene:// 被 connect-src/CORS 拦截 | §3.1/§3.4：dev `connect-src` 加 `cyrene:`（header **+** meta 两处）、live2d 分支对命中的 `isTrustedDevUrl` origin 回补 ACAO 并加 `Vary: Origin`；prod 页面同源不受影响 |
| shader 运行时 fetch 404 导致首帧失败 | D5A-02b：vendor Shaders/WebGL/ → public/live2d/shaders/ + `loadShaders('/live2d/shaders/')` 重定向（关键路径，A1 spike②确认） |
| 8192 纹理在低端 GPU/SwiftShader 失败 | D5A-11：优雅失败→静态头像；批 C 降级策略；CI 用 Haru 2048 |
| Framework 源码大、升级成本 | vendored 原样保留 + THIRD_PARTY_NOTICES；升级按 SDK 版本整体替换重验（doc 05 §15） |
| 全量 hash 拖慢 list/首帧 | D5A-07/08：list=结构/尺寸；全量 hash 仅首次 load 一次（fail-closed pending） |
| 「同尺寸不同内容」替换 | §4 已知限制（本地信任边界=用户本人） |

## 8. 需要记录到最终报告的中途决策（批次 A 执行中若出现）

- 任何对 §0 决策的偏离（如 A1 spike 推翻 asm.js 判断、装配工具幂等语义、store 字段增删、IPC schema 调整）均按既定流程：**按推荐执行 → 记入本节/决策记录 → 最终报告汇报**。

---

（本 spec 之后进入 plan；批次 B/C 各自独立 spec 与 plan，不在本文件。）