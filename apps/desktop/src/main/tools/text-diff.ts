import { diffLines } from 'diff'

export interface DiffLine { kind: 'added' | 'removed' | 'unchanged'; text: string }
export interface TextDiffResult { lines: DiffLine[]; added: number; removed: number; truncated: boolean; totalLines: number }   // totalLines（A-20/H2）
export const MAX_DIFF_LINES = 100

export function computeTextDiff(oldText: string, newText: string): TextDiffResult {
  const parts = diffLines(oldText, newText)
  let added = 0, removed = 0
  const lines: DiffLine[] = []   // lint：lines 从未重赋值 → const
  for (const p of parts) {
    const kind = p.added ? 'added' : p.removed ? 'removed' : 'unchanged'
    if (kind !== 'unchanged') { if (p.added) added += p.count ?? 0; else removed += p.count ?? 0 }
    const seg = p.value.split(/(?<=\n)/)
    for (const text of seg) { if (lines.length < MAX_DIFF_LINES) lines.push({ kind, text }) }
  }
  const total = parts.reduce((n, p) => n + (p.count ?? p.value.split('\n').length), 0)
  return { lines, added, removed, truncated: total > MAX_DIFF_LINES, totalLines: total }
}

export interface TextFormat { hasBom: boolean; eol: 'crlf' | 'lf' | 'mixed'; endsWithNewline: boolean }

export function detectTextFormat(text: string): TextFormat {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  const eol: TextFormat['eol'] = crlf > 0 && lf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : 'lf'
  return { hasBom: text.startsWith('﻿'), eol, endsWithNewline: text.endsWith('\n') }
}

export function normalizeToFormat(content: string, fmt: TextFormat): string {
  // 拆行段重拼（L-2）：去 BOM → 统一 LF → 按目标 EOL 重拼 → 末尾换行补齐 → 还原 BOM
  let s = content.startsWith('﻿') ? content.slice(1) : content
  s = s.replace(/\r\n/g, '\n')
  if (fmt.eol === 'crlf') s = s.replace(/\n/g, '\r\n')
  if (fmt.endsWithNewline && !s.endsWith(fmt.eol === 'crlf' ? '\r\n' : '\n')) s += fmt.eol === 'crlf' ? '\r\n' : '\n'
  if (fmt.hasBom) s = '﻿' + s
  return s
}
