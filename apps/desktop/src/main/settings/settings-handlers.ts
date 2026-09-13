// src/main/settings/settings-handlers.ts
// 阶段 4 批次 B（spec §5.1 本地设置）：settings:load / settings:save 两通道 handler 装配。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）。
// settings:save 入参经 SettingsPatchSchema（unknown key 剥离、非法值拒绝），服务层 save 落盘前再 SettingsStateSchema.parse 兜底。
// 批次 C（FINAL-MED）：tools.grants patch 拒绝——GrantStore 为唯一写者（add/revoke/prune 全经工具权限流程含黑名单复核/ttl 白名单/审计），
//   平行写面会绕过「无永久 grant」保证（renderer 可注入 expiresAt:2^53 且不经校验）。fail-closed 拒绝而非静默剥离。
import { IpcChannels } from '@shared/contracts'
import { SettingsStateSchema } from '@shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { SETTINGS_FILE_NAME } from './settings-service'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { settingsLoadSchema, settingsSaveSchema } from '../ipc/channels'
import { ToolServiceError } from '../tools/tool-service'
import type { SettingsService } from './settings-service'
import type { SettingsState } from '@shared/contracts'

/**
 * Renderer 侧的设置读取（2026-09-13，M-19 残余）：**降级态下读也拒绝**。
 *
 * 降级（损坏文件隔离失败）意味着磁盘上那份设置**读不出来**，而内存里只有默认值。此时把默认值当
 * "当前设置"返回给 UI 是**谎报**——用户会以为设置被重置了，接着改一改、写一写，把未能隔离的原文件
 * 覆掉。故这条读路径直接抛 `PERSISTENCE_DEGRADED`：Renderer 的 `settings.hydrate` 早已 fail-open
 * （保留默认值、不阻塞启动），现在多了一步"把失败记下来并在设置页显示"。
 *
 * **启动期不受影响**：`main/index.ts` 走的是 `settings.load()` 本身（不经本函数），仍不抛。
 * 抽成具名导出以便单测直击这条规则（不经 ipcMain）。
 */
export async function loadSettingsForRenderer(settings: SettingsService): Promise<SettingsState> {
  const degraded = settings.getLastError()
  if (degraded !== undefined) {
    throw new CyreneError(
      CyreneErrorCode.PERSISTENCE_DEGRADED,
      `持久化已降级（${SETTINGS_FILE_NAME}：${degraded}），已拒绝读取以保留现场`
    )
  }
  return settings.load()
}

export function registerSettingsHandlers(deps: { settings: SettingsService; sanitize: MessageSanitizer; logger: Logger }): void {
  const { settings, sanitize, logger } = deps
  registerHandler(IpcChannels.settingsLoad, createIpcHandler(settingsLoadSchema, SettingsStateSchema, () => loadSettingsForRenderer(settings), { sanitize, channel: IpcChannels.settingsLoad, logger }), 0)
  registerHandler(IpcChannels.settingsSave, createIpcHandler(settingsSaveSchema, SettingsStateSchema, (patch) => {
    if (patch.tools !== undefined) throw new ToolServiceError('GRANT_WRITE_DENIED', '目录授权仅经工具权限流程管理（授权/撤销在权限确认与设置页授权管理）')   // FINAL-MED：平行写面关闭
    return settings.save(patch)
  }, { sanitize, channel: IpcChannels.settingsSave, logger }), 1)
}
