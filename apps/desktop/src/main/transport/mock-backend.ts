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
  RealtimeVoiceControlInput,
  RealtimeVoiceStartInput,
  VoiceCommitInput,
  VoiceDiscardInput,
  VoiceRecordStartInput,
  VoiceRecordStopInput
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

  // —— P4-B 语音（Task 4 落地真实 Mock 实现；Task 3 中间态抛 NOT_IMPLEMENTED 保持编译绿） ——
  async startRecordVoice(_input: VoiceRecordStartInput): Promise<{ recordingId: string }> { throw this.voiceNotImplemented('startRecordVoice') }
  async stopRecordVoice(_input: VoiceRecordStopInput): Promise<void> { throw this.voiceNotImplemented('stopRecordVoice') }
  async commitVoice(_input: VoiceCommitInput): Promise<ClientRequestRef> { throw this.voiceNotImplemented('commitVoice') }
  async discardVoice(_input: VoiceDiscardInput): Promise<void> { throw this.voiceNotImplemented('discardVoice') }
  async startRealtimeVoice(_input: RealtimeVoiceStartInput): Promise<{ sessionId: string }> { throw this.voiceNotImplemented('startRealtimeVoice') }
  async stopRealtimeVoice(_input: RealtimeVoiceControlInput): Promise<void> { throw this.voiceNotImplemented('stopRealtimeVoice') }
  async cancelRealtimeVoice(_input: RealtimeVoiceControlInput): Promise<void> { throw this.voiceNotImplemented('cancelRealtimeVoice') }
  async startDictation(_input: DictationStartInput): Promise<{ clientRequestId: string }> { throw this.voiceNotImplemented('startDictation') }
  async stopDictation(_input: DictationStopInput): Promise<void> { throw this.voiceNotImplemented('stopDictation') }
  async cancelDictation(_input: DictationStopInput): Promise<void> { throw this.voiceNotImplemented('cancelDictation') }
  sendAudioBytes(_bytes: Uint8Array): void { throw this.voiceNotImplemented('sendAudioBytes') }
  async audioCancel(_input: AudioCancelInput): Promise<void> { throw this.voiceNotImplemented('audioCancel') }

  private voiceNotImplemented(method: string): CyreneError {
    return new CyreneError(CyreneErrorCode.NOT_IMPLEMENTED, `MockBackend.${method} 尚未实现(阶段4批B Task 4 落地)`)
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
