# Cyrene 阶段4 批次A（P4-A）设计：模型服务 Profile 管理 + TTS 试听 + 设置中心框架

- **日期：** 2026-08-15（Asia/Shanghai）
- **状态：** 设计定稿（待评审）
- **上一批：** [2026-08-15-phase3-rerun2-layout-design.md](./2026-08-15-phase3-rerun2-layout-design.md)（阶段 3，已真实联调通过）
- **前端基线：** `main@4a3a155`；后端对照 `elysia-agent main@556117a`（protocol `2.0`）
- **相关文档：** docs 02（通信协议与数据映射 §19）、docs 06（Store 划分 §3.8 modelServiceStore）、docs 11（设置中心详细设计）、docs 12（分阶段计划 §9.5 阶段 4）、docs 16（阶段执行清单 §7 阶段 4）
- **决策输入：** 用户敲定 D1（阶段 4 分两块）/ D4（执行位置 backend 为主 + 展示不可用态）；D3（TTS 自动朗读）归 P4-B；D2（阶段 5 带占位）另立批次

## 1. 背景与目标

阶段 3 已真实联调通过，阶段 4（模型服务与语音）转为主线。经契约盘点（2026-08-15），阶段 4 的 E-01~E-06/E-08 契约已由后端 `556117a` 全部确认到位：`/api/providers` CRUD + test、`/api/tts/voices` + `/api/tts/preview`、WS `switch_model`/`set_service`/`set_tts_voice`、`server_info.services.{llm,stt,tts}` 能力与当前模型、`voice.*`/`dictation.*` 事件。**E-07 的 D-8 缺口实际已关闭**（`DictationStartMessage` 已带 `sttProfileId` 字段、后端 `start_dictation` 实现会话内 STT 快照），仅前端文档（doc 02 §19 D-8 / doc 16 E-07）过时，本批同步更新。

阶段 4 内容量大（Profile 管理 + 普通录音 + 实时语音会话 + TTS + 输入法转写 + 设置中心），用户敲定**分两块、各自闭环**：

- **P4-A（本批）**：模型服务三类 Profile 管理（内置 + 自定义：查看/新增/编辑/复制/删除/类型化测试/激活切换）+ 一次性凭据提交 + 执行位置展示（backend 可用 / desktop·local_worker 不可用态）+ TTS 声音列表与试听 + 设置中心视图框架。
- **P4-B（下批）**：普通录音 + 实时语音会话 + 输入法转写（含 `dictation.start.sttProfileId` 独立选择）+ TTS 自动朗读（决策 D3：自动朗读 AI 回复、设置可关）+ settingsStore/设置持久化基础设施（D3 开关落点）。

**本批目标：** 在真实 Windows Electron（REAL 模式）上，三类 LLM/STT/TTS Profile 可查看、测试、切换；自定义 Profile 可新增/编辑/复制/删除（密钥只显示配置状态、不回显明文）；TTS 声音可列表与试听；设置中心可从导航进入并展示模型服务页。desktop/local_worker 执行位置展示为「不可用/待配置」态，不提供调用（决策 D4）。

## 2. 范围（做 vs 不做）

### 做

1. **领域契约扩展**（[shared/contracts/model.ts](apps/desktop/src/shared/contracts/model.ts) + [shared/contracts/backend.ts](apps/desktop/src/shared/contracts/backend.ts) + [shared/contracts/ipc.ts](apps/desktop/src/shared/contracts/ipc.ts) + [shared/schemas/](apps/desktop/src/shared/schemas/)）：`ModelProfile` 对齐 doc 02 领域形状；新增 `UpsertModelProfileCommand` / `ModelProfileTestCommand` / `TtsVoice` / `TtsPreviewCommand` / `TtsPreviewOutcome` / `SetTtsVoiceCommand` / `ModelProfileTestResult` 扩展；`ActiveModelSelection` 与 IPC 通道常量。
2. **BackendAdapter 真实实现**（[real-backend.ts](apps/desktop/src/main/transport/real-backend.ts)）：现有 `listModelProfiles`/`testModelProfile`/`activateModelProfile` 由 `notImplemented` 落为真实 REST/WS；新增 `saveModelProfile`/`deleteModelProfile`/`listTtsVoices`/`previewTts`/`setTtsVoice`。握手归一化 `server_info.services` 为当前激活 Profile 选择。`switch_model_result` 更新激活状态。
3. **Mock 扩展**（[mock-backend.ts](apps/desktop/src/main/transport/mock-backend.ts)）：三类内置 Profile + 自定义 Profile 增删改/测试/切换/声音列表/试听/设置声音；分页与 real keyset 语义无关（本批不涉及历史）。
4. **IPC + Preload + schema**：新增 `models:*` / `tts:*` 通道；Preload `desktopApi` 对应方法 + 入参/出参 zod 校验（`createIpcHandler` 双层校验 + `MAX_IPC_MESSAGE_BYTES` 预算）。TTS 试听音频经 Main 解码为可播 URL（参照阶段 3 媒体代理边界，试听不落 Renderer 二进制）。
5. **`modelServiceStore`**（[renderer/src/stores/model-service.store.ts](apps/desktop/src/renderer/src/stores/)，新）：doc 06 §3.8 职责——三类 Profile 列表、激活选择、测试/试听状态、编辑草稿与校验错误、凭据是否已配置；不保存/回显密钥明文。
6. **设置中心视图框架**（App.vue 视图切换 + [CySettingsView.vue](apps/desktop/src/renderer/src/components/) 新 + [CyModelServicesPane.vue](apps/desktop/src/renderer/src/components/) 新 + 子组件）：NavRail「设置」进入全窗覆盖式设置中心（参照 CyHistoryViewer 的 overlay 惯例）；导航按 doc 11 §1 分组；本批实现「模型服务」页（LLM/STT/TTS 三 tab + 自定义 Profile 向导），其余分组显示占位态。
7. **TTS 声音与试听 UI**：声音列表（`/api/tts/voices`，含 `current`）+ 试听按钮（`/api/tts/preview`，固定短文本）+ 设为当前声音（WS `set_tts_voice`）。
8. **文档同步**：doc 02 §19 D-8/E-07 状态修正（`dictation.start` 已带 `sttProfileId`）；doc 12 E-07 完成证据更新；docs 16 阶段 4 批 A 进度与测试数字；README/CLAUDE 状态；本批决策记录。

