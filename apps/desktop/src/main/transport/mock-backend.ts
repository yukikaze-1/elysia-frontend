import type {
  ActivateConversationResult,
  ActivateModelProfileCommand,
  BackendSession,
  CancelGenerationInput,
  ChatHistoryItem,
  ChatHistoryPage,
  ChatHistoryQuery,
  ConnectInput,
  ConnectionState,
  ConversationDetail,
  ConversationMessagesQuery,
  GetConversationQuery,
  HistoryCategory,
  MessageContextQuery,
  MessagePage,
  ModelProfileTestResult,
  ToolResult
} from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { ClientRequestRef, Message, SendMessageInput } from '@shared/contracts/message'
import type {
  ActiveModelSelection,
  ModelExecutionLocation,
  ModelProfile,
  ModelProfileTestCommand,
  ModelServiceType,
  SetTtsVoiceCommand,
  TtsPreviewCommand,
  TtsVoiceListResult,
  UpsertModelProfileCommand
} from '@shared/contracts/model'
import type { StickerManifest } from '@shared/contracts/sticker'
import type {
  AudioCancelInput,
  DictationStartInput,
  DictationStopInput,
  DictationFinalEvent,
  DictationPartialEvent,
  DictationCancelledEvent,
  RealtimeVoiceControlInput,
  RealtimeVoiceStartInput,
  VoiceCommitInput,
  VoiceDiscardInput,
  VoiceInputMode,
  VoiceRecordStartInput,
  VoiceRecordStopInput,
  VoiceTranscriptEvent,
  VoiceSessionStartedEvent,
  VoiceSessionPartialEvent,
  VoiceSessionTurnEvent,
  VoiceSessionEndedEvent,
  AudioSessionStartedEvent,
  AudioSessionReadyEvent,
  AudioSessionCancelledEvent,
  VoiceErrorEvent
} from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { parseBackendEvent } from '@shared/schemas'
import { isoToLocalDate } from '@shared/domain'
import type { BackendAdapter, BackendEventHandler, UploadContent } from './backend-adapter'
import type { AttachmentInfo, AttachmentSignResult } from '@shared/contracts/attachments'
import fixtureRaw from '../fixtures/domain/streaming-reply.jsonl?raw'

/** 上传 MIME → kind 提示值（Mock 确定性；真实后端以魔数真值为准） */
function kindFromMimeForMock(mime: string): string {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

/** 最小合法 WAV（44 字节头 + 0.125s 静音 PCM16/单声道/8kHz）：
 *  P4-A final review——旧 4 字节 "RIFF" 不是合法 WAV，<audio> 解码失败；试听预览需可播放的确定性字节。 */
function makeSilentWav(): Uint8Array {
  const sampleRate = 8000
  const numChannels = 1
  const bitsPerSample = 16
  const dataSize = sampleRate / 8 // 0.125s 静音 = 1000 samples
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const w = (offset: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numChannels, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, (sampleRate * numChannels * bitsPerSample) / 8, true)
  v.setUint16(32, (numChannels * bitsPerSample) / 8, true); v.setUint16(34, bitsPerSample, true)
  w(36, 'data'); v.setUint32(40, dataSize, true)
  return new Uint8Array(buf) // samples 零初始化 → 静音
}

/** CYRENE_MOCK_HISTORY_LARGE env → seedHistoryCount：undefined/空串→undefined（不开）；
 *  正整数→原值；0/负数/NaN/非整数→120（「大」语义兜底，不允许空 seed，spec §4.3.1） */
export function parseMockHistoryCountEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  if (Number.isInteger(n) && n > 0) return n
  return 120
}

