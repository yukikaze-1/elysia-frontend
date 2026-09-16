// renderer/src/conversation/backend-identity.ts
// 后端事实域（endpoint）身份与「端点漂移 → 清空保留数据」判定。
//
// 为什么单独存在：这是会话语料最容易被悄悄破坏的一条边界——把「换到另一个后端」误判成「同后端重连」
// 会让旧后端的会话列表、角色绑定快照与消息快照在新后端上继续被当作事实；反过来（把瞬态重连
// 误判成换端点）会在每次抖动时清空用户正在看的会话。原先这套判据与 store 的响应式赋值混在
// 一起，只有整棵 store 集成用例能到达。
//
// 本模块不 import `vue` / `pinia`：只做纯判定，清空动作由调用方以回调执行。
import type { ConnectionState } from '@shared/contracts'

export type BackendIdentity = {
  key: string
  /** URL 派生的身份足以隔离旧数据；连接 id 只是无端点时的保守回退。 */
  authoritative: boolean
}

/**
 * 一个 connection id 标识的是**传输转世**，不是后端。绑定快照在一个后端内不可变，
 * 故以规范化后的服务端 URL 为主身份，仅在拿不到端点时（例如启动期）保守地退回连接 id。
 */
export function backendIdentity(state: ConnectionState): BackendIdentity | undefined {
  const rawUrl = state.serverUrl?.trim()
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl)
      const origin = parsed.origin === 'null'
        ? `${parsed.protocol}//${parsed.host}`
        : parsed.origin
      // 配置的 base URL 才是后端事实域。保留 pathname（去掉尾斜杠）以免同一 host 上的两个
      // 不同网关被当成同一权威。query 与 fragment 有意排除：它们是传输选项，不是另一个后端。
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
      if (origin && origin !== 'null') return { key: `url:${origin.toLowerCase()}${pathname}`, authoritative: true }
    } catch {
      // 端点非法：退回非权威的连接身份，而不是从状态水合里抛错。
    }
  }
  const connectionId = state.connectionId?.trim()
  return connectionId ? { key: `connection:${connectionId}`, authoritative: false } : undefined
}

export function conversationConnectionSignature(state: ConnectionState): string {
  return JSON.stringify([
    state.status,
    state.connectionId ?? null,
    backendIdentity(state)?.key ?? null,
    state.features?.characterProfiles === true
  ])
}

const NON_AUTHORITATIVE_PREFIX = 'connection:'

/**
 * 端点漂移判定器。
 *
 * 三份状态必须分开记：**最后权威端点**（缺 URL 的传输中间态永远不得覆写它）、
 * **最后的非权威身份**（只在与权威身份无关时才用于隔离）、以及**当前保留数据的出处**
 * （`undefined` = 出处未确立的离线/启动快照）。
 */
export interface EndpointDrift {
  /** 最后确立的权威端点（无则 undefined）。 */
  known(): BackendIdentity | undefined
  /**
   * 观测一次连接状态并维护身份台账。
   * `retained` 报告「当前是否有需要隔离的保留数据」；`clear` 在判定换端点时被调用一次。
   * 返回本次观测是否触发了清空（供调用方在清空后追加自己的动作）。
   */
  observe(state: ConnectionState, retained: () => boolean, clear: () => void): boolean
  /** 记录当前保留数据的出处。非权威身份在有权威端点存在时不得覆写它。 */
  rememberData(identity: BackendIdentity | undefined): void
  /**
   * 无端点 URL 时能否提交后端数据。
   *
   * 连接 id 回退在「从未确立过端点」时有用，但它**不是**「已连接的无 URL 状态与上一个权威 URL
   * 同属一个后端」的证据。故一旦已知权威端点，缺 URL / 非权威状态对保留数据一律只读。
   */
  canCommit(identity: BackendIdentity | undefined): boolean
  /**
   * 两个身份是否属于可比较的同一事实域。绑定冲突只在**可证明**的同一域内才有意义：
   * 未知身份可以在同一传输转世内互相比较；一旦存在权威 URL，无 URL 的回退身份
   * 既不得与之比较、也不得覆写它。
   */
  canCompareBindings(left: BackendIdentity | undefined, right: BackendIdentity | undefined): boolean
}

export function createEndpointDrift(initial: ConnectionState): EndpointDrift {
  const initialIdentity = backendIdentity(initial)
  let known = initialIdentity?.authoritative ? initialIdentity : undefined
  let lastNonAuthoritative = initialIdentity?.authoritative ? undefined : initialIdentity
  let dataIdentity: BackendIdentity | undefined

  function isNonAuthoritative(identity: BackendIdentity): boolean {
    return !identity.authoritative && identity.key.startsWith(NON_AUTHORITATIVE_PREFIX)
  }

  return {
    known: () => known,

    observe(state, retained, clear) {
      const next = backendIdentity(state)
      let cleared = false
      if (next?.authoritative) {
        // 首个权威连接不得继承出处未证的启动缓存。一旦已知权威端点，缺 serverUrl 的瞬态状态
        // 不替换它；只有真正不同的端点才是清掉保留事实的那次迁移。
        if (
          (known && known.key !== next.key)
          || (!known && retained() && dataIdentity?.authoritative !== true)
        ) {
          clear()
          cleared = true
        }
        known = next
        lastNonAuthoritative = undefined
      } else if (next) {
        // 没有权威出处时，两个不同的「仅连接」身份不能假定同属一个后端。
        // 若已存在权威身份，这只是一次瞬态传输状态。
        if (!known) {
          const identityChanged = lastNonAuthoritative && lastNonAuthoritative.key !== next.key
          const unprovenRetainedData = retained() && (!dataIdentity || dataIdentity.key !== next.key)
          if (identityChanged || unprovenRetainedData) {
            clear()
            cleared = true
          }
        }
        if (!known) lastNonAuthoritative = next
      }
      return cleared
    },

    rememberData(identity) {
      if (!identity) return
      if (isNonAuthoritative(identity) && known) return
      dataIdentity = identity
    },

    canCommit(identity) {
      return !(known && (!identity || !identity.authoritative))
    },

    canCompareBindings(left, right) {
      if (!left || !right || left.key !== right.key) return false
      if (left.authoritative && right.authoritative) return true
      return !known
    }
  }
}
