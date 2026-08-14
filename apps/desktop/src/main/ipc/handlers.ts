import { z } from 'zod'
import { IpcChannels } from '@shared/contracts'
import { getAppInfo } from '../app/app-info'
import { createSanitizePublicMessage } from '../diagnostics/sanitize'
import { registerCredentialsHandlers } from '../credentials'
import type { CredentialStore } from '../credentials/credential-store'
import type { Logger } from '../diagnostics/logger'
import type { AuditEvent } from '../diagnostics/audit'
import { registerChatHandlers } from '../chat/chat-handlers'
import type { ChatService } from '../chat/chat-service'
import type { ConnectionConfig } from '../connection/connection-config'
import { registerPersistenceHandlers } from '../persistence/persistence-handlers'
import type { SessionStore } from '../persistence/session-store'
import { registerAttachmentsHandlers } from '../attachments/attachments-handlers'
import type { UploadService } from '../attachments/upload-service'
import type { MediaService } from '../attachments/media-service'
import { createIpcHandler } from './executor'
import { registerHandler } from './registry'
import { appInfoSchema } from './channels'
import { app } from 'electron'

export function registerHandlers(deps: {
  credentials: CredentialStore; logger: Logger; chat: ChatService; connectionConfig: ConnectionConfig; sessionStore: SessionStore;
  attachments: { svc: UploadService; media: MediaService }
  audit?: (event: Omit<AuditEvent, 'ts'>) => void
}): void {
  const sanitize = createSanitizePublicMessage({
    home: app.getPath('home'),
    userData: app.getPath('userData') // installAppIdentity 已 setPath('userData')——此处精确取，勿用字面量推导（单一事实来源）
  })
  registerHandler(IpcChannels.appGetInfo, createIpcHandler(z.undefined(), appInfoSchema, () => getAppInfo(), { sanitize }), 0)
  registerCredentialsHandlers(deps.credentials, { logger: deps.logger, sanitize, audit: deps.audit }, deps.connectionConfig)
  registerChatHandlers({ svc: deps.chat, sanitize, logger: deps.logger })
  registerPersistenceHandlers({ sessionStore: deps.sessionStore, sanitize, logger: deps.logger })
  registerAttachmentsHandlers({ svc: deps.attachments.svc, media: deps.attachments.media, sanitize, logger: deps.logger })
}
