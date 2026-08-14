// 复制工具（spec §4.6.1）：navigator.clipboard 优先 + document.execCommand 兜底。Web API，不经 IPC。
export interface ClipboardEnv {
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
  document?: Pick<Document, 'createElement' | 'body' | 'execCommand'>
}

export async function copyText(text: string, env: ClipboardEnv = {}): Promise<boolean> {
  const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined)
  if (nav?.clipboard?.writeText) {
    try { await nav.clipboard.writeText(text); return true } catch { /* 降级 execCommand */ }
  }
  const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined)
  if (doc) {
    const ta = doc.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    doc.body.appendChild(ta)
    ta.select()
    const ok = doc.execCommand('copy')
    doc.body.removeChild(ta)
    return ok
  }
  return false
}
