// src/renderer/src/stores/connection.store.ts
// 连接状态(C-3 定死 push,不轮询):连接动作 + ConnectionState;状态变化由 Main 经 chat:state 推送 setState。
// 断线→in-flight 置 interrupted 的编排在 messageStore.handleConnectionStateChange(见 main.ts 接线)。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ConnectionState } from '@shared/contracts'
import { api } from './desktop-api'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnectionState>({ status: 'disconnected' })
  const connecting = ref(false)
  const error = ref<string>()

  async function connect(serverUrl: string): Promise<void> {
    connecting.value = true
    error.value = undefined
    try {
      await api.connect(serverUrl)
      state.value.status = 'connecting'
    } catch (e) {
      error.value = messageOf(e)
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
