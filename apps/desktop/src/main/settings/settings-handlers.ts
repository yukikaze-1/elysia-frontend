// src/main/settings/settings-handlers.ts
// 阶段 4 批次 B（spec §5.1 本地设置）：settings:load / settings:save 两通道 handler 装配。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）。
// settings:save 入参经 SettingsPatchSchema（unknown key 剥离、非法值拒绝），服务层 save 落盘前再 SettingsStateSchema.parse 兜底。
import { IpcChannels } from '@shared/contracts'
import { SettingsStateSchema } from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { settingsLoadSchema, settingsSaveSchema } from '../ipc/channels'
import type { SettingsService } from './settings-service'

export function registerSettingsHandlers(deps: { settings: SettingsService; sanitize: MessageSanitizer; logger: Logger }): void {
  const { settings, sanitize, logger } = deps
  registerHandler(IpcChannels.settingsLoad, createIpcHandler(settingsLoadSchema, SettingsStateSchema, () => settings.load(), { sanitize, channel: IpcChannels.settingsLoad, logger }), 0)
  registerHandler(IpcChannels.settingsSave, createIpcHandler(settingsSaveSchema, SettingsStateSchema, (patch) => settings.save(patch), { sanitize, channel: IpcChannels.settingsSave, logger }), 1)
}
