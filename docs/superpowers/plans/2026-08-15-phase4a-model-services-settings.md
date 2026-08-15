# P4-A（模型服务 Profile 管理 + TTS 试听 + 设置中心框架）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron Renderer 提供设置中心「模型服务」页：三类 LLM/STT/TTS Profile 可查看、测试、切换；自定义 Profile 可新增/编辑/复制/删除（密钥不回显）；TTS 声音可列表与试听；desktop/local_worker 展示不可用态。

**Architecture:** 三层边界不变（Main 持 BackendAdapter + MediaService，Preload 具名窄 API，Renderer Pinia store 纯 UI）。新增 `providers-mapper.ts`（ProviderResponse→ModelProfile[] 纯函数）供 real/mock 共用；real-backend 落成模型/TTS 方法 + `switch_model_result`/`set_tts_voice_result` pending 关联；`modelServiceStore` 编排 UI；`appStore.currentView` 驱动设置中心 overlay；TTS 试听音频经 MediaService 一次性内存路由（`tts-preview`）供 `<audio>` 播放，二进制不落 Renderer。

**Tech Stack:** Electron + Vue 3 + TypeScript + Pinia + zod（运行时 schema）+ Vitest（单测）+ Playwright `_electron`（集成）。

**Spec:** [2026-08-15-phase4a-model-services-settings-design.md](../specs/2026-08-15-phase4a-model-services-settings-design.md)（plan 从 spec 论证；执行者两者都读）

## Global Constraints

- **凭据永不回显**：`apiKey` 只存在当前表单组件，store 草稿/state 不含 `apiKey`；save/test 成功或失败后调用方清空输入框；IPC 出参 schema 白名单丢弃未知键。
- **backend 为主**：desktop/local_worker 条目只展示「不可用·待配置」态，不提供测试/激活（D4）；`UpsertModelProfileCommand.executionLocation` 类型允许三值但 UI 不发送非 backend。
- **WS result 帧关联（D-A14）**：单服务单 in-flight；`switch_model_result` 按回显 `service`+`model`、`set_tts_voice_result` 按回显 `voice` 匹配 pending；超时 10s reject；不匹配（迟到/乱序）忽略。
- **错误三形状（§3.4）**：REST ProtocolError（`{code,error}`）→ `backendCode` 透传；REST v1 ApiFail（`{error}`）→ 无 code；WS result 帧 `"<CODE>: <msg>"` 前缀解析为 `{backendCode, message}`。
- **试听二进制不落 Renderer**：adapter 返回 raw bytes，IPC handler 经 MediaService `putTtsPreview` 存一次性内存缓存，Renderer 只拿 `cyrene://` URL。
- 测试纪律：944 单测（83 files）/ 42 集成（11 files）基础上全绿；typecheck/lint/build 全绿；文档中文。
- 真实 Windows Electron（REAL 模式）是验收方；本批 Mock 驱动的工作标「已开发、未联调」。

---

## 文件结构

| 文件 | 职责 | Task |
|---|---|---|
| `src/shared/contracts/model.ts` | 重写 ModelProfile + 新增命令/结果/TTS/激活选择类型 | 1 |
| `src/shared/contracts/backend.ts` | 扩展 ModelProfileTestResult/ActivateModelProfileCommand | 1 |
| `src/shared/contracts/events.ts` | 新增 SwitchModelResultEvent/SetTtsVoiceResultEvent | 1 |
| `src/shared/contracts/ipc.ts` | 新增 `models:*`/`tts:*` 通道 | 1 |
| `src/shared/schemas/ipc-response.ts` | ModelProfileSchema 等出参 schema | 2 |
| `src/main/ipc/channels.ts` | models/tts 命令 requestSchema | 2 |
| `src/main/transport/protocol-v2/raw-types.ts` | switch_model_result/set_tts_voice_result RawFrame | 2 |
| `src/main/transport/protocol-v2/raw-schemas.ts` | 对应 raw schema | 2 |
| `src/main/transport/providers-mapper.ts`（新） | ProviderResponse→ModelProfile[] 纯函数 | 3 |
| `src/main/transport/protocol-v2/frame-mapper.ts` | switch_model_result/set_tts_voice_result → BackendEvent | 4 |
| `src/main/transport/real-backend.ts` | 落成模型/TTS 方法 + pending + services 保存 + 错误解析 | 4 |
| `src/main/transport/mock-backend.ts` | 三类内置 profile + custom CRUD/test/voices/preview/setVoice | 5 |
| `src/main/models/model-handlers.ts`（新） | models/tts IPC handler（含 previewTts 组装） | 6 |
| `src/main/ipc/handlers.ts` | 装配 model-handlers | 6 |
| `src/preload/desktop-api.ts` + `index.d.ts` + `renderer/src/stores/desktop-api.types.ts` | 暴露 models/tts 方法 | 6 |
| `src/main/attachments/media-service.ts` | MediaRouteType 加 `tts-preview` + putTtsPreview + stream 分支 | 7 |
| `src/renderer/src/stores/model-service.store.ts`（新） | 模型服务编排 | 8 |
| `src/renderer/src/stores/app.store.ts`（新） | currentView | 9 |
| `src/renderer/src/components/CySettingsView.vue` 等（新） | 设置中心 UI | 9 |
| `src/renderer/src/App.vue` / `CyNavRail.vue` | 视图切换接入 | 9 |
| `tests/unit/providers-mapper.spec.ts` 等 | 单测 | 3-8 |
| `tests/integration/settings-model-services.spec.ts`（新） | 真实 Electron 集成 | 10 |

---

### Task 1: 领域契约（model.ts / backend.ts / events.ts / ipc.ts）

**Files:**
- Modify: `src/shared/contracts/model.ts`（整文件重写）
- Modify: `src/shared/contracts/backend.ts`（ModelProfileTestResult / ActivateModelProfileCommand 扩展）
- Modify: `src/shared/contracts/events.ts`（BackendEvent 联合扩展）
- Modify: `src/shared/contracts/ipc.ts`（IpcChannels 扩展）

**Interfaces:**
- Produces: `ModelProfile`、`UpsertModelProfileCommand`、`ModelProfileTestCommand`、`ModelProfileTestResult`、`ActivateModelProfileCommand`、`TtsVoice`、`TtsPreviewCommand`、`TtsPreviewOutcome`、`SetTtsVoiceCommand`、`ActiveModelSelection`、`TtsVoiceListResult`、`ModelCredentialStatus`、`ModelProfileSource`、`SwitchModelResultEvent`、`SetTtsVoiceResultEvent`、`IpcChannels.modelsListProfiles` 等。

- [ ] **Step 1: 重写 `model.ts` 领域契约**

```ts
/** 模型服务类型:恰好三类,输入法转写不构成第四类 */
export type ModelServiceType = 'llm' | 'stt' | 'tts'
/** 模型执行位置(区别于 ToolRuntime,模型调用不进入工具状态机) */
export type ModelExecutionLocation = 'backend' | 'desktop' | 'local_worker'
export type ModelProfileSource = 'built_in' | 'custom'
export type ModelCredentialStatus = 'missing' | 'configured' | 'expired'

/** 模型 Profile（可激活模型级展开；id 可直接作为 switch_model.model，spec D-A3） */
export interface ModelProfile {
  id: string                    // 内置 "<provider>/<model>"，custom "custom/<name>"
  type: ModelServiceType
  displayName: string           // provider 名（内置）或 custom name
  source: ModelProfileSource
  provider: string              // test body provider 字段（内置名 或 'custom'）
  model: string                 // test body model 字段（内置 model 名 / custom name）
  models: string[]              // 该 provider 全量模型列表（custom 展示用）
  executionLocation: ModelExecutionLocation
  credentialStatus: ModelCredentialStatus
  enabled: boolean              // ← services.*.enabled（P4-A 仅展示）
  capabilities: string[]        // ← capabilities 键名展开（稳定排序）
  endpointLabel?: string        // custom base_url host 部分（脱敏展示）
  builtIn: boolean              // source 快捷派生（兼容既有消费方）
}

/** 自定义 Profile 保存命令（doc 02 UpsertCustomModelProfileCommand；apiKey 一次性） */
export interface UpsertModelProfileCommand {
  type: ModelServiceType
  name: string                  // custom 条目名
  baseUrl?: string
  apiKey?: string               // 一次性：成功/失败后 Renderer 立即清除
  apiKeyEnv?: string
  models?: string[]
  executionLocation?: ModelExecutionLocation  // 缺省 backend；UI 不发送 desktop/local
  capabilities?: string[]
  makeActive?: boolean          // 保存成功后可选立即切换
}

/** 类型化测试命令（test body 拆 provider/model，spec D-A3/D-A7） */
export interface ModelProfileTestCommand {
  service: ModelServiceType
  provider: string              // 内置名 或 'custom'
  model: string
  level: 'connectivity' | 'usable'
  baseUrl?: string
  apiKey?: string               // 一次性：测试用明文，成功/失败后清除
}

export interface ModelProfileTestResult {
  profileId: string
  service: ModelServiceType
  level: 'connectivity' | 'usable'
  ok: boolean
  latencyMs?: number
  error?: string
  detail?: string
}

/** 激活命令（switch_model 需要 service；由 store 从 profile.type 填） */
export interface ActivateModelProfileCommand {
  profileId: string
  service: ModelServiceType
}

export interface TtsVoice { id: string; name?: string; languages: string[]; capabilities: string[] }
export interface TtsVoiceListResult { voices: TtsVoice[]; current?: string; source: 'static' | 'api'; error?: string }
export interface TtsPreviewCommand { voiceId?: string }   // 领域 camelCase；real-backend 映射 wire {voice_id}
export interface TtsPreviewOutcome { ok: boolean; audioUrl?: string; durationMs?: number; error?: string }
export interface SetTtsVoiceCommand { voice: string }

export interface ActiveModelSelection {
  llmProfileId?: string
  voiceSttProfileId?: string
  ttsProfileId?: string
  dictationSttProfileId?: string    // P4-B 消费；P4-A 仅类型占位
}

/** 模型 Profile 凭据元数据（阶段 4 模型密钥 UI 消费）：Renderer 只见状态,永远看不到明文。 */
export interface ModelCredentialInfo {
  configured: boolean
  originLabel?: string
  expiresAt?: string
  accountLabel?: string
}
```

- [ ] **Step 2: 运行类型检查确认基线无回归**

Run: `cd /home/yomu/elysia-frontend && export PATH="/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH" && pnpm -F @cyrene/desktop typecheck`
Expected: 因既有消费方（real-backend/mock-backend 引用旧 `ModelProfile` 字段）报类型错——这是预期，Task 4/5 修复；先记录基线，不强行通过。

- [ ] **Step 3: 扩展 `backend.ts` 的 ModelProfileTestResult 与 ActivateModelProfileCommand**

`src/shared/contracts/backend.ts`：删除现有 `TestModelProfileCommand`/`ModelProfileTestResult`/`ActivateModelProfileCommand` 三段（移到 model.ts 统一），并重导：

```ts
export type { ModelProfileTestResult, ModelProfileTestCommand, ActivateModelProfileCommand, ModelServiceType, ModelProfile } from './model'
```

> 若 `backend.ts` 有 `export { ... } from './model'` 已有重导，直接在重导列表补这几名。
>
> **`TestModelProfileCommand` 删除后的连锁修复（本 Step 不提交，随 Task 4 一起）：** `src/main/transport/backend-adapter.ts` 第 20 行 import 与第 75 行 `testModelProfile(input: TestModelProfileCommand)` 会报类型错——Task 4 Step 3 必须同步把接口签名改为 `testModelProfile(input: ModelProfileTestCommand)`（import 改从 `@shared/contracts/model` 取）。`grep -rn 'TestModelProfileCommand' src/` 在 Task 4 完成后应只剩 backend-adapter.ts 与 real/mock-backend 的 import——届时一并清理。

- [ ] **Step 4: `events.ts` 新增 result 事件并入 BackendEvent 联合**

