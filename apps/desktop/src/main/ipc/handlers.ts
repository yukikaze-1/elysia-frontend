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
import type { BackendAdapter } from '../transport/backend-adapter'
import { registerModelHandlers } from '../models/model-handlers'
import { registerSettingsHandlers } from '../settings/settings-handlers'
import type { SettingsService } from '../settings/settings-service'
import { registerVoiceHandlers } from '../voice/voice-handlers'
import { registerLive2dHandlers } from './live2d-handlers'
import { registerToolHandlers } from './tool-handlers'
import type { Live2DModelRegistry } from '../live2d/model-registry'
import type { ToolService } from '../tools/tool-service'
import type { GrantStore } from '../tools/grant-store'
import { readAuditEvents } from '../tools/tool-history'
import { createIpcHandler } from './executor'
import { registerHandler } from './registry'
import { appInfoSchema } from './channels'
import { app } from 'electron'

export function registerHandlers(deps: {
  credentials: CredentialStore; logger: Logger; chat: ChatService; connectionConfig: ConnectionConfig; sessionStore: SessionStore;
  attachments: { svc: UploadService; media: MediaService }
  models: { adapter: BackendAdapter; media: MediaService }
  settings: { svc: SettingsService }
  voice: { adapter: BackendAdapter; media: MediaService }
  live2d: { registry: Live2DModelRegistry }
  tools: ToolService
  grants: GrantStore                 // 批次 C（D6C-12）：目录授权仓库（tool 四新通道数据源）
  auditDir: string                   // 批次 C（D6C-12）：审计目录（toolHistory 回读）
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
  registerModelHandlers({ adapter: deps.models.adapter, media: deps.models.media, sanitize, logger: deps.logger })
  registerSettingsHandlers({ settings: deps.settings.svc, sanitize, logger: deps.logger })
  registerVoiceHandlers({ adapter: deps.voice.adapter, media: deps.voice.media, sanitize, logger: deps.logger })
  registerLive2dHandlers({ registry: deps.live2d.registry, sanitize, logger: deps.logger })
  registerToolHandlers({ tools: deps.tools, sanitize, grants: deps.grants, history: readAuditEvents, auditDir: deps.auditDir })
}
