import { describe, expect, it } from 'vitest'
import { normalizeAppMode, resolveAppConfig, shouldUseViteDevServer } from '../../src/main/config/env'
import { resolveBackendMode } from '../../src/main/config/backend-mode'

describe('normalizeAppMode', () => {
  it('development/test 原样保留', () => {
    expect(normalizeAppMode('development')).toBe('development')
    expect(normalizeAppMode('test')).toBe('test')
  })
  it('未知/缺失一律归 production（fail-safe）', () => {
    expect(normalizeAppMode('production')).toBe('production')
    expect(normalizeAppMode('staging')).toBe('production')
    expect(normalizeAppMode(undefined)).toBe('production')
  })
})

describe('resolveAppConfig', () => {
  it('devToolsAllowed = !isPackaged（打包恒 false，与 mode 无关）', () => {
    expect(resolveAppConfig('development', false).devToolsAllowed).toBe(true)
    expect(resolveAppConfig('test', false).devToolsAllowed).toBe(true)
    expect(resolveAppConfig('production', false).devToolsAllowed).toBe(true) // 未打包仍允许（开发便利）
    expect(resolveAppConfig('production', true).devToolsAllowed).toBe(false)
    expect(resolveAppConfig('development', true).devToolsAllowed).toBe(false) // --mode development 的 packaged 产物也恒关
  })
  it('env 无法把 devToolsAllowed 翻成 true（打包时）', () => {
    expect(resolveAppConfig('development', true, { CYRENE_DEVTOOLS: 'true' }).devToolsAllowed).toBe(false)
  })
  it('logLevel：打包恒 info，不读 env（任何 mode，含 --mode test packaged）', () => {
    expect(resolveAppConfig('production', true, { CYRENE_LOG_LEVEL: 'debug' }).logLevel).toBe('info')
    expect(resolveAppConfig('test', true, { CYRENE_LOG_LEVEL: 'debug' }).logLevel).toBe('info')
  })
  it('logLevel：非打包默认随 mode（prod=info，dev/test=debug），合法 env 可覆盖', () => {
    expect(resolveAppConfig('development', false).logLevel).toBe('debug')
    expect(resolveAppConfig('test', false, { CYRENE_LOG_LEVEL: 'warn' }).logLevel).toBe('warn')
    expect(resolveAppConfig('production', false, { CYRENE_LOG_LEVEL: 'warn' }).logLevel).toBe('warn')
  })
  it('logLevel：非法 env 值回退 mode 默认（无守卫类型强转）', () => {
    expect(resolveAppConfig('test', false, { CYRENE_LOG_LEVEL: 'garbage' }).logLevel).toBe('debug')
    expect(resolveAppConfig('production', false, { CYRENE_LOG_LEVEL: 'garbage' }).logLevel).toBe('info')
  })
  it('协议常量固定 cyrene/renderer', () => {
    const c = resolveAppConfig('production', true)
    expect(c.protocolName).toBe('cyrene')
    expect(c.rendererHost).toBe('renderer')
  })
})

describe('shouldUseViteDevServer', () => {
  it('未打包 + 有 ELECTRON_RENDERER_URL → true（electron-vite dev，含 --mode test）', () => {
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(true)
  })
  it('打包恒 false（残留 dev env 不能把打包产物劫持到 http/无严格 CSP）', () => {
    expect(shouldUseViteDevServer(true, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(false)
  })
  it('无 ELECTRON_RENDERER_URL → false（test/production 构建、--mode development 直启）', () => {
    expect(shouldUseViteDevServer(false, {})).toBe(false)
  })
  it('畸形/非 http 残留 env → false（走 cyrene://，不白窗不劫持）', () => {
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'http://' })).toBe(false)
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'not-a-url' })).toBe(false)
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'file:///x' })).toBe(false)
  })
})

describe('resolveBackendMode', () => {
  it('packaged → real（无视 env，mock env 不能翻成 mock）', () => {
    expect(resolveBackendMode(true, { CYRENE_BACKEND: 'mock' })).toBe('real')
    expect(resolveBackendMode(true, {})).toBe('real')
  })
  it('未打包 + CYRENE_BACKEND=mock → mock（显式演示模式）', () => {
    expect(resolveBackendMode(false, { CYRENE_BACKEND: 'mock' })).toBe('mock')
  })
  it('未打包默认 → real（CYRENE_BACKEND=real 显式或缺失都 real）', () => {
    expect(resolveBackendMode(false, {})).toBe('real')
    expect(resolveBackendMode(false, { CYRENE_BACKEND: 'real' })).toBe('real')
  })
  it('未打包 + 未知值 → real（fail-safe，不识别即 real）', () => {
    expect(resolveBackendMode(false, { CYRENE_BACKEND: 'staging' })).toBe('real')
  })
})
