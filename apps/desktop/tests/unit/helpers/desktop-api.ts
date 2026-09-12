// tests/unit/helpers/desktop-api.ts
// I-06 / P2-10（2026-09-11 全量前端评审）：类型真实的 desktop API mock 工厂。
//
// 问题（评审原文 §P2-10）：40 个组件 spec 手搓 `setDesktopApi({...} as never)`，其中 39 个用
// **无校验 cast** 送进去。那个 cast 抹掉了唯一能发现「mock 与 DesktopApiLike 漂移」的机制：
// preload 面在一个阶段内从 74 键涨到 93 键；一旦某方法被重命名/移除，mock 会静默继续提供一个
// **已不存在**的方法，而 spec 照样全绿——门禁的保护意义归零。
//
// 本模块把 mock 的构造变成**受检**的：
//   1. 不传参时返回值覆盖 DesktopApiLike 的**每一个键**（类型层面由 `DesktopApiMock` 的 `-?` 保证，
//      漏一个键就是编译错误），因此 spec 不必再手搓整张键表——那正是漂移的温床；
//   2. `overrides` 的**键**被约束为 `keyof DesktopApiLike`——写不存在的键**编译报错**；
//   3. `overrides` 的**值**被约束为对应方法的完整签名（参数与返回类型双向检查）——写错**编译报错**；
//   4. 全程无 `as never` / `as any` / `as unknown as` 逃生口。
//
// 判别力探针（迁移时实测，逐条对应上面的 3）：
//     createDesktopApiMock({ getCredentialStatusTypo: async () => 1 })
//     //  error TS2322: Type '() => Promise<number>' is not assignable to type 'undefined'.
//     //  （该键不存在 → 映射为 never，`undefined` 是它在报错里的显示形态）
//     createDesktopApiMock({ previewTts: vi.fn(async () => ({ nope: true })) })
//     //  error TS2322: Property 'ok' is missing in type '{ nope: boolean; }'
//     //              but required in type 'TtsPreviewOutcome'.
//
// 默认值纪律——「无害且可用」，且**偏向空**：
//   - 读方法返回空集合 / 中性状态，**不是**「像样的假数据」：spec 若需要数据必须自己 override，
//     否则断言必然失败。默认值不得替 spec 说话（否则就是变相放宽断言）；
//   - 写方法返回 resolved Promise；
//   - 订阅方法返回 no-op unsubscribe（组件 unmount 时调用它不能炸）；
//   - 所有默认值都是 vi.fn，因此 `expect(api.foo).toHaveBeenCalledWith(...)` 照常可用。
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { DesktopApiLike } from '../../../src/renderer/src/stores/desktop-api.types'
import type { SettingsState, CharacterSummary, CharacterDetail, CharacterPublicState, ConnectionState } from '@shared/contracts'

/**
 * DesktopApiLike 的每个方法 → vitest mock。
 *
 * `-?` 是刻意的：把可选方法（`getMe?` … `deleteCharacterDraft?`）也变成必填，
 * 于是「默认值覆盖每一个键」成为编译期保证，而不是靠人记得补。
 *
 * 这里刻意**不**在 mock 的类型参数上钉住方法签名（`Mock<(...args: A) => R>`）：那样
 * 裸 `vi.fn()`（= `Mock<Constructable | Procedure>`）会因为构造签名而不可赋值，
 * 逼 30 个既有 spec 改写 stub 形状——那是把重构变成行为改动。签名校验由下面的
 * `DesktopApiOverrides<O>` 在**调用处**完成（见该类型的说明）。
 */
export type DesktopApiMock = {
  [K in keyof DesktopApiLike]-?: NonNullable<DesktopApiLike[K]> extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : never
}

