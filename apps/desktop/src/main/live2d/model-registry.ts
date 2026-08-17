// apps/desktop/src/main/live2d/model-registry.ts
// 阶段 5 批次 A（A3，spec D5A-07）：Main 模型注册表——manifest + integrity 两级可用性 + fail-closed verify。
// 两级可用性：① manifestSchema 校验失败（含 licenseRef 缺失）→ 整目录跳过不列出；② 合法但 integrity 覆盖的
// 模型文件缺失/尺寸不符 → 列出且 available=false（preview 条目豁免，缺失不置可用性为假）。
// verifyIntegrity：fail-closed pending——同模型并发共享同一 Promise；hash 不匹配熔断（resolveModelFile 拒）。
import { z } from 'zod'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Live2DModelSummary } from '@shared/contracts'
import { verifyIntegrityAgainst, type IntegrityEntry } from './manifest'

/** 共享契约别名收口：Task 6（controller/store）与 preload 消费同一 Live2DModelSummary，不另定义 */
export type Live2DSummary = Live2DModelSummary

/** manifest.json 形状（D5A-07 必填/可选集）：必填 {id, displayName, modelFile, licenseRef, integrityManifest}；可选 {preview?, expressions?, motions?, version?} */
export const manifestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  displayName: z.string(),
  modelFile: z.string(),
  preview: z.string().optional(),
  expressions: z.array(z.string()).optional(),
  motions: z.array(z.string()).optional(),
  version: z.string().optional(),
  licenseRef: z.string(),
  integrityManifest: z.string()
})

/** integrity.json 形状：{ files: IntegrityEntry[] } */
export const integritySchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string()
  }))
})

/** available=false 的脱敏原因枚举码（非原始错误文本，避免泄漏路径/详情） */
type UnavailableReason = 'missing_file' | 'size_mismatch' | 'hash_mismatch'

/** 预览条目豁免：integrity 中 manifest.preview 指向的文件（或 preview.png 约定名）缺失/尺寸不符不置可用性为假 */
function isPreviewEntry(entryPath: string, preview: string | undefined): boolean {
  if (preview !== undefined && entryPath === preview) return true
  const parts = entryPath.split('/')
  return parts[parts.length - 1] === 'preview.png'
}

/**
 * 条目路径安全过滤（I-2，纵深）：integrity 条目侧与 resolveModelFile 请求侧同纪律——
 * 拒绝绝对路径（POSIX `/` 起始、Windows 盘符/反斜杠分隔走私）、含 `..`/`.`/空段。
 * 装配器 computeIntegrity 产出恒为 `/` 分隔的安全相对路径，任何逃逸条目即手工构造/被篡改信号。
 */
