# 阶段 5（Live2D）批次 B：表现——状态映射 + 待机 + 动作/表情 + 参数驱动回退 + 设置子页 + Panel

**设计 spec（binding authority）**
**日期：** 2026-08-18
**批次：** 阶段 5 · 批次 B（共 A/B/C 三批次；A = 地基【已完成】，B = 表现【本 spec】，C = 收口【口型/降级/后端指令/联调，另见独立 spec】）
**依据：** [05-Cyrene-Live2D前端接入设计-v0.2.md](../../05-Cyrene-Live2D前端接入设计-v0.2.md)（binding；§6 状态来源与优先级 / §7 状态映射 / §8 后端指令【归 C】 / §9 动作调度 / §11 鼠标互动 / §13 尺寸定位 / §14 设置持久化）+ [11-Cyrene-前端设置中心详细设计.md](../../11-Cyrene-前端设置中心详细设计.md) §7.1（Live2D 设置子页）+ 批次 A spec/plan（[2026-08-17-phase5-live2d-batcha-foundation-design.md](../specs/2026-08-17-phase5-live2d-batcha-foundation-design.md)）+ 本会话决策集合（见 §0）

---

## 0. 决策集合（本批定案，按推荐拍板并记录；最终报告汇报）

| # | 决策 | 理由 |
|---|---|---|
| **D5B-01** | **参数驱动落点 = Controller 纯函数 + Adapter 窄参数通道**：`Live2DAdapter` 的 `Live2DModelHandle` 增 `setParam(id, value)`（写单个模型参数，支持任意 Id==xx 的 Cubism 参数；对未知参数 Id 静默忽略）；动画数学（眨眼、呼吸、过渡、口型包络）作为 **Controller 内纯函数**（可单测，不依赖 SDK 句柄——单测传 fake 参数集）。doc 05 §2「业务模块只依赖 Controller，不直接调用 SDK API」：参数 Id **字符串**跨层传递（如 `'ParamEyeLOpen'`），业务层不 import Cubism 常量 | 保持 Controller 无 Pinia/SDK 依赖、参数驱动逻辑单测可覆盖；Adapter 只暴露薄参数通道，不承载动画策略 |
| **D5B-02** | **待机/眨眼/呼吸口径**：眨眼驱动 `ParamEyeROpen/ParamEyeLOpen`（随机间隔 + 短闭眼时长的婴儿式眨眼模型，纯函数）；呼吸为 **Controller 纯函数正弦**（语义对齐 vendored `effect/cubismbreath.ts` 的 `ParamAngleZ` 正弦公式与数值，经 `setParam('ParamAngleZ', v)` 写出——**不直接调 Framework `CubismBreath.updateParameters`**，因后者吃真实 `CubismModel` 就地改参，与 D5B-01 的「纯函数 + fake 参数集」不可兼得；仅当模型暴露 `ParamAngleZ` 才驱动，可配幅度/频率）。二者**仅当模型暴露对应参数**（`ParamEyeROpen/ILOpen`、`ParamAngleZ` 存在才驱动，经 cdi3 参数集判定）；lil 已实测 `ParamEyeROpen/LOpen` 存在（B2 可覆盖）。状态、动作或口型之外的参数不被 Controller 任意写 | doc 05 §17「待机、眨眼、呼吸正常」；参数存在性判定避免对无该参数的模型造帧；呼吸用纯函数重写保 Controller 无 SDK 句柄（对齐 CubismBreath 数值） |
| **D5B-03** | **无动作模型兜底语义（B4 核心）**：表现调度器按「模型实际提供的资源」路由——模型 manifest/model3 有 motions → 走动作系统（B3）；无 motions/expressions → **参数级表现**（B4）：状态 → 一组参数映射（如 speaking→MouthOpenY 开合、thinking→轻微 AngleX 摇摆），**不为缺失动作伪造动画**、不 panic、不记错误 | 默认模型 lil 无动作文件（已实测），doc 05 §17 验收须在被选默认模型上成立；存在性路由使 Haru（有动作）与 lil（无动作）同框正确 |
| **D5B-04** | **状态映射驱动源 = Panel 编排层，Controller 保持无 Pinia**：新建薄 `live2dStateSource`（订阅 `connectionStore`/`conversationStore`/`messageStore`/`voiceStore`，组合出 `CharacterState`）→ 调 `controller.setState(state)`。Controller 自身只接受 `setState(CharacterState)` 命令、维护状态机与优先级栈，**不 import 任何 store**。映射来源在批次 B 可得的有限集：`offline`（connection 未连接）/`idle`/`thinking`（生成开始）/`speaking`（正文增量或 TTS 播放）/`happy|sad|surprised`（generation.completed.mood 经本地映射表，未知码忽略→IDLE）/`error`（连接/生成/渲染错误）。**`listening`（输入聚焦轻微注视）驱动源置 null 归批次 B 不接线**——与 `working/waiting_permission`（工具归阶段 6）一致作「槽位 + 驱动源 null + defer」处理（有枚举/优先级/收敛预留，但本批无触发源、不测试不验收），避免为低价值「输入聚焦注视」额外接 ChatInput focus 布线 | doc 05 §7 状态映射；Controller 可单测；`listening/working/waiting_permission` 驱动源缺位是阶段/范围依赖而非遗漏（如实标注） |
| **D5B-05** | **高优先级结束回前态 = 优先级栈收敛表（本 spec §3.1）**：显式状态机表「事件→转入态→结束事件→回退态」，非一律回 idle（doc 05 §9「高优先级状态结束后回到当前业务状态，不是一律 idle」）。每态记「结束事件集合」与「回退目标态」；结束事件未到时长超限仍返回回退态 | 消除调度器行为二义性 |
| **D5B-06** | **`performanceMode` 四值统一**：doc 05 §12 的 `'auto'|'quality'|'balanced'|'low_power'` 为唯一枚举。批次 A Controller 现为三值 `Live2DPerformanceMode = 'auto'|'high'|'low'`（`renderer/src/live2d/controller.ts:17`，不在 shared/contracts）——迁移为：**在 `shared/contracts/live2d.ts` 新建四值 `PerformanceMode`**，Controller 的 `Live2DPerformanceMode` 改指/移除之，`'high'→'quality'`、`'low'→'low_power'` 读回归一（`shared/schemas/ipc-response.ts` 的 `SettingsStateSchema.live2d.performanceMode` 与 `SettingsPatchSchema`、`settings.store.ts`、预置 `DEFAULT_LIVE2D.performanceMode:'auto'` 消费端一并更新）。帧率/降帧消费归批次 C，本批只定义枚举与设置持久化，`setPerformanceMode` 延续「记录 + 低活 idle 时不变帧率」 | 消除三值/四值两套枚举漂移（批次 A 遗留）；C 的降帧策略需要单一权威枚举 |
| **D5B-07** | **动作/表情系统 = Framework `CubismMotionManager`/`CubismExpressionMotionManager` + Controller 优先级仲裁**：`Live2DModelHandle` 增 `startMotion(modelId, file, priority)`/`startExpression(modelId, file)`/`stopMotion/stopAll`/`getParameterIdList`/`setParam`，帧推进并入 `update(dt)`。**动作/表情唯一标识 = 文件相对路径**（`manifest.motions/expressions` 为摊平文件路径数组，rel 见 I-4）。调度策略（合并重复/最大时长/队列/优先级 3/2/1/0/结束回前态）按 doc 05 §9 在 Controller 实现；表情按本地映射表发射（I-1），无表情/不命中落 B4 | 复用 vendored Framework 的 motion 子系统（已就位），不自造轮子；调度仲裁在 Controller（可单测），Adapter 只管加载/播放原语 |
| **D5B-08** | **设置子页全量 + 持久化**：`Live2DSettings` 扩为 doc 05 §14 全量 10 字段 `{enabled, modelId, scale, offsetX, offsetY, mouseTracking, autoMotions, lipSync, performanceMode, reduceMotion}`。默认值：`enabled:true, modelId:null, scale:1, offsetX:0, offsetY:0, mouseTracking:true, autoMotions:true, lipSync:true, performanceMode:'auto', reduceMotion:false`。沿用批次 A 的 `.default(DEFAULT_LIVE2D)` 兼容机制（旧 settings.json 无新字段不崩、不 bump version）。设置子页挂 **`CySettingsView` 既有的 `character`（角色与外观）nav**（已占位，阶段 5）→ 新建 `CyLive2DPane`（镜像 `CyVoicePane`/`CyModelServicesPane` 结构）；`scale/offsetX/offsetY` 设**安全钳制**（`scale∈[0.5,3]`、`offset∈[-2,2]`，防模型完全移出画布，doc 05 §13） | doc 11 §7.1 全项；复用设置中心框架；兼容机制防老设置被毁 |
| **D5B-09** | **鼠标跟随/点击作用域**：视线跟随（`setLookTarget(NormalizedPoint)`）仅当 `mouseTracking=true` 且 Panel 可见（布局折叠/隐藏或 `enabled=false` 时不驱动）；跟随/点击在 `reduceMotion=true` 时禁用。**`setLookTarget(null)` 在 mouseleave 时平滑回正**（doc 05 §11，I-2）。点击预设动作（priority=1）仅对**有动作模型**生效（无动作模型点击静默，不伪造），且**不打断 speaking/thinking（2 级）与 error/waiting_permission（3 级）**（doc 05 §11，I-3）；命中安全区来自画布相对坐标 | doc 05 §11 + §12.2 折叠暂停纪律 |
| **D5B-10** | **Panel 缩放/偏移交互 + Layout 消费**：`CyLive2DPanel` 完整化——canvas + 模型下拉（A 已有）+ **状态映射徽标** + **缩放/偏移手柄**（画布内叠加最小控件，读写 `Live2DSettings.scale/offsetX/offsetY`，即时预览，持久化走 settingsStore）+ 消费 model3 的 `Layout`（有则用官方 Layout 宽高比拟合，无则沿用 A 的 scale-only MVP）。**T6 切换竞态硬化**（批次 A 遗留 Minor）纳入本 task：`controller.switchModel` 返回「实际生效 id」（成功=目标 id，守卫丢弃=旧 id，失败=旧 id），store 仅在该生效 id 上持久化 `modelId`——消除「已加载 a 却持久化 b」窄竞态 | doc 05 §13 Layout/缩放偏移 + 批次 A 遗留硬化 |