export interface MockBackendOptions {
  /** 每个事件的触发间隔(毫秒) */
  emitDelayMs?: number
  /** 覆盖内置夹具(测试用) */
  fixtureRaw?: string
  /** 连接状态变化回调(connect/disconnect 时触发) */
  onConnectionStateChange?: (state: ConnectionState) => void
  /** 唯一 ID 工厂（测试确定性）：默认实例内单调计数器+时间前缀（禁裸 Date.now 同 ms 碰撞） */
  idFactory?: () => string
  /** 时钟（测试确定性）：默认 new Date() */
  now?: () => Date
  /** 大 seed：设置时 seedMessages() 返回确定性合成历史（spec §4.3.1）；默认 undefined 保持 5 条 */
  seedHistoryCount?: number
  /** 语音错误注入（P4-B Mock）：设置时各语音 start* 方法 emit `voice.error` 而非继续（测错误路由） */
  voiceError?: { code: string; message?: string }
  /** 普通录音转写文本（P4-B Mock）：stopRecordVoice 缺省 `'这是一段测试录音的转写文本'`；显式空串测「未识别」（stop 不发 transcript） */
  voiceTranscriptText?: string
}

const MOCK_SESSION: BackendSession = {
  sessionId: 'mock-session-1',
  protocolVersion: '0.1',
  serverUrl: 'mock://local'
}

/** 默认会话模板：与旧模块级 MOCK_CONVERSATIONS 完全一致（conv-1001 首位），每次调用返回全新数组 */
function createMockConversations(): Conversation[] {
  return [
    { id: 'conv-1001', title: '流式回复演示', updatedAt: '2026-08-08T08:00:00.000Z', preview: '好的，我来回答…' },
    { id: 'conv-1002', title: '历史会话示例', updatedAt: '2026-08-07T10:30:00.000Z' }
  ]
}

/**
 * Mock Backend:按夹具回放流式事件,用于阶段 0 UI 与测试。
 * 真实后端协议未联调前,一切经 Mock 的任务标记为"已开发、未联调"。
 */
export class MockBackend implements BackendAdapter {
  private handler?: BackendEventHandler
  private connected = false
  private readonly fixture: BackendEvent[]
  private readonly emitDelayMs: number
  private readonly onConnectionStateChange?: (state: ConnectionState) => void
  private readonly idFactory: () => string
  private readonly now: () => Date
  private readonly conversations: Conversation[] = createMockConversations()
  private activeConversationId?: string
  private generationTimers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private idCounter = 0
  /** 大 seed 条数（构造体内先于 messageRecords 赋值，seedMessages() 才能读到；spec §4.3.1） */
  private readonly seedHistoryCount: number
  /** P4-B 语音选项：voiceError 注入 + 录音转写文本（缺省测试文案） */
  private readonly voiceErrorOpt?: { code: string; message?: string }
  private readonly transcriptText: string
  /** 实时语音会话归属会话（startRealtimeVoice 携带；turn 内 conversationId 取此优先于活动会话） */
  private realtimeConversationId?: string
  /** 实时会话 turn 已发标志（每会话首个 chunk 仅发一次 partial+turn；realtime start/stop/cancel 时重置） */
  private realtimeTurnEmitted = false
  /** 历史记录（预置样例 + sendMessage 追加；查看器 Mock 全链路数据源） */
  private readonly messageRecords: Message[]

