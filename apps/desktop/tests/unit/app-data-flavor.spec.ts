// tests/unit/app-data-flavor.spec.ts（node）
// 开发环境隔离（docs/19，2026-09-12）：Electron userData 的 dev/production 分仓单测。
//
// 背景（本 spec 的存在理由）：此前开发态与打包产物共用 `<appData>/Cyrene`——`pnpm dev` 会直接改写
// 用户正式版的凭据、settings、会话草稿、Live2D 模型目录与日志审计。本机同时跑多套 Electron 项目时，
// 任一项目的 dev 进程都可能踩到用户真实数据。风味后缀是这条隔离的唯一实现点，必须被钉死：
//   ① development 未打包 → Cyrene-Dev；test / production / 打包 → Cyrene（正式路径零改动）；
//   ② 风味必须在 installAppIdentity() 之前设定（单实例锁派生自 userData）；
//   ③ `app.setName('Cyrene')` 保持不变——身份唯一性由 userData 路径承担，改名会波及诊断导出与窗口标题。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** mock 状态（vi.hoisted：工厂在模块 import 前求值） */
const h = vi.hoisted(() => {
  const state = { appData: '/tmp/cyrene-appdata-flavor-test', name: '', userData: '' }
  const mockApp = {
    isPackaged: false,
    getPath: (key: string) => {
      if (key === 'appData') return state.appData
      if (key === 'userData') return state.userData
      throw new Error(`mock app.getPath 未覆盖：${key}`)
    },
    setName: (n: string) => { state.name = n },
    setPath: (key: string, value: string) => {
      if (key !== 'userData') throw new Error(`mock app.setPath 未覆盖：${key}`)
      state.userData = value
    }
  }
  return { state, mockApp }
})

vi.mock('electron', () => ({ app: h.mockApp }))

const {
  expectedUserDataBase,
  installAppIdentity,
  resetAppDataFlavorForTest,
  resolveAppDataFlavor,
  setAppDataFlavor
} = await import('../../src/main/app/lifecycle')

/** 平台无关期望（path.join 用宿主分隔符，直接手写 `a/Cyrene` 会在 Windows 上假红） */
const base = (dirName: string): string => join(h.state.appData, dirName)

beforeEach(() => {
  h.state.appData = join(tmpdir(), 'cyrene-appdata-flavor-test')
  h.state.name = ''
  h.state.userData = ''
  resetAppDataFlavorForTest()
})

afterEach(() => { resetAppDataFlavorForTest() })

describe('resolveAppDataFlavor', () => {
  it('未打包 development → dev', () => {
    expect(resolveAppDataFlavor('development', false)).toBe('dev')
  })

  it('打包（任何 mode）→ default（正式数据路径不因 mode 漂移）', () => {
    expect(resolveAppDataFlavor('development', true)).toBe('default')
    expect(resolveAppDataFlavor('production', true)).toBe('default')
    expect(resolveAppDataFlavor('test', true)).toBe('default')
  })

  it('未打包 test / production → default（集成 harness 有独立 appData 覆写门，不再叠后缀）', () => {
    expect(resolveAppDataFlavor('test', false)).toBe('default')
    expect(resolveAppDataFlavor('production', false)).toBe('default')
  })

  it('未知 mode → default（与 normalizeAppMode 的 fail-safe 同向）', () => {
    expect(resolveAppDataFlavor('staging', false)).toBe('default')
    expect(resolveAppDataFlavor('', false)).toBe('default')
  })
})

describe('expectedUserDataBase', () => {
  it('缺省风味（未显式设定）→ 生产同名目录，不意外读到 -Dev', () => {
    expect(expectedUserDataBase()).toBe(base('Cyrene'))
  })

  it('dev 风味 → <appData>/Cyrene-Dev', () => {
    setAppDataFlavor('dev')
    expect(expectedUserDataBase()).toBe(base('Cyrene-Dev'))
  })

  it('default 风味 → <appData>/Cyrene（与 dev 严格不同目录）', () => {
    setAppDataFlavor('default')
    const prod = expectedUserDataBase()
    setAppDataFlavor('dev')
    expect(prod).toBe(base('Cyrene'))
    expect(expectedUserDataBase()).not.toBe(prod)
  })
})

describe('installAppIdentity', () => {
  it('dev 风味：setPath(userData) = Cyrene-Dev；setName 恒为 Cyrene', () => {
    h.state.appData = join(tmpdir(), `cyrene-flavor-${process.pid}-dev`)
    setAppDataFlavor('dev')
    const ident = installAppIdentity()
    expect(ident.setPathOk).toBe(true)
    expect(h.state.userData).toBe(base('Cyrene-Dev'))
    // 应用名不随风味变化：诊断导出/窗口标题口径稳定，身份唯一性由 userData 承担
    expect(h.state.name).toBe('Cyrene')
  })

  it('default 风味：setPath(userData) = Cyrene（打包产物路径零改动）', () => {
    h.state.appData = join(tmpdir(), `cyrene-flavor-${process.pid}-prod`)
    setAppDataFlavor('default')
    const ident = installAppIdentity()
    expect(ident.setPathOk).toBe(true)
    expect(h.state.userData).toBe(base('Cyrene'))
  })
})
