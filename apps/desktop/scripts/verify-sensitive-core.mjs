// apps/desktop/scripts/verify-sensitive-core.mjs
// verify:sensitive 扫描逻辑的纯函数拆分（vitest node 环境可 import——node-version-ok.mjs 先例）。
// 黑名单来自 spec §5.1（D7A-14）：前 4 条为 redact.ts RULES 原文、后 3 条为赋值形态 / 私钥头。
// 注意：无 /g 旗标（repeatable test 不依赖 lastIndex 重置）。
export const SECRET_BLACKLIST = [
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+\/-]+=*/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/ },
  { name: 'sk-api-key', re: /sk-[A-Za-z0-9]{10,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'agent-access-token-assign', re: /AGENT_ACCESS_TOKEN\s*=\s*\S+/ },
  { name: 'account-token-assign', re: /ACCOUNT_TOKEN\s*=\s*\S+/ },
  { name: 'private-key-header', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
]

// 排除目录（D7A-14）：third_party/ 整体排除——vendor（CubismSdkForWeb-5-r.5）291 个跟踪文件
// 含 228KB asm.js base64（live2dcubismcore.min.js），必然误报且非本仓代码；真实秘密不进商家产物。
// 排除是整树目录前缀（`third_party/`），不留行级 allowlist 兜底——vendor 更新即静默放行，语义一致。
export const EXCLUDED_DIR_PREFIXES = ['third_party/']

export function isExcludedPath(p) {
  return EXCLUDED_DIR_PREFIXES.some((prefix) => p.startsWith(prefix))
}

/**
 * 单文本逐行扫描（1 基行号；多个规则命中同一行会产生多条）。
 * @returns Array<{ name: string; line: number; text: string }>（text = 命中完整行，供 allowlist 锚定与展示）
 */
export function scanSecretsInText(text, blacklist = SECRET_BLACKLIST) {
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of blacklist) {
      if (rule.re.test(line)) hits.push({ name: rule.name, line: i + 1, text: line })
    }
  }
  return hits
}

/**
 * 行级 allowlist 匹配：路径由调用方按精确路径索引（entries 已是该路径的条目列表），
 * 此处只做「锚定段」匹配。锚定命中 = 该行允许放行；不命中返回 null（违规）。
 * 锚定正则无 /g，重复 test 安全。
 */
export function allowlistEntryFor(entries, lineText) {
  for (const e of entries) {
    if (e.anchor.test(lineText)) return e
  }
  return null
}