**对 doc 05 / 批次 A 的显式范围承接**：
- 批次 A 的 `Live2DModelHandle`（`update/draw/destroy`）为**本批基底**；本批在其上新增 `setParam/startMotion/startExpression/stopMotion/getParameterIdList`（不破坏既有 `update/draw/destroy` 契约）。
- 批次 A Controller 的 no-op 占位 `setState/setExpression/playMotion/setMouthLevel/setLookTarget` 在**本批真实实现**（`setState` 走状态机，`playMotion` 走动作系统，`setMouthLevel` 走口型参数【口型数据源归 C1，但参数写入原语本批落地】，`setLookTarget` 走视线）。
- `performanceMode` 三值→四值迁移（D5B-06）会触碰批次 A 契约，按 doc 13 纪律同步更新相关接口注释。

**范围外（本批不做，归批次 C/后续）**：TTS 音量口型的**数据源**（AnalyserNode→level，C1；本批只落地 `setMouthLevel(level)` 参数写入原语，不接音频）；性能**降帧/GPU 重建**策略（C2）；后端 `Live2DDirective` 收发（C3，协议契约在 doc 02 §12 但代码零接线）；`working/waiting_permission` 状态驱动源（阶段 6 工具）；真实 Windows Electron（REAL）联调（C6）。

