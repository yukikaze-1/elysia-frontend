// tests/integration/h01-fileref-probe.spec.ts
// S5-B2（H-01）**取证探针**：直接量出 `webUtils.getPathForFile` 对**页面主世界 JS 构造的 File** 返回什么。
//
// 为什么必须这样量：`toIpcDescriptor`（preload）用字段白名单构造 IPC 描述符，Renderer 递上来的 `path` 会被丢弃；
// 唯一能进入 `UploadFileDescriptor.path` 的通道就是 `webUtils.getPathForFile(f.file)`。于是
// 「被攻陷 Renderer 能否读任意本地文件」等价于本探针的结论：
//   · 合成 File 能被解析出真实路径 ⇒ 现有防线不足（无需用户拖拽即可指认黑名单外任意路径）；
//   · 解析为空串 ⇒ Renderer 只能操作「真的从 OS 拖入/选中」的文件，残余风险显著更低。
//
// 手法：Main 侧建一个临时 BrowserWindow，**同一个 preload 文件加载两遍**——
//   ① 应用 preload（`out/preload/index.js`）：经 contextBridge 暴露的 `desktopApi` 是主世界可见面，
//      用它走**真实产品路径**（Renderer → preload → getPathForFile → IPC → Main）；
//   ② 诊断 preload（临时目录里生成）：只把 `webUtils.getPathForFile` 原样暴露出来，直接读它的返回值。
// 两个窗口都用后即销毁；**不改任何产品代码、不新增防御**——测的就是今天的真实边界。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, closeApp } from './helpers/app'