> 判别字段必须用 `event:`（现有 `BackendEvent` 全部成员用 `event`，`shared/schemas/events.ts` 的 `BackendEventSchema` 是 `z.discriminatedUnion('event', ...)`，`message.store.ts` 用 `switch (event.event)`）——用 `kind:` 会整仓 typecheck 挂掉。

```ts
export interface SwitchModelResultEvent extends BackendEventEnvelope {
  event: 'switch_model.result'
  service: 'llm' | 'stt' | 'tts'
  model: string
  ok: boolean
  error?: string
}
export interface SetTtsVoiceResultEvent extends BackendEventEnvelope {
  event: 'set_tts_voice.result'
  ok: boolean
  error?: string
  voice?: string
}
```

把两者加入 `BackendEvent` 联合（现有联合在 events.ts 末尾）。

- [ ] **Step 5: `ipc.ts` 新增通道常量**

`IpcChannels` 对象追加：

```ts
  modelsListProfiles: 'models:list-profiles',
  modelsSaveProfile: 'models:save-profile',
  modelsDeleteProfile: 'models:delete-profile',
  modelsTestProfile: 'models:test-profile',
  modelsActivateProfile: 'models:activate-profile',
  modelsGetActiveSelection: 'models:get-active-selection',
  ttsListVoices: 'tts:list-voices',
  ttsPreview: 'tts:preview',
  ttsSetVoice: 'tts:set-voice'
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/model.ts src/shared/contracts/backend.ts src/shared/contracts/events.ts src/shared/contracts/ipc.ts
git commit -m "feat(阶段4 批次A): 领域契约——ModelProfile 对齐 + 模型/TTS 命令与 result 事件 + IPC 通道"
```

---

### Task 2: 运行时 Schema（ipc-response.ts / channels.ts / raw 契约）

**Files:**
- Modify: `src/shared/schemas/ipc-response.ts`
- Modify: `src/shared/schemas/events.ts`（新增两个 result 事件的 runtime schema——**缺则 preload `parseBackendEvent` 会丢弃 emitted 帧**）
- Modify: `src/main/ipc/channels.ts`
- Modify: `src/main/transport/protocol-v2/raw-types.ts`
- Modify: `src/main/transport/protocol-v2/raw-schemas.ts`

**Interfaces:**
- Consumes: Task 1 领域类型。
- Produces: `ModelProfileSchema`、`TtsVoiceSchema`、`TtsVoiceListResultSchema`、`TtsPreviewOutcomeSchema`、`ModelProfileTestResultSchema`、`ActiveModelSelectionSchema`；channels 的 `modelsListProfilesSchema` 等 request schema；raw `switch_model_result`/`set_tts_voice_result` 帧类型与 schema。

- [ ] **Step 1: `ipc-response.ts` 新增出参 schema**

```ts
export const ModelProfileSchema: z.ZodType<ModelProfile> = z.object({
  id: z.string(), type: z.enum(['llm', 'stt', 'tts']), displayName: z.string(),
  source: z.enum(['built_in', 'custom']), provider: z.string(), model: z.string(),
  models: z.array(z.string()), executionLocation: z.enum(['backend', 'desktop', 'local_worker']),
  credentialStatus: z.enum(['missing', 'configured', 'expired']), enabled: z.boolean(),
  capabilities: z.array(z.string()), endpointLabel: z.string().optional(), builtIn: z.boolean()
})
export const ModelProfilesSchema = z.array(ModelProfileSchema)
export const TtsVoiceSchema: z.ZodType<TtsVoice> = z.object({
  id: z.string(), name: z.string().optional(), languages: z.array(z.string()), capabilities: z.array(z.string())
})
export const TtsVoiceListResultSchema: z.ZodType<TtsVoiceListResult> = z.object({
  voices: z.array(TtsVoiceSchema), current: z.string().optional(), source: z.enum(['static', 'api']), error: z.string().optional()
})
export const TtsPreviewOutcomeSchema: z.ZodType<TtsPreviewOutcome> = z.object({
  ok: z.boolean(), audioUrl: z.string().optional(), durationMs: z.number().optional(), error: z.string().optional()
})
export const ModelProfileTestResultSchema: z.ZodType<ModelProfileTestResult> = z.object({
  profileId: z.string(), service: z.enum(['llm', 'stt', 'tts']), level: z.enum(['connectivity', 'usable']),
  ok: z.boolean(), latencyMs: z.number().optional(), error: z.string().optional(), detail: z.string().optional()
})
export const ActiveModelSelectionSchema: z.ZodType<ActiveModelSelection> = z.object({
  llmProfileId: z.string().optional(), voiceSttProfileId: z.string().optional(),
  ttsProfileId: z.string().optional(), dictationSttProfileId: z.string().optional()
})
```

> 需 import 对应类型：`import type { ModelProfile, ModelProfileTestResult, TtsVoice, TtsVoiceListResult, TtsPreviewOutcome, ActiveModelSelection } from '@shared/contracts'`（若 barrel 已导出）。

- [ ] **Step 2: `channels.ts` 新增 request schema**

```ts
export const modelsListProfilesSchema = z.object({ type: z.enum(['llm', 'stt', 'tts']).optional() })
export const modelsSaveProfileSchema: z.ZodType<UpsertModelProfileCommand> = z.object({
  type: z.enum(['llm', 'stt', 'tts']), name: z.string().min(1).max(200),
  baseUrl: z.string().max(2048).optional(), apiKey: z.string().max(8192).optional(),
  apiKeyEnv: z.string().max(200).optional(), models: z.array(z.string().max(200)).max(50).optional(),
  executionLocation: z.enum(['backend', 'desktop', 'local_worker']).optional(),
  capabilities: z.array(z.string().max(100)).max(50).optional(), makeActive: z.boolean().optional()
})
export const modelsDeleteProfileSchema = z.object({ service: z.enum(['llm', 'stt', 'tts']), name: z.string().min(1).max(200) })
export const modelsTestProfileSchema: z.ZodType<ModelProfileTestCommand> = z.object({
  service: z.enum(['llm', 'stt', 'tts']), provider: z.string().min(1).max(200), model: z.string().min(1).max(200),
  level: z.enum(['connectivity', 'usable']), baseUrl: z.string().max(2048).optional(), apiKey: z.string().max(8192).optional()
})
export const modelsActivateProfileSchema: z.ZodType<ActivateModelProfileCommand> = z.object({
  profileId: z.string().min(1).max(512), service: z.enum(['llm', 'stt', 'tts'])
})
export const modelsGetActiveSelectionSchema = z.undefined()
export const ttsListVoicesSchema = z.undefined()
export const ttsPreviewSchema: z.ZodType<TtsPreviewCommand> = z.object({ voiceId: z.string().max(200).optional() })
export const ttsSetVoiceSchema: z.ZodType<SetTtsVoiceCommand> = z.object({ voice: z.string().min(1).max(200) })
```

- [ ] **Step 3: `raw-types.ts` + `raw-schemas.ts` 加 result 帧**

`raw-types.ts` 加（对齐 ws_message.py `SwitchModelResultMessage` / `SetTtsVoiceResultMessage`）：

```ts
export interface RawSwitchModelResult {
  type: 'switch_model_result'
  service: 'llm' | 'stt' | 'tts'
  model: string
  ok: boolean
  error?: string
}
export interface RawSetTtsVoiceResult {
  type: 'set_tts_voice_result'
  ok: boolean
  error?: string
  voice?: string
}
```

`RawFrame` 联合加这两接口；`raw-schemas.ts` 加对应 zod（`switch_model_result`：`ok` 必填 bool、`error` optional；`set_tts_voice_result`：`ok` 必填、`voice`/`error` optional）。

- [ ] **Step 4: `shared/schemas/events.ts` 加 result 事件 schema 并入 BackendEventSchema**

`events.ts` 现有 `BackendEventSchema = z.discriminatedUnion('event', [...])`（判别字段 `event`）。追加两 schema 并加入 union：

```ts
export const SwitchModelResultEventSchema: z.ZodType<import('@shared/contracts').SwitchModelResultEvent> = z.object({
  event: z.literal('switch_model.result'), service: z.enum(['llm', 'stt', 'tts']), model: z.string(),
  ok: z.boolean(), error: z.string().optional()
})
export const SetTtsVoiceResultEventSchema: z.ZodType<import('@shared/contracts').SetTtsVoiceResultEvent> = z.object({
  event: z.literal('set_tts_voice.result'), ok: z.boolean(), error: z.string().optional(), voice: z.string().optional()
})
```

`BackendEventSchema` 的 union 数组追加以 `z.lazy(() => ...)` 形式或直接元素（沿用该文件既有成员写法）。`parseBackendEvent` 自动覆盖。

- [ ] **Step 5: Commit**

```bash
git add src/shared/schemas/ipc-response.ts src/shared/schemas/events.ts src/main/ipc/channels.ts src/main/transport/protocol-v2/raw-types.ts src/main/transport/protocol-v2/raw-schemas.ts
git commit -m "feat(阶段4 批次A): 运行时 Schema——模型/TTS 出参与命令 zod + switch/tts result 事件 schema + raw 帧"
```

---

### Task 3: providers-mapper.ts（ProviderResponse → ModelProfile[] 纯函数）

**Files:**
- Create: `src/main/transport/providers-mapper.ts`
- Test: `tests/unit/providers-mapper.spec.ts`

**Interfaces:**
- Consumes: Task 1 `ModelProfile`/`ModelServiceType`；raw REST 形状（rest.py `ProvidersResponse` wire，字段 camelCase）。
- Produces: `providersToModelProfiles(raw: ProvidersResponseWire): ModelProfile[]`（纯函数，real/mock 共用）。
- **enabled 偏差说明（P4-A）**：mapper 恒置 `enabled: true`（`services.*.enabled` 不消费——P4-A 中 enabled 仅展示且 UI 不编辑，后续批次接入 per-service enabled 时再补参）。

- [ ] **Step 1: 写失败测试**

`tests/unit/providers-mapper.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { providersToModelProfiles, type ProvidersResponseWire } from '../../src/main/transport/providers-mapper'

const WIRE: ProvidersResponseWire = {
  llm: { deepseek: { models: ['deepseek-v4-flash', 'deepseek-r1'], credentialConfigured: true, runtime: 'backend', capabilities: { auth: 'api_key' } } },
  stt: { 'sensevoice/sense-voice': { models: ['sense-voice'], credentialConfigured: false, runtime: 'backend', capabilities: {} } },
  tts: {},
  custom: { llm: [{ name: 'my-llm', base_url: 'https://api.example.com', models: ['m1'], runtime: 'backend', credentialConfigured: true, capabilities: {} }] },
  unconfigured: { llm: [{ name: 'openai', env_vars: ['OPENAI_API_KEY'] }] }
}

describe('providersToModelProfiles', () => {
  it('内置 provider 每 model 展开一条，id=<provider>/<model>', () => {
    const out = providersToModelProfiles(WIRE)
    const deepseek = out.filter((p) => p.provider === 'deepseek')
    expect(deepseek).toHaveLength(2)
    expect(deepseek[0].id).toBe('deepseek/deepseek-v4-flash')
    expect(deepseek[0].source).toBe('built_in')
    expect(deepseek[0].credentialStatus).toBe('configured')
  })

  it('custom 条目一条，id=custom/<name>，provider=custom', () => {
    const out = providersToModelProfiles(WIRE).filter((p) => p.source === 'custom')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('custom/my-llm')
    expect(out[0].provider).toBe('custom')
    expect(out[0].model).toBe('my-llm')
    expect(out[0].endpointLabel).toBe('api.example.com')
  })

  it('empty models 的 provider 展开为一条（model 用 provider 名兜底），不会静默丢弃', () => {
    const wire = { ...WIRE, stt: { x: { models: [], credentialConfigured: false, runtime: 'backend', capabilities: {} } } }
    const out = providersToModelProfiles(wire)
    expect(out.some((p) => p.id === 'x/x')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/providers-mapper.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 mapper**

```ts
import type { ModelCredentialStatus, ModelProfile, ModelProfileSource, ModelServiceType } from '@shared/contracts/model'

