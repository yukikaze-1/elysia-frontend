import { z } from 'zod'
import { IpcChannels, BACKEND_TOKEN_KEY, BACKEND_TOKEN_ORIGIN_KEY, type IpcResult } from '@shared/contracts'
import type { CredentialStatus } from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { Logger } from '../diagnostics/logger'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { AuditEvent } from '../diagnostics/audit'
import { safeAudit } from '../diagnostics/safe-audit'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { credentialStatusSchema, credentialsClearSchema, credentialsSetSchema } from '../ipc/channels'
import type { CredentialStore } from './credential-store'

type CredentialExecutor = (raw: unknown) => Promise<IpcResult<{ status: CredentialStatus; key: string }>>

/** 凭据审计签名（与 main 注入的 fail-open 包装同型） */
type AuditFn = (event: Omit<AuditEvent, 'ts'>) => void

/** BACKEND_TOKEN_KEY 特判委派目标（ConnectionConfig 的结构化端口；decoupled——不 import 具体类） */
interface CredentialConfigPort {
  setBackendToken(token: string): Promise<void>
  clearBackendToken(): Promise<void>
}

/** 凭据生命周期元数据（无秘密值）写入日志 + 审计：status 变化才记；before 须在变更前捕获；隔离天然保留（fail-open 不阻断操作） */
async function maybeLogStatusChange(opts: { logger: Logger; audit?: AuditFn }, store: CredentialStore, key: string, before: string): Promise<void> {
  try {
    const after = await store.getStatus(key)
    if (before !== after) {
      opts.logger.info('credential:status-change', { key, from: before, to: after })
      safeAudit(opts.audit, { type: 'credential:status-change', summary: `key=${key} from=${before} to=${after}` })
    }
  } catch { /* 元数据日志/审计失败不阻断 */ }
}

/** 纯工厂（可单测）：三个通道的 executor，不触碰 electron registry。connConfig 为 BACKEND_TOKEN_KEY 特判委派目标 */
export function createCredentialsExecutors(store: CredentialStore, opts: { logger: Logger; sanitize: MessageSanitizer; audit?: AuditFn }, connConfig?: CredentialConfigPort): {
  getStatus: CredentialExecutor
  set: CredentialExecutor
  clear: CredentialExecutor
} {
  return {
    getStatus: createIpcHandler(z.undefined(), credentialStatusSchema,
      async () => { const key = BACKEND_TOKEN_KEY; return { status: await store.getStatus(key), key } },
      { sanitize: opts.sanitize }),
    set: createIpcHandler(credentialsSetSchema, credentialStatusSchema,
      async (req) => {
        try {
          const before = await store.getStatus(req.key)
          if (req.key === BACKEND_TOKEN_KEY && connConfig) {
            await connConfig.setBackendToken(req.value)   // 决策 9：token 走 connection-config（endpoint 校验 + origin 绑定）
          } else if (req.key === BACKEND_TOKEN_ORIGIN_KEY) {
            throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '绑定 origin 仅经连接配置内部维护')   // 纵深：绑定 origin 不开放通用写（最终 review 修复）
          } else {
            await store.setCredential(req.key, req.value)
          }
          opts.logger.info('credential:set', { key: req.key }) // 操作事件（元数据，无秘密值）
          safeAudit(opts.audit, { type: 'credential:set', status: 'success', summary: `key=${req.key}` })
          await maybeLogStatusChange(opts, store, req.key, before)
          return { status: await store.getStatus(req.key), key: req.key }
        } catch (e) {
          safeAudit(opts.audit, { type: 'credential:set', status: 'failed', summary: `key=${req.key} code=${(e as { code?: string }).code ?? 'UNKNOWN'}` })
          throw e
        }
      },
      { sanitize: opts.sanitize }),
    clear: createIpcHandler(credentialsClearSchema, credentialStatusSchema,
      async (req) => {
        try {
          const before = await store.getStatus(req.key)
          if (req.key === BACKEND_TOKEN_KEY && connConfig) {
            await connConfig.clearBackendToken()   // 决策 9：clear 同理委派（token + 绑定同清）
          } else if (req.key === BACKEND_TOKEN_ORIGIN_KEY) {
            throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '绑定 origin 仅经连接配置内部维护')
          } else {
            await store.clearCredential(req.key)
          }
          opts.logger.info('credential:clear', { key: req.key }) // 操作事件（元数据，无秘密值）
          safeAudit(opts.audit, { type: 'credential:clear', status: 'success', summary: `key=${req.key}` })
          await maybeLogStatusChange(opts, store, req.key, before)
          return { status: await store.getStatus(req.key), key: req.key }
        } catch (e) {
          safeAudit(opts.audit, { type: 'credential:clear', status: 'failed', summary: `key=${req.key} code=${(e as { code?: string }).code ?? 'UNKNOWN'}` })
          throw e
        }
      },
      { sanitize: opts.sanitize })
  }
}

export function registerCredentialsHandlers(store: CredentialStore, opts: { logger: Logger; sanitize: MessageSanitizer; audit?: AuditFn }, connConfig?: CredentialConfigPort): void {
  const h = createCredentialsExecutors(store, opts, connConfig)
  registerHandler(IpcChannels.credentialsGetStatus, h.getStatus, 0)
  registerHandler(IpcChannels.credentialsSet, h.set, 1)
  registerHandler(IpcChannels.credentialsClear, h.clear, 1)
}