---

## 1. 目标

批次 B 目标（一个验收句）：**已加载的 Live2D 模型能随连接/生成/TTS 状态自动切换表现（含待机眨眼呼吸、有动作模型的动作/表情调度、无动作模型的参数级回退），表现配置可在设置中心「角色与外观」子页全量调整并持久化，且默认模型（修女莉尔，无动作文件）的待机/眨眼/呼吸按 P0 口径成立。**

拆解为可验证子目标：

1. 状态机与优先级栈按「事件→态→回退」表收敛，Controller 可单测；
2. 待机眨眼/呼吸（有对应参数时）驱动正确，参数级回退覆盖无动作模型；
3. 有动作模型的动作/表情经白名单加载 + 优先级调度；无动作模型静默落到参数级；
4. `Live2DSettings` 扩至 doc 05 §14 全量并持久化（老设置兼容）；
5. 设置中心「角色与外观」子页可全量调整并即时预览；Panel 显示状态徽标 + 缩放/偏移手柄；
6. `performanceMode` 统一四值；切换竞态硬化（生效 id 持久化）。

## 2. 分层架构（批次 A 之上扩展）

```text
CySettingsView ── character nav ──► CyLive2DPane（设置子页，doc 11 §7.1 全量）
        │
CyLive2DPanel（完整面：canvas + 模型下拉 + 状态徽标 + 缩放/偏移手柄 + 鼠标跟随/点击）
        │
  live2dStateSource（薄编排：订阅 connection/conversation/message/voice store → CharacterState）
        │  controller.setState(CharacterState) / playMotion / setMouthLevel / setLookTarget
Live2DController（状态机 + 优先级栈 + 待机动画纯函数【眨眼/呼吸正弦】+ 动作调度仲裁）
        │  setParam / startMotion / startExpression / getParameterIdList
Live2DAdapter（窄参数通道 setParam + motion/expression 加载播放原语）
        │  CubismFramework / CubismModel / CubismMotionManager / CubismExpressionMotionManager
        │  cyrene:// fetch（白名单 = manifest.motions/expressions）
Main 模型注册表 + 协议分支（批次 A 不变，B 仅消费既有供给）
```

