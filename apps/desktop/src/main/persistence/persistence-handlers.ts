// 阶段 3 G2 持久化四通道（spec §4.2）：hydrate / persist-session / cache-messages / open-external。
import { z } from 'zod'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import { PersistSessionResultSchema, SessionPersistenceStateSchema } from '@shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { shell } from 'electron'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import {
  chatCacheMessagesSchema, chatHydratePersistenceSchema, chatOpenExternalSchema, chatPersistSessionSchema
} from '../ipc/channels'
import type { SessionStore } from './session-store'

/** 外部链接：http/https 白名单 + new URL 校验 + ≤2048 字符；非法 scheme 直接拒绝（含 file:/cyrene:/javascript:） */
export function openExternal(url: string): void {
  if (url.length > 2048) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '外部链接过长')
  let u: URL
  try { u = new URL(url) } catch { throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '外部链接非法') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '仅允许 http/https 外部链接')
  }
  void shell.openExternal(u.toString())
}

export function registerPersistenceHandlers(deps: { sessionStore: SessionStore; sanitize: MessageSanitizer; logger: Logger }): void {
  const { sessionStore, sanitize, logger } = deps
  const handle = <TReq, TRes>(
    requestSchema: z.ZodType<TReq>, responseSchema: z.ZodType<TRes>,
    fn: (req: TReq) => TRes | Promise<TRes>, channel: IpcChannelName
  ): ((raw: unknown) => Promise<IpcResult<TRes>>) =>
    createIpcHandler(requestSchema, responseSchema, fn, { sanitize, channel, logger })

  registerHandler(IpcChannels.chatHydratePersistence, handle(chatHydratePersistenceSchema, SessionPersistenceStateSchema, () => sessionStore.hydrate(), IpcChannels.chatHydratePersistence), 0)
  registerHandler(IpcChannels.chatPersistSession, handle(chatPersistSessionSchema, PersistSessionResultSchema, (req) => sessionStore.persistSession(req), IpcChannels.chatPersistSession), 1)
  registerHandler(IpcChannels.chatCacheMessages, handle(chatCacheMessagesSchema, z.undefined(), (req) => sessionStore.cacheMessages(req), IpcChannels.chatCacheMessages), 1)
  registerHandler(IpcChannels.appOpenExternal, handle(chatOpenExternalSchema, z.undefined(), (req) => openExternal(req.url), IpcChannels.appOpenExternal), 1)
}
