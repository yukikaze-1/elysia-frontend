# Cyrene Live2D 前端接入设计

**文档状态：** 维护中
**最后核验：** 2026-08-29
**适用阶段：** 阶段 5～8
**权威范围：** Live2D 资源、安全、状态、性能和降级设计
**初始文档日期：** 2026-08-03

> **状态说明：** 正文中的带日期实施/联调注记只代表当时快照；当前阶段、阻塞项和最近验证统一读取 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)。

---

## 1. 目标

Live2D 为 Cyrene 提供持续角色形象和基础情绪反馈。它是表现层，不参与聊天、工具或权限决策。

P0 目标：

- 加载已安装并通过校验的模型；
- 在设置页切换 Live2D 模型；
- 待机、眨眼、呼吸和轻微视线跟随；
- 根据连接、生成、工具和错误状态切换表现；
- TTS 播放时进行基础音量口型；
- 角色栏作为聊天窗口右侧布局列展开，不覆盖消息、滚动条或输入区；
- 支持隐藏、降帧和静态头像降级；
- Live2D 失败时聊天保持完整可用。

P0 不包含摄像头追踪、精确音素口型、模型商店或未经校验的任意模型导入。Demo 至少准备两个可切换的模型配置或角色皮肤，用于验证切换流程。

## 2. 分层结构

```text
Vue Live2DPanel
       ↓
Live2DController
       ↓
Expression / Motion / LipSync / Performance
       ↓
Live2DAdapter
       ↓
选定的 Cubism Web SDK 或兼容封装
```

业务模块只依赖 `Live2DController`，不直接调用 SDK API 或动作文件名。

## 3. 核心接口

```typescript
interface Live2DController {
  listInstalledModels(): Promise<Live2DModelSummary[]>;
  load(modelId: string): Promise<void>;
  switchModel(modelId: string): Promise<void>;
  unload(): Promise<void>;
  setState(state: CharacterState): void;
  setExpression(name: string, priority?: MotionPriority): void;
  playMotion(name: string, priority?: MotionPriority): Promise<void>;
  setMouthLevel(level: number): void;
  setLookTarget(target: NormalizedPoint | null): void;
  setVisibility(visible: boolean): void;
  setPerformanceMode(mode: PerformanceMode): void;
  reset(): Promise<void>;
}

interface Live2DModelSummary {
  id: string;
  displayName: string;
  preview: string;
  version: string;
  available: boolean;
}
```

> **注（批次 A 落地，2026-08-17）：** Main 注册表摘要为上文 `Live2DModelSummary` 的**扩展超集**，多出 `licenseRef`（指向装配注入的 `LICENSE.txt`）与 `integrityState`（`unverified|verified|failed`），并引入**两级可用性**——`available=false` 附脱敏 `reason?`（如 `missing_file`/`size_mismatch`/`hash_mismatch`）；`preview` 条目不参与可用性判定（缺失用 UI 占位）。完整契约见 `shared/contracts/live2d.ts`。

```typescript
type CharacterState =
  | "offline"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "waiting_permission"
  | "working"
  | "happy"
  | "sad"
  | "surprised"
  | "error";

type MotionPriority = 0 | 1 | 2 | 3;
type PerformanceMode = "auto" | "quality" | "balanced" | "low_power";
```

> **注（批次 B 落地，2026-08-18）：** 上表接口按批次 B 真实实现修订——`switchModel(modelId)` 签名由 `Promise<void>` 改为 **`Promise<string>`**（返回**实际生效 id**，D5B-10/T6 竞态硬化：切换中串行守卫/同模型幂等丢弃时返回旧 id，store 仅持久化生效 id）；新增 `setState(s)`（服务状态机命令，状态源已仲裁采纳）、`setAutoMotions/setLipSync/setMouthLevel`（待机/口型独立门与电平原语）、`setViewTransform(scale, offsetX, offsetY)`（Panel 缩放/偏移手柄，安全钳制 scale∈[0.5,3]、offset∈[-2,2]）、`setLookTarget(target|null)`（视线跟随/回正，null=回正）、`playMotion(file, priority)`/`playTapMotion(priority)`（B3 动作白名单调度：低优先不打断 3 级态、同动作去抖、长动作超时、切换清队列）、`setExpression(file)`（I-4 白名单文件路径唯一标识）、`on(event, cb)` 订阅（`state`/`device_lost`/`status`/`error`）。完整签名与语义见 `renderer/src/live2d/controller.ts`。
>
> **`Live2DModelSummary` 完整 8 字段（契约 `shared/contracts/live2d.ts`）：** `id`/`displayName`/`preview`（相对模型目录的预览图路径，可 null）/`version`/`available`（两级可用性：manifest 合法 + integrity 覆盖文件存在且尺寸一致）/`reason?`（仅不可用时脱敏枚举码 `missing_file|size_mismatch|hash_mismatch`）/`licenseRef`（模型目录内许可文件相对路径）/`integrityState`（`unverified|verified|failed`）。
>
> **`Live2DSettings` 全量 10 字段（doc 11 §7.1 设置子页 + doc 05 §14）：** `enabled`（缺省 true；与 G1 布局 `live2dShown` 正交）/`modelId`（null = 默认首个可用）/`scale`（0.5–3）/`offsetX`/`offsetY`（±2）/`mouseTracking`/`autoMotions`/`lipSync`/`performanceMode`（统一四值 `auto|quality|balanced|low_power`，旧三值 `high/low` 读回归一）/`reduceMotion`。契约经 `SettingsStateSchema.live2d` `.default(DEFAULT_LIVE2D)` 兼容旧 settings.json（不崩、不 bump version）。

