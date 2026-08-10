import { z } from 'zod'
import { IpcChannels } from '@shared/contracts'
import { getAppInfo } from '../app/app-info'
import { createSanitizePublicMessage } from '../diagnostics/sanitize'
import { registerCredentialsHandlers } from '../credentials'
import type { CredentialStore } from '../credentials/credential-store'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from './executor'
import { registerHandler } from './registry'
import { appInfoSchema } from './channels'
import { app } from 'electron'

export function registerHandlers(deps: { credentials: CredentialStore; logger: Logger }): void {
  const sanitize = createSanitizePublicMessage({
    home: app.getPath('home'),
    userData: app.getPath('userData') // installAppIdentity 已 setPath('userData')——此处精确取，勿用字面量推导（单一事实来源）
  })
  registerHandler(IpcChannels.appGetInfo, createIpcHandler(z.undefined(), appInfoSchema, () => getAppInfo(), { sanitize }), 0)
  registerCredentialsHandlers(deps.credentials, { logger: deps.logger, sanitize })
}
