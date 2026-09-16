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
  // 位置必须最后（见上顺序注记）。
  //
  // 2026-09-10 收窄（门禁漂移整改）：原规则是裸的 `[A-Za-z0-9+/]{40,}`，而 `/` 与 `+` 都在 base64 字符集内，
  // 因此**任何 40 字符以上的相对 import 路径、camelCase 标识符串、词表串、40/64 位 hex 摘要**都命中
  // （实测全仓 P0 命中 1671 行 / 221 文件）。这些命中全部要靠「类别级 allowlist + 逐文件人工核对」承接，
  // 于是每新增一个含长路径的文件就必然变红——allowlist 在 2026-08-22 核对后两周内即腐烂（39 条路径失效、
  // 大量新文件无条目），门禁长期全红、事实失效，并直接掩盖了 2026-09-07~09-10 连续四次 CI 里的真实
  // DataCloneError 回归。判据改为「像秘密」而非「够长」，见 isSecretLikeBase64 的实测依据。
  { name: 'base64-long-string', re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/, accept: isSecretLikeBase64 }
]

/** 香农熵（bits/char）——用于区分随机 base64 与可读词表/路径长串 */
function shannonEntropy(s) {
  const freq = new Map()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p) }
  return h
}

/**
 * 「像秘密的 40+ base64 长串」判据（2026-09-10 收窄，实测依据见下）：
 *  ① 同时含大写、小写与数字——排除全小写/全大写的 hex 摘要（git SHA、schemaHash、夹具完整性值）
 *     与纯词表串（`apps/desktop/.../CyLive2DPanel` 仅有大小写与路径分隔，仍会过这一关，见 ②）；
 *  ② 不含 `/`，或香农熵 ≥ 4.5 bits/char——排除斜杠连接的可读路径/标识符串。
 *
 * 实测依据（tmp 探针，全仓 1083 跟踪文件）：
 *  - 检出保真度：随机 base64 凭据 32 字节 996/1000、48 字节 1000/1000、64 字节 1000/1000 仍命中；
 *    含 `/` 的真实凭据 299/300 仍命中。24 字节（32 字符）本就不足 40 字符阈值，非本次收窄所致。
 *  - 误报面：P0 命中 1671 行 / 221 文件 → 收窄后 561 行 / 5 文件（其中 557 行是 pnpm-lock.yaml 的
 *    npm integrity sha512，见 RULE_FILE_EXCLUSIONS）。
 *  - 阈值依据：被 ② 挡掉的含 `/` 行熵最大 4.21，保留行熵最小 ≈5.5——阈值落在实测空带内，非拍脑袋。
 *
 * 已记录的检出收窄（不静默）：纯 hex（如 64 位 hex 密钥）不再由此规则兜住。此前这类串 100% 落在
 * allowlist 里（git SHA / schemaHash 全是这一形态），实际覆盖为零，故非有效能力回退；
 * bearer / JWT / sk- / AKIA / *_TOKEN 赋值 / PRIVATE KEY 六类专属规则与人工复核不变。
 */
export function isSecretLikeBase64(run) {
  const body = run.replace(/=+$/, '')
  if (!/[A-Z]/.test(body) || !/[a-z]/.test(body) || !/[0-9]/.test(body)) return false
  return !body.includes('/') || shannonEntropy(body) >= 4.5
}

/**
 * 按规则名排除的整文件（2026-09-10 新增）：与 EXCLUDED_DIR_PREFIXES 的「整树排除」不同，这是**按规则**排除——
 * 文件仍参与其余全部规则的扫描，只是不再套用某条通用启发式规则。
 * `pnpm-lock.yaml`：生成的锁文件，其 `integrity: sha512-<base64>` 是 npm 设计的确定性非秘密哈希，
 * 天然满足「40+ 高熵 base64」——全仓 557 行命中全部来自此处。整文件排除会连带丢掉锁文件里
 * token-in-URL / 赋值形态的检出能力，故只按规则排除，其余六条规则照扫。
 */
export const RULE_FILE_EXCLUSIONS = {
  'base64-long-string': ['pnpm-lock.yaml']
}

export function isRuleExcludedForPath(ruleName, p) {
  return (RULE_FILE_EXCLUSIONS[ruleName] ?? []).includes(p)
}

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
//
// 2026-09-16 追加第四个：`tests/unit/redact-gate-parity.spec.ts` 是"门禁规则 ↔ 产品脱敏"的**交叉校验**，
// 它的样本**必须**逐条命中黑名单规则，否则那条断言恒真（样本要按各规则自身的字符类与长度门槛构造）。
// 样本全是合成串（含 AWS 官方文档里的 `AKIAIOSFODNN7EXAMPLE` 这类公开示例），非真实凭据。
// 该文件被判红的经过本身是门禁有效的证据：它是被 `verify:sensitive` 抓出来的，而不是我预先想起来的。
export const SELF_EXCLUDED_FILES = [
  'apps/desktop/scripts/verify-sensitive.mjs',
  'apps/desktop/scripts/verify-sensitive-core.mjs',
  'apps/desktop/tests/unit/verify-sensitive.spec.ts',
  'apps/desktop/tests/unit/redact-gate-parity.spec.ts'
]

export function isExcludedPath(p) {
  return EXCLUDED_DIR_PREFIXES.some((prefix) => p.startsWith(prefix))
}

export function isSelfExcludedFile(p) {
  return SELF_EXCLUDED_FILES.includes(p)
}

/**
 * 单文本逐行扫描（1 基行号；多个规则命中同一行会产生多条）。
 * `rule.accept`（可选）：拿到正则匹配到的**子串**再做一次形态判定——用于把「够长」收窄成「像秘密」
 * （见 isSecretLikeBase64）。规则正则均无 `/g` 旗标，故 `exec` 与 `test` 等价且无 lastIndex 状态。
 * @returns Array<{ name: string; line: number; text: string }>（text = 命中完整行，供 allowlist 锚定与展示）
 */
export function scanSecretsInText(text, blacklist = SECRET_BLACKLIST) {
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of blacklist) {
      const m = rule.re.exec(line)
      if (!m) continue
      if (typeof rule.accept === 'function' && !rule.accept(m[0])) continue
      hits.push({ name: rule.name, line: i + 1, text: line })
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