> **注（批次 C 收口落地，2026-08-18，D5C-09）：** 本表接口按批次 C 真实实现再修订——`reset(modelId?)` 签名扩展：缺省当前 modelId 优先、不可用回退首个可用、失败 → fallback（GPU 丢失一次重建路径，D5C-04）；`setExpression(file): boolean` 与 `playMotion(file, priority, durationMs?): boolean` **均返回 boolean**（白名单命中执行 true、未命中/未就绪/仲裁拒绝 false，脱敏日志落点）；`playMotion` 扩**第三参 `durationMs`（数值）**，生效时长取 `min(durationMs, MOTION_MAX_MS=15s)`，显式 durationMs 跳过同动作去抖合并；`live2dStateSource` 返回句柄 **`{ unsub, recompose }`**（`recompose()` 按当前业务源重组合，供 GPU 重建后恢复 CharacterState）；state-source 增 **`pushDirective(state, strength, durationMs?): boolean`**（后端指令瞬态覆盖：建议强度 ≤1 仲裁、永不覆盖 client 2/3 级现实态、超时回业务态）。**lipSync 门定案（批次 B Task5 M3 关闭，D5C-02）**：lipSync 只门控 C1/B4 **参数级电口**（`autoMotions ∧ lipSync` 门写 `ParamMouthOpenY`，门关写 0 清态、不残留上一帧）；**B3 动作口部不受 lipSync 门**（模型作者编排，闭嘴门控记为后续需求）。完整签名与语义见 `renderer/src/live2d/controller.ts` / `renderer/src/composables/live2d-state-source.ts`（2026-09-17 架构整改 Prompt 5 从 `live2d/state-source.ts` 迁出） / `stores/live2d.store.ts`。

## 4. 模型资源包

推荐资源目录（**源目录**形态——装配前的原始模型；装配后落到 userData `models/<id>/`，见下方注）：

```text
assets/live2d/<model-id>/
├── manifest.json
├── model3.json
├── model.moc3
├── textures/
├── motions/
├── expressions/
├── physics3.json
├── pose3.json
└── preview.png
```

> **注（实际落地口径，2026-09-10 校正）**：运行时读取的是 **userData 下的 `models/<id>/`**，不是仓库内的 `assets/live2d/`——模型因授权原因不随仓库分发（`EXT-01`）。且模型目录**必须经装配工具生成**（含 `manifest.json` 与 `integrity.json`），不能手工摆放：
>
> ```powershell
> pnpm live2d:install --model-dir <源目录> --id <slug> --display-name "<显示名>"
> ```
>
> 工具由源目录产出 `LICENSE.txt` / `preview.png` / `manifest.json` / `integrity.json` 并拷贝到目标目录。安装路径与参数约束见 [doc 17 §3.1](17-Cyrene-前端开发环境与依赖安装记录.md)。

客户端自定义 `manifest.json`：

```json
{
  "id": "cyrene-default",
  "displayName": "Cyrene",
  "modelFile": "model3.json",
  "preview": "preview.png",
  "expressions": ["neutral", "happy", "sad", "surprised"],
  "motions": ["idle", "greeting", "thinking", "speaking"],
  "licenseRef": "LICENSE.txt",
  "integrityManifest": "integrity.json"
}
```

所有资源路径从已安装模型目录解析，拒绝绝对路径、`..`、符号链接/连接点逃逸和未列入完整性清单的文件。`integrity.json` 记录相对路径、大小和 SHA-256；安装、切换和打包时复核。后端不能传入本地路径、URL 或脚本来加载新资源。

设置页只列出已安装且 Manifest、资源完整性和许可状态通过校验的模型。

## 5. 加载生命周期

```text
unloaded → loading → ready
               ↓       ↓
             failed ← device_lost
               ↓
             fallback
```

加载步骤：

1. 检查用户是否启用 Live2D；
2. 读取模型 Manifest；
3. 验证资源路径和白名单；
4. 创建渲染上下文；
5. 加载模型、纹理、物理和默认动作；
6. 进入待机状态；
7. 失败时释放已创建资源并显示静态头像。

切换会话不重复加载同一模型。窗口隐藏或系统休眠时暂停高频更新。

> **注（2026-08-19 CI 修复）：** `BrowserWindow` 已设 `backgroundThrottling: false`——渲染进程 timer/rAF 恒定运行，
> 不随窗口遮挡/失焦被 Chromium 全局节流。原因：① 无 WM 的 headless CI（xvfb）下窗口被判为遮挡 → 默认节流
> （timer~1/秒 + rAF 暂停）会让 Live2D 渲染环停摆（口型/画布断言失败）；② 生产上全渲染进程 timer 节流会拖慢
> 流式回复/语音/TTS 实时链路。**「窗口隐藏暂停高频更新」改由 app 自有机制负责**：`live2dShown ∧ enabled`
> 门（布局折叠/关闭时 Panel `startStop` 停 rAF，D5C-05 可见性收口）不再依赖 Chromium 全局节流。