信任边界与批次 A 相同：renderer 只经 cyrene:// 消费已校验资源，参数 Id 字符串、动作文件名走白名单，不动 SDK 本体。

## 3. 组件设计

### 3.1 B1 — 状态机 + 优先级调度（Controller 内核）

- **`CharacterState` 枚举**（doc 05 §3）：`offline/idle/listening/thinking/speaking/waiting_permission/working/happy/sad/surprised/error`（完整 11 态；`listening/working/waiting_permission` 驱动源 null 但槽位与优先级定义完备，本批不接线——见 D5B-04）。
- **优先级表**（doc 05 §6）：3 = `error/waiting_permission`；2 = `speaking/working/thinking`；1 = `happy/sad/surprised`（+ 用户互动/后端情绪建议，本批用户互动=点击动作）；0 = `idle`（+ 待机眨眼呼吸）。
- **收敛表「事件→转入态→结束事件→回退态」**（D5B-05，消除二义性）：

  | 触发事件 | 转入态 | 优先级 | 结束事件 | 回退态 |
  |---|---|---|---|---|
  | connection 断开 | offline | 0 | 重连 | idle |
  | 空闲（无活动） | idle | 0 | — | —（常态） |
  | 生成开始 | thinking | 2 | 首个正文增量 / generation.completed | speaking / idle |
  | 首个正文增量 / TTS 播放 | speaking | 2 | generation.completed 或 TTS 停止 | idle |
  | mood 映射命中（happy/sad/surprised） | happy/sad/surprised | 1 | 时长上限（~2s）或下一高优先事件 | 回原业务态 |
  | 连接/生成/渲染错误 | error | 3 | 错误清除或 ~3s | 回原业务态 |
  | [阶段6] 工具等待/执行 | waiting_permission/working | 3/2 | [阶段6] | 回原业务态 |

- **规则**：仅同/更高优先级事件可打断当前态；低优先级事件在更高优先级态激活时**排队或丢弃**（doc 05 §9「只记录最新业务状态，不缓存全部动作」→ 丢弃，只保留最新）；结束事件或时长超限 → 回退态。`setState` 幂等（同态不重触发）。
- 纯逻辑函数放 `controller.ts` 或独立 `state-machine.ts`（便于单测收敛表所有转移）。

### 3.2 B2 — 待机眨眼/呼吸（参数驱动核心，纯函数）

