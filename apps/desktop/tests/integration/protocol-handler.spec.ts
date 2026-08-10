// tests/integration/protocol-handler.spec.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { symlinkSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
const rendererRoot = join(__dirname, '../../out/renderer') // tests/integration → apps/desktop/out/renderer
const outside = mkdtempSync(join(tmpdir(), 'cy-f1-out-'))
const escapeLink = join(rendererRoot, 'escape-link')
const escapeDirIndex = join(rendererRoot, 'escape-dir', 'index.html')
const emptyDir = join(rendererRoot, 'empty-dir')

beforeAll(async () => {
  mkdirSync(join(rendererRoot, 'escape-dir'), { recursive: true })
  mkdirSync(emptyDir)
  writeFileSync(join(outside, 'secret.txt'), 'secret')           // 先写 target 再建 symlink（Windows 可移植）
  symlinkSync(join(outside, 'secret.txt'), escapeLink)           // 文件级 symlink → 外部
  symlinkSync(join(outside, 'secret.txt'), escapeDirIndex)       // 目录内 index.html → 外部
  launched = await launchApp()
})
afterAll(async () => {
  if (launched) await closeApp(launched) // beforeAll 失败时 launched 未赋值，防二次抛
  rmSync(escapeLink, { force: true }); rmSync(join(rendererRoot, 'escape-dir'), { recursive: true, force: true })
  rmSync(emptyDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
})

const fetchStatus = (url: string): Promise<number> =>
  launched.app.evaluate(async ({ net }, u) => (await net.fetch(u)).status, url)

describe('protocol handler（F1 拒绝分支实测）', () => {
  it('正常 index.html → 200 + 严格 CSP', async () => {
    const res = await launched.app.evaluate(async ({ net }) => {
      const r = await net.fetch('cyrene://renderer/index.html')
      return { status: r.status, csp: r.headers.get('content-security-policy') }
    })
    expect(res.status).toBe(200)
    expect(res.csp).toContain("default-src 'none'")
    expect(res.csp).toContain("frame-src 'none'")
  })
  it('非 renderer host → 404', async () => expect(await fetchStatus('cyrene://evil-host/')).toBe(404))
  it('空 host → 404（400 为防御性死代码不测）', async () => {
    // 实施期事实：main 进程 net.fetch('cyrene://') 在 URL loader 层抛 TypeError: Invalid URL（空 host 非合法 standard URL）
    // 而非进入 handler 返 404。按 spec §5.2/C-G6 try/catch 兼容两种落点：抛 → 视为 404。
    const status = await launched.app.evaluate(async ({ net }, u) => {
      try { return (await net.fetch(u)).status } catch { return 404 }
    }, 'cyrene://')
    expect(status).toBe(404)
  })
  it('路径穿越 ..%2f → 403', async () => expect(await fetchStatus('cyrene://renderer/..%2f..%2fetc%2fpasswd')).toBe(403))
  it('孤立 % → 403（decode 抛错）', async () => expect(await fetchStatus('cyrene://renderer/%')).toBe(403))
  it('缺失文件 → 404', async () => expect(await fetchStatus('cyrene://renderer/nonexistent.js')).toBe(404))
  it('空目录无 index.html → 404', async () => expect(await fetchStatus('cyrene://renderer/empty-dir/')).toBe(404))
  it('文件 symlink 逃逸 → 403', async () => expect(await fetchStatus('cyrene://renderer/escape-link')).toBe(403))
  it('目录内 index.html symlink 逃逸 → 403', async () => expect(await fetchStatus('cyrene://renderer/escape-dir/')).toBe(403))
})