> **已补齐（2026-09-12，全量评审 M-37）：上面最后半句"「窗口最小化时暂停渲染」为后续可选项（当前最小化仍渲染）"
> 已不再是可选项，现已落地。** 实测该缺口是真的：`backgroundThrottling:false` 关掉了浏览器自身节流，而应用自有的
> `active` 门当时只含 `currentView ∧ live2dShown ∧ enabled ∧ status==='ready'`——**没有窗口状态项**，
> 全仓 `visibilitychange` / `document.hidden` / `IntersectionObserver` 0 命中。于是窗口最小化/切走后仍在做
> 每帧完整模型更新+绘制（`quality` 模式下 `perf.ts` 不设上限）。
>
> 现规定：窗口可见性是渲染 gate 的**组成部分**，由 `renderer/src/utils/document-visibility.ts` 提供
> （读 `document.hidden` 并订阅 `visibilitychange`；单例，整棵 renderer 只挂一个监听），并**同时**并入两处：
> ① `CyLive2DPanel` 的 `active`（rAF 启停）；② 同组件的 `surfaceVisible`（上报 store，驱动 controller 侧暂停）——
> 只接一处会让另一条路径继续跑，故两处都接，并有源码级断言钉住（`tests/unit/document-visibility.spec.ts`）。
>
> **覆盖范围如实说明**：`visibilitychange` 覆盖"最小化 / 切到别的应用 / 文档隐藏"，**不**覆盖"窗口被另一个窗口
> 遮挡"（遮挡不触发该事件；`IntersectionObserver` 对 Electron 顶层窗口也不适用）。故本项解决的是"最小化仍全速
> 渲染"这一半，未声称解决遮挡。


### 5.1 模型切换

模型切换流程：

1. 校验目标模型已安装且可用；
2. 保存当前模型 ID，不保存实时动作进度；
3. 暂停动作、口型和渲染事件；
4. 预加载目标模型关键资源；
5. 目标加载成功后原子替换当前模型；
6. 恢复当前业务状态；
7. 加载失败时继续使用原模型并提示原因。

切换过程中聊天、语音和工具流程不得暂停。后端只可以建议 `modelId`，最终是否允许切换由客户端已安装白名单和用户设置决定。

## 6. 状态来源与优先级

状态来源包括：

- 客户端连接；
- AI 生成；
- TTS 播放；
- 工具等待授权；
- 工具执行；
- 后端可选表现指令；
- 用户点击互动。

推荐优先级：

| 优先级 | 状态 | 说明 |
|---:|---|---|
| 3 | error、waiting_permission | 必须让用户感知 |
| 2 | speaking、working、thinking | 当前主要任务 |
| 1 | 后端情绪建议、用户互动 | 可被主要任务打断 |
| 0 | idle、自动眨眼、呼吸 | 默认循环 |

高优先级状态结束后回到当前业务状态，而不是一律回到 `idle`。

## 7. 状态映射

| 业务事件 | 角色状态 | 默认表现 |
|---|---|---|
| 未连接 | offline | 低活跃待机 |
| 已连接且空闲 | idle | 待机、眨眼、呼吸 |
| 用户正在输入 | listening | 轻微注视输入区 |
| 生成开始 | thinking | 思考动作 |
| 首个正文增量到达 | speaking | 说话动作 |
| TTS 播放 | speaking | 说话动作 + 口型 |
| Desktop 工具待授权 | waiting_permission | 提醒动作 |
| 工具运行 | working | 工作动作 |
| 生成或工具失败 | error | 短暂错误表情 |
| 完成且无音频 | idle | 平滑回到待机 |

AI 文本内容不在前端进行复杂情绪分析。后端有明确指令时可作为低优先级建议。

消息 `emotion` 主要用于文本标签展示；只有经过本地映射表识别的情绪代码才能转换为 Live2D 表情。未知代码显示为普通心情文本或“未知”，不能直接当作动作/表达式名称。

后端 `generation.completed.mood` 为 **LLM 自由文本**（真实值如「开心」「平静」「难过」，也可能混英文），前端经 `normalizeEmotionCode`（`renderer/src/composables/live2d-state-source.ts`；2026-09-17 架构整改 Prompt 5 从 `live2d/state-source.ts` 迁出）本地归一为 `happy/sad/surprised` 枚举码——ASCII 大小写不敏感、中文按字面精确匹配（别名表见 §18）。未命中保持 `undefined` → `idle`（行为不变）；归一只在本地进行，未知码绝不成为动作/表达式名（联调前整改 F-1，2026-08-18）。

## 8. 后端表现指令

```typescript
interface Live2DDirective {
  state?: CharacterState;
  expression?: string;
  motion?: string;
  priority?: 0 | 1 | 2 | 3;
  durationMs?: number;
}
```

校验规则：

- 状态必须在前端枚举中；
- 表情和动作必须存在于 Manifest 白名单；
- 后端优先级上限由客户端限制；
- 持续时间设置上下限；
- 不接受路径、URL、代码或任意参数名；
- 无效指令被忽略并记录脱敏警告，不影响消息显示。

## 9. 动作调度

调度器维护：

- 当前动作；
- 当前优先级；
- 是否可中断；
- 排队的短动作；
- 待机恢复状态。

规则：

- 低优先级动作不能打断权限提醒或错误；
- 同一动作在短时间内重复触发时合并；
- 长动作设置最大时长；
- 会话快速切换不堆积动作；
- 模型未就绪时只记录最新业务状态，不缓存全部动作；
- TTS 停止后口型立即进入平滑归零。

