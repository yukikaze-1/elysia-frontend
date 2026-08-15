// tests/integration/settings-model-services-ipc.spec.ts
// Task 10：模型服务九通道经 IPC 往返（launchApp 恒 mock；mock 装配下模型方法无需先 connect）。
// 仿 history-viewer-ipc.spec.ts——渲染进程访问必须用 page.evaluate（main 进程无 window.desktopApi）。
// apiKey 一次性红线：save 响应/列表永不含 apiKey（ModelProfileSchema 亦 strip 未知键）。
import { describe, expect, it } from 'vitest'
import { closeApp, launchApp } from './helpers/app'

// page.evaluate 回调被序列化到渲染进程，类型仅编译期可见（运行时擦除），模块作用域类型可安全引用。
interface IpcModelApi {
  listModelProfiles: (i?: { type?: 'llm' | 'stt' | 'tts' }) => Promise<Array<Record<string, unknown>>>
  getActiveModelSelection: () => Promise<Record<string, string | undefined>>
  saveModelProfile: (c: Record<string, unknown>) => Promise<Record<string, unknown>>
  deleteModelProfile: (s: 'llm' | 'stt' | 'tts', n: string) => Promise<void>
}

describe('模型服务 IPC 契约（P4-A）', () => {
  it('models:list-profiles 返回归一化 Profile（内置 present）且 get-active-selection 返回对象', async () => {
    const launched = await launchApp()
    try {
      const out = await launched.page.evaluate(async () => {
        const a = (window as unknown as { desktopApi: IpcModelApi }).desktopApi
        const profiles = await a.listModelProfiles()
        const sel = await a.getActiveModelSelection()
        return {
          count: profiles.length,
          hasBuiltIn: profiles.some((p) => p.source === 'built_in'),
          hasCustom: profiles.some((p) => p.source === 'custom'),
          first: profiles[0] ?? null,
          anyApiKey: profiles.some((p) => Object.prototype.hasOwnProperty.call(p, 'apiKey')),
          sel
        }
      })
      expect(out.count).toBeGreaterThan(0)
      expect(out.hasBuiltIn).toBe(true)
      expect(out.hasCustom).toBe(false)                 // 初始无 custom
      expect(out.first).toMatchObject({ source: 'built_in', executionLocation: 'backend' })
      expect(out.anyApiKey).toBe(false)                 // 出参永不含凭据
      expect(typeof out.sel).toBe('object')
      expect(out.sel).not.toBeNull()
    } finally { await closeApp(launched) }
  })

  it('save→list 出现 custom（含 apiKey 一次性）；delete 非激活成功；响应无 apiKey 回显', async () => {
    const launched = await launchApp()
    try {
      const out = await launched.page.evaluate(async () => {
        const a = (window as unknown as { desktopApi: IpcModelApi }).desktopApi
        const saved = await a.saveModelProfile({ type: 'llm', name: 'it-custom', baseUrl: 'https://api.example.com', apiKey: 'k' })
        const afterSave = await a.listModelProfiles({ type: 'llm' })
        await a.deleteModelProfile('llm', 'it-custom')
        const afterDelete = await a.listModelProfiles({ type: 'llm' })
        return {
          savedHasApiKey: Object.prototype.hasOwnProperty.call(saved, 'apiKey'),
          savedCredential: saved.credentialStatus,
          inList: afterSave.some((p) => p.id === 'custom/it-custom'),
          listedCredential: afterSave.find((p) => p.id === 'custom/it-custom')?.credentialStatus,
          goneAfterDelete: !afterDelete.some((p) => p.id === 'custom/it-custom')
        }
      })
      expect(out.savedHasApiKey).toBe(false)            // save 响应无 apiKey 回显
      expect(out.savedCredential).toBe('configured')    // apiKey 已生效（一次性消费，不留明文）
      expect(out.inList).toBe(true)
      expect(out.listedCredential).toBe('configured')
      expect(out.goneAfterDelete).toBe(true)            // 非激活 custom 可删
    } finally { await closeApp(launched) }
  })
})
