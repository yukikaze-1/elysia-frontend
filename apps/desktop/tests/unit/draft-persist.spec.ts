// tests/unit/draft-persist.spec.ts —— Task 4:messageStore.handleConnectionStateChange 断线时自动持久化草稿。
// 断言:断线(error/reconnecting/disconnected)→ draftStore.flush(currentId) 被调;currentId undefined → 不调。
// env=node:经 stores/desktop-api 注入 mock api;pinia 用 createPinia + setActivePinia。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(), attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn(),
  listLive2dModels: vi.fn(),
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
  diagnosticsState: vi.fn(), diagnosticsDevModeSet: vi.fn(), diagnosticsOpenLogDir: vi.fn(), diagnosticsClearLogs: vi.fn(), diagnosticsExport: vi.fn(), onDiagnosticsDevEvent: vi.fn(() => () => {}), getLastCrash: vi.fn(),
}

describe('断线草稿自动持久化（Task 4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
  })

  it('handleConnectionStateChange 断线(error) → 调 draftStore.flush(currentId)', () => {
    useConversationStore().$patch({ currentId: 'c1' })
    const draft = useDraftStore()
    const flushSpy = vi.spyOn(draft, 'flush').mockResolvedValue(undefined)
    const store = useMessageStore()

    store.handleConnectionStateChange({ status: 'error' })

    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(flushSpy).toHaveBeenCalledWith('c1')
  })

  it('断线(reconnecting)→ 调 draftStore.flush(currentId)', () => {
    useConversationStore().$patch({ currentId: 'c1' })
    const draft = useDraftStore()
    const flushSpy = vi.spyOn(draft, 'flush').mockResolvedValue(undefined)
    const store = useMessageStore()

    store.handleConnectionStateChange({ status: 'reconnecting' })
    expect(flushSpy).toHaveBeenCalledWith('c1')
  })

  it('断线且 currentId undefined → 不调 flush', () => {
    useConversationStore().$patch({ currentId: undefined })
    const draft = useDraftStore()
    const flushSpy = vi.spyOn(draft, 'flush').mockResolvedValue(undefined)
    const store = useMessageStore()

    store.handleConnectionStateChange({ status: 'error' })
    expect(flushSpy).not.toHaveBeenCalled()
  })

  it('非断线态(connected)→ 不调 flush', () => {
    useConversationStore().$patch({ currentId: 'c1' })
    const draft = useDraftStore()
    const flushSpy = vi.spyOn(draft, 'flush').mockResolvedValue(undefined)
    const store = useMessageStore()

    store.handleConnectionStateChange({ status: 'connected' })
    expect(flushSpy).not.toHaveBeenCalled()
  })
})
