// tests/unit/draft.store.spec.ts —— spec §4.4.1：save/get/超限/防抖持久化/切会话 flush/发送清空/删除清理。
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDraftStore, DRAFT_MAX_BYTES } from '../../src/renderer/src/stores/draft.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { SessionPersistenceState } from '@shared/contracts'

const mockApi = {
  persistSession: vi.fn(), hydratePersistence: vi.fn(),
  cacheMessages: vi.fn(), openExternal: vi.fn(), attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  // P4-B 语音/设置面
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn(),
  listLive2dModels: vi.fn(),
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
  // 阶段 7 批次 A（Task 5）：诊断面（DesktopApiLike 全契约镜像——mock 补键）
  diagnosticsState: vi.fn(), diagnosticsDevModeSet: vi.fn(), diagnosticsOpenLogDir: vi.fn(), diagnosticsClearLogs: vi.fn(), diagnosticsExport: vi.fn(), onDiagnosticsDevEvent: vi.fn(() => () => {}), getLastCrash: vi.fn(),
}

describe('draftStore（spec §4.4.1）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.useFakeTimers(); mockApi.persistSession.mockReset(); mockApi.persistSession.mockResolvedValue({}) })
  afterEach(() => { vi.useRealTimers() })

  it('saveDraft 写入内存 + 800ms 防抖后 persistSession（携带草稿+锚点）', async () => {
    const s = useDraftStore()
    s.setScrollAnchor('c1', { messageId: 'm1', offset: 5 })
    expect(s.saveDraft('c1', '你好')).toBe(true)
    expect(s.drafts['c1']).toBe('你好')
    expect(mockApi.persistSession).not.toHaveBeenCalled()
    vi.advanceTimersByTime(800)
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1)
    expect(mockApi.persistSession).toHaveBeenCalledWith({
      conversationId: 'c1', draft: { text: '你好', updatedAt: expect.any(String) }, scrollAnchor: { messageId: 'm1', offset: 5 }
    })
  })

  it('超限（UTF-8 字节 >100KB）拒绝写入 + overLimit 置位，不静默截断', () => {
    const s = useDraftStore()
    const big = '汉'.repeat(Math.ceil(DRAFT_MAX_BYTES / 3)) // 100KB 字节 → 码点 <100k，按字节算超限
    expect(s.saveDraft('c1', big)).toBe(false)
    expect(s.drafts['c1']).toBeUndefined()
    expect(s.overLimit['c1']).toBe(true)
  })

  it('flush 立即持久化并取消待写防抖（切会话/发送路径）', async () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'x')
    vi.advanceTimersByTime(300)
    await s.flush('c1')
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(mockApi.persistSession).toHaveBeenCalledTimes(1) // 防抖已取消
  })

  it('clear 持久化空串（发送成功清空）；hydrate 水合草稿+锚点', async () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'typing')
    s.clear('c1')
    expect(s.drafts['c1']).toBeUndefined()
    await s.flush('c1')
    expect(mockApi.persistSession).toHaveBeenLastCalledWith({
      conversationId: 'c1', draft: { text: '', updatedAt: expect.any(String) }, scrollAnchor: null
    })
    const state: SessionPersistenceState = {
      drafts: [{ conversationId: 'c9', text: '旧草稿', attachmentLocalIds: [], updatedAt: 't' }],
      scrollAnchors: { c9: { messageId: 'm9', offset: 3 } }, conversations: [], messageSnapshots: {}
    }
    s.hydrate(state)
    expect(s.drafts['c9']).toBe('旧草稿')
    expect(s.scrollAnchors['c9']).toEqual({ messageId: 'm9', offset: 3 })
  })

  it('removeConversations 清被淘汰项 + evictionNotice 置位（P2-1 不静默）', () => {
    const s = useDraftStore()
    s.saveDraft('old', 'x'); s.saveDraft('new', 'y')
    s.removeConversations(['old'])
    expect(s.drafts['old']).toBeUndefined()
    expect(s.evictionNotice).toContain('old')
  })

  it('purge 删会话联动：清内存草稿/锚点 + 取消待写', () => {
    const s = useDraftStore()
    s.saveDraft('c1', 'x'); s.setScrollAnchor('c1', { messageId: 'm1', offset: 0 })
    s.purge('c1')
    expect(s.drafts['c1']).toBeUndefined()
    expect(s.scrollAnchors['c1']).toBeUndefined()
  })
})