## 10. 基础口型同步

P0 使用音量驱动：

```text
TTS Audio
   ↓ Web Audio Analyser
RMS / 音量包络
   ↓ 平滑、阈值、缩放
mouthLevel 0..1
   ↓
Live2D 嘴部参数
```

建议处理：

- 使用短窗口 RMS；
- 设置噪声门限；
- 上升较快、下降稍慢；
- 限制最大变化速度；
- 静音、暂停和结束时归零；
- 音频播放失败时停止口型但不影响文字消息。

不根据字符数量伪造口型，不使用麦克风输入驱动 AI 的嘴部。

## 11. 鼠标和点击互动

P0：

- 鼠标在角色区域移动时轻微视线跟随；
- 离开后平滑回正；
- 点击一个安全命中区域触发预设动作；
- 正在权限提醒、错误或 TTS 时，普通点击不打断高优先级动作。

用户开启“减少动态效果”后关闭鼠标跟随和非必要点击动作。

> **作用域扩展（2026-09-12，全量评审 M-24）：** 上句只覆盖 Live2D 侧。该开关现已**同时门控整个界面的持续 CSS 动画**——判据为「系统 `prefers-reduced-motion` ∨ 本开关 ⇒ 根元素 `cy-reduce-motion` 类」，由 `renderer/src/reduced-motion.css` 关掉 6 处 `animation: … infinite`（覆盖完整性由 `tests/unit/reduce-motion.spec.ts` 守住）。连带后果：`CyLive2DPane` 里该开关**不再随 Live2D 启用状态禁用**（作用域已超出 Live2D，关闭 Live2D 时它仍有实际作用）；开关文案相应改为「禁用鼠标跟随与点击动作，并关闭界面持续动画（减轻晕动）」。Live2D 侧行为本身未变。

## 12. 性能策略

### 12.1 性能模式

| 模式 | 目标帧率 | 行为 |
|---|---:|---|
| quality | 60 FPS | 完整物理和动作 |
| balanced | 30～60 FPS | 根据负载调整 |
| low_power | 30 FPS 或更低 | 降低物理更新和画布分辨率 |
| auto | 动态 | 根据窗口可见性和帧耗时选择 |

> **落地口径（2026-09-14 评审报告 §16.2 L-3）：** 本表是**设计目标**；批次 C 实际落地的只有**帧间隔降帧**一项——`live2d/perf.ts` 的 `FrameBudget` 四值只决定 `shouldDraw` 的帧间隔（quality 恒满帧／low_power 33.33ms 封顶／balanced 按 EMA 帧耗时 60↔30／auto 迟滞升降档），**不改物理更新频率、也不改画布分辨率**（`grep` renderer 无 `devicePixelRatio`，canvas 尺寸只随 CSS 盒变化）。故 `low_power` 行的「降低物理更新和画布分辨率」与 `auto` 行的「根据窗口可见性…选择」两项**当前未落地**。

### 12.2 自动降级

- 窗口隐藏：暂停渲染循环；
- Live2D 栏折叠：暂停画布并保留状态；
- 连续帧耗时过高：降低帧率；
- GPU 上下文丢失：尝试重建一次；
- 重建失败：静态头像；
- 系统低电量模式：切换低功耗配置。

> **落地口径（2026-09-14 评审报告 §16.2 L-3）：** 上一条「系统低电量模式」**当前未落地**——代码侧不读系统电量（`grep` 无 `battery`／`getBattery`），没有任何按电量自动切 `low_power` 的路径；只能由用户在设置页手动选。其余五条（隐藏/折叠暂停、帧耗时降帧、GPU 丢失重建一次、重建失败静态头像）均已落地。

Live2D 资源释放后不得残留计时器、音频分析器或事件监听器。

> **补充：GPU 纹理也属于"不得残留"之列（2026-09-12，全量评审 M-25）。** 实测原状的缺口：纹理由**本项目 glue** 创建（`live2d/adapter.ts` 的 `loadTexture` 调 `gl.createTexture`；vendored framework 只管理它自己的离屏渲染目标），而 teardown 只置 `this.gl = null; this.canvas = null`，**从不 `deleteTexture`** —— `grep deleteTexture` 只命中 vendored framework。后果：2048² 模型每次加载约 **33 MB VRAM** 滞留至 GC，换模型（面板下拉）逐次累积。
>
> 现规定：**glue 创建的 GL 资源必须按实例记账、并在 `destroy()` 时显式释放**。三点细化（都不是"加一行 deleteTexture"能覆盖的）：
> ① 上传中途失败（`texImage2D`/`generateMipmap` 抛错）时**立即删除半成品纹理**——否则它既不在账上又已占显存；
> ② **context 丢失时清账**——GPU 侧资源已随 context 消失，旧 name 对重建后的 context 无意义，留着会让账目失真；
> ③ 释放路径必须容忍 `gl` 已为 null / context 已丢失（`deleteTexture` 失败不得阻断 `destroy` 的其余步骤）。

## 13. 尺寸和定位

