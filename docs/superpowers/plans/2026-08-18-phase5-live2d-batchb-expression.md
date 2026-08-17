# 阶段5 批次B（Live2D 表现）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已加载的 Live2D 模型随连接/生成/TTS 状态自动切换表现（含待机眨眼/呼吸、有动作模型的动作/表情调度、无动作模型的参数级回退），设置可在「角色与外观」子页全量调整并持久化，默认模型（修女莉尔，无动作文件）的待机/眨眼/呼吸按 P0 口径成立。

**Architecture:** 批次 A 之上扩展五层。Controller 保持无 Pinia/SDK 依赖：状态机 + 优先级收敛表 + 待机动画纯函数（眨眼/呼吸正弦）+ 动作调度仲裁。Adapter 增窄参数通道（`setParam`）与 motion/expression 加载播放原语（Framework `CubismMotionManager`/`CubismExpressionMotionManager`）。新的薄 `live2dStateSource` 订阅 connection/conversation/message/voice store 组合出 `CharacterState` 驱动 Controller。设置契约扩至 doc05 §14 全量 10 字段 + `PerformanceMode` 四值迁移。Panel 完整化 + 设置子页 `CyLive2DPane`（挂 CySettingsView 既有的 character nav）。

**Tech Stack:** Electron+Vue3+TS+Vite（electron-vite）+Pinia+zod+Vitest+Playwright `_electron`（xvfb-run）+ Cubism Web SDK 5-r.5（vendored asm.js Core + Framework）。

**Spec:** [docs/superpowers/specs/2026-08-18-phase5-live2d-batchb-expression-design.md](../specs/2026-08-18-phase5-live2d-batchb-expression-design.md)（binding authority；本计划从 spec 论证，执行者两篇同读）

## Global Constraints

- **决策表 D5B-01~10（spec §0）是硬约束**：参数驱动=Controller 纯函数+Adapter 窄参数通道（`setParam(id,value)`，未知 Id 静默忽略）；**breath 为 Controller 纯正弦**（经 `setParam('ParamAngleZ')` 写出，**不直接调 Framework `CubismBreath.updateParameters`**——其吃真实 CubismModel）；无动作模型走参数级回退（不为缺失动作伪造动画）；`CharacterState` 完整 11 态，`listening/working/waiting_permission` 槽位定义但**驱动源 null 不接线不测试**；动作/表情唯一标识 = **文件相对路径**（`manifest.motions/expressions` 为摊平文件路径数组，不用 group）；`performanceMode` 统一 doc05 四值（`'auto'|'quality'|'balanced'|'low_power'`），三值 `'high'/'low'` 读回归一；`Live2DSettings` 扩 10 字段且 `.default(DEFAULT_LIVE2D)` 兼容老 settings.json（不 bump version）；`setLookTarget(NormalizedPoint|null)` + mouseleave 平滑回正；点击预设动作 priority=1 不打断 speaking/thinking/error/waiting_permission；情绪态 happy/sad/surprised 经本地映射→setExpression（白名单文件路径），不命中落 B4。
- **不得**：import store 进 Controller（无 Pinia 依赖）；调用 Framework `CubismBreath`；改 Framework 本体源码；新增 IPC 通道；引入 npm 依赖；把批次 C 的东西混入（TTS 口型数据源/降帧/后端 directive/真机联调）。
- **批次 A 基底必保**：`Live2DModelHandle` 既有 `update/draw/destroy` 契约不变；`Live2DController` 既有 `status/modelId/init/switchModel/unload/setVisibility/setPerformanceMode/reset/on` 不破坏；`live2dStore` 既有 `init/switchModel/dispose/tick` 不破坏（仅按 D5B-10 硬化 switchModel 持久化）。
- 门禁：`typecheck` / `lint` / `test`（单测）/ `test:integration`（xvfb-run）/ `build` 全绿；`check:contract` 与本批无关。
- 文档保持中文；三态 = **已开发、未联调**（真实 Windows Electron REAL 联调归批次 C6）。
- nvm Node 22.23.0（所有 pnpm 命令前缀 `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22.23.0 >/dev/null 2>&1 && ...`）。

## 文件结构