### 不做

- **不做语音链路**（普通录音/实时会话/转写/TTS 自动朗读）：归 P4-B。doc 11 §2.3 STT 测试麦克风、§2.6 转写专用 STT 选择、§3 语音输入均不在本批。
- **不做 desktop/local_worker 真实调用**（决策 D4）：后端对 desktop/local 条目执行 test/switch 返回 `PROFILE_RUNTIME_NOT_BACKEND`；前端只展示「不可用/待配置」态与原因，不提供测试/激活入口。E-09 Local Worker 不进 Demo（保持 P2）。
- **不做 settingsStore / 设置持久化基础设施**（决策 D-A10）：本批模型服务设置全部是后端状态（providers/switch_model/tts_voice），无本地持久化需求；D3 自动朗读开关等本地设置随 P4-B/阶段 5 引入。设置中心「当前页」不记忆（打开即回「模型服务」）。
- **不做安全策略 / 权限审批历史 / 已授权命令 / Live2D / 字体外观 / 日志开发者模式页面**：doc 11 §4-§8 分别归阶段 6 / 阶段 5 / 后续，本批仅导航占位。
- **不做 `model.profile.changed` wire 事件消费**（决策 D-A5）：后端 `556117a` 无此事件（grep 证实），doc 02 §19 事件表属领域意图。当前激活由 `server_info.services.*.model` 初始化 + `switch_model_result`/`set_tts_voice_result` 更新，不等待/不消费不存在的 wire 事件。
- **不把凭据明文写入任何 Store、普通配置、日志或 IPC 响应**：save 响应 `api_key` 键已被后端剔除（`_strip_secret_keys`）；Renderer 表单提交后立即清空。
- **不改变后端契约**：不改 switch_model 标识格式、不改 providers wire、不新增后端字段。`ModelProfile.id` 直接采用后端 switch 可接受的标识（决策 D-A3），无自定义合成键。

## 3. 契约基础（后端 `556117a` wire，P4-A 消费面）

### 3.1 Provider 管理（REST，[rest.py](apps/desktop/../elysia-agent/frontend_contract/rest.py)）

| 端点 | 请求 | 响应 | 关键语义 |
|---|---|---|---|
| `GET /api/providers` | — | `ProvidersResponse{llm:{name:ProviderEntry}, stt:{...}, tts:{...}, custom:{service:[CustomProvider]}, unconfigured:{service:[UnconfiguredEntry]}}` | provider 名是动态 key；`ProviderEntry{models, credentialConfigured, runtime, capabilities}`；`CustomProvider{name, base_url, api_key_env?, models?, runtime, credentialConfigured, capabilities}`；`UnconfiguredEntry{name, env_vars}` |
| `POST /api/providers` | `{service, entry:{name, base_url?, api_key?, api_key_env?, models?, runtime?, capabilities?}}` | `{ok:true, data:全量 custom 列表}`（api_key 键已剔除） | custom 同名更新幂等；backend 条目 `base_url` 必填 + SSRF；非 backend 带 `api_key` → 400 `PROFILE_INVALID_RUNTIME`；runtime 非法 → 400 `PROFILE_INVALID_RUNTIME` |
| `DELETE /api/providers/{service}/{name}` | — | `{ok:true, data}` / 409 `PROFILE_IN_USE` | 激活中（service_state/model 或 config 以 `custom/{name}` 开头）→ 409 |
| `POST /api/providers/test` | `{service, provider, model, level, base_url?, api_key?, character?}` | `ProviderTestResult{ok, latency_ms?, error?, detail?}` | `level=connectivity\|usable`；base_url 非空一律 SSRF 校验；desktop/local 条目 → 400 `PROFILE_RUNTIME_NOT_BACKEND` |