- 画布随右栏尺寸变化；
- 右栏参与主布局排版；关闭、折叠或窄窗自动隐藏时，不改变聊天消息和滚动状态；
- 模型使用统一的标准化坐标；
- 用户可设置缩放和水平/垂直偏移；
- 设置值限制在安全范围，防止模型完全移出画布；
- DPI 和系统缩放变化时重新计算分辨率；
- 不把模型区域覆盖到权限确认窗口。

> **落地口径（2026-09-14 评审报告 §16.2 L-4）：** 上一条「DPI 和系统缩放变化时重新计算分辨率」**当前未落地**——`CyLive2DPanel.vue` 的 `resizeCanvas()` 只把 `canvas.width/height` 设为 CSS 盒的 `clientWidth/clientHeight`（**未乘 `devicePixelRatio`**），且 renderer 全树 `devicePixelRatio` 零命中；系统缩放变化时仅靠 CSS 盒变化被动跟随，不做按 DPR 的重算。其余各条均已落地（缩放/偏移带安全范围钳制、面板不覆盖权限窗）。

## 14. 设置和持久化

```typescript
interface Live2DSettings {
  enabled: boolean;
  modelId: string;
  scale: number;
  offsetX: number;
  offsetY: number;
  mouseTracking: boolean;
  autoMotions: boolean;
  lipSync: boolean;
  performanceMode: PerformanceMode;
  reduceMotion: boolean;
}
```

模型实例、动作进度和嘴部实时值不持久化。

模型选择变化应即时预览；保存失败时回退到上一个可用模型。

## 15. 资源与许可

- 代码、SDK、Core、模型、纹理、动作和音频分别记录来源和许可；
- 模型资源不因被打包进客户端就默认具备分发权；
- 构建时检查必需许可文件；
- 开源仓库和发布包可以使用不同的资源包含策略；
- 引入或升级 SDK 前重新验证 Electron/Chromium、Windows、Linux 和图形环境兼容性。

Cyrene 属于 AI/聊天角色应用，且支持切换模型、后端驱动表现及未来能力扩展，发布形态可能触及 Live2D 的 AI/Chatbot 或“Expandable Applications”分类。开发验证可先进行，但对外发布前必须按 Live2D 官方流程确认适用许可；不能仅凭“个人/小规模通常豁免”推断本项目一定豁免，因为 Expandable Application 可能需要单独审核和出版许可。模型作者授权与 Cubism SDK/Core 许可分别核对并留档。

### 15.1 资源与许可记录（批次 A 落地，2026-08-17）

| 资源 | 来源 / 版本 | 许可 | 状态 |
|---|---|---|---|
| Cubism Web SDK（Framework 源码 + Core + 13 shaders） | `third_party/CubismSdkForWeb-5-r.5/`（commit `22993e5`），vendored 进 `renderer/src/live2d/` + `public/live2d/`（Core 为 **asm.js** 构建，CSP 无需放宽，D5A-03） | Core：Live2D Proprietary；Framework：Open Software License；SDK 官方许可链接见 `renderer/src/live2d/THIRD_PARTY_NOTICES.md` | 已入库、已验证 |
| 官方示例模型 8 个 | SDK `Samples/Resources/`（Haru 等） | Free Material License（官方示例资源） | 已入库；Haru 已装配（CI 可装配） |
| 用户模型 3 个（含修女莉尔免费版） | `tmp/修女莉尔免费版/修女莉尔免费版/`（**不入 git**，路径更正依据见评审报告 §16.2；用户模型为双层同名目录，内层含 `*.model3.json`），免费版「个人开发验证」用途 | 免费版个人开发验证；装配工具注入 `LICENSE.txt`（免费版+来源+个人开发验证注记），manifest `licenseRef` 指向之 | 已装配到 `userData/models/`（haru/lil/wanko），未入 git |

发布前（批次 C 之后进入发布流程时）必须：① 按 Live2D 官方 **AI/Chatbot / Expandable Applications** 分类复核适用许可并确认出版许可；② 复核 8 个官方示例模型的 Free Material License 使用边界；③ 用户模型分发权与作者授权分别核对留档；④ 无法确认时不发布含该 SDK/模型的产物。开发验证（当前批次）可先行。

> **批次 C 台账注记（2026-08-18）：** 发布前许可复核**仍 defer**（本批只做代码批次与文档，不进入发布流程），上表资源清单与分类判断不变；批次 C 联调清单已把许可复核登记为「遗留说明节」项，进入发布流程前按上述 ①②③④ 执行。

> **路径漂移的连带影响（2026-09-14 评审报告 §16.2 L-6，代码侧待修）：** 集成夹具 `tests/integration/helpers/live2d-fixture.ts:34` 仍按旧路径 `tmp/live2d/修女莉尔免费版/修女莉尔免费版` 拼 `LIL_SRC`，因该路径不存在而 `existsSync` 恒 false ⇒ lil 分支用例在 CI 上**静默跳过**（无失败、无警告）。本文只更正文档侧路径；**夹具属代码侧，另批处置**（见评审报告 §16.3 代码侧疑点 1）。

## 16. 测试场景

- 模型首次加载成功；
- 资源缺失、损坏和路径非法；
- 完整性哈希不匹配、绝对路径和符号链接/连接点逃逸；
- GPU 上下文丢失；
- 隐藏、展开和调整窗口；
- 60/30 FPS 切换；
- thinking → speaking → idle；
- waiting_permission 打断普通动作；
- 后端发送未知表情或动作；
- TTS 播放、暂停、结束和失败；
- 快速切换会话；
- 在两个已安装模型之间反复切换；
- 目标模型损坏时保留原模型；
- 长时间待机后无明显内存持续增长；
- Live2D 完全禁用时聊天和工具流程正常。