- **`blink`（纯函数）**：驱动 `ParamEyeROpen/LOpen`（存在性判定：从处理好的参数 Id 集判断 `ParamEyeROpen`/`ParamEyeLOpen` 是否可写）。婴儿式眨眼：随机间隔（~2.5–7s）+ 短闭眼（~150–250ms）+ 平滑（fast 关/慢开）。实现为可注入时钟的占位函数，单测断言序列（无真实 SDK）。
- **`breath`（纯函数）**：正弦呼吸驱动 `ParamAngleZ`（若模型暴露）；**不直接调 Framework `CubismBreath`**（其 `updateParameters(model: CubismModel,…)` 吃真实 SDK 句柄，与 D5B-01 纯函数承诺冲突，见 C-1 修订）——Controller 内按 vendored `effect/cubismbreath.ts` 的正弦公式与数值（周期 ~2s）自行实现纯正弦，经 `setParam('ParamAngleZ', v)` 写出。可注入时钟，单测传 fake 参数集（无真实 SDK）。
- **`setMouthLevel(level)`**（doc 05 §10 的写入原语，本批不接数据源）：`level∈[0,1]` → 映射到口部参数（`ParamMouthOpenY`，存在性判定；LipSync Group 空则直接驱动 `ParamMouthOpenY`——lil 实测 LipSync `Ids:[]` 但 `ParamMouthOpenY` 存在）。平滑/钳制在参数写层。
- 这些纯函数由 Controller 在 `tick`/帧推进中调用（帧推进在 `adapter.update` 之后，Controller 状态为 ready 且 `autoMotions`/`lipSync` 开启时）。
- 参数存在性判定来源：`getParameterIdList()`（Adapter 从 CubismModel 获取，用于 B2/B4 的路由）。

### 3.3 B3 — 动作/表情系统 + 白名单 + 调度

- **Adapter**（`Live2DModelHandle` 增）：
  - `getParameterIdList(): string[]`
  - `setParam(id: string, value: number): void`（未知 Id 静默忽略）
  - `startMotion(modelId: string, file: string, priority: number): Promise<void>`——`file` 是**该模型 motion 文件相对路径**（见下「动作身份」），经 cyrene:// fetch motion3.json → `CubismMotion.create` → 入 `CubismMotionManager`（Framework），按优先级入队；返回可等待完成/中断的句柄（或 Promise resolve on start）
  - `startExpression(modelId: string, file: string): Promise<void>`——`file` 为 exp3 文件相对路径 → `CubismExpressionMotionManager`
  - `stopMotion(priority?: number): void`、`stopAll(): void`
  - `frame advance`：`update(dt)` 内推进 motion manager + expression manager（在 model.update 之前喂参数、之后 draw）
- **动作身份（I-4 钉死）**：`manifest.motions` 是**摊平的 motion 文件相对路径数组**（装配时从 model3 `FileReferences.Motions` 各组 `File` 读出、group 信息不保留），`manifest.expressions` 同理。故**动作/表情的唯一标识 = 文件相对路径**（如 `'motions/haru_g_idle.motion3.json'`），不用 group。`playMotion(file, priority)` / `startMotion(modelId, file, priority)` 一律收文件路径；「组」只作 Controller 内部分组标签（如 speaking→选 speaking 组的某文件），下发前解析为该文件路径并经白名单。装配工具本批保持摊平（不改装配格式）；若要保留 group→file 映射，属装配格式增强、非本批必需（YAGNI，record note）。
- **白名单**：动作/表情文件路径必须 ∈ 该模型的 manifest.motions/expressions（装配时从 model3 FileReferences 读出写入 manifest）——`controller.playMotion` 先查白名单，不在 → 忽略（不抛错、脱敏日志）。URL 供给仍经 cyrene:// 协议层 whitelist（批次 A）。
- **Controller 调度（仲裁）**：`playMotion(file, priority)`——按优先级与当前态裁决（低优先级不打断 3 级：权限/错误；**2 级 speaking/thinking 激活时不发点击动作**，见 I-3）；同动作短时重复合并（去抖 ~500ms）；长动作最大时长上限（~15s，超时 stopMotion 回退）；会话/模型快速切换时清队列（stopAll + 队列清空）；模型未就绪时只记最新状态。`setExpression(file)` = 白名单查到即 `startExpression`，未知 → 忽略。
- **情绪态→表情/动作发射（I-1）**：`happy/sad/surprised` 对**有表达式模型**走表情：本地映射表 `{happy→'expressions/happy.exp3.json'?, sad→…, surprised→…}` 的**文件路径**查白名单，命中 → `setExpression(file)`；无表达式或不命中 → 落 B4 参数级（不空转）。映射表内具体文件名以该模型 manifest 实际含有的为准（Haru 有 F01-F08，映射缺省取语义最接近的 F 编号，未命中即参数级）。

