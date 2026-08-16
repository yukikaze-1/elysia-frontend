// src/renderer/src/stores/connection.store.ts
// 连接状态(C-3 定死 push,不轮询):连接动作 + ConnectionState;状态变化由 Main 经 chat:state 推送 setState。
// 断线→in-flight 置 interrupted 的编排在 messageStore.handleConnectionStateChange(见 main.ts 接线)。
// connect 无参:endpoint/token 由 Main 侧 connection-config 持有,renderer 不传任意 URL;错误经 parsePublicError 结构化。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ConnectionState } from '@shared/contracts'
import { VOICE_ERROR_CODES } from '@shared/contracts'
import { api } from './desktop-api'
import { parsePublicError, type PublicError } from '../utils/public-error'

export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnectionState>({ status: 'disconnected' })
  const connecting = ref(false)
  const error = ref<PublicError>()

  async function connect(): Promise<void> {
    error.value = undefined
    // P1-2:乐观置位——真实 IPC 时序里 Main 在 await 期间就可能推送 connected(C-3 push),
    // 若在 await 之后再置 connecting,会把 onChatState 已定的 connected 覆写回「连接中…」。
    state.value = { status: 'connecting' }
    connecting.value = true
    try {
      await api.connect()
      // 连接结果由 chat:state push 更新（定死 push 不轮询），此处不主动拉
    } catch (e) {
      error.value = parsePublicError(e instanceof Error ? e.message : String(e))
      // 失败保持 error 状态:不残留乐观 connecting,也不回 disconnected(整改必须修改5:错误可见)
      state.value = { status: 'error', lastError: error.value.message }
    } finally {
      connecting.value = false
    }
  }

  /** 由 onChatState 推送更新(C-3 定死 push,不轮询);成功/重连清旧错误 */
  function setState(s: ConnectionState): void {
    state.value = s
    if (s.status === 'connected' || s.status === 'reconnecting') error.value = undefined
  }

  /** onChatError 消费入口:显式置公开错误(Main 侧已结构化,renderer 仅保存展示)。
   *  D-P15:语音族错误码 → 不展示全局连接横幅(语音错误是会话级预期错误,由 voiceStore.error 展示)。
   *  真实路径形状:real-backend handleErrorFrame 以 CyreneError(UNKNOWN, …, {code: frame.code}) 构造,
   *  backend-error-handlers 经 extractPublic 把语音码上提为 backendCode → 校验 code 与 backendCode 双路径。 */
  function setError(err: PublicError): void {
    if (
      (VOICE_ERROR_CODES as readonly string[]).includes(err.code) ||
      (err.backendCode !== undefined && (VOICE_ERROR_CODES as readonly string[]).includes(err.backendCode))
    ) return
    error.value = err
  }

  async function refreshState(): Promise<void> {
    state.value = await api.getConnectionState()
  }

  async function disconnect(): Promise<void> {
    await api.disconnect()
  }

  return { state, connecting, error, connect, setState, setError, refreshState, disconnect }
})