  // —— 阶段 4 P4-A 模型服务（三类内置 + custom CRUD + voices/preview/setVoice；与 real 语义镜像）——
  /** 内置 provider 表（<service> → <provider> → 元数据）；capabilities 键名展开为稳定排序数组 */
  private readonly mockProviders = {
    llm: {
      deepseek: { models: ['deepseek-v4-flash', 'deepseek-r1'], credentialConfigured: true, runtime: 'backend', capabilities: { auth: 'api_key' } },
      // Task 10 集成测试夹具：local_worker 执行位置行（徽标「不可用·待配置」+ 无调用按钮；P4-A 仅展示）
      ollama: { models: ['llama3.2', 'qwen3'], credentialConfigured: false, runtime: 'local_worker', capabilities: { chat: 'true' } }
    },
    stt: { sensevoice: { models: ['sense-voice'], credentialConfigured: false, runtime: 'backend', capabilities: { language: 'zh' } } },
    tts: { edge: { models: ['edge-tts'], credentialConfigured: true, runtime: 'backend', capabilities: { stream: 'true' } } }
  }
  /** 自定义 provider（saveModelProfile upsert；delete 移除） */
  private readonly customProviders: Record<ModelServiceType, Array<{ name: string; base_url?: string; models?: string[]; runtime?: ModelExecutionLocation; credentialConfigured?: boolean; capabilities?: Record<string, unknown> }>> = { llm: [], stt: [], tts: [] }
  /** TTS 声音清单（静态；setTtsVoice 仅改 current） */
  private readonly voices = [
    { id: 'v1', name: '晓晓', languages: ['zh-CN'], capabilities: [] },
    { id: 'v2', name: '云希', languages: ['zh-CN'], capabilities: [] },
    { id: 'v3', name: 'Yunxi', languages: ['zh-CN', 'en-US'], capabilities: [] }
  ]
  private currentVoice: string | undefined
  /** 当前激活选择（activateModelProfile 更新；getActiveModelSelection 返回副本） */
  private activeSelection: ActiveModelSelection = {}

  // —— 阶段 4 批次 B（P4-B）语音/TTS 模拟 ——
  /** 单活动语音会话（任一语音模式持一；kind + key 双标识，key=recordingId/sessionId/clientRequestId） */
  private activeVoice?: { kind: VoiceInputMode; key: string }
  /** 已接收的语音音频块计数（sendAudioBytes 累积；测试可观测） */
  public receivedAudioChunks = 0
  /** 单一共享信封计数器（Minor 11 修复）：全部语音/TTS 事件与既有 generation/replay 事件共用同一
   *  单调计数器打 eventId/sequence（不另起 voiceSeq，避免与 replay 事件交错时非单调；mock-replay.spec 断言全局升序） */
  private nextSequence = 0

  private seedMessages(): Message[] {
    if (this.seedHistoryCount > 0) return this.seedSyntheticHistory(this.seedHistoryCount)
    const mk = (messageId: string, conversationId: string, role: 'user' | 'assistant', createdAt: string, content?: string, stickerId?: string): Message =>
      ({ messageId, conversationId, role, createdAt, status: 'completed', ...(content !== undefined ? { content } : {}), ...(stickerId ? { stickerId } : {}) })
    return [
      mk('msg-1001', 'conv-1001', 'user', '2026-08-14T02:00:00.000Z', '你好，帮我总结一下'),
      mk('msg-1002', 'conv-1001', 'assistant', '2026-08-14T02:00:10.000Z', '好的，正在总结……'),
      mk('msg-1003', 'conv-1001', 'user', '2026-08-13T09:00:00.000Z', '发个表情', 'st_1'),
      mk('msg-1004', 'conv-1002', 'user', '2026-08-07T01:30:00.000Z', '历史会话的问题'),
      mk('msg-1005', 'conv-1002', 'assistant', '2026-08-07T01:31:00.000Z', '这是历史会话的回复')
    ]
  }

  /** 确定性合成历史（spec §4.3.1）：30 条/日 × 若干日、createdAt 单调、纯文本无 sticker */
  private seedSyntheticHistory(count: number): Message[] {
    const mk = (messageId: string, conversationId: string, role: 'user' | 'assistant', createdAt: string, content: string): Message =>
      ({ messageId, conversationId, role, createdAt, status: 'completed', content })
    const DAY = 86_400_000, MIN = 60_000
    const base = new Date('2026-08-08T00:00:00.000Z').getTime()
    const out: Message[] = []
    for (let i = 0; i < count; i++) {
      const day = Math.floor(i / 30), minute = i % 30
      const createdAt = new Date(base + day * DAY + minute * MIN).toISOString()
      out.push(mk(`run2-msg-${String(i + 1).padStart(4, '0')}`, i % 2 === 0 ? 'conv-1001' : 'conv-1002', i % 2 === 0 ? 'user' : 'assistant', createdAt, `模拟命中文本 ${i + 1}`))
    }
    return out
  }