### 3.4 B4 — 无动作模型参数驱动回退

- 触发条件：模型 `getParameterIdList()` 无/少 motion（manifest 无 motions，或 model3 无 FileReferences.Motions）。
- **行为**：当 Controller 收到 `thinking/speaking/happy/...` 等态，而模型有动作系统 → 走 B3；无 → 走**参数级近似**：
  - idle → 眨眼 + 呼吸（B2 内核）
  - thinking → 轻微 `ParamAngleX` 摇摆 + 眨眼加快
  - speaking → `setMouthLevel`（若外部给 level；本批数据源缺省 0，口型源 C1）+ 头轻微动作
  - happy → 眼睛笑（`ParamEyeLSmile/ParamEyeRSmile`，存在性判定）+ 呼吸
  - surprise → 眼睛睁大（`ParamEyeLOpen/ROpen` 拉大）
  - error → `ParamAngleZ` 轻微歪头
- 参数 Id 均作**存在性判定**（getParameterIdList 路由），不存在的 Param 不写。全部不记错误、不打扰状态机。
- 单测：给定「无动作 + 参数集」fake，断言各状态下写了的参数/值范围；「有动作」fake 断言走 B3 不写参数级。

### 3.5 B5 — 设置子页（CyLive2DPane）+ 持久化扩展

- **契约扩展**（顺序敏感，批次 A 走熟模式）：`shared/contracts/live2d.ts` `Live2DSettings` 扩 10 字段（D5B-08）+ `PerformanceMode` 四值（D5B-06 迁移）；`shared/contracts/voice.ts` `SettingsState/SettingsPatch` 的 live2d 段自动随类型；`shared/schemas/ipc-response.ts` 扩 `DEFAULT_LIVE2D` 全字段 + `SettingsStateSchema.live2d` 子 schema 全字段 + `SettingsPatchSchema.live2d` 嵌套 partial 全字段；`settings-service.ts` `save()` 第三 merge 行已含 `live2d`（批次 A 已加，字段自然随扩）；`settings.store.ts` 的 `setLive2d` 已存在，随契约扩；`hydrate/scheduleSave/persist` 三处接线已有 live2d。**新增迁移**：`performanceMode` 旧值 `'high'→'quality'`、`'low'→'low_power'`（读回时归一，写入统一四值）。
- **CyLive2DPane.vue**（新建，镜像 CyVoicePane/ModelServicesPane）：模型列表（available 过滤 + preview 缩略图 + 状态/错误）+ enabled 开关 + scale/offset 滑块（钳制 D5B-08）+ mouseTracking/autoMotions/lipSync 开关 + performanceMode 下拉（四值）+ reduceMotion 开关 + 恢复默认。改动即 `setLive2d` patch → settingsStore 500ms 防抖持久化 → Panel 即时反映。
  - **doc11 §7.1「帧率」项**（M-3）：由 `performanceMode` 四值下拉承载（`quality=60`/`balanced=30-60`/`low_power≤30`/`auto=动态`，doc 05 §12），不设独立帧率输入框；实际降帧消费归批次 C。
  - **保存失败回退**（M-4）：沿用 `settingsStore` 既有持久化失败语义（阶段 4 定型：保留内存态、记日志、不崩）——UI 已生效值不回退（即时预览已反映），仅在重启后读回保存态。
- 挂载：`CySettingsView.vue` 的 `character` nav 项（现有 `{ key:'character', label:'角色与外观' }`）→ `<CyLive2DPane v-else-if="activeNav === 'character'" />`。

