// src/renderer/src/stores/connection.store.ts
// 连接状态(C-3 定死 push,不轮询):连接动作 + ConnectionState;状态变化由 Main 经 chat:state 推送 setState。
// 断线→in-flight 置 interrupted 的编排在 messageStore.handleConnectionStateChange(见 main.ts 接线)。
// connect 无参:endpoint/token 由 Main 侧 connection-config 持有,renderer 不传任意 URL;错误经 parsePublicError 结构化。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ConnectionState } from '@shared/contracts'
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
      // 失败复位:不残留乐观 connecting(C-3 push 未到,显式兜底)
      state.value = { status: 'disconnected' }
    } finally {
      connecting.value = false
    }
  }

  /** 由 onChatState 推送更新(C-3 定死 push,不轮询) */
  function setState(s: ConnectionState): void {
    state.value = s
  }

  async function refreshState(): Promise<void> {
    state.value = await api.getConnectionState()
  }

  async function disconnect(): Promise<void> {
    await api.disconnect()
  }

  return { state, connecting, error, connect, setState, refreshState, disconnect }
})