| 文件 | 责任 | 变更 |
|---|---|---|
| `apps/desktop/src/shared/contracts/live2d.ts` | `Live2DSettings` 扩 10 字段 + **新建** 四值 `PerformanceMode` | 修改 |
| `apps/desktop/src/shared/contracts/voice.ts` | `SettingsState/SettingsPatch` live2d 段随类型（无需改，自动随 contracts/live2d） | 微改/不动 |
| `apps/desktop/src/shared/schemas/ipc-response.ts` | `Live2DSettingsSchema` 扩 + `DEFAULT_LIVE2D` 扩 + performanceMode 四值 schema + 迁移归一 | 修改 |
| `apps/desktop/src/renderer/src/live2d/controller.ts` | 状态机+优先级收敛表+纯函数（blink/breath/mouth）+ 调度仲裁 + setState/playMotion/setMouthLevel/setLookTarget 真实实现；`Live2DPerformanceMode`→`PerformanceMode`；switchModel 返回生效 id | 修改 |
| `apps/desktop/src/renderer/src/live2d/state-machine.ts` | 收敛表 + 优先级栈纯函数（可单测，Controller 组合） | 新建 |
| `apps/desktop/src/renderer/src/live2d/param-anim.ts` | 眨眼/呼吸正弦/口型 纯函数动画（可注入时钟） | 新建 |
| `apps/desktop/src/renderer/src/live2d/adapter.ts` | handle 增 `getParameterIdList/setParam/startMotion/startExpression/stopMotion/stopAll` + 帧推进 + Layout 装配 | 修改 |
| `apps/desktop/src/renderer/src/live2d/state-source.ts` | `live2dStateSource`：订阅 connection/message/voice store → CharacterState | 新建 |
| `apps/desktop/src/renderer/src/stores/live2d.store.ts` | switchModel 用生效 id 持久化（D5B-10）；接线 stateSource | 修改 |
| `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue` | 状态徽标/缩放偏移手柄/鼠标跟随点击/Layout 渲染 | 修改 |
| `apps/desktop/src/renderer/src/components/CyLive2DPane.vue` | 设置子页（doc11 §7.1 全量） | 新建 |
| `apps/desktop/src/renderer/src/components/CySettingsView.vue` | character nav → `<CyLive2DPane>` | 修改 |
| `apps/desktop/tests/unit/live2d-state.spec.ts` / `live2d-param-anim.spec.ts` / `live2d-controller.spec.ts` / `live2d-adapter2.spec.ts` / `live2d-settings.spec.ts` / `live2d-store.spec.ts` / `live2d-pane.spec.ts` | 单测 | 新建 |
| `apps/desktop/tests/integration/electron-live2d.spec.ts` | 集成扩（状态驱动/动作播放/设置子页/性能模式/布局/竞态） | 修改 |

---

### Task 1（B5 契约）: Live2DSettings 10 字段 + PerformanceMode 四值迁移 + 持久化链

**Files:**
- Modify: `apps/desktop/src/shared/contracts/live2d.ts`
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`（`Live2DSettingsSchema`/`DEFAULT_LIVE2D`/`SettingsStateSchema.live2d`/`SettingsPatchSchema.live2d`）
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`（`Live2DPerformanceMode` 三值 → 引用共享 `PerformanceMode` 四值）
- Test: `apps/desktop/tests/unit/live2d-settings.spec.ts`

**Interfaces:**
- Consumes: 批次 A `Live2DSettings`（`{enabled, modelId}`）、`Live2DPerformanceMode`（controller.ts，`'auto'|'high'|'low'`）、`Live2DSettingsSchema`/`DEFAULT_LIVE2D`（ipc-response.ts）
- Produces: `shared/contracts/live2d.ts` 的 `PerformanceMode = 'auto'|'quality'|'balanced'|'low_power'`（**新建**）；`Live2DSettings = { enabled:boolean; modelId:string|null; scale:number; offsetX:number; offsetY:number; mouseTracking:boolean; autoMotions:boolean; lipSync:boolean; performanceMode:PerformanceMode; reduceMotion:boolean }`；`ipc-response.ts` 的 `Live2DSettingsSchema`/`DEFAULT_LIVE2D`（10 字段 + `performanceMode` 四值）+ `normalizePerformanceMode(v: string): PerformanceMode`（`'high'→'quality'`、`'low'→'low_power'`、`'auto'|'quality'|'balanced'|'low_power'` 原样）。后续 Task 3/5 消费。