/**
 * overrides 的受检形态——本 helper 判别力的来源：
 *   - **键**：`[K in keyof O]` 只枚举 O 自身出现的键，而整体约束 `O extends DesktopApiOverrides<O>`
 *     要求这些键都能在 DesktopApiLike 里找到；写不存在的键 → 该键被映射成 `never` → **编译失败**。
 *   - **值**：交叉 `Partial<DesktopApiLike>` 让「真实键 + 错误签名」也编译失败
 *     （实测：`vi.fn(async () => 12345)` 报 TS2322 并**把真实签名写进报错里**）。
 *
 * **实测更正（2026-09-12，迁移时被证伪的初版注释）**：
 *   ① 初版曾断言「裸 `vi.fn()` 不可赋值给具体签名，是全量迁移的真实阻塞点」——**该诊断已被后续实测
 *      推翻**。`Mock<Procedure | Constructable>` 的调用签名是 `(...args: any[]) => any`，对具体签名
 *      **是可赋值的**：`createDesktopApiMock({ settingsLoad: vi.fn(), settingsSave: vi.fn(),
 *      listLive2dModels: vi.fn(), readLive2dModelFile: vi.fn() })`（live2d-pane / live2d-panel）与
 *      `{ setTtsVoice: vi.fn() }`（cy-tts-voices，迁移前就在仓库里）都通过了约束。
 *      当初那 11 个文件「迁不过去」的真因是**返回类型坍缩**（`createDesktopApiMock()` 的返回类型里
 *      mock 方法消失，`.mockResolvedValue` 报 TS2339），与 override 的值无关——见函数末尾的注释。
 *      推论：裸 mock 的 spec **可以直接**迁进来（键仍受检）；但裸 mock 会让
 *      `toHaveBeenCalledWith(...)` 的实参检查静默失效（形参列表为空 ⇒ 期望值不受检），
 *      故迁移时仍应尽量给探针型 mock 写真实签名（`vi.fn<NonNullable<DesktopApiLike['x']>>()`）。
 *   ② 试图用 `| ReturnType<typeof vi.fn>` 显式放行裸 mock 会适得其反：那会让每个键推断成联合类型，
 *      参数约束 `O extends DesktopApiOverrides<O>` 随之失败，错误数反而从 32 涨到 42（实测）。
 */
type DesktopApiOverrides<O> = Partial<{
  [K in keyof O]: K extends keyof DesktopApiLike ? DesktopApiLike[K] : never
}> & Partial<DesktopApiLike>

/** 空订阅：组件 unmount 时调用的 unsubscribe 不能炸 */
const noopUnsubscribe = (): (() => void) => () => {}

/**
 * 带**真实签名**的单个 mock：`typedMock<'listCharacters'>(async () => …)`。
 *
 * 为什么需要它（2026-09-12 迁移组件域时实测）：`DesktopApiLike` 里有一批**可选**方法
 * （`listCharacters?` / `getCharacterDraft?` / `updateMe?` …），其类型是 `F | undefined` 联合。
 * 裸 `vi.fn()`（`Mock<Constructable | Procedure>`）**不能**赋给这类联合（但对**必填**方法可以——
 * 所以 `{ settingsLoad: vi.fn() }` 能过而 `{ listCharacters: vi.fn() }` 不能，这条差异是实测出来的，
 * 不是推测）。另外显式给出参数/返回类型还能顺带消除字面量拓宽：
 *     vi.fn(async () => ({ ephemeral: true, reply: '预览' }))   // 推断成 { ephemeral: boolean } ⇒ 不满足契约
 *     typedMock<'previewCharacter'>(async () => ({ ephemeral: true, reply: '预览' }))   // 上下文类型 ⇒ 保持 true
 *
 * 实现里那一处 `as` 是刻意的：`vi.fn(impl)` 无法被 TS 证明等于 `Mock<NonNullable<DesktopApiLike[K]>>`
 * （泛型条件类型），而**调用方**的类型仍由参数与返回标注钉死，判别力不受影响。
 */
export function typedMock<K extends keyof DesktopApiLike>(
  impl?: NonNullable<DesktopApiLike[K]>
): Mock<NonNullable<DesktopApiLike[K]>> {
  return vi.fn(impl) as Mock<NonNullable<DesktopApiLike[K]>>
}

// —— 少量「结构较深」实体的一次性空值（默认值只能有一个来源，否则又变成各处手搓）——
/** 中性的用户档案：identity 面 spec 需要数据时必须自己 override */
export const desktopApiUserIdentity = {
  userId: '', displayName: '', locale: '', timezone: '', initialized: false, revision: 0,
  createdAt: '', updatedAt: ''
}

const characterSummary: CharacterSummary = {
  characterId: '', source: 'builtin', mutable: false, status: 'active',
  currentRevision: 0, displayName: '', description: '', aliases: [], presentation: {}, updatedAt: ''
}