## 17. 验收标准

- [ ] 至少两个合法、通过校验的模型配置可以加载；
- [ ] 设置页可以列出并在两个已安装模型之间切换；
- [ ] 切换失败时保留原模型和聊天状态；
- [ ] 待机、眨眼、呼吸正常；
- [ ] 生成、TTS、工具和错误状态映射正确；
- [ ] 后端无法指定任意资源路径；
- [ ] 高优先级状态不会被普通动作打断；
- [ ] TTS 音量可以驱动基础口型；
- [ ] 隐藏后停止高频渲染；
- [ ] 失败后自动降级为静态头像；
- [ ] Live2D 异常不影响聊天和权限操作；
- [ ] 角色栏始终作为聊天右侧布局列展开，不覆盖聊天内容；
- [ ] 模型及 SDK 许可已记录。
- [ ] 对外发布前已确认 AI/Chatbot、可扩展应用分类及适用出版许可；无法确认时不发布含该 SDK/模型的产物。

## 18. 实现状态（阶段 5 批次 A/B/C 落地，2026-08-18）

**三态：** 已真实联调（2026-08-19，真实 Windows Electron + Ubuntu 后端验收通过；验收记录见 `docs/review/2026-08-19-阶段5-Live2D真实联调验收.md`）。当时门禁为 typecheck/lint/build + 单测 + 集成 + `check:contract` 全绿；**测试数字（单测/集成文件数与用例数）只在 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md) 维护，此处不复制**（本行原写的 1609 单测/120 files、98 集成/16 files 是 2026-08-19 读数，现已过期；同期的 doc 10 §6 记的是 1599/119，两份文档两套数字）。详细决策见 `docs/review/2026-08-18-阶段5批次C-决策记录.md`（主会话落文）、批次 B 决策见 `docs/review/2026-08-18-阶段5批次B-决策记录.md`、批次 A 决策与 Rulings 见 `docs/review/2026-08-17-阶段5批次A-决策记录.md`；联调清单见 `docs/review/2026-08-18-阶段5批次C-联调清单.md`。

> **check:contract 论证已作废（2026-09-14，doc 02 §19.2 自我更正）：** 本行原以「check:contract（WS 28/28 + REST 15/15）全绿」作门禁论证，该论证已被 [doc 02](02-Cyrene-前后端通信协议与前端数据结构-v0.2.md) §19.2 自己否掉——WS 28/28 是批次 7（2026-08 上旬）时点的过期读数，且**口径本身是错的**：该门禁只核对「前端已认的帧型」，**结构上不可能发现「后端新增、前端未认」的帧**，故「通过」不能用来论证后端未含某帧（详见 doc 02 §19.2 末的批次 C 更正注记）。

**批次 A 已落地（本文档对应子项）：**

| 本文档子项 | 状态 | 落点 |
|---|---|---|
| §2 分层（Panel → Controller → Adapter → SDK） | 已实现 | `renderer/src/live2d/controller.ts` / `adapter.ts` / `gl/`（CubismGL 抽象）+ vendored SDK |
| §3 核心接口 | 部分（批次 A 子集） | Controller 首批 `listInstalledModels/load/switchModel/unload/setVisibility/setPerformanceMode/reset`；`setState/setExpression/playMotion/setMouthLevel/setLookTarget` 为 no-op 占位（批次 B 落地）；`Live2DModelSummary` 扩展超集见 §3 注 |
| §4 模型资源包 / manifest | 已实现（装配工具产出） | `scripts/live2d-install.mjs` → `userData/models/<id>/`（manifest + integrity + LICENSE.txt + 拷贝非 symlink） |
| §5 加载生命周期 / §5.1 切换 | 已实现（批次 A 子集） | 状态机 `unloaded→loading→ready\|failed→fallback`；切换失败保留原模型 + 静态头像回退 |
| §12.2 折叠暂停 / GPU 重建 | 部分 | 右栏不可见即不创建/暂停渲染循环 + `device_lost`→failed→fallback；重建/降帧/低功耗归批 C |
| §14 设置与持久化 | 部分（批次 A 子集） | `settings` 契约增 `live2d: {enabled, modelId}`（`.default(DEFAULT_LIVE2D)` 兼容旧设置）；scale/offset/mouseTracking 等归批次 B |
| §15 资源与许可 | 已记录 | 见 §15.1；发布前按官方 AI/Chatbot/Expandable 复核 |

**批次 B（表现）已落地（2026-08-18，本文档对应子项）：**