/** rest.py ProvidersResponse wire（camelCase 字段；provider 名动态 key） */
export interface ProvidersResponseWire {
  llm: Record<string, ProviderEntryWire>
  stt: Record<string, ProviderEntryWire>
  tts: Record<string, ProviderEntryWire>
  custom: Partial<Record<ModelServiceType, Array<CustomProviderWire>>>
  unconfigured?: Partial<Record<ModelServiceType, Array<{ name: string; env_vars: string[] }>>>
}
export interface ProviderEntryWire {
  models: string[]
  credentialConfigured?: boolean
  runtime?: 'backend' | 'desktop' | 'local_worker'
  capabilities?: Record<string, unknown>
}
export interface CustomProviderWire {
  name: string
  base_url?: string
  models?: string[]
  runtime?: 'backend' | 'desktop' | 'local_worker'
  credentialConfigured?: boolean
  capabilities?: Record<string, unknown>
}

function caps(entry: { capabilities?: Record<string, unknown> }): string[] {
  return Object.keys(entry.capabilities ?? {}).sort()
}
function hostOf(url: string): string | undefined {
  try { return new URL(url).host } catch { return undefined }
}

/** 单条内置或 custom → ModelProfile[]（内置每 model 一条；custom 单条 id=custom/<name>） */
export function providersToModelProfiles(raw: ProvidersResponseWire): ModelProfile[] {
  const out: ModelProfile[] = []
  const pushEntry = (
    service: ModelServiceType, name: string,
    entry: ProviderEntryWire | CustomProviderWire, source: ModelProfileSource
  ): void => {
    const runtime = entry.runtime ?? 'backend'
    const cred = (entry.credentialConfigured ? 'configured' : 'missing') as ModelCredentialStatus
    const models = 'models' in entry ? (entry.models ?? []) : []
    if (source === 'built_in') {
      const list = models.length ? models : [name]
      for (const m of list) {
        out.push({
          id: `${name}/${m}`, type: service, displayName: name, source, provider: name, model: m,
          models: list, executionLocation: runtime, credentialStatus: cred, enabled: true,
          capabilities: caps(entry), builtIn: true
        })
      }
    } else {
      const base = 'base_url' in entry ? entry.base_url : undefined
      out.push({
        id: `custom/${name}`, type: service, displayName: name, source, provider: 'custom', model: name,
        models, executionLocation: runtime, credentialStatus: cred, enabled: true,
        capabilities: caps(entry), ...(base ? { endpointLabel: hostOf(base) } : {}), builtIn: false
      })
    }
  }
  const services: Array<ModelServiceType> = ['llm', 'stt', 'tts']
  for (const s of services) {
    for (const [name, entry] of Object.entries(raw[s] ?? {})) pushEntry(s, name, entry, 'built_in')
    for (const entry of raw.custom?.[s] ?? []) pushEntry(s, entry.name, entry, 'custom')
  }
  return out
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/providers-mapper.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/transport/providers-mapper.ts tests/unit/providers-mapper.spec.ts
git commit -m "feat(阶段4 批次A): providers-mapper——ProviderResponse→ModelProfile[] 纯函数（D-A3 展开）"
```

---

### Task 4: real-backend 落成模型/TTS 方法 + result 帧关联

**Files:**
- Modify: `src/main/transport/real-backend.ts`
- Modify: `src/main/transport/protocol-v2/frame-mapper.ts`
- Test: `tests/unit/real-backend-model-services.spec.ts`

**Interfaces:**
- Consumes: Task 1-3 类型/mapper；`restFetch`（已存在，`real-backend.ts:492`）。
- Produces: `listModelProfiles`/`testModelProfile`/`activateModelProfile`/`saveModelProfile`/`deleteModelProfile`/`listTtsVoices`/`previewTts`(raw)/`setTtsVoice`/`getActiveModelSelection`；`services` 字段 + `normalizeServices` 归一化；`switch_model_result`/`set_tts_voice_result` pending 关联 + 事件 emit；`resultFrameError` helper；**backend-adapter.ts 接口签名更新（`testModelProfile(input: ModelProfileTestCommand)`，见 Task 1 Step 3 连锁说明）**；`RealBackendOptions.switchTimeoutMs?: number`。

- [ ] **Step 1: 写失败测试（pending 关联 + services 归一化）**

`tests/unit/real-backend-model-services.spec.ts`（仿现有 `real-backend` 单测，用 `wsFactory` 注入假 socket + `fetchImpl` 注入假 REST）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealBackend } from '../../src/main/transport/real-backend'
import type { ModelProfileTestCommand, UpsertModelProfileCommand } from '@shared/contracts/model'
```

关键用例：
1. `listModelProfiles` 拉 `GET /api/providers` 并经 `providersToModelProfiles` 归一化（fetchImpl 返回 ProvidersResponse wire）。
2. `activateModelProfile({profileId:'deepseek/deepseek-v4-flash', service:'llm'})` 发 `switch_model` 帧，fake socket 回 `switch_model_result{service:'llm',model:'deepseek/deepseek-v4-flash',ok:true}` → promise resolve；`ok:false` 带 error → reject 且 error 含 backendCode。
3. `setTtsVoice({voice:'v1'})` 发帧，fake socket 回 `set_tts_voice_result{ok:true,voice:'v1'}` → resolve。
4. `getActiveModelSelection` 在握手 `server_info` 带 `services` 后返回归一化（fake socket 先推 server_info）。
5. `saveModelProfile`：POST 后跟 GET（`/api/providers` 被调两次），返回归一化 custom 条目。
6. `deleteModelProfile`：DELETE `/api/providers/llm/x`；非 2xx 409 body `{ok:false,code:'PROFILE_IN_USE',error:'custom/x 正在使用'}` → reject，断言 `e.details.code === 'PROFILE_IN_USE'`（**CyreneError 只有 code/message/details，`backendCode` 是 IPC 层由 `details.backendCode ?? details.code` 组装——本层断言 details**）。

> fake socket：`class FakeWs { send=vi.fn(); on=vi.fn((ev,cb)=>{this.handlers[ev]=cb}) ; close=vi.fn(); push(frame){this.handlers['message']?.(JSON.stringify(frame))} }`。REST：`fetchImpl` 返回 `{ok, status, json: async()=>body}`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/real-backend-model-services.spec.ts`
Expected: FAIL（方法 notImplemented / 类型错误）。

- [ ] **Step 3: frame-mapper 加 result 帧 case + backend-adapter 接口签名更新**

`frame-mapper.ts`：`mapFrame` 加：

```ts
case 'switch_model_result':
  return { event: 'switch_model.result', service: frame.service, model: frame.model, ok: frame.ok, ...(frame.error ? { error: frame.error } : {}) }
case 'set_tts_voice_result':
  return { event: 'set_tts_voice.result', ok: frame.ok, ...(frame.error ? { error: frame.error } : {}), ...(frame.voice ? { voice: frame.voice } : {}) }
```

> `frame` 需能从 `RawFrame` 判别出 `RawSwitchModelResult`/`RawSetTtsVoiceResult`（Task 2 已加类型）。事件类型来自 Task 1（判别字段 `event:`，见 Task 1 Step 4）。

`backend-adapter.ts` 接口签名更新（Task 1 Step 3 连锁）：import `TestModelProfileCommand` 改 `ModelProfileTestCommand`（从 `@shared/contracts/model`），第 75 行改 `testModelProfile(input: ModelProfileTestCommand)`。

- [ ] **Step 4: real-backend 实现**

类字段追加（构造区）：
```ts
private services?: { llm?: { model?: string | null }; stt?: { model?: string | null }; tts?: { model?: string | null } }
private pendingSwitch: Map<ModelServiceType, { model: string; resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }> = new Map()
private pendingVoice?: { voice: string; resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
```

`RealBackendOptions` 接口追加（构造区）：`switchTimeoutMs?: number`（默认 10000，见 `switchTimeoutMs()`）。

`handleServerInfo` 末尾追加归一化（**`frame.services` 是 `Record<string, unknown>`，不能直接赋值**——需防御性提取 llm/stt/tts 的 `model`，且 `model` 可缺省/null/string 三态；放在版本校验 early-return 之后）：

```ts
/** RawServerInfo.services 是 loose record（raw-types.ts:53）；只取每服务 model（string|null），未知形状忽略 */
private normalizeServices(raw: Record<string, unknown> | undefined): { llm?: { model?: string | null }; stt?: { model?: string | null }; tts?: { model?: string | null } } {
  const pick = (svc: string): { model?: string | null } | undefined => {
    const entry = raw?.[svc]
    if (!entry || typeof entry !== 'object') return undefined
    const m = (entry as { model?: unknown }).model
    if (typeof m === 'string') return { model: m }
    if (m === null) return { model: null }
    return undefined
  }
  return { llm: pick('llm'), stt: pick('stt'), tts: pick('tts') }
}
// handleServerInfo 末尾：
this.services = this.normalizeServices(frame.services)
```

`handleFrame` default 分支前加 result 帧特判（在 `mapper.mapFrame` 之前，直接消费并 pending 匹配；同时仍 emit 事件给 store）：
```ts
case 'switch_model_result': {
  const pending = this.pendingSwitch.get(frame.service)
  if (pending && pending.model === frame.model) {
    clearTimeout(pending.timer); this.pendingSwitch.delete(frame.service)
    frame.ok ? pending.resolve() : pending.reject(this.resultFrameError(frame.error))
  } // 不匹配/无 pending：忽略（D-A14），不 emit 也不告警
  const ev = this.mapper?.mapFrame(frame); if (ev) this.emit(ev)
  return
}
case 'set_tts_voice_result': {
  const pending = this.pendingVoice
  if (pending && frame.voice !== undefined && pending.voice === frame.voice) {
    clearTimeout(pending.timer); this.pendingVoice = undefined
    frame.ok ? pending.resolve() : pending.reject(this.resultFrameError(frame.error))
  }
  const ev = this.mapper?.mapFrame(frame); if (ev) this.emit(ev)
  return
}
```

辅助（错误三形状 §3.4 之 3）：
```ts
private resultFrameError(error: string | undefined): Error {
  const m = /^([A-Z_]+):\s*(.*)$/.exec(error ?? '')
  return new CyreneError(CyreneErrorCode.UNKNOWN, m ? m[2] : (error ?? '模型切换失败'), { backendCode: m ? m[1] : undefined })
}
```

WS 发送 helper + 方法实现（放在 `listStickers` 之后、`submitToolResult` 之前）：
```ts
/** 发无 ACK 帧，需等 result 帧（switch_model/set_tts_voice）；未连接抛 NOT_CONNECTED */
private requireWs(): void {
  if (this.state.status !== 'connected' || !this.ws) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接，无法执行模型操作')
}
private switchTimeoutMs(): number { return this.options.switchTimeoutMs ?? 10000 }

async listModelProfiles(type?: ModelServiceType): Promise<ModelProfile[]> {
  const res = await this.restFetch('/api/providers')
  const parsed = parseRestProviders(await res.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'providers 响应校验失败')
  const all = providersToModelProfiles(parsed.data)
  return type ? all.filter((p) => p.type === type) : all
}

async testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult> {
  const res = await this.restFetch('/api/providers/test', {
    method: 'POST',
    body: JSON.stringify({
      service: input.service, provider: input.provider, model: input.model, level: input.level,
      ...(input.baseUrl ? { base_url: input.baseUrl } : {}), ...(input.apiKey ? { api_key: input.apiKey } : {})
    })
  })
  const parsed = parseRestProviderTest(await res.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'providers/test 响应校验失败')
  const d = parsed.data
  return { profileId: `${input.provider}/${input.model}`, service: input.service, level: input.level, ok: d.ok, ...(d.latency_ms !== undefined ? { latencyMs: d.latency_ms } : {}), ...(d.error ? { error: d.error } : {}), ...(d.detail ? { detail: d.detail } : {}) }
}

async saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile> {
  const res = await this.restFetch('/api/providers', {
    method: 'POST',
    body: JSON.stringify({
      service: input.type,
      entry: {
        name: input.name, ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
        ...(input.apiKey ? { api_key: input.apiKey } : {}), ...(input.apiKeyEnv ? { api_key_env: input.apiKeyEnv } : {}),
        ...(input.models ? { models: input.models } : {}), ...(input.executionLocation ? { runtime: input.executionLocation } : {}),
        ...(input.capabilities ? { capabilities: input.capabilities } : {})
      }
    })
  })
  await res.json() // ApiOk{data: 全量 custom 列表}；api_key 已剔除，弃用
  // save 响应不含 credentialConfigured（F2）→ 重新 GET 取真实状态
  const fresh = await this.restFetch('/api/providers')
  const parsed = parseRestProviders(await fresh.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'providers 响应校验失败')
  const target = providersToModelProfiles(parsed.data).find((p) => p.source === 'custom' && p.model === input.name)
  if (!target) throw new CyreneError(CyreneErrorCode.UNKNOWN, `保存后未找到 custom/${input.name}`)
  if (input.makeActive) await this.activateModelProfile({ profileId: target.id, service: target.type })
  return target
}

async deleteModelProfile(service: ModelServiceType, name: string): Promise<void> {
  await this.restFetch(`/api/providers/${service}/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

async listTtsVoices(): Promise<TtsVoiceListResult> {
  const res = await this.restFetch('/api/tts/voices')
  const parsed = parseRestTtsVoices(await res.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'tts/voices 响应校验失败')
  const d = parsed.data
  return { voices: d.voices.map((v) => ({ id: v.id, ...(v.name ? { name: v.name } : {}), languages: v.languages ?? [], capabilities: v.capabilities ?? [] })), current: d.current ?? undefined, source: d.source === 'api' ? 'api' : 'static', ...(d.error ? { error: d.error } : {}) }
}

/** 返回 raw（bytes 由 IPC handler 写入 MediaService）；二进制不越 Main */
async previewTts(input: TtsPreviewCommand): Promise<{ ok: boolean; mime?: string; bytes?: Uint8Array; durationMs?: number; error?: string }> {
  const res = await this.restFetch('/api/tts/preview', { method: 'POST', body: JSON.stringify(input.voiceId ? { voice_id: input.voiceId } : {}) })
  const parsed = parseRestTtsPreview(await res.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'tts/preview 响应校验失败')
  const d = parsed.data
  if (!d.ok) return { ok: false, ...(d.error ? { error: d.error } : {}) }
  if (!d.audio_base64) return { ok: false, error: '试听无音频数据' }
  const bytes = Buffer.from(d.audio_base64, 'base64')
  return { ok: true, mime: d.mime, bytes: new Uint8Array(bytes), ...(d.duration_ms !== undefined ? { durationMs: d.duration_ms } : {}) }
}

async setTtsVoice(input: SetTtsVoiceCommand): Promise<void> {
  this.requireWs()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { this.pendingVoice = undefined; reject(new CyreneError(CyreneErrorCode.TIMEOUT, `set_tts_voice 超时`)) }, this.switchTimeoutMs())
    this.pendingVoice = { voice: input.voice, resolve, reject, timer }
    this.ws!.send(JSON.stringify({ type: 'set_tts_voice', voice: input.voice }))
  })
}

async activateModelProfile(input: ActivateModelProfileCommand): Promise<void> {
  this.requireWs()
  return new Promise<void>((resolve, reject) => {
    const existing = this.pendingSwitch.get(input.service)
    if (existing) { clearTimeout(existing.timer); existing.reject(new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, `同服务切换未完成`)) }
    const timer = setTimeout(() => { this.pendingSwitch.delete(input.service); reject(new CyreneError(CyreneErrorCode.TIMEOUT, `switch_model 超时`)) }, this.switchTimeoutMs())
    this.pendingSwitch.set(input.service, { model: input.profileId, resolve, reject, timer })
    this.ws!.send(JSON.stringify({ type: 'switch_model', service: input.service, model: input.profileId }))
  })
}

getActiveModelSelection(): ActiveModelSelection {
  const s = this.services
  return { ...(s?.llm?.model ? { llmProfileId: s.llm.model } : {}), ...(s?.stt?.model ? { voiceSttProfileId: s.stt.model } : {}), ...(s?.tts?.model ? { ttsProfileId: s.tts.model } : {}) }
}
```

> 需要新增 REST wire 解析器：`parseRestProviders`/`parseRestProviderTest`/`parseRestTtsVoices`/`parseRestTtsPreview`。放 `protocol-v2/rest-schemas.ts`（仿 `parseRestSessions`，`rest.py` 形状，字段 camelCase）。Task 4 Step 5 实现。

- [ ] **Step 5: `rest-schemas.ts` 加 providers/tts wire 解析**

`protocol-v2/rest-schemas.ts` 追加（zod，镜像 rest.py；`ProvidersResponse` 动态 key 用 `z.record`）：

```ts
export const ProviderEntryWireSchema = z.object({
  models: z.array(z.string()), credentialConfigured: z.boolean().default(false),
  runtime: z.enum(['backend', 'desktop', 'local_worker']).default('backend'),
  capabilities: z.record(z.string(), z.unknown()).default({})
})
export const CustomProviderWireSchema = z.object({
  name: z.string(), base_url: z.string().optional(), api_key_env: z.string().optional(),
  models: z.array(z.string()).optional(), runtime: z.enum(['backend', 'desktop', 'local_worker']).default('backend'),
  credentialConfigured: z.boolean().default(false), capabilities: z.record(z.string(), z.unknown()).default({})
})
export const ProvidersResponseWireSchema = z.object({
  llm: z.record(z.string(), ProviderEntryWireSchema), stt: z.record(z.string(), ProviderEntryWireSchema),
  tts: z.record(z.string(), ProviderEntryWireSchema), custom: z.record(z.string(), z.array(CustomProviderWireSchema)).default({}),
  unconfigured: z.record(z.string(), z.array(z.object({ name: z.string(), env_vars: z.array(z.string()) }))).optional()
})
export const ProviderTestResultWireSchema = z.object({
  ok: z.boolean(), latency_ms: z.number().optional(), error: z.string().optional(), detail: z.string().optional()
})
export const TtsVoiceEntryWireSchema = z.object({
  id: z.string(), name: z.string().optional(), languages: z.array(z.string()).optional(), capabilities: z.array(z.string()).optional()
})
export const TtsVoicesResponseWireSchema = z.object({
  voices: z.array(TtsVoiceEntryWireSchema), current: z.string().optional(), source: z.enum(['static', 'api']).default('static'), error: z.string().optional()
})
export const TtsPreviewResultWireSchema = z.object({
  ok: z.boolean(), mime: z.string().optional(), audio_base64: z.string().optional(), duration_ms: z.number().optional(), error: z.string().optional()
})
```

并导出显式解析函数（**仿现有 `parseRestSessions` 模式，逐函数写 `return Schema.safeParse(input)`；本仓库无 `makeSafeParse` 泛化 helper，勿凭空引用**）：

```ts
export function parseRestProviders(input: unknown): { success: true; data: z.infer<typeof ProvidersResponseWireSchema> } | { success: false } {
  return ProvidersResponseWireSchema.safeParse(input)
}
export function parseRestProviderTest(input: unknown): { success: true; data: z.infer<typeof ProviderTestResultWireSchema> } | { success: false } {
  return ProviderTestResultWireSchema.safeParse(input)
}
export function parseRestTtsVoices(input: unknown): { success: true; data: z.infer<typeof TtsVoicesResponseWireSchema> } | { success: false } {
  return TtsVoicesResponseWireSchema.safeParse(input)
}
export function parseRestTtsPreview(input: unknown): { success: true; data: z.infer<typeof TtsPreviewResultWireSchema> } | { success: false } {
  return TtsPreviewResultWireSchema.safeParse(input)
}
```

- [ ] **Step 6: 运行测试**

Run: `pnpm -F @cyrene/desktop test tests/unit/real-backend-model-services.spec.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/main/transport/real-backend.ts src/main/transport/protocol-v2/frame-mapper.ts src/main/transport/protocol-v2/rest-schemas.ts tests/unit/real-backend-model-services.spec.ts
git commit -m "feat(阶段4 批次A): real-backend 落成模型/TTS 方法 + switch/tts result 帧 pending 关联 + services 归一化"
```

---

### Task 5: mock-backend 扩展

**Files:**
- Modify: `src/main/transport/mock-backend.ts`
- Test: `tests/unit/mock-backend-model-services.spec.ts`

**Interfaces:**
- Consumes: Task 1 类型。
- Produces: mock 的 `listModelProfiles`/`testModelProfile`/`activateModelProfile`/`saveModelProfile`/`deleteModelProfile`/`listTtsVoices`/`previewTts`/`setTtsVoice`；内存 custom 列表 + 激活选择 + voices。

- [ ] **Step 1: 写失败测试**

`tests/unit/mock-backend-model-services.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'

function makeBackend() { return new MockBackend({}) }

describe('MockBackend model services', () => {
  it('listModelProfiles 返回三类内置 + 空 custom', async () => {
    const p = await makeBackend().listModelProfiles()
    expect(p.some((x) => x.type === 'llm' && x.builtIn)).toBe(true)
    expect(p.some((x) => x.type === 'stt')).toBe(true)
    expect(p.some((x) => x.type === 'tts')).toBe(true)
    expect(p.some((x) => x.source === 'custom')).toBe(false)
  })
  it('saveModelProfile 后 custom 出现在列表；同名更新幂等', async () => {
    const b = makeBackend()
    await b.saveModelProfile({ type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com', apiKey: 'k', makeActive: false })
    const list = await b.listModelProfiles('llm')
    expect(list.filter((x) => x.source === 'custom')).toHaveLength(1)
    expect(list.find((x) => x.id === 'custom/my-llm')?.credentialStatus).toBe('configured')
    await b.saveModelProfile({ type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com', apiKey: 'k2', makeActive: false })
    expect((await b.listModelProfiles('llm')).filter((x) => x.source === 'custom')).toHaveLength(1)
  })
  it('deleteModelProfile 激活中 → PROFILE_IN_USE', async () => {
    const b = makeBackend()
    await b.activateModelProfile({ profileId: 'custom/my-llm', service: 'llm' })
    await expect(b.deleteModelProfile('llm', 'my-llm')).rejects.toMatchObject({ details: { code: 'PROFILE_IN_USE' } })
  })
  it('setTtsVoice 更新 currentVoice，activateModelProfile 更新 active 选择', async () => {
    const b = makeBackend()
    await b.setTtsVoice({ voice: 'v2' })
    expect((await b.listTtsVoices()).current).toBe('v2')
    await b.activateModelProfile({ profileId: 'deepseek/deepseek-v4-flash', service: 'llm' })
    expect(b.getActiveModelSelection().llmProfileId).toBe('deepseek/deepseek-v4-flash')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/mock-backend-model-services.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 mock 扩展**

替换现有 `listModelProfiles`/`testModelProfile`/`activateModelProfile`，追加字段与方法：

```ts
// 字段
private readonly mockProviders = {
  llm: { deepseek: { models: ['deepseek-v4-flash', 'deepseek-r1'], credentialConfigured: true, runtime: 'backend', capabilities: { auth: 'api_key' } } },
  stt: { sensevoice: { models: ['sense-voice'], credentialConfigured: false, runtime: 'backend', capabilities: { language: 'zh' } } },
  tts: { edge: { models: ['edge-tts'], credentialConfigured: true, runtime: 'backend', capabilities: { stream: 'true' } } }
}
private readonly customProviders: Record<ModelServiceType, Array<{ name: string; base_url?: string; models?: string[]; runtime?: ModelExecutionLocation; credentialConfigured?: boolean; capabilities?: Record<string, unknown> }>> = { llm: [], stt: [], tts: [] }
private readonly voices = [
  { id: 'v1', name: '晓晓', languages: ['zh-CN'], capabilities: [] },
  { id: 'v2', name: '云希', languages: ['zh-CN'], capabilities: [] },
  { id: 'v3', name: 'Yunxi', languages: ['zh-CN', 'en-US'], capabilities: [] }
]
private currentVoice: string | undefined
private activeSelection: ActiveModelSelection = {}
```

方法：

```ts
async listModelProfiles(type?: ModelServiceType): Promise<ModelProfile[]> {
  const out: ModelProfile[] = []
  const services: ModelServiceType[] = ['llm', 'stt', 'tts']
  for (const s of services) {
    for (const [name, entry] of Object.entries(this.mockProviders[s])) {
      for (const m of (entry.models.length ? entry.models : [name])) {
        out.push({ id: `${name}/${m}`, type: s, displayName: name, source: 'built_in', provider: name, model: m, models: entry.models, executionLocation: 'backend', credentialStatus: entry.credentialConfigured ? 'configured' : 'missing', enabled: true, capabilities: Object.keys(entry.capabilities).sort(), builtIn: true })
      }
    }
    for (const c of this.customProviders[s]) {
      out.push({ id: `custom/${c.name}`, type: s, displayName: c.name, source: 'custom', provider: 'custom', model: c.name, models: c.models ?? [], executionLocation: c.runtime ?? 'backend', credentialStatus: c.credentialConfigured ? 'configured' : 'missing', enabled: true, capabilities: Object.keys(c.capabilities ?? {}).sort(), ...(c.base_url ? { endpointLabel: new URL(c.base_url).host } : {}), builtIn: false })
    }
  }
  return type ? out.filter((p) => p.type === type) : out
}

async testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult> {
  const ok = input.level === 'connectivity' ? true : input.provider !== 'failing-stt'
  return { profileId: `${input.provider}/${input.model}`, service: input.service, level: input.level, ok, latencyMs: 42, ...(ok ? {} : { error: 'mock 转写失败' }) }
}

async saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile> {
  if (input.executionLocation && input.executionLocation !== 'backend') {
    throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'P4-A 不支持非 backend', { code: 'PROFILE_INVALID_RUNTIME' })
  }
  const list = this.customProviders[input.type]
  const existing = list.find((c) => c.name === input.name)
  const entry = { name: input.name, ...(input.baseUrl ? { base_url: input.baseUrl } : {}), ...(input.models ? { models: input.models } : {}), runtime: 'backend' as const, credentialConfigured: Boolean(input.apiKey), capabilities: Object.fromEntries((input.capabilities ?? []).map((c) => [c, true])) }
  if (existing) Object.assign(existing, entry); else list.push(entry)
  const p = (await this.listModelProfiles(input.type)).find((x) => x.id === `custom/${input.name}`)!
  if (input.makeActive) await this.activateModelProfile({ profileId: p.id, service: p.type })
  return p
}

async deleteModelProfile(service: ModelServiceType, name: string): Promise<void> {
  const active = this.activeSelection[service === 'llm' ? 'llmProfileId' : service === 'tts' ? 'ttsProfileId' : 'voiceSttProfileId']
  if (active === `custom/${name}`) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `custom/${name} 正在使用，无法删除`, { code: 'PROFILE_IN_USE' })
  this.customProviders[service] = this.customProviders[service].filter((c) => c.name !== name)
}

async activateModelProfile(input: ActivateModelProfileCommand): Promise<void> {
  if (input.service === 'llm') this.activeSelection.llmProfileId = input.profileId
  else if (input.service === 'tts') this.activeSelection.ttsProfileId = input.profileId
  else this.activeSelection.voiceSttProfileId = input.profileId
}

async listTtsVoices(): Promise<TtsVoiceListResult> {
  return { voices: this.voices, current: this.currentVoice, source: 'static' }
}

async previewTts(_input: TtsPreviewCommand): Promise<{ ok: boolean; mime?: string; bytes?: Uint8Array; durationMs?: number; error?: string }> {
  return { ok: true, mime: 'audio/wav', bytes: new Uint8Array([82, 73, 70, 70]) /* mock WAV 头 */ }
}

async setTtsVoice(input: SetTtsVoiceCommand): Promise<void> { this.currentVoice = input.voice }

getActiveModelSelection(): ActiveModelSelection { return { ...this.activeSelection } }
```

> 需 import `UpsertModelProfileCommand`/`ModelProfileTestCommand`/`SetTtsVoiceCommand`/`TtsVoiceListResult`/`ActiveModelSelection` 类型。`CyreneError`/`CyreneErrorCode` 已在 mock 导入。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/mock-backend-model-services.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/transport/mock-backend.ts tests/unit/mock-backend-model-services.spec.ts
git commit -m "feat(阶段4 批次A): mock-backend 模型/TTS 方法（三类内置 + custom CRUD + voices/preview/setVoice）"
```

---

### Task 6: IPC handlers + Preload

**Files:**
- Create: `src/main/models/model-handlers.ts`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/main/index.ts`（`registerHandlers` 调用处传 `models:{adapter, media}`）
- Modify: `src/preload/desktop-api.ts`、`src/preload/index.d.ts`
- Modify: `src/renderer/src/stores/desktop-api.ts` + `desktop-api.types.ts`
- Test: `tests/unit/model-handlers.spec.ts`

**Interfaces:**
- Consumes: Task 1-4（adapter 方法、schema）；`MediaService`（Task 7 前置——本任务可先定义 MediaService 所需接口，Task 7 实现）。
- Produces: `models*`/`tts*` IPC handler；Preload `api.listModelProfiles` 等方法。

- [ ] **Step 1: 写失败测试（handlers 装配 + previewTts 组装）**

`tests/unit/model-handlers.spec.ts`：注入 mock adapter + mock mediaService（`{ putTtsPreview: vi.fn((id, bytes, mime)=>id) }`），调用 handler 函数断言：list 归一化透传、save 调 adapter、preview 组装 `{ok:true, audioUrl: 'cyrene://renderer/__cyrene-media/tts-preview/<id>'}`、adapter 返回 `{ok:false,error}` 时透传。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/model-handlers.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 model-handlers**

```ts
// src/main/models/model-handlers.ts
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { IpcChannels } from '@shared/contracts'
import {
  modelsListProfilesSchema, modelsSaveProfileSchema, modelsDeleteProfileSchema, modelsTestProfileSchema,
  modelsActivateProfileSchema, modelsGetActiveSelectionSchema, ttsListVoicesSchema, ttsPreviewSchema, ttsSetVoiceSchema
} from '../ipc/channels'
import {
  ModelProfilesSchema, ModelProfileTestResultSchema, ActiveModelSelectionSchema, TtsVoiceListResultSchema, TtsPreviewOutcomeSchema, ModelProfileSchema
} from '@shared/schemas'
import type { BackendAdapter } from '../transport/backend-adapter'
import type { MediaService } from '../attachments/media-service'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import { randomUUID } from 'node:crypto'

export function registerModelHandlers(deps: { adapter: BackendAdapter; media: Pick<MediaService, 'putTtsPreview'>; sanitize: MessageSanitizer; logger: import('../diagnostics/logger').Logger }): void {
  const { adapter, media } = deps
  registerHandler(IpcChannels.modelsListProfiles, createIpcHandler(modelsListProfilesSchema, ModelProfilesSchema, ({ type }) => adapter.listModelProfiles(type), { sanitize: deps.sanitize, channel: IpcChannels.modelsListProfiles, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsSaveProfile, createIpcHandler(modelsSaveProfileSchema, ModelProfileSchema, (input) => adapter.saveModelProfile(input), { sanitize: deps.sanitize, channel: IpcChannels.modelsSaveProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsDeleteProfile, createIpcHandler(modelsDeleteProfileSchema, z.undefined(), (input) => adapter.deleteModelProfile(input.service, input.name), { sanitize: deps.sanitize, channel: IpcChannels.modelsDeleteProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsTestProfile, createIpcHandler(modelsTestProfileSchema, ModelProfileTestResultSchema, (input) => adapter.testModelProfile(input), { sanitize: deps.sanitize, channel: IpcChannels.modelsTestProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsActivateProfile, createIpcHandler(modelsActivateProfileSchema, z.undefined(), (input) => adapter.activateModelProfile(input), { sanitize: deps.sanitize, channel: IpcChannels.modelsActivateProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsGetActiveSelection, createIpcHandler(modelsGetActiveSelectionSchema, ActiveModelSelectionSchema, () => adapter.getActiveModelSelection(), { sanitize: deps.sanitize, channel: IpcChannels.modelsGetActiveSelection, logger: deps.logger }), 0)
  registerHandler(IpcChannels.ttsListVoices, createIpcHandler(ttsListVoicesSchema, TtsVoiceListResultSchema, () => adapter.listTtsVoices(), { sanitize: deps.sanitize, channel: IpcChannels.ttsListVoices, logger: deps.logger }), 0)
  registerHandler(IpcChannels.ttsPreview, createIpcHandler(ttsPreviewSchema, TtsPreviewOutcomeSchema, async (input) => {
    const raw = await adapter.previewTts(input)
    if (!raw.ok) return { ok: false, ...(raw.error ? { error: raw.error } : {}) }
    const id = `ttsp-${randomUUID()}`
    media.putTtsPreview(id, raw.bytes ?? new Uint8Array(), raw.mime ?? 'audio/wav')
    return { ok: true, audioUrl: `cyrene://renderer${MEDIA_PATH_PREFIX}tts-preview/${id}`, ...(raw.durationMs !== undefined ? { durationMs: raw.durationMs } : {}) }
  }, { sanitize: deps.sanitize, channel: IpcChannels.ttsPreview, logger: deps.logger }), 1)
  registerHandler(IpcChannels.ttsSetVoice, createIpcHandler(ttsSetVoiceSchema, z.undefined(), (input) => adapter.setTtsVoice(input), { sanitize: deps.sanitize, channel: IpcChannels.ttsSetVoice, logger: deps.logger }), 1)
}
```

> `MEDIA_PATH_PREFIX` 从 `../attachments/media-service` 导入。`randomUUID` 用于一次性 media id。

- [ ] **Step 4: handlers.ts 装配 + index.ts 传依赖**

`handlers.ts` 的 `registerHandlers` deps 加 `models: { adapter: BackendAdapter; media: MediaService }`，函数体尾部加 `registerModelHandlers({ adapter: deps.models.adapter, media: deps.models.media, sanitize, logger: deps.logger })`。**必须同步改调用处** `src/main/index.ts`（`registerHandlers({...})` 调用点，约 206 行）传入 `models: { adapter: <BackendAdapter 实例>, media: <MediaService 实例> }`——`ChatService` 不暴露 adapter（`createChatService` 只返回 `{connect, setEndpoint, ...}`），需从 Main 装配处直接传；`index.ts` 加入本任务文件列表与 commit。

- [ ] **Step 5: Preload 暴露方法**

`desktop-api.ts` 加（模块级 async function，仿 `queryChatHistory`）：

```ts
async function listModelProfiles(input?: { type?: ModelServiceType }): Promise<ModelProfile[]> {
  return unwrap(await invokeWithArgs<ModelProfile[]>(IpcChannels.modelsListProfiles, input), ModelProfilesSchema)
}
async function saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile> {
  return unwrap(await invokeWithArgs<ModelProfile>(IpcChannels.modelsSaveProfile, input), ModelProfileSchema)
}
async function deleteModelProfile(service: ModelServiceType, name: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.modelsDeleteProfile, { service, name }), z.undefined())
}
async function testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult> {
  return unwrap(await invokeWithArgs<ModelProfileTestResult>(IpcChannels.modelsTestProfile, input), ModelProfileTestResultSchema)
}
async function activateModelProfile(input: ActivateModelProfileCommand): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.modelsActivateProfile, input), z.undefined())
}
async function getActiveModelSelection(): Promise<ActiveModelSelection> {
  return unwrap(await invoke<ActiveModelSelection>(IpcChannels.modelsGetActiveSelection), ActiveModelSelectionSchema)
}
async function listTtsVoices(): Promise<TtsVoiceListResult> {
  return unwrap(await invoke<TtsVoiceListResult>(IpcChannels.ttsListVoices), TtsVoiceListResultSchema)
}
async function previewTts(input: TtsPreviewCommand): Promise<TtsPreviewOutcome> {
  return unwrap(await invokeWithArgs<TtsPreviewOutcome>(IpcChannels.ttsPreview, input), TtsPreviewOutcomeSchema)
}
async function setTtsVoice(input: SetTtsVoiceCommand): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.ttsSetVoice, input), z.undefined())
}
```

并把它们挂到 `api` 对象（`api = { ...existing, listModelProfiles, saveModelProfile, ... }`）。同步更新 `index.d.ts` 与 `renderer/src/stores/desktop-api.types.ts` 的类型签名（`DesktopApiLike`）。

> `desktop-api.types.ts` 是 renderer 侧 `api` 的类型（`DesktopApiLike`），`setDesktopApi(mock)` 注入用。preload `index.d.ts` 是 window.desktopApi 类型。两者都补 9 个方法。

- [ ] **Step 6: 运行测试 + typecheck**

Run: `pnpm -F @cyrene/desktop test tests/unit/model-handlers.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: 两命令通过。

- [ ] **Step 7: Commit**

```bash
git add src/main/models/model-handlers.ts src/main/ipc/handlers.ts src/main/index.ts src/preload/desktop-api.ts src/preload/index.d.ts src/renderer/src/stores/desktop-api.ts src/renderer/src/stores/desktop-api.types.ts tests/unit/model-handlers.spec.ts
git commit -m "feat(阶段4 批次A): models/tts IPC handlers + Preload 具名 API（previewTts 组装一次性 media URL）"
```

---

### Task 7: MediaService tts-preview 路由

**Files:**
- Modify: `src/main/attachments/media-service.ts`
- Test: `tests/unit/media-service.spec.ts`（追加用例，用该文件现有 `mkService` helper；`attachment-media.spec.ts` 不含 stream 测试，勿放那里）

**Interfaces:**
- Consumes: `MEDIA_PATH_PREFIX`（已存在）；`this.now`（MediaService 已有 `now = deps.now ?? Date.now`，见构造）。
- Produces: `MediaRouteType = 'attachment' | 'sticker' | 'tts-preview'`；`putTtsPreview(id, bytes, mime): void`；`parseMediaPath` 白名单加 `tts-preview`；`stream('tts-preview', id, req)` 分支；TTL 清理。

- [ ] **Step 1: 追加失败测试**

`tests/unit/media-service.spec.ts` 追加：

```ts
it('tts-preview 路由：put 后 stream 返回 bytes；未知 id → 404', async () => {
  const svc = mkService()
  svc.putTtsPreview('ttsp-1', new Uint8Array([1, 2, 3]), 'audio/wav')
  const res = await svc.stream('tts-preview', 'ttsp-1', new Request('cyrene://renderer/__cyrene-media/tts-preview/ttsp-1', { headers: { 'sec-fetch-dest': 'img' } }))
  expect(res.status).toBe(200)
  const bytes = new Uint8Array(await res.arrayBuffer())
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  expect(res.headers.get('content-type')).toBe('audio/wav')
  const miss = await svc.stream('tts-preview', 'nope', new Request('cyrene://renderer/__cyrene-media/tts-preview/nope', { headers: { 'sec-fetch-dest': 'img' } }))
  expect(miss.status).toBe(404)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/media-service.spec.ts`
Expected: FAIL（类型/方法不存在）。

- [ ] **Step 3: 实现**

```ts
export type MediaRouteType = 'attachment' | 'sticker' | 'tts-preview'
// 类字段
private readonly ttsPreviewCache = new Map<string, { bytes: Uint8Array; mime: string; createdAt: number }>()
private readonly TTS_PREVIEW_TTL_MS = 60_000

/** 试听音频一次性缓存：放入后 60s 过期；put 时顺手清理过期项（时钟用现有 this.now = deps.now ?? Date.now） */
putTtsPreview(id: string, bytes: Uint8Array, mime: string): void {
  const now = this.now()
  for (const [k, v] of this.ttsPreviewCache) if (now - v.createdAt > this.TTS_PREVIEW_TTL_MS) this.ttsPreviewCache.delete(k)
  this.ttsPreviewCache.set(id, { bytes, mime, createdAt: now })
}

private async streamTtsPreview(id: string): Promise<Response> {
  const hit = this.ttsPreviewCache.get(id)
  if (!hit) return new Response(null, { status: 404 })
  return new Response(hit.bytes, { status: 200, headers: { 'content-type': hit.mime, 'cache-control': 'no-store' } })
}
```

`parseMediaPath` 白名单加 `tts-preview`（media-service.ts:44 现硬编码 attachment/sticker）：

```ts
  if (mt !== 'attachment' && mt !== 'sticker' && mt !== 'tts-preview') return null
```

`stream()` 加 `if (mediaType === 'tts-preview') return this.streamTtsPreview(id)`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/media-service.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/attachments/media-service.ts tests/unit/media-service.spec.ts
git commit -m "feat(阶段4 批次A): MediaService tts-preview 一次性路由（put + 60s TTL + 404）"
```

---

### Task 8: modelServiceStore + 单测

**Files:**
- Create: `src/renderer/src/stores/model-service.store.ts`
- Test: `tests/unit/model-service.store.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `api`（`api.listModelProfiles` 等）；`parsePublicError`（`../utils/public-error`）。
- Produces: `useModelServiceStore()`——`profiles`/`active`/`voices`/`currentVoice`/`testing`/`testResult`/`preview`/`error`/`drafts`/`validation` + `load`/`saveProfile`/`deleteProfile`/`testProfile`/`activate`/`listVoices`/`preview`/`setVoice`/`startEdit`/`updateDraft`/`cancelEdit`。

- [ ] **Step 1: 写失败测试**

`tests/unit/model-service.store.spec.ts`（仿 attachment.store.spec：`setDesktopApi(mockApi)`）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useModelServiceStore } from '../../src/renderer/src/stores/model-service.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(),
  attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  // P4-A 新增
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(),
  testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn()
}

beforeEach(() => {
  setActivePinia(createPinia()); setDesktopApi(mockApi); vi.clearAllMocks()
  mockApi.listModelProfiles.mockResolvedValue([])   // saveProfile/deleteProfile 内部 load() 依赖它返回数组（Minor #17 防 undefined）
  mockApi.getActiveModelSelection.mockResolvedValue({})
})

const PROFILES = [
  { id: 'deepseek/deepseek-v4-flash', type: 'llm', displayName: 'deepseek', source: 'built_in', provider: 'deepseek', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], executionLocation: 'backend', credentialStatus: 'configured', enabled: true, capabilities: [], builtIn: true },
  { id: 'custom/my-llm', type: 'llm', displayName: 'my-llm', source: 'custom', provider: 'custom', model: 'my-llm', models: [], executionLocation: 'backend', credentialStatus: 'missing', enabled: true, capabilities: [], builtIn: false }
]

describe('modelServiceStore', () => {
  it('load 拉 profiles + 激活选择', async () => {
    mockApi.listModelProfiles.mockResolvedValue(PROFILES)
    mockApi.getActiveModelSelection.mockResolvedValue({ llmProfileId: 'deepseek/deepseek-v4-flash' })
    const s = useModelServiceStore()
    await s.load()
    expect(s.profiles).toHaveLength(2)
    expect(s.active.llmProfileId).toBe('deepseek/deepseek-v4-flash')
  })
  it('activate 成功后更新 active', async () => {
    mockApi.activateModelProfile.mockResolvedValue(undefined)
    const s = useModelServiceStore()
    await s.activate({ id: 'custom/my-llm', type: 'llm' } as never)
    expect(mockApi.activateModelProfile).toHaveBeenCalledWith({ profileId: 'custom/my-llm', service: 'llm' })
    expect(s.active.llmProfileId).toBe('custom/my-llm')
  })
  it('activate 失败可见错误且 active 不变', async () => {
    mockApi.activateModelProfile.mockRejectedValue(new Error('[IPC_ERROR] [UNKNOWN] [backendCode=PROFILE_RUNTIME_NOT_BACKEND] 该 Profile 由 Electron 执行'))
    const s = useModelServiceStore()
    await s.activate({ id: 'custom/my-llm', type: 'llm' } as never)
    expect(s.error?.backendCode).toBe('PROFILE_RUNTIME_NOT_BACKEND')
    expect(s.active.llmProfileId).toBeUndefined()
  })
  it('deleteProfile PROFILE_IN_USE → 可见错误', async () => {
    mockApi.deleteModelProfile.mockRejectedValue(new Error('[IPC_ERROR] [UNKNOWN] [backendCode=PROFILE_IN_USE] custom/x 正在使用'))
    const s = useModelServiceStore()
    await s.deleteProfile({ type: 'llm', model: 'x' } as never)
    expect(s.error?.backendCode).toBe('PROFILE_IN_USE')
  })
  it('saveProfile 一次性 apiKey 提交；drafts 不含 apiKey', async () => {
    mockApi.saveModelProfile.mockResolvedValue(PROFILES[1])
    const s = useModelServiceStore()
    const draft = { type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com' }
    await s.saveProfile(draft, 'secret-key')
    expect(mockApi.saveModelProfile).toHaveBeenCalledWith({ ...draft, apiKey: 'secret-key' })
    expect(JSON.stringify(s.drafts)).not.toContain('secret-key')
  })
  it('listVoices + setVoice 更新 currentVoice', async () => {
    mockApi.listTtsVoices.mockResolvedValue({ voices: [{ id: 'v1', languages: [], capabilities: [] }], source: 'static' })
    mockApi.setTtsVoice.mockResolvedValue(undefined)
    const s = useModelServiceStore()
    await s.listVoices()
    expect(s.voices).toHaveLength(1)
    await s.setVoice('v1')
    expect(s.currentVoice).toBe('v1')
  })
  it('preview 成功 → preview.url；失败 → preview.error', async () => {
    mockApi.previewTts.mockResolvedValue({ ok: true, audioUrl: 'cyrene://renderer/__cyrene-media/tts-preview/ttsp-1' })
    const s = useModelServiceStore()
    await s.preview({ voiceId: 'v1' })
    expect(s.preview?.url).toContain('ttsp-1')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/model-service.store.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 store**

```ts
// src/renderer/src/stores/model-service.store.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ActiveModelSelection, ModelProfile, ModelProfileTestResult, ModelServiceType, SetTtsVoiceCommand, TtsPreviewCommand, TtsVoice, UpsertModelProfileCommand } from '@shared/contracts'
import { api } from './desktop-api'
import { parsePublicError, type PublicError } from '../utils/public-error'

export interface ProfileDraft {
  type: ModelServiceType
  name: string
  baseUrl?: string
  apiKeyEnv?: string
  models?: string[]
  capabilities?: string[]
  executionLocation?: 'backend' | 'desktop' | 'local_worker'
}

function messageOf(e: unknown): string { return e instanceof Error ? e.message : String(e) }

export const useModelServiceStore = defineStore('modelService', () => {
  const profiles = ref<ModelProfile[]>([])
  const active = ref<ActiveModelSelection>({})
  const voices = ref<TtsVoice[] | null>(null)
  const voiceSource = ref<'static' | 'api' | null>(null)
  const currentVoice = ref<string | null>(null)
  const voicesError = ref<PublicError>()        // 错误态一律 PublicError（repo 惯例，UI 渲染 .message）
  const loading = ref(false)
  const testing = ref<Record<string, 'idle' | 'running' | 'ok' | 'error'>>({})
  const testResult = ref<Record<string, ModelProfileTestResult | undefined>>({})
  const previewing = ref(false)
  const preview = ref<{ url?: string; error?: string } | null>(null)
  const saving = ref(false)
  const deleting = ref(false)
  const activating = ref<Record<ModelServiceType, boolean>>({ llm: false, stt: false, tts: false })
  const error = ref<PublicError>()
  const drafts = ref<Record<string, ProfileDraft>>({})
  const validation = ref<Record<string, string[]>>({})

  function byType(type: ModelServiceType): ModelProfile[] { return profiles.value.filter((p) => p.type === type) }
  function customProfiles(type: ModelServiceType): ModelProfile[] { return byType(type).filter((p) => p.source === 'custom') }
  function activeProfileId(type: ModelServiceType): string | undefined {
    return type === 'llm' ? active.value.llmProfileId : type === 'tts' ? active.value.ttsProfileId : active.value.voiceSttProfileId
  }

  async function load(): Promise<void> {
    loading.value = true; error.value = undefined
    try {
      const [list, sel] = await Promise.all([api.listModelProfiles(), api.getActiveModelSelection()])
      profiles.value = list; active.value = sel
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { loading.value = false }
  }

  async function activate(profile: Pick<ModelProfile, 'id' | 'type'>): Promise<void> {
    if (activating.value[profile.type]) return
    activating.value[profile.type] = true; error.value = undefined
    try {
      await api.activateModelProfile({ profileId: profile.id, service: profile.type })
      if (profile.type === 'llm') active.value = { ...active.value, llmProfileId: profile.id }
      else if (profile.type === 'tts') active.value = { ...active.value, ttsProfileId: profile.id }
      else active.value = { ...active.value, voiceSttProfileId: profile.id }
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { activating.value[profile.type] = false }
  }

  async function testProfile(profile: Pick<ModelProfile, 'type' | 'provider' | 'model'>, level: 'connectivity' | 'usable', apiKeyInput?: string): Promise<void> {
    const key = `${profile.provider}/${profile.model}|${level}`
    testing.value[key] = 'running'; error.value = undefined
    try {
      const r = await api.testModelProfile({ service: profile.type, provider: profile.provider, model: profile.model, level, ...(apiKeyInput ? { apiKey: apiKeyInput } : {}) })
      testResult.value[key] = r
      testing.value[key] = r.ok ? 'ok' : 'error'
      if (!r.ok) error.value = { message: r.error ?? '测试失败' } as PublicError
    } catch (e) { testing.value[key] = 'error'; testResult.value[key] = undefined; error.value = parsePublicError(messageOf(e)) }
  }

  async function saveProfile(draft: ProfileDraft, apiKeyInput?: string): Promise<void> {
    saving.value = true; error.value = undefined
    try {
      const cmd: UpsertModelProfileCommand = { ...draft, ...(apiKeyInput ? { apiKey: apiKeyInput } : {}) }
      await api.saveModelProfile(cmd)
      delete drafts.value[draft.name]
      delete validation.value[draft.name]
      await load()
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { saving.value = false }
  }

  async function deleteProfile(profile: Pick<ModelProfile, 'type' | 'model'>): Promise<void> {
    deleting.value = true; error.value = undefined
    try {
      await api.deleteModelProfile(profile.type, profile.model)
      await load()
    } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { deleting.value = false }
  }

  async function listVoices(): Promise<void> {
    voicesError.value = undefined
    try {
      const r = await api.listTtsVoices()
      voices.value = r.voices; voiceSource.value = r.source
      currentVoice.value = r.current ?? null; voicesError.value = r.error ? { message: r.error } as PublicError : undefined
    } catch (e) { voicesError.value = parsePublicError(messageOf(e)) }
  }

  async function preview(input: TtsPreviewCommand): Promise<void> {
    previewing.value = true; preview.value = null; error.value = undefined
    try {
      const r = await api.previewTts(input)
      preview.value = r.ok ? { url: r.audioUrl } : { error: r.error ?? '试听失败' }
    } catch (e) { preview.value = { error: parsePublicError(messageOf(e)) } } finally { previewing.value = false }
  }

  async function setVoice(input: SetTtsVoiceCommand): Promise<void> {
    error.value = undefined
    try { await api.setTtsVoice(input); currentVoice.value = input.voice } catch (e) { error.value = parsePublicError(messageOf(e)) }
  }

  function startEdit(profile?: ModelProfile): void {
    const key = profile?.model ?? 'new'
    drafts.value[key] = profile && profile.source === 'custom'
      ? { type: profile.type, name: profile.model, baseUrl: profile.endpointLabel ? `https://${profile.endpointLabel}` : undefined, models: profile.models, capabilities: profile.capabilities }
      : { type: profile?.type ?? 'llm', name: '', models: [], capabilities: [] }
    validation.value[key] = []
  }
  function updateDraft(key: string, patch: Partial<ProfileDraft>): void {
    drafts.value[key] = { ...drafts.value[key], ...patch }
  }
  function cancelEdit(key: string): void { delete drafts.value[key]; delete validation.value[key] }

  return {
    profiles, active, voices, voiceSource, currentVoice, voicesError, loading, testing, testResult, previewing, preview,
    saving, deleting, activating, error, drafts, validation,
    byType, customProfiles, activeProfileId, load, activate, testProfile, saveProfile, deleteProfile,
    listVoices, preview, setVoice, startEdit, updateDraft, cancelEdit
  }
})
```

> `api.saveModelProfile` 成功后再 `load()` 刷新列表（save 返回单条，但列表需重拉保持统一）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/model-service.store.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/model-service.store.ts tests/unit/model-service.store.spec.ts
git commit -m "feat(阶段4 批次A): modelServiceStore——profiles/激活/测试/试听/草稿编排（apiKey 不入 store）"
```

---

### Task 9: appStore + 设置中心 UI

**Files:**
- Create: `src/renderer/src/stores/app.store.ts`
- Modify: `src/renderer/src/components/CyNavRail.vue`（active 上提）
- Modify: `src/renderer/src/App.vue`（视图切换 + settings overlay）
- Create: `src/renderer/src/components/CySettingsView.vue`、`CyModelServicesPane.vue`、`CyProfileCard.vue`、`CyProfileWizard.vue`、`CyTtsVoices.vue`

**Interfaces:**
- Consumes: Task 8 store；`layoutStore`；doc 11 §1 导航分组。
- Produces: `appStore.currentView`；设置中心 overlay + 模型服务页 UI。

- [ ] **Step 1: appStore**

```ts
// src/renderer/src/stores/app.store.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
export type AppView = 'chat' | 'tasks' | 'settings'
export const useAppStore = defineStore('app', () => {
  const currentView = ref<AppView>('chat')
  function setView(v: AppView): void { currentView.value = v }
  return { currentView, setView }
})
```

- [ ] **Step 2: CyNavRail 上提 active**

`CyNavRail.vue`：删局部 `const active = ref<NavKey>('chat')`，改 `const app = useAppStore()`，按钮 `:aria-pressed="app.currentView === item.key"` + `@click="app.setView(item.key as AppView)"`；`NavKey`/`AppView` 对齐。

- [ ] **Step 3: App.vue 视图切换 + settings overlay**

`App.vue`：
- `const app = useAppStore()`。
- 模板：`v-if="app.currentView === 'chat'"` 包既有四区；`v-else-if="app.currentView === 'tasks'"` 显示占位（「任务中心 · 阶段 6 落地」）；`v-else` 渲染 `<CySettingsView @close="app.setView('chat')" />`。
- settings/tasks 时隐藏 CyLive2DPanel 高频渲染（`v-show="layout.effective.live2dShown && app.currentView === 'chat'"`）。

- [ ] **Step 4: CySettingsView（全窗 overlay，布局纪律同 CyHistoryViewer）**

结构：`<div class="cy-settings-overlay">`（`position:fixed; inset:36px 0 0 0; display:flex; justify-content:center; align-items:center;`）→ `.cy-settings`（`display:flex; width:min(920px, 92vw); height:min(640px, 84vh); min-height:0; border-radius:14px; overflow:hidden;`）→ 左侧 `.cy-settings-nav`（`flex:0 0 200px; overflow-y:auto;`，导航项：模型服务[激活]/语音[占位:阶段4-P4-B]/安全与权限[占位:阶段6]/角色与外观[占位:阶段5]/开发与诊断[占位:阶段6]）→ 右侧 `.cy-settings-body`（`flex:1 1 0; min-width:0; overflow-y:auto;` 渲染 `CyModelServicesPane`）。顶部 header 带「设置」标题 + 关闭按钮（Esc 关闭 + 回焦到触发按钮，仿 historyViewer）。

- [ ] **Step 5: CyModelServicesPane（三 tab + 内容）**

- `onMounted(() => { modelStore.load(); modelStore.listVoices() })`。
- 顶部 tab：`llm | stt | tts`（`const tab = ref<ModelServiceType>('llm')`）+ 「添加自定义模型」按钮（打开 CyProfileWizard）。
- 每 tab 渲染：`modelStore.byType(tab)` → 按 `provider` 分组渲染 `<CyProfileCard :profile>`；TTS tab 附加 `<CyTtsVoices>`。
- 错误展示：`v-if="modelStore.error"` 显示 `modelStore.error.message`（PublicError）+ 关闭按钮（清 `modelStore.error`）。

- [ ] **Step 6: CyProfileCard**

props: `profile: ModelProfile`。渲染：displayName、执行位置徽标（`profile.executionLocation === 'backend'` → 「后端」绿标；否则「不可用·待配置」灰标 + `title` 说明）、credentialStatus 点、capabilities 摘要、models 数。按钮：
- 「测试连接」→ `modelStore.testProfile(profile, 'connectivity')`（`testing` 中禁用，显示 spinner）。
- 「可用性测试」→ `modelStore.testProfile(profile, 'usable')`。
- 「设为当前」→ `modelStore.activate(profile)`（仅 `executionLocation==='backend' && enabled`；`activating[type]` 中禁用）。
- 「编辑」「复制」→ 打开 Wizard（复制：`startEdit(profile)` + 改名）。
- 「删除」→ 确认后 `modelStore.deleteProfile(profile)`（仅 custom）。
- 测试结果：`v-if="modelStore.testResult[key]"` 显示 ok/延迟/错误。

- [ ] **Step 7: CyProfileWizard**

表单（`modelStore.drafts['new']` / 编辑 key）：类型（锁/可改）、名称、Endpoint（`baseUrl`，backend 必填，占位 `https://`）、模型 ID（`models` 逗号分隔 → 数组）、apiKey 一次性输入（`<input type="password">`，`@input` 存**组件局部 ref**，不写 store；提交后清空）、capabilities（逗号分隔）、「测试并保存」（先 `testProfile(...,'connectivity', apiKeyRef)` 通过后 `saveProfile(draft, apiKeyRef)`；失败保留表单）、「保存并设为当前」（`makeActive:true`）。安全红线：编辑 custom 回填**不显示**已存密钥（只显示 credentialStatus）。提交成功/失败后 `apiKeyRef = ''`。

- [ ] **Step 8: CyTtsVoices**

`modelStore.voices` 列表（id/name/languages）+ `currentVoice` 高亮 + 「设为当前声音」按钮（`modelStore.setVoice`）+ 「试听」按钮（`modelStore.preview({voiceId})`）→ `<audio v-if="modelStore.preview?.url" :src="modelStore.preview.url" controls autoplay>`。试听是独立操作，不打断当前生成。

- [ ] **Step 9: typecheck + 现有单测回归**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop test`
Expected: 全绿（新增 UI 无独立单测，集成测试在 Task 10）。

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/stores/app.store.ts src/renderer/src/components/CyNavRail.vue src/renderer/src/App.vue src/renderer/src/components/CySettingsView.vue src/renderer/src/components/CyModelServicesPane.vue src/renderer/src/components/CyProfileCard.vue src/renderer/src/components/CyProfileWizard.vue src/renderer/src/components/CyTtsVoices.vue
git commit -m "feat(阶段4 批次A): 设置中心视图框架 + 模型服务页（appStore 视图切换 / Profile 卡片 / 向导 / TTS 试听）"
```

---

### Task 10: 集成测试（IPC mock + 真实 Electron）

**Files:**
- Create: `tests/integration/settings-model-services-ipc.spec.ts`
- Create: `tests/integration/settings-model-services.spec.ts`

**Interfaces:**
- Consumes: `launchApp`/`closeApp`（`tests/integration/helpers/app.ts`）；Task 6/8/9。
- Produces: 集成测试证据（IPC 契约 + UI 布局/点击）。

- [ ] **Step 1: IPC mock 集成测试**

`tests/integration/settings-model-services-ipc.spec.ts`（`page.evaluate` 直调 renderer 的 `window.desktopApi`，仿 `history-viewer-ipc.spec.ts`；**mock 装配下模型方法不要求先 connect**）：

```ts
it('models:list-profiles 返回归一化 Profile（含 custom）', async () => {
  const launched = await launchApp()
  const app = launched.app, page = launched.page
  const out = await page.evaluate(async () => {
    const api = (window as unknown as { desktopApi: { listModelProfiles: (i?: unknown) => Promise<unknown[]>; getActiveModelSelection: () => Promise<Record<string, string | undefined>>; saveModelProfile: (c: unknown) => Promise<unknown>; deleteModelProfile: (s: string, n: string) => Promise<void> } }).desktopApi
    const profiles = await api.listModelProfiles()
    const sel = await api.getActiveModelSelection()
    return { count: profiles.length, sel }
  })
  expect(out.count).toBeGreaterThan(0)
  await page.evaluate(() => (window as unknown as { desktopApi: { saveModelProfile: (c: unknown) => Promise<unknown> } }).desktopApi.saveModelProfile({ type: 'llm', name: 'it-custom', baseUrl: 'https://api.example.com', apiKey: 'k' }))
  // 删除（非激活可删）
  await page.evaluate(() => (window as unknown as { desktopApi: { deleteModelProfile: (s: string, n: string) => Promise<void> } }).desktopApi.deleteModelProfile('llm', 'it-custom'))
  await closeApp(launched)
})
```

> **不要**在 `app.evaluate` 里访问 `desktopApi`——那是 **main 进程**，无 `window.desktopApi` 全局；渲染进程访问必须用 `page.evaluate`。`credentialsSet` 方法不存在（是 `setBackendToken`），且 mock 模型方法无需连接，直接调用即可。

- [ ] **Step 2: 真实 Electron 集成测试**

`tests/integration/settings-model-services.spec.ts`（`launchApp` mock 装配）：

用例（按序）：
1. 打开应用 → NavRail 点「设置」→ `.cy-settings` 出现且 bounding box ⊂ viewport（1184×721）。
2. 「模型服务」页默认 LLM tab → 内置 profile 卡片可见（`deepseek/deepseek-v4-flash`）。
3. 执行位置徽标：backend 卡片显示「后端」，无 desktop/local 卡片（本批 mock 只含 backend）。
4. 点「测试连接」→ 结果区出现 `ok`/延迟（`vi.waitFor` 文本）。
5. 点「设为当前」→ `aria-pressed`/选中态更新（store.active）。
6. 切 TTS tab → 声音列表可见 → 点「试听」→ `<audio>` 出现（mock previewTts 返回 bytes）。
7. 自定义：点「添加自定义模型」→ 向导 → 填名称/Endpoint/apiKey → 「保存」→ 列表出现 `custom/<name>` 卡片 → 再次打开向导编辑，apiKey 输入框为空（不回显）。
8. 删除激活中的 custom → 可见错误：**先**在 `custom/<name>` 卡片点「设为当前」（使 mock `activeSelection` 指向它），**再**点「删除」→ 可见错误（mock `PROFILE_IN_USE`，`s.error?.backendCode`）。
9. 关闭设置（Esc）→ 回 chat 视图且焦点回到「设置」按钮。

- [ ] **Step 3: 运行全部集成测试**

Run: `pnpm -F @cyrene/desktop test:integration`
Expected: 既有 42 用例 + 新用例全绿。

- [ ] **Step 4: Commit**

```bash
git add tests/integration/settings-model-services-ipc.spec.ts tests/integration/settings-model-services.spec.ts
git commit -m "test(阶段4 批次A): 模型服务集成测试（IPC 契约 + 真实 Electron 布局/点击/表单）"
```

---

### Task 11: 文档同步 + 决策记录

**Files:**
- Modify: `docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md`（§19 D-8 第 982/1002 行 + 第 1010 行附近映射表）
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（E-07 行 + §7 阶段 4 批 A + 变更记录）
- Modify: `docs/12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md`（E-07 完成证据）
- Modify: `README.md`、`CLAUDE.md`（状态段）
- Create: `docs/review/2026-08-15-阶段4批次A-决策记录.md`

**Interfaces:**
- Consumes: 本批全部决策（D1/D4 用户敲定 + D-A3~D-A14）。
- Produces: 文档同步 + 决策记录。

- [ ] **Step 1: 决策记录**

`docs/review/2026-08-15-阶段4批次A-决策记录.md`：记录 D1（阶段 4 分两块）/D3（自动朗读归 P4-B）/D4（backend 为主）用户敲定 + 本批 D-A3（ModelProfile 可激活模型级展开）/D-A4（credentialStatus 两态）/D-A5（激活来源=server_info.services + result 帧，无 model.profile.changed wire）/D-A6（凭据一次性）/D-A7（测试两 level）/D-A8（切换只影响新请求）/D-A10（P4-A 不建 settingsStore）/D-A11（试听一次性 media 路由）/D-A14（WS result 帧单 in-flight 关联）+ 文档过时发现记录（D-8 已由后端关闭）。

- [ ] **Step 2: doc 02 §19 更新**

- 第 982 行「输入法转写专用 STT 选择」：由「**无独立字段（待对齐）**：后端 `dictation.start` 仅带 `clientRequestId`」改「**契约已确认（后端 `556117a`）**：`dictation.start.sttProfileId`（`<provider>/<model>`，缺省用全局活动 STT），会话内快照不改全局活动 STT」。
- 第 1002 行 D-8 行：同改，状态改「已确认」。
- 第 1010 行附近「剩余待后端确认项：`dictationSttProfileId`（D-8）」→ 移除或改为「已确认」。
- 同步 §19.1 字段差异表如涉 `dictation.start`。

- [ ] **Step 3: docs 16 / 12 / README / CLAUDE 同步**

- docs 16：E-07 行 `[~]`（契约已确认）；§7 阶段 4 新增「批 A（模型服务 Profile 管理 + TTS 试听）已落地」勾选 + 测试数字（944→新值）+ 状态注「已开发、未联调」；变更记录表追加行。
- docs 12：E-07 完成证据改「转写可经 `dictation.start.sttProfileId` 独立选择兼容 STT Profile」。
- README/CLAUDE：状态段加 P4-A 进度行。

- [ ] **Step 4: 全量验证**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop test && pnpm -F @cyrene/desktop test:integration && pnpm -F @cyrene/desktop check:contract`
Expected: 全绿；记录最终单测/集成计数。

- [ ] **Step 5: Commit**

```bash
git add docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md docs/12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md README.md CLAUDE.md docs/review/2026-08-15-阶段4批次A-决策记录.md
git commit -m "docs(阶段4 批次A): 决策记录 + doc02 D-8/E-07 契约修正 + docs16/12/README/CLAUDE 状态同步"
```

---

## Self-Review 注记（plan 编写时已核对）

- **类型一致性**：`ModelProfile`/`UpsertModelProfileCommand`/`ModelProfileTestCommand`/`ModelProfileTestResult`/`ActivateModelProfileCommand`/`TtsVoice`/`TtsVoiceListResult`/`TtsPreviewCommand`/`TtsPreviewOutcome`/`SetTtsVoiceCommand`/`ActiveModelSelection` 在 Task 1 定义、Task 2 schema、Task 3-5 实现、Task 6 preload、Task 8 store 中签名一致；`previewTts` 在 adapter 层返回 **raw**（含 bytes），`TtsPreviewOutcome` 由 IPC handler 组装——这是对 spec §5.1 的精确化（transport 不依赖 media-service，与现有 attachment 编排一致）。
- **`switch_model_result`/`set_tts_voice_result`**：Task 2 raw 帧 + 事件 schema（`shared/schemas/events.ts`）+ Task 4 handleFrame 特判（pending 匹配）+ frame-mapper emit（store 可订阅）；双路径（resolve pending + emit 事件）已说明。
- **`services` 归一化**：Task 4 `normalizeServices` 从 `Record<string, unknown>` 防御性提取（不直接赋值 `frame.services`）。
- **错误三形状**：Task 4 `resultFrameError`（WS 前缀解析）+ restFetch（ProtocolError code → details.code → executor backendCode 透传）。
- **`event:` 判别字段**：两个新事件用 `event:`（非 `kind:`），并入 `BackendEventSchema` discriminatedUnion——缺事件 schema 会在 preload 丢弃帧。
- **backend-adapter.ts 接口更新**：Task 1 Step 3 连锁说明 + Task 4 Step 3 落实（`testModelProfile(input: ModelProfileTestCommand)`）。
- **store 错误态**：`error`/`voicesError` 为 `PublicError|null`（repo 惯例），UI 渲染 `.message`，测试断言 `s.error?.backendCode`。
- **占位符扫描**：所有 task 的代码均给出实际实现；无 TBD。

---

## 评审修复记录（code-review 一轮，2026-08-15）

plan 经独立 code-review 评审：**0 Critical → 修复 4 Critical / 7 Important / 6 Minor**。关键修复：

| 严重度 | 问题 | 修复 |
|---|---|---|
| Critical | 新事件用 `kind:` 判别，与 `BackendEvent.event`/`discriminatedUnion('event')` 冲突；且无事件 runtime schema → preload 丢弃帧 | Task 1 Step 4 改 `event:`；Task 2 Step 4 加 `SwitchModelResultEventSchema`/`SetTtsVoiceResultEventSchema` 入 `BackendEventSchema` |
| Critical | 删 `TestModelProfileCommand` 后 `backend-adapter.ts` 接口未更新 | Task 1 Step 3 连锁说明 + Task 4 Step 3 落实接口签名更新 |
| Critical | `this.services = frame.services`（`Record<string, unknown>`）无法 typecheck | Task 4 新增 `normalizeServices` 防御性提取 |
| Critical | Task 8 store 错误态 `ref<string>` 与 `parsePublicError` 对象矛盾 | `error`/`voicesError` 改 `PublicError|null`；测试断言改 `s.error?.backendCode` |
| Important | 测试断言 `error.backendCode` 在 real-backend 层不存在（IPC 层才组装） | 改断言 `e.details.code` |
| Important | Task 8 mockApi 缺全量既有方法（`setDesktopApi` 强类型） | 补全既有 vi.fn() 面 |
| Important | Task 7 测试文件/helper 错（`attachment-media.spec.ts` 无 stream；`{} as Request` 崩溃） | 改 `media-service.spec.ts` + `mkService` + 带 header 的 `Request` |
| Important | `putTtsPreview` 用 `this.options.now`（不存在） | 用既有 `this.now()` |
| Important | `makeSafeParse` 幽灵 helper | 逐函数显式 `safeParse` |
| Important | Task 10 `app.evaluate` 访问 `desktopApi`（main 进程无此全局）+ `credentialsSet` 不存在 | 改 `page.evaluate`（renderer）；删 `credentialsSet` |
| Minor | `RealBackendOptions` 无 `switchTimeoutMs` | Task 4 补字段 |
| Minor | Task 6 漏改 `src/main/index.ts`（传 adapter/media） | Files + Step 4 + commit 补上 |
| Minor | mapper `enabled` 恒 true 且 Interfaces 有幽灵 `ServicesWire` | 注明 P4-A 偏差 + 删幽灵参数 |
| Minor | `parseResultFrameError` 命名漂移 | 统一 `resultFrameError` |
| Minor | Task 10 删除前未设当前 | 补「先设为当前」步骤 |