### 3.6 B6 — Panel 完整化 + 缩放偏移 + 布局 + 切换竞态硬化

- **CyLive2DPanel.vue**（改造）：保留 G1 结构与挂载点；新增：
  - **状态徽标**：显示 `controller.status` 与当前 `CharacterState`（如「思考中」/「说话中」），图标/文案映射本地表；
  - **缩放/偏移手柄**：画布内叠加（`scale` 滑块 + `offsetX/offsetY` 调整，最小控件），即时预览（读 settingsStore live2d → 写 Canvas 视图变换）并持久化；
  - **鼠标跟随/点击**（D5B-09）：mousemove → `setLookTarget(target: NormalizedPoint | null)`（签名钉死为 doc 05 §3 的 `NormalizedPoint|null`；null = 回正）——`mouseTracking` + 可见 + `!reduceMotion` 才驱动；**mouseleave/移出命中区 → `setLookTarget(null)` 平滑回正**（doc 05 §11「离开后平滑回正」，I-2）。点击安全区 → 对**有动作模型** `playMotion(预设文件, priority=1)`（低优先级，**不打断 speaking/thinking/3 级态**——doc 05 §11「权限/错误/TTS 时普通点击不打断高优先级」，I-3），无动作静默；Panel 隐藏/折叠 → 停 rAF（批次 A 已有）；
  - **消费 model3 `Layout`**：适配器装配时若有 Layout（`Width/Height/X/Y`）按官方 `CubismModelMatrix` 拟合，无则沿用批次 A scale-only MVP（无 Layout 模型行为不变）。
- **切换竞态硬化**（D5B-10，批次 A 遗留）：`controller.switchModel(id): Promise<string>` 返回**实际生效 id**（成功=目标 id；守卫丢弃/失败=旧 id）。`live2dStore.switchModel` 用返回值持久化 `modelId`（不再无条件持久化目标 id）。
- 单测/集成：Panel 状态徽标、缩放/偏移读写、Layout 消费、竞态硬化（store 持久化生效 id）。

## 4. 安全设计

- 不变：renderer 只消费 cyrene:// 已校验资源；参数 Id 是字符串（不引入任意脚本/路径）；动作/表情文件只从白名单（manifest.motions/expressions）经 cyrene:// 供给。
- **新增面**：`playMotion/startExpression` 的 `file` 参数**必须** ∈ 白名单——白名单由 Main 装配（manifest 生成时从 model3 FileReferences 读入）且供给经完整性校验（批次 A）；Controller 在发起前再查一次本地白名单副本（belt-and-suspenders，防协议层外注入）。未知 mood 码不转动作/表情（doc 05 §7）。
- 参数 Id 无安全风险（字符串，只写模型参数，不碰文件/路径/网络）。
- 无新增 IPC 通道（全部本地 renderer 内）；设置持久化走既有 `settings:save`（批次 A 已接线）。

## 5. 测试策略

单测（fake adapter/GL + 可注入时钟 + 内存 fixture）：

| 面 | 用例 |
|---|---|
| 状态机（B1） | 收敛表全转移：thinking→speaking→idle、error 打断、低优先级不打断 3 级、同态幂等、结束回正确回退态（非一律 idle）、`listening/working/waiting_permission` 槽位存在但驱动源 null |
| 待机（B2） | blink 序列（随机间隔/闭眼时长/平滑）、breath 纯正弦驱动 ParamAngleZ 且仅当该参数存在（fake 参数集断言，不依赖 SDK）、setMouthLevel 钳制/存在性 |
| 动作系统（B3） | 白名单通过→startMotion；白名单外→忽略不抛错；优先级仲裁（低不打断高）、重复合并、长动作超时、快速切换清队列；**情绪态→表情发射**（happy/sad/surprised 命中白名单→setExpression，不命中→落 B4） |
| 参数回退（B4） | 无动作模型各状态写对参数/值域；有动作模型走 B3 不写参数级；未知 Param 不写 |
| 设置（B5） | 契约 schema 全字段；老 settings.json 无新字段默认加载不崩不 bump version；performanceMode 'high'/'low' 读回归一；scale/offset 钳制；setLive2d 部分 patch 保子树 |
| Panel（B6） | switchModel 返回生效 id；store 仅持久化生效 id（竞态：守卫丢弃时持久化旧 id）；缩放/偏移读写转换；Layout 消费（有/无）；**mouseleave→setLookTarget(null) 回正；点击动作不打断 speaking/thinking/3 级态** |

