import { z } from 'zod'
import { IpcChannels, BACKEND_TOKEN_KEY, type IpcResult } from '@shared/contracts'
import type { CredentialStatus } from '@shared/contracts'
import type { Logger } from '../diagnostics/logger'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { credentialStatusSchema, credentialsClearSchema, credentialsSetSchema } from '../ipc/channels'
import type { CredentialStore } from './credential-store'

type CredentialExecutor = (raw: unknown) => Promise<IpcResult<{ status: CredentialStatus; key: string }>>

/** 凭据生命周期元数据（无秘密值）写入日志：status 变化才记；before 须在变更前捕获 */
async function maybeLogStatusChange(logger: Logger, store: CredentialStore, key: string, before: string): Promise<void> {
  try {
    const after = await store.getStatus(key)
    if (before !== after) logger.info('credential:status-change', { key, from: before, to: after })
  } catch { /* 元数据日志失败不阻断 */ }
}

/** 纯工厂（可单测）：三个通道的 executor，不触碰 electron registry */
export function createCredentialsExecutors(store: CredentialStore, opts: { logger: Logger; sanitize: MessageSanitizer }): {
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
        const before = await store.getStatus(req.key)
        await store.setCredential(req.key, req.value)
        opts.logger.info('credential:set', { key: req.key }) // 操作事件（元数据，无秘密值）
        await maybeLogStatusChange(opts.logger, store, req.key, before)
        return { status: await store.getStatus(req.key), key: req.key }
      },
      { sanitize: opts.sanitize }),
    clear: createIpcHandler(credentialsClearSchema, credentialStatusSchema,
      async (req) => {
        const before = await store.getStatus(req.key)
        await store.clearCredential(req.key)
        opts.logger.info('credential:clear', { key: req.key }) // 操作事件（元数据，无秘密值）
        await maybeLogStatusChange(opts.logger, store, req.key, before)
        return { status: await store.getStatus(req.key), key: req.key }
      },
      { sanitize: opts.sanitize })
  }
}

export function registerCredentialsHandlers(store: CredentialStore, opts: { logger: Logger; sanitize: MessageSanitizer }): void {
  const h = createCredentialsExecutors(store, opts)
  registerHandler(IpcChannels.credentialsGetStatus, h.getStatus, 0)
  registerHandler(IpcChannels.credentialsSet, h.set, 1)
  registerHandler(IpcChannels.credentialsClear, h.clear, 1)
}