const characterDetail: CharacterDetail = {
  summary: {
    characterId: '', source: 'builtin', mutable: false, status: 'active', currentRevision: 0,
    displayName: '', description: '', aliases: [], presentation: {}, updatedAt: ''
  },
  current: {
    characterId: '', revision: 0, schemaVersion: 0, displayName: '', description: '', aliases: [],
    promptProfile: {
      corePersonality: '', relationshipStyle: '', emotionStyle: '', speakingStyle: '',
      conversationInitiative: '', examples: []
    },
    runtimeDefaults: {
      voice: {}, emotion: { idleExpressions: [] }, wakeWords: [],
      proactive: { enabled: false, intervalSeconds: 0, triggers: [] }
    },
    presentation: {}, checksum: '', compilerVersion: 0, createdBy: 'system', createdAt: ''
  }
}

const characterPublicState: CharacterPublicState = {
  characterId: '', characterInstanceId: '', characterRevision: 0, stateVersion: 0,
  proactiveEnabled: false, updatedAt: ''
}

const settingsState = {
  version: 1,
  voice: {
    enabled: false, realtimeEnabled: false, autoReadReply: false, showCaptions: false,
    consentBackendStt: false
  },
  dictation: { insertMode: 'append' },
  live2d: {
    enabled: false, modelId: null, scale: 1, offsetX: 0, offsetY: 0, mouseTracking: false,
    autoMotions: false, lipSync: false, performanceMode: 'auto', reduceMotion: false
  },
  tools: { grants: [] }
} satisfies SettingsState

