// tests/unit/live2d-registry.spec.ts
// 阶段 5 批次 A（A3，spec D5A-07）：Main 模型注册表 + manifest 完整性工具单测。
// 内存临时目录 + 自建 fixture（computeIntegrity 生成 integrity.json 先于 registry 构造写盘）。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeIntegrity, type IntegrityEntry } from '../../src/main/live2d/manifest'
import { Live2DModelRegistry } from '../../src/main/live2d/model-registry'

// 并发 pending 共享断言：拦截 verifyIntegrityAgainst（registry 唯一 hash 复核入口），计数证明同模型并发仅跑一次。
const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn() }))
vi.mock('../../src/main/live2d/manifest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/main/live2d/manifest')>()
  return {
    ...mod,
    verifyIntegrityAgainst: (modelDir: string, entries: IntegrityEntry[]) => {
      verifySpy(modelDir, entries)
      return mod.verifyIntegrityAgainst(modelDir, entries)
    }
  }
})

const roots: string[] = []
function tmpModelsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cy-live2d-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

/** 装配合规模型目录：写模型文件（+可选 preview）+ manifest.json → computeIntegrity → integrity.json */
async function installModel(root: string, cfg: {
  id: string
  displayName?: string
  licenseRef?: string   // 缺省 → manifest 无 licenseRef（整目录跳过用例）
  version?: string
  preview?: boolean
  modelData?: Buffer
}): Promise<string> {
  const dir = join(root, cfg.id)
  mkdirSync(dir, { recursive: true })
  const modelFile = 'model3.json'
  writeFileSync(join(dir, modelFile), cfg.modelData ?? Buffer.from('model-data'))
  if (cfg.preview) writeFileSync(join(dir, 'preview.png'), Buffer.from('preview-bytes'))
  const manifest: Record<string, unknown> = {
    id: cfg.id,
    displayName: cfg.displayName ?? cfg.id,
    modelFile,
    integrityManifest: 'integrity.json'
  }
  if (cfg.licenseRef !== undefined) manifest.licenseRef = cfg.licenseRef
  if (cfg.version !== undefined) manifest.version = cfg.version
  if (cfg.preview) manifest.preview = 'preview.png'
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  const entries = await computeIntegrity(dir)
  writeFileSync(join(dir, 'integrity.json'), JSON.stringify({ files: entries }))
  return dir
}

describe('manifest 工具（computeIntegrity）', () => {
  it('递归相对路径 / 分隔；跳过隐藏项/空目录；排除 manifest.json/integrity.json 自身', async () => {
    const root = tmpModelsRoot()
    const dir = join(root, 'm')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    mkdirSync(join(dir, 'empty'), { recursive: true })
    writeFileSync(join(dir, 'a.moc3'), 'a')
    writeFileSync(join(dir, 'sub', 'b.tex'), 'b')
    writeFileSync(join(dir, 'manifest.json'), '{}')
    writeFileSync(join(dir, 'integrity.json'), '{}')
    writeFileSync(join(dir, '.hidden'), 'h')
    const entries = await computeIntegrity(dir)
    const paths = entries.map((e) => e.path).sort()
    expect(paths).toEqual(['a.moc3', 'sub/b.tex'])
    expect(paths.some((p) => p.includes('manifest.json') || p.includes('integrity.json') || p.startsWith('.'))).toBe(false)
  })
})

describe('listInstalledModels 两级可用性（D5A-07）', () => {
  it('manifest 缺 licenseRef / id 非法 → 整目录跳过不列出', async () => {
    const root = tmpModelsRoot()
    await installModel(root, { id: 'no-license' }) // 无 licenseRef
    const badDir = join(root, 'bad-id')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ id: 'bad id!', displayName: 'x', modelFile: 'm', integrityManifest: 'i' }))
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list).toHaveLength(0)
  })

  it('合法但 integrity 覆盖的模型文件缺失 → 列出且 available=false（reason missing_file）', async () => {
    const root = tmpModelsRoot()
    const dir = await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    rmSync(join(dir, 'model3.json'))
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'ok', available: false, reason: 'missing_file' })
  })

  it('合法但 integrity 覆盖的模型文件尺寸不符 → 列出且 available=false（reason size_mismatch）', async () => {
    const root = tmpModelsRoot()
    const dir = await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    writeFileSync(join(dir, 'model3.json'), Buffer.from('x')) // 尺寸不同
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'ok', available: false, reason: 'size_mismatch' })
  })

  it('preview 缺失 → 仍 available=true（豁免，UI 占位）', async () => {
    const root = tmpModelsRoot()
    const dir = await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt', preview: true })
    rmSync(join(dir, 'preview.png')) // integrity.json 仍含 preview.png 条目，但文件已删
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'ok', available: true })
    expect(list[0].reason).toBeUndefined()
  })

  it('integrity.json 缺失 → fail-closed available=false（reason missing_file）', async () => {
    const root = tmpModelsRoot()
    const dir = await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    rmSync(join(dir, 'integrity.json'))
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list[0]).toMatchObject({ id: 'ok', available: false, reason: 'missing_file' })
  })
})