- [ ] **Step 1: 写失败单测 `live2d-settings.spec.ts`**（当前 10 字段解析会失败/缺失字段）：
```ts
import { describe, expect, it } from 'vitest'
import { PerformanceMode, Live2DSettings } from '../../../src/shared/contracts/live2d'
import { DEFAULT_LIVE2D, normalizePerformanceMode, SettingsStateSchema } from '../../../src/shared/schemas/ipc-response'
describe('settings 契约（批次B B5）', () => {
  it('DEFAULT_LIVE2D 含全量 10 字段', () => {
    expect(DEFAULT_LIVE2D).toEqual({
      enabled: true, modelId: null, scale: 1, offsetX: 0, offsetY: 0,
      mouseTracking: true, autoMotions: true, lipSync: true,
      performanceMode: 'auto', reduceMotion: false
    })
  })
  it('performanceMode 归一：high→quality / low→low_power / 四值原样', () => {
    expect(normalizePerformanceMode('high')).toBe('quality')
    expect(normalizePerformanceMode('low')).toBe('low_power')
    expect(normalizePerformanceMode('auto')).toBe('auto')
    expect(normalizePerformanceMode('balanced')).toBe('balanced')
    expect(normalizePerformanceMode('unknown')).toBe('auto') // 未知→兜底 auto
  })
  it('加载路径：settings.json 含 performanceMode high/low → safeParse 不 corrupt 且归一（I-3）', () => {
    const r1 = SettingsStateSchema.safeParse({ live2d: { performanceMode: 'high' } })
    expect(r1.success).toBe(true)
    if (r1.success) expect(r1.data.live2d.performanceMode).toBe('quality')
    const r2 = SettingsStateSchema.safeParse({ live2d: { enabled: true, modelId: null, performanceMode: 'low' } })
    expect(r2.success).toBe(true)
    if (r2.success) expect(r2.data.live2d.performanceMode).toBe('low_power')
  })
})
```
- [ ] **Step 2: 运行确认失败**：`pnpm -F @cyrene/desktop test live2d-settings` → FAIL（`PerformanceMode`/`normalizePerformanceMode` 未定义、10 字段不匹配）。
- [ ] **Step 3: `contracts/live2d.ts` 扩**：新建 `export type PerformanceMode = 'auto' | 'quality' | 'balanced' | 'low_power'`；`Live2DSettings` 扩为 10 字段（performanceMode: PerformanceMode）。删除 controller.ts 的 `Live2DPerformanceMode`（三值），改 import 共享 `PerformanceMode`（Task 3 一并落地 setPerformanceMode 签名；本 task 只改类型引用，保持 switchModel/status 等不变）。
- [ ] **Step 4: `ipc-response.ts` 扩 + schema 层归一（I-3）**：`Live2DSettingsSchema` 改 `z.object({ enabled:z.boolean(), modelId:z.string().nullable(), scale:z.number().min(0.5).max(3).default(1), offsetX:z.number().min(-2).max(2).default(0), offsetY:z.number().min(-2).max(2).default(0), mouseTracking:z.boolean().default(true), autoMotions:z.boolean().default(true), lipSync:z.boolean().default(true), performanceMode: z.preprocess((v) => normalizePerformanceMode(String(v)), z.enum(['auto','quality','balanced','low_power'])).default('auto'), reduceMotion:z.boolean().default(false) })`；`DEFAULT_LIVE2D` 同步 10 字段；新增 `export function normalizePerformanceMode(v: string): PerformanceMode { if (v === 'high') return 'quality'; if (v === 'low') return 'low_power'; return (['auto','quality','balanced','low_power'] as const).includes(v as PerformanceMode) ? (v as PerformanceMode) : 'auto' }`。**归一放在 `z.preprocess`（schema 解析期）而非 renderer hydrate**——真实链路是 Main `settings-service` 先 `SettingsStateSchema.safeParse`，裸 `z.enum` 会让含 `'high'/'low'` 的文件直接 corrupt+全量重置（正是要避免的）；`preprocess` 使 load/save 两路都归一（I-3）。**补一个 spec §5 要求的加载路径用例**：构造含 `performanceMode:'high'` 与 `performanceMode:'low'` 的 settings.json→`SettingsStateSchema.safeParse` 不 corrupt、读出 `'quality'`/`'low_power'`。
- [ ] **Step 5: 运行单测**：`pnpm -F @cyrene/desktop test live2d-settings` → PASS；`typecheck` + `lint` 绿。
- [ ] **Step 6: Commit**：`feat(阶段5批次B): Live2DSettings 10 字段 + PerformanceMode 四值 + 持久化链兼容（high/low→quality/low_power 归一）`

---

### Task 2（B3 adapter 面）: Live2DModelHandle 增参数通道 + motion/expression 加载播放 + Layout 装配

**Files:**
- Modify: `apps/desktop/src/renderer/src/live2d/adapter.ts`
- Test: `apps/desktop/tests/unit/live2d-adapter2.spec.ts`