/** 默认实现表：键集必须与 DesktopApiLike 完全一致（`DesktopApiMock` 的 `-?` 使遗漏立即报错）。 */
function defaults(): DesktopApiMock {
  return {
    // —— 凭据/连接装配 ——
    getCredentialStatus: vi.fn(async () => 'empty'),
    setBackendToken: vi.fn(async () => 'empty'),
    clearBackendToken: vi.fn(async () => 'empty'),
    setEndpoint: vi.fn(async () => ({ endpoint: '' })),
    getEndpoint: vi.fn(async () => ({})),
    getRuntimeInfo: vi.fn(async () => ({ mode: 'real', packaged: false })),
    connect: vi.fn(async () => ({ sessionId: '', protocolVersion: '', serverUrl: '' })),
    disconnect: vi.fn(async () => {}),
    listConversations: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    send: vi.fn(async () => ({ clientRequestId: '', serverMessageId: '' })),
    cancel: vi.fn(async () => {}),
    activate: vi.fn(async () => ({ conversationId: '' })),
    createConversation: vi.fn(async () => ({ id: '', title: '', updatedAt: '' })),
    renameConversation: vi.fn(async () => ({ id: '', title: '', updatedAt: '' })),
    deleteConversation: vi.fn(async () => {}),
    getConnectionState: vi.fn(async (): Promise<ConnectionState> => ({ status: 'disconnected' })),
    // —— 多角色角色面 ——
    getMe: vi.fn(async () => desktopApiUserIdentity),
    updateMe: vi.fn(async () => desktopApiUserIdentity),
    listCharacters: vi.fn(async () => ({ items: [], hasMore: false })),
    getCharacter: vi.fn(async () => characterDetail),
    listCharacterRevisions: vi.fn(async () => ({ items: [], hasMore: false })),
    getCharacterState: vi.fn(async () => characterPublicState),
    resetCharacterEvolution: vi.fn(async () => ({ state: characterPublicState, resetFields: [] })),
    createCharacter: vi.fn(async () => characterDetail),
    updateCharacter: vi.fn(async () => ({
      character: characterDetail,
      stateImpact: { statePolicy: 'preserve', affectedInstances: 0, pendingInstances: 0, resetFields: [] }
    })),
    cloneCharacter: vi.fn(async () => characterDetail),
    archiveCharacter: vi.fn(async () => ({ character: characterSummary })),
    rollbackCharacter: vi.fn(async () => ({
      character: characterDetail,
      stateImpact: { statePolicy: 'preserve', affectedInstances: 0, pendingInstances: 0, resetFields: [] }
    })),
    validateCharacter: vi.fn(async () => ({ valid: true, issues: [] })),
    previewCharacter: vi.fn(async () => ({ ephemeral: true, reply: '' })),
    // —— FE-D2：未提交角色编辑草稿 ——
    listCharacterDrafts: vi.fn(async () => []),
    getCharacterDraft: vi.fn(async () => undefined),
    saveCharacterDraft: vi.fn(async () => {}),
    deleteCharacterDraft: vi.fn(async () => {}),
    // —— 阶段 3 G4 历史查看器/表情面 ——
    queryChatHistory: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessageContext: vi.fn(async () => ({ items: [], hasMore: false })),
    listStickers: vi.fn(async () => ({ stickers: [] })),
    onChatEvent: vi.fn(() => noopUnsubscribe()),
    onChatState: vi.fn(() => noopUnsubscribe()),
    onChatReplay: vi.fn(() => noopUnsubscribe()),
    onChatError: vi.fn(() => noopUnsubscribe()),
    // —— 阶段 3 G2 持久化面 ——
    hydratePersistence: vi.fn(async () => ({
      drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {}
    })),
    persistSession: vi.fn(async () => ({})),
    cacheMessages: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    // —— 阶段 3 G3 attachments 面 ——
    attachmentsValidate: vi.fn(async () => []),
    attachmentsUpload: vi.fn(async () => ({ uploadId: '', attachments: [] })),
    attachmentsCancel: vi.fn(async () => {}),
    attachmentsCheck: vi.fn(async () => ({ status: 'not_found' as const })),
    // —— 阶段 4 批次 A 模型服务/TTS 面 ——
    listModelProfiles: vi.fn(async () => []),
    saveModelProfile: vi.fn(async () => ({
      id: '', type: 'llm', displayName: '', source: 'built_in', provider: '', model: '',
      models: [], executionLocation: 'backend', credentialStatus: 'missing', enabled: false,
      capabilities: [], builtIn: false
    })),
    deleteModelProfile: vi.fn(async () => {}),
    testModelProfile: vi.fn(async () => ({
      profileId: '', service: 'llm', level: 'connectivity', ok: false
    })),
    activateModelProfile: vi.fn(async () => {}),
    getActiveModelSelection: vi.fn(async () => ({})),
    listTtsVoices: vi.fn(async () => ({ voices: [], source: 'static' })),
    previewTts: vi.fn(async () => ({ ok: false })),
    setTtsVoice: vi.fn(async () => {}),
    // —— 阶段 4 批次 B 语音面 ——
    voiceStartRecord: vi.fn(async () => ({ recordingId: '' })),
    voiceStopRecord: vi.fn(async () => {}),
    voiceCommit: vi.fn(async () => ({ clientRequestId: '', serverMessageId: '' })),
    voiceDiscard: vi.fn(async () => {}),
    voiceStartRealtime: vi.fn(async () => ({ sessionId: '' })),
    voiceStopRealtime: vi.fn(async () => {}),
    voiceCancelRealtime: vi.fn(async () => {}),
    voiceStartDictation: vi.fn(async () => ({ clientRequestId: '' })),
    voiceStopDictation: vi.fn(async () => {}),
    voiceCancelDictation: vi.fn(async () => {}),
    audioCancel: vi.fn(async () => {}),
    voiceSendAudio: vi.fn(() => {}),
    // —— 阶段 4 批次 B 设置面 ——
    settingsLoad: vi.fn(async () => settingsState),
    settingsSave: vi.fn(async () => settingsState),
    // —— 阶段 5 批次 A Live2D 面 ——
    listLive2dModels: vi.fn(async () => []),
    readLive2dModelFile: vi.fn(async () => ({ ok: false as const, status: 404 })),
    // —— 阶段 6 批次 B 工具面 ——
    onToolEvent: vi.fn(() => noopUnsubscribe()),
    toolDecide: vi.fn(async () => {}),
    toolCancel: vi.fn(async () => {}),
    toolList: vi.fn(async () => []),
    toolPickSource: vi.fn(async () => {}),
    toolConfirmUpload: vi.fn(async () => {}),
    // —— 阶段 6 批次 C 目录授权/审批历史面 ——
    toolGrantDirectory: vi.fn(async () => ({ executed: false })),
    toolListGrants: vi.fn(async () => []),
    toolRevokeGrant: vi.fn(async () => {}),
    toolListHistory: vi.fn(async () => []),
    // —— 阶段 7 批次 A（Task 5）：诊断面 ——
    diagnosticsState: vi.fn(async () => ({
      devMode: false, displayDir: '', logSizeBytes: 0, logFiles: [], retentionDays: 0,
      auditRetentionDays: 0, eventDropped: 0, lastCleanup: null
    })),
    diagnosticsDevModeSet: vi.fn(async () => {}),
    diagnosticsOpenLogDir: vi.fn(async () => {}),
    diagnosticsClearLogs: vi.fn(async () => {}),
    diagnosticsExport: vi.fn(async () => ({ cancelled: true as const })),
    onDiagnosticsDevEvent: vi.fn(() => noopUnsubscribe()),
    // —— 阶段 7 批次 B（Task 1）：Renderer 崩溃 marker ——
    getLastCrash: vi.fn(async () => null),
    // —— 2026-09-11（H-04）：退出前持久化 flush 契约 ——
    onPersistFlushRequest: vi.fn(() => noopUnsubscribe()),
    persistFlushDone: vi.fn(async () => {})
  }
}