describe('S5-B2 探针：合成 File 能否被 getPathForFile 解析为真实路径', () => {
  it('主世界构造 File + DataTransfer → getPathForFile 返回值与产品路径行为', async () => {
    // ① 造一个**真实存在**的探针文件（名字带 PROBE 标记，便于事后检索）
    const dir = mkdtempSync(join(tmpdir(), 'cy-h01-probe-'))
    const probeFile = join(dir, 'H01-PROBE-secret.txt')
    writeFileSync(probeFile, 'H01-PROBE-CONTENT')

    // ② 诊断 preload：把 getPathForFile 原样暴露（仅本探针用，写在临时目录，不入仓库）
    const diagPreloadDir = mkdtempSync(join(tmpdir(), 'cy-h01-preload-'))
    const diagPreload = join(diagPreloadDir, 'diag-preload.cjs')
    writeFileSync(diagPreload, [
      "const { contextBridge, webUtils } = require('electron')",
      'contextBridge.exposeInMainWorld(\'__cyreneDiag\', {',
      "  getPathForFile: (f) => { try { return webUtils.getPathForFile(f) } catch (e) { return 'THREW:' + String(e) } },",
      '})',
      '',
    ].join('\n'))

    const launched = await launchApp()
    const { app, page, userData } = launched
    try {
      await page.getByRole('button', { name: /REAL|MOCK/ }).first().click()
      await page.getByRole('button', { name: '连接', exact: true }).click()
      await expect.poll(
        () => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''),
        { timeout: 15000, interval: 200 }
      ).toContain('已连接')

      // ③ A/B/C/D 四组：在应用页主世界里跑（`desktopApi` 是主世界可见面 ⇒ 攻击面一致）
      const observed = await page.evaluate(async ({ probeFile }) => {
        type ProbeApi = { attachmentsValidate: (input: { files: Array<Record<string, unknown>> }) => Promise<unknown> }
        const api = (window as unknown as { desktopApi?: ProbeApi }).desktopApi

        // 关键手法：完全不碰真实文件选择——纯 JS 构造 File，再塞进真实 DataTransfer
        const dt = new DataTransfer()
        dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'H01-PROBE-secret.txt', { type: 'text/plain' }))
        const synthetic = dt.files[0]

        const base = { name: 'H01-PROBE-secret.txt', size: 4, mediaType: 'text/plain', source: 'drag_drop' as const }
        const call = async (files: Array<Record<string, unknown>>): Promise<unknown> => {
          if (!api) return 'no-api'
          try { return await api.attachmentsValidate({ files }) }
          catch (e) { return `threw: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
        }

        // A：Renderer 主动递伪造 path（`AttachmentInputFile` 无该字段；验证白名单是否丢弃它）
        const forgedPath = await call([{ ...base, localId: 'A', path: probeFile }])
        // B：合成 File（无 bytes）——若 getPathForFile 给出真实路径，这里会走到 realpath+黑名单分支
        const syntheticNoBytes = await call([{ ...base, localId: 'B', file: synthetic }])
        // C：合成 File + bytes（拖入回退形态）
        const syntheticWithBytes = await call([{ ...base, localId: 'C', file: synthetic, bytes: new ArrayBuffer(4) }])
        // D：对照——纯 bytes 分支（Renderer 已有数据，不涉及读盘）
        const bytesOnly = await call([{ localId: 'D', name: 'x.bin', size: 4, mediaType: 'application/octet-stream', source: 'paste', bytes: new Uint8Array([1, 2, 3, 4]) }])

        return { hasApi: !!api, forgedPath, syntheticNoBytes, syntheticWithBytes, bytesOnly }
      }, { probeFile })

      // ④ 直接读 getPathForFile 的返回值（诊断窗口；同一 preload 语义）
      const pathForFile = await app.evaluate(async ({ BrowserWindow }, { preloadPath, }) => {
        const win = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false } })
        await win.loadURL('about:blank')
        try {
          const out: unknown = await win.webContents.executeJavaScript(`(() => {
            const dt = new DataTransfer()
            dt.items.add(new File([new Uint8Array([1,2,3,4])], 'H01-PROBE-secret.txt', { type: 'text/plain' }))
            const synthetic = dt.files[0]
            const diag = window.__cyreneDiag
            return {
              hasDiag: !!diag,
              syntheticFromDataTransfer: diag ? diag.getPathForFile(synthetic) : 'no-diag',
              plainConstructed: diag ? diag.getPathForFile(new File([new Uint8Array([9])], 'plain.txt')) : 'no-diag',
              directConstructor: diag ? diag.getPathForFile(Object.create(File.prototype)) : 'no-diag',
            }
          })()`)
          return out
        } catch (e: unknown) { return { execFail: String(e) } }
        finally { win.destroy() }
      }, { preloadPath: diagPreload })

      // 证据输出（本轮取证用；同时把关键读数写进断言，见下）
      console.log('[H01-PROBE page]', JSON.stringify(observed, null, 2))
      console.log('[H01-PROBE getPathForFile]', JSON.stringify(pathForFile, null, 2))

      // ⚠️ **常驻回归门禁（S5-B2 承重断言）**：fileRef 改造的信任锚虽然换成了 Main 自己的表，
      // 但「对端只能引用 Main 登记过的文件」这条链条**仍然**依赖 `getPathForFile` 不解析合成 File——
      // preload 会把它的**任何**非空返回值登记进表。若未来 Electron 版本开始把合成 File 解析成真实路径，
      // 表里就会出现攻击者指定的路径 ⇒ 防线静默失效。
      // 故此处**必须硬断言**（而非只留读数）：上游行为一变，本条立即红。
      expect(pathForFile, '诊断窗口必须真的拿到 getPathForFile').toHaveProperty('hasDiag', true)
      const paths = pathForFile as { syntheticFromDataTransfer?: unknown; plainConstructed?: unknown }
      expect(paths.syntheticFromDataTransfer, 'DataTransfer 里的合成 File 必须解析为空串——否则 preload 会把攻击者指定的路径登记进 fileRef 表').toBe('')
      expect(paths.plainConstructed, '直接构造的 File 必须解析为空串').toBe('')
      // 产品路径侧：伪造 path 不抵达 IPC（A/C 组都只落进 bytes 分支或被 schema 拒），合成 File 从不落进 fileRef 分支
      expect(observed.hasApi, 'desktopApi 必须存在，否则本探针不成立').toBe(true)
      expect(observed.syntheticNoBytes, '既无路径也无 bytes 的合成 File 必须被 schema 拒').toMatch(/SCHEMA_VALIDATION_FAILED/)
      expect(observed.syntheticWithBytes, '合成 File 只走 bytes 分支（不产生 path/fileRef）').toEqual([{ localId: 'C', ok: true, kind: 'file' }])
    } finally {
      try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
      rmSync(dir, { recursive: true, force: true })
      rmSync(diagPreloadDir, { recursive: true, force: true })
    }
  }, 90_000)
})