**Interfaces:**
- Consumes: `@framework/*`：`CubismMotion`（`motion/cubismmotion.ts`，`static create(buffer,size,onFinished?)`）、`CubismMotionManager`（`motion/cubismmotionmanager.ts`，`startMotionPriority(motion,autoDelete,priority)`/`updateMotion(model,dt)`）、`CubismExpressionMotion`（`motion/cubismexpressionmotion.ts`，`static create(buffer,size)`）、`CubismExpressionMotionManager`（`motion/cubismexpressionmotionmanager.ts`，继承 `CubismMotionQueueManager.startMotion(motion,autoDelete)`/`updateMotion(model,dt)`）、`CubismModel`（`setParameterValueById(id,value)`/`getParameterIndex(id)` 返回 `-1` 表示未知）、`CubismModelSettingJson`（`getLayoutMap(map)`）、`CubismModelMatrix`（`math/cubismmodelmatrix.ts`，`setupFromLayout(map)`）。cyrene:// 供给（批次 A）。
- Produces: `Live2DModelHandle` 增 `getParameterIdList(): string[]`、`setParam(id: string, value: number): void`（基于 `getParameterIndex` 真域判定：`idx < 0 || idx >= getParameterCount()` 时静默忽略——**非 `===-1`，见 I-1**）、`startMotion(modelId: string, file: string, priority: number): Promise<void>`、`startExpression(modelId: string, file: string): Promise<void>`、`stopMotion(priority?: number): void`、`stopAll(): void`；`update(dt)` 内推进 motion/expression manager（先喂 motion 参数、再 physics、再 model.update、后 draw）。装配 `Layout`：`setting.getLayoutMap(map)` 非空 → `this.layoutMvp = new CubismModelMatrix(this.model.getCanvasWidth(), this.model.getCanvasHeight())`（**传真实维度，避免无参构造 2.0/0=Infinity，I-2**）+ `setupFromLayout(map)` 拟合；空 → 沿用批量 A `buildFitMvp` scale-only MVP。`stopMotion(priority)` 定义为 **Controller 层仲裁动作**（底层 SDK 只有 `CubismMotionQueueManager.stopAllMotions()`，无按 priority 停——Task 3 按其语义调度）；`stopAll()` → `motionManager/expressionManager.stopAllMotions()`。后续 Task 3/4 消费。

- [ ] **Step 1: 写失败单测 `live2d-adapter2.spec.ts`**（fake engine + fake fetch 记录，复用批次 A `live2d-adapter.spec.ts` 的 fake GL 纪律）：断言 handle 暴露新方法、`setParam` 未知 Id 静默忽略（**断言不写 not-exist 槽**——fake model 的 `setParameterValueById` spy 对未知参数 Id 不被调用，避免「传任何 Id 都不抛错」假绿）、`startMotion/startExpression` 调 cyrene:// fetch 正确文件、`Layout` 有/无时 MVP 拟合路径。**fixture 扩展（M-4）**：现有 `live2d-adapter.spec` 的 FakeModel 需补 mock `getParameterCount/getParameterId(i).getString()/getParameterIndex/setParameterValueById`、`CubismModelSettingJson.getLayoutMap`，并 `vi.mock` `CubismMotionManager/CubismExpressionMotionManager`（它们吃真实 CubismModel），断言 `update(dt)` 会调 `motionManager.updateMotion`。运行确认 FAIL（方法不存在）。
- [ ] **Step 2: handle 增字段与方法**：`Live2DModelHandleImpl` 增 `motionManager: CubismMotionManager`、`expressionManager: CubismExpressionMotionManager`（构造时 new），注意保留既有 `update/draw/destroy` 契约。`getParameterIdList` 返回模型参数 Id 字符串数组：`for (let i=0;i<this.model.getParameterCount();i++){ list.push(this.model.getParameterId(i).getString()) }`——**`CubismId` 的方法是 `.getString()`，没有 `.getId()`（C-1，API 已核对 `id/cubismid.ts:32`）**。`setParam(id, value)`：**存在性判定不能用 `getParameterIndex(id)===-1`**——vendored `cubismmodel.ts:610` 对未知 Id 会向 `_notExistParameterId` 合成新索引并返回 `parameters.count + notExist.size`（永不为 -1，I-1）；改用真域判定 `const idx = this.model.getParameterIndex(id); if (idx < 0 || idx >= this.model.getParameterCount()) return;`（not-exist 域在 `[getParameterCount(), …)`，此判断真正拦截未知 Id），再 `this.model.setParameterValueById(CubismFramework.getIdManager().getId(id), value)`。`update(dt)` 改为：`motionManager.updateMotion(this.model, dt)` → `expressionManager.updateMotion(this.model, dt)` →（physics evaluate）→ `model.update()` → 按 MVP 画。
- [ ] **Step 3: motion/expression 加载原语**（`startMotion`/`startExpression`）：`fetch(cyrene://.../{modelId}/{encodePath(file)})` → `arrayBuffer` → `CubismMotion.create(ab, ab.byteLength)` → `motionManager.startMotionPriority(motion, true, priority)`（autoDelete=true）；expression 同构 `CubismExpressionMotion.create(ab, ab.byteLength)` → `expressionManager.startMotion(expr, true)`。文件路径白名单由调用方（Controller）先行校验（本 task 只管加载，不重复校验——但**加一道深度防御**：file 不匹配该模型 manifest paths 时抛错）。`stopAll()` → `motionManager.stopAllMotions()` + `expressionManager.stopAllMotions()`；`stopMotion(priority)` 仅作 Controller 仲裁的占位（不被 handle 层使用，见 Interfaces 注）。销毁时 handle.destroy 已释放 model/moc。
- [ ] **Step 4: Layout 装配**：`createModel` 内 `const layoutMap = new Map<string, number>(); const hasLayout = setting.getLayoutMap(layoutMap)`；`hasLayout` 且非空 → `this.layoutMvp = new CubismModelMatrix(this.model.getCanvasWidth(), this.model.getCanvasHeight()); this.layoutMvp.setupFromLayout(layoutMap)`（**传真实维度防除零 Infinity；setupFromLayout 用小写 key，装配时对 layoutMap 键按需要归一大小写——官方 model3 `Layout` 大写 `Width/CenterX/...`，读取后要么归一、要么 fixture 与实现同 key，I-2**）；无 → `this.layoutMvp = null`（用批次 A `buildFitMvp`）。`draw()` 分支：有 layoutMvp 用其矩阵 × 投影（`CubismMatrix44.multiply` 或 `renderer.getMvpMatrix().setMatrix(...)`），无则 scale-only。**单测断言「有 Layout 时 MVP 矩阵非退化（无 NaN/Infinity）」**。
- [ ] **Step 5: 运行单测**：`pnpm -F @cyrene/desktop test live2d-adapter2` → PASS；`typecheck` + `lint` 绿；回归既有 `live2d-adapter.spec`（批次 A）不破。
- [ ] **Step 6: Commit**：`feat(阶段5批次B): Live2DAdapter 参数通道 + motion/expression 加载播放 + Layout 装配`