| 本文档子项 | 状态 | 落点 |
|---|---|---|
| §3 核心接口 | 已实现（真实化） | `switchModel` 返回生效 id（D5B-10）；`setState/setAutoMotions/setLipSync/setMouthLevel/setViewTransform/setLookTarget/playMotion/playTapMotion/setExpression/on` 落地；接口注见 §3 |
| §6 状态来源与优先级 / §7 状态映射 | 已实现 | `live2dStateSource` 薄编排层（D5B-04）：connection 断→offline、error 优先(3)、生成∧无正文→thinking、正文/TTS→speaking、最后完成消息 emotion 经 `normalizeEmotionCode` 本地归一（中/英文别名→happy/sad/surprised，未命中忽略）、否则 idle；`listening/working/waiting_permission` 槽位定义完备但驱动源 null（归阶段 6）【**已于 2026-08-20 被阶段 6 批次 B Task 7（`d7346eb`）取代**：`waiting_permission` 已接线（`live2d.store.ts:170` `toolWaiting: () => useToolStore().waitingForApproval`，`state-source.ts:110` 仲裁为 3 级覆盖 thinking/speaking、审批终态后按事件驱动回退）；`listening/working` 仍为定义完备、驱动源 null 的槽位。以上为批次 B（2026-08-18）时点记录，保留原文】。**F-1（联调前整改）：** 后端 `mood` 为 LLM 自由文本，归一别名表 = `happy`←`happy/开心/高兴/愉快/喜悦/兴奋`、`sad`←`sad/难过/悲伤/伤心/沮丧/低落`、`surprised`←`surprised/惊讶/惊喜/吃惊/诧异`（ASCII 大小写不敏感，中文按字面精确匹配） |
| §9 动作调度 / §3.3 表情 | 已实现 | B3 白名单调度（低优先不打断 3 级态、同动作去抖、长动作上限、切换清队列、点击不打断 speaking/thinking）；情绪态→表情本地映射（happy/f01、sad/f02、surprised/f06，不命中落 B4）；无动作模型 B4 参数级回退（thinking 摆头/speaking 口型+轻头/happy 笑眼/surprised 瞪眼/error 歪头，存在性判定） |
| §11 鼠标和点击互动 | 已实现 | Panel mouseleave→`setLookTarget(null)` 平滑回正；点击画布→playTapMotion(priority=1)（reduceMotion 禁用）；点击不打断 speaking/thinking/error/waiting_permission |
| §12 性能策略 / §12.1 性能模式 | 已实现（四值统一） | `performanceMode` 四值 `auto/quality/balanced/low_power`（旧三值 `high/low` 读回归一，schema 归一）；实际降帧消费归批 C |
| §13 尺寸和定位 | 已实现 | Panel 缩放/偏移手柄（即时预览 + 500ms 防抖持久化）；Layout 消费（有 Layout 走 `setupFromLayout`、无 Layout 沿用 scale-only，单测夹具覆盖） |
| §14 设置与持久化 | 已实现（全量 10 字段） | `Live2DSettings` 10 字段经「角色与外观」子页（CyLive2DPane）可调并持久化；老 settings.json 兼容（不崩、不 bump version） |
| §5.1 切换 / T6 竞态 | 已实现 | 快速连续切换 → store 仅持久化 `switchModel` 返回的**生效 id**（守卫丢弃时持久化旧 id），渲染模型与持久化 id 一致 |

**集成新增（批次 B，Electron `tests/integration/electron-live2d.spec.ts` 增 7 用例）：** 状态驱动徽标「思考中→说话中→空闲」、动作播放（Haru B3 画布非空 / lil B4 优雅降级）、情绪态→表情（mock emotion=happy → 徽标「开心」+ 画布非空）、设置子页（scale/performanceMode 即时生效 + 重启持久化恢复）、性能模式（四值存在 + 旧值 high/low 读回归一 + 不 corrupt）、布局（无 Layout 模型画幅正常）、切换竞态（生效 id 与渲染/持久化三方一致）。

> **取代注记（2026-09-15，`72b9117`）：** 上句的 `tests/integration/electron-live2d.spec.ts` **已不存在**——该文件按实测逐用例耗时拆为 `electron-live2d-core.spec.ts`／`-motion.spec.ts`／`-settings.spec.ts`（共享夹具抽到 `tests/integration/helpers/live2d-fixture.ts`），CI 侧 `integration-live2d` 同步改为一文件一 matrix job。用例内容未变，只换了落点文件。

**批次 C（收口）已落地（2026-08-18，本文档对应子项）：**