**前端归一化（决策 D-A3）：** `ModelProfile` 粒度为 **「可激活模型」级展开**，`id` = 后端 switch 可直接接受的 model 标识，无合成键：

- 内置 provider（`{llm,stt,tts}` 的 key）每个 model **展开一条**：`id = "<provider>/<model>"`（如 `deepseek/deepseek-v4-flash`）、`provider = "<provider>"`、`model = "<model>"`、`models = 该 provider 全量模型列表`（UI 分组展示用）；
- custom 条目 **一条**：`id = "custom/<name>"`、`provider = "custom"`、`model = "<name>"`（后端 `resolve_model_params` 只解析 `custom/<name>` 两段，custom 条目的 `models` 列表仅展示、不参与激活标识）、`models = 条目 models 列表`；
- 内置与 custom 的不对称性由后端语义决定，前端归一化如实保留。

`type` 由 service 映射；`source`（built_in/custom）由条目落在 `{llm,stt,tts}`（内置）还是 `custom`（自定义）判定；`executionLocation` = `runtime`；`credentialStatus` = `credentialConfigured ? 'configured' : 'missing'`（`expired` 枚举保留，P4-A 无来源不产出）；`capabilities`/`models` 透传；`enabled` 由 `services.*.enabled`（P4-A 仅展示，不编辑）。

**激活与测试的标识用法：** `switch_model{service, model}` 的 `model` 直接传 `ModelProfile.id`；`POST /api/providers/test` 的 body 是分开的 `{service, provider, model, level}`（后端拼 `f"{provider}/{model}"`，custom 即 `provider="custom", model="<name>"`），故 `ModelProfileTestCommand` 携带 `provider`+`model` 两字段（由 store 从 profile 拆出），而非 `id`。

### 3.2 模型切换（WS v2）

| 帧 | 请求 | 响应 | 语义 |
|---|---|---|---|
| 切换 | `switch_model{service, model, clientRequestId?}` | `switch_model_result{service, model, ok, error?}`（`ok` 必填，成功 `error` 缺省省略） | `model` 即上文 `ModelProfile.id` 格式；切换只影响新请求 |
| 服务开关 | `set_service{service:stt\|tts, enabled}` | `service_mode_result{service, ...}` | 仅 stt/tts，不含 llm（P4-A 不主动调用，仅展示 enabled 态） |
| TTS 声音 | `set_tts_voice{voice, clientRequestId?}` | `set_tts_voice_result{ok, error?, voice?}`（`ok` 必填；成功带 `voice` 回显） | voice 须在活动 TTS 后端 `list_voices()` 内；未知/不可用 → `{ok:false, error}` 不改 state |

**当前激活来源（决策 D-A5）：** `server_info.services.{llm,stt,tts}` = `ServiceCapability{available, enabled, model, default}`。握手时 `model` 归一化为 `ActiveModelSelection.llmProfileId/ttsProfileId/voiceSttProfileId`（P4-A 只消费 llm/tts/voiceStt 三键；dictation 键留 P4-B）；切换后由 `switch_model_result.model` 更新对应键。`available=false` 时 `model` 为显式 null → 激活为未选择。

### 3.3 TTS 声音与试听（REST）

| 端点 | 请求 | 响应 | 语义 |
|---|---|---|---|
| `GET /api/tts/voices` | — | `TtsVoicesResponse{voices:[TtsVoiceEntry], current?, source, error?}` | `TtsVoiceEntry{id, name?, languages?, capabilities?}`；`current` = 活动会话 tts_voice 或后端默认；后端未启用 → 空列表 + `error`（200 不炸）；恒作用于活动会话激活 TTS profile |
| `POST /api/tts/preview` | `{voice_id?}`（后端固定短文本 `_PREVIEW_TEXT`，不读聊天；缺省回退活动会话当前 voice） | `TtsPreviewResult{ok, mime?, audio_base64?, duration_ms?, error?}` | 成功带 base64 音频；失败带 error。注意 wire 字段是 **`voice_id`**（snake_case，后端手写解析未走 ContractModel），前端领域字段用 camelCase 由 real-backend 映射 |

**试听播放（决策 D-A11）：** Main 收到 `TtsPreviewResult` 后把 `audio_base64` 解码为字节。**一次性内存缓存由 MediaService 所有并注入**（`MediaService.putTtsPreview(id, bytes, mime)`；`Map<id, {bytes, mime, createdAt}>`），扩展 media-service 媒体路由为 `attachment | sticker | tts-preview`（复用 `MEDIA_PATH_PREFIX`/`parseMediaPath`/协议注册），`stream('tts-preview', id)` 查缓存流式、未知 id → 404；缓存短 TTL（60s）定时清理（每次 put 顺手清过期项）；返回 `cyrene://renderer/__cyrene-media/tts-preview/{id}`；Renderer `<audio>` 播放；**base64/二进制不落 Renderer store**；试听是独立操作，不打断当前回复生成。