---

### Task 3（B1+B2+B4 controller 内核）: 状态机收敛表 + 待机动画纯函数 + 参数级回退

**Files:**
- Create: `apps/desktop/src/renderer/src/live2d/state-machine.ts`
- Create: `apps/desktop/src/renderer/src/live2d/param-anim.ts`
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`
- Test: `apps/desktop/tests/unit/live2d-state.spec.ts`、`tests/unit/live2d-param-anim.spec.ts`、`tests/unit/live2d-controller.spec.ts`（扩）

**Interfaces:**
- Consumes: Task 2 handle 新方法（getParameterIdList/setParam/startMotion/startExpression/stopMotion/stopAll）；Task 1 `PerformanceMode`；spec §3.1 收敛表
- Produces: `state-machine.ts`：`export type CharacterState = 'offline'|'idle'|'listening'|'thinking'|'speaking'|'waiting_permission'|'working'|'happy'|'sad'|'surprised'|'error'`；`export class CharacterStateMachine`：`onEvent(event: StateEvent): CharacterState`（事件→态转移，含优先级仲裁与回退，纯逻辑可单测）；`export type StatePriority = 0|1|2|3`。`param-anim.ts`：`export function blinkTarget(tSec, paramIds, clock): Record<string,number>`、`export function breathTarget(tSec, paramIds): Record<string,number>`、`export function mouthLevelTarget(level, paramIds): Record<string,number>`（均返回「要写的参数→值」，空对象=无参数可写）。`controller.ts`：真实实现 `setState(s)/setMouthLevel(level)/setLookTarget(target)/setExpression/playMotion` + 状态机组合 + 参数级回退（B4）+ switchModel 返回生效 id。

- [ ] **Step 1: 写失败单测 state-machine.spec.ts**：收敛表全转移（thinking→speaking→idle、error 打断、低不打断 3 级、同态幂等、结束回正确回退态非一律 idle、`listening/working/waiting_permission` 槽位定义但无源）。运行 FAIL（CharacterStateMachine 未定义）。
- [ ] **Step 2: 写 `state-machine.ts`**：实现 spec §3.1 收敛表与优先级仲裁（纯类，无 SDK/Pinia）。
- [ ] **Step 3: 写 param-anim.spec.ts + param-anim.ts**：blinkTarget 在 `paramIds` 含 `ParamEyeROpen/LOpen` 时返回变化序列（随机间隔+闭眼时长、可注入时钟），不含→空对象；breathTarget 含 `ParamAngleZ` 时正弦，不含→空对象（**纯 sine，不调 CubismBreath**，C-1）；mouthLevelTarget 含 `ParamMouthOpenY` 时映射 [0,1]→值，不含→空对象。
- [ ] **Step 4: 改 controller.ts**：组合 CharacterStateMachine + param-anim；真实 `setState/playMotion/setMouthLevel/setLookTarget/setExpression`；`tick` 内（ready 且 autoMotions 时）驱动待机动画（眨眼光照 state-machine、呼吸正弦）；B4：模型无动作（`getParameterIdList` 无对应 motion）时态→参数映射（speaking→mouthLevel、thinking→AngleX、happy→EyeLSmile 等，表见 spec §3.4）；`switchModel(id): Promise<string>` 改返回生效 id（成功=id、守卫丢弃/失败=旧 id）。**注意（M-2）**：`setLookTarget` 签名由批次 A 占位 `(_x:number,_y:number)` 改为 doc05 的 `setLookTarget(target: NormalizedPoint | null)`——这是对既有占位签名的显式变更（null=回正），实现对内不再用 (x,y)。
- [ ] **Step 5: 运行单测 + 回归**：`pnpm -F @cyrene/desktop test live2d-state live2d-param-anim live2d-controller` → PASS；`typecheck` + `lint` 绿；批次 A `live2d.spec`（controller+store）不破。
- [ ] **Step 6: Commit**：`feat(阶段5批次B): Controller 状态机收敛表 + 待机动画纯函数（blink/breath/mouth）+ 无动作参数级回退 + switchModel 生效 id`

---

### Task 4（B3 调度 + B4 wiring + state source）: 动作调度仲裁 + 情绪表情 + live2dStateSource 编排

**Files:**
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`（playMotion 调度细化 + 白名单）
- Create: `apps/desktop/src/renderer/src/live2d/state-source.ts`
- Modify: `apps/desktop/src/renderer/src/stores/live2d.store.ts`（接线 stateSource；switchModel 生效 id 持久化）
- Test: `apps/desktop/tests/unit/live2d-store.spec.ts`、`tests/unit/live2d-state-source.spec.ts`

