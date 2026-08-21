// apps/desktop/scripts/verify-sensitive-core.mjs
// verify:sensitive 扫描逻辑的纯函数拆分（vitest node 环境可 import——node-version-ok.mjs 先例）。
// 黑名单：spec §5.1（D7A-14）第一条至第七条 + review LOW① 补入的第 8 条（redact 第 4 条 40+ 长串）——
// 即「复用 redact RULES」全部四条（Bearer/JWT/sk-/AKIA/40+ base64 原文复用）+ AGENT/ACCOUNT_TOKEN 赋值形态 + PRIVATE KEY 头。
// 注意：无 /g 旗标（repeatable test 不依赖 lastIndex 重置）；顺序关键——短规则（Bearer/sk-/AKIA）先于
// 长串规则（同 redact.ts RULES 顺序注记：Bearer 先于 ≥40 长串，否则 Bearer token 先被长串规则命中）。
export const SECRET_BLACKLIST = [
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+\/-]+=*/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/ },
  { name: 'sk-api-key', re: /sk-[A-Za-z0-9]{10,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'agent-access-token-assign', re: /AGENT_ACCESS_TOKEN\s*=\s*\S+/ },
  { name: 'account-token-assign', re: /ACCOUNT_TOKEN\s*=\s*\S+/ },
  { name: 'private-key-header', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // LOW①（review 2026-08-22）：D7A-14 决策措辞「40+ base64（复用 redact RULES）」——补 redact 第 4 条原文；
  // 位置必须最后（见上顺序注记）。该规则对全文类别性命中（sha512 包哈希/夹具完整性/词表路径长串），
  // 扫描端以「类别级 allowlist + 逐文件人工核对」承接（见 verify-sensitive.mjs ALLOWLIST 第二段）。
  { name: 'base64-long-string', re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/ }
]

// 排除目录（D7A-14 + 同级 vendor 语义扩展）：third_party/ 整体排除——vendor（CubismSdkForWeb-5-r.5）
// 291 个跟踪文件含 228KB asm.js base64（live2dcubismcore.min.js），必然误报且非本仓代码；真实秘密不进商家产物。
// 同级扩展（review LOW① 落地中实测）：`src/renderer/public/live2d/`（同一 Core asm.js base64 的 vendored 副本）
// 与 `src/renderer/src/live2d/framework/`（vendored Cubism Framework 源码，长标识符/路径串密集）
// ——与 lint 配置同款 vendor 忽略（eslint.config.mjs 已忽略此二树），语义同一：vendor 产物不参与本仓机密扫描。
// 排除是整树目录前缀（`third_party/`），不留行级 allowlist 兜底——vendor 更新即静默放行，语义一致。
export const EXCLUDED_DIR_PREFIXES = [
  'third_party/',
  'apps/desktop/src/renderer/public/live2d/',
  'apps/desktop/src/renderer/src/live2d/framework/'
]

// 自排除（review HIGH-1：扫描器扫自身源文件/单测——黑名单字面量（ALLOWLIST 锚定/理由）与单测触发器
// 必然命中且非秘密；排除后每次改 ALLOWLIST/reason/触发器不破坏全绿。此三文件为扫描逻辑本体非被检内容，
// 与 third_party 相同语义——被检面是本仓的源码/文档/配置，不含扫描器自身）。
export const SELF_EXCLUDED_FILES = [
  'apps/desktop/scripts/verify-sensitive.mjs',
  'apps/desktop/scripts/verify-sensitive-core.mjs',
  'apps/desktop/tests/unit/verify-sensitive.spec.ts'
]

export function isExcludedPath(p) {
  return EXCLUDED_DIR_PREFIXES.some((prefix) => p.startsWith(prefix))
}

export function isSelfExcludedFile(p) {
  return SELF_EXCLUDED_FILES.includes(p)
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
 * 行级 allowlist 匹配：路径由调用方按精确路径索引（entries 已是该路径的条目列表）。
 * 判定 = 锚定段命中 && 规则域命中：
 *  - anchor.test(lineText)：锚定段（无 /g，重复 test 安全）；
 *  - rules：undefined / 空 = 全规则豁免（精确条目语义——锚定段已逐行人工核对，维持现状）；
 *    数组 = 仅豁免列出的规则名（类别级条目语义——R2-1：通用 40+ 锚若豁免全部规则，
 *    覆盖文件内「同时含 40+ run」的新增 Bearer/JWT/sk- 行会被静默放行——真实 token 形态普遍 ≥40 字符）。
 * 命中返回条目；不命中返回 null（违规）。
 */
export function allowlistEntryMatches(entry, lineText, hitName) {
  if (!entry.anchor.test(lineText)) return false
  if (Array.isArray(entry.rules) && entry.rules.length > 0) {
    if (!entry.rules.includes(hitName)) return false
  }
  return true
}

export function allowlistEntryFor(entries, lineText, hitName) {
  for (const e of entries) {
    if (allowlistEntryMatches(e, lineText, hitName)) return e
  }
  return null
}
