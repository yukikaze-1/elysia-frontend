// tests/integration/helpers/links.ts
// 预置「隔离必然失败」所需的链接形态探测（2026-09-13，H-11b / M-19 两处共用）。
//
// 背景（本轮实测）：Windows 上未开开发者模式时 `symlinkSync` 建**文件** symlink 直接 EPERM，
// 于是"用符号链接构造损坏现场"的用例会整组被跳过、只有 CI 能验。探针实测发现 **目录 junction
// 在 Windows 上免特权可用**，且 `lstat().isSymbolicLink() === true`、`realpath` 解析到外部 ⇒
// 触发与文件 symlink **完全相同**的产品路径（safe-open 拒符号链接 → 隔离 → assertContained 越根上抛）。
// 故用例按可用形态择一，两个平台都能跑真链路；两者都不可用则整组跳过并在用例名里写明，不伪装通过。
//
// 探测方式与本仓既有四处同款（protocol-handler / safe-open / live2d-registry / tool-executors）：
// **真建一次链接**，失败即认为该形态不可用，绝不靠平台名猜。
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type LinkMode = 'file-symlink' | 'dir-junction' | 'none'

export function detectLinkMode(): LinkMode {
  const probe = mkdtempSync(join(tmpdir(), 'cy-persist-degrade-probe-'))
  const targetDir = join(probe, 'target')
  const targetFile = join(probe, 'target.txt')
  try {
    writeFileSync(targetFile, 'x')
    try {
      symlinkSync(targetFile, join(probe, 'flink'))
      return 'file-symlink'
    } catch { /* Windows 无开发者模式 → EPERM，退到 junction */ }
    try {
      symlinkSync(targetDir, join(probe, 'dlink'), process.platform === 'win32' ? 'junction' : 'dir')
      return 'dir-junction'
    } catch { return 'none' }
  } finally { rmSync(probe, { recursive: true, force: true }) }
}