**Interfaces:**
- Consumes: Task 2/3 的全部 handle 方法 + controller 状态机；`messageStore.activeGenerationId`（有值=生成中）、`connectionStore.state.status`、`voiceStore.tts.playing`；**wire 字段名是 `emotion` 不是 `mood`**——`generation.completed.emotion?: string`（`shared/contracts/events.ts:62`），写在完成后的 assistant `Message.emotion`；state-source 经 `messageStore` 读取最后完成 assistant message 的 `.emotion`（I-4）
- Produces: `state-source.ts`：`export function createLive2dStateSource(sources: { connection: () => ConnectionState; isGenerating: () => boolean; isSpeaking: () => boolean; emotion: () => string | undefined }, push: (s: CharacterState) => void): () => void`（订阅组合 → push；返回退订）。controller 的 `playMotion` 白名单核查 + 调度（合并 ~500ms/最大时长 ~15s/清队列/低不打断 3 级 + speaking/thinking 激活时不发点击）。`live2dStore` 用 `switchModel` 返回的生效 id 持久化 `modelId`（D5B-10）。**M-1**：spec D5B-04 曾列 `conversationStore` 为订阅源之一，但批次 B 无「conversation→角色态」的具体映射（无意义），本批 `createLive2dStateSource` 不订阅 conversationStore，注释注明「归阶段 6 / 后续」。

- [ ] **Step 1: 单测 controller 调度（扩 live2d-controller.spec）**：playMotion 白名单外忽略不抛错；低优先级不打断 3 级；同动作重复合并；长动作 ~15s 超时 stopMotion；快速切换清队列；情绪态→setExpression 命中/不命中。运行 FAIL 或补断言。
- [ ] **Step 2: controller.playMotion 调度细化**：`playMotion(file, priority)`——文件路径 ∈ `modelsMap[当前模型].motions` 白名单才 `handle.startMotion(modelId, file, priority)`，否则忽略；去抖 Map（file→ts，500ms 内重复忽略）；最大时长追 timer（~15s → `handle.stopMotion(priority)`）；切模型/会话清队列（`handle.stopAll`）。`setExpression(file)` 同理白名单 + `startExpression`。情绪态 happy/sad/surprised → 本地映射表（路径文件命中）→ setExpression，否则落 B4。
- [ ] **Step 3: 写 state-source.spec.ts + state-source.ts**：`createLive2dStateSource` 组合（I-4 真 backing）——connection disconnected→offline；isGenerating（`messageStore.activeGenerationId` 有值）且 `!isSpeaking` → thinking；isSpeaking（`voiceStore.tts.playing===true` **或**当前生成已有正文 delta——实现取 `messageStore` 当前 gen 是否已产出 content 段）→speaking；emotion（读最后完成 assistant message `.emotion`）命中本地映射表（happy/sad/surprised）→ 对应情绪态，未知码忽略；error→error；否则 idle。单测各源组合，断言 emotion 穿透与未知码忽略。
- [ ] **Step 4: live2dStore 接线 + 竞态硬化**：`init` 后 `createLive2dStateSource` push 到 controller.setState；`switchModel(next)` 改 `const effectiveId = await ctrl.switchModel(next)` → `setLive2d({ modelId: effectiveId })`（不再无条件 persist next）；`dispose` 退订 stateSource。
- [ ] **Step 5: 运行单测 + 回归**：`pnpm -F @cyrene/desktop test live2d-store live2d-state-source live2d-controller` → PASS；`typecheck` + `lint` + `build` 绿。
- [ ] **Step 6: Commit**：`feat(阶段5批次B): 动作调度仲裁（白名单/合并/超时/清队列）+ 情绪→表情 + live2dStateSource 状态编排 + switchModel 生效 id 持久化`

