// src/main/settings/settings-handlers.ts
// 阶段 4 批次 B（spec §5.1 本地设置）：settings:load / settings:save 两通道 handler 装配。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）。
// settings:save 入参经 SettingsPatchSchema（unknown key 剥离、非法值拒绝），服务层 save 落盘前再 SettingsStateSchema.parse 兜底。
// 批次 C（FINAL-MED）：tools.grants patch 拒绝——GrantStore 为唯一写者（add/revoke/prune 全经工具权限流程含黑名单复核/ttl 白名单/审计），
//   平行写面会绕过「无永久 grant」保证（renderer 可注入 expiresAt:2^53 且不经校验）。fail-closed 拒绝而非静默剥离。
import { IpcChannels } from '@shared/contracts'
import { SettingsStateSchema } from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { settingsLoadSchema, settingsSaveSchema } from '../ipc/channels'
import { ToolServiceError } from '../tools/tool-execution-contract'
import type { SettingsService } from './settings-service'

export function registerSettingsHandlers(deps: { settings: SettingsService; sanitize: MessageSanitizer; logger: Logger }): void {
  const { settings, sanitize, logger } = deps
  // 降级拒绝读取的规则在 `SettingsService.loadForRenderer()`（放服务上而非本模块：handler 经 ipc/registry
  // 间接 import electron，单测 import 它会触发 Electron 二进制懒下载——M-40 记过这个坑）。
  registerHandler(IpcChannels.settingsLoad, createIpcHandler(settingsLoadSchema, SettingsStateSchema, () => settings.loadForRenderer(), { sanitize, channel: IpcChannels.settingsLoad, logger }), 0)
  registerHandler(IpcChannels.settingsSave, createIpcHandler(settingsSaveSchema, SettingsStateSchema, (patch) => {
    if (patch.tools !== undefined) throw new ToolServiceError('GRANT_WRITE_DENIED', '目录授权仅经工具权限流程管理（授权/撤销在权限确认与设置页授权管理）')   // FINAL-MED：平行写面关闭
    return settings.save(patch)
  }, { sanitize, channel: IpcChannels.settingsSave, logger }), 1)
}
