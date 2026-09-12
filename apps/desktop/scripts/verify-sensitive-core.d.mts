// scripts/verify-sensitive-core.d.mts
// verify-sensitive-core.mjs 的类型声明（P1-11，2026-09-11）。
//
// 同 live2d-install.d.mts 的理由：测试直接 import 这些纯函数，而 `.mjs` 无声明 → TS7016，
// 且 `any` 会沿调用链扩散。刻意**不**用 `declare module '*.mjs'` 兜底（那会把报错换成失守）。
//
// 维护：新增导出需同步此文件（`tests/unit/scripts-dts-mirror.spec.ts` 会枚举并核对）。
export interface SecretRule {
  name: string
  re: RegExp
}

export interface SecretHit {
  name: string
  /** 1 基行号 */
  line: number
  /** 命中完整行文本（allowlist 锚定与展示用） */
  text: string
}

/** 黑名单规则集（name + 正则） */
export const SECRET_BLACKLIST: SecretRule[]

/** 按规则名分组的文件豁免表（如 { 'base64-long-string': ['pnpm-lock.yaml'] }） */
export const RULE_FILE_EXCLUSIONS: Record<string, string[]>

/** 整棵跳过的目录前缀 */
export const EXCLUDED_DIR_PREFIXES: string[]

/** 扫描器自身文件（避免自扫） */
export const SELF_EXCLUDED_FILES: string[]

/** 长 base64 串判定：形似密钥而非普通压缩/哈希载荷 */
export function isSecretLikeBase64(run: string): boolean

/** 该规则是否对该路径豁免 */
export function isRuleExcludedForPath(ruleName: string, p: string): boolean

/** 路径是否落在整棵跳过的前缀下 */
export function isExcludedPath(p: string): boolean

/** 是否扫描器自身文件 */
export function isSelfExcludedFile(p: string): boolean

/** 扫描一段文本，返回命中项 */
export function scanSecretsInText(text: string, blacklist?: SecretRule[]): SecretHit[]

/** 该 allowlist 条目是否匹配这一行（entry 形态由脚本决定，故用 unknown） */
export function allowlistEntryMatches(entry: unknown, lineText: string, hitName: string): boolean

/** 为某行找出适用的 allowlist 条目（无则返回 null）；条目类型由调用方给出 */
export function allowlistEntryFor<T>(entries: readonly T[], lineText: string, hitName: string): T | null