---

### Task 5（B5 UI + B6 Panel）: CyLive2DPane 设置子页 + Panel 完整化

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyLive2DPane.vue`
- Modify: `apps/desktop/src/renderer/src/components/CySettingsView.vue`（character nav → CyLive2DPane）
- Modify: `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue`（状态徽标/缩放偏移手柄/鼠标跟随点击/Layout 渲染）
- Test: `apps/desktop/tests/unit/live2d-pane.spec.ts`、`tests/unit/live2d-panel.spec.ts`

**Interfaces:**
- Consumes: Task 1 `Live2DSettings` 10 字段 + `setLive2d`；Task 3/4 controller/store；批次 A Panel（canvas + 模型下拉 + 状态态）
- Produces: `CyLive2DPane.vue`（doc11 §7.1：enabled/模型列表+preview/状态错误/scale+offset/鼠标跟随/自动动作/口型/性能模式四值/减少动态/恢复默认；改即 `setLive2d` patch → settingsStore 防抖持久化）；`CyLive2DPanel.vue` 增状态徽标 + 缩放偏移手柄 + 鼠标跟随点击（D5B-09）；`CySettingsView` character 挂载。

- [ ] **Step 1: 写 `CyLive2DPane.vue`（新建）**：镜像 `CyVoicePane.vue` 结构；表单控件绑定 `settingsStore.live2d` 各字段，`change/input` → `setLive2d`；模型下拉 `models`（live2dStore）+ available 过滤 + preview 占位；performanceMode 下拉（四值）；scale/offset 滑块（`scale∈[0.5,3]`、`offset∈[-2,2]`）；恢复默认 → `setLive2d(DEFAULT_LIVE2D)`。
- [ ] **Step 2: `CySettingsView.vue` 挂载**：`import CyLive2DPane`；`<CyLive2DPane v-else-if="activeNav === 'character'" />`（在 voice 后）。
- [ ] **Step 3: `CyLive2DPanel.vue` 完整化**：状态徽标（`controller.status`+`CharacterState` → 本地文案映射）；缩放偏移手柄（读 live2d scale/offset → canvas 视图变换，即时预览 + `setLive2d`）；鼠标跟随/点击（mousemove → `setLookTarget(归一化)`，mouseleave → `setLookTarget(null)` 回正，`mouseTracking`+可见+`!reduceMotion` 才驱动；点击 → `playMotion(预设文件, 1)` 仅对白名单命中模型，不打断高优先）；`onMounted` 接 `live2dStore.tick` rAF（批次 A 已有），`onBeforeUnmount` dispose。
- [ ] **Step 4: 单测 pane/panel**：pane 各控件读写 setLive2d patch + 防抖；panel 状态徽标文案、缩放偏移转换、mouseleave→setLookTarget(null)、点击不打断高优先（fake controller spy）。运行 PASS。
- [ ] **Step 5: 运行**：`pnpm -F @cyrene/desktop test live2d-pane live2d-panel` + `typecheck` + `lint` + `build` 绿；既有 `live2d.spec`（批次A）不破。
- [ ] **Step 6: Commit**：`feat(阶段5批次B): CyLive2DPane 设置子页 + CyLive2DPanel 状态徽标/缩放偏移/鼠标跟随点击 + 挂载 character nav`

---

### Task 6（B7 集成 + 文档）: Electron 集成测试扩展 + 文档同步

**Files:**
- Modify: `apps/desktop/tests/integration/electron-live2d.spec.ts`
- Modify: `docs/05-Cyrene-Live2D前端接入设计-v0.2.md`、`docs/10-...-任务拆分-v0.2.md`、`docs/11-...-设置中心详细设计.md`、`docs/16-...-进度跟踪.md`、`README.md`、`CLAUDE.md`、决策记录 `docs/review/2026-08-18-阶段5批次B-决策记录.md`

**Interfaces:**
- Consumes: Task 1-5 全部；批次 A 集成 harness（`_electron` + xvfb/SwiftShader + `CYRENE_TEST_USERDATA`）；Haru（有动作）与 lil（无动作，本机装配后集成；skip-when-absent 纪律）
- Produces: 批次 B 验收证据；文档三态/计数同步

- [ ] **Step 1: 集成用例扩展**（沿用纪律：真实点击、`expect.poll`、`count()===0`、xvfb-run）：
  1. **状态驱动**：mock 后端发 `generation.started`/`generation.completed`（及正文 delta）（或经 Main 编排）→ 面板状态徽标「思考中」→「说话中/空闲」（真实 DOM 断言）；
  2. **动作播放**：Haru 触发 speaking → 帧推进、canvas 非空、无 console error；lil 同场景 → 参数级（canvas 非空 + 无错误）；**情绪态→表情**（mock `generation.completed.emotion='happy'` → Haru setExpression 进入、canvas 非空）；
  3. **设置子页**：打开「角色与外观」→ 改 scale/performanceMode → 即时预览 + 重启后持久化恢复；
  4. **性能模式**：四值下拉存在、选中持久化、旧值 `high`/`low` 读回归一；
  5. **布局**：lil（无 Layout）沿用 scale-only（A 已验）；有 Layout fixture（Haru 无 Layout——用 mock model3 注入 Layout 或断言 lil 路径）画幅正常；
  6. **切换竞态**：快速连续 `switchModel(a);switchModel(b)` → 最终 `live2dStore.modelId` 与实际渲染模型一致（生效 id）。
  - 运行 `pnpm -F @cyrene/desktop test:integration`（新增 + 既有 electron-live2d 回归）全绿；`build`。
- [ ] **Step 2: 文档同步**（中文、按既定纪律）：doc05 §18「批次 B 已落地/待落地」状态 + §3 接口注释（Controller 接口、`Live2DModelSummary`、`Live2DSettings` 10 字段）+ doc10 §8 注记 + doc11 §7.1 状态 + doc16 进度 + README/CLAUDE.md 三态与计数；新建决策记录（D5B-01~10 + nit-a/b/c + 中途决策）。
- [ ] **Step 3: 运行全量门禁**：`test`（新增单测 + 既有回归）+ `test:integration` + `typecheck` + `lint` + `build` 全绿。
- [ ] **Step 4: Commit**：`test(阶段5批次B): Electron 集成——状态驱动/动作播放/设置子页/性能模式/布局/切换竞态` + `docs(阶段5批次B): 文档同步 + 决策记录`

---

## 任务顺序依赖

```
Task1(B5 契约: settings 10 字段+四值) ──► Task3(controller 消费 performanceMode)
Task2(B3 adapter: 参数+motion/expr+Layout) ──► Task3(handle 新方法)
Task3(B1+B2+B4 controller 内核: 状态机+待机纯函数+参数回退+switch生效id)
   └─► Task4(B3 调度+state source: playMotion 仲裁+live2dStateSource+store 接线)