describe('listInstalledModels 返回字段', () => {
  it('version/preview/licenseRef/integrityState 正确', async () => {
    const root = tmpModelsRoot()
    await installModel(root, { id: 'haru', displayName: 'Haru', licenseRef: 'LICENSE.txt', version: '1.2.3', preview: true })
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      id: 'haru',
      displayName: 'Haru',
      preview: 'preview.png',
      version: '1.2.3',
      available: true,
      licenseRef: 'LICENSE.txt',
      integrityState: 'unverified'
    })
  })

  it('无 version/preview → version 缺省 0 / preview null', async () => {
    const root = tmpModelsRoot()
    await installModel(root, { id: 'plain', licenseRef: 'LICENSE.txt' })
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list).toMatchObject([{ id: 'plain', version: '0', preview: null, available: true, integrityState: 'unverified' }])
  })

  it('preview 为 null / preview.png 均为合法摘要（Live2DModelSummarySchema 校验通过）', async () => {
    const root = tmpModelsRoot()
    await installModel(root, { id: 'a', licenseRef: 'LICENSE.txt', preview: true })
    await installModel(root, { id: 'b', licenseRef: 'LICENSE.txt' })
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    // schema 与契约镜像（ipc-response 同形）——preview null 与字符串都放行
    const { Live2DModelSummarySchema } = await import('@shared/schemas')
    for (const s of list) expect(Live2DModelSummarySchema.safeParse(s).success).toBe(true)
  })
})

describe('resolveModelFile containment + 白名单', () => {
  let root: string
  let registry: Live2DModelRegistry
  beforeEach(async () => {
    root = tmpModelsRoot()
    await installModel(root, { id: 'A', licenseRef: 'LICENSE.txt' })
    await installModel(root, { id: 'B', licenseRef: 'LICENSE.txt' })
    registry = new Live2DModelRegistry({ modelsDir: root })
  })

  it('白名单内路径 + size 匹配 → 绝对路径', async () => {
    const p = await registry.resolveModelFile('A', 'model3.json')
    expect(p).toBe(join(realpathSync(join(root, 'A')), 'model3.json'))
  })

  it('`../` 逃逸 → null', async () => {
    await expect(registry.resolveModelFile('A', '../B/model3.json')).resolves.toBeNull()
  })

  it('绝对路径 → null', async () => {
    await expect(registry.resolveModelFile('A', '/etc/passwd')).resolves.toBeNull()
  })

  it('%2F 走私段 → null', async () => {
    await expect(registry.resolveModelFile('A', 'sub%2Fmodel3.json')).resolves.toBeNull()
  })

  it('symlink 逃逸 → null（realpath containment + lstat 非普通文件双拒）', async () => {
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(root, 'A', 'escape-link'))
    await expect(registry.resolveModelFile('A', 'escape-link')).resolves.toBeNull()
  })

  it('跨模型目录 → null（A 的 relPath 指向 B）', async () => {
    await expect(registry.resolveModelFile('A', '../B/model3.json')).resolves.toBeNull()
  })

  it('integrity 白名单外路径（存在但未列入 integrity.json）→ null', async () => {
    writeFileSync(join(root, 'A', 'extra.txt'), 'extra')
    await expect(registry.resolveModelFile('A', 'extra.txt')).resolves.toBeNull()
  })

  it('尺寸不符 → null', async () => {
    writeFileSync(join(root, 'A', 'model3.json'), Buffer.from('different-size'))
    await expect(registry.resolveModelFile('A', 'model3.json')).resolves.toBeNull()
  })
})