### 3.4 错误码与错误信封（P4-A 消费面）

Profile 族错误码：`PROFILE_IN_USE`（409）/`PROFILE_INVALID_RUNTIME`（400）/`PROFILE_RUNTIME_NOT_BACKEND`（400）/`SSRF_BLOCKED`（400）。**后端有三种错误形状，前端归一化需区分**：

1. **REST ProtocolError**（新错误码，`save/delete/test` 的 400/409）：`{ok:false, code: "<CODE>", error: "<msg>", ...}`（`ProtocolError`）→ IPC `IpcErrorBody{code, backendCode, message}`，`backendCode` 透传。
2. **REST v1 ApiFail**（既有校验路径，如缺 name/base_url 的 400）：`{ok:false, error: "<msg>"}`，无 code → IPC `backendCode` 省略，只带公开 message。
3. **WS result 帧裸错误字符串**（`switch_model_result.error` / `set_tts_voice_result.error`）：后端返回形如 `"PROFILE_RUNTIME_NOT_BACKEND: 该 Profile 由 Electron 执行"` 的 **`"<CODE>: <msg>"` 文本前缀**，无结构化 code。前端 real-backend 需按 `"^([A-Z_]+): (.*)$"` 解析为 `{backendCode, message}`；无前缀（纯描述）则 `backendCode` 省略、整体作 message。

WS result 帧**不是** `ProtocolError` 信封，不套 `createIpcHandler` 的 CyreneError 透传——real-backend 把解析后的 `{backendCode, message}` 抛/返回统一给 IPC 层（见 §5.3 activate 关联）。

### 3.5 WS result 帧关联（无 clientRequestId）

`switch_model_result`/`set_tts_voice_result` **均不带 `clientRequestId`**（`SwitchModelResultMessage{service, model, ok, error?}`；`SetTtsVoiceResultMessage{ok, error?, voice?}`）。关联策略（决策 D-A14）：

- **单服务单 in-flight**：store 每个 service（llm/stt/tts）与 set_tts_voice 各自最多一个在途命令；发起时记录 `{service, model|voice}`，等 result 帧。
- **按回显字段匹配**：result 帧的 `service`+`model`（或 `voice`）与在途记录匹配才更新；**不匹配（迟到/乱序/其他客户端切换）→ 忽略更新、记录该 service 状态需下次 `GET /api/providers`/`listTtsVoices` 重新校准**（不在本批引入重放队列）。
- 同一 result 帧同时携带 `ok:true` 与 `error` 不会发生（成功 `error` 缺省省略）。

## 4. 现状（前端代码证据）

