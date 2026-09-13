import { createHash } from 'node:crypto'

/** 递归键排序（D6B-22，镜像后端 canonical_json：sort_keys + separators=(',',':') + ensure_ascii=False） */
export function canonicalJsonStringify(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) out[k] = canon((v as Record<string, unknown>)[k])
      return out
    }
    return v
  }
  return JSON.stringify(canon(value))
}

export function computeParamHash(arguments_: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJsonStringify(arguments_), 'utf8').digest('hex')
}
