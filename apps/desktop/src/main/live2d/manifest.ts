// apps/desktop/src/main/live2d/manifest.ts
// 阶段 5 批次 A（A3，spec D5A-07）：模型完整性清单纯工具层。
// 约束：纯 node（node:crypto / node:fs / node:fs/promises / node:path），无 zod、无 @shared alias、无第三方依赖——
// Task 4（A5）装配 CLI 会经 strip-types 直接 import 本文件（hashFile / computeIntegrity），保持零运行时依赖。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** integrity.json 单条目：相对路径（/ 分隔）+ 尺寸 + SHA-256 */
export interface IntegrityEntry { path: string; size: number; sha256: string }

/** 流式 SHA-256 + 尺寸（逐块读盘，不整文件载入内存）；lstat 非普通文件（symlink/FIFO/设备）拒绝 */
export async function hashFile(abs: string): Promise<{ size: number; sha256: string }> {
  const st = await lstat(abs)
  if (!st.isFile()) throw new Error(`hashFile: 非普通文件 ${abs}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(abs)) {
    hash.update(chunk)
  }
  return { size: st.size, sha256: hash.digest('hex') }
}

/**
 * 递归扫描模型目录 → integrity 条目：
 * - 相对路径统一 / 分隔（跨平台稳定，Task 3 协议层逐段解码后与索引 key 比对）；
 * - 跳过 `.` 开头隐藏项与空目录；
 * - 显式排除 manifest.json / integrity.json 自身（装配产物由 computeIntegrity 生成，二者不在清单内）；
 * - symlink 等非普通项（Dirent.isFile/isDirectory 均 false）自然跳过。
 */
export async function computeIntegrity(modelDir: string): Promise<IntegrityEntry[]> {
  const entries: IntegrityEntry[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const abs = join(dir, item.name)
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (item.isDirectory()) {
        const children = await readdir(abs).catch(() => [])
        if (children.length === 0) continue // 空目录跳过
        await walk(abs, rel)
      } else if (item.isFile()) {
        if (item.name === 'manifest.json' || item.name === 'integrity.json') continue
        const { size, sha256 } = await hashFile(abs)
        entries.push({ path: rel, size, sha256 })
      }
    }
  }
  await walk(modelDir, '')
  return entries
}

/** fail-closed 全量复核：每条目文件存在 + 普通文件（lstat 非 symlink）+ 尺寸一致 + SHA-256 一致；任一不符 → false */
export async function verifyIntegrityAgainst(modelDir: string, entries: IntegrityEntry[]): Promise<boolean> {
  for (const entry of entries) {
    const abs = join(modelDir, ...entry.path.split('/'))
    const st = await lstat(abs).catch(() => null)
    if (!st || !st.isFile()) return false
    if (st.size !== entry.size) return false
    const { sha256 } = await hashFile(abs)
    if (sha256 !== entry.sha256) return false
  }
  return true
}