| 本文档子项 | 状态 | 落点 |
|---|---|---|
| §3 核心接口 | 已实现（收口修订） | `reset(modelId?)` 签名扩展（GPU 重建一次）、`setExpression`/`playMotion` 返回 boolean、`playMotion` 第三参 durationMs（≤15s 封顶）、state-source 返回 `{unsub, recompose}` + `pushDirective(state, strength, durationMs?)`、lipSync 门定案（Task5 M3 关闭）；接口注见 §3 |
| §10 基础口型同步（C1） | 已实现 | `mouth-level.ts` `computeMouthLevel` 纯函数（噪声门/attack~50ms/release~250ms 攻放不对称/最大变化率钳制/归零）+ `tts-mouth-source.ts`（MediaElementSource→Analyser fftSize=256→RMS→包络；每元素 createMediaElementSource 终生一次，F1）+ 口部写出**通用化**（`updateAnimation` 对所有 ready 模型写 `ParamMouthOpenY`，门=`autoMotions ∧ lipSync`，B3 动作后写自然覆盖）+ `voiceStore.ttsAudioEl`/CyTtsPlayer 挂接 + `live2dStore.tick()` 采样 + mock env 桥 `CYRENE_MOCK_MOUTH_LEVEL`（step/sine 合成包络，经 getRuntimeInfo 水合，renderer 不读 env） |
| §12 性能策略 / §12.2 自动降级（C2） | 已实现 | `perf.ts` `FrameBudget` 四值真实降帧（quality 恒满帧 / low_power 30fps 封顶 / balanced 按 EMA 帧耗时 60↔30 / auto 迟滞升降档；skip 帧不 updateAnimation 不 draw）+ `reset(modelId?)` GPU 丢失**一次重建**（rebuildGuard finally 复位非永久，成功恢复 ready + 重放 settings/CharacterState，失败 → fallback）+ `setVisibility` 接线进 tick 门（消除批次 B Task5 M4 死面）+ 重建路径 `adapter.initialize` 半初始化 try/catch 兜底（批次 A Task5 P3） |
| §8 后端表现指令（C3） | 已实现（契约冻结 + 桩化） | `live2d.directive` **扁平 wire 帧** `{type, expression?, motion?, state?, priority?(0-3), durationMs?}` 四件套（`raw-types.ts` 类型 + `raw-schemas.ts` `.strict()` 未知字段整帧拒 + `FrameMapper.mapFrame` 分支 + `BackendEventSchema` 镜像）；`state` **七值**（`idle/listening/thinking/speaking/happy/sad/surprised`，**剔除 error**——error 为 client 派生态不可注入，偏离 doc 02 §12 见决策记录）；`pushDirective` 建议强度仲裁（priority clamp ≤1 → 永不覆盖 client 2/3 级现实态）+ `handleDirective` 校验/脱敏日志/指令>emotion + mock `CYRENE_MOCK_DIRECTIVE` env + real-backend 解析桩；无新增 IPC 通道 |
| 防御加固（M1-M4/F2/F3 等） | 已实现 | resolveModelFile `%` 同口径（`canonicalizeRelPathSegment` 含合法 `%XX` 才解码一次，`%25` 放行 / `%2F`/`%252F`/非法序列拒）/ registry 强制 `manifest.id===dirname` / integrity 空数组视为不完整（列表/请求/verify 三方一致）/ `reason` 闭合枚举 `missing_file|size_mismatch|hash_mismatch` / F2 blink 速率调制（thinking/speaking rate=2）/ F3 expressions 空 → B4 参数级近似 / Task5 M2 restore 分叉（`restoreDefaults()`：面板存活 switchModel 首个可用、已 dispose 显式持久化）/ 批次 A F2/F3/F4 关单（无实害）、N1/N3 批次 B 已完成不重复收口 |
| §15 资源与许可 | 已记录 | 见 §15.1；**发布前复核仍 defer**（发布流程事项，本批仅台账记录） |

**批次 C 集成新增（原标题的 `electron-live2d.spec.ts` 已被 `72b9117`／2026-09-15 取代，见上条注记；原叙述：增 7 用例，既有第 6 号「设备丢失」改写为「一次重建」不计入）：** C1 口型链路（`CYRENE_MOCK_MOUTH_LEVEL=step` 全链路 + 停止归 0，真实 RMS 归联调肉眼）、C2.1 性能模式四值切换（low_power 降帧后渲染不崩 + 持久化）、C2.2 GPU 丢失重建一次（`webglcontextlost` → 重建回到就绪+渲染恢复或回退不崩 + 聊天可用）、C3.1 指令消费（happy+F01 → 徽标「开心」+ 画布非空 + 无 console error）、C3.2 指令非白名单 expression（不崩 + 脱敏 warn `directive_miss` 不记 payload 原文）、C3.3 指令 `state:working` 越界（env 解析缺省不发射、不崩、聊天可用）、收口回归（恢复默认设置 → 切回首个可用，画布/select/持久化三方一致）。
**批次 C 真实 Windows Electron（REAL）联调：已通过（2026-08-19）。** 按 `docs/review/2026-08-18-阶段5批次C-联调清单.md` 完成冻结基线 + C1/C2/C3 定向复验 + 自动化门禁复跑 + 真机 deferred 结论 + 遗留说明，三态已升「已真实联调」；详见 `docs/review/2026-08-19-阶段5-Live2D真实联调验收.md`。

> **阶段 7 批次 D 注记（2026-08-28，Live2D 数值读数接入诊断页，闭合 D7A-06，已真实联调）：** 诊断页「Live2D 性能」占位（`:240-241`，原为「不可用——帧耗时统计未导出」）已替换为**数值读数**——`FrameBudget.getStats()` → `Live2DController.getStats()` 透传 → `live2dStore.getStats()`（`status !== 'ready' || !controller` → null）→ `CyDiagnosticsPane` `live2dStats` computed 读取时取值 → v-if 显示读数 / v-else 显示「未启动（无读数）」。`Live2dFrameStats` 契约新增（`shared/contracts/live2d.ts`，帧耗时/帧率/降帧计数元数据，无正文/参数敏感面）。**读取时取值**（非持续记录）；`status !== 'ready'` → null → 「未启动（无读数）」。**真机前置修复（2026-08-28）**：CyLive2DPanel 常驻挂载（settings 打开保留 ready，`currentView` gate 停 rAF）——真机诊断页显示真实帧耗时/帧率，禁用→未启动、启用→ready；集成正 path + 禁用/启用生命周期回归（`de4fcf8`/`fc38e7f`）。三态=已真实联调；决策见 `docs/review/2026-08-27-阶段7批次D-决策记录.md`，真机验收见 `docs/review/2026-08-28-阶段7批次D-真实联调验收.md`。