function isSafeEntryPath(p: string): boolean {
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')) return false
  const parts = p.split('/')
  return parts.length > 0 && parts.every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** realpath 后的 containment 判定：child 必须位于 parent 内（win 大小写归一，relative 基于归一化路径） */
function isContained(parent: string, child: string): boolean {
  const norm = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s
  const rel = relative(norm(parent), norm(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}

export class Live2DModelRegistry {
  private readonly modelsDir: string
  private readonly verified = new Set<string>()
  private readonly failed = new Set<string>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly integrityCache = new Map<string, IntegrityEntry[] | null>()

  constructor(deps: { modelsDir: string }) {
    this.modelsDir = deps.modelsDir
  }

  /** 扫 modelsDir/*：manifest 非法（含 licenseRef 缺失）整目录跳过；合法但 integrity 覆盖模型文件缺失/尺寸不符 → available=false */
  async listInstalledModels(): Promise<Live2DSummary[]> {
    const out: Live2DSummary[] = []
    let top: import('node:fs').Dirent[]
    try {
      top = await readdir(this.modelsDir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of top) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const summary = await this.inspectModelDir(join(this.modelsDir, entry.name))
      if (summary) out.push(summary)
    }
    return out
  }

  private async inspectModelDir(dir: string): Promise<Live2DSummary | null> {
    let raw: string
    try {
      raw = await readFile(join(dir, 'manifest.json'), 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    const m = manifestSchema.safeParse(parsed)
    if (!m.success) return null // 含 licenseRef 缺失 / id 非法 → 整目录跳过
    const { id, displayName, preview, version, licenseRef } = m.data

    const entries = await this.loadIntegrity(id)
    let available = true
    let reason: UnavailableReason | undefined
    if (entries) {
      for (const it of entries) {
        if (isPreviewEntry(it.path, preview)) continue // preview 豁免
        const abs = join(dir, ...it.path.split('/'))
        const st = await lstat(abs).catch(() => null)
        if (!st || !st.isFile()) { available = false; reason = 'missing_file'; break }
        if (st.size !== it.size) { available = false; reason = 'size_mismatch'; break }
      }
    } else {
      // integrity.json 缺失/非法 → 无清单可核，fail-closed 置不可用
      available = false
      reason = 'missing_file'
    }

    const integrityState = this.verified.has(id) ? 'verified' : this.failed.has(id) ? 'failed' : 'unverified'
    // fail-closed：hash 复核失败（failed 态）→ 列表亦置不可用（reason hash_mismatch），UI 不再尝试装载
    if (this.failed.has(id)) {
      available = false
      reason = 'hash_mismatch'
    }
    const summary: Live2DSummary = {
      id,
      displayName,
      preview: preview ?? null,
      version: version ?? '0',
      available,
      licenseRef,
      integrityState
    }
    if (reason !== undefined) summary.reason = reason
    return summary
  }

  /**
   * 解析模型文件绝对路径（Task 3 协议分支消费）：
   * realpath containment（../、绝对路径、symlink 逃逸、跨模型目录全拒）+ lstat 仅普通文件（FIFO/设备/symlink 拒，
   * safe-open 纪律，防 net.fetch 挂起）+ relPath 须在 integrity entries（key 匹配）且尺寸一致 → 返回绝对路径；否则 null。
   * fail-closed 熔断：verifyIntegrity 失败（failed.has）→ 恒 null。
   */
  async resolveModelFile(modelId: string, relPath: string): Promise<string | null> {
    if (this.failed.has(modelId)) return null
    // 解码走私/非法形态防御（协议层已逐段 decodeURIComponent，这里对裸 relPath 再拒一层）：
    // 绝对路径、残留 % 编码（%2F 走私段）、NUL、`.`/`..`/空段
    if (isAbsolute(relPath) || relPath.includes('%') || relPath.includes('\0')) return null
    const parts = relPath.split('/')
    if (parts.length === 0 || parts.some((p) => p === '' || p === '.' || p === '..')) return null

    const dir = join(this.modelsDir, modelId)
    const dirReal = await realpath(dir).catch(() => null)
    if (!dirReal) return null
    const candidate = join(dir, ...parts)
    const candReal = await realpath(candidate).catch(() => null)
    if (!candReal) return null
    if (!isContained(dirReal, candReal)) return null

    const st = await lstat(candReal).catch(() => null)
    if (!st || !st.isFile()) return null // FIFO/设备/symlink 拒

    const entries = await this.loadIntegrity(modelId)
    if (!entries) return null
    const rel = parts.join('/')
    const entry = entries.find((e) => e.path === rel)
    if (!entry || entry.size !== st.size) return null
    return candReal
  }

  /**
   * fail-closed pending + 会话内缓存：同模型并发共享同一 Promise；hash 不匹配/复核抛错 → failed 熔断。
   * verified/failed 短路（D5A-07「会话内每模型一次，缓存 verified 态」/ D5A-08「路由不做逐请求 hash」）：
   * 协议闭包每请求调本方法，成功/失败态缓存后不再重哈希全目录。
   */
  verifyIntegrity(modelId: string): Promise<boolean> {
    if (this.verified.has(modelId)) return Promise.resolve(true)
    if (this.failed.has(modelId)) return Promise.resolve(false)
    const existing = this.pending.get(modelId)
    if (existing) return existing
    const p = (async () => {
      try {
        const dir = join(this.modelsDir, modelId)
        const entries = await this.loadIntegrity(modelId)
        if (!entries) {
          this.failed.add(modelId)
          return false
        }
        const ok = await verifyIntegrityAgainst(dir, entries)
        if (ok) {
          this.verified.add(modelId)
          this.failed.delete(modelId)
        } else {
          this.failed.add(modelId)
          this.verified.delete(modelId)
        }
        return ok
      } catch {
        this.failed.add(modelId) // throw（TOCTOU/流读失败等）→ 同样熔断（fail-closed），且 p 恒 resolve 不再有 unhandledRejection
        return false
      }
    })()
    this.pending.set(modelId, p)
    void p.finally(() => { this.pending.delete(modelId) })
    return p
  }

  /** 读取并缓存模型 integrity.json：缺失/JSON 非法/schema 非法 → null（fail-closed）；条目路径逐条安全过滤（I-2，拒 OOB 读取） */
  private async loadIntegrity(modelId: string): Promise<IntegrityEntry[] | null> {
    const cached = this.integrityCache.get(modelId)
    if (cached !== undefined) return cached
    const raw = await readFile(join(this.modelsDir, modelId, 'integrity.json'), 'utf8').catch(() => null)
    if (raw === null) {
      this.integrityCache.set(modelId, null)
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.integrityCache.set(modelId, null)
      return null
    }
    const r = integritySchema.safeParse(parsed)
    const result = r.success ? r.data.files.filter((f) => isSafeEntryPath(f.path)) : null
    this.integrityCache.set(modelId, result)
    return result
  }
}
