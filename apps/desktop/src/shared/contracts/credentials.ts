// src/shared/contracts/credentials.ts
/** 凭据可用状态：Renderer 只经 IPC 见这 4 值，绝不明文回读 */
export type CredentialStatus = 'unavailable' | 'locked' | 'empty' | 'available'

export type CredentialKey = 'backend.token' // 未来: 'model.llm.*' 等

/** 当前唯一 key */
export const BACKEND_TOKEN_KEY: CredentialKey = 'backend.token'

/**
 * Token 与 Endpoint Origin 的绑定值 key（明文 origin；非 CredentialKey 字面量联合，
 * 专用字符串类型避免 TS 报错——它由 connection-config 内部读写，不暴露给通用凭据路径）。
 */
export const BACKEND_TOKEN_ORIGIN_KEY: string = 'backend_token_origin'

/** key 白名单单一来源（zod .refine / store 谓词 / preload 固定 key 全派生自它） */
export const CREDENTIAL_KEY_ALLOWLIST: readonly string[] = ['backend.token', 'backend_token_origin']

/**
 * 白名单谓词：字面量精确匹配，或 `prefix.*` 通配（当前 allowlist 无通配项，
 * model.* 语义由本函数结构预留——未来加 'model.*' 进 allowlist 即激活，无需改调用方）。
 */
export function isKeyAllowed(key: string): boolean {
  return CREDENTIAL_KEY_ALLOWLIST.some((pattern) => {
    if (pattern.endsWith('.*')) return key.startsWith(pattern.slice(0, -1))
    return key === pattern
  })
}
