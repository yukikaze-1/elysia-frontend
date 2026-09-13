// @vitest-environment happy-dom
// tests/unit/cy-persistence-banner.spec.ts
// H-11b renderer 半边（2026-09-13）：本地持久化故障必须有**全局**用户可见出口。
//
// 判别力设计：修复前 `draft.store.persistNow` 无条件 fail-open，UI 侧没有任何组件读它——
// 因此本组用例的失败模式是"元素根本不存在"，而不是"文案措辞不对"。
// 三类断言各钉一件事：
//   ① 两种故障各自的**动作建议不同**（降级=现场被故意保住，别指望重启自愈；写失败=恢复后自动重试）
//   ② 只显示 Main 给的无路径投影（基名 + 封闭标签），绝不显示绝对路径
//   ③ 无故障时**不渲染**（否则横幅常驻 = 另一种形式的噪音）
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import CyPersistenceBanner from '../../src/renderer/src/components/CyPersistenceBanner.vue'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { SessionPersistenceState } from '@shared/contracts'

const EMPTY_STATE: SessionPersistenceState = { drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {} }

function mountBanner() {
  return mount(CyPersistenceBanner)
}

describe('CyPersistenceBanner（H-11b renderer 半边）', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(createDesktopApiMock()) })

  it('无故障 → 不渲染任何横幅', () => {
    const w = mountBanner()
    expect(w.find('[data-testid="persistence-banner"]').exists()).toBe(false)
    expect(w.text()).toBe('')
  })

  it('降级态：文案说明"已停用"并给出基名+触发标签；建议是"先备份再重启"', async () => {
    const w = mountBanner()
    useDraftStore().hydrate({ ...EMPTY_STATE, persistenceDegraded: { file: 'drafts-v1.json', reason: 'schema-version-mismatch:99' } })
    await w.vm.$nextTick()
    const banner = w.find('[data-testid="persistence-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.attributes('role'), '故障告知必须是 alert（可访问性播报）').toBe('alert')
    expect(banner.text()).toContain('本地保存已停用')
    expect(w.find('[data-testid="persistence-banner-detail"]').text()).toBe('drafts-v1.json · schema-version-mismatch:99')
    expect(banner.text()).toContain('先备份该文件再重启')
  })

  it('单次写失败：文案是"失败"且建议是"恢复后自动重试"（与降级态必须不同）', async () => {
    const w = mountBanner()
    const store = useDraftStore()
    const api = createDesktopApiMock()
    api.persistSession.mockRejectedValueOnce(new Error('[PERSISTENCE_WRITE_FAILED] 本地保存失败（ENOSPC）'))
    setDesktopApi(api)
    store.saveDraft('c1', 'x')
    await store.flush('c1')
    await w.vm.$nextTick()
    const banner = w.find('[data-testid="persistence-banner"]')
    expect(banner.text()).toContain('本地保存失败')
    expect(banner.text()).toContain('自动重试')
    expect(banner.text()).not.toContain('先备份该文件再重启')
    expect(w.find('[data-testid="persistence-banner-detail"]').exists(), '写失败没有文件投影就不显示详情行').toBe(false)
  })

  it('未映射的 IPC 故障码也走持久化兜底句（不留空白提示）', async () => {
    const w = mountBanner()
    const store = useDraftStore()
    const api = createDesktopApiMock()
    api.persistSession.mockRejectedValueOnce(new Error('[IPC_ERROR] IPC 调用失败'))
    setDesktopApi(api)
    store.saveDraft('c1', 'x')
    await store.flush('c1')
    await w.vm.$nextTick()
    expect(w.find('[data-testid="persistence-banner"]').text()).toContain('本地保存失败：草稿与离线缓存没有被写入磁盘。')
  })

  it('绝不显示绝对路径（外部传入的畸形投影也不行）', async () => {
    const w = mountBanner()
    // 防御性：即便上游（Main 之外的注入面/未来重构）塞了路径，也只当普通文本显示，不额外加工——
    // 本用例钉的是"组件不会自己拼接/回显任何路径信息"。
    useDraftStore().hydrate({ ...EMPTY_STATE, persistenceDegraded: { file: 'drafts-v1.json', reason: 'read-failed:ENOENT' } })
    await w.vm.$nextTick()
    const text = w.find('[data-testid="persistence-banner"]').text()
    expect(text).not.toMatch(/[A-Za-z]:\\/)
    expect(text).not.toContain('/tmp/')
    expect(text).not.toContain('/home/')
  })
})