- **BackendAdapter 接口**（[backend-adapter.ts](apps/desktop/src/main/transport/backend-adapter.ts)）已声明 `listModelProfiles`/`testModelProfile`/`activateModelProfile`，real 实现均为 `throw notImplemented(...)`（[real-backend.ts:722-724](apps/desktop/src/main/transport/real-backend.ts#L722-L724)）；mock 有极简占位（固定 1 条 LLM profile、test 恒 ok、activate no-op）。
- **契约类型现状**：`model.ts` 已有 `ModelProfile{id,type,provider,modelId,executionLocation,builtIn,name}` 与 `ModelCredentialInfo`（阶段 2 占位，字段未对齐 doc 02）；`backend.ts` 已有 `TestModelProfileCommand{profileId}`/`ModelProfileTestResult{ok,latencyMs?,error?}`/`ActivateModelProfileCommand{profileId}`/`StartVoiceInputInput`/`StartDictationInput{conversationId, sttProfileId}` 等（P4-A 需扩展对齐）。
- **IPC 现状**：`IpcChannels`（[ipc.ts](apps/desktop/src/shared/contracts/ipc.ts)）无 `models:*`/`tts:*` 通道；注册走 `registerHandler`（[registry.ts](apps/desktop/src/main/ipc/registry.ts)）+ `createIpcHandler`（[executor.ts](apps/desktop/src/main/ipc/executor.ts) 入参/出参双层 zod）；装配在 `handlers.ts`。
- **Preload 现状**：`desktop-api.ts` 暴露具名窄 API；新方法沿 `invokeWithArgs` + 出参 schema 模式。
- **设置中心现状**：NavRail 有「聊天/任务/设置」三按钮，但 `active` 是组件局部 ref（[CyNavRail.vue:7](apps/desktop/src/renderer/src/components/CyNavRail.vue#L7)）；App.vue 四区 grid 无设置视图、无视图切换。
- **Store 现状**：无 `modelServiceStore`/`appStore`（doc 06 §3.1 appStore 的「当前页面」未落地）；layoutStore 已有（G1）。
- **测试基建**：`tests/integration/helpers/app.ts` 支持 `launchApp(opts.env)` 装配 Mock；真实 Electron 布局/点击测试先例 = `history-viewer-layout.spec.ts`（阶段 3 RUN2）；check:contract 覆盖 WS 13/13 + REST 段 8/8。

## 5. 设计

### 5.1 领域契约（shared/contracts/model.ts 重写对齐）

```typescript
export type ModelServiceType = 'llm' | 'stt' | 'tts'
export type ModelExecutionLocation = 'backend' | 'desktop' | 'local_worker'
export type ModelProfileSource = 'built_in' | 'custom'
export type ModelCredentialStatus = 'missing' | 'configured' | 'expired'

export interface ModelProfile {
  id: string                    // 决策 D-A3：可直接 switch 的标识（内置 "<provider>/<model>"，custom "custom/<name>"）
  type: ModelServiceType
  displayName: string           // provider 名（内置）或 custom name
  source: ModelProfileSource
  provider: string              // test body provider 字段（内置名 或 "custom"）
  model: string                 // test body model 字段（内置 model 名 / custom name）
  models: string[]              // 该 provider 全量模型列表（custom 条目展示用）
  executionLocation: ModelExecutionLocation
  credentialStatus: ModelCredentialStatus   // ← credentialConfigured（决策 D-A4）
  enabled: boolean              // ← services.*.enabled（展示用，P4-A 不编辑）
  capabilities: string[]        // ← capabilities 键名展开（稳定排序）
  endpointLabel?: string        // custom base_url 脱敏展示（host 部分）
  builtIn: boolean              // source 快捷派生（兼容既有消费方）
}

export interface UpsertModelProfileCommand {   // doc 02 UpsertCustomModelProfileCommand
  type: ModelServiceType
  name: string                  // custom 条目名（provider 键）
  baseUrl?: string
  apiKey?: string               // 一次性提交：成功/失败后 Renderer 立即清除
  apiKeyEnv?: string
  models?: string[]
  executionLocation?: ModelExecutionLocation  // 缺省 backend；类型允许三值（未来/程序化用），但 P4-A 向导 UI 不发送 desktop/local_worker（§5.4 不可选）——保留 `PROFILE_INVALID_RUNTIME` 校验路径供 mock/契约测试
  capabilities?: string[]
  makeActive?: boolean          // 保存成功后可选立即切换
}

export interface ModelProfileTestCommand {
  service: ModelServiceType
  provider: string              // 内置名 或 'custom'（后端拼 f"{provider}/{model}"）
  model: string                 // 内置 model 名 / custom name
  level: 'connectivity' | 'usable'   // 决策 D-A7：对齐后端两 level
  baseUrl?: string
  apiKey?: string               // 一次性：测试用明文，成功/失败后清除
}

export interface TtsVoice { id: string; name?: string; languages: string[]; capabilities: string[] }
export interface TtsPreviewCommand { voiceId?: string }   // 领域 camelCase；real-backend 映射为 wire {voice_id}
export interface TtsPreviewOutcome { ok: boolean; audioUrl?: string; durationMs?: number; error?: string }  // IPC 结果：Main 已解码 base64 → 一次性 media URL，二进制不下发
export interface SetTtsVoiceCommand { voice: string }

export interface ActiveModelSelection {
  llmProfileId?: string
  voiceSttProfileId?: string
  ttsProfileId?: string
  dictationSttProfileId?: string    // P4-B 消费；P4-A 仅类型占位
}
```

**BackendAdapter 新增/落成方法**（real-backend.ts）：

```typescript
listModelProfiles(type?: ModelServiceType): Promise<ModelProfile[]>   // 落成：GET /api/providers 归一化
testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult>  // 落成：POST /api/providers/test
activateModelProfile(input: ActivateModelProfileCommand): Promise<void>  // 落成：WS switch_model{service, model: input.profileId}；real-backend 注册 pending{service, model}，等 switch_model_result 按 §3.5 匹配后 resolve/reject（ok:false → reject 可见错误），超时（10s）reject
saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile>   // 新：POST /api/providers → 随后 GET /api/providers 取 credentialConfigured（save 响应 data 不含该布尔）→ 归一化 name 匹配条目返回
deleteModelProfile(service: ModelServiceType, name: string): Promise<void>  // 新：DELETE /api/providers/{service}/{name}
listTtsVoices(): Promise<{ voices: TtsVoice[]; current?: string; source: string; error?: string }>  // 新：GET /api/tts/voices
previewTts(input: TtsPreviewCommand): Promise<TtsPreviewOutcome>   // 新：POST /api/tts/preview → Main 解码 base64 → 一次性 media URL
setTtsVoice(input: SetTtsVoiceCommand): Promise<void>             // 新：WS set_tts_voice；等 set_tts_voice_result 按 voice 匹配 resolve/reject，超时（10s）reject
getActiveModelSelection(): ActiveModelSelection                   // 新：从握手 services 归一化
```

- `ModelProfileTestResult` 扩展对齐：`{profileId, service, level, ok, latencyMs?, error?, detail?}`。
- `ActivateModelProfileCommand` 扩展：`{profileId, service}`（`switch_model` 需要 service；由 store 从 profile.type 填）。

### 5.2 IPC 通道与 Preload

```typescript
// IpcChannels 新增
modelsListProfiles: 'models:list-profiles'      // 参 {type?} → ModelProfile[]
modelsSaveProfile: 'models:save-profile'        // 参 UpsertModelProfileCommand → ModelProfile
modelsDeleteProfile: 'models:delete-profile'    // 参 {service, name} → undefined
modelsTestProfile: 'models:test-profile'        // 参 ModelProfileTestCommand → ModelProfileTestResult
modelsActivateProfile: 'models:activate-profile' // 参 {profileId, service} → undefined
modelsGetActiveSelection: 'models:get-active-selection' // 参 无 → ActiveModelSelection
ttsListVoices: 'tts:list-voices'                // 参 无 → {voices, current?, source, error?}
ttsPreview: 'tts:preview'                       // 参 TtsPreviewCommand → TtsPreviewOutcome（audioUrl 一次性）
ttsSetVoice: 'tts:set-voice'                    // 参 SetTtsVoiceCommand → undefined
```

- 每个通道 `requestSchema`/`responseSchema` 落 [main/ipc/channels.ts](apps/desktop/src/main/ipc/channels.ts) + [shared/schemas/](apps/desktop/src/shared/schemas/)；Preload 侧入参/出参 zod 校验同现有模式。
- **试听音频 URL（决策 D-A11，详见 §3.3）**：Main `previewTts` 把 `audio_base64` 解码为字节，存入一次性内存缓存并扩展 media-service 路由为 `tts-preview`，返回 `{audioUrl: "cyrene://renderer/__cyrene-media/tts-preview/{id}"}`；Renderer `<audio>` 播放；缓存短 TTL（60s）过期清理。
- 出参箱预算：`ModelProfile[]`/`TtsVoice[]` 均在 `MAX_IPC_MESSAGE_BYTES` 内（声音/Profile 条数有限）；`tts:preview` 响应的 `audioUrl` 不含二进制。

### 5.3 modelServiceStore（renderer/src/stores/model-service.store.ts）

doc 06 §3.8 职责落地：

```typescript
state: {
  profiles: ModelProfile[]                     // 三类合并，按 type 分组展示
  active: ActiveModelSelection
  voices: TtsVoice[] | null                    // GET /api/tts/voices 结果（TTS tab）
  voiceSource: 'static' | 'api' | null
  currentVoice: string | null                  // voices.current 初始化；set_tts_voice_result.voice 回显更新
  voicesError: string | null                   // 后端未启用等（200 + error 字段）
  loading: boolean
  testing: Record<string, 'idle'|'running'|'ok'|'error'>   // key = profileId|level
  testResult: Record<string, ModelProfileTestResult | undefined>
  previewing: boolean
  preview: { url?: string; error?: string } | null
  saving: boolean
  deleting: boolean
  activating: Record<ModelServiceType, boolean>   // 决策 D-A14：单服务单 in-flight（每 service 至多一个在途 switch）
  error: string | null                          // 当前可见错误（switch/save/delete/test 失败）
  drafts: Record<string, ProfileDraft>          // 自定义 Profile 编辑草稿（不存 apiKey）
  validation: Record<string, string[]>          // 草稿校验错误
}
getters: byType(type), customProfiles(type), activeProfileId(type), voiceList...
actions:
  load()                     // 拉 profile 列表 + 激活选择
  saveProfile(draft, apiKeyInput)  // 一次性提交；成功/失败后清空 apiKeyInput
  deleteProfile(profile)     // 删除保护：PROFILE_IN_USE → error
  testProfile(profile, level, apiKeyInput?)   // 类型化测试
  activate(profile)          // switch_model；成功后更新 active
  listVoices() / preview(voice?) / setVoice(voice)
  startEdit(profile?) / updateDraft / cancelEdit
```

- **草稿（决策 D-A6）**：编辑自定义 Profile 的 `apiKey` 只存在于当前表单组件；store 草稿字段**不含 apiKey**；提交成功或失败后调用方清空输入框。编辑回填**不回显已存密钥**（credentialConfigured 只显示状态）。
- **切换语义（决策 D-A8/D-A14）**：`activate()` 只影响新请求；**单服务单 in-flight**（`activating[service]` 为 true 时忽略同 service 新切换，避免乱序）；等 `switch_model_result` 按回显 `service`+`model` 匹配后更新 `active`（不乐观更新）；`ok:false` 或错误 → 可见错误、`active` 保持原值、不静默回退；result 帧 `service`/`model` 与在途记录不匹配（迟到/其他客户端）→ 忽略更新并标记该 service 需下次 `load()` 校准。
- **声音设置关联（D-A14 同款）**：`setVoice()` 单 in-flight；等 `set_tts_voice_result` 按回显 `voice` 匹配；成功 → `currentVoice = voice`（后端回显）；失败 → 可见错误、`currentVoice` 保持原值。

### 5.4 设置中心视图框架（UI）

- **App.vue 视图切换**：本批引入轻量 `appStore`（对齐 doc 06 §3.1，最小字段 `currentView: 'chat' | 'tasks' | 'settings'`），NavRail `active` 从局部 ref 上提为 `appStore.currentView` 驱动；`chat` = 既有四区布局，`tasks` = 占位视图（阶段 6 工具系统，显示「后续阶段」占位），`settings` = `CySettingsView`（全窗覆盖式 overlay，参照 CyHistoryViewer 的 `.cy-history-overlay` 布局纪律：定高、内部滚动、Esc/关闭按钮）。
- **CySettingsView**：左侧设置导航（doc 11 §1 分组：模型服务 / 语音 / 安全与权限 / 角色与外观 / 开发与诊断），右侧内容区。本批实现「模型服务」子页；其余子页显示「占位：阶段 X 落地」说明。
- **CyModelServicesPane**：三 tab（LLM/STT/TTS）切换 + 「添加自定义模型」按钮。
  - **Profile 卡片（决策 D-A3 展开 + 分组呈现）**：store 里 `ModelProfile` 是「可激活模型」级（内置每 model 一条、custom 一条），UI **按 `provider` 分组卡片**——组头显示 provider 名 + 共享字段（执行位置徽标：backend=可用 / desktop·local_worker=「不可用·待配置」灰标 + tooltip「Desktop/Local Worker 执行位置由本机承载，当前版本不可用」；credentialStatus 点：configured=绿 / missing=灰；capabilities 摘要；custom 显示 endpointLabel），组内**每个 model 行**（内置）或单行（custom）携带自己的「测试连接」「可用性测试」「设为当前」（仅 backend + enabled）「编辑」（仅 custom）「复制」「删除」（仅 custom；激活中删除 → PROFILE_IN_USE 可见错误）。多 model provider 的「设为当前」作用于**所在 model 行**（激活 `该行的 id`），不存在 provider 级模糊激活。
  - **自定义 Profile 向导**（LLM/STT/TTS 共用，按类型显示不同字段）：类型、显示名称、模型 ID（models）、执行位置（backend 可用 / desktop·local_worker 显示不可选）、Endpoint（backend 必填、HTTPS 默认）、apiKey 一次性输入、capabilities、测试、保存、可选「保存并设为当前」。
  - **TTS tab 附加**：声音列表（id/name/languages）选择 + 「设为当前声音」 + 「试听」按钮 + 播放中状态。
- **安全红线**（doc 11 §2.5 + 契约）：Endpoint 输入只读文本展示后端校验结果（SSRF_BLOCKED → 可见错误）；编辑不回填密钥；删除激活中 → 可见错误；测试失败保留表单并给可执行错误。

### 5.5 Mock 扩展

mock-backend.ts 补：三类内置 profile（llm/stt/tts 各 1~2 条，含 models/capabilities/runtime）、`saveModelProfile`（存内存 custom 列表 + 同名更新）、`deleteModelProfile`（激活中抛 `PROFILE_IN_USE`）、`testModelProfile`（connectivity 恒 ok / usable 按 provider 名可控）、`listTtsVoices`（3~4 条 + current）、`previewTts`（返回 `{ok:true, audioUrl: "cyrene://renderer/__cyrene-media/tts-preview/mock-1"}` + mock 内存音频字节供代理流式）、`setTtsVoice`（更新 current + 成功回显 voice）。`activateModelProfile` 更新 mock 激活选择并回 `switch_model_result` 形状。保持与 real 语义同构（错误码/形状一致）。

## 6. 错误处理与安全

- **凭据永不回显**：save 响应后端已剔除 `api_key`；IPC 出参 schema 白名单丢弃未知键；Renderer store/日志不落明文。
- **SSRF 由后端执行**：前端只透传 base_url 并展示 `SSRF_BLOCKED`；前端不做「安全绕过」判定（契约已完成证据在 doc 12 E-04，非本批职责）。
- **删除保护**：`PROFILE_IN_USE` 409 → 可见错误「正在使用，无法删除」；不静默。
- **测试与激活分离**（doc 11 §9）：测试是独立操作，测试失败不影响当前激活；切换只影响新请求。
- **日志脱敏**：模型 Profile 测试/保存失败日志只含 `profileId/service/错误码`，不含 base_url 明文凭据部分、api_key、完整响应。
- **错误信封（§3.4 三形状）**：REST ProtocolError/ApiFail 由 IPC handler 层（`createIpcHandler` → `IpcErrorBody`，backendCode 透传）；WS result 帧错误由 real-backend 解析 `"<CODE>: <msg>"` 前缀后以 `IpcErrorBody` 形式返回给 store（经 pending 关联 reject 或 `parsePublicError` 展示）；Renderer 统一 `parsePublicError` 展示。

## 7. 测试计划

### 7.1 单元测试（Vitest）

1. **Provider 归一化纯函数**（独立模块 [main/transport/providers-mapper.ts](apps/desktop/src/main/transport/providers-mapper.ts) 新，real-backend/mock 共用）：`ProvidersResponse` → `ModelProfile[]`（内置/custom 展开、id=`<provider>/<model>` 或 `custom/<name>`、credentialStatus、capabilities 排序、desktop/local 条目标记）；空/缺省/`available=false` 边界。
2. **schema**：`UpsertModelProfileCommand`/`ModelProfileTestCommand`/`SetTtsVoiceCommand` 入参校验（缺失/超长/非法 runtime/非法 level）；出参 schema 白名单。
3. **modelServiceStore**（mock desktopApi）：load/save（apiKey 不入 store）/delete（PROFILE_IN_USE 错误）/test（connectivity/usable）/activate（成功更新 active；失败保留）/listVoices/preview/setVoice；drafts 不含 apiKey。
4. **mock 扩展**：save 同名更新幂等、delete 激活中抛错、voices 列表/current、preview 可控。

### 7.2 集成测试（Vitest + real adapter fixture / Electron）

1. **check:contract 扩展**：`GET /api/providers` / `POST /api/providers` / `DELETE /api/providers/{service}/{name}` / `POST /api/providers/test` / `GET /api/tts/voices` / `POST /api/tts/preview` 的契约 TS 侧 schema 与 wire 对齐（跨仓 REST 段）。
2. **IPC 集成**（launchApp mock）：`models:list-profiles` 返回归一化列表；`models:save-profile`（含 apiKey 一次性提交，响应无密钥）；`models:delete-profile` PROFILE_IN_USE；`tts:list-voices`/`tts:set-voice`；`tts:preview` 返回 audioUrl。
3. **真实 Electron 集成**（新 `tests/integration/settings-model-services.spec.ts`）：打开应用 → 点 NavRail「设置」→ 设置中心出现 → 「模型服务」页三 tab → 内置 Profile 卡片可见 → 执行位置徽标（backend 可用/desktop·local 不可用态）→ 「测试连接」出结果 → 「设为当前」成功后 active 更新 → TTS 声音列表 + 试听 → 自定义 Profile 新增（表单提交后 apiKey 输入框清空）→ 删除激活中 Profile 出可见错误。布局断言：设置中心面板完整在视口内、内容区内部滚动。

## 8. 验收清单（对齐 doc 11 §10 / doc 16 §7 子集）

- [ ] LLM、STT、TTS 三类 Profile 可查看（列表 + 能力摘要 + 凭据状态 + 执行位置），内置与自定义来源区分；
- [ ] 三类自定义 Profile 可新增、编辑、复制、删除；编辑不回填密钥；删除激活中 → 可见 `PROFILE_IN_USE` 错误；
- [ ] 类型化测试（连接/可用性）可执行，结果含延迟与错误；测试失败保留表单；
- [ ] 「设为当前」可切换 backend Profile；切换失败可见错误、只影响新请求；
- [ ] 密钥只显示配置状态，不回显明文；save/test 后表单 apiKey 清空；
- [ ] desktop/local_worker 执行位置展示「不可用·待配置」态，不提供测试/激活；
- [ ] TTS 声音可列表、试听（固定短文本）、设为当前声音；
- [ ] 设置中心可从导航进入、面板完整在窗口内内部滚动、其余分组显示占位；
- [ ] 944 单测（83 files）+ 42 集成（11 files）基础上全部通过；typecheck/lint/build 全绿。

## 9. 文档同步清单

- **doc 02 §19 D-8 / doc 16 E-07**：`dictation.start` 已带 `sttProfileId` 字段（`<provider>/<model>`、缺省用全局活动 STT），会话内快照不改全局活动 STT——由「待决策」改「契约已确认（后端 `556117a`）」；doc 02 第 982/1002 行对齐表同改。
- **doc 12 E-07 完成证据**：改为「转写可经 `dictation.start.sttProfileId` 独立选择兼容 STT Profile」。
- **docs 16 §7 阶段 4**：批 A 任务勾选 + 测试数字 + 状态注（本批 Mock 驱动标「已开发、未联调」，真实 Windows 联调是验收方）。
- **README / CLAUDE.md**：当前状态段新增 P4-A 进度行。
- **决策记录**：`docs/review/2026-08-15-阶段4批次A-决策记录.md`（D1/D4 用户敲定 + D-A3~D-A12 本批推荐决策 + 文档过时发现记录）。

## 10. 风险与边界

- **switch_model 失败语义**：`switch_model_result` 成功带 `ok:true`、`error` 缺省省略；失败带 `error`；store 必须等 result 帧（按 §3.5/D-A14 关联）才更新 active（不能乐观更新）。
- **试听音频清理**：临时媒体文件需短 TTL 或播放完清理，避免累积（参照 media-service 过期策略）。
- **Profile 数量**：真实 provider 列表规模未知；UI 卡片不做虚拟滚动（YAGNI，条数有限），内容区内部滚动即可。
- **本批不触碰语音**：P4-B 会新增 voiceStore/麦克风/转写，本批 modelServiceStore 不预留语音字段（避免超前设计）。
