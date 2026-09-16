// src/main/tools/file-identity.ts
// 授权 ↔ 执行的路径身份复核（2026-09-16 审计 P2「授权↔执行的路径身份缺口（TOCTOU）」）。
//
// 缺口（修复前）：决策链 step 5 把 `normalizeToolPath` 的 realpath 缓存进记录并在**那一刻**做黑名单与
// 包含性判定，但执行器在**另一个时刻**按同一个字符串重新打开文件。两者之间路径可被换链——把已授权的
// 普通文件换成指向别处的符号链接（或换成另一个文件）——于是「批准的是 A、读到/写到的是 B」，
// 大文件还会被当作 A 上传出去。修复前的注释（`tool-executors.ts` 的「TOCTOU：open 后 fstat 复核」）
// 只比对了 size，既拦不住同尺寸替换，也不覆盖符号链接换链。
//
// 本模块只做一件事：**取身份**（授权时一次、执行前一次，由调用方比对）。判定与错误码留在调用方，
// 因为 read / write 两条路径要表达的用户语义不同（读取被换链 vs 覆盖被换链）。
//
// 为什么用 lstat 而不是 stat：授权时的 `realPath` 已是 realpathSync.native 的产物（父链符号链接全部解开），
// 故执行期若在该路径上看见符号链接，那只能是替换——必须点名，而不是跟随它去打开目标。
import * as fs from 'node:fs'

/** 文件身份。Windows NTFS 与 Linux ext4 均报非零 dev/ino；`{0,0}` 表示该文件系统不提供身份（见 probeIdentity） */
export interface FileIdentity { dev: number; ino: number }

/**
 * 身份探测结果。**四态必须分开**，不能压成 `FileIdentity | undefined`：
 *   · `file`        —— 可复核（正常路径）；
 *   · `symlink`     —— 路径此刻是符号链接（授权后换链的形态之一）；
 *   · `missing`     —— 路径此刻不存在；
 *   · `unsupported` —— 存在、但文件系统不报 dev/ino（如某些 FAT/网络盘）⇒ **身份复核不可用**。
 * 最后两态在"授权时"与"执行时"的含义相反，混作一谈会让"不可用"被静默当成"通过"。
 */
export type IdentityProbe =
  | { kind: 'file'; identity: FileIdentity }
  | { kind: 'symlink' }
  | { kind: 'missing' }
  | { kind: 'unsupported' }

/** 取路径当前身份（不跟随符号链接）。任何 fs 异常都归 `missing`——调用方的判据是"能不能复核"，不是异常类型 */
export function probeIdentity(p: string): IdentityProbe {
  let st: fs.Stats
  try { st = fs.lstatSync(p) } catch { return { kind: 'missing' } }
  if (st.isSymbolicLink()) return { kind: 'symlink' }
  if (st.dev === 0 && st.ino === 0) return { kind: 'unsupported' }
  return { kind: 'file', identity: { dev: st.dev, ino: st.ino } }
}

/**
 * 授权时捕获身份。只有 `file` 态返回身份——其余三态一律 `undefined`，含义是"这条路径**当时**没有可复核的身份"。
 * 调用方据此把执行期的复核限定在"授权时确有一个具体文件"的情形；授权时不存在（新建写）由既有的
 * `isNewFile`/`FILE_CONFLICT` 判据覆盖，两者不重叠。
 */
export function captureFileIdentity(p: string): FileIdentity | undefined {
  const probe = probeIdentity(p)
  return probe.kind === 'file' ? probe.identity : undefined
}

/**
 * 身份是否仍然指向同一个文件。`expected === undefined` ⇒ 不适用（授权时没有身份）⇒ 交由调用方的既有判据。
 * 返回字符串即拒绝原因（调用方决定错误码），`null` 表示通过。
 */
export function identityChangedReason(p: string, expected: FileIdentity | undefined): 'symlink' | 'gone' | 'replaced' | null {
  if (!expected) return null
  const probe = probeIdentity(p)
  if (probe.kind === 'symlink') return 'symlink'
  if (probe.kind !== 'file') return 'gone'          // missing / unsupported：授权时能取到身份、现在取不到 ⇒ 不可复核，一律拒
  if (probe.identity.dev !== expected.dev || probe.identity.ino !== expected.ino) return 'replaced'
  return null
}