  constructor(options: MockBackendOptions = {}) {
    this.seedHistoryCount = options.seedHistoryCount ?? 0
    this.voiceErrorOpt = options.voiceError
    this.transcriptText = options.voiceTranscriptText ?? '这是一段测试录音的转写文本'
    this.messageRecords = this.seedMessages()
    this.emitDelayMs = options.emitDelayMs ?? 30
    this.onConnectionStateChange = options.onConnectionStateChange
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? (() => `mock-${Date.now()}-${++this.idCounter}`)
    const raw = options.fixtureRaw ?? fixtureRaw
    this.fixture = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => {
        const parsed = parseBackendEvent(JSON.parse(line))
        if (!parsed.success) {
          throw new CyreneError(
            CyreneErrorCode.SCHEMA_VALIDATION_FAILED,
            `MockBackend 夹具第 ${index + 1} 行不符合事件 Schema`,
            { line: index + 1, issues: parsed.error.issues }
          )
        }
        return parsed.data
      })
  }

  subscribe(handler: BackendEventHandler): () => void {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = undefined
    }
  }

  async connect(input: ConnectInput): Promise<BackendSession> {
    this.connected = true
    this.onConnectionStateChange?.({ status: 'connected' })
    return { ...MOCK_SESSION, serverUrl: input.serverUrl }
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.clearTimers()
    this.onConnectionStateChange?.({ status: 'disconnected' })
  }

  getConnectionState(): ConnectionState {
    return { status: this.connected ? 'connected' : 'disconnected' }
  }

  async listConversations(_input: PageQuery): Promise<Page<Conversation>> {
    return { items: this.conversations.map((c) => ({ ...c })), hasMore: false }
  }

  async getConversation(input: GetConversationQuery): Promise<ConversationDetail> {
    const conv = this.conversations.find((c) => c.id === input.conversationId)
    if (!conv) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${input.conversationId}`)
    return { ...conv }
  }

  async getConversationMessages(_input: ConversationMessagesQuery): Promise<MessagePage> {
    return { items: [], hasMore: false }
  }

  async getMessageContext(input: MessageContextQuery): Promise<MessagePage> {
    const records = this.messageRecords.filter((m) => m.conversationId === input.conversationId)
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
    const idx = records.findIndex((m) => m.messageId === input.messageId)
    if (idx < 0) throw new CyreneError(CyreneErrorCode.NOT_FOUND, `消息不存在: ${input.messageId}`)
    const before = Math.min(input.before ?? 5, idx)
    const after = Math.min(input.after ?? 5, records.length - idx - 1)
    return { items: records.slice(idx - before, idx + after + 1), hasMore: false }
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const conv: Conversation = { id: this.idFactory(), title: input.title ?? '新会话', updatedAt: this.now().toISOString() }
    this.conversations.push(conv)
    return { ...conv }
  }

  async activateConversation(conversationId: string): Promise<ActivateConversationResult> {
    if (!this.conversations.some((c) => c.id === conversationId)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${conversationId}`)
    this.activeConversationId = conversationId
    return { conversationId }
  }

  async renameConversation(id: string, title: string): Promise<Conversation> {
    const conv = this.conversations.find((c) => c.id === id)
    if (!conv) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${id}`)
    conv.title = title
    conv.updatedAt = this.now().toISOString()
    return { ...conv }
  }

  async deleteConversation(id: string): Promise<void> {
    const idx = this.conversations.findIndex((c) => c.id === id)
    if (idx < 0) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${id}`)
    this.conversations.splice(idx, 1)
    if (this.activeConversationId === id) this.activeConversationId = undefined
  }

  async sendMessage(input: SendMessageInput): Promise<ClientRequestRef> {
    if (!this.connected) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    }
    // G4：贴图/文本消息记录进历史（可被查看器分类/关键词检索）
    const recordedId = `msg-${this.idFactory().replace(/[^A-Za-z0-9_-]/g, '')}`
    this.messageRecords.push({
      messageId: recordedId, conversationId: input.conversationId, role: 'user',
      createdAt: this.now().toISOString(), status: 'completed',
      ...(input.text ? { content: input.text } : {}),
      ...(input.stickerId ? { stickerId: input.stickerId } : {})
    })
    this.scheduleReplay(input.conversationId)
    return { clientRequestId: input.clientRequestId }
  }

  // —— 阶段 3 G3 附件确定性（spec §3.2）——
  async uploadAttachments(files: UploadContent[]): Promise<AttachmentInfo[]> {
    if (!this.connected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    return files.map((f) => {
      const attachmentId = `att_${this.idFactory().replace(/[^A-Za-z0-9_-]/g, '')}`
      const kind = f.kind ?? kindFromMimeForMock(f.mediaType)
      return { attachmentId, kind, mime: f.mediaType, size: f.size, url: `/api/attachments/${attachmentId}`, filename: f.name }
    })
  }

  async signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult> {
    const base = 'https://mock.local'
    // P2-2：返回精确 AttachmentSignResult 形状（{url,expiresAt}）——多余 attachmentId 属字面量超集，TS excess property 报错
    return { url: `${base}/api/attachments/${encodeURIComponent(attachmentId)}?sig=mock&exp=1`, expiresAt: this.now().toISOString() }
  }

  async cancelGeneration(input: CancelGenerationInput): Promise<void> {
    const genTimers = this.generationTimers.get(input.generationId)
    if (!genTimers) return // 未知 genId no-op
    genTimers.forEach((timer) => clearTimeout(timer))
    this.generationTimers.delete(input.generationId)
  }

  async listModelProfiles(type?: ModelServiceType): Promise<ModelProfile[]> {
    const out: ModelProfile[] = []
    const services: ModelServiceType[] = ['llm', 'stt', 'tts']
    for (const s of services) {
      for (const [name, entry] of Object.entries(this.mockProviders[s])) {
        for (const m of (entry.models.length ? entry.models : [name])) {
          out.push({ id: `${name}/${m}`, type: s, displayName: name, source: 'built_in', provider: name, model: m, models: entry.models, executionLocation: (entry.runtime ?? 'backend') as ModelExecutionLocation, credentialStatus: entry.credentialConfigured ? 'configured' : 'missing', enabled: true, capabilities: Object.keys(entry.capabilities).sort(), builtIn: true })
        }
      }
      for (const c of this.customProviders[s]) {
        out.push({ id: `custom/${c.name}`, type: s, displayName: c.name, source: 'custom', provider: 'custom', model: c.name, models: c.models ?? [], executionLocation: c.runtime ?? 'backend', credentialStatus: c.credentialConfigured ? 'configured' : 'missing', enabled: true, capabilities: Object.keys(c.capabilities ?? {}).sort(), ...(c.base_url ? { endpointLabel: new URL(c.base_url).host } : {}), ...(c.base_url ? { baseUrl: c.base_url } : {}), builtIn: false })
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
    return { ok: true, mime: 'audio/wav', bytes: makeSilentWav() /* 合法静音 WAV：<audio> 可解码 */ }
  }

  async setTtsVoice(input: SetTtsVoiceCommand): Promise<void> { this.currentVoice = input.voice }

  getActiveModelSelection(): ActiveModelSelection { return { ...this.activeSelection } }

  async queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage> {
    const filtered = this.messageRecords
      .filter((m) => input.scope.type === 'all_conversations' || m.conversationId === input.scope.conversationId)
      .filter((m) => !input.query || (m.content ?? '').toLowerCase().includes(input.query.toLowerCase()))
      .filter((m) => !input.localDate || isoToLocalDate(m.createdAt, input.timeZone) === input.localDate)
      .filter((m) => categoryMatches(m, input.category))
      .map((m) => this.toHistoryItem(m))
      .sort((a, b) => (a.sortKey > b.sortKey ? -1 : a.sortKey < b.sortKey ? 1 : 0)) // DESC：最新在前（real keyset 同构）
    let offset = 0
    if (input.cursor?.startsWith('mock:')) offset = Number(input.cursor.slice(5)) || 0
    const page = filtered.slice(offset, offset + input.limit)
    const items = [...page].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)) // 页内升序返回（real transport 后序一致）
    const nextOffset = offset + input.limit
    return { items, hasMore: nextOffset < filtered.length, nextCursor: nextOffset < filtered.length ? `mock:${nextOffset}` : undefined }
  }

  async listStickers(): Promise<StickerManifest> {
    return { stickers: [
      { stickerId: 'st_1', src: '/static/stickers/st_1.png' },
      { stickerId: 'st_2', src: '/static/stickers/st_2.png' },
      { stickerId: 'st_3', src: '/static/stickers/st_3.png' }
    ] }
  }

  // —— P4-B 语音（Task 7 落地 Mock 模拟；Task 3 中间态抛 NOT_IMPLEMENTED 保持编译绿） ——
  async startRecordVoice(input: VoiceRecordStartInput): Promise<{ recordingId: string }> {
    if (this.pollVoiceError()) return { recordingId: input.recordingId }
    this.activeVoice = { kind: 'record', key: input.recordingId }
    return { recordingId: input.recordingId }
  }

  async stopRecordVoice(input: VoiceRecordStopInput): Promise<void> {
    const text = this.transcriptText
    // 显式空串测「未识别」：不发 transcript（Minor 18）；非空才 emit voice.transcript
    if (text.length > 0) {
      this.emit({ ...this.stamp(), event: 'voice.transcript', recordingId: input.recordingId, text } satisfies VoiceTranscriptEvent)
    }
    if (this.activeVoice?.kind === 'record') this.activeVoice = undefined
  }

  async commitVoice(input: VoiceCommitInput): Promise<ClientRequestRef> {
    if (!this.connected) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    }
    // 复用既有 sendMessage 语义：记录消息 + 触发 generation 回放；ack 以返回的 ClientRequestRef 体现。
    // 服务端消息 ID（serverMessageId）由 idFactory 确定性生成（缺省 `msg-<factory>` 前缀），并作为记录消息的
    // messageId——Task 12 messageStore.sendVoiceCommit 依赖 ref.serverMessageId 迁移乐观消息 key，Mock 须与 real
    // 的 user_message.ack{messageId} 返回形状一致（real sendMessage/commitVoice await ack 后均返回 {clientRequestId, serverMessageId}）。
    const serverMessageId = `msg-${this.idFactory().replace(/[^A-Za-z0-9_-]/g, '')}`
    this.messageRecords.push({
      messageId: serverMessageId,
      conversationId: input.conversationId, role: 'user', createdAt: this.now().toISOString(),
      status: 'completed', content: input.text
    })
    this.scheduleReplay(input.conversationId)
    return { clientRequestId: input.clientRequestId, serverMessageId }
  }

  async discardVoice(_input: VoiceDiscardInput): Promise<void> {
    if (this.activeVoice?.kind === 'record') this.activeVoice = undefined
  }

  async startRealtimeVoice(input: RealtimeVoiceStartInput): Promise<{ sessionId: string }> {
    if (this.pollVoiceError()) return { sessionId: input.sessionId }
    this.activeVoice = { kind: 'realtime', key: input.sessionId }
    this.realtimeConversationId = input.conversationId
    this.realtimeTurnEmitted = false
    this.emit({ ...this.stamp(), event: 'voice_session.started', sessionId: input.sessionId, ...(input.conversationId ? { conversationId: input.conversationId } : {}) } satisfies VoiceSessionStartedEvent)
    return { sessionId: input.sessionId }
  }

  async stopRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void> {
    this.emit({ ...this.stamp(), event: 'voice_session.ended', sessionId: input.sessionId, reason: 'stopped' } satisfies VoiceSessionEndedEvent)
    if (this.activeVoice?.kind === 'realtime') { this.activeVoice = undefined; this.realtimeTurnEmitted = false }
  }

  async cancelRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void> {
    this.emit({ ...this.stamp(), event: 'voice_session.ended', sessionId: input.sessionId, reason: 'cancelled' } satisfies VoiceSessionEndedEvent)
    if (this.activeVoice?.kind === 'realtime') { this.activeVoice = undefined; this.realtimeTurnEmitted = false }
  }

  async startDictation(input: DictationStartInput): Promise<{ clientRequestId: string }> {
    if (this.pollVoiceError()) return { clientRequestId: input.clientRequestId }
    this.activeVoice = { kind: 'dictation', key: input.clientRequestId }
    // 模拟输入法转写累积首条字幕（零消息副作用）
    this.emit({ ...this.stamp(), event: 'dictation.partial', text: '正在听写' } satisfies DictationPartialEvent)
    return { clientRequestId: input.clientRequestId }
  }

  async stopDictation(input: DictationStopInput): Promise<void> {
    this.emit({ ...this.stamp(), event: 'dictation.final', clientRequestId: input.clientRequestId, text: '这是听写文本' } satisfies DictationFinalEvent)
    if (this.activeVoice?.kind === 'dictation') this.activeVoice = undefined
  }

  async cancelDictation(input: DictationStopInput): Promise<void> {
    this.emit({ ...this.stamp(), event: 'dictation.cancelled', clientRequestId: input.clientRequestId } satisfies DictationCancelledEvent)
    if (this.activeVoice?.kind === 'dictation') this.activeVoice = undefined
  }

  sendAudioBytes(_bytes: Uint8Array): void {
    // 同步累积计数（无会话也计数，不 throw——与 real 的「丢弃告警不抛」语义对齐的 Mock 简化）
    this.receivedAudioChunks++
    if (this.activeVoice?.kind !== 'realtime') return
    // 实时会话：起会话后首个 chunk 模拟后端 VAD 分段 → partial + 自动提交 turn（每会话仅一次）
    if (!this.realtimeTurnEmitted) {
      const sessionId = this.activeVoice.key
      const conversationId = this.realtimeConversationId ?? this.activeConversationId
      const messageId = `msg_${this.idFactory().replace(/[^A-Za-z0-9_-]/g, '')}`
      this.realtimeTurnEmitted = true
      this.emit({ ...this.stamp(), event: 'voice_session.partial', sessionId, turnId: 1, segmentIndex: 0, text: '实时语音轮次文本' } satisfies VoiceSessionPartialEvent)
      this.emit({ ...this.stamp(), event: 'voice_session.turn', sessionId, turnId: 1, messageId, ...(conversationId ? { conversationId } : {}), text: '实时语音轮次文本' } satisfies VoiceSessionTurnEvent)
    }
  }

  async audioCancel(input: AudioCancelInput): Promise<void> {
    this.emit({ ...this.stamp(), event: 'audio.session.cancelled', streamId: input.streamId } satisfies AudioSessionCancelledEvent)
  }

  /** options.voiceError 注入：各语音 start* 时 emit voice.error（替代继续）；falsy 时返回 false 正常继续 */
  private pollVoiceError(): boolean {
    const err = this.voiceErrorOpt
    if (!err) return false
    this.emit({ ...this.stamp(), event: 'voice.error', code: err.code, ...(err.message ? { message: err.message } : {}) } satisfies VoiceErrorEvent)
    return true
  }

  async submitToolResult(_input: ToolResult): Promise<void> {
    // Mock 无操作
  }

  /** 释放定时器(测试清理用) */
  dispose(): void {
    this.clearTimers()
  }

  /** 领域富化（Mock 与 Real 差异注，P0-1）：直接产出 ChatHistoryItem（非 REST wire），
   *  为演示「表情」分类缩略图保留 resource；真实后端 search item 无 kind/url，联调后分类缩略图需资源端点补充。 */
  private toHistoryItem(m: Message): ChatHistoryItem {
    const base: ChatHistoryItem = {
      hitId: `${m.conversationId}:${m.messageId}:`,
      conversationId: m.conversationId, messageId: m.messageId,
      senderLabel: senderLabelOf(m.role), createdAt: m.createdAt,
      sortKey: `${m.createdAt}|${m.messageId}`
    }
    if (m.content) base.snippet = m.content
    if (m.stickerId) {
      base.resource = { messageId: m.messageId, timestamp: m.createdAt, kind: 'sticker', url: `/static/stickers/${m.stickerId}.png`, stickerId: m.stickerId }
      base.snippet = '表情'
    }
    return base
  }

  private scheduleReplay(conversationId: string): void {
    const genId = this.idFactory()
    const msgId = this.idFactory()
    const rspId = this.idFactory()
    const segmentMap = new Map<string, string>()
    const genTimers: ReturnType<typeof setTimeout>[] = []
    this.fixture.forEach((event, index) => {
      const fresh: Record<string, unknown> = { ...event }
      fresh.eventId = this.idFactory()
      fresh.sequence = this.nextSequence++
      if ('generationId' in event) fresh.generationId = genId
      if ('messageId' in event) fresh.messageId = msgId
      if ('responseId' in event) fresh.responseId = rspId
      if ('conversationId' in event) fresh.conversationId = conversationId
      if ('segmentId' in event && typeof event.segmentId === 'string') {
        let mapped = segmentMap.get(event.segmentId)
        if (!mapped) {
          mapped = this.idFactory()
          segmentMap.set(event.segmentId, mapped)
        }
        fresh.segmentId = mapped
      }
      // BackendEvent 是接口联合，需 as unknown as 双转（TS2352）
      const timer = setTimeout(() => {
        this.emit(fresh as unknown as BackendEvent)
        // TTS 模拟（D-P13）：generation.completed 之后、ttsActive（已激活 TTS Profile）时追加 audio 会话事件
        if (event.event === 'generation.completed' && this.ttsActive) {
          this.emit({ ...this.stamp(), event: 'audio.session.started', streamId: 1, format: 'wav' } satisfies AudioSessionStartedEvent)
          this.emit({ ...this.stamp(), event: 'audio.session.ready', streamId: 1, url: 'cyrene://renderer/__cyrene-media/tts-live/mock-silent', format: 'wav' } satisfies AudioSessionReadyEvent)
        }
      }, index * this.emitDelayMs)
      genTimers.push(timer)
    })
    this.generationTimers.set(genId, genTimers)
  }

  private clearTimers(): void {
    this.generationTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)))
    this.generationTimers.clear()
  }

  private emit(event: BackendEvent): void {
    this.handler?.(event)
  }

  /** 共享单调信封（Minor 11）：全部 Mock 事件（replay + 语音/TTS）复用同一计数器打 eventId/sequence */
  private stamp(): { eventId: string; sequence: number } {
    return { eventId: this.idFactory(), sequence: this.nextSequence++ }
  }

  /** TTS 活动判定（D-P13）：无独立标志，`!!activeSelection.ttsProfileId` 即活动 */
  get ttsActive(): boolean {
    return !!this.activeSelection.ttsProfileId
  }
}

/** Mock 分类过滤：all 全放行；sticker 有 stickerId；其余分类 Mock 无样例（可扩展） */
function categoryMatches(m: Message, category: HistoryCategory): boolean {
  if (category === 'all') return true
  if (category === 'sticker') return !!m.stickerId
  return false   // 其余分类 Mock 无样例（可扩展）
}

function senderLabelOf(role: Message['role']): string {
  switch (role) { case 'assistant': return 'assistant'; case 'system': return '系统'; case 'tool': return '工具'; default: return 'user' }
}