集成（Playwright `_electron` + xvfb/SwiftShader，扩 `electron-live2d.spec.ts`）：

| 面 | 用例 |
|---|---|
| 状态驱动 | 收到 generation.thinking/completed 事件 → Panel 状态徽标变「思考中」→「说话中/空闲」（mock 后端驱动） |
| 动作播放 | Haru（有动作）触发 speaking → adapter 帧推进 / canvas 仍非空（不崩）；lil（无动作）同场景 → 参数级（canvas 非空 + 无错误） |
| 设置子页 | 打开「角色与外观」→ 改 scale/offset/performanceMode → 即时预览 + 重启后持久化恢复 |
| 性能模式 | 四值下拉存在且选中持久化；迁移旧值不崩 |
| 布局 | 有 Layout / 无 Layout 模型画幅（lil 无 Layout 沿用 scale-only，A 已验；有 Layout fixture 断言拟合） |
| 切换竞态 | 快速连续切换 → 最终 setLive2d 的 modelId 与实际渲染模型一致 |

## 6. 验收清单（批次 B）

- [ ] 待机眨眼/呼吸在默认模型（lil，无动作文件）上成立——待机 → 眨眼/呼吸参数被驱动（参数集存在性判定下）；
- [ ] 状态机按收敛表正确转移（thinking→speaking→idle、error 打断、结束回正确回退态），`listening/working/waiting_permission` 槽位定义完备（驱动源 null，归 B 范围外/阶段 6）；
- [ ] 有动作模型（Haru）动作/表情走白名单 + 优先级调度，**情绪态（happy/sad/surprised）经本地映射发射表情**（命中→setExpression，不命中→参数级）；无动作模型（lil）静默落到参数级回退，不 panic、不记伪动作；
- [ ] `Live2DSettings` 全量字段经「角色与外观」子页可调并持久化，老 settings.json 兼容（不崩、不 bump version）；
- [ ] `performanceMode` 统一四值，旧三值读回归一；
- [ ] Panel 显示状态徽标 + 缩放/偏移手柄（即时预览 + 持久化）；切换竞态硬化（生效 id 持久化）；**鼠标离开视图→视线平滑回正；点击预设动作不打断 speaking/thinking/error/waiting_permission**；
- [ ] 全文档计数/状态同步（doc 05/10/11/16 + README + 决策记录 + CLAUDE.md 措辞，按既定纪律）；
- [ ] 三态 = **已开发、未联调**（Mock/本地驱动；真实 Windows Electron REAL 联调归批次 C6）。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Framework motion/expression API 与批次 A 适配器整合面大 | plan 给真实 API 名与调用序；adapter 增面不改既有 `update/draw/destroy` 契约；单测全覆盖新增面 |
| 默认模型 lil 无动作、参数级表现是否符合验收审美 | B4 参数级近似按文档口径实现（存在性判定 + 值域），验收以「驱动正确 + 不崩 + 不打扰聊天」为准，非艺术性判据；审美优化非本批范围 |
| 状态映射驱动源跨 store 接线复杂 | D5B-04 薄编排层单点订阅，Controller 无 store 依赖；`listening/working/waiting_permission` 无源如实标注（阶段/范围依赖） |
| settings 契约扩字段破坏老文件 | D5B-08 沿用 `.default()` 兼容机制；单测覆盖老文件加载 |
| performanceMode 三值→四值迁移波及面 | D5B-06 归一函数单测；迁移点列全（类型/controller/契约/消费端） |

## 8. 需要记录到最终报告的中途决策（批次 B 执行中若出现）

- 任何对 §0 决策的偏离（如 Framework motion API 实际导出与 plan 不一致、参数 Id 命名差异、状态映射源新增/省略、设置字段增减）均按既定流程：**按推荐执行 → 记入决策记录 → 最终报告汇报**。