describe('verifyIntegrity（fail-closed pending + 熔断）', () => {
  beforeEach(() => { verifySpy.mockClear() })

  it('hash 匹配 → true；并发两次共享同一 pending（verifyIntegrityAgainst 仅一次）', async () => {
    const root = tmpModelsRoot()
    await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const p1 = registry.verifyIntegrity('ok')
    const p2 = registry.verifyIntegrity('ok')
    expect(p1).toBe(p2) // 同一 Promise
    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)
    expect(verifySpy).toHaveBeenCalledTimes(1)
    const list = await registry.listInstalledModels()
    expect(list[0].integrityState).toBe('verified')
  })

  it('完成后 pending 清理：第三次 verify 重新复核（累计 2 次）', async () => {
    const root = tmpModelsRoot()
    await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    const registry = new Live2DModelRegistry({ modelsDir: root })
    await registry.verifyIntegrity('ok')
    await new Promise((r) => setTimeout(r, 0)) // 让 finally 清理微任务落地
    await registry.verifyIntegrity('ok')
    expect(verifySpy).toHaveBeenCalledTimes(2)
  })

  it('篡改（同尺寸不同字节）→ false + 熔断（resolveModelFile 恒拒 / 列表 available=false reason hash_mismatch）', async () => {
    const root = tmpModelsRoot()
    const dir = await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    const registry = new Live2DModelRegistry({ modelsDir: root })
    writeFileSync(join(dir, 'model3.json'), Buffer.from('model-datZ')) // 10 字节同尺寸不同内容
    await expect(registry.verifyIntegrity('ok')).resolves.toBe(false)
    await expect(registry.resolveModelFile('ok', 'model3.json')).resolves.toBeNull()
    const list = await registry.listInstalledModels()
    expect(list[0]).toMatchObject({ available: false, reason: 'hash_mismatch', integrityState: 'failed' })
  })

  it('未知模型 id → false（fail-closed，无清单）', async () => {
    const root = tmpModelsRoot()
    const registry = new Live2DModelRegistry({ modelsDir: root })
    await expect(registry.verifyIntegrity('ghost')).resolves.toBe(false)
  })

  it('verifyIntegrityAgainst 抛错（hashFile 流读途中失败）→ false + 熔断（I-1）', async () => {
    const root = tmpModelsRoot()
    await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    const registry = new Live2DModelRegistry({ modelsDir: root })
    // 模拟 hashFile/createReadStream 途中抛错：verifyIntegrityAgainst 拒绝 → p 不 reject、fail-closed 熔断
    verifySpy.mockImplementationOnce(() => { throw new Error('read-failed') })
    await expect(registry.verifyIntegrity('ok')).resolves.toBe(false)
    await expect(registry.resolveModelFile('ok', 'model3.json')).resolves.toBeNull()
    const list = await registry.listInstalledModels()
    expect(list[0]).toMatchObject({ available: false, reason: 'hash_mismatch', integrityState: 'failed' })
  })
})

describe('integrity 条目路径安全过滤（I-2，纵深）', () => {
  it('手工构造含 ../ 逃逸 / 绝对路径 / 空段条目 → 过滤拒（不读取模型目录外文件，安全条目照常复核）', async () => {
    const root = tmpModelsRoot()
    const dir = await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    const outside = join(root, 'outside.bin')
    writeFileSync(outside, 'outside-secret-data')
    const real = await computeIntegrity(dir) // 安全条目（model3.json）
    // 注入三类非法条目：../ 逃逸、POSIX 绝对路径、空段；合法条目保留
    writeFileSync(join(dir, 'integrity.json'), JSON.stringify({
      files: [
        { path: '../outside.bin', size: Buffer.byteLength('outside-secret-data'), sha256: 'deadbeef' },
        { path: '/etc/passwd', size: 1, sha256: 'deadbeef' },
        { path: 'sub//model3.json', size: 1, sha256: 'deadbeef' },
        ...real
      ]
    }))
    const registry = new Live2DModelRegistry({ modelsDir: root })
    // list 只查安全条目（model3.json 存在 + 尺寸一致）→ available=true；逃逸条目不被 lstat
    const list = await registry.listInstalledModels()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'ok', available: true })
    // verify 只 hash 安全条目 → true（outside.bin 的 hash 不参与）
    await expect(registry.verifyIntegrity('ok')).resolves.toBe(true)
    // 无 OOB 副作用：篡改 outside.bin 不影响验证结果
    writeFileSync(outside, 'outside-tampered-data')
    await expect(registry.verifyIntegrity('ok')).resolves.toBe(true)
  })

  it('全部条目非法 → 过滤为空数组 → 空清单可用（无 OOB 读取）', async () => {
    const root = tmpModelsRoot()
    const dir = await installModel(root, { id: 'ok', licenseRef: 'LICENSE.txt' })
    writeFileSync(join(dir, 'integrity.json'), JSON.stringify({
      files: [{ path: '../outside.bin', size: 1, sha256: 'deadbeef' }]
    }))
    const registry = new Live2DModelRegistry({ modelsDir: root })
    const list = await registry.listInstalledModels()
    expect(list[0]).toMatchObject({ id: 'ok', available: true })
    await expect(registry.verifyIntegrity('ok')).resolves.toBe(true)
  })
})