Task1+3+4 ──► Task5(B5 UI+Panel)
Task1-5 ──► Task6(集成+文档)
```

执行序 1→2→3→4→5→6（SDD 串行；Task1/2 无文件写冲突——Task1 只改 contracts/schema，Task2 只改 adapter；Task3 消费两者接口）。

## Self-review notes（写作时已核）

- spec 全覆盖：D5B-01/02→Task2/3（参数通道+纯函数呼吸）；D5B-03/04→Task3/4（B4 回退+state source）；D5B-05→Task3（收敛表）；D5B-06→Task1（四值迁移）；D5B-07→Task2/4（motion/expr+调度）；D5B-08→Task1/5（设置契约+UI）；D5B-09→Task5（鼠标）；D5B-10→Task3/4（switch 生效 id）+Task5（Panel）。
- 无 placeholder：每 step 含真实文件/签名/断言；Framework motion/expression API 名与 vendored 源码核对（`CubismMotion.create`/`startMotionPriority`/`updateMotion`、`CubismExpressionMotion.create`、`setParameterValueById`/`getParameterIndex`、`getLayoutMap`/`CubismModelMatrix.setupFromLayout`）。
- 类型一致：`PerformanceMode` 四值（Task1→3/5）、`CharacterState` 11 态（Task3/4）、`setParam/getParameterIdList/startMotion/startExpression/stopMotion/stopAll`（Task2→3/4）、`switchModel(id):Promise<string>` 生效 id（Task3→4）、`Live2DSettings` 10 字段（Task1→5）。
- doc05 §9 调度（合并/超时/清队列/低不打断 3 级）+ spec C-1（不调 CubismBreath）+ I-1/I-2/I-3/I-4（情绪表情/回正/点击优先级/文件路径身份）均已落 Task。
- 「无动作模型 B4 参数回退」在 Task3 落地（controller 内核），Task4 接调度与 state source——B4 与 B3 共享 controller，符合 spec「有动作走 B3、无动作走 B4」的存在性路由。