/**
 * 构造一个**类型真实**的 desktop API mock：默认覆盖 DesktopApiLike 的每一个键，
 * 只需给出本 spec 真正关心的那几个 overrides。
 *
 * 写不存在的键或写错签名都是编译错误——这正是本 helper 相对 `setDesktopApi({...} as never)` 的价值。
 *
 * **实测更正（2026-09-12，迁移 store 域时发现的两条）**：
 *   ① `O` 原本没有默认类型实参，无参调用会让 `O` 退化成约束 `Partial<DesktopApiLike>`；但**加了
 *      默认值也没用**——真正的原因是**展开本身**：`{...defaults(), ...overrides}` 对每个键推断出
 *      联合 `Mock<签名> | 签名`，而 `Mock<签名>` 可赋值给 `签名`，于是联合被**子类型归约**坍缩成
 *      裸 `签名`，mock 方法随之消失（探针实测：无参、`{}`、带 override 三种调用**全部**如此）：
 *          createDesktopApiMock().connect.mockResolvedValue(...)
 *          //  error TS2339: Property 'mockResolvedValue' does not exist on type '() => Promise<BackendSession>'.
 *      此前 5 个迁移点都只对**自己传入的局部 mock 变量**断言，从未在返回对象上调用 mock 方法，
 *      所以这条路径一直没被走到。
 *   ② 修法不能是 `as DesktopApiMock & O`：override 允许传**普通函数**（如 `activate: async () => …`），
 *      而 `DesktopApiMock & O` 会声称它也有 `mockResolvedValue` —— 那是把编译错误换成运行时陷阱。
 *      故返回类型如实写成 `Omit<DesktopApiMock, keyof O> & O`：**被 override 的键保持调用者给的类型，
 *      其余键保持完整的 `Mock<签名>`**。这正是 `{...defaults(), ...overrides}` 的真实语义。
 *      （`O` 的默认值必须是 `{}` 而非 `Record<string, never>`：后者的 `keyof` 是 `string`，
 *      会把 `Omit` 削成空对象。）
 *
 * @example
 * const previewTts = vi.fn(async () => ({ ok: true, audioUrl: 'cyrene://x' }))
 * setDesktopApi(createDesktopApiMock({ previewTts }))
 */
export function createDesktopApiMock(): DesktopApiMock
export function createDesktopApiMock<O extends DesktopApiOverrides<O>>(
  overrides: O
): Omit<DesktopApiMock, keyof O> & O
export function createDesktopApiMock(overrides?: object): object {
  // 实现签名（对外不可见）只需自证「返回一个对象」。**返回类型标注必须存在**：不写的话 TS 推断出的
  // 就是上面①里被归约过的展开类型，mock 方法静默消失；而写成 `DesktopApiMock & O` 又是不诚实的
  // （见②）。故用重载：调用方看到的返回类型是精确的 `Omit<DesktopApiMock, keyof O> & O`，
  // 无需任何 `as`。三个重载的判别力与原先完全相同，键/值校验仍在**参数**上（调用处报 TS2322）。
  return { ...defaults(), ...overrides }
}
